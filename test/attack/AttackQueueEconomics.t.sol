// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice ECONOMICS ATTACKS ON MoleQueue - the batch auction's pricing and its anti-grief design.
///
/// Everything here runs against a REAL Uniswap v4 PoolManager, a REAL MoleHook oracle and a REAL
/// MoleQueue. Nothing is stubbed and no price is asserted from a comment: every "better"/"worse" claim
/// in this file is a measured pair of numbers, benchmarked against the identical pool state via
/// snapshot/revert so the two arms of a comparison can never contaminate each other.
///
/// ==================================================================================================
/// FINDINGS. Read this before the tests.
///
///   Q-1  RESIDUAL SANDWICH.  The version of MoleQueue this file was first written against ran the
///        aggregated residual swap with `sqrtPriceLimitX96` pinned to MIN/MAX - "fill at literally any
///        price" - and no `minOut` anywhere, while `settle()` was permissionless and the residual size
///        was public from the moment the epoch froze. That is an announced, exactly-sized, unavoidable
///        market order with a zero floor. The tree now carries `maxResidualSlippageBps` and the attack
///        is dead; `test_sandwich_isBlockedByTheResidualBound_andNowLosesMoney` keeps the hostile setup
///        pointed at the live target, pins the exact selector, and measures the attacker into a LOSS.
///
///   Q-2  STALE-ANCHOR CROSSING.  Same story. Crossing at TWAP rather than spot is right and is not
///        under attack here - the header's sequencer argument stands. What was missing was the other
///        half: a refusal to cross once the anchor and the market have visibly diverged. The tree now
///        carries `maxTwapDeviationTicks`, matching the guard MolePositions already had.
///        `test_staleTwapCrossing_isRefusedByTheDeviationGuard_andTheDelayPaysTheHonestSide` pins it
///        and measures what the refusal is worth to the party who queued before the move.
///
///   Q-3  *** STILL OPEN. THE RESIDUAL BOUND IS AN UNENFORCED SIZE CAP, AND `place()` DOES NOT KNOW
///        ABOUT IT. ***  `maxResidualSlippageBps` is checked against the TWAP, so a batch's OWN honest
///        price impact counts against it exactly like a sandwicher's. The bound is immutable, the
///        epoch's size is not bounded anywhere, and nothing in `place()` looks at pool depth. So a
///        one-sided epoch that grows past roughly `maxResidualSlippageBps` of the pool's liquidity
///        becomes un-settleable against an unmoved market, with no attacker present: settle() reverts
///        for everyone and KEEPS reverting, because what breaches the bound is the batch's own price
///        impact and waiting does not change that. Users queue into that state one at a time, every
///        transaction succeeding, with no signal that the batch has been bricked.
///        Stated precisely, there are exactly two exits, and neither is good: somebody moves the pool
///        in the batch's favour at their own expense (possible only inside the deviation band, and
///        nobody has an incentive to do it), or everyone sits out the full `maxEpochLife` and reclaims
///        in kind - locked up, unswapped, for `epochDuration + freezeDuration + maxEpochLife`.
///        `test_residualBoundIsAnUnenforcedSizeCap_butTheBatchStillResolvesAtTheDeadline` proves it end to
///        end. It is a liveness/UX defect, not a custody one - escrow is never at risk - but it is a
///        real cliff that the fix for Q-1 introduced, and it lands hardest on exactly the large batches
///        the netting pitch is about. It belongs at `place()` time (cap the epoch against pool depth,
///        or reject the order that would breach it), or the residual should be SPLIT and executed
///        across blocks rather than refused whole.
///
/// A note on what the Q-2 band does NOT do, stated so it is not mistaken for a stronger claim: a
/// deviation band admits staleness up to the band. Inside it, the reactive side still gets a
/// better-than-market cross. The guard bounds the leak, it does not close it. That number is logged.
/// ==================================================================================================
///
/// TIME: `vm.warp(block.timestamp + d)` does NOT accumulate inside one call frame (solc caches
/// TIMESTAMP), so every advance here goes through the explicit `_clock` / `_height` accumulators. State
/// snapshots roll those accumulators back with everything else, which is what we want - each revert is
/// followed by an explicit re-warp to the restored value.
contract AttackQueueEconomics is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------- world */

    uint24 internal constant LP_FEE = 3000; // 0.30%, the pool's one and only fee
    uint32 internal constant OBS_INTERVAL = 60;
    uint256 internal constant T0 = 1_750_000_000;

    uint32 internal constant EPOCH = 600; // open window
    uint32 internal constant FREEZE = 120; // freeze window before settlement is legal
    uint32 internal constant LIFE = 3600; // deadline after freezing, then anyone may timeout()
    uint32 internal constant TWAP_WINDOW = 1800;

    /// @dev ~5.1%. Wide enough that ordinary noise does not stall settlement, narrow enough that a
    ///      sandwich big enough to matter trips it.
    int24 internal constant TWAP_BAND = 500;

    /// @dev 2%. Must exceed the LP fee plus the batch's OWN price impact or nothing settles - which is
    ///      exactly the cliff Q-3 is about.
    uint16 internal constant RESIDUAL_BPS = 200;

    /// @dev Deep enough that ordinary batch sizes are a small fraction of the book, so "queued beats
    ///      instant" is decided by the fee and the curve rather than by a knife-edge liquidity cliff.
    int256 internal constant LIQUIDITY = 200_000e18;
    int24 internal constant TICK_LOWER = -60_000;
    int24 internal constant TICK_UPPER = 60_000;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal attacker = makeAddr("attacker");
    address internal marketMaker = makeAddr("marketMaker");

    MoleHook internal hook;
    MoleQueue internal queue;
    PoolKey internal qKey; // NOT `key` - Deployers already owns that name.

    uint256 internal _clock;
    uint256 internal _height;

    /* ---------------------------------------------------------------- harness */

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    /// @dev Re-pin the EVM clock to the (also-reverted) accumulators after a state revert, so a
    ///      snapshot arm can never leave the harness and the chain disagreeing about what time it is.
    function _resync() internal {
        vm.warp(_clock);
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-econ", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev restrictedLiquidity = false (this suite provides liquidity through Deployers' own router)
    ///      and hookFeePips = 0 (a hook surcharge would sit on BOTH sides of every comparison and prove
    ///      nothing; the LP fee is the thing crossing actually saves).
    function _deployHook(uint256 seed) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        h = MoleHook(a);
    }

    function _poolKey(int24 spacing) internal view returns (PoolKey memory k) {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(hook))
        });
    }

    function _openPool(PoolKey memory k) internal {
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: LIQUIDITY, salt: 0}),
            ZERO_BYTES
        );
    }

    function _newQueue(PoolKey memory k) internal returns (MoleQueue q) {
        q = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            k,
            EPOCH,
            FREEZE,
            LIFE,
            TWAP_WINDOW,
            TWAP_BAND,
            RESIDUAL_BPS,
            TEST_UPGRADE_ADMIN
        );
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, 2_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(who, 2_000_000e18);
        _approveFor(who, address(queue));
        _approveFor(who, address(swapRouter));
    }

    function _approveFor(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _place(address who, bool zeroForOne, uint128 amountIn) internal returns (uint256 idx) {
        vm.prank(who);
        idx = queue.place(zeroForOne, amountIn);
    }

    function _claim(address who, uint64 e, uint256 idx) internal returns (uint256 out) {
        vm.prank(who);
        out = queue.claim(e, idx);
    }

    /// @dev Open -> past the cutoff -> Frozen -> past the freeze window. Leaves the epoch settleable.
    function _reachSettlementWindow() internal {
        _advance(EPOCH);
        queue.freeze();
        _advance(FREEZE);
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    /// @dev What the SAME size would fetch going straight through the pool, right now. Callers wrap
    ///      this in a snapshot so the benchmark never perturbs the arm it is benchmarking.
    function _instantOut(address who, PoolKey memory k, bool zeroForOne, uint256 amountIn)
        internal
        returns (uint256 out)
    {
        Currency cOut = zeroForOne ? k.currency1 : k.currency0;
        uint256 before = _bal(cOut, who);
        _swapAs(who, k, zeroForOne, amountIn);
        out = _bal(cOut, who) - before;
    }

    function _swapAs(address who, PoolKey memory k, bool zeroForOne, uint256 amountIn) internal {
        vm.prank(who);
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _slot0(PoolKey memory k) internal view returns (uint160 sqrtP, int24 tick) {
        (sqrtP, tick,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    /// @dev The price the queue will cross at, computed the way settle() computes it - from the oracle,
    ///      never from spot.
    function _twapPriceX96() internal view returns (uint256 priceX96, int24 tick) {
        tick = hook.consult(qKey.toId(), TWAP_WINDOW);
        priceX96 = _priceX96At(tick);
    }

    function _priceX96At(int24 tick) internal pure returns (uint256) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
    }

    /// @dev out/in as a 1e18-scaled rate, so different order SIZES are directly comparable.
    function _rate(uint256 amountOut, uint256 amountIn) internal pure returns (uint256) {
        return FullMath.mulDiv(amountOut, 1e18, amountIn);
    }

    function _bps(uint256 delta, uint256 base) internal pure returns (uint256) {
        return (delta * 10_000) / base;
    }

    /// @dev Single-argument logging on purpose: every number this file puts "on record" is formatted
    ///      into one string, so a label and its value can never drift apart.
    function _logU(string memory label, uint256 v) internal pure {
        console2.log(string.concat(label, vm.toString(v)));
    }

    function _logI(string memory label, int256 v) internal pure {
        console2.log(string.concat(label, vm.toString(v)));
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        hook = _deployHook(1);
        qKey = _poolKey(60);
        _openPool(qKey);

        // WARM THE ORACLE. The pool is born at tick 0 with a seeded observation, and letting more than
        // `twapWindow` elapse is what makes `consult(TWAP_WINDOW)` answerable at all. Deliberately
        // quiet: with no swaps the TWAP tick is EXACTLY 0, so priceX96 is EXACTLY 2^96 and the crossing
        // arithmetic is exact to the wei. That matters for the balanced-epoch test, which asserts a
        // to-the-wei fill AND an untouched pool: at any other tick, floor(floor(x*p/Q)*Q/p) leaves a
        // wei of residual and therefore a 1-wei pool swap, which would make "the pool was not touched"
        // untestable for reasons that have nothing to do with the property under test.
        _advance(uint256(TWAP_WINDOW) * 2);

        queue = _newQueue(qKey);

        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(dave);
        _fund(attacker);
        _fund(marketMaker);
    }

    /* ==============================================================================================
       1. QUEUED BEATS INSTANT, MEASURED.

       The condition the owner's "ship both entry paths" decision rests on. Two IDENTICAL sells of the
       same size against the SAME pool state: one crossed inside the batch, one shoved through the pool.
       The crossed one pays no LP fee and no slippage because no pool trade happens for it; the instant
       one pays both. If that margin ever inverts, nobody queues and the netting thesis dies silently,
       so the number is logged and the comparison is strict.

       The benchmark is taken under vm.snapshotState() so the instant swap is quoted against the exact
       pool the batch would have crossed against, not against a pool the batch already moved.
       ============================================================================================== */

    function test_queuedBeatsInstant_crossedFillStrictlyBeatsThePool() public {
        uint128 size = 400e18;

        // A perfectly opposed pair, so alice's whole order crosses and nothing touches the pool.
        _place(alice, true, size); // alice sells currency0
        _place(bob, false, size); // bob sells currency1

        // BENCHMARK: the same 400e18 of currency0, sold instantly, against this same untouched pool.
        uint256 snap = vm.snapshotState();
        uint256 instantOut = _instantOut(carol, qKey, true, size);
        vm.revertToState(snap);
        _resync();

        (uint256 priceX96, int24 twapTick) = _twapPriceX96();
        _reachSettlementWindow();
        queue.settle(0);
        uint256 queuedOut = _claim(alice, 0, 0);

        _logU("QUEUED  fill (wei of currency1): ", queuedOut);
        _logU("INSTANT fill (wei of currency1): ", instantOut);
        _logU("margin in favour of the queue (wei): ", queuedOut - instantOut);
        _logU("margin in favour of the queue (bps): ", _bps(queuedOut - instantOut, instantOut));

        // The crossed fill IS the TWAP, exactly. No fee, no slippage, no rounding surcharge.
        assertEq(queuedOut, FullMath.mulDiv(size, priceX96, FixedPoint96.Q96), "crossed fill is not the TWAP");
        assertEq(twapTick, int24(0), "harness: the quiet pool should read a TWAP of exactly tick 0");

        // The whole thesis, as a strict inequality.
        assertGt(queuedOut, instantOut, "QUEUING NO LONGER BEATS GOING INSTANTLY - the netting thesis is dead");

        // And the margin is at least the LP fee it structurally avoids (0.30% = 30 bps), not dust.
        assertGe(_bps(queuedOut - instantOut, instantOut), 30, "margin has collapsed below the fee it saves");
    }

    /* ==============================================================================================
       2. UNIFORM PRICE.

       Three different-sized orders on the same side of one epoch must all receive the SAME rate. Queue
       position confers nothing (the smallest order is placed FIRST and the largest LAST, with an order
       from the opposite side interleaved between them) and order size confers nothing. That is the
       entire point of a batch: if either mattered, the batch would just be a worse orderbook.

       Deliberately a PARTIAL cross, so the rate under test is the BLENDED one - part TWAP, part
       aggregated pool swap. A uniform price that only holds when everything crosses is not the claim.
       ============================================================================================== */

    function test_uniformPrice_sizeAndQueuePositionBuyNothing() public {
        uint128 small = 7e18;
        uint128 medium = 250e18;
        uint128 large = 1_400e18;

        uint256 iSmall = _place(alice, true, small); // first in the queue, smallest
        _place(dave, false, 500e18); // the opposing side, so only part of side 0 crosses
        uint256 iMedium = _place(bob, true, medium);
        uint256 iLarge = _place(carol, true, large); // last in the queue, 200x the first

        _reachSettlementWindow();
        queue.settle(0);

        (,, uint128 totalIn0,, uint128 out0,,,) = queue.epochs(0);
        assertEq(totalIn0, small + medium + large, "side-0 escrow is not what was placed");

        uint256 outSmall = _claim(alice, 0, iSmall);
        uint256 outMedium = _claim(bob, 0, iMedium);
        uint256 outLarge = _claim(carol, 0, iLarge);

        uint256 rSmall = _rate(outSmall, small);
        uint256 rMedium = _rate(outMedium, medium);
        uint256 rLarge = _rate(outLarge, large);

        _logU("rate for 7e18, placed FIRST: ", rSmall);
        _logU("rate for 250e18, placed THIRD: ", rMedium);
        _logU("rate for 1400e18, placed LAST: ", rLarge);

        // Rounding floor on a 1e18-scaled rate can cost at most 1e18/amountIn; the smallest order here
        // is 7e18, so one wei of payout is worth ~0.14 of a rate unit. A 1000-unit band is ~1e-15
        // relative - tight enough that any real size- or position-dependence blows straight through it.
        assertApproxEqAbs(rSmall, rLarge, 1_000, "the SMALLEST order got a different rate from the largest");
        assertApproxEqAbs(rMedium, rLarge, 1_000, "the MIDDLE order got a different rate from the largest");
        assertApproxEqAbs(rSmall, rMedium, 1_000, "queue position bought a better rate");

        // It really is a blended rate, not the degenerate all-crossed case.
        (uint256 priceX96,) = _twapPriceX96();
        uint256 pureTwap = FullMath.mulDiv(1e18, priceX96, FixedPoint96.Q96);
        assertLt(rLarge, pureTwap, "nothing went through the pool - this is not the blended case");

        // No side is over-paid: the three claims exhaust the side's output up to floor dust.
        uint256 paid = outSmall + outMedium + outLarge;
        assertLe(paid, out0, "claims paid out MORE than settlement produced");
        assertGe(paid, uint256(out0) - 3, "more than one wei per order was stranded");
    }

    /* ==============================================================================================
       3. THE CANCEL GRIEF IS CLOSED (B8), AND THE CUTOFF'S VALUE IS MEASURED.

       The exact attack the freeze window exists to stop: queue big on the scarce side so the batch
       looks balanced, then yank it at the last moment and force everybody else through the pool at a
       worse price. Both arms run against the identical world via snapshot/revert:

         ARM A  attacker cancels AFTER the cutoff  -> MUST revert WrongPhase, and settlement must
                execute the size that was frozen (asserted three ways: the stored escrow, the payout,
                and an UNTOUCHED pool).
         ARM B  attacker cancels BEFORE the cutoff -> the grief lands, and we measure exactly what the
                honest party loses. That number is what the cutoff is worth.
       ============================================================================================== */

    function test_cancelGrief_freezeCutoffIsClosed_andItsValueIsMeasured() public {
        uint128 honest = 600e18; // alice, selling currency0
        uint128 bait = 600e18; // attacker, selling currency1 - makes the batch look perfectly balanced

        _place(alice, true, honest);
        uint256 baitIdx = _place(attacker, false, bait);

        (uint160 sqrtBefore, int24 tickBefore) = _slot0(qKey);
        uint256 liqBefore = StateLibrary.getLiquidity(manager, qKey.toId());

        uint256 snap = vm.snapshotState();

        /* ---------------------------------------------------- ARM A: cancel after the cutoff */

        // Past the open window. `_phase` flips to Frozen on the clock alone - nobody has to remember to
        // press freeze() for the cutoff to bite.
        _advance(EPOCH);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Frozen), "cutoff did not close the epoch");

        vm.prank(attacker);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, baitIdx);

        queue.freeze();
        _advance(FREEZE);
        queue.settle(0);

        // The size that was frozen is the size that settled: the bait is still escrowed, still crossed.
        (,, uint128 t0, uint128 t1, uint128 o0, uint128 o1,,) = queue.epochs(0);
        assertEq(t0, honest, "side-0 escrow moved after the freeze");
        assertEq(t1, bait, "THE BAIT ESCAPED - a cancel took effect after the cutoff");

        (uint256 priceX96,) = _twapPriceX96();
        assertEq(uint256(o0), FullMath.mulDiv(honest, priceX96, FixedPoint96.Q96), "side 0 did not clear at TWAP");
        assertEq(uint256(o1), bait, "side 1 did not clear at TWAP");

        // A fully crossed batch does not touch the pool: same price, same tick, same liquidity.
        (uint160 sqrtAfter, int24 tickAfter) = _slot0(qKey);
        assertEq(sqrtAfter, sqrtBefore, "a pool swap happened despite a fully balanced batch");
        assertEq(tickAfter, tickBefore, "pool tick moved");
        assertEq(StateLibrary.getLiquidity(manager, qKey.toId()), liqBefore, "pool liquidity moved");

        uint256 protectedOut = _claim(alice, 0, 0);

        /* -------------------------------------------- ARM B: the same attack, cancel allowed */

        vm.revertToState(snap);
        _resync();

        // Still Open. This is precisely what the cutoff forbids.
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Open), "world did not rewind to the open epoch");
        vm.prank(attacker);
        queue.cancel(0, baitIdx);

        // The batch is now one-sided and alice's entire order is dumped into the pool.
        _reachSettlementWindow();
        queue.settle(0);
        uint256 griefedOut = _claim(alice, 0, 0);

        _logU("honest fill with the cutoff ENFORCED: ", protectedOut);
        _logU("honest fill with the cancel ALLOWED: ", griefedOut);
        _logU("what the freeze cutoff is worth (wei): ", protectedOut - griefedOut);
        _logU("what the freeze cutoff is worth (bps): ", _bps(protectedOut - griefedOut, protectedOut));

        // The grief is real - this is why B8 exists - and the cutoff is what stops it.
        assertGt(protectedOut, griefedOut, "the cancel grief costs the victim nothing - the cutoff is pointless");
        assertGe(
            _bps(protectedOut - griefedOut, protectedOut),
            30,
            "the grief is smaller than the LP fee - re-check the setup, this should be fee PLUS slippage"
        );
    }

    /* ==============================================================================================
       4. PERFECTLY BALANCED EPOCH - the product, in one test.

       When the two sides match exactly, NO pool swap happens at all. Not "a small one": none. The
       PoolManager's slot0 and liquidity are identical before and after, and its token balances do not
       move. Both sides are paid at exactly the TWAP, to the wei.
       ============================================================================================== */

    function test_perfectlyBalancedEpoch_neverTouchesThePool_andPaysExactlyTheTwap() public {
        (uint256 priceX96, int24 twapTick) = _twapPriceX96();
        assertEq(twapTick, int24(0), "harness precondition: the quiet pool must read tick 0 exactly");

        uint128 side0 = 900e18;
        uint128 side1 = uint128(FullMath.mulDiv(side0, priceX96, FixedPoint96.Q96)); // the exact TWAP amount

        _place(alice, true, side0);
        _place(bob, false, side1);

        (uint160 sqrtBefore, int24 tickBefore) = _slot0(qKey);
        uint256 liqBefore = StateLibrary.getLiquidity(manager, qKey.toId());
        uint256 mgr0Before = _bal(currency0, address(manager));
        uint256 mgr1Before = _bal(currency1, address(manager));

        _reachSettlementWindow();
        queue.settle(0);

        // THE POOL WAS NOT TOUCHED.
        (uint160 sqrtAfter, int24 tickAfter) = _slot0(qKey);
        assertEq(sqrtAfter, sqrtBefore, "sqrtPriceX96 moved - a swap leaked through on a balanced batch");
        assertEq(tickAfter, tickBefore, "tick moved on a balanced batch");
        assertEq(StateLibrary.getLiquidity(manager, qKey.toId()), liqBefore, "liquidity moved on a balanced batch");
        assertEq(_bal(currency0, address(manager)), mgr0Before, "currency0 moved in or out of the PoolManager");
        assertEq(_bal(currency1, address(manager)), mgr1Before, "currency1 moved in or out of the PoolManager");

        // BOTH SIDES PAID AT EXACTLY THE TWAP.
        uint256 aliceOut = _claim(alice, 0, 0);
        uint256 bobOut = _claim(bob, 0, 1);

        assertEq(aliceOut, FullMath.mulDiv(side0, priceX96, FixedPoint96.Q96), "side 0 was not paid the TWAP");
        assertEq(bobOut, FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96), "side 1 was not paid the TWAP");
        assertEq(aliceOut, side1, "the two sides did not simply swap escrows");
        assertEq(bobOut, side0, "the two sides did not simply swap escrows");

        // And the queue kept nothing.
        assertEq(_bal(currency0, address(queue)), 0, "currency0 stranded in the queue");
        assertEq(_bal(currency1, address(queue)), 0, "currency1 stranded in the queue");

        _logU("balanced epoch, side0 escrow in: ", side0);
        _logU("balanced epoch, side0 paid out: ", aliceOut);
        _logU("balanced epoch, side1 escrow in: ", side1);
        _logU("balanced epoch, side1 paid out: ", bobOut);
    }

    /* ==============================================================================================
       5. ONE-SIDED EPOCH - nothing crosses, everything goes through the pool, and it still settles.

       The degenerate batch. `want0` is zero, so `crossed0` and `crossed1` are zero and the residual IS
       the whole epoch. It must settle, pay out pro-rata, and strand nothing - not revert, not divide by
       a zero total, not leave escrow behind.
       ============================================================================================== */

    function test_oneSidedEpoch_settlesThroughThePoolAndStrandsNothing() public {
        uint128 a = 300e18;
        uint128 b = 900e18;

        _place(alice, true, a);
        _place(bob, true, b);

        // BENCHMARK the aggregated swap: the same combined size, instantly, against this same pool.
        uint256 snapBench = vm.snapshotState();
        uint256 aggregateBench = _instantOut(carol, qKey, true, uint256(a) + b);
        vm.revertToState(snapBench);
        _resync();

        _reachSettlementWindow();
        queue.settle(0);

        (,, uint128 t0, uint128 t1, uint128 out0, uint128 out1,,) = queue.epochs(0);
        assertEq(t0, a + b, "escrow wrong");
        assertEq(t1, 0, "there is no side 1 in a one-sided epoch");
        assertEq(out1, 0, "side 1 was paid something out of nowhere");
        assertGt(out0, 0, "a one-sided epoch settled to zero output");

        // Everything went through the pool as ONE swap, so the batch's output is exactly the single
        // aggregated fill - no crossing, and no TWAP anywhere in the answer.
        assertEq(uint256(out0), aggregateBench, "the batch did not execute as one aggregated pool swap");

        uint256 aOut = _claim(alice, 0, 0);
        uint256 bOut = _claim(bob, 0, 1);
        assertGt(aOut, 0, "small side-0 order paid nothing");
        assertGt(bOut, 0, "large side-0 order paid nothing");
        assertApproxEqAbs(_rate(aOut, a), _rate(bOut, b), 1_000, "one-sided epoch is not uniformly priced");

        // Nothing stranded, nothing double-counted.
        assertLe(aOut + bOut, out0, "claims exceeded settlement output");
        assertGe(aOut + bOut, uint256(out0) - 2, "output stranded in the queue");
        assertEq(_bal(currency0, address(queue)), 0, "escrow left behind after a one-sided settlement");

        // Claiming twice is not a fourth way out.
        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.claim(0, 0);

        _logU("one-sided epoch, total escrow in: ", uint256(a) + b);
        _logU("one-sided epoch, total paid out: ", uint256(out0));
    }

    /* ==============================================================================================
       6. THE ORACLE FAILS CLOSED.

       A pool whose observation ring cannot cover `twapWindow` must STOP settlement, not settle at a
       made-up price. Proven in three stages on a pool created FRESH, after the epoch was already
       frozen:

         (a) pool not initialised at all               -> PoolNotInitialized
         (b) initialised, ring younger than the window -> InsufficientObservations
         (c) once the ring genuinely covers the window -> settlement proceeds

       Stage (c) is what makes (a) and (b) evidence rather than coincidence: the only thing that changed
       between the last revert and the successful settle is coverage.
       ============================================================================================== */

    function test_oracleFailsClosed_settleRevertsRatherThanInventingAPrice() public {
        // A different tickSpacing gives a different PoolId, so this really is a virgin oracle ring.
        PoolKey memory fresh = _poolKey(10);

        MoleQueue q2 = _newQueue(fresh);
        _approveFor(alice, address(q2));
        _approveFor(bob, address(q2));

        vm.prank(alice);
        q2.place(true, 100e18);
        vm.prank(bob);
        q2.place(false, 100e18);

        _advance(EPOCH);
        q2.freeze();
        _advance(FREEZE);

        // (a) The pool does not exist yet. Fail closed.
        vm.expectRevert(MoleHook.PoolNotInitialized.selector);
        q2.settle(0);

        // (b) Create it NOW. Its one seeded observation is `TWAP_WINDOW` seconds too young to answer.
        _openPool(fresh);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        q2.settle(0);

        // Still frozen, still nothing paid, nothing half-done.
        (MoleQueue.Phase ph,,,, uint128 o0, uint128 o1,,) = q2.epochs(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a failed settle left the epoch in a settled state");
        assertEq(o0, 0, "a failed settle wrote an output");
        assertEq(o1, 0, "a failed settle wrote an output");
        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        q2.claim(0, 0);

        // (c) Give the ring the coverage it was missing. Nothing else changes.
        _advance(uint256(TWAP_WINDOW) + 1);
        q2.settle(0);

        (MoleQueue.Phase ph2,,,,,,,) = q2.epochs(0);
        assertEq(uint8(ph2), uint8(MoleQueue.Phase.Settled), "settlement did not proceed once the window was covered");

        vm.prank(alice);
        assertGt(q2.claim(0, 0), 0, "settled epoch paid nothing");
    }

    /* ==============================================================================================
       Q-1  THE RESIDUAL SANDWICH -> BLOCKED, AND NOW LOSS-MAKING (regression).

       The attack, unchanged from when it landed: the residual is a publicly sized, unavoidable market
       order and `settle()` is permissionless, so anybody may push the price against it, let it fill,
       and unwind. It used to work because `_swapExactIn` pinned `sqrtPriceLimitX96` to MIN/MAX and
       nothing compared the fill to anything.

       Two front-run sizes, because the defence is LAYERED and the layers must be told apart:
         - a front-run small enough to stay inside `maxTwapDeviationTicks` reaches the residual bound
           and dies there                                    -> ResidualSwapTooFarFromTwap
         - a bigger one never even gets that far              -> TwapTooFarFromSpot
       And the attacker, having moved the price for nothing, unwinds into two lots of LP fee: the
       sandwich is not merely blocked, it is negative-EV. That number is the one worth having.
       ============================================================================================== */

    /// @notice THE SAME SANDWICH, MIRRORED ONTO THE OTHER LEG. The residual bound is written twice, once
    ///         per direction, and the two copies are independent code: a test that only ever drives a
    ///         zeroForOne residual leaves the currency1 half completely unguarded, and deleting it kills
    ///         nothing. Mutation testing found exactly that -- the 1->0 branch survived removal while the
    ///         0->1 branch died, so half the defence was decorative and the suite could not tell.
    ///
    ///         An epoch of currency1 sellers makes the residual a 1->0 swap, so the attacker front-runs in
    ///         the SAME direction (zeroForOne = false, pushing the tick up) to leave less currency0 for the
    ///         batch to take.
    function test_sandwich_isBlockedOnTheOneForZeroLegToo() public {
        uint128 victim = 600e18; // one-sided the other way: the whole batch is a 1->0 residual

        _place(alice, false, victim);
        _reachSettlementWindow();

        uint256 snap = vm.snapshotState();

        // The control: a clean block settles and pays.
        queue.settle(0);
        assertGt(_claim(alice, 0, 0), 0, "control: a clean 1->0 batch must settle and pay");

        vm.revertToState(snap);
        _resync();

        // Front-run sized to stay INSIDE the stale-anchor band, so this exercises the residual bound and
        // not the other guard.
        _swapAs(attacker, qKey, false, 4_000e18);
        (, int24 pushedTick) = _slot0(qKey);
        assertLt(
            pushedTick > 0 ? int256(pushedTick) : -int256(pushedTick),
            int256(TWAP_BAND),
            "harness: this front-run must stay inside the TWAP band or it tests the wrong guard"
        );

        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        queue.settle(0);

        // The batch is untouched: still Frozen, escrow whole, nothing owed.
        (MoleQueue.Phase ph,,, uint128 t1,, uint128 o1,,) = queue.epochs(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a refused settlement still changed the epoch");
        assertEq(t1, victim, "escrow moved during a refused settlement");
        assertEq(o1, 0, "a refused settlement wrote an output");
    }

    function test_sandwich_isBlockedByTheResidualBound_andNowLosesMoney() public {
        uint128 victim = 600e18; // one-sided epoch: the whole batch is residual, the worst case

        _place(alice, true, victim);
        _reachSettlementWindow();

        uint256 snap = vm.snapshotState();

        // ARM A: the control. A clean block settles, and this is the fill the attacker is trying to
        // skim.
        queue.settle(0);
        uint256 cleanOut = _claim(alice, 0, 0);

        vm.revertToState(snap);
        _resync();

        // ARM B: front-run sized to stay INSIDE the stale-anchor band, so the residual bound is the
        // thing being tested rather than the other guard.
        uint256 atk0Before = _bal(currency0, attacker);
        uint256 atk1Before = _bal(currency1, attacker);

        _swapAs(attacker, qKey, true, 4_000e18);
        (, int24 pushedTick) = _slot0(qKey);
        assertLt(
            pushedTick > 0 ? int256(pushedTick) : -int256(pushedTick),
            int256(TWAP_BAND),
            "harness: this front-run must stay inside the TWAP band or it tests the wrong guard"
        );

        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        queue.settle(0);

        // The batch is untouched: still Frozen, still nothing owed, escrow still whole.
        (MoleQueue.Phase ph,, uint128 t0,, uint128 o0,,,) = queue.epochs(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a refused settlement still changed the epoch");
        assertEq(t0, victim, "escrow moved during a refused settlement");
        assertEq(o0, 0, "a refused settlement wrote an output");

        // The attacker unwinds into the price they themselves moved, paying the LP fee twice.
        uint256 got1 = _bal(currency1, attacker) - atk1Before;
        _swapAs(attacker, qKey, false, got1);
        int256 attackerPnl0 = int256(_bal(currency0, attacker)) - int256(atk0Before);

        // ARM B, bigger: the same idea with more size never reaches the residual bound at all.
        uint256 snap2 = vm.snapshotState();
        _swapAs(attacker, qKey, true, 8_000e18);
        (, int24 farTick) = _slot0(qKey);
        assertGt(
            farTick > 0 ? int256(farTick) : -int256(farTick),
            int256(TWAP_BAND),
            "harness: this front-run must leave the TWAP band"
        );
        vm.expectRevert(MoleQueue.TwapTooFarFromSpot.selector);
        queue.settle(0);
        vm.revertToState(snap2);
        _resync();

        // Once the price the attacker moved has come back, the batch settles normally and the victim is
        // made whole to within the attacker's own fee drag. The sandwich cost the attacker and bought
        // them nothing.
        queue.settle(0);
        uint256 afterAttackOut = _claim(alice, 0, 0);

        _logU("victim fill, clean block: ", cleanOut);
        _logU("victim fill after the failed sandwich: ", afterAttackOut);
        _logI("attacker currency0 PnL (wei): ", attackerPnl0);
        _logI("pushed tick, small front-run: ", int256(pushedTick));
        _logI("pushed tick, big front-run: ", int256(farTick));

        // THE GUARDS, pinned by selector above, and their consequences here.
        assertLt(attackerPnl0, int256(0), "the sandwich was still profitable - the residual bound is not biting");
        assertGt(afterAttackOut, (cleanOut * 99) / 100, "the failed sandwich still skimmed over 1% off the victim");
    }

    /* ==============================================================================================
       Q-2  STALE-ANCHOR CROSSING -> REFUSED, AND THE REFUSAL IS WORTH MEASURING (regression).

       The setup is the one that makes the batch indefensible on its own: the honest party queues while
       the market is calm, the market then moves for reasons that have nothing to do with anybody here,
       and B8's cutoff means the honest party CANNOT leave. Someone who merely reacts after the move
       takes the other side at the stale price.

       The guard turns theft into a delay. This test proves the refusal by selector, then lets the TWAP
       catch up and measures what the honest party was paid versus what the stale cross would have paid
       them. Finally it logs the leak that REMAINS inside the band, because a deviation band bounds
       staleness, it does not abolish it, and pretending otherwise would be the same kind of
       overclaiming this codebase keeps finding.
       ============================================================================================== */

    function test_staleTwapCrossing_isRefusedByTheDeviationGuard_andTheDelayPaysTheHonestSide() public {
        uint128 honest = 2_000e18; // bob queues currency1 -> currency0 while the market is calm

        _place(bob, false, honest);

        // 400s later the market moves. Exogenous: a third party trades, the attacker pays nothing for
        // the opportunity and takes no risk to create it.
        _advance(400);
        _swapAs(marketMaker, qKey, true, 15_000e18);

        // Still inside the open window. The attacker reacts, taking the side the stale price favours.
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Open), "harness: attacker must still be able to place");
        _place(attacker, true, honest);

        _advance(200); // past the cutoff. Bob cannot get out; B8 says so.
        queue.freeze();
        _advance(FREEZE);

        (uint256 stalePriceX96, int24 staleTwap) = _twapPriceX96();
        (, int24 spotTick) = _slot0(qKey);
        int256 drift = int256(staleTwap) - int256(spotTick);
        if (drift < 0) drift = -drift;
        assertGt(drift, int256(TWAP_BAND), "harness: TWAP and spot did not diverge past the band");

        // THE GUARD. The batch would have crossed at a price everyone can see is wrong, and it refuses.
        vm.expectRevert(MoleQueue.TwapTooFarFromSpot.selector);
        queue.settle(0);

        // What the stale cross WOULD have paid bob: his 2000e18 of currency1 at the stale TWAP, plus
        // whatever the small residual fetched. Crossing alone is a strict lower bound on it, which is
        // all this comparison needs.
        uint256 staleCrossFloor = FullMath.mulDiv(honest, FixedPoint96.Q96, stalePriceX96);

        // Let the anchor catch up to the market. Nothing else changes: no swaps, no new orders.
        _advance(1_000);
        (uint256 freshPriceX96, int24 freshTwap) = _twapPriceX96();
        queue.settle(0);

        uint256 bobOut = _claim(bob, 0, 0);
        uint256 atkOut = _claim(attacker, 0, 1);

        // What the attacker's cross is still worth relative to just using the pool, at the same instant.
        uint256 snapBench = vm.snapshotState();
        uint256 atkPoolAlt = _instantOut(carol, qKey, true, honest);
        vm.revertToState(snapBench);
        _resync();

        _logI("stale TWAP tick at the refused settlement: ", int256(staleTwap));
        _logI("spot tick at the refused settlement: ", int256(spotTick));
        _logI("TWAP tick once it caught up: ", int256(freshTwap));
        _logU("honest side, fill the guard delivered: ", bobOut);
        _logU("honest side, floor of the stale cross it refused: ", staleCrossFloor);
        _logU("what the refusal was worth to the honest side (wei): ", bobOut - staleCrossFloor);
        _logU("attacker fill: ", atkOut);
        _logU("attacker, what the pool would have paid: ", atkPoolAlt);
        _logU("leak still inside the band (bps of the attacker fill): ", _bps(atkOut - atkPoolAlt, atkOut));

        // THE POINT: refusing to cross on a stale anchor is worth real money to the party who could not
        // walk away, and the guard converted the theft into a delay rather than a loss.
        assertGt(freshPriceX96, 0, "sanity");
        assertGt(bobOut, staleCrossFloor, "the delay bought the honest side nothing - re-check the guard");

        // HONEST ABOUT WHAT IS LEFT: inside the band the reactive side is still ahead of the pool. The
        // band bounds the leak; it does not close it. Asserted so that a future narrowing of the band
        // shows up here as a changed number rather than as silence.
        assertGt(atkOut, atkPoolAlt, "no leak at all inside the band - the band may have been narrowed");
        assertLt(_bps(atkOut - atkPoolAlt, atkOut), 1_000, "the leak inside the band exceeds 10% - band too wide");
    }

    /* ==============================================================================================
       Q-3  *** OPEN DEFECT ***  THE RESIDUAL BOUND IS AN UNENFORCED SIZE CAP.

       `maxResidualSlippageBps` is measured against the TWAP, and a batch's OWN honest price impact is
       indistinguishable from a sandwicher's. So the bound is simultaneously an anti-MEV guard and a
       hard cap on how big a one-sided epoch may get relative to the pool - except that nothing
       ENFORCES the cap where it could be enforced. `place()` does not look at pool depth, at the
       epoch's running total, or at the bound. Users walk into the un-settleable region one successful
       transaction at a time.

       Once there, no attacker is needed and no amount of waiting helps: the pool has not moved, the
       TWAP has not moved, and what breaches the bound is the batch's own impact, which is a constant.
       settle() reverts for everybody and keeps reverting. Being exact about the exits, because
       "permanently stuck" would be an overclaim: someone could push the pool in the batch's favour
       inside the deviation band and make it settle, but they would be paying for the privilege and
       nobody has a reason to. The exit that actually exists is the B4 escape hatch - sit out the whole
       `maxEpochLife` and reclaim in kind, unswapped, having achieved nothing but a lockup.

       This test walks the cliff: the same epoch settles at one size and cannot settle at another,
       `place()` cheerfully carries it across the edge, and the ending is a full-length lockup.
       ============================================================================================== */

    /// @notice THE SAME THING WITH THE SIDES SWAPPED. The refund is booked and paid per side, in two
    ///         independent pieces of code, and mutation testing found that only the currency0 leg was ever
    ///         exercised: deleting the currency1 payout from `claim` turned nothing red, so half the fix
    ///         was untested and a side-1 seller's in-kind refund could have been silently kept.
    function test_Q3_theInKindRefundIsPaidOnTheSideOneLegToo() public {
        uint128 big1 = 8_000e18; // ~4% of the pool, the other way round: the unswappable residual
        uint128 small0 = 1_000e18; // absorbable by netting alone

        uint256 alice1Before = _bal(currency1, alice);

        _place(alice, false, big1);
        _place(carol, true, small0);
        _reachSettlementWindow();

        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        queue.settle(0);

        _advance(LIFE);
        queue.settle(0);

        (,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = queue.epochs(0);
        assertEq(refund0, 0, "the fully-matched side must have nothing to refund");
        assertEq(refund1, big1 - out0, "the unmatched currency1 remainder was not booked back in kind");
        assertGt(refund1, 0, "premise: this batch must actually have an unswappable side-1 residual");

        // Carol is fully filled at the TWAP out of netting alone.
        assertEq(_claim(carol, 0, 1), out0, "carol was not paid the whole side-0 output");
        assertEq(queue.refundOf(0, 1), 0, "a fully-matched order must have no in-kind leg");

        // Alice is paid in BOTH tokens by one claim: currency0 for the part that crossed, currency1 back
        // for the part that could not be swapped.
        assertEq(queue.refundOf(0, 0), refund1, "alice's in-kind entitlement is wrong");
        uint256 alice1Mid = _bal(currency1, alice);
        assertEq(_claim(alice, 0, 0), out1, "alice was not paid the whole side-1 output");
        assertEq(_bal(currency1, alice) - alice1Mid, refund1, "alice's currency1 in-kind leg was not paid");
        assertEq(alice1Before - _bal(currency1, alice), big1 - refund1, "alice paid for more than actually crossed");

        assertLe(_bal(currency1, address(queue)), 2, "currency1 left behind after both sides claimed");
    }

    /// @notice THE FALLBACK IS NOT A BLANKET CATCH, and this test is why the selector filter exists. The
    ///         lenient path converts a failed residual swap into an in-kind refund, which is the right
    ///         answer for "the pool cannot do this trade at an acceptable price" and the WRONG answer for
    ///         anything else. Catching everything would turn a broken token, a future bug or any new error
    ///         into a quiet no-swap settlement -- the kind of failure that gets discovered by its victims
    ///         rather than by its author. Only the two price selectors are eligible; everything else is
    ///         re-thrown verbatim, deadline or no deadline.
    function test_Q3_aNonPriceFailureIsRethrownRatherThanRefunded() public {
        _place(alice, true, 8_000e18);
        _reachSettlementWindow();
        _advance(LIFE); // lenient: a PRICE failure here would settle as an in-kind refund

        // Make the settle-side token transfer fail. This is not a price problem, so it must not be
        // laundered into a refund.
        vm.mockCall(Currency.unwrap(currency0), abi.encodeWithSignature("transfer(address,uint256)"), abi.encode(false));
        vm.expectRevert(MoleQueue.TransferFailed.selector);
        queue.settle(0);
        vm.clearMockedCalls();

        // Nothing was written: no phase change, no refund booked, no output recorded.
        (MoleQueue.Phase ph,,,, uint128 out0,, uint128 refund0,) = queue.epochs(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a re-thrown failure still resolved the epoch");
        assertEq(out0, 0, "a re-thrown failure wrote an output");
        assertEq(refund0, 0, "a re-thrown failure booked a refund");

        // And with the fault cleared the same epoch resolves normally, so the revert was the fault and
        // not the deadline.
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "the epoch could not resolve once fixed");
    }

    /// @notice Q-3, THE FIX. THE CROSSING IS NO LONGER HOSTAGE TO THE RESIDUAL.
    ///
    ///         The defect was structural, not a missing bound. The residual bound is unavoidably also a
    ///         size cap -- a batch's own honest price impact is indistinguishable from a sandwicher's --
    ///         and nothing can enforce that cap at `place()` time, because the residual depends on orders
    ///         that have not arrived yet and a v4 swap cannot be simulated in a view. So the whole batch
    ///         failed: it waited out `maxEpochLife` and refunded EVERYTHING unswapped, INCLUDING the
    ///         matched portion, which needs no pool at all and was already priced at the TWAP. The more a
    ///         batch was worth netting, the likelier it could not settle. Backwards.
    ///
    ///         Now the matched part clears and only the unmatched remainder comes back. This test is the
    ///         case that distinguishes the two designs: a batch with BOTH. Under the old code carol -- who
    ///         is small, opposite, and entirely absorbable by netting -- got nothing but her deposit back
    ///         after a full lockup, because of how big the OTHER side happened to be.
    function test_Q3_theCrossedPortionSettlesEvenWhenTheResidualCannot() public {
        uint128 big0 = 8_000e18; // ~4% of the pool one way: far past what the residual bound allows
        uint128 small1 = 1_000e18; // the other way: fully absorbable by netting, needs no pool at all

        uint256 alice1Before = _bal(currency1, alice);
        uint256 carol0Before = _bal(currency0, carol);
        uint256 carol1Before = _bal(currency1, carol);

        _place(alice, true, big0);
        _place(carol, false, small1);
        _reachSettlementWindow();

        // Strict while there is still time: the residual really is unswappable within the bound.
        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        queue.settle(0);

        _advance(LIFE);
        queue.settle(0);

        (uint256 priceX96,) = _twapPriceX96();
        uint128 expectedCross = uint128(FullMath.mulDiv(small1, FixedPoint96.Q96, priceX96));

        (MoleQueue.Phase ph,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = queue.epochs(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "the batch did not resolve at the deadline");

        // THE POINT: the matched part cleared at the TWAP, and only the remainder came back.
        assertEq(out1, expectedCross, "the crossed portion was not delivered to the side-1 seller");
        assertGt(out0, 0, "the side-0 sellers were paid nothing for the part that did cross");
        assertEq(refund0, big0 - expectedCross, "the unmatched remainder was not booked back in kind");
        assertEq(refund1, 0, "the fully-matched side must have nothing to refund");

        // CAROL IS FULLY FILLED, at the TWAP, and touches no pool. Under the old design she waited out the
        // whole lockup and got her deposit back, for no reason connected to her own order.
        assertEq(_claim(carol, 0, 1), out1, "carol was not paid the whole side-1 output");
        assertEq(queue.refundOf(0, 1), 0, "a fully-matched order must have no in-kind leg");
        assertEq(_bal(currency1, carol), carol1Before - small1, "carol paid more or less than she queued");
        assertGt(_bal(currency0, carol), carol0Before, "carol received no currency0 at all");

        // ALICE IS PARTIALLY FILLED: paid at the TWAP for what crossed, refunded the rest in kind, both in
        // ONE claim on ONE flag -- never two withdrawals that could disagree about what is owed.
        uint256 aliceRefund = queue.refundOf(0, 0);
        assertEq(aliceRefund, refund0, "sole seller on her side must be entitled to the whole refund");
        uint256 alice0Mid = _bal(currency0, alice);
        assertEq(_claim(alice, 0, 0), out0, "alice was not paid the whole side-0 output");
        assertEq(_bal(currency0, alice) - alice0Mid, aliceRefund, "alice's in-kind leg was not paid");
        assertEq(_bal(currency1, alice) - alice1Before, out0, "alice's swapped leg was not paid");

        // Nothing kept, on either token.
        assertLe(_bal(currency0, address(queue)), 2, "currency0 left behind after both sides claimed");
        assertLe(_bal(currency1, address(queue)), 2, "currency1 left behind after both sides claimed");

        _logU("crossed at TWAP, needing no pool (wei): ", expectedCross);
        _logU("returned in kind, unswappable (wei): ", refund0);
    }

    function test_residualBoundIsAnUnenforcedSizeCap_butTheBatchStillResolvesAtTheDeadline() public {
        uint128 settleable = 1_200e18; // ~0.6% of pool liquidity: impact + fee well under the bound
        uint128 tipsItOver = 6_800e18; // takes the epoch to 8_000e18, ~4% of the pool

        uint256 alice0Before = _bal(currency0, alice);
        uint256 bob0Before = _bal(currency0, bob);

        _place(alice, true, settleable);

        // CONTROL: at this size the identical epoch settles without complaint.
        uint256 snap = vm.snapshotState();
        _reachSettlementWindow();
        queue.settle(0);
        (MoleQueue.Phase okPhase,,,, uint128 okOut0,,,) = queue.epochs(0);
        assertEq(uint8(okPhase), uint8(MoleQueue.Phase.Settled), "control: the small batch should settle");
        assertGt(okOut0, 0, "control: the small batch paid nothing");
        vm.revertToState(snap);
        _resync();

        // AND NOW THE CLIFF. `place()` accepts the order that makes the epoch un-settleable, with no
        // revert, no event, and no way for bob to know he has just bricked the batch for both of them.
        _place(bob, true, tipsItOver);
        (,, uint128 doomed0,,,,,) = queue.epochs(0);
        assertEq(doomed0, settleable + tipsItOver, "harness: both orders should be in the same epoch");

        _reachSettlementWindow();

        // No attacker. No price manipulation. The batch's own impact breaches its own bound.
        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        queue.settle(0);

        // And it is not transient: nothing about the pool or the oracle changes with time here, so
        // waiting is not a strategy. Try again much later, same refusal.
        _advance(LIFE / 2);
        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        queue.settle(0);

        (uint256 priceX96,) = _twapPriceX96();
        (, int24 spotNow) = _slot0(qKey);
        assertEq(spotNow, int24(0), "the pool never moved - this is entirely self-inflicted");

        // THE OTHER EXIT, verified rather than assumed, so the finding is stated exactly. A third party
        // who pushes the pool in the batch's FAVOUR - staying inside the deviation band, or the other
        // guard fires instead - does unstick it. They are simply buying the batch's counterparty risk
        // at their own cost, which is why nobody does this, but "permanently stuck" would be wrong and
        // this arm is what makes the difference measurable.
        uint256 rescueSnap = vm.snapshotState();
        _swapAs(marketMaker, qKey, false, 4_900e18);
        (, int24 rescuedTick) = _slot0(qKey);
        assertLt(int256(rescuedTick), int256(TWAP_BAND), "harness: the rescue push must stay inside the band");
        queue.settle(0);
        (MoleQueue.Phase rescuedPhase,,,,,,,) = queue.epochs(0);
        assertEq(uint8(rescuedPhase), uint8(MoleQueue.Phase.Settled), "a favourable in-band push did not unstick it");
        _logI("tick a benefactor had to buy to unstick the batch: ", int256(rescuedTick));
        vm.revertToState(rescueSnap);
        _resync();

        // THE EXIT: past the deadline the batch resolves itself rather than waiting on anyone. Nothing
        // crossed in this epoch -- both orders are the same way round -- so the whole escrow is booked
        // back in kind, which is the same money the old timeout path returned, minus the wait for someone
        // to press it. `timeout()` remains available for the epoch that is never settled at all.
        _advance(LIFE);
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "the deadline did not resolve the batch");

        assertEq(queue.refundOf(0, 0), settleable, "alice's in-kind entitlement is wrong");
        assertEq(queue.refundOf(0, 1), tipsItOver, "bob's in-kind entitlement is wrong");
        assertEq(_claim(alice, 0, 0), 0, "nothing was swapped, so the output leg must be zero");
        assertEq(_claim(bob, 0, 1), 0, "nothing was swapped, so the output leg must be zero");
        assertEq(_bal(currency0, alice), alice0Before, "alice did not get exactly her currency0 back");
        assertEq(_bal(currency0, bob), bob0Before, "bob did not get exactly his currency0 back");
        assertEq(_bal(currency0, address(queue)), 0, "escrow left behind after the refund");

        _logU("size that settles (wei): ", settleable);
        _logU("size that can NEVER settle (wei): ", uint256(settleable) + tipsItOver);
        _logU("pool liquidity for scale (wei): ", uint256(LIQUIDITY));
        _logU("residual bound (bps): ", RESIDUAL_BPS);
        _logU("TWAP price used for the bound (X96): ", priceX96);
        _logU("seconds of lockup before anyone could exit: ", uint256(EPOCH) + FREEZE + LIFE);
    }
}
