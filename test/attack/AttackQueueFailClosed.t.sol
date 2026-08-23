// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @dev Places an order and settles an epoch inside ONE transaction. The only way to drive the
///      "same-tx place+settle" question against the real contract.
contract Composer {
    function placeThenSettle(MoleQueue q, bool zeroForOne, uint128 amountIn, uint64 e) external returns (uint256 idx) {
        idx = q.place(zeroForOne, amountIn);
        q.settle(e);
    }
}

/// @notice FAIL-CLOSED COMPLETENESS OF THE BATCH QUEUE — the dossier's clearing-price guard block
///         (P-49), the deferral policy (P-56, FLOW-3 D1-D5, C-7), the internal-cross fee (C-3) and the
///         post-freeze immunity invariant (P-53, FLOW-3 inv (f)), each driven against the LIVE shape of
///         MoleQueue (UUPS proxy, real PoolManager, real MoleHook oracle).
///
/// HOW TO READ THE NAMES. Three prefixes, and they mean different things:
///
///   test_<guard>_...     the guard EXISTS. Each one was mutation-verified: the guard line was deleted,
///                        the test went red, the line was restored. The mutation is named in the test's
///                        doc comment and recorded in QUEUE-FAILCLOSED-FINDINGS.md.
///   test_MISSING_...     the guard DOES NOT EXIST. The test is written as the attack the guard would
///                        stop and asserts the refusal the dossier specifies; it is RED on purpose and
///                        stays red until the guard ships. Each one also proves the ESCAPE still works
///                        if a future guard starts refusing, so shipping the guard turns it green
///                        without a rewrite. Exclude with `--no-match-test MISSING_` for a green gate.
///   test_PIN_...         neither: a behaviour the memo relies on (C-3 charge, C-7 terminal action),
///                        pinned so that a change shows up as a red test rather than a stale memo.
///
/// TIME. `vm.warp(block.timestamp + d)` does NOT accumulate inside one call frame, so every advance
/// here moves the explicit `_clock` / `_height` accumulators (and re-pins them after a state revert).
contract AttackQueueFailClosed is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------ config */

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;

    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 500; // 5%

    /// @dev A realistic chain timestamp; `consult` fails closed on `secondsAgo > block.timestamp`.
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant FUNDING = 100_000e18;

    /// @dev Where the free TWAP walk parks the pool. ~13.5% of the true price; far enough that the
    ///      theft is unmistakable, near enough that the clearing arithmetic stays well inside uint128.
    int24 internal constant WALK_TICK = -20_000;

    /// @dev The ONE-BLOCK position: the band's own depth (the size any spot liquidity floor would be
    ///      calibrated to) straddling the parked tick, added and removed inside the same block. Anyone may
    ///      place it while `restrictedLiquidity` is off — how the hook is deployed in this harness, and (per
    ///      the memo's chain read) how it is deployed live.
    int24 internal constant JIT_LOWER = -20_020;
    int24 internal constant JIT_UPPER = -19_980;
    uint128 internal constant JIT_DEPTH = 100_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal attacker = makeAddr("attacker");
    address internal stranger = makeAddr("stranger");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;
    Composer internal composer;

    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;

    /* ------------------------------------------------------------------ harness */

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    /// @dev Re-pin the EVM clock to the (also-reverted) accumulators after a state revert.
    function _resync() internal {
        vm.warp(_clock);
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-failclosed", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deployHook(uint256 seed) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        h = MoleHook(a);
    }

    function _keyFor(int24 spacing) internal view returns (PoolKey memory k) {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(hook))
        });
    }

    function _newPool(int24 spacing) internal returns (PoolKey memory k) {
        k = _keyFor(spacing);
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function _addLiquidity(PoolKey memory k, int24 lower, int24 upper, int256 liq) internal {
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liq, salt: 0}), ZERO_BYTES
        );
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        _swapLimited(k, zeroForOne, amount, zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT);
    }

    /// @dev An exact-input swap that STOPS at `limit`. This is the walker's tool: offer more than the
    ///      in-range liquidity can absorb and name the tick you want the pool parked at.
    function _swapLimited(PoolKey memory k, bool zeroForOne, uint256 amount, uint160 limit) internal {
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Real swaps spaced beyond `OBS_INTERVAL` so the ring advances, then a quiet tail longer than
    ///      the window so the TWAP equals the current tick and the deviation band reads zero drift.
    function _warmOracle(PoolKey memory k, uint256 size) internal {
        _advance(90);
        _swap(k, true, size);
        _advance(90);
        _swap(k, false, size);
        _advance(90);
        _swap(k, true, size);
        _advance(TWAP_WINDOW + 120);
    }

    function _newQueue(PoolKey memory k, uint16 bps) internal returns (MoleQueue) {
        return deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            k,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            bps,
            TEST_UPGRADE_ADMIN
        );
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        t0.approve(spender, type(uint256).max);
        t1.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _fund(address who) internal {
        t0.transfer(who, FUNDING);
        t1.transfer(who, FUNDING);
        _approve(who, address(queue));
    }

    function _placeOn(MoleQueue q, address who, bool zeroForOne, uint128 amount) internal returns (uint256 idx) {
        vm.prank(who);
        idx = q.place(zeroForOne, amount);
    }

    function _place(address who, bool zeroForOne, uint128 amount) internal returns (uint256 idx) {
        return _placeOn(queue, who, zeroForOne, amount);
    }

    function _claimOn(MoleQueue q, address who, uint64 e, uint256 idx) internal returns (uint256 out) {
        vm.prank(who);
        out = q.claim(e, idx);
    }

    function _epochOf(MoleQueue q, uint64 e)
        internal
        view
        returns (
            MoleQueue.Phase phase,
            uint64 frozenAt,
            uint128 in0,
            uint128 in1,
            uint128 out0,
            uint128 out1,
            uint128 refund0,
            uint128 refund1
        )
    {
        (phase, frozenAt, in0, in1, out0, out1, refund0, refund1) = q.epochs(e);
    }

    function _spotTick(PoolKey memory k) internal view returns (int24 tick) {
        (, tick,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    function _priceX96At(int24 tick) internal pure returns (uint256) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        return FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
    }

    /// @dev A second pool on the same hook with deliberately anaemic, tightly-concentrated liquidity,
    ///      plus its own queue. Outside [lower, upper] the pool has ZERO liquidity — the shape the live
    ///      pool has under `restrictedLiquidity`, and the shape every walk attack needs.
    function _thinWorld(int24 spacing, int24 lower, int24 upper, uint128 liq, uint16 bps)
        internal
        returns (PoolKey memory k, MoleQueue q)
    {
        k = _newPool(spacing);
        _addLiquidity(k, lower, upper, int256(uint256(liq)));
        _warmOracle(k, 1e12);
        q = _newQueue(k, bps);
        _approve(alice, address(q));
        _approve(bob, address(q));
        _approve(carol, address(q));
        _approve(attacker, address(q));
        _approve(stranger, address(q));
    }

    /// @dev THE FREE TWAP WALK (F-4, replayed against the queue). One exact-input swap that exhausts the
    ///      in-range band and names `WALK_TICK` as its limit: once liquidity is zero the price moves to
    ///      the limit for nothing and the hook records the parked tick. Returns where spot was parked.
    function _walk(PoolKey memory k) internal returns (int24 parked) {
        _swapLimited(k, true, 10_000e18, TickMath.getSqrtPriceAtTick(WALK_TICK));
        parked = _spotTick(k);
        assertEq(parked, WALK_TICK, "premise: the walk did not park spot at the target tick");
    }

    /// @dev Once a whole window has elapsed with no further trade, the TWAP equals the parked spot and
    ///      the deviation band reads zero drift at a price nobody trades at. Asserted, not assumed.
    function _assertAnchorFollowedTheWalk(PoolKey memory k, int24 parked) internal view returns (int24 clearing) {
        clearing = hook.consult(k.toId(), TWAP_WINDOW);
        assertApproxEqAbs(int256(clearing), int256(parked), 2, "premise: the anchor did not follow the walk");
        int24 spot = _spotTick(k);
        int24 drift = spot > clearing ? spot - clearing : clearing - spot;
        assertLe(drift, MAX_TWAP_DEVIATION_TICKS, "premise: the walked TWAP must sit inside the band");
    }

    /// @dev What the pool would actually have paid for `amount` of token0 at the true (pre-walk) price:
    ///      the nominal value at tick 0. Used only to size the theft in failure messages.
    function _nominal(uint256 amount) internal pure returns (uint256) {
        return FullMath.mulDiv(amount, _priceX96At(0), FixedPoint96.Q96);
    }

    /// @dev The one-block position, in and out. The test contract is both the walker and the LP.
    function _jitAdd(PoolKey memory k) internal {
        _addLiquidity(k, JIT_LOWER, JIT_UPPER, int256(uint256(JIT_DEPTH)));
    }

    function _jitRemove(PoolKey memory k) internal {
        _addLiquidity(k, JIT_LOWER, JIT_UPPER, -int256(uint256(JIT_DEPTH)));
    }

    /// @dev `after_ - before_` as a signed decimal string, for failure messages.
    function _delta(uint256 after_, uint256 before_) internal pure returns (string memory) {
        return after_ >= before_
            ? string.concat("+", vm.toString(after_ - before_))
            : string.concat("-", vm.toString(before_ - after_));
    }

    function _freezeAndSettle(MoleQueue q, uint64 e) internal {
        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);
        q.settle(e);
        (MoleQueue.Phase p,,,,,,,) = _epochOf(q, e);
        assertEq(uint8(p), uint8(MoleQueue.Phase.Settled), "epoch did not reach Settled");
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        hook = _deployHook(1);
        poolKey = _newPool(60);
        // Deep and wide, so a residual here fills cleanly and only the guard under test can refuse.
        _addLiquidity(poolKey, -60_000, 60_000, 200_000e18);
        _warmOracle(poolKey, 1e18);

        queue = _newQueue(poolKey, RESIDUAL_SLIPPAGE_BPS);

        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(attacker);
        _fund(stranger);

        composer = new Composer();
        t0.transfer(address(composer), FUNDING);
        t1.transfer(address(composer), FUNDING);
        _approve(address(composer), address(queue));
    }

    /* ================================================================================
       1.  WINDOW COVERAGE PROOF  (P-49 line 1)  — PRESENT, in the oracle.
       ============================================================================= */

    /// @notice An anchor whose window the ring cannot cover is refused by selector, one second short of
    ///         coverage it is still refused, and on the second it is accepted with nothing else changed.
    ///         MUTATION: delete `if (!found) revert InsufficientObservations();` in MoleHook.consult ->
    ///         settle succeeds at the uncovered anchor -> RED.
    function test_coverage_anUncoveredWindowIsRefusedUntilTheRingCoversIt() public {
        PoolKey memory fresh = _keyFor(10);
        MoleQueue q = _newQueue(fresh, RESIDUAL_SLIPPAGE_BPS);
        _approve(alice, address(q));
        _approve(carol, address(q));
        // Balanced to the wei at tick 0, so no residual is ever needed and the only thing in the way of
        // settlement is the oracle's coverage proof.
        uint256 iA = _placeOn(q, alice, true, 100e18);
        _placeOn(q, carol, false, 100e18);

        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        // The pool is born NOW: one seed observation, `TWAP_WINDOW` too young to answer.
        manager.initialize(fresh, SQRT_PRICE_1_1);
        vm.prank(stranger);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        q.settle(0);

        (MoleQueue.Phase ph,,,, uint128 o0, uint128 o1,,) = _epochOf(q, 0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a refused settle changed the phase");
        assertEq(o0, 0, "a refused settle wrote an output");
        assertEq(o1, 0, "a refused settle wrote an output");

        // One second short of coverage: still refused.
        _advance(TWAP_WINDOW - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        q.settle(0);

        // Exactly covered: accepted, and the fill is the exact TWAP cross.
        _advance(1);
        vm.prank(stranger);
        q.settle(0);
        assertEq(uint8(q.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "covered window did not settle");
        assertEq(_claimOn(q, alice, 0, iA), 100e18, "balanced cross at tick 0 is not exact");
    }

    /* ================================================================================
       2.  STALENESS + OBSERVATION COUNT  (P-49 line 1, "observation count"; top-10 #4)  — MISSING.
       ============================================================================= */

    /// @notice A pool seeded once and never traded again — ONE observation, thirty days old, no write
    ///         inside the window — is accepted as the anchor. `consult` extends the seed tick to now and
    ///         the deviation band reads spot == TWAP because nothing ever moved spot. Nothing in the
    ///         queue asks how old the anchor is or how many observations back it. RED until an anchor
    ///         age / minimum-observation bound exists; when it does, the escape below must still work.
    function test_MISSING_staleness_anIdleSeedOnlyPoolThirtyDaysOldIsAcceptedAsTheAnchor() public {
        PoolKey memory idle = _newPool(10);
        uint32 seededAt = uint32(_clock);
        _advance(30 days);

        MoleQueue q = _newQueue(idle, RESIDUAL_SLIPPAGE_BPS);
        _approve(alice, address(q));
        _approve(carol, address(q));
        uint256 iA = _placeOn(q, alice, true, 100e18);
        uint256 iC = _placeOn(q, carol, false, 100e18);
        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        // Premise, read from the oracle itself: index 0 (the seed is the only entry) and the last ring
        // write is the seed, a month ago.
        (uint16 index,, uint32 lastObsTs,,, bool init) = hook.poolStates(idle.toId());
        assertTrue(init, "premise: pool initialised");
        assertEq(index, 0, "premise: more than one observation");
        assertEq(lastObsTs, seededAt, "premise: the ring was written after the seed");
        assertGe(_clock - lastObsTs, 30 days, "premise: the anchor is not a month old");

        (bool ok,) = address(q).call(abi.encodeCall(MoleQueue.settle, (0)));
        string memory msg_ = "no attempt";
        if (ok) {
            msg_ = string.concat(
                "MISSING staleness/observation-count guard: a batch cleared on a single ",
                vm.toString(_clock - lastObsTs),
                "s-old seed observation; alice was paid ",
                vm.toString(_claimOn(q, alice, 0, iA)),
                " of currency1"
            );
        } else {
            // The guard exists. The refusal must not be a trap.
            _advance(MAX_EPOCH_LIFE);
            vm.prank(stranger);
            q.timeout(0);
            assertEq(_claimOn(q, alice, 0, iA), 100e18, "escape after a stale-anchor refusal is not in kind");
            assertEq(_claimOn(q, carol, 0, iC), 100e18, "escape after a stale-anchor refusal is not in kind");
        }
        assertFalse(ok, msg_);
    }

    /* ================================================================================
       3.  TWAP-vs-SPOT DEVIATION BAND  (P-49 "spot deviation band", Q-2)  — PRESENT, both signs.
       ============================================================================= */

    /// @notice Spot BELOW the anchor, inside the strict window: refused by selector, nothing written, and
    ///         once the anchor catches up the same epoch settles. The move lands AFTER the cutoff, so the
    ///         honest side could not have cancelled out of it.
    ///         MUTATION: delete `if (drift > maxTwapDeviationTicks) revert TwapTooFarFromSpot();` ->
    ///         the stale cross goes through -> RED.
    function test_band_spotBelowTheAnchorIsRefusedInsideTheStrictWindow() public {
        uint256 iB = _place(bob, false, 2_000e18); // sells currency1, wants currency0
        _advance(EPOCH_DURATION);
        queue.freeze();

        // Half-way through the freeze window the market drops hard (sells of currency0).
        _advance(FREEZE_DURATION / 2);
        _swap(poolKey, true, 20_000e18);
        _advance(FREEZE_DURATION / 2);

        int24 twap = hook.consult(poolKey.toId(), TWAP_WINDOW);
        int24 spot = _spotTick(poolKey);
        assertLt(spot, twap - MAX_TWAP_DEVIATION_TICKS, "premise: spot must sit below the anchor by more than the band");

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.TwapTooFarFromSpot.selector);
        queue.settle(0);

        (MoleQueue.Phase ph,,,, uint128 o0, uint128 o1,,) = _epochOf(queue, 0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a refused settle changed the phase");
        assertEq(o0 + o1, 0, "a refused settle wrote an output");

        // The anchor catches up; nothing else changes; the epoch settles.
        _advance(TWAP_WINDOW + 1);
        vm.prank(stranger);
        queue.settle(0);
        assertGt(_claimOn(queue, bob, 0, iB), 0, "the epoch did not pay once the anchor was fresh");
    }

    /// @notice Spot ABOVE the anchor (the other arm of the absolute value), and PAST THE DEADLINE: the
    ///         band is not one of the two refund-eligible selectors, so a lenient settle still refuses,
    ///         and the only door is `timeout()`, which returns everything in kind.
    ///         MUTATION: same line as above -> the lenient settle crosses at the stale anchor -> RED.
    function test_band_spotAboveTheAnchorIsRefusedEvenPastTheDeadline_andTimeoutIsTheOnlyDoor() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 iA = _place(alice, true, 100e18);
        _advance(EPOCH_DURATION);
        queue.freeze();

        // Right before the deadline the market jumps UP (sells of currency1), inside the window.
        _advance(MAX_EPOCH_LIFE - FREEZE_DURATION / 2);
        _swap(poolKey, false, 20_000e18);
        _advance(FREEZE_DURATION / 2);

        int24 twap = hook.consult(poolKey.toId(), TWAP_WINDOW);
        int24 spot = _spotTick(poolKey);
        assertGt(spot, twap + MAX_TWAP_DEVIATION_TICKS, "premise: spot must sit above the anchor by more than the band");
        (, uint64 frozenAt,,,,,,) = _epochOf(queue, 0);
        assertGe(_clock, uint256(frozenAt) + MAX_EPOCH_LIFE, "premise: we are at or past the deadline");

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.TwapTooFarFromSpot.selector);
        queue.settle(0);

        vm.prank(stranger);
        queue.timeout(0);
        assertEq(_claimOn(queue, alice, 0, iA), 100e18, "timeout after a band refusal is not in kind");
        assertEq(t0.balanceOf(alice), a0, "alice not made whole");
    }

    /* ================================================================================
       4.  MAX JUMP FROM THE LAST CLEARING  (P-49 "max jump from the last good clearing tick")  — MISSING.
       ============================================================================= */

    /// @notice Epoch 0 clears at ~tick 0. Between epochs the pool is walked, for free, to a tick where
    ///         it has no liquidity; the anchor follows; spot agrees; epoch 1 clears ~20,000 ticks from
    ///         the last clearing with no refusal. Nothing in the queue remembers where it last cleared.
    ///         RED until a `maxClearingJumpTicks` bound exists; when it does, the escape must still work.
    function test_MISSING_maxJump_aClearingTwentyThousandTicksFromTheLastOneIsAccepted() public {
        (PoolKey memory thin, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, RESIDUAL_SLIPPAGE_BPS);

        // Epoch 0: a small one-sided batch clears through the band at ~tick 0. This is the last clearing.
        _placeOn(q, alice, true, 1e18);
        _freezeAndSettle(q, 0);
        int24 lastClearing = hook.consult(thin.toId(), TWAP_WINDOW);
        assertLt(lastClearing > 0 ? lastClearing : -lastClearing, 100, "premise: epoch 0 cleared near tick 0");

        // Epoch 1 opened at the freeze, 300s ago. Bob queues honestly; 61s later (past the observation
        // interval, so the hook writes the parked tick) the walk; the attacker then takes the other side,
        // priced at the parked tick: just enough currency1 to buy all of bob's currency0 at ~13.5%.
        uint256 iB = _placeOn(q, bob, true, 100e18);
        _advance(OBS_INTERVAL + 1);
        int24 parked = _walk(thin);
        uint256 p = _priceX96At(parked);
        uint128 need1 = uint128(FullMath.mulDiv(100e18, p, FixedPoint96.Q96) + 1e15);
        uint256 iX = _placeOn(q, attacker, false, need1);

        _advance(EPOCH_DURATION - FREEZE_DURATION - (OBS_INTERVAL + 1));
        q.freeze();
        // The rounding residual cannot fill in a void, so the cross clears on the lenient path.
        _advance(MAX_EPOCH_LIFE);
        int24 clearing = _assertAnchorFollowedTheWalk(thin, parked);
        int24 jump = clearing > lastClearing ? clearing - lastClearing : lastClearing - clearing;
        assertGt(jump, 15_000, "premise: the clearing moved by more than 15k ticks since the last one");

        uint256 x0 = t0.balanceOf(attacker);
        (bool ok,) = address(q).call(abi.encodeCall(MoleQueue.settle, (1)));
        string memory msg_ = "no attempt";
        if (ok) {
            uint256 bobGot = _claimOn(q, bob, 1, iB);
            _claimOn(q, attacker, 1, iX);
            msg_ = string.concat(
                "MISSING max-jump guard: epoch 1 cleared ",
                vm.toString(int256(jump)),
                " ticks from the last clearing; bob sold 100e18 currency0 worth ~",
                vm.toString(_nominal(100e18)),
                " and received ",
                vm.toString(bobGot),
                " currency1; the attacker took ",
                vm.toString(t0.balanceOf(attacker) - x0),
                " currency0"
            );
        } else {
            vm.prank(stranger);
            q.timeout(1);
            assertEq(_claimOn(q, bob, 1, iB), 100e18, "escape after a jump refusal is not in kind");
            assertEq(_claimOn(q, attacker, 1, iX), need1, "escape after a jump refusal is not in kind");
        }
        assertFalse(ok, msg_);
    }

    /* ================================================================================
       5.  DEPTH / MINIMUM LIQUIDITY AT THE CLEARING TICK  (P-49 "current depth")  — MISSING.
       ============================================================================= */

    /// @notice F-4 AGAINST THE QUEUE. The FIRST epoch — so no jump guard could ever help — on a pool whose
    ///         only liquidity is a narrow band (the shape `restrictedLiquidity` gives the live pool). The
    ///         attacker exhausts the band and parks spot in the void for the price of one fee, waits one
    ///         window, and the batch crosses at a tick where the pool holds ZERO liquidity.
    ///
    ///         TWO ARMS, because the obvious patch is not a fix. ARM A: the walker — or any settler; settle
    ///         is permissionless and so is adding liquidity while `restrictedLiquidity` is off — drops the
    ///         band's own depth around the parked tick for ONE BLOCK, in the freeze block and again in the
    ///         settle block, so a guard that reads `getLiquidity` at either moment sees a full pool. The
    ///         dust residual then fills and the cross clears in the STRICT window, no deadline needed; the
    ///         position comes out the same block having paid nothing but the dust trade. ARM B: no depth
    ///         anywhere, the lenient settle at the deadline. A spot liquidity floor turns off neither arm.
    ///         Only a bound the one-block position cannot satisfy — time-weighted depth over the window, or
    ///         a reference the walker cannot place — refuses both, and then the escape must still work.
    ///         RED until a JIT-proof depth bound exists.
    function test_MISSING_depth_aFreeTwapWalkIntoZeroLiquidityClearsTheBatchAtTheWalkedPrice() public {
        (PoolKey memory thin, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, RESIDUAL_SLIPPAGE_BPS);

        uint256 iA = _placeOn(q, alice, true, 100e18); // honest: sells currency0
        _advance(OBS_INTERVAL + 10);

        uint256 spent0 = t0.balanceOf(address(this));
        int24 parked = _walk(thin);
        spent0 -= t0.balanceOf(address(this)); // currency0 the walk pushed through the band (traded, not lost)
        assertEq(StateLibrary.getLiquidity(manager, thin.toId()), 0, "premise: zero in-range liquidity at the parked tick");

        uint256 p = _priceX96At(parked);
        uint128 need1 = uint128(FullMath.mulDiv(100e18, p, FixedPoint96.Q96) + 1e15);
        uint256 iX = _placeOn(q, attacker, false, need1);

        _advance(EPOCH_DURATION - (OBS_INTERVAL + 10));
        // The freeze block: a guard that samples depth when the epoch is frozen reads the one-block position.
        _jitAdd(thin);
        q.freeze();
        _jitRemove(thin);
        assertEq(StateLibrary.getLiquidity(manager, thin.toId()), 0, "premise: the freeze-block position was not removed");
        _advance(FREEZE_DURATION);
        int24 clearing = _assertAnchorFollowedTheWalk(thin, parked);

        // Strict, no depth: refused in every world — as shipped, because the dust residual cannot execute in a
        // void (`ResidualSwapTooFarFromTwap`, the PRICE failure the deadline fallback forgives; the cross itself
        // is not what is refused — arm B shows that); under a depth guard, for the guard's own reason. The
        // selector is deliberately not pinned here so a guard that ships does not trip this premise.
        vm.prank(stranger);
        (bool okStrict,) = address(q).call(abi.encodeCall(MoleQueue.settle, (0)));
        assertFalse(okStrict, "premise: a strict settle with no depth anywhere must be refused");
        (MoleQueue.Phase phS,,,, uint128 o0S, uint128 o1S,,) = _epochOf(q, 0);
        assertEq(uint8(phS), uint8(MoleQueue.Phase.Frozen), "premise: a refused settle changed the phase");
        assertEq(o0S + o1S, 0, "premise: a refused settle wrote an output");

        // ARM A — the one-block position in the settle block. Snapshotted so arm B runs from the same state.
        uint256 snap = vm.snapshotState();
        uint256 lp0 = t0.balanceOf(address(this));
        uint256 lp1 = t1.balanceOf(address(this));
        _jitAdd(thin);
        uint128 depthAtSettle = StateLibrary.getLiquidity(manager, thin.toId());
        assertGe(depthAtSettle, JIT_DEPTH, "premise: the settle-block position does not cover a floor sized to the band");
        uint256 x0 = t0.balanceOf(attacker);
        (bool okJit,) = address(q).call(abi.encodeCall(MoleQueue.settle, (0)));
        string memory msgJit = "";
        if (okJit) {
            uint256 aliceGot = _claimOn(q, alice, 0, iA);
            _claimOn(q, attacker, 0, iX);
            uint256 taken = t0.balanceOf(attacker) - x0;
            _jitRemove(thin);
            msgJit = string.concat(
                "ARM A (one-block depth, STRICT window): in-range liquidity read ",
                vm.toString(depthAtSettle),
                " at settle and the batch still cleared at tick ",
                vm.toString(int256(clearing)),
                "; alice sold 100e18 currency0 worth ~",
                vm.toString(_nominal(100e18)),
                " and received ",
                vm.toString(aliceGot),
                " currency1; the attacker took ",
                vm.toString(taken),
                " currency0; the position's net was ",
                _delta(t0.balanceOf(address(this)), lp0),
                " currency0 / ",
                _delta(t1.balanceOf(address(this)), lp1),
                " currency1 (the dust residual only) - a spot liquidity floor sized to the band reads satisfied. "
            );
        } else {
            (MoleQueue.Phase ph,,,, uint128 o0, uint128 o1,,) = _epochOf(q, 0);
            assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "arm A: a refused settle changed the phase");
            assertEq(o0 + o1, 0, "arm A: a refused settle wrote an output");
            _jitRemove(thin);
        }
        assertEq(StateLibrary.getLiquidity(manager, thin.toId()), 0, "premise: the settle-block position was not removed");
        vm.revertToState(snap);
        _resync();

        // ARM B — no depth anywhere, the lenient settle at the deadline.
        _advance(MAX_EPOCH_LIFE);
        x0 = t0.balanceOf(attacker);
        (bool okLenient,) = address(q).call(abi.encodeCall(MoleQueue.settle, (0)));
        string memory msgLenient = "";
        if (okLenient) {
            uint256 aliceGot = _claimOn(q, alice, 0, iA);
            _claimOn(q, attacker, 0, iX);
            msgLenient = string.concat(
                "ARM B (no depth, lenient at the deadline): the batch cleared at tick ",
                vm.toString(int256(clearing)),
                " with zero in-range liquidity; alice received ",
                vm.toString(aliceGot),
                " currency1 for 100e18 currency0; the attacker took ",
                vm.toString(t0.balanceOf(attacker) - x0),
                " currency0; the walk pushed ",
                vm.toString(spent0),
                " currency0 through the band (traded at ~par, recoverable the same way)."
            );
        } else {
            // The guard exists and is not forgiven past the deadline. The refusal must not be a trap.
            vm.prank(stranger);
            q.timeout(0);
            assertEq(_claimOn(q, alice, 0, iA), 100e18, "escape after a depth refusal is not in kind");
            assertEq(_claimOn(q, attacker, 0, iX), need1, "escape after a depth refusal is not in kind");
        }
        assertFalse(okJit || okLenient, string.concat("MISSING depth guard. ", msgJit, msgLenient));
    }

    /* ================================================================================
       6.  CONSUMED-INPUT CHECK ON THE RESIDUAL, BOTH DIRECTIONS  (17.2, S-1)  — PRESENT.
       ============================================================================= */

    /// @notice 0->1 leg. The residual is sized just past what the band can absorb so the OUTPUT lands
    ///         inside a deliberately wide 10% band — only the input-consumed check can refuse. Strict:
    ///         `ResidualShortFill`; at the deadline the whole side comes back in kind, not one wei kept.
    ///         MUTATION: delete `if (uint128(-owed) < amountIn) revert ResidualShortFill();` -> the short
    ///         fill settles and strands the difference -> RED.
    function test_consumedInput_aShortFillOnTheZeroForOneLegIsRefusedAndReturnedWhole() public {
        (PoolKey memory thin, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, 1_000);
        (uint160 sqrtNow,,,) = StateLibrary.getSlot0(manager, thin.toId());
        uint256 capacity =
            SqrtPriceMath.getAmount0Delta(TickMath.getSqrtPriceAtTick(-60), sqrtNow, 100_000e18, false);
        uint128 amt = uint128((capacity * 104) / 100);

        uint256 a0 = t0.balanceOf(alice);
        uint256 iA = _placeOn(q, alice, true, amt);
        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        q.settle(0);
        (,,,, uint128 o0,, uint128 r0,) = _epochOf(q, 0);
        assertEq(o0, 0, "a refused short fill recorded an output");
        assertEq(r0, amt, "the short-filled side was not booked back whole");
        assertEq(_claimOn(q, alice, 0, iA), 0, "no swap happened, so the output leg must be zero");
        assertEq(t0.balanceOf(alice), a0, "alice was not made whole");
        assertEq(t0.balanceOf(address(q)), 0, "escrow stranded in the queue");
    }

    /// @notice 1->0 leg, the mirror. One check serves both legs because it sits in `_swapExactIn`, but a
    ///         guard exercised in one direction only is a guard tested once (17.3), so the other leg is
    ///         driven here on its own.
    ///         MUTATION: same line -> RED.
    function test_consumedInput_aShortFillOnTheOneForZeroLegIsRefusedAndReturnedWhole() public {
        (PoolKey memory thin, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, 1_000);
        (uint160 sqrtNow,,,) = StateLibrary.getSlot0(manager, thin.toId());
        uint256 capacity = SqrtPriceMath.getAmount1Delta(sqrtNow, TickMath.getSqrtPriceAtTick(60), 100_000e18, false);
        uint128 amt = uint128((capacity * 104) / 100);

        uint256 c1 = t1.balanceOf(carol);
        uint256 iC = _placeOn(q, carol, false, amt);
        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        q.settle(0);
        (,,,,, uint128 o1,, uint128 r1) = _epochOf(q, 0);
        assertEq(o1, 0, "a refused short fill recorded an output");
        assertEq(r1, amt, "the short-filled side was not booked back whole");
        assertEq(_claimOn(q, carol, 0, iC), 0, "no swap happened, so the output leg must be zero");
        assertEq(t1.balanceOf(carol), c1, "carol was not made whole");
        assertEq(t1.balanceOf(address(q)), 0, "escrow stranded in the queue");
    }

    /* ================================================================================
       7.  THE FALLBACK IS DEADLINE-GATED AND LIMITED TO THE TWO PRICE SELECTORS  (17.5, Q-3)  — PRESENT.
       ============================================================================= */

    /// @notice Strict until the very last second. A residual that cannot fill is refused at the first
    ///         legal settle, refused one second before the deadline, and resolved — matched part cleared,
    ///         unmatched part back in kind — on the deadline itself.
    ///         MUTATION: `bool lenient = true;` (delete the gate) -> the deadline-minus-one settle
    ///         resolves early -> RED.
    function test_fallback_isStrictUntilTheDeadlineThenRefundsTheUnmatchedPartInKind() public {
        (, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, RESIDUAL_SLIPPAGE_BPS);
        uint128 big = 50_000e18;
        uint256 iA = _placeOn(q, alice, true, big);
        uint256 iC = _placeOn(q, carol, false, 10e18); // fully crossable against alice
        _advance(EPOCH_DURATION);
        q.freeze();
        (, uint64 frozenAt,,,,,,) = _epochOf(q, 0);

        _advance(FREEZE_DURATION);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        _advance(MAX_EPOCH_LIFE - FREEZE_DURATION - 1);
        assertEq(_clock, uint256(frozenAt) + MAX_EPOCH_LIFE - 1, "premise: one second before the deadline");
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        _advance(1);
        vm.prank(stranger);
        q.settle(0);
        (MoleQueue.Phase ph,,,, uint128 o0, uint128 o1, uint128 r0, uint128 r1) = _epochOf(q, 0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "the deadline settle did not resolve the epoch");
        assertGt(o0, 0, "the crossed part was not cleared for the currency0 side");
        assertGt(o1, 0, "the crossed part was not cleared for the currency1 side");
        assertLe(r1, 1, "the fully-crossed side must owe at most a rounding wei of refund");
        assertGt(r0, 0, "the unmatched remainder was not booked back");
        assertEq(uint256(r0) + o1, big, "crossed + refunded must equal what the currency0 side escrowed");

        uint256 a0 = t0.balanceOf(alice);
        _claimOn(q, alice, 0, iA);
        assertEq(t0.balanceOf(alice), a0 + r0, "alice's in-kind leg was not paid");
        assertEq(_claimOn(q, carol, 0, iC), o1, "carol's cross was not paid");
    }

    /// @notice Past the deadline a NON-price failure inside the unlock is re-thrown verbatim, never
    ///         laundered into a refund; with the fault cleared the same epoch resolves by swapping.
    ///         MUTATION: `_isResidualPriceFailure` returns true (a blanket catch) -> TransferFailed becomes
    ///         a quiet in-kind settlement -> RED.
    function test_fallback_aNonPriceFailureIsRethrownEvenPastTheDeadline() public {
        _place(alice, true, 100e18);
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE); // lenient

        // The settle-side transfer reverts. Not a price problem.
        vm.mockCallRevert(address(t0), IERC20Minimal.transfer.selector, "");
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.TransferFailed.selector);
        queue.settle(0);
        vm.clearMockedCalls();

        (MoleQueue.Phase ph,,,, uint128 o0,, uint128 r0,) = _epochOf(queue, 0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a re-thrown failure resolved the epoch");
        assertEq(o0, 0, "a re-thrown failure wrote an output");
        assertEq(r0, 0, "a re-thrown failure booked a refund");

        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0b,, uint128 r0b,) = _epochOf(queue, 0);
        assertGt(o0b, 0, "the residual was not swapped once the fault cleared");
        assertEq(r0b, 0, "a healthy residual was refunded instead of swapped");
    }

    /// @notice A revert whose data BEGINS with a price selector but carries trailing bytes is not a price
    ///         failure: it is re-thrown byte for byte. The genuine 4-byte selector, from the same state, is
    ///         forgiven. The length check was recorded as unkillable by any reachable state; a mocked
    ///         PoolManager reaches it.
    ///         MUTATION: delete `if (err.length != 4) return false;` -> the 36-byte counterfeit is
    ///         accepted and refunded -> RED.
    function test_fallback_aCounterfeitPriceSelectorWithTrailingDataIsRethrownVerbatim() public {
        _place(alice, true, 100e18);
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE); // lenient

        bytes memory counterfeit = abi.encodeWithSelector(MoleQueue.ResidualSwapTooFarFromTwap.selector, uint256(0xdead));
        assertEq(counterfeit.length, 36, "premise: the counterfeit is longer than a bare selector");
        vm.mockCallRevert(address(manager), IPoolManager.swap.selector, counterfeit);
        vm.prank(stranger);
        vm.expectRevert(counterfeit);
        queue.settle(0);
        vm.clearMockedCalls();

        (MoleQueue.Phase ph,,,,,, uint128 r0,) = _epochOf(queue, 0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Frozen), "a counterfeit selector resolved the epoch");
        assertEq(r0, 0, "a counterfeit selector booked a refund");

        // Positive control: the bare selector from the same place IS forgiven past the deadline.
        vm.mockCallRevert(address(manager), IPoolManager.swap.selector, abi.encodeWithSelector(MoleQueue.ResidualSwapTooFarFromTwap.selector));
        vm.prank(stranger);
        queue.settle(0);
        vm.clearMockedCalls();
        (MoleQueue.Phase ph2,,,, uint128 o0b,, uint128 r0b,) = _epochOf(queue, 0);
        assertEq(uint8(ph2), uint8(MoleQueue.Phase.Settled), "the genuine price failure did not resolve");
        assertEq(o0b, 0, "a refunded residual recorded an output");
        assertEq(r0b, 100e18, "the genuine price failure did not refund the whole side");
    }

    /* ================================================================================
       8.  DEFERRAL CEILING + ALWAYS-AVAILABLE ESCAPE, NO SETTLER DEPENDENCY  (P-56, 17.4, B4)  — PRESENT
           as a TIME bound (maxEpochLife from the CUTOFF), not a count of deferrals.
       ============================================================================= */

    /// @notice A frozen epoch whose guard trips on every attempt: the settler cannot resolve it and never
    ///         comes back. At exactly cutoff + maxEpochLife a COMPLETE STRANGER ends it and every escrow
    ///         comes back in kind — no settler, no freeze operator, no permission.
    ///         MUTATION: delete `ep.phase = Phase.Refunding;` in timeout's Frozen branch -> claims revert
    ///         WrongPhase -> RED.
    function test_escape_aFrozenEpochWithATrippedGuardIsFreedByAStrangerOnTheCutoffClock() public {
        (, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, RESIDUAL_SLIPPAGE_BPS);
        uint256 a0 = t0.balanceOf(alice);
        uint256 c1 = t1.balanceOf(carol);
        uint256 iA = _placeOn(q, alice, true, 50_000e18);
        uint256 iC = _placeOn(q, carol, false, 10e18);
        uint256 cutoff = _clock + EPOCH_DURATION;

        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        _advance(MAX_EPOCH_LIFE - FREEZE_DURATION - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        q.timeout(0);

        _advance(1);
        assertEq(_clock, cutoff + MAX_EPOCH_LIFE, "premise: the bound is measured from the cutoff");
        vm.prank(stranger);
        q.timeout(0);
        assertEq(uint8(q.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "the stranger could not free the escrow");

        assertEq(_claimOn(q, alice, 0, iA), 50_000e18, "alice not refunded in kind");
        assertEq(_claimOn(q, carol, 0, iC), 10e18, "carol not refunded in kind");
        assertEq(t0.balanceOf(alice), a0, "alice not made whole");
        assertEq(t1.balanceOf(carol), c1, "carol not made whole");
        assertEq(t0.balanceOf(address(q)) + t1.balanceOf(address(q)), 0, "escrow left behind");
    }

    /// @notice The same bound when NOBODY presses anything: no freeze, no settle attempt, the market moves
    ///         past the band after the cutoff so a settle would be refused anyway. At cutoff + maxEpochLife
    ///         the stranger times the never-frozen epoch out and the escrow is back in kind.
    ///         MUTATION: delete `ep.phase = Phase.Refunding;` in timeout's Open branch -> claims revert
    ///         WrongPhase -> RED.
    function test_escape_aNeverFrozenEpochWithATrippedGuardTimesOutOnTheCutoffClock() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);
        uint256 cutoff = _clock + EPOCH_DURATION;

        _advance(EPOCH_DURATION + 10);
        _swap(poolKey, true, 20_000e18); // the band would refuse any settle from here

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.settle(0); // never frozen: settle is not even reachable

        _advance(MAX_EPOCH_LIFE - 11);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(1);
        assertEq(_clock, cutoff + MAX_EPOCH_LIFE, "premise: the bound is measured from the cutoff");
        vm.prank(stranger);
        queue.timeout(0);
        assertEq(queue.currentEpoch(), 1, "an abandoned epoch must not still be taking orders");
        assertEq(_claimOn(queue, alice, 0, iA), 100e18, "alice not refunded in kind");
        assertEq(_claimOn(queue, carol, 0, iC), 60e18, "carol not refunded in kind");
        assertEq(t0.balanceOf(alice), a0, "alice not made whole");
    }

    /// @notice PIN (C-7). AT THE DEADLINE THE TERMINAL ACTION IS WHOEVER CALLS FIRST. From one identical
    ///         state on the deadline second, `settle` (lenient) clears the matched part at TWAP and refunds
    ///         the rest, while `timeout` refunds everything in kind — and both are permissionless. A
    ///         participant who dislikes the cross can race `timeout`; a participant who likes it can race
    ///         `settle`. Pinned so that whichever way C-7 is decided, the change shows up here.
    function test_PIN_C7_atTheDeadlineSettleAndTimeoutAreBothOpenAndDisagreeOnWhatCarolReceives() public {
        (, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, RESIDUAL_SLIPPAGE_BPS);
        uint256 iA = _placeOn(q, alice, true, 50_000e18);
        uint256 iC = _placeOn(q, carol, false, 10e18);
        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(MAX_EPOCH_LIFE);

        uint256 snap = vm.snapshotState();

        // Arm A: settle wins the race. Carol is crossed and paid in currency0.
        uint256 c0 = t0.balanceOf(carol);
        vm.prank(stranger);
        q.settle(0);
        assertEq(uint8(q.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "arm A: settle was not open at the deadline");
        uint256 carolCrossed = _claimOn(q, carol, 0, iC);
        assertGt(carolCrossed, 0, "arm A: carol's cross paid nothing");
        assertEq(t0.balanceOf(carol), c0 + carolCrossed, "arm A: carol was not paid in currency0");
        uint256 aliceRefund = q.refundOf(0, iA);
        assertGt(aliceRefund, 0, "arm A: alice's unmatched part was not booked back");

        vm.revertToState(snap);
        _resync();

        // Arm B: timeout wins the race. Carol gets her own currency1 back and no currency0 at all.
        uint256 c1 = t1.balanceOf(carol);
        c0 = t0.balanceOf(carol);
        vm.prank(stranger);
        q.timeout(0);
        assertEq(uint8(q.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "arm B: timeout was not open at the deadline");
        assertEq(_claimOn(q, carol, 0, iC), 10e18, "arm B: carol's refund is not in kind");
        assertEq(t1.balanceOf(carol), c1 + 10e18, "arm B: carol did not get her currency1 back");
        assertEq(t0.balanceOf(carol), c0, "arm B: carol received currency0 from an in-kind refund");
        assertEq(_claimOn(q, alice, 0, iA), 50_000e18, "arm B: alice's refund is not in kind");
    }

    /* ================================================================================
       9.  SAME-TX PLACE + SETTLE  (FLOW-3 precheck)  — PRESENT structurally (phase gating), not as the
           named precheck.
       ============================================================================= */

    /// @notice One transaction places into epoch e and settles e. The place succeeds (e is Open) and the
    ///         settle refuses (e is not stored-Frozen), so the whole composition unwinds: no order, no
    ///         totals change, no balance change.
    ///         MUTATION: delete `if (ep.phase != Phase.Frozen) revert WrongPhase();` in settle -> an OPEN
    ///         epoch settles inside the composer's transaction -> RED.
    function test_sameTx_placingIntoAnEpochAndSettlingItInOneTransactionIsRefused() public {
        _place(alice, true, 100e18);
        uint256 cBal1 = t1.balanceOf(address(composer));

        vm.expectRevert(MoleQueue.WrongPhase.selector);
        composer.placeThenSettle(queue, false, 50e18, 0);

        assertEq(queue.orderCount(0), 1, "the composer's order survived the refused composition");
        (,, uint128 in0, uint128 in1,,,,) = _epochOf(queue, 0);
        assertEq(in0, 100e18, "totals changed");
        assertEq(in1, 0, "totals changed");
        assertEq(t1.balanceOf(address(composer)), cBal1, "the composer's escrow was taken by a refused composition");
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Open), "the epoch phase changed");
    }

    /// @notice PIN. Placing into the NEXT epoch while settling this one is allowed and changes nothing:
    ///         epoch e's outputs are byte-identical with and without the composed place, because settle
    ///         reads only e's frozen totals and the oracle.
    function test_PIN_sameTx_placingIntoTheNextEpochWhileSettlingThisOneChangesNothing() public {
        _place(alice, true, 100e18);
        _place(carol, false, 60e18);
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);

        uint256 snap = vm.snapshotState();
        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0A, uint128 o1A, uint128 r0A, uint128 r1A) = _epochOf(queue, 0);
        vm.revertToState(snap);
        _resync();

        composer.placeThenSettle(queue, true, 500e18, 0);
        (,,,, uint128 o0B, uint128 o1B, uint128 r0B, uint128 r1B) = _epochOf(queue, 0);
        assertEq(o0B, o0A, "out0 changed because of a place into the next epoch");
        assertEq(o1B, o1A, "out1 changed because of a place into the next epoch");
        assertEq(r0B, r0A, "refund0 changed because of a place into the next epoch");
        assertEq(r1B, r1A, "refund1 changed because of a place into the next epoch");
        (,, uint128 in0Next,,,,,) = _epochOf(queue, 1);
        assertEq(in0Next, 500e18, "the composed order did not land in the next epoch");
    }

    /* ================================================================================
       10. DONATION / POST-FREEZE IMMUNITY  (P-53, FLOW-3 inv (f))  — PRESENT, structurally: settle reads
           frozen totals, the TWAP and spot; claim reads the epoch record. No balance is ever consulted.
       ============================================================================= */

    /// @notice `donate()` between freeze and settle changes no fill. The hook mines no donate bit, so the
    ///         oracle cannot see it; donate moves fee growth, not the tick or the liquidity. A/B against
    ///         the same snapshot, fills compared to the wei. Non-vacuity: fee growth really moved.
    ///         No single guard line exists to mutate; the immunity is the absence of a balance read.
    function test_immunity_aDonateBetweenFreezeAndSettleChangesNoFill() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18); // 60 crosses, 40 goes through the pool
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);

        uint256 snap = vm.snapshotState();
        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0A, uint128 o1A, uint128 r0A, uint128 r1A) = _epochOf(queue, 0);
        uint256 aA = _claimOn(queue, alice, 0, iA);
        uint256 cA = _claimOn(queue, carol, 0, iC);
        vm.revertToState(snap);
        _resync();

        (uint256 fg0, uint256 fg1) = StateLibrary.getFeeGrowthGlobals(manager, poolKey.toId());
        donateRouter.donate(poolKey, 5_000e18, 5_000e18, ZERO_BYTES);
        (uint256 fg0b, uint256 fg1b) = StateLibrary.getFeeGrowthGlobals(manager, poolKey.toId());
        assertGt(fg0b, fg0, "non-vacuity: the donation did not move fee growth");
        assertGt(fg1b, fg1, "non-vacuity: the donation did not move fee growth");

        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0B, uint128 o1B, uint128 r0B, uint128 r1B) = _epochOf(queue, 0);
        assertEq(o0B, o0A, "out0 moved with a donation");
        assertEq(o1B, o1A, "out1 moved with a donation");
        assertEq(r0B, r0A, "refund0 moved with a donation");
        assertEq(r1B, r1A, "refund1 moved with a donation");
        assertEq(_claimOn(queue, alice, 0, iA), aA, "alice's fill moved with a donation");
        assertEq(_claimOn(queue, carol, 0, iC), cA, "carol's fill moved with a donation");
    }

    /// @notice A plain ERC-20 transfer INTO the queue between freeze and settle changes no fill — and the
    ///         gift is stranded, not distributed (there is no sweep).
    ///         MUTATION (negative control): make settle read
    ///         `ep.totalIn0 = uint128(IERC20Minimal(currency0).balanceOf(address(this)))` -> the gift
    ///         inflates the side's total and every fill moves -> RED.
    function test_immunity_anErc20TransferIntoTheQueueBetweenFreezeAndSettleChangesNoFill() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);

        uint256 snap = vm.snapshotState();
        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0A, uint128 o1A, uint128 r0A, uint128 r1A) = _epochOf(queue, 0);
        uint256 aA = _claimOn(queue, alice, 0, iA);
        uint256 cA = _claimOn(queue, carol, 0, iC);
        vm.revertToState(snap);
        _resync();

        t0.transfer(address(queue), 7_000e18);
        t1.transfer(address(queue), 3_000e18);
        assertEq(t0.balanceOf(address(queue)), 100e18 + 7_000e18, "non-vacuity: the gift did not land");

        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0B, uint128 o1B, uint128 r0B, uint128 r1B) = _epochOf(queue, 0);
        assertEq(o0B, o0A, "out0 moved with an ERC-20 gift");
        assertEq(o1B, o1A, "out1 moved with an ERC-20 gift");
        assertEq(r0B, r0A, "refund0 moved with an ERC-20 gift");
        assertEq(r1B, r1A, "refund1 moved with an ERC-20 gift");
        assertEq(_claimOn(queue, alice, 0, iA), aA, "alice's fill moved with an ERC-20 gift");
        assertEq(_claimOn(queue, carol, 0, iC), cA, "carol's fill moved with an ERC-20 gift");
        // The gift is stranded — nobody's fill, nobody's refund, no sweep.
        assertGe(t0.balanceOf(address(queue)), 7_000e18, "the gift was distributed to claimants");
        assertGe(t1.balanceOf(address(queue)), 3_000e18, "the gift was distributed to claimants");
    }

    /// @notice An ERC-6909 claim transfer INTO the queue between freeze and settle changes no fill. The
    ///         queue never reads its PoolManager claim balance.
    ///         MUTATION (negative control): make settle do
    ///         `ep.totalIn1 += uint128(poolManager.balanceOf(address(this), currency1.toId()))` -> RED.
    function test_immunity_anErc6909TransferIntoTheQueueBetweenFreezeAndSettleChangesNoFill() public {
        // Acquire currency1 claims BEFORE the snapshot so both arms share the same pool state.
        uint256 id1 = uint256(uint160(Currency.unwrap(currency1)));
        swapRouter.swap(
            poolKey,
            SwapParams({zeroForOne: true, amountSpecified: -int256(1_000e18), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: true, settleUsingBurn: false}),
            ZERO_BYTES
        );
        uint256 claims = manager.balanceOf(address(this), id1);
        assertGt(claims, 0, "premise: no claims to transfer");
        _advance(TWAP_WINDOW + 1); // let the anchor absorb that swap so the band is not what decides

        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);

        uint256 snap = vm.snapshotState();
        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0A, uint128 o1A, uint128 r0A, uint128 r1A) = _epochOf(queue, 0);
        uint256 aA = _claimOn(queue, alice, 0, iA);
        uint256 cA = _claimOn(queue, carol, 0, iC);
        vm.revertToState(snap);
        _resync();

        manager.transfer(address(queue), id1, claims);
        assertEq(manager.balanceOf(address(queue), id1), claims, "non-vacuity: the claims did not land");

        vm.prank(stranger);
        queue.settle(0);
        (,,,, uint128 o0B, uint128 o1B, uint128 r0B, uint128 r1B) = _epochOf(queue, 0);
        assertEq(o0B, o0A, "out0 moved with an ERC-6909 gift");
        assertEq(o1B, o1A, "out1 moved with an ERC-6909 gift");
        assertEq(r0B, r0A, "refund0 moved with an ERC-6909 gift");
        assertEq(r1B, r1A, "refund1 moved with an ERC-6909 gift");
        assertEq(_claimOn(queue, alice, 0, iA), aA, "alice's fill moved with an ERC-6909 gift");
        assertEq(_claimOn(queue, carol, 0, iC), cA, "carol's fill moved with an ERC-6909 gift");
    }

    /* ================================================================================
       11. C-3: WHAT THE CROSSED PORTION IS CHARGED  — PIN: exactly zero.
       ============================================================================= */

    /// @notice PIN (C-3). A perfectly balanced epoch at tick 0 crosses 100e18 for 100e18: zero pool fee,
    ///         zero spread, zero netting fee, the pool never touched (it has no liquidity at all, so any
    ///         residual would have reverted). This is what `internalCrossFeeBps` actually is today: 0.
    function test_PIN_C3_theCrossedPortionIsChargedExactlyZero() public {
        PoolKey memory exact = _newPool(10); // tick 0 exactly; never swapped, no liquidity
        _advance(TWAP_WINDOW + 1);
        MoleQueue q = _newQueue(exact, RESIDUAL_SLIPPAGE_BPS);
        _approve(alice, address(q));
        _approve(carol, address(q));
        uint256 iA = _placeOn(q, alice, true, 100e18);
        uint256 iC = _placeOn(q, carol, false, 100e18);

        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);
        vm.prank(stranger);
        q.settle(0);

        (,,,, uint128 o0, uint128 o1, uint128 r0, uint128 r1) = _epochOf(q, 0);
        assertEq(o0, 100e18, "currency0 sellers were charged something on the cross");
        assertEq(o1, 100e18, "currency1 sellers were charged something on the cross");
        assertEq(r0 + r1, 0, "a balanced epoch booked a refund");
        assertEq(_claimOn(q, alice, 0, iA), 100e18, "alice's cross was not the exact TWAP amount");
        assertEq(_claimOn(q, carol, 0, iC), 100e18, "carol's cross was not the exact TWAP amount");
        assertEq(t0.balanceOf(address(q)) + t1.balanceOf(address(q)), 0, "the queue kept a fee");
        assertEq(StateLibrary.getLiquidity(manager, exact.toId()), 0, "premise: the pool had no liquidity to touch");
    }
}
