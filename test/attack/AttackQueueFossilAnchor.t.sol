// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice THE QUIET POOL: a batch that nobody may cancel, crossing at a price nobody has quoted for days.
///
/// WHAT WAS TRUE BEFORE THIS FILE EXISTED, and it was proven on a fork of live RH mainnet:
///
///   1. `MoleHook.consult()` takes its QUIET-TAIL path whenever the window lies wholly after the last swap
///      and returns EXACTLY `lastTick`. That is CORRECT — with the tick constant across the window,
///      `lastTick` IS the arithmetic mean — and this file does not touch it.
///
///   2. But MoleQueue's settlement has THREE price guards and on a quiet pool all three resolve to that
///      one number: `consult(twapWindow)`, `consult(shortTwapWindow)` and `slot0.tick` are IDENTICAL, so
///      the short-vs-long drift check and the spot-vs-long check both compute ZERO BY CONSTRUCTION and
///      cannot fire however old the price is. Three guards reading one number is one guard wearing three
///      hats. `test_theThreeSettlementGuardsCollapseToOneNumberOnAQuietPool` pins that, permanently,
///      because it is the premise everything else here rests on.
///
///   3. That left `maxOracleStaleness` alone — and it read `poolStates(id).lastObsTimestamp`, the last
///      RING WRITE, which `MoleHook._write` stamps on ANY swap past `minObservationInterval` regardless of
///      size and regardless of whether the tick moved. ONE RAW UNIT reset it to zero while the cumulative
///      that same swap recorded advanced by `elapsed * lastTick` — carrying the fossil tick forward and
///      adding nothing. The last standing guard was a heartbeat the attacker restarted from inside the
///      settling transaction.
///
/// THE ATTACK: queue on the side the fossil price favours; wait for the freeze, after which nobody can
/// cancel BY DESIGN; then in ONE transaction swap one raw unit and call `settle` (it is permissionless).
/// Every guard passes. If the fossil never favours the attacker they simply never settle — the epoch times
/// out and they reclaim in kind at zero cost. A free option on the whole batch, exercised after seeing the
/// market. The depth guard is no obstacle: `restrictedLiquidity` is FALSE on the live RH hook, so the
/// attacker mints the required liquidity at the target tick themselves — which is why this world is built
/// with `restrictedLiquidity` false, exactly as RH 4663 holds it.
///
/// WHAT THE FIX ACTUALLY BUYS, STATED HERE SO NOBODY READS MORE INTO IT. `maxOracleStaleness` is now
/// measured against `MoleHook.consultEvidence(...).quietSpan` — the widest stretch of time the anchor rests
/// on in which the pool recorded NOTHING, across the window and across the bracket its left edge was
/// interpolated over, unclipped. A dust swap adds one recorded point and leaves the emptiness behind it
/// untouched. It proves trades HAPPENED; it cannot prove they were arm's length, and a party willing to
/// wash-trade its own pool on a schedule still manufactures a passing reading. See
/// `test_aScheduledWashTradeStillManufacturesAPassingAnchor`, which is a FAILURE pinned as a test rather
/// than a defence: closing it needs a price this pool does not produce.
///
/// EVERY SCHEDULE NUMBER BELOW IS THE LIVE RH 4663 QUEUE's, read from proxy
/// 0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd on 2026-08-24.
contract AttackQueueFossilAnchor is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------ THE LIVE RH 4663 SCHEDULE, verbatim */

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant FREEZE_DURATION = 60;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;

    /// @dev The live queue's EXPLICITLY SET staleness dial (it is not on the derived default): 3,600 s.
    uint32 internal constant LIVE_STALENESS = 3600;
    /// @dev The live queue's explicitly set depth floor and short window, so nothing else can refuse first.
    uint32 internal constant LIVE_SHORT_WINDOW = 60;
    int24 internal constant LIVE_JUMP = 1200;
    uint128 internal constant LIVE_MIN_LIQUIDITY = 1;

    /// @dev The live WETH/USDG pool's newest observation on 2026-08-24 was 381,696 s old — 4.4 days. This
    ///      is that, rounded to whole days, so the fossil under test is the fossil that exists.
    uint256 internal constant FOSSIL_AGE = 4 days;

    uint256 internal constant T0 = 1_750_000_000;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    MoleHook internal hook;
    MoleQueue internal queue;
    PoolKey internal qKey;

    uint256 internal _clock;
    uint256 internal _height;

    /* ------------------------------------------------------------------ harness */

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-fossil-anchor", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev Sizes here are tiny against 200,000e18 of liquidity, so no warm-up or dust swap can walk the
    ///      tick off zero. Every refusal below is therefore attributable to the freshness measurement and
    ///      never to the deviation band.
    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            qKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev THE ATTACKER'S WHOLE COST, on the shipped LP fee: one raw unit of currency0.
    function _dustSwap() internal {
        vm.prank(mallory);
        _swap(true, 1);
    }

    function _warm() internal {
        _advance(90);
        _swap(true, 1e16);
        _advance(90);
        _swap(false, 1e16);
        _advance(90);
        _swap(true, 1e16);
    }

    /// @dev A history LONGER THAN THE WINDOW and evenly covered, which is what an ordinary pool looks
    ///      like. `_warm` alone leaves the 1,800 s window reaching back past the pool's own birth, where
    ///      `consult` fails closed for a different and entirely correct reason.
    function _warmAcrossTheWholeWindow() internal {
        for (uint256 i = 0; i < 13; i++) {
            _advance(200);
            _swap(i % 2 == 0, 1e16);
        }
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(who, 1_000_000e18);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(queue), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(queue), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev A batch that crosses EXACTLY, so settlement never touches the pool and any refusal can only
    ///      have come from a guard rather than from the residual leg.
    function _placeAPerfectlyCrossingBatch() internal {
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(bob);
        queue.place(false, 100e18);
    }

    function _deployQueue() internal {
        queue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            qKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
        // The LIVE dials, so no derived default can be the thing that refuses.
        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(LIVE_SHORT_WINDOW, LIVE_STALENESS, LIVE_JUMP, LIVE_MIN_LIQUIDITY);
        _fund(alice);
        _fund(bob);
        _fund(mallory);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        address a = _hookAddr(1);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            // restrictedLiquidity FALSE, exactly as the live RH hook holds it: anyone may mint the depth
            // the settlement guard asks for, so the depth floor is not a barrier to this attack.
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        qKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(qKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            qKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );
    }

    /* ================================================================================
       1. THE PREMISE: ON A QUIET POOL THERE IS ONLY ONE NUMBER.
       ============================================================================= */

    /// @notice THE THREE PRICE GUARDS ARE ONE GUARD ON A QUIET POOL, and this is the measurement that says
    ///         so rather than an argument that it must be. `consult` at the long window, `consult` at the
    ///         short window and `slot0.tick` all return the SAME int24, so both drift subtractions are
    ///         `x - x` and neither can ever fire. Everything else in this file is a consequence.
    ///
    ///         This is deliberately NOT a claim that `consult` is wrong — with the tick constant across the
    ///         window `lastTick` is the true arithmetic mean, and the assertion below that the two windows
    ///         agree is that correctness, seen from the guard's side.
    ///
    ///         MUTATION: none — this test asserts a property of `MoleHook.consult` that the lane
    ///         deliberately did not change. It is the tripwire on the PREMISE: if a future edit makes the
    ///         quiet-tail path stop returning `lastTick`, the reasoning in `_requireAnchorIsFresh` needs
    ///         revisiting and this goes red first.
    function test_theThreeSettlementGuardsCollapseToOneNumberOnAQuietPool() public {
        _warm();
        _advance(FOSSIL_AGE);
        PoolId id = qKey.toId();

        int24 long_ = hook.consult(id, TWAP_WINDOW);
        int24 short_ = hook.consult(id, LIVE_SHORT_WINDOW);
        (, int24 spot,,) = StateLibrary.getSlot0(manager, id);

        assertEq(long_, short_, "premise broken: the two TWAP windows no longer agree on a quiet pool");
        assertEq(long_, spot, "premise broken: spot no longer equals the TWAP on a quiet pool");

        // And the same statement from the oracle's own mouth: it took the tail path, so the window
        // contained no trade at all and every window is the same single tick.
        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(id, TWAP_WINDOW);
        assertTrue(extrapolated, "the tail path was not reported as the tail path");
        (, uint32 lastSwapTs,,,,) = hook.poolStates(id);
        assertEq(
            uint256(quietSpan),
            block.timestamp - uint256(lastSwapTs),
            "the tail path's dead air is the time since the last swap, and nothing else"
        );
        assertGt(uint256(quietSpan), uint256(LIVE_STALENESS), "premise: this pool must read as a fossil");
    }

    /* ================================================================================
       2. THE ATTACK, AND THE ONE LINE THAT NOW REFUSES IT.
       ============================================================================= */

    /// @notice ONE RAW UNIT USED TO BUY THE WHOLE BATCH. The pool is a 4-day fossil; a batch is placed,
    ///         frozen (so nobody can cancel) and reaches its settlement window; then mallory swaps ONE RAW
    ///         UNIT of currency0 and calls `settle` — the shape that worked, in the order it worked.
    ///
    ///         The test asserts BOTH halves, and the first half is what stops it being vacuous:
    ///           - the dust swap really does reset the OLD instrument. `now - lastObsTimestamp` reads ZERO
    ///             afterwards, comfortably inside the live 3,600 s bound, so the pre-fix guard would have
    ///             waved this settlement through. That is asserted arithmetically, not asserted about.
    ///           - the NEW instrument is untouched by it: `quietSpan` still reports the four-day hole the
    ///             anchor is drawn across, and `settle` refuses `OracleTooStale`.
    ///
    ///         Nobody loses anything in the refusal: the epoch times out and every deposit comes back in
    ///         kind, which the tail of this test proves by taking that exit.
    ///
    ///         MUTATION: point the guard back at `lastObsTimestamp` (or delete the `quietSpan` check in
    ///         `_requireAnchorIsFresh`) -> settle SUCCEEDS -> RED. Delete the bracket-span line in
    ///         `MoleHook.consultEvidence` (`if (gap > quietSpan) quietSpan = gap;` in the terminating
    ///         branch) -> quietSpan collapses to the tail, which the dust swap zeroed -> RED.
    function test_aDustSwapCannotRestartTheFreshnessClockOnAFossilAnchor() public {
        _warm();
        _advance(FOSSIL_AGE);
        _deployQueue();
        _placeAPerfectlyCrossingBatch();

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);

        PoolId id = qKey.toId();

        // THE DUST SWAP. One raw unit, in the block the settlement would happen in.
        _dustSwap();

        // HALF ONE: the old instrument is now perfectly, uselessly fresh.
        (,, uint32 lastObsTs,,,) = hook.poolStates(id);
        assertEq(uint256(lastObsTs), block.timestamp, "premise: the dust swap did not write the ring");
        assertLe(
            block.timestamp - uint256(lastObsTs),
            queue.effectiveMaxOracleStaleness(),
            "premise: the pre-fix staleness measurement must PASS here, or this test proves nothing"
        );

        // HALF TWO: the new instrument sees straight through it.
        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(id, TWAP_WINDOW);
        assertFalse(extrapolated, "premise: the dust swap put the last swap inside the window");
        assertGt(
            uint256(quietSpan),
            queue.effectiveMaxOracleStaleness(),
            "the dead air behind the anchor was not measured"
        );

        vm.prank(mallory);
        vm.expectRevert(MoleQueue.OracleTooStale.selector);
        queue.settle(0);

        // AND THE REFUSAL COSTS THE HONEST PARTICIPANTS NOTHING. The epoch times out and both sides take
        // back exactly what they escrowed, in kind, with no price applied.
        _advance(uint256(MAX_EPOCH_LIFE) + uint256(FREEZE_DURATION));
        queue.timeout(0);
        uint256 aBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        vm.prank(alice);
        queue.claim(0, 0);
        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(alice) - aBefore,
            100e18,
            "the refused batch did not return the escrow in kind"
        );
    }

    /// @notice THE SAME REFUSAL WITHOUT THE DUST SWAP, so the two halves of the measurement are separable.
    ///         A plain fossil takes `consult`'s quiet-tail path, `quietSpan` is the tail itself, and the
    ///         bound refuses.
    ///
    ///         MUTATION: delete the tail seed in `MoleHook.consultEvidence`
    ///         (`quietSpan = nowTs - s.lastTimestamp`, i.e. start it at zero) -> the tail path reports no
    ///         dead air at all -> settle SUCCEEDS -> RED.
    function test_anUntouchedFossilIsRefusedOnTheTailPathAlone() public {
        _warm();
        _advance(FOSSIL_AGE);
        _deployQueue();
        _placeAPerfectlyCrossingBatch();

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);

        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(qKey.toId(), TWAP_WINDOW);
        assertTrue(extrapolated, "premise: an untouched fossil answers on the tail path");
        assertGt(uint256(quietSpan), uint256(LIVE_STALENESS), "the tail was not measured as dead air");

        vm.expectRevert(MoleQueue.OracleTooStale.selector);
        queue.settle(0);
    }

    /* ================================================================================
       3. DEAD AIR IN THE MIDDLE OF THE WINDOW COUNTS TOO.
       ============================================================================= */

    /// @notice A SILENCE WITH RECORDED EDGES IS STILL A SILENCE. Here the window's left edge is bracketed
    ///         TIGHTLY (150 s) and the pool traded again shortly before settlement, so neither the bracket
    ///         span nor the tail is anywhere near the bound — but between those two there is a 1,300 s
    ///         stretch in which nothing happened, and it sits wholly INSIDE the window. Both of its ends
    ///         being recorded does not make the silence between them informative; it only makes it
    ///         measurable.
    ///
    ///         Two arms, because a refusal on its own could be any guard: at a 900 s bound the batch is
    ///         refused, and at a 1,500 s bound — nothing else changed, same block, same anchor — it
    ///         settles. So the 1,300 s interior gap is provably the only thing that spoke.
    ///
    ///         MUTATION: delete the interior-gap line in `MoleHook.consultEvidence`'s loop body
    ///         (`if (gap > quietSpan) quietSpan = gap;` before `haveNewer = true`) -> the 1,300 s hole
    ///         disappears from the reading, the 900 s arm settles -> RED.
    function test_deadAirInsideTheWindowCountsEvenWhenBothItsEdgesAreRecorded() public {
        _warm();
        _advance(600);
        _deployQueue();
        _placeAPerfectlyCrossingBatch();

        // The schedule, relative to the epoch start S. Everything is chosen so that ONLY the middle gap
        // can breach a 900 s bound.
        _advance(100);
        _swap(true, 1e16); // S+100   ring write
        _advance(150);
        _swap(false, 1e16); // S+250   ring write   -> left bracket is [S+100, S+250], span 150
        _advance(150);
        queue.freeze(); // S+400   past EPOCH_DURATION, no swap
        _advance(1150);
        _swap(true, 1e16); // S+1550  ring write    -> THE HOLE: S+250 .. S+1550 == 1,300 s
        _advance(400);
        _swap(false, 1e16); // S+1950  ring write   -> 400 s
        _advance(60); // S+2010  the settlement block, tail 60 s

        PoolId id = qKey.toId();
        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(id, TWAP_WINDOW);
        assertFalse(extrapolated, "premise: this pool traded inside the window");
        assertEq(uint256(quietSpan), 1300, "the interior hole was not the widest stretch, or was not seen");

        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(LIVE_SHORT_WINDOW, 900, LIVE_JUMP, LIVE_MIN_LIQUIDITY);
        vm.expectRevert(MoleQueue.OracleTooStale.selector);
        queue.settle(0);

        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(LIVE_SHORT_WINDOW, 1500, LIVE_JUMP, LIVE_MIN_LIQUIDITY);
        queue.settle(0);
        assertEq(
            uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "only the bound changed and it still refused"
        );
    }

    /* ================================================================================
       4. NON-VACUITY: A POOL THAT ACTUALLY TRADES STILL SETTLES.
       ============================================================================= */

    /// @notice THE GUARD MUST NOT BE A BRICK. A pool trading steadily across the whole window settles its
    ///         batch on the LIVE dials with nothing widened and nothing waived. Without this, "refuses a
    ///         fossil" would be indistinguishable from "refuses everything", which is the failure mode a
    ///         fail-closed guard actually has.
    ///
    ///         MUTATION: make `effectiveMaxOracleStaleness` return 0, or make `consultEvidence` return
    ///         `type(uint32).max` -> RED.
    function test_aPoolThatTradesThroughTheWindowStillSettlesOnTheLiveDials() public {
        _warmAcrossTheWholeWindow();
        _deployQueue();
        _placeAPerfectlyCrossingBatch();

        // Trade every 100 s straight through the epoch, the freeze and the settlement wait.
        for (uint256 i = 0; i < 3; i++) {
            _advance(100);
            _swap(i % 2 == 0, 1e16);
        }
        queue.freeze();
        for (uint256 i = 0; i < 3; i++) {
            _advance(100);
            _swap(i % 2 == 0, 1e16);
        }

        (uint32 quietSpan,) = hook.consultEvidence(qKey.toId(), TWAP_WINDOW);
        assertLe(uint256(quietSpan), uint256(LIVE_STALENESS), "a steadily trading pool read as stale");

        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "a live pool could not settle");
    }

    /* ================================================================================
       5. THE RESIDUAL, PINNED AS A TEST RATHER THAN CLAIMED AS A DEFENCE.
       ============================================================================= */

    /// @notice THIS DOES NOT CLOSE THE HOLE — IT PRICES IT, AND HERE IS THE PRICE. `quietSpan` proves that
    ///         trades HAPPENED. Nothing reachable from inside this pool can prove they were arm's length.
    ///         mallory keeps her own fossil pool "warm" with a one-raw-unit swap every 1,500 s — well
    ///         inside the live 3,600 s bound — against liquidity she is free to mint herself, since
    ///         `restrictedLiquidity` is FALSE on the live hook. The tick never moves off the fossil. Every
    ///         guard passes and the batch clears.
    ///
    ///         THIS TEST ASSERTS THE ATTACK STILL WORKS. It is here so that nobody reads the fix as a
    ///         closure, and so that if a later change DOES close it, this goes red and somebody has to
    ///         come and read this comment. What changed is the SHAPE of the cost: from one byte appended
    ///         to the exploit transaction — free, atomic and invisible until it landed — to a public
    ///         commitment maintained across blocks for the whole life of the window, which a counterparty
    ///         can watch and which the operator can make arbitrarily expensive by tightening
    ///         `maxOracleStaleness`.
    ///
    ///         THE ACTUAL FIX IS AN INDEPENDENT PRICE SOURCE. Every number reachable from here derives
    ///         from the same tick, so no arrangement of them can corroborate that tick. A pool nobody
    ///         trades has no honest price and no in-pool guard invents one.
    function test_aScheduledWashTradeStillManufacturesAPassingAnchor() public {
        _warm();
        _advance(FOSSIL_AGE);
        _deployQueue();

        int24 fossil = hook.consult(qKey.toId(), TWAP_WINDOW);
        _placeAPerfectlyCrossingBatch();

        // The heartbeat: one raw unit every 1,500 s, inside the live 3,600 s bound, sustained from before
        // the epoch opened until the settlement block. Nothing else — the tick never moves.
        //
        // NOTE WHAT THIS COSTS HER, because it is the only thing the fix actually charges: the heartbeat
        // must reach back PAST THE WINDOW'S LEFT EDGE, not merely be recent. A heartbeat started after the
        // freeze leaves the left edge still bracketed against the fossil and `settle` refuses; she has to
        // have been maintaining the pool for longer than `twapWindow` before the batch she wants to take.
        _advance(150);
        _dustSwap();
        _advance(150);
        queue.freeze();
        for (uint256 i = 0; i < 4; i++) {
            _advance(1500);
            _dustSwap();
        }
        _advance(50);

        PoolId id = qKey.toId();
        (uint32 quietSpan,) = hook.consultEvidence(id, TWAP_WINDOW);
        assertLe(uint256(quietSpan), uint256(LIVE_STALENESS), "the manufactured heartbeat did not pass the bound");
        assertEq(hook.consult(id, TWAP_WINDOW), fossil, "the tick moved, so this is no longer the fossil price");

        vm.prank(mallory);
        queue.settle(0);
        assertEq(
            uint8(queue.phaseOf(0)),
            uint8(MoleQueue.Phase.Settled),
            "the residual closed by accident -- read this test's comment before deleting it"
        );
    }

    /* ================================================================================
       6. THE EVIDENCE VIEW SPEAKS IN THE SAME VOICE AS THE ANSWER IT DESCRIBES.
       ============================================================================= */

    /// @notice `consultEvidence` MUST REFUSE EXACTLY WHERE `consult` REFUSES, or a caller could get an
    ///         evidence reading for an answer that does not exist and treat the pair as consistent.
    ///
    ///         MUTATION: drop any of the three refusals from `consultEvidence` -> the matching arm goes
    ///         RED naming the error that stopped being thrown.
    function test_consultEvidenceRefusesWhereverConsultRefuses() public {
        _warm();
        PoolId id = qKey.toId();

        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(id, 0);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consultEvidence(id, 0);

        uint32 tooLong = uint32(block.timestamp) + 1;
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(id, tooLong);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consultEvidence(id, tooLong);

        PoolId unseeded = PoolId.wrap(keccak256("no such pool"));
        vm.expectRevert(MoleHook.PoolNotInitialized.selector);
        hook.consult(unseeded, TWAP_WINDOW);
        vm.expectRevert(MoleHook.PoolNotInitialized.selector);
        hook.consultEvidence(unseeded, TWAP_WINDOW);
    }
}
