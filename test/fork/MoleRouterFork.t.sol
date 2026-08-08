// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {MoleRouter, IPancakeV3Pool} from "../../src/MoleRouter.sol";

/// @title MoleRouterFork
/// @notice The back-to-back proof: a swap driven through MoleRouter on the LIVE chain delivers exactly
///         what the pool itself delivers, and leaves the router holding nothing.
///
/// This is the on-chain half of a three-way agreement. The off-chain TypeScript quoter is already
/// verified against raw on-chain swaps to the wei (`router/test/liveParity.test.ts`). This test verifies
/// MoleRouter's delivered output equals a raw on-chain swap to the wei. Transitively: the number the user
/// is quoted off-chain is the number MoleRouter pays them, with nothing lost in the executor.
///
///   forge test --match-path test/fork/MoleRouterFork.t.sol --fork-url rh_mainnet --threads 1 -vv
contract MoleRouterFork is Test {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    // The three live PancakeSwap V3 WETH/USDG pools, by fee tier.
    address internal constant POOL_100 = 0x4520F3f932AE530c58CC332b532951e5814e6CB8;
    address internal constant POOL_500 = 0x88A8E96E7785d378825e8B5D7FC0e6f62487061E;
    address internal constant POOL_10000 = 0x0ff6bdD6ac5DB3426C3C2c922F93a5749887E28d;

    MoleRouter internal router;
    address internal user = makeAddr("router.user");

    function setUp() public {
        if (block.chainid != 4663) vm.skip(true);
        router = new MoleRouter(POOL_MANAGER, WETH);
    }

    /* ------------------------------------------------------------------------------------------ helpers */

    function _oneHopPlan(address pool, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.PancakeV3,
            pool: pool,
            zeroForOne: tokenIn == WETH, // WETH is token0 (lower address)
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            key: _emptyKey()
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});
        plan = MoleRouter.SwapPlan({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: user,
            deadline: block.timestamp + 1,
            paths: paths
        });
    }

    function _emptyKey() internal pure returns (PoolKey memory k) {
        k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0)),
            fee: 0,
            tickSpacing: 0,
            hooks: IHooks(address(0))
        });
    }

    /// @dev What a raw swap through the pool returns, measured in a snapshot and rolled back, so the
    ///      comparison target is the pool's own arithmetic and not a second model of it.
    function _rawSwapOut(address pool, address tokenIn, uint256 amountIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        RawSwapProbe probe = new RawSwapProbe();
        deal(tokenIn, address(probe), amountIn);
        out = probe.run(pool, tokenIn == WETH, amountIn, tokenIn);
        vm.revertToState(snap);
    }

    /* ---------------------------------------------------------------------------------- exactness proof */

    function test_singleHop_deliversExactlyTheRawPoolOutput_andHoldsNothing() public {
        uint256 amountIn = 5e17; // 0.5 WETH
        uint256 expected = _rawSwapOut(POOL_500, WETH, amountIn);
        assertGt(expected, 0, "premise: the pool should quote a nonzero output");

        deal(WETH, user, amountIn);
        vm.prank(user);
        IERC20L(WETH).approve(address(router), amountIn);

        uint256 balBefore = IERC20L(USDG).balanceOf(user);
        vm.prank(user);
        uint256 got = router.swap(_oneHopPlan(POOL_500, WETH, USDG, amountIn, expected));

        assertEq(got, expected, "router delivered a different amount than the raw pool swap");
        assertEq(IERC20L(USDG).balanceOf(user) - balBefore, expected, "recipient did not net the full output");

        // The load-bearing invariant: the router keeps nothing.
        assertEq(IERC20L(WETH).balanceOf(address(router)), 0, "router retained input token");
        assertEq(IERC20L(USDG).balanceOf(address(router)), 0, "router retained output token");
    }

    function test_reverseDirection_USDGtoWETH_isExact() public {
        uint256 amountIn = 1000e6; // 1000 USDG
        uint256 expected = _rawSwapOut(POOL_500, USDG, amountIn);
        assertGt(expected, 0, "premise");

        deal(USDG, user, amountIn);
        vm.prank(user);
        IERC20L(USDG).approve(address(router), amountIn);

        vm.prank(user);
        uint256 got = router.swap(_oneHopPlan(POOL_500, USDG, WETH, amountIn, expected));
        assertEq(got, expected, "reverse-direction output diverged from the raw swap");
        assertEq(IERC20L(WETH).balanceOf(address(router)), 0, "residual WETH");
        assertEq(IERC20L(USDG).balanceOf(address(router)), 0, "residual USDG");
    }

    /* -------------------------------------------------------------------------- splitting across venues */

    function test_split_acrossTwoFeeTiers_sumsTheParts_andHoldsNothing() public {
        // Half through the deep 0.05% pool, half through the 1% pool. This is the aggregator's whole
        // point: two pools in one atomic transaction, output summed, nothing stuck in the middle.
        uint256 half = 25e16; // 0.25 WETH each
        uint256 e500 = _rawSwapOut(POOL_500, WETH, half);
        uint256 e10000 = _rawSwapOut(POOL_10000, WETH, half);
        assertGt(e500, 0, "premise 500");
        assertGt(e10000, 0, "premise 10000");

        MoleRouter.Hop[] memory h500 = new MoleRouter.Hop[](1);
        h500[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, POOL_500, true, WETH, USDG, _emptyKey());
        MoleRouter.Hop[] memory h10000 = new MoleRouter.Hop[](1);
        h10000[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, POOL_10000, true, WETH, USDG, _emptyKey());

        MoleRouter.Path[] memory paths = new MoleRouter.Path[](2);
        paths[0] = MoleRouter.Path(half, h500);
        paths[1] = MoleRouter.Path(half, h10000);

        MoleRouter.SwapPlan memory plan = MoleRouter.SwapPlan({
            tokenIn: WETH,
            tokenOut: USDG,
            amountIn: 5e17,
            minAmountOut: e500 + e10000,
            recipient: user,
            deadline: block.timestamp + 1,
            paths: paths
        });

        deal(WETH, user, 5e17);
        vm.prank(user);
        IERC20L(WETH).approve(address(router), 5e17);

        uint256 balBefore = IERC20L(USDG).balanceOf(user);
        vm.prank(user);
        uint256 got = router.swap(plan);

        assertEq(got, e500 + e10000, "split total is not the sum of the parts");
        assertEq(IERC20L(USDG).balanceOf(user) - balBefore, got, "recipient did not net the split output");
        assertEq(IERC20L(WETH).balanceOf(address(router)), 0, "residual input after split");
        assertEq(IERC20L(USDG).balanceOf(address(router)), 0, "residual output after split");
    }

    /* ------------------------------------------------------------------------------------ minOut guard */

    function test_minOut_isTheOnlyPromise_andItReverts_notUnderfills() public {
        uint256 amountIn = 5e17;
        uint256 expected = _rawSwapOut(POOL_500, WETH, amountIn);

        deal(WETH, user, amountIn);
        vm.prank(user);
        IERC20L(WETH).approve(address(router), amountIn);

        // Demand one wei more than the pool can possibly give. It must revert, and the user must keep
        // their input — a swap that cannot meet minOut is a swap that does not happen.
        MoleRouter.SwapPlan memory plan = _oneHopPlan(POOL_500, WETH, USDG, amountIn, expected + 1);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.InsufficientOutput.selector, expected, expected + 1));
        router.swap(plan);

        assertEq(IERC20L(WETH).balanceOf(user), amountIn, "input was taken by a reverted swap");
        assertEq(IERC20L(USDG).balanceOf(address(router)), 0, "router held output after a revert");
    }

    /* -------------------------------------------------------------------------- native ETH, on mainnet */

    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Native ETH IN on the live chain: the router wraps the attached ETH to the REAL WETH and
    ///         swaps it through the deep Pancake pool, delivering USDG and holding nothing.
    function test_nativeIn_wrapsRealWethAndSwaps() public {
        uint256 amountIn = 5e17; // 0.5 ETH
        uint256 expected = _rawSwapOut(POOL_500, WETH, amountIn);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, POOL_500, true, WETH, USDG, _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amountIn, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(NATIVE, USDG, amountIn, expected, user, block.timestamp + 1, paths);

        vm.deal(user, amountIn);
        uint256 usdgBefore = IERC20L(USDG).balanceOf(user);
        vm.prank(user);
        uint256 got = router.swap{value: amountIn}(plan);

        assertEq(got, expected, "native-in delivered a different amount than the raw swap");
        assertEq(IERC20L(USDG).balanceOf(user) - usdgBefore, expected, "recipient did not net the output");
        assertEq(user.balance, 0, "native input not consumed");
        assertEq(address(router).balance, 0, "router retained native ETH");
        assertEq(IERC20L(WETH).balanceOf(address(router)), 0, "router retained WETH");
    }

    /// @notice Native ETH OUT on the live chain: swap USDG through the pool to WETH, unwrap the real WETH,
    ///         and deliver ETH to the recipient.
    function test_nativeOut_swapsAndUnwrapsRealWeth() public {
        uint256 amountIn = 1000e6; // 1000 USDG
        uint256 expected = _rawSwapOut(POOL_500, USDG, amountIn); // USDG -> WETH out

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.PancakeV3, POOL_500, false, USDG, WETH, _emptyKey());
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amountIn, hops);
        MoleRouter.SwapPlan memory plan =
            MoleRouter.SwapPlan(USDG, NATIVE, amountIn, expected, user, block.timestamp + 1, paths);

        deal(USDG, user, amountIn);
        vm.prank(user);
        IERC20L(USDG).approve(address(router), amountIn);
        uint256 ethBefore = user.balance;
        vm.prank(user);
        uint256 got = router.swap(plan);

        assertEq(got, expected, "native-out delivered a different amount than the raw swap");
        assertEq(user.balance - ethBefore, expected, "recipient did not receive native ETH");
        assertEq(address(router).balance, 0, "router retained native ETH");
        assertEq(IERC20L(WETH).balanceOf(address(router)), 0, "router retained WETH");
        assertEq(IERC20L(USDG).balanceOf(address(router)), 0, "router retained input");
    }
}

interface IERC20L {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}


/// @dev A raw pool swap, used only to produce the exactness target.
contract RawSwapProbe {
    function run(address pool, bool zeroForOne, uint256 amountIn, address tokenIn) external returns (uint256) {
        (int256 a0, int256 a1) = IPancakeV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
            abi.encode(tokenIn)
        );
        return zeroForOne ? uint256(-a1) : uint256(-a0);
    }

    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        address tokenIn = abi.decode(data, (address));
        if (a0 > 0) IERC20L(tokenIn).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20L(tokenIn).transfer(msg.sender, uint256(a1));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        this.pancakeV3SwapCallback(a0, a1, data);
    }
}
