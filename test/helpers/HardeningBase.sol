// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Position as V4Position} from "v4-core/libraries/Position.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleVault, deployMoleQueue, deployMoleRouter, TEST_UPGRADE_ADMIN} from "./ProxyDeploy.sol";

/// @dev The smallest WETH9 surface the router needs, so a hardening world can build a router without
///      dragging another suite's mock into this compilation unit. ERC-20 legs only; the native path has
///      its own suite.
contract HardeningWETH {
    string public name = "Wrapped Ether";
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "WETH: insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "WETH: send failed");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "WETH: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "WETH: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @notice ONE world, all four contracts, bound to ONE pool — so a property can be asserted after EVERY
///         flow of every contract without each file re-deriving a harness that drifts from the others.
///
/// The pool carries our own MoleHook (the only admissible shape under the fail-closed allowlist), the
/// vault is pinned to that hook with every keeper bound switched OFF (so a refused keeper cannot mask a
/// custody result), the queue is bound to the same pool with a warm oracle, and the router swaps through
/// the same pool via its v4 verb. Keeper bounds, fee policy and the hook fee are the shipped SHAPE of the
/// world, not the shipped numbers: this base exists to reach code, and a bound that refuses the caller
/// reaches nothing.
abstract contract HardeningBase is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;

    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 500;

    /// @dev A realistic chain timestamp: `consult` fails closed on `secondsAgo > block.timestamp`.
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant FUNDING = 1_000_000e18;

    address internal KEEPER = makeAddr("keeper");
    address internal TREASURY = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    MoleHook internal hook;
    PoolKey internal hookKey;
    PoolId internal hookId;
    MolePositions internal vault;
    MoleQueue internal queue;
    MoleRouter internal router;
    HardeningWETH internal weth;

    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;

    /// @dev `vm.warp(block.timestamp + d)` does not accumulate inside one call frame (solc caches the
    ///      value), so every file here moves an explicit clock and an explicit L1 height.
    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("attack-hardening", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deployHook(uint256 seed) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), TREASURY, TEST_UPGRADE_ADMIN),
            a
        );
        h = MoleHook(a);
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Real swaps spaced past the observation interval so the ring advances and `consult(TWAP_WINDOW)`
    ///      answers; the trailing quiet period makes TWAP == spot so the queue's drift guard reads zero.
    function _warmOracle(PoolKey memory k, uint256 size) internal {
        _advance(90);
        _swap(k, true, size);
        _advance(90);
        _swap(k, false, size);
        _advance(90);
        _swap(k, true, size);
        _advance(TWAP_WINDOW + 120);
    }

    /// @param feeBps performance fee on the vault. 0 = off.
    function _buildWorld(uint16 feeBps) internal {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        hook = _deployHook(1);
        hookKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(hookKey, SQRT_PRICE_1_1);
        hookId = hookKey.toId();
        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200_000e18, salt: 0}),
            ZERO_BYTES
        );
        _warmOracle(hookKey, 1e18);

        vault = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(hook), 0, 0, 0, 0, 10_000, 0, feeBps, feeBps == 0 ? address(0) : TREASURY
        );
        vault.whitelistPool(hookKey);

        queue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            hookKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );

        weth = new HardeningWETH();
        router = deployMoleRouter(manager, address(weth), address(0), address(0));

        _fund(alice);
        _fund(bob);
        _fund(mallory);
    }

    function _fund(address who) internal {
        t0.mint(who, FUNDING);
        t1.mint(who, FUNDING);
        vm.startPrank(who);
        t0.approve(address(vault), type(uint256).max);
        t1.approve(address(vault), type(uint256).max);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        t0.approve(address(router), type(uint256).max);
        t1.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address who) internal view returns (uint256, uint256) {
        return (t0.balanceOf(who), t1.balanceOf(who));
    }

    function _open(address who, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = vault.open(hookKey, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function _onChainLiquidity(uint256 id) internal view returns (uint128) {
        MolePositions.Position memory p = vault.getPosition(id);
        return StateLibrary.getPositionLiquidity(
            manager, hookId, V4Position.calculatePositionKey(address(vault), p.tickLower, p.tickUpper, bytes32(id))
        );
    }

    /// @dev INV-1, both halves, for any of our contracts: no ERC-20 balance and no ERC-6909 claim.
    function _assertHoldsNothing(address who, string memory when) internal view {
        assertEq(t0.balanceOf(who), 0, string.concat("holds currency0: ", when));
        assertEq(t1.balanceOf(who), 0, string.concat("holds currency1: ", when));
        assertEq(manager.balanceOf(who, currency0.toId()), 0, string.concat("holds 6909 claim 0: ", when));
        assertEq(manager.balanceOf(who, currency1.toId()), 0, string.concat("holds 6909 claim 1: ", when));
    }

    /// @dev A one-hop v4 plan through the hook pool, ERC-20 both ends.
    function _v4Plan(bool zeroForOne, uint256 amt, uint256 minOut, address recipient)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        address tin = Currency.unwrap(zeroForOne ? currency0 : currency1);
        address tout = Currency.unwrap(zeroForOne ? currency1 : currency0);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), zeroForOne, tin, tout, hookKey);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amt, hops);
        plan = MoleRouter.SwapPlan(tin, tout, amt, minOut, recipient, block.timestamp + 1, paths);
    }
}
