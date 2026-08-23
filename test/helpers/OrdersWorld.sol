// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MoleOrders} from "../../src/MoleOrders.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleRouter} from "./ProxyDeploy.sol";

/// @notice The world every MoleOrders attack file needs, in the shape the contract now actually ships in:
///         a real PoolManager, a real MoleHook whose TWAP is the order book's price bound, and a real
///         MoleRouter to execute through.
///
/// Two pools over the SAME pair, both opened at 1:1, both deep:
///   - `oraclePool` carries the hook, so it both prices orders and can be routed through (this is the
///     production shape: the MoleSwap pool is the reference),
///   - `plainPool` carries no hook, so a split route has a second, genuinely different venue to use.
///     A split is the only way to reproduce the router's rounded-down path rescale, which is the half of
///     F-02 that broke honest fills.
///
/// TIME. The book refuses a TWAP window shorter than five minutes, and `consult` refuses a window its
/// observations do not cover, so the world opens at a realistic timestamp and then advances past one full
/// window before any order exists. `_advance` keeps an explicit clock because `vm.warp` inside a loop does
/// not accumulate — solc caches `block.timestamp` per call frame.
abstract contract OrdersWorld is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant T0 = 1_750_000_000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint24 internal constant LP_FEE = 3000; // 0.30%, on both pools
    uint32 internal constant TWAP_WINDOW = 1800; // 30 minutes, the shipped default
    uint16 internal constant SLIP_BPS = 100; // 1% — what a sane client asks for

    MoleHook internal hook;
    MoleRouter internal router;
    MoleOrders internal book;
    MockERC20 internal tokenA; // order input
    MockERC20 internal tokenB; // order output
    PoolKey internal oraclePool;
    PoolKey internal plainPool;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal admin = makeAddr("admin");
    address internal attacker = makeAddr("attacker");
    address internal treasury = makeAddr("treasury");

    uint256 internal _clock;

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("orders-world", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @param feeDial the MoleFeeDial to wire into the router, or address(0) for a feeless router.
    function _buildWorld(address feeDial) internal {
        _clock = T0;
        vm.warp(_clock);
        deployFreshManagerAndRouters();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);

        address ha = _hookAddr(1);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, address(this)),
            ha
        );
        hook = MoleHook(ha);

        router = deployMoleRouter(
            manager, makeAddr("weth"), feeDial, feeDial == address(0) ? address(0) : treasury
        );
        book = new MoleOrders(router, admin, keeper);

        oraclePool = PoolKey({
            currency0: Currency.wrap(address(tokenA)),
            currency1: Currency.wrap(address(tokenB)),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(ha)
        });
        manager.initialize(oraclePool, SQRT_PRICE_1_1);

        plainPool = PoolKey({
            currency0: Currency.wrap(address(tokenA)),
            currency1: Currency.wrap(address(tokenB)),
            fee: LP_FEE,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(plainPool, SQRT_PRICE_1_1);

        tokenA.mint(address(this), 5_000_000e18);
        tokenB.mint(address(this), 5_000_000e18);
        tokenA.approve(address(modifyLiquidityRouter), type(uint256).max);
        tokenB.approve(address(modifyLiquidityRouter), type(uint256).max);
        tokenA.approve(address(swapRouter), type(uint256).max);
        tokenB.approve(address(swapRouter), type(uint256).max);
        _addLiquidity(oraclePool, 200_000e18);
        _addLiquidity(plainPool, 200_000e18);

        // Owner funds + approves the order book (NOT the router — the book pulls, then routes).
        tokenA.mint(owner, 1_000e18);
        vm.prank(owner);
        tokenA.approve(address(book), type(uint256).max);

        // One full TWAP window of history, so `consult(TWAP_WINDOW)` is answerable from the observation
        // afterInitialize seeded.
        _advance(TWAP_WINDOW + 200);
    }

    function _addLiquidity(PoolKey memory k, int256 amount) internal {
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: amount, salt: 0}), ""
        );
    }

    /// @dev Move the market by trading against a pool directly (not through the router).
    function _marketSwap(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /* ------------------------------------------------------------------------------- plan construction */

    function _v4Hop(PoolKey memory k) internal view returns (MoleRouter.Hop memory) {
        return MoleRouter.Hop({
            venue: MoleRouter.Venue.UniswapV4,
            pool: address(0),
            zeroForOne: true, // tokenA is currency0 in both pools
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            key: k
        });
    }

    /// @dev A single-path plan through the hooked pool.
    function _plan(address recipient, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = _v4Hop(oraclePool);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});
        plan = MoleRouter.SwapPlan({
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: recipient,
            deadline: block.timestamp + 60,
            paths: paths
        });
    }

    /// @dev A two-path plan — the split the aggregator produces by default, and the shape that used to
    ///      revert `Residual()` the instant the fee dial was non-zero.
    function _splitPlan(address recipient, uint256 amountIn, uint256 minOut, uint256 firstShare)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        MoleRouter.Hop[] memory h0 = new MoleRouter.Hop[](1);
        h0[0] = _v4Hop(oraclePool);
        MoleRouter.Hop[] memory h1 = new MoleRouter.Hop[](1);
        h1[0] = _v4Hop(plainPool);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](2);
        paths[0] = MoleRouter.Path({amountIn: firstShare, hops: h0});
        paths[1] = MoleRouter.Path({amountIn: amountIn - firstShare, hops: h1});
        plan = MoleRouter.SwapPlan({
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: recipient,
            deadline: block.timestamp + 60,
            paths: paths
        });
    }

    /* ------------------------------------------------------------------------------ order construction */

    function _createOrder(uint256 amountPerLeg, uint256 totalBudget, uint256 minOutPerLeg, uint64 interval)
        internal
        returns (uint256 id)
    {
        return _createOrderWithSlip(amountPerLeg, totalBudget, minOutPerLeg, interval, SLIP_BPS);
    }

    /// @dev `maxSlippageBps` is measured on the POST-FEE output the owner actually receives, so an order
    ///      routed through a fee-bearing router needs a tolerance that covers the aggregator fee and the
    ///      pool fee as well as price impact. Tests that turn the fee dial on say so explicitly.
    function _createOrderWithSlip(
        uint256 amountPerLeg,
        uint256 totalBudget,
        uint256 minOutPerLeg,
        uint64 interval,
        uint16 slipBps
    ) internal returns (uint256 id) {
        vm.prank(owner);
        id = book.createOrder(
            address(tokenA),
            address(tokenB),
            amountPerLeg,
            totalBudget,
            minOutPerLeg,
            interval,
            oraclePool,
            TWAP_WINDOW,
            slipBps
        );
    }

    /// @dev The plan an HONEST keeper builds: read the leg and its live floor from the contract, pin
    ///      `minAmountOut` to exactly that floor.
    function _honestPlan(uint256 id) internal view returns (MoleRouter.SwapPlan memory) {
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        return _plan(owner, legIn, floorOut);
    }
}
