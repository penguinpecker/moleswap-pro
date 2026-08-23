// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {deployMoleRouter} from "../helpers/ProxyDeploy.sol";

/// @title AttackRouterHopBounds
/// @notice The router is the address every MoleSwap user grants a standing max approval to, so the only
///         thing standing between a hostile ROUTE and user money is what the router refuses to do on its
///         own account. The 2026-08-23 audit found three ways that refusal was incomplete, and all three
///         share one root: the router treated numbers chosen by an untrusted counterparty as facts.
///
///           F-08 — a v3 hop names an ARBITRARY pool address. The callback paid whatever that address
///                  demanded (no per-hop ceiling at all — `amountIn` was not even in scope), and the hop's
///                  output was read out of the same address's return value with no balance ever measured.
///                  A contract that transfers nothing could therefore both take the router's standing
///                  balance of the input token and mint an output out of the router's balance of another.
///           F-09 — a v4 hop's PoolKey is caller data. Validation and the sweep set were built from the
///                  hop's declared token labels, while the currencies that actually moved came from the
///                  key, so the validated set and the executed set were two different sets.
///           F-10 — ETH pushed into the router mid-swap had no sweep leg at all and sat here forever.
///
/// Every test below drives the real attack and asserts on BALANCES — what the attacker ended up holding
/// and what the router still holds — rather than merely that some call reverted. Each one is written so
/// that deleting the single guard it names turns it from green to red.
contract AttackRouterHopBounds is Test, Deployers {
    MoleRouter internal router;
    MockWETH internal weth;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;

    address internal user = makeAddr("user");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        deployFreshManagerAndRouters();
        weth = new MockWETH();
        router = deployMoleRouter(manager, address(weth), address(0), address(0));
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
    }

    /* --------------------------------------------------------------------------------------- utilities */

    function _emptyKey() internal pure returns (PoolKey memory k) {
        k = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(0)), 0, 0, IHooks(address(0)));
    }

    function _hop(address pool, address tokenIn, address tokenOut) internal pure returns (MoleRouter.Hop memory) {
        return MoleRouter.Hop(MoleRouter.Venue.PancakeV3, pool, true, tokenIn, tokenOut, _emptyKey());
    }

    function _onePath(MoleRouter.Hop memory h, uint256 amt) internal pure returns (MoleRouter.Path[] memory paths) {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = h;
        paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amt, hops);
    }

    function _plan(
        MoleRouter.Path[] memory paths,
        address tokenIn,
        address tokenOut,
        uint256 amt,
        uint256 minOut,
        address recipient
    ) internal view returns (MoleRouter.SwapPlan memory) {
        return MoleRouter.SwapPlan(tokenIn, tokenOut, amt, minOut, recipient, block.timestamp + 1, paths);
    }

    /* ============================================================ F-08 A — the per-hop payment ceiling */

    /// @notice THE DRAIN THE AUDIT DESCRIBES, END TO END. The router is holding 1,000 A (an airdrop, a
    ///         mis-sent transfer, a future residual — the router's own suite already proves such a balance
    ///         is meant to survive a swap untouched). The attacker submits a one-wei swap whose "pool" is
    ///         a contract they wrote; inside `pool.swap` it calls the router's public v3 callback back and
    ///         demands the ENTIRE 1,000 A, then returns (0,0). With `minAmountOut = 0` the swap would
    ///         otherwise complete successfully and the sweep would restore nothing, because the balance
    ///         went DOWN. The hop budget is the guard: this hop was allotted one wei, so one wei is the
    ///         most it can be made to pay.
    /// @dev GUARD: `_payV3Callback`'s `if (owed > budget) revert HopInputExceeded(...)`.
    function test_hostilePoolCannotDrainAStandingBalanceThroughTheCallback() public {
        tokenA.mint(address(router), 1_000e18); // the standing balance the attacker is after
        GreedyCallbackPool pool = new GreedyCallbackPool(address(tokenA), 1_000e18 + 1);

        tokenA.mint(attacker, 1);
        vm.prank(attacker);
        tokenA.approve(address(router), 1);

        MoleRouter.SwapPlan memory plan =
            _plan(_onePath(_hop(address(pool), address(tokenA), address(tokenB)), 1), address(tokenA), address(tokenB), 1, 0, attacker);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.HopInputExceeded.selector, 1_000e18 + 1, 1));
        router.swap(plan);

        assertEq(tokenA.balanceOf(address(router)), 1_000e18, "the router's standing balance was drained");
        assertEq(tokenA.balanceOf(address(pool)), 0, "the hostile pool was paid");
        assertEq(tokenA.balanceOf(attacker), 1, "the attacker's own input moved");
    }

    /// @notice The same ceiling, per PATH. A two-path route splits 100 A into 50 + 50; path 1's pool
    ///         demands 100 — its own slice AND path 2's. Without a per-hop budget the demand is bounded
    ///         only by the router's whole balance, so with a 60 A airdrop present path 1 takes 100, path 2
    ///         still gets its honest 50, and 50 of the airdrop is gone while the swap SUCCEEDS. The budget
    ///         pins each hop to the slice the route declared for it.
    /// @dev GUARD: `_payV3Callback`'s `if (owed > budget) revert HopInputExceeded(...)`.
    function test_pathOnePoolCannotEatPathTwosSlice() public {
        tokenA.mint(address(router), 60e18); // standing balance that makes the un-guarded drain succeed
        GreedyCallbackPool greedy = new GreedyCallbackPool(address(tokenA), 100e18);
        HonestPool honest = new HonestPool(address(tokenA), address(tokenB));
        tokenB.mint(address(honest), 1_000e18);
        tokenB.mint(address(greedy), 1_000e18);

        MoleRouter.Hop[] memory h1 = new MoleRouter.Hop[](1);
        h1[0] = _hop(address(greedy), address(tokenA), address(tokenB));
        MoleRouter.Hop[] memory h2 = new MoleRouter.Hop[](1);
        h2[0] = _hop(address(honest), address(tokenA), address(tokenB));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](2);
        paths[0] = MoleRouter.Path(50e18, h1);
        paths[1] = MoleRouter.Path(50e18, h2);

        tokenA.mint(attacker, 100e18);
        vm.prank(attacker);
        tokenA.approve(address(router), 100e18);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.HopInputExceeded.selector, 100e18, 50e18));
        router.swap(_plan(paths, address(tokenA), address(tokenB), 100e18, 0, attacker));

        assertEq(tokenA.balanceOf(address(router)), 60e18, "path 1 ate into the router's standing balance");
        assertEq(tokenA.balanceOf(address(greedy)), 0, "the greedy pool was paid beyond its slice");
    }

    /// @notice The ceiling is CUMULATIVE, not per-invocation. A v3 pool may call the callback as many
    ///         times as it likes inside one `pool.swap()` — the active pin is not cleared until that call
    ///         returns — so a limit that merely compared each demand against the hop's input would be
    ///         defeated by asking for it twice. The budget is decremented as it is spent, so the second
    ///         ask sees a remaining budget of zero.
    /// @dev GUARD: `_spendBudget(owed)` in `_payV3Callback` (the decrement, not the comparison).
    function test_repeatedCallbacksInOneSwapCannotExceedTheHopBudgetInAggregate() public {
        tokenA.mint(address(router), 100e18); // the standing balance a second helping would come out of
        DoubleDipPool pool = new DoubleDipPool(address(tokenA), 10e18);

        tokenA.mint(attacker, 10e18);
        vm.prank(attacker);
        tokenA.approve(address(router), 10e18);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.HopInputExceeded.selector, 10e18, 0));
        router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(tokenB)), 10e18),
                address(tokenA),
                address(tokenB),
                10e18,
                0,
                attacker
            )
        );

        assertEq(tokenA.balanceOf(address(router)), 100e18, "the second helping came out of the standing balance");
        assertEq(tokenA.balanceOf(address(pool)), 0, "the double-dipping pool kept anything");
    }

    /* ================================================== F-08 B — the output is measured, not announced */

    /// @notice A "pool" that transfers NOTHING and simply declares a fat output. Before the fix the hop's
    ///         output was `-amount1` straight off that call, so `_deliverOutput` pushed 1,000 B to the
    ///         attacker out of the router's OWN balance of B, and `minAmountOut = 0` waved it through —
    ///         a mint-from-thin-air whose only limit was what the router happened to be holding. The hop
    ///         output is now a measured balance delta, so a pool that pays nothing produces nothing.
    /// @dev GUARD: `_swapV3`'s `amountOut = measured < claimed ? measured : claimed`.
    function test_lyingPoolCannotMintOutputFromTheRoutersOwnBalance() public {
        tokenB.mint(address(router), 1_000e18); // the standing balance the fabricated delta would pay out
        LyingPool pool = new LyingPool(address(tokenA), 1_000e18); // claims 1,000 B, transfers zero

        tokenA.mint(attacker, 1);
        vm.prank(attacker);
        tokenA.approve(address(router), 1);

        vm.prank(attacker);
        uint256 got = router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(tokenB)), 1),
                address(tokenA),
                address(tokenB),
                1,
                0,
                attacker
            )
        );

        assertEq(got, 0, "the router credited an output no pool ever paid");
        assertEq(tokenB.balanceOf(attacker), 0, "the attacker was paid out of the router's own balance");
        assertEq(tokenB.balanceOf(address(router)), 1_000e18, "the router's standing B balance was drained");
    }

    /// @notice The same lie, aimed at WETH and cashed out as native ETH — the variant the audit calls out
    ///         because `plan.tokenOut = NATIVE` turns the fabricated delta into `IWETH.withdraw` plus a
    ///         raw send to an attacker-chosen address, which no token blacklist or transfer hook can stop.
    /// @dev GUARD: `_swapV3`'s `amountOut = measured < claimed ? measured : claimed`.
    function test_lyingPoolCannotDrainStrandedWethAsNativeEth() public {
        // Park 8 ETH of real, withdrawable WETH in the router.
        vm.deal(address(this), 8 ether);
        weth.deposit{value: 8 ether}();
        weth.transfer(address(router), 8 ether);

        LyingPool pool = new LyingPool(address(tokenA), 8 ether); // claims 8 WETH out, transfers zero

        tokenA.mint(attacker, 1);
        vm.prank(attacker);
        tokenA.approve(address(router), 1);
        uint256 attackerEthBefore = attacker.balance;

        vm.prank(attacker);
        uint256 got = router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(weth)), 1),
                address(tokenA),
                0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE,
                1,
                0,
                attacker
            )
        );

        assertEq(got, 0, "a fabricated WETH delta was credited");
        assertEq(attacker.balance, attackerEthBefore, "the attacker cashed out the router's WETH as ETH");
        assertEq(weth.balanceOf(address(router)), 8 ether, "the router's parked WETH was unwrapped away");
    }

    /// @notice The measurement is a FLOOR, not a replacement: a pool that over-delivers is still tracked
    ///         at what it announced, and the surplus is swept to the payer rather than handed to the
    ///         recipient. This is the half of the clamp that stops a mid-swap airdrop of the output token
    ///         from inflating the recipient's take, and it is why the fix keeps the pool's number as a
    ///         ceiling instead of discarding it.
    /// @dev GUARD: the `claimed` side of `amountOut = measured < claimed ? measured : claimed`.
    function test_overDeliveringPoolIsStillTrackedAtItsAnnouncedOutput() public {
        GenerousPool pool = new GenerousPool(address(tokenA), address(tokenB)); // says 1:1, pays 1.5:1
        tokenB.mint(address(pool), 1_000e18);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        address recipient = makeAddr("recipient");

        vm.prank(user);
        uint256 got = router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(tokenB)), 100e18),
                address(tokenA),
                address(tokenB),
                100e18,
                0,
                recipient
            )
        );

        assertEq(got, 100e18, "the tracked output followed the measurement instead of the announcement");
        assertEq(tokenB.balanceOf(recipient), 100e18, "recipient did not get the tracked output");
        assertEq(tokenB.balanceOf(user), 50e18, "the surplus was not swept to the payer");
        assertEq(tokenB.balanceOf(address(router)), 0, "the router stranded the surplus");
    }

    /* ============================================ F-08 C — an unvalidated pool address is now BOUNDED */

    /// @notice `hop.pool` is never checked to be a real pool, and only the first hop's INPUT label is
    ///         pinned to the plan — `hops[0].tokenOut` is free, so hop 2's pinned payment token is
    ///         attacker-chosen. The audit's amplifier: name a token the router holds as hop 1's output,
    ///         then have hop 2's "pool" demand all of it. The two fixes compose to close it — hop 2's
    ///         budget is hop 1's MEASURED output, and a pool that delivered nothing hands its successor a
    ///         budget of zero.
    /// @dev GUARD: `_payV3Callback`'s budget check, fed by `_swapV3`'s measured delta.
    function test_unvalidatedSecondHopCannotBeFundedByAFakeFirstHop() public {
        MockERC20 tokenX = new MockERC20("X", "X", 18);
        tokenX.mint(address(router), 900e18); // the target: a token the router holds

        LyingPool fake = new LyingPool(address(tokenA), 900e18); // claims 900 X out of hop 1, transfers zero
        GreedyCallbackPool grab = new GreedyCallbackPool(address(tokenX), 900e18); // hop 2 demands all of it

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = _hop(address(fake), address(tokenA), address(tokenX));
        hops[1] = _hop(address(grab), address(tokenX), address(tokenB));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(1, hops);

        tokenA.mint(attacker, 1);
        vm.prank(attacker);
        tokenA.approve(address(router), 1);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.HopInputExceeded.selector, 900e18, 0));
        router.swap(_plan(paths, address(tokenA), address(tokenB), 1, 0, attacker));

        assertEq(tokenX.balanceOf(address(router)), 900e18, "the router's X balance was drained via hop 2");
        assertEq(tokenX.balanceOf(address(grab)), 0, "hop 2's pool was paid a token hop 1 never produced");
    }

    /// @notice A hop that claims to swap a token for itself is refused before any pool is called. It is
    ///         the one shape that would make the measured output delta ambiguous, since the payment and
    ///         the proceeds would net inside a single balance read.
    /// @dev GUARD: `_runPath`'s `if (hop.tokenIn == hop.tokenOut) revert HopChainBroken();`
    function test_hopThatSwapsATokenForItselfIsRefused() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        HonestPool honest = new HonestPool(address(tokenA), address(tokenA));

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = _hop(address(honest), address(tokenA), address(tokenA)); // A -> A
        hops[1] = _hop(address(honest), address(tokenA), address(tokenC));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(10e18, hops);

        tokenA.mint(attacker, 10e18);
        vm.prank(attacker);
        tokenA.approve(address(router), 10e18);

        vm.prank(attacker);
        vm.expectRevert(MoleRouter.HopChainBroken.selector);
        router.swap(_plan(paths, address(tokenA), address(tokenC), 10e18, 0, attacker));
    }

    /* ================================ F-09 — the executed currencies are the validated currencies */

    /// @notice THE KEY/LABEL MISMATCH, DRIVEN AS THEFT. The plan declares a hop (A -> D) so `_runPath`'s
    ///         chain check passes and `_touchedTokens` snapshots {A, D}; the PoolKey names a real (C, D)
    ///         pool, so the currency that actually leaves the router is C — a token nothing snapshotted
    ///         and nothing sweeps. The attacker's declared input A is pulled, never spent, and swept
    ///         straight back to them at the end, so the whole trade is funded out of the router's C.
    /// @dev GUARD: `_swapV4`'s `Currency.unwrap(declaredIn) != hop.tokenIn || ... revert HopChainBroken()`.
    function test_v4KeyCannotName_ACurrencyTheDeclaredLabelsNeverMentioned() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        MockERC20 tokenD = new MockERC20("D", "D", 18);
        (MockERC20 lo, MockERC20 hi) = address(tokenC) < address(tokenD) ? (tokenC, tokenD) : (tokenD, tokenC);
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(lo)),
            currency1: Currency.wrap(address(hi)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, SQRT_PRICE_1_1);
        lo.mint(address(this), 200_000e18);
        hi.mint(address(this), 200_000e18);
        lo.approve(address(modifyLiquidityRouter), type(uint256).max);
        hi.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100_000e18, salt: 0}), ""
        );

        // The router is holding the currency the key really spends.
        lo.mint(address(router), 500e18);

        // Declared: A -> hi. Executed by the key: lo -> hi. Both labels chain, so nothing before
        // `_swapV4` objects.
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), true, address(tokenA), address(hi), key);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(100e18, hops);

        tokenA.mint(attacker, 100e18);
        vm.prank(attacker);
        tokenA.approve(address(router), 100e18);

        vm.prank(attacker);
        vm.expectRevert(MoleRouter.HopChainBroken.selector);
        router.swap(_plan(paths, address(tokenA), address(hi), 100e18, 0, attacker));

        assertEq(lo.balanceOf(address(router)), 500e18, "a currency the labels never named was spent");
        assertEq(hi.balanceOf(attacker), 0, "the attacker was paid out of an unvalidated currency");
        assertEq(tokenA.balanceOf(attacker), 100e18, "the attacker's declared input moved");
    }

    /// @notice The honest v4 route still works, so the currency binding is a tightening and not a ban:
    ///         the off-chain planner derives tokenIn/tokenOut from the very currency ordering it puts in
    ///         the key, so a real plan already satisfies it.
    function test_v4HopWithMatchingLabelsStillExecutes() public {
        (Currency c0, Currency c1) = deployMintAndApprove2Currencies();
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))});
        manager.initialize(key, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100_000e18, salt: 0}), ""
        );

        address t0 = Currency.unwrap(c0);
        address t1 = Currency.unwrap(c1);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), true, t0, t1, key);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(1e18, hops);

        MockERC20(t0).mint(user, 1e18);
        vm.prank(user);
        MockERC20(t0).approve(address(router), 1e18);

        vm.prank(user);
        uint256 got = router.swap(_plan(paths, t0, t1, 1e18, 1, user));
        assertGt(got, 0, "the honest v4 hop stopped producing output");
        assertEq(MockERC20(t1).balanceOf(user), got, "recipient did not net the v4 output");
    }

    /// @notice `hop.key.hooks` is attacker-supplied, and a hook carrying BEFORE_SWAP_RETURNS_DELTA has its
    ///         returned delta applied to the SWAPPER's deltas by v4-core — so `owed` is hook-controlled,
    ///         not pool-math-controlled, and the only guard on it rejected a POSITIVE owed. Modelled here
    ///         with a PoolManager that returns whatever delta it is told to: the swap specifies 1 A of
    ///         input and the "pool" answers that the router owes 1,000 A, which `_settle` would hand over
    ///         out of the router's standing balance. An exact-input swap can never spend more than it
    ///         specified, and now it cannot.
    /// @dev GUARD: `_swapV4`'s `if (spend > amountIn) revert HopInputExceeded(spend, amountIn);`
    function test_v4HookCannotInflateWhatTheRouterSettles() public {
        DeltaDictatingPoolManager fakePm = new DeltaDictatingPoolManager();
        MoleRouter hooked = deployMoleRouter(IPoolManager(address(fakePm)), address(weth), address(0), address(0));

        (MockERC20 lo, MockERC20 hi) = address(tokenA) < address(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
        lo.mint(address(hooked), 1_000e18); // the standing balance the inflated `owed` would take
        fakePm.setDelta(-int128(uint128(1_000e18)), int128(0)); // "you owe 1,000 of currency0, you get 0"

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(lo)),
            currency1: Currency.wrap(address(hi)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), true, address(lo), address(hi), key);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(1e18, hops);

        lo.mint(attacker, 1e18);
        vm.prank(attacker);
        lo.approve(address(hooked), 1e18);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.HopInputExceeded.selector, 1_000e18, 1e18));
        hooked.swap(_plan(paths, address(lo), address(hi), 1e18, 0, attacker));

        assertEq(lo.balanceOf(address(hooked)), 1_000e18, "the hook-inflated debt was settled from the router");
        assertEq(lo.balanceOf(address(fakePm)), 0, "the PoolManager received more than the swap specified");
    }

    /* =================================================== F-10 (router half) — native ETH is net-swept */

    /// @notice `receive()` accepts ETH from anyone while the swap lock is held — which is precisely when a
    ///         hostile token, a route-named "pool" or a v4 hook is executing. `_sweep` walked ERC-20s
    ///         only, so that ETH had no way out of the contract and no recovery path: dead value, and
    ///         exactly the standing balance the F-08 drain existed to monetise. It now leaves with the
    ///         payer, like any other increase the swap caused.
    /// @dev GUARD: the `_sweepNative(nativeBase, payer)` call at the end of `_execute`.
    function test_ethDonatedMidSwapLeavesWithThePayerInsteadOfStranding() public {
        EtherPushingPool pool = new EtherPushingPool(address(tokenA), address(tokenB));
        tokenB.mint(address(pool), 1_000e18);
        vm.deal(address(pool), 3 ether);

        tokenA.mint(user, 100e18);
        vm.prank(user);
        tokenA.approve(address(router), 100e18);
        uint256 payerEthBefore = user.balance;

        vm.prank(user);
        router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(tokenB)), 100e18),
                address(tokenA),
                address(tokenB),
                100e18,
                1,
                user
            )
        );

        assertEq(address(router).balance, 0, "ETH pushed in mid-swap is stranded in the router forever");
        assertEq(user.balance - payerEthBefore, 3 ether, "the donated ETH was not returned to the payer");
    }

    /// @notice And the sweep is a NET-CHANGE sweep, not a whole-balance one. ETH force-fed to the router
    ///         before a swap (SELFDESTRUCT, or the proxy named as a block's fee recipient — `receive()`
    ///         refuses everything else) is unowned by the caller, and handing the contract's entire
    ///         balance to whoever calls next is the precise shape the audit faults in the vault's
    ///         `_refundNative`. The router already treats a pre-existing token airdrop this way; native
    ///         ETH now matches.
    /// @dev GUARD: the `- (plan.tokenIn == NATIVE ? plan.amountIn : 0)` baseline in `_execute`, i.e. that
    ///      `_sweepNative` measures against the balance we came in with rather than against zero.
    function test_preexistingForceFedEthIsPreservedNotHarvestedByTheNextCaller() public {
        vm.deal(address(router), 5 ether); // force-fed: no `receive()` path could have accepted this
        HonestPool pool = new HonestPool(address(tokenA), address(tokenB));
        tokenB.mint(address(pool), 1_000e18);

        tokenA.mint(attacker, 1);
        vm.prank(attacker);
        tokenA.approve(address(router), 1);
        uint256 attackerEthBefore = attacker.balance;

        vm.prank(attacker);
        router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(tokenB)), 1),
                address(tokenA),
                address(tokenB),
                1,
                0,
                attacker
            )
        );

        assertEq(attacker.balance, attackerEthBefore, "the caller harvested force-fed ETH");
        assertEq(address(router).balance, 5 ether, "the force-fed ETH was swept out of the router");
    }

    /// @notice The same preservation across the native legs that actually move ETH — a native-OUT swap
    ///         unwraps WETH and forwards it, so the balance passes through the contract on its way to the
    ///         recipient. The recipient gets exactly the route's output and the unowned balance is
    ///         untouched, which is what proves the baseline is measured rather than assumed to be zero.
    /// @dev GUARD: same baseline as above, exercised through `_deliverOutput`'s unwrap.
    function test_nativeOutSwapDeliversOutputWithoutDisturbingForceFedEth() public {
        vm.deal(address(router), 5 ether);

        HonestPool pool = new HonestPool(address(tokenA), address(weth));
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        weth.transfer(address(pool), 100 ether);

        tokenA.mint(user, 4 ether);
        vm.prank(user);
        tokenA.approve(address(router), 4 ether);
        address recipient = makeAddr("nrecipient");

        vm.prank(user);
        uint256 got = router.swap(
            _plan(
                _onePath(_hop(address(pool), address(tokenA), address(weth)), 4 ether),
                address(tokenA),
                0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE,
                4 ether,
                1,
                recipient
            )
        );

        assertEq(got, 4 ether, "native-out route output changed");
        assertEq(recipient.balance, 4 ether, "recipient did not receive the unwrapped output");
        assertEq(user.balance, 0, "the payer harvested force-fed ETH through the native leg");
        assertEq(address(router).balance, 5 ether, "the force-fed ETH was consumed by a native-out swap");
    }

    /* ============================================================= the invariant all of this adds up to */

    /// @notice THE PROPERTY THAT MAKES A STANDING APPROVAL SAFE, stated as one assertion: whatever route
    ///         is submitted, the router can never end a swap holding LESS of a token than it started with,
    ///         except for the part of the payer's own input it spent. Every mechanism above was a way to
    ///         break exactly this. Driven here with the worst combination the audit describes — a fake
    ///         pool, a fabricated output, `minAmountOut = 0`, and a router holding three separate standing
    ///         balances the plan names.
    function test_noRouteCanReduceTheRoutersStandingBalances() public {
        MockERC20 tokenX = new MockERC20("X", "X", 18);
        tokenA.mint(address(router), 111e18);
        tokenB.mint(address(router), 222e18);
        tokenX.mint(address(router), 333e18);

        LyingPool fake = new LyingPool(address(tokenA), 333e18);
        GreedyCallbackPool grab = new GreedyCallbackPool(address(tokenX), 333e18);

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](2);
        hops[0] = _hop(address(fake), address(tokenA), address(tokenX));
        hops[1] = _hop(address(grab), address(tokenX), address(tokenB));
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(1, hops);

        tokenA.mint(attacker, 1);
        vm.prank(attacker);
        tokenA.approve(address(router), 1);

        vm.prank(attacker);
        try router.swap(_plan(paths, address(tokenA), address(tokenB), 1, 0, attacker)) {}
        catch {}

        assertGe(tokenA.balanceOf(address(router)), 111e18, "standing A balance fell");
        assertEq(tokenB.balanceOf(address(router)), 222e18, "standing B balance fell");
        assertEq(tokenX.balanceOf(address(router)), 333e18, "standing X balance fell");
        assertEq(tokenB.balanceOf(attacker), 0, "the attacker extracted B");
        assertEq(tokenX.balanceOf(attacker), 0, "the attacker extracted X");
    }
}

/* ============================================================================= hostile counterparties */

interface IV3Callback {
    function pancakeV3SwapCallback(int256, int256, bytes calldata) external;
}

interface IERC20M {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

/// @dev An honest constant-1:1 v3-style pool. Demands exactly the input it was offered and pays the
///      output, so it exercises the guards' non-interference with a real route.
contract HonestPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        amount0 = int256(amountIn);
        amount1 = -int256(amountIn);
        IV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        IERC20M(token1).transfer(recipient, amountIn);
    }
}

/// @dev Demands a FIXED amount in the callback, regardless of what the hop offered, then returns a zero
///      delta. This is the F-08 mechanism-A drain: the demand is bounded only by what the router holds.
contract GreedyCallbackPool {
    address public immutable target;
    uint256 public immutable demand;

    constructor(address _target, uint256 _demand) {
        target = _target;
        demand = _demand;
    }

    function swap(address, bool, int256, uint160, bytes calldata data) external returns (int256, int256) {
        IV3Callback(msg.sender).pancakeV3SwapCallback(int256(demand), int256(0), data);
        return (int256(0), int256(0));
    }
}

/// @dev Calls the callback TWICE inside one swap, each time demanding the hop's full input. A ceiling
///      compared per invocation would let both through; a decremented budget stops the second.
contract DoubleDipPool {
    address public immutable target;
    uint256 public immutable each;

    constructor(address _target, uint256 _each) {
        target = _target;
        each = _each;
    }

    function swap(address, bool, int256, uint160, bytes calldata data) external returns (int256, int256) {
        IV3Callback(msg.sender).pancakeV3SwapCallback(int256(each), int256(0), data);
        IV3Callback(msg.sender).pancakeV3SwapCallback(int256(each), int256(0), data);
        return (int256(0), int256(0));
    }
}

/// @dev Takes the input it is owed and DECLARES an output it never transfers — the F-08 mechanism-B lie.
contract LyingPool {
    address public immutable tokenIn;
    uint256 public immutable claimedOut;

    constructor(address _tokenIn, uint256 _claimedOut) {
        tokenIn = _tokenIn;
        claimedOut = _claimedOut;
    }

    function swap(address, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        amount0 = int256(uint256(amountSpecified));
        amount1 = -int256(claimedOut); // announced, never paid
        IV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
    }
}

/// @dev Announces a 1:1 fill and transfers 1.5x — the honest over-receive the tracked output must NOT
///      follow, so the surplus is swept to the payer rather than handed to the recipient.
contract GenerousPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        amount0 = int256(amountIn);
        amount1 = -int256(amountIn);
        IV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        IERC20M(token1).transfer(recipient, (amountIn * 3) / 2);
    }
}

/// @dev An honest pool that also pushes native ETH into the router mid-swap — the only ingress `receive()`
///      permits, since the lock is held for the whole swap.
contract EtherPushingPool {
    address public immutable token0;
    address public immutable token1;

    constructor(address _t0, address _t1) {
        token0 = _t0;
        token1 = _t1;
    }

    receive() external payable {}

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        amount0 = int256(amountIn);
        amount1 = -int256(amountIn);
        IV3Callback(msg.sender).pancakeV3SwapCallback(amount0, amount1, data);
        (bool ok,) = msg.sender.call{value: 3 ether}("");
        require(ok, "EtherPushingPool: router refused ETH");
        IERC20M(token1).transfer(recipient, amountIn);
    }
}

/// @dev A v4 PoolManager that returns whatever BalanceDelta it is told to, which is what a hook carrying
///      BEFORE_SWAP_RETURNS_DELTA does to a swapper's deltas in v4-core. Only the surface MoleRouter
///      touches is implemented: unlock/swap/sync/settle/take.
contract DeltaDictatingPoolManager {
    int128 internal d0;
    int128 internal d1;

    function setDelta(int128 a0, int128 a1) external {
        d0 = a0;
        d1 = a1;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallback(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey calldata, SwapParams calldata, bytes calldata) external view returns (BalanceDelta) {
        return toBalanceDelta(d0, d1);
    }

    function sync(Currency) external {}

    function settle() external payable returns (uint256) {
        return 0;
    }

    function take(Currency currency, address to, uint256 amount) external {
        if (amount != 0) IERC20M(Currency.unwrap(currency)).transfer(to, amount);
    }
}

/// @dev A minimal WETH9 for the native-ETH legs: deposit wraps, withdraw unwraps and returns ETH.
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "MockWETH: insufficient");
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "MockWETH: send failed");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "MockWETH: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "MockWETH: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
