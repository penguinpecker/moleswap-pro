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
import {MoleHook} from "../../src/MoleHook.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";

/// @notice ORACLE / TWAP ATTACK SURFACE on MoleHook.
///
/// The thesis under test: `consult()` claims to return "the arithmetic-mean tick over the last
/// `secondsAgo` seconds" and to "revert rather than return a stale or half-covered answer". Both halves
/// of that claim are attacked here with real swaps against a real PoolManager, and the returned value is
/// compared against an independently computed reference TWAP built from the actual per-swap tick history
/// (not from the hook's own accumulator), so the hook cannot grade its own homework.
///
/// STATUS. Six of the attacks in this file LANDED against the previous MoleHook and are now BLOCKED.
/// Every one of them keeps its original hostile setup — the same 480 dust swaps, the same one-block
/// 256-swap ring flood, the same 2106 rollover — and now measures the same quantity to prove the attack
/// no longer moves it. Nothing was deleted to reach green:
///
///   A-1  / A-2 / A-2b  the ORACLE FREEZE. `_write` gated the ring push on time-since-last-SWAP while
///                      bumping that clock on every swap, so any pool busier than minObservationInterval
///                      recorded NOTHING forever and consult() failed OPEN with a lifetime average. The
///                      gate is now `sinceObs = now - lastObsTimestamp`. Busy pools record; dust cannot
///                      pin the window. Regressions below.
///   A-4                consult() never interpolated to `target`, so it silently answered a LONGER
///                      window than requested (measured 12x understatement). It now interpolates between
///                      the two bracketing observations and divides by the REQUESTED window.
///   A-5                minObservationInterval == 0 was a legal deploy value and let 256 dust swaps in
///                      ONE block overwrite the whole ring and brick consult(). The constructor now
///                      refuses that config, and at the tightest legal config (1s) a one-block flood
///                      cannot write more than a single observation.
///   A-6                the 2106 uint32 rollover panicked inside afterSwap and killed the swap path
///                      permanently. The subtractions are unchecked (v3-style) and swaps survive.
///   A-7                consult() over-long windows died on an arithmetic Panic rather than the guard.
///                      There is now an explicit fail-closed check that returns InsufficientObservations.
///
/// STILL LIVE, and deliberately left proven by a PASSING test: A-5b. CARDINALITY is a hardcoded 256 with
/// no v3-style increaseObservationCardinalityNext, so organic volume can still roll the whole ring inside
/// a 30-minute window and brick a 30-minute TWAP. That is a bounded, no-attacker DoS on the READ path
/// (it reverts, it does not lie) and the fix did not address it.
///
/// THE FEE IS GONE, THE ORACLE IS NOT. MoleHook's volatility-scaled dynamic fee was REMOVED rather than
/// repaired: the party that collected the surcharge was the party that could manufacture the volatility it
/// was derived from, and with `restrictedLiquidity` the vault is always that party. Nothing in THIS file
/// ever attacked the fee — every attack here targets the oracle, which survives unchanged — so only one
/// clause lost its subject: A-5 also used to pin the constructor's `volWindow == 0` guard, and `volWindow`
/// no longer exists. That clause is deleted. The half of A-5 the ring-flood attack actually needed,
/// `minObservationInterval == 0`, is untouched and still pinned by selector.
///
/// Mechanical consequences, so the diff is not mistaken for a weakening: the constructor is 7 args (was
/// 12), so `_ctorArgs` shrank; `PoolState` is 6 fields (was 8: `volAccum` and `lastObsTick` went with the
/// fee), so every `poolStates` destructure lost two trailing holes. No assertion was relaxed. Two were
/// ADDED — the 256-swap one-block flood (A-5) and the 540-swap dust campaign (A-2b) are precisely the
/// machines that used to walk the surcharge to its ceiling, so both now also assert `currentFee` is
/// immovable. They are cheap, they keep the hostile setup pointed at a live target, and they fail if a
/// future change ever re-derives the fee from swap-driven state.
///
/// TIME: `vm.warp(block.timestamp + d)` inside a loop does NOT accumulate — solc caches block.timestamp
/// per call frame. Every loop here uses the explicit `_clock` counter.
contract AttackMoleHookOracle is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal treasury = makeAddr("treasury");

    /// @dev The pool's one and only LP fee. There is no min/base/max any more — `lpFeePips` is a single
    ///      immutable that beforeSwap re-asserts with OVERRIDE_FEE_FLAG on every swap.
    uint24 internal constant LP_FEE = 3000;

    /// @dev A realistic chain timestamp. Deliberately NOT the default `1`: several things in this file
    ///      (and one test in the shipped suite) behave differently at a tiny timestamp.
    uint256 internal constant T0 = 1_750_000_000;

    uint256 internal _clock;
    /// @dev Explicit block height. Same reason as _clock: block.number cannot change inside a call
    ///      frame either, so solc may cache it and `vm.roll(block.number + n)` in a loop would stall.
    uint256 internal _height;

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        // Time passing implies blocks passing. Foundry's vm.warp does NOT advance block.number, so a
        // harness that only warps models a chain where the clock moves but no block is ever produced —
        // which silently freezes anything keyed on block.number. On Robinhood Chain block.number is the
        // ETHEREUM L1 height (~12s per tick), so one tick per advance is the conservative mapping.
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    /* ------------------------------------------------------------- reference oracle */

    /// @dev The tick that was in force starting at `ts`. Between swaps the pool tick cannot move (only
    ///      swaps move it), so the true tick path is piecewise-constant and exactly reconstructible.
    struct Sample {
        uint32 ts;
        int24 tick;
    }

    mapping(bytes32 => Sample[]) internal _samples;

    function _record(PoolKey memory k) internal {
        (, int24 t,,) = StateLibrary.getSlot0(manager, k.toId());
        _samples[PoolId.unwrap(k.toId())].push(Sample(uint32(block.timestamp), t));
    }

    /// @notice The honest arithmetic-mean tick over [now-window, now], computed from the real tick path.
    function _trueMeanTick(PoolKey memory k, uint32 window) internal view returns (int256) {
        Sample[] storage ss = _samples[PoolId.unwrap(k.toId())];
        uint32 nowTs = uint32(block.timestamp);
        uint32 start = nowTs - window;
        int256 acc;
        for (uint256 i = 0; i < ss.length; i++) {
            uint32 segStart = ss[i].ts;
            uint32 segEnd = i + 1 < ss.length ? ss[i + 1].ts : nowTs;
            if (segEnd <= start || segStart >= nowTs) continue;
            uint32 a = segStart < start ? start : segStart;
            uint32 b = segEnd > nowTs ? nowTs : segEnd;
            if (b <= a) continue;
            acc += int256(uint256(b - a)) * int256(ss[i].tick);
        }
        return acc / int256(uint256(window));
    }

    /* ------------------------------------------------------------------- harness */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("attack-oracle", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev restrictedLiquidity is FALSE here on purpose: this suite drives liquidity through Deployers'
    ///      own router, and the oracle attacks are about the observation ring, not about who may provide.
    function _ctorArgs(uint32 obsInterval) internal returns (bytes memory) {
        return hookProxyArgs(manager, address(this), LP_FEE, obsInterval, false, uint24(0), treasury, address(this));
    }

    function _deployHook(uint256 seed, uint32 obsInterval) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo("ERC1967Proxy.sol:ERC1967Proxy", _ctorArgs(obsInterval), a);
        h = MoleHook(a);
    }

    /// @dev Run the deployment at a correctly-mined address WITHOUT the forge-std wrapper, so the
    ///      initializer's own revert data survives instead of being swallowed by a require() string.
    ///      This is what lets A-5 pin the exact error selector on a refused configuration.
    ///
    ///      Under the proxy build this runs the PROXY's constructor, which delegatecalls `initialize`.
    ///      OpenZeppelin bubbles the raw revert data from that delegatecall, so the selector still
    ///      arrives intact — and the address being checked is now the proxy's, which is the one that
    ///      actually matters since the PoolManager never sees the implementation.
    function _rawDeploy(uint256 seed, uint32 obsInterval) internal returns (bool ok, bytes memory ret, address at) {
        at = _hookAddr(seed);
        vm.etch(at, bytes.concat(vm.getCode("ERC1967Proxy.sol:ERC1967Proxy"), _ctorArgs(obsInterval)));
        (ok, ret) = at.call("");
    }

    function _newPool(MoleHook h, int24 spacing) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        _record(k); // pool is born at tick 0
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
        _record(k);
    }

    function _tick(PoolKey memory k) internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x < 0 ? uint256(-x) : uint256(x);
    }

    function _ringIndex(MoleHook h, PoolId id) internal view returns (uint16 idx) {
        (idx,,,,,) = h.poolStates(id);
    }

    /// @dev The observation `consult` would actually anchor on for a window of `secondsAgo`: the newest
    ///      ring entry at or before `now - secondsAgo`. Reconstructed from public storage, independently
    ///      of consult itself, so "the window is genuinely covered" can be asserted rather than assumed.
    ///      `nowTs` is passed in (callers hand it `_clock`) so this can never read a solc-cached
    ///      block.timestamp from before the caller's last warp.
    function _anchorTs(MoleHook h, PoolId id, uint32 nowTs, uint32 secondsAgo)
        internal
        view
        returns (uint32 ts, bool found)
    {
        uint32 target = nowTs - secondsAgo;
        uint16 i = _ringIndex(h, id);
        for (uint256 n = 0; n < 256; n++) {
            (uint32 ots,, bool init) = h.observations(id, i);
            if (!init) break;
            if (ots <= target) return (ots, true);
            i = i == 0 ? uint16(255) : i - 1;
        }
        return (0, false);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
    }

    /* ================================================================================
       A-1  THE ORACLE FREEZE  ->  BLOCKED (regression)

       The attack: `_write()` used to gate the ring push on

           uint32 elapsed = nowTs - s.lastTimestamp;      // s.lastTimestamp rewritten EVERY swap
           s.lastTimestamp = nowTs;                        // unconditional, outside the gate
           if (elapsed >= minObservationInterval) { push observation }

       i.e. the gap since the last SWAP, not since the last OBSERVATION. A pool whose swaps arrived closer
       together than minObservationInterval recorded NOTHING, forever — the busier the pool, the more
       completely the oracle was disabled. This test ran the exact freeze condition (a swap every 30s
       against a 60s interval, for four hours) and measured ZERO observations.

       The gate is now `sinceObs = nowTs - s.lastObsTimestamp`. Same four hours, same 480 swaps, same
       measurement: the ring must now advance on the OBSERVATION clock — 14400s / 60s = 240 writes. */

    function test_regression_A1_busyPoolRecordsOnTheObservationClock() public {
        MoleHook h = _deployHook(1, 60); // 60s "minimum seconds between oracle writes"
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        (uint16 i0,,,,,) = h.poolStates(id);
        assertEq(i0, 0, "sanity: ring starts at the seed");

        // Four hours of ordinary activity, one swap every 30 seconds. 30 < 60, always: this is the exact
        // cadence that used to freeze the oracle solid.
        for (uint256 i = 0; i < 480; i++) {
            _advance(30);
            _swap(k, i % 2 == 0, 1e13);
        }

        // NOTE: `_clock`, not block.timestamp — solc caches the TIMESTAMP opcode per call frame, so a
        // block.timestamp read after a later vm.warp in this same frame would be silently stale.
        assertEq(_clock - T0, 4 hours, "clock did not actually advance");

        (uint16 i1, uint32 lastSwapTs, uint32 lastObsTs,,,) = h.poolStates(id);
        console2.log("A-1: observations written in 4h / 480 swaps =", uint256(i1));

        // 4 hours / 60s. Not "more than zero" — the exact number the interval mandates.
        assertEq(uint256(i1), 240, "ring must advance once per observation interval");
        assertEq(uint256(lastSwapTs), _clock, "swap clock still tracks every swap");
        assertEq(uint256(lastObsTs), _clock, "observation clock is current");

        // Every slot from the seed to the head carries the timestamp its interval demands, and nothing
        // beyond the head was touched (240 < CARDINALITY, so the ring has not wrapped).
        for (uint16 s = 0; s <= 240; s++) {
            (uint32 ots,, bool init) = h.observations(id, s);
            assertTrue(init, "ring slot below the head is uninitialised");
            assertEq(uint256(ots), T0 + 60 * uint256(s), "observation landed off its interval");
        }
        for (uint16 s = 241; s < 248; s++) {
            (,, bool init) = h.observations(id, s);
            assertFalse(init, "ring wrote past its head");
        }

        // ... and the SSTORE is still time-gated: the two clocks are genuinely distinct, so a swap
        // inside the interval costs no ring write. (The freeze fix must not turn into a write per swap.)
        _advance(30);
        _swap(k, true, 1e13);
        (uint16 i2, uint32 swapTs2, uint32 obsTs2,,,) = h.poolStates(id);
        assertEq(uint256(i2), 240, "a swap inside the interval must not write");
        assertEq(uint256(swapTs2), _clock, "swap clock advanced");
        assertEq(uint256(obsTs2), _clock - 30, "observation clock did NOT advance");
    }

    /* ================================================================================
       A-2  THE FREEZE MADE consult() RETURN THE POOL-LIFETIME AVERAGE  ->  BLOCKED

       Previously: on the frozen pool the only observation was the seed, so consult(300) averaged over
       4h20m30s of pool life and reported a tick ~3900 above the truth — a "5-minute TWAP" pinned near a
       price the pool had not traded at for twenty straight minutes. Same path, same 300s read: it must
       now answer the window it was asked for.
       ================================================================================ */

    function test_regression_A2_consult300TracksTheTrue5MinuteMeanOnABusyPool() public {
        MoleHook h = _deployHook(2, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        // Phase A — four hours of normal trading at ~tick 0, swaps every 30s (the old freeze condition).
        for (uint256 i = 0; i < 480; i++) {
            _advance(30);
            _swap(k, i % 2 == 0, 1e13);
        }
        int24 calmTick = _tick(k);

        // Phase B — the price moves hard and STAYS there (a real repricing, or a manipulation held open).
        _advance(30);
        _swap(k, true, 2_000e18);
        int24 movedTick = _tick(k);
        assertLt(movedTick, calmTick - 3000, "the big swap did not actually move the price");

        // Phase C — 20 further minutes pinned at the new price, still one swap every 30s.
        for (uint256 i = 0; i < 40; i++) {
            _advance(30);
            _swap(k, i % 2 == 0, 1e13);
        }

        int24 reported = h.consult(id, 300);
        int256 truth = _trueMeanTick(k, 300);

        // The honest 5-minute mean is the moved price: nothing but the moved price happened in it.
        assertLt(truth, int256(calmTick) - 3000, "reference TWAP sanity");

        // The window is genuinely COVERED now: the entry consult anchors on sits at or just before
        // now-300, never four hours back at the seed.
        (uint32 anchorTs, bool found) = _anchorTs(h, id, uint32(_clock), 300);
        assertTrue(found, "no observation covers a 300s window");
        uint256 anchorAge = _clock - anchorTs;
        console2.log("A-2 requested window (s)      :", uint256(300));
        console2.log("A-2 EFFECTIVE window (s)      :", anchorAge);
        console2.log("A-2 true  5-min mean tick     :", truth);
        console2.log("A-2 consult(300) returned tick:", int256(reported));
        console2.log("A-2 error (ticks)             :", _abs(int256(reported) - truth));

        assertGe(anchorAge, 300, "anchor must not be inside the requested window");
        assertLe(anchorAge, 360, "anchor must be at most one interval older than the window start");

        // The headline, inverted: the "5-minute TWAP" was off by ~3900 ticks (tens of percent of price).
        // It must now be exact to within integer-division rounding.
        assertLe(_abs(int256(reported) - truth), 1, "consult(300) must equal the true 300s mean");

        // And it is no longer stale in the exploitable direction: it reports the price the pool has
        // actually been trading at for twenty minutes, not the pre-move one.
        assertLt(int256(reported), int256(calmTick) - 3000, "reported tick must follow the repricing");
        assertEq(int256(reported), int256(movedTick), "the whole window is at the moved price");
    }

    /* ================================================================================
       A-2b  ATTACKER AGENCY  ->  BLOCKED

       The attacker did not need the pool to be busy: they made it busy, with 0.0054 tokens of dust, and
       from that instant the TWAP window start was pinned wherever they chose — everything after was
       invisible to consult(). The dust is still spent here, swap for swap; it must now buy nothing.
       ================================================================================ */

    function test_regression_A2b_dustCannotFreezeTheOracleOrPinTheTwapWindow() public {
        MoleHook h = _deployHook(20, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        // --- the pool is healthy: sparse trading, observations accumulate normally.
        for (uint256 i = 0; i < 10; i++) {
            _advance(120);
            _swap(k, i % 2 == 0, 1e13);
        }
        (uint16 idxHealthy,,,,,) = h.poolStates(id);
        assertEq(uint256(idxHealthy), 10, "pool should be recording before the attack");

        // --- the attacker starts dust-swapping every 30s. Nothing else about the pool changes.
        uint256 dustNotional;
        for (uint256 i = 0; i < 480; i++) {
            _advance(30);
            _swap(k, i % 2 == 0, 1e13);
            dustNotional += 1e13;
        }
        (uint16 idxFrozen,,,,,) = h.poolStates(id);
        // 4h of dust at a 60s interval = 240 more writes. The ring does NOT stop when the pool gets busy.
        assertEq(uint256(idxFrozen), uint256(idxHealthy) + 240, "dust must not stop the ring advancing");

        // --- now the price genuinely reprices (crash / repeg / anything) and stays there.
        _advance(30);
        _swap(k, true, 2_000e18);
        uint256 repriceTs = _clock;
        int24 movedTick = _tick(k);
        for (uint256 i = 0; i < 60; i++) {
            _advance(30);
            _swap(k, i % 2 == 0, 1e13);
            dustNotional += 1e13;
        }

        // 30 more minutes of dust = 30 more writes; 250 + 30 = 280 wraps once around CARDINALITY 256.
        (uint16 idxAfter,,,,,) = h.poolStates(id);
        assertEq(uint256(idxAfter), 280 % 256, "the repricing window must be fully recorded");
        (uint32 headTs,, bool headInit) = h.observations(id, idxAfter);
        assertTrue(headInit, "ring head uninitialised");
        assertLe(_clock - headTs, 60, "the newest observation is older than one interval");
        assertGt(uint256(headTs), repriceTs, "no observation was written after the repricing");

        // A 30-minute TWAP is the canonical "manipulation-resistant" read, and the pool has been at the
        // new price for the full 30 minutes. It must now report exactly that.
        int24 reported = h.consult(id, 1800);
        int256 truth = _trueMeanTick(k, 1800);
        (uint32 anchorTs, bool found) = _anchorTs(h, id, uint32(_clock), 1800);

        console2.log("A-2b attacker dust notional   :", dustNotional);
        console2.log("A-2b anchor window start (ago):", _clock - anchorTs);
        console2.log("A-2b true  30-min mean tick   :", truth);
        console2.log("A-2b consult(1800) tick       :", int256(reported));
        console2.log("A-2b error (ticks)            :", _abs(int256(reported) - truth));

        assertEq(truth, int256(movedTick), "reference: the whole 30-min window is at the new price");
        assertTrue(found, "no observation covers a 1800s window");
        assertGe(_clock - anchorTs, 1800, "anchor must not be inside the requested window");
        assertLe(_clock - anchorTs, 1800 + 60, "anchor is at most one interval past the window");

        // Was: reported - truth > 5000 (the stale pre-attack price). The residual is now bounded by the
        // interpolation of the single 60s gap the repricing landed inside: the jump sits exactly halfway
        // into that gap, so the error is (30 * 6713) / 1800 == 56 ticks. It is set by the interval and
        // the size of the jump alone, and CANNOT grow with the length of the attack.
        assertLe(_abs(int256(reported) - truth), 60, "consult must report the repriced 30-min mean");

        // Attacker cost is dust: 540 swaps of 1e13 == 0.0054 tokens of notional total. Kept armed.
        assertLe(dustNotional, 1e16, "the freeze was bought with dust");

        // The same 540-swap campaign also used to be the cheapest way to walk the volatility surcharge,
        // which the attacker then collected out of third-party flow. That fee is gone, so the identical
        // campaign must now leave the quoted fee exactly where the deployment set it.
        assertEq(uint256(h.currentFee(id)), uint256(LP_FEE), "540 dust swaps moved the fee");
    }

    /* ================================================================================
       A-5b  RING EXHAUSTION BY ORDINARY VOLUME — no attacker, and STILL LIVE. CARDINALITY is a
             hardcoded 256 with no v3-style increaseObservationCardinalityNext, so the ring only ever
             covers 256 * (write cadence) seconds. This is now a pure ring-size limit rather than a
             configuration trap (A-1's fix means the interval alone sets the cadence), and it fails
             CLOSED — consult reverts rather than lying — but a pool trading every ~6s still cannot
             serve a 30-minute TWAP at a 5s interval.
       ================================================================================ */

    function test_A5b_organicVolumeExhaustsTheRingAndBricksThe30MinuteTwap() public {
        MoleHook h = _deployHook(21, 5); // 5s interval: the smallest setting that still covers 1800s
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        // Let the pool age so `now - 1800` is comfortably after pool creation.
        for (uint256 i = 0; i < 12; i++) {
            _advance(600);
            _swap(k, i % 2 == 0, 1e13);
        }
        h.consult(id, 1800); // healthy

        // Ordinary busy-market cadence: one swap every 6 seconds for ~25 minutes. Every swap writes
        // (6 >= 5), so 256 writes overwrite the entire ring inside the 30-minute window.
        for (uint256 i = 0; i < 260; i++) {
            _advance(6);
            _swap(k, i % 2 == 0, 1e13);
        }

        (uint32 oldestTs,,) = h.observations(id, uint16((uint256(_ringIndex(h, id)) + 1) % 256));
        console2.log("A-5b oldest observation age(s):", block.timestamp - oldestTs);

        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, 1800);
    }

    /* ================================================================================
       A-3  CONTROL: the SAME price path with swaps spaced ABOVE the interval reads correctly.
            This isolated the freeze's cause to swap cadence, not to the test, the clock, or the math.
            It passed before the fix and must keep passing after it — if this ever fails, the fix broke
            the ordinary, never-attacked case.
       ================================================================================ */

    function test_A3_controlSparsePoolReadsTheCorrectTwap() public {
        MoleHook h = _deployHook(3, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        // Phase A — four hours at ~tick 0, but one swap every 120s (> the 60s interval).
        for (uint256 i = 0; i < 120; i++) {
            _advance(120);
            _swap(k, i % 2 == 0, 1e13);
        }
        int24 calmTick = _tick(k);

        _advance(120);
        _swap(k, true, 2_000e18);
        assertLt(_tick(k), calmTick - 3000, "the big swap did not move the price");

        for (uint256 i = 0; i < 10; i++) {
            _advance(120);
            _swap(k, i % 2 == 0, 1e13);
        }

        (uint16 idx,,,,,) = h.poolStates(id);
        assertGt(idx, 100, "observations ARE written when swaps are sparser than the interval");

        int24 reported = h.consult(id, 300);
        int256 truth = _trueMeanTick(k, 300);
        console2.log("A-3 true  5-min mean tick     :", truth);
        console2.log("A-3 consult(300) returned tick:", int256(reported));
        assertLt(_abs(int256(reported) - truth), 50, "sparse pool: consult tracks the true 5-min mean");
    }

    /* ================================================================================
       A-4  WINDOW OVER-COVERAGE  ->  BLOCKED

       consult() used to skip interpolation entirely: it returned the mean over
       [newest observation <= target, now] and divided by that longer span, silently reporting it as the
       requested window. Measured here at a 12x understatement of a real move — a caller who asks for 300
       seconds and receives 62 minutes of smoothing is not protected by the bound it thinks it set.
       Identical setup; consult must now answer EXACTLY the 300 seconds asked for. */

    function test_regression_A4_consultAnswersExactlyTheRequestedWindow() public {
        MoleHook h = _deployHook(4, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        // One hour of calm, with a single swap at the start so an observation exists at ~T0.
        _advance(70);
        _swap(k, true, 1e13);
        _advance(3600);

        // A large move lands, and one minute later somebody asks for the 5-minute TWAP.
        _swap(k, true, 2_000e18);
        int24 moved = _tick(k);
        _advance(60);
        _swap(k, true, 1e13); // keeps price at `moved`

        int24 reported = h.consult(id, 300);
        int256 truth = _trueMeanTick(k, 300);

        // Truth: 60s at `moved` + 240s at ~0  => about moved/5.
        console2.log("A-4 moved tick                :", int256(moved));
        console2.log("A-4 true  5-min mean tick     :", truth);
        console2.log("A-4 consult(300) returned tick:", int256(reported));

        assertLt(truth, -1000, "reference: the 5-min mean should already be well below zero");

        // The anchor observation is still the one from an hour ago — the ring genuinely has nothing
        // closer — so this proves the INTERPOLATION, not a lucky choice of bracket.
        (uint32 anchorTs, bool found) = _anchorTs(h, id, uint32(_clock), 300);
        assertTrue(found, "no observation covers the window");
        assertGt(_clock - anchorTs, 3600, "the bracketing observation really is an hour old");

        // Was: reported > truth (damped toward the older window) with an understatement factor >= 5.
        // Exact equality with the independently reconstructed mean. The old understatement-RATIO check
        // that used to sit here was dead once this line existed — integer division of equal magnitudes is
        // always zero — so it asserted nothing. Exact equality is the strictly stronger claim, and the
        // non-triviality guard above (truth < -1000) is what stops it being satisfied by a flat series.
        assertEq(int256(reported), truth, "consult must return the true requested-window mean");
    }

    /* ================================================================================
       A-5  RING FLOOD -> consult() DoS  ->  BLOCKED AT TWO LAYERS

       The attack needed minObservationInterval == 0 — a legal, unguarded deploy value, and the natural
       "maximum accuracy" setting. Every swap then pushed an entry even when elapsed == 0, so 256 dust
       swaps in ONE block overwrote the whole ring with entries stamped `now` and every consult() with a
       window shorter than the flood age reverted, indefinitely, for the price of gas.

       Layer 1: the constructor now REFUSES interval 0, so that deployment cannot exist.
       Layer 2: at interval == 1, the tightest legal config, the ring write is gated on time since the
       last OBSERVATION — so an unlimited number of swaps inside one block can write at most one entry.
       Both are asserted below, with the flood itself unchanged: 256 real dust swaps, one block.

       CHANGED SHAPE. This test used to pin a SECOND refused configuration, `volWindow == 0`, alongside
       the interval. `volWindow` was a parameter of the volatility-scaled fee, which has been removed from
       MoleHook entirely, so that clause has no subject and is deleted rather than faked. The deletion is
       narrow on purpose: `volWindow` was never what this attack needed — `minObservationInterval == 0` is,
       and that guard, its selector, and the whole flood below are untouched.

       ADDED. The flood now also asserts the FEE cannot be moved by it. 256 dust swaps in one block is
       exactly the machine that walked the old volatility surcharge to its ceiling before collecting it
       from third-party flow; with the fee reduced to an immutable, the same machine must buy nothing on
       that path either, and this line fails the moment a fee is re-derived from swap-driven state. */

    function test_regression_A5_zeroIntervalRefusedAndOneBlockFloodCannotRollTheRing() public {
        // ---- layer 1: the configuration the attack required cannot be deployed at all.
        (bool ok0, bytes memory ret0,) = _rawDeploy(50, 0);
        assertFalse(ok0, "minObservationInterval == 0 must not deploy");
        assertEq(ret0, abi.encodeWithSelector(MoleHook.BadFeeBounds.selector), "wrong error for interval 0");

        // Control: the neighbouring legal configuration deploys and keeps the value it was given, so the
        // revert above is the guard firing and not a broken deployment harness.
        (bool okG, bytes memory retG, address atG) = _rawDeploy(52, 1);
        assertTrue(okG, "interval == 1 must be deployable");
        vm.etch(atG, retG);
        assertEq(uint256(MoleHook(atG).minObservationInterval()), 1, "interval not stored");

        // ---- layer 2: run the flood at the tightest interval that IS legal.
        MoleHook h = _deployHook(5, 1);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        _advance(3600);
        _swap(k, true, 1e13);
        h.consult(id, 300); // works before the flood
        (uint16 idxBefore,,,,,) = h.poolStates(id);
        assertEq(uint256(idxBefore), 1, "the aged swap wrote exactly one observation");

        // One block. No time passes. 256 dust swaps.
        uint256 tsBefore = _clock;
        uint24 feeBefore = h.currentFee(id);
        assertEq(uint256(feeBefore), uint256(LP_FEE), "pool did not open at the configured fee");
        for (uint256 i = 0; i < 256; i++) {
            _swap(k, i % 2 == 0, 1e12);
        }
        assertEq(_clock, tsBefore, "flood must happen inside one block");

        (uint16 idx,,,,,) = h.poolStates(id);
        console2.log("A-5 ring index after flood    :", uint256(idx));
        assertEq(uint256(idx), uint256(idxBefore), "256 swaps in one block wrote a ring entry");

        // The flood cannot move the FEE either — there is no longer any swap-derived state for it to
        // move. Asserted against the constant, not against `feeBefore`, so this cannot pass by both
        // readings drifting together.
        assertEq(uint256(h.currentFee(id)), uint256(LP_FEE), "a 256-swap one-block flood moved the fee");

        // The ring still holds its history: the seed is untouched and nothing carries the flood stamp
        // beyond the single pre-flood entry.
        (uint32 seedTs,, bool seedInit) = h.observations(id, 0);
        assertTrue(seedInit, "seed missing");
        assertEq(uint256(seedTs), T0, "the flood overwrote the seed observation");
        for (uint16 s = 2; s < 256; s++) {
            (,, bool init) = h.observations(id, s);
            assertFalse(init, "the flood wrote into the ring");
        }

        // Every window the attack used to brick still answers.
        h.consult(id, 300);
        h.consult(id, 1800);
        h.consult(id, 1 hours);

        // And re-flooding every block does not roll the ring either: one block, one entry, by construction.
        for (uint256 b = 0; b < 3; b++) {
            _advance(12);
            for (uint256 i = 0; i < 256; i++) {
                _swap(k, i % 2 == 0, 1e12);
            }
        }
        (uint16 idxEnd,,,,,) = h.poolStates(id);
        assertEq(uint256(idxEnd), uint256(idxBefore) + 3, "sustained flooding wrote more than one entry per block");
        h.consult(id, 1800);
    }

    /* ================================================================================
       A-6  uint32 TIMESTAMP ROLLOVER (Feb 2106)  ->  BLOCKED

       `elapsed = nowTs - s.lastTimestamp` used to be a CHECKED uint32 subtraction. v3 does this unchecked
       precisely because it must wrap. The first swap after the rollover panicked inside afterSwap and the
       pool's swap path was dead permanently. Same warp past 2**32; the swap must now go through, the
       oracle must fail CLOSED across the discontinuity rather than answer from pre-rollover timestamps,
       and it must heal itself within one interval.
       ================================================================================ */

    function test_regression_A6_uint32RolloverDoesNotBrickSwaps() public {
        MoleHook h = _deployHook(6, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        _advance(120);
        _swap(k, true, 1e15);
        h.consult(id, 60);
        (uint16 idxBefore,,,,,) = h.poolStates(id);

        // Cross 2**32 seconds (2106-02-07). uint32(block.timestamp) wraps to a small number while
        // s.lastTimestamp is still ~1.75e9 — the subtraction that used to panic.
        _clock = uint256(type(uint32).max) + 1 + 100;
        vm.warp(_clock);
        assertEq(uint256(uint32(block.timestamp)), 100, "the clock did not actually roll over");

        // THE SWAP GOES THROUGH. No expectRevert: the assertion is that this call simply succeeds.
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -1e15, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        _record(k);

        (uint16 idxAfter, uint32 lastSwapTs, uint32 lastObsTs,,,) = h.poolStates(id);
        assertEq(uint256(lastSwapTs), 100, "the post-rollover swap did not update the swap clock");
        assertEq(uint256(lastObsTs), 100, "the post-rollover swap did not update the observation clock");
        assertEq(uint256(idxAfter), uint256(idxBefore) + 1, "the rollover swap wrote no observation");

        // The oracle FAILS CLOSED across the discontinuity: every ring entry older than the rollover
        // carries a ~1.75e9 stamp that is *newer* than any post-rollover target, so no bracket exists
        // and consult refuses with its own error instead of inventing a mean out of wrapped arithmetic.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, 60);

        // ... and it heals: once two post-rollover observations bracket the window, reads resume and are
        // exact, built only from post-rollover entries.
        int24 pinned = _tick(k);
        _advance(120);
        _swap(k, true, 1e13);
        assertEq(_tick(k), pinned, "dust moved the tick; this check needs a pinned price");
        assertEq(h.consult(id, 60), pinned, "oracle did not recover after the rollover");

        // Removing liquidity still works: the remove bits are unmined, so no hook state can trap it.
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -1_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    /* ================================================================================
       A-7  TEST-INTEGRITY  ->  FIXED AT THE SOURCE

       MoleHook.t.sol's `test_consultRevertsWhenTheWindowIsNotCovered` pins
       InsufficientObservations, but the shipped suite runs at block.timestamp == 1, where
       `target = nowTs - secondsAgo` underflowed before any oracle logic executed — so the test passed on
       a Panic and proved nothing about the backward scan. consult() now carries an explicit
       `secondsAgo > nowTs` guard that returns its OWN error. The same two timestamps are checked here:
       both must produce the selector, so that shipped test can no longer be green for the wrong reason.
       ================================================================================ */

    function test_regression_A7_overlongWindowRevertsWithTheGuardNotAPanic() public {
        MoleHook h = _deployHook(7, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        _advance(600);
        _swap(k, true, 1e15); // a real, recent observation to walk back from

        // At a realistic timestamp: the backward scan runs out of observations and the guard fires.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, 365 days);

        // Rewind the chain clock to the local-test default of 1, as the shipped suite runs. This is the
        // case that used to die on an arithmetic Panic; expectRevert(selector) accepts ONLY the guard's
        // own error, so a Panic here would fail this test.
        vm.warp(1);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, 365 days);

        // The neighbouring guards on the same path, also by selector rather than by bare revert.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, 0);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, 2); // nowTs == 1, so a 2-second window is still over-long
    }

    /* ================================================================================
       A-8  NEGATIVE CONTROLS — things I tried that are NOT broken. These must keep passing;
            if one starts failing, the fix for A-1/A-4 broke something real.
       ================================================================================ */

    /// @dev Single-block manipulation cannot move consult(): after the manipulating swap,
    ///      nowTs == s.lastTimestamp, so cumNow carries zero seconds of the new tick.
    function test_A8_singleBlockSpotManipulationDoesNotMoveTheTwap() public {
        MoleHook h = _deployHook(8, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        for (uint256 i = 0; i < 20; i++) {
            _advance(120);
            _swap(k, i % 2 == 0, 1e13);
        }
        int24 before = h.consult(id, 600);

        // Same block: slam the price, read the TWAP, unwind.
        _swap(k, true, 2_000e18);
        int24 during = h.consult(id, 600);
        assertEq(during, before, "a same-block spot slam moved the TWAP");
    }

    /// @dev The cumulative itself is exact for negative ticks — no sign error in the int56 extension.
    function test_A8_cumulativeIsExactAcrossNegativeTicks() public {
        MoleHook h = _deployHook(9, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        _advance(120);
        _swap(k, true, 2_000e18); // deep negative tick
        int24 t = _tick(k);
        assertLt(t, -3000, "expected a negative tick");

        _advance(600);
        _swap(k, true, 1e13);

        (,,,, int56 cum,) = h.poolStates(id);
        // 120s at tick 0 then 600s at tick t.
        assertEq(int256(cum), int256(t) * 600, "int56 extension is wrong for negative ticks");
        assertEq(h.consult(id, 300), t, "consult over a pinned negative tick is wrong");
    }

    /// @dev Ring wraparound past CARDINALITY is handled: consult keeps working, and windows older
    ///      than the ring can hold correctly revert instead of silently returning garbage.
    function test_A8_ringWraparoundStillReadsAndCorrectlyRefusesTooOld() public {
        MoleHook h = _deployHook(10, 60);
        PoolKey memory k = _newPool(h, 60);
        PoolId id = k.toId();

        // 300 writes at 61s apart -> the ring wraps and the seed is overwritten.
        for (uint256 i = 0; i < 300; i++) {
            _advance(61);
            _swap(k, i % 2 == 0, 1e13);
        }
        (uint16 idx,,,,,) = h.poolStates(id);
        assertEq(uint256(idx), 300 % 256, "ring did not wrap as expected");

        h.consult(id, 600); // recent window still readable
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(id, uint32(299 * 61)); // older than the ring can cover -> refuses, as documented
    }
}
