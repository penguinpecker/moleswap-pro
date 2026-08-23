// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @dev Freezes an epoch and settles it inside ONE transaction. The whole point of the freeze window is
///      that this composition must be impossible; the only way to prove it is to build it.
contract FreezeThenSettle {
    function run(MoleQueue q, uint64 e) external {
        q.freeze();
        q.settle(e);
    }
}

/// @notice ATTACKING THE TWO TIME GATES BETWEEN A FROZEN EPOCH AND ITS RESOLUTION.
///
/// The queue has three clocks and they were wired to two anchors, which is one anchor too few:
///
///   THE CUTOFF (`frozenAt`) is the moment the epoch stopped accepting orders. It is stamped by `freeze()`
///   as `epochStartedAt + epochDuration` — the SCHEDULED time, deliberately backdated, because `freeze()`
///   is permissionless and unincentivised and stamping the button press let a late press extend how long
///   escrow could be held. That is 17.4 and it stays.
///
///   THE SETTLEMENT DELAY was measured from that same backdated cutoff — and that is the defect. The
///   enforced wait was `max(0, freezeDuration − lateness)`, so on a quiet queue, where a late freeze is
///   the DEFAULT because nobody is paid to press it, there was often no wait at all: `freeze(e)` and
///   `settle(e)` fit in one transaction, and the settler picked the exact block — and therefore the exact
///   spot price and the exact residual execution — the whole batch was measured against. That is the
///   precise ability the window exists to deny. It now runs from the press.
///
///   THE ESCAPE HATCH (`timeout`) unlocked at `frozenAt + maxEpochLife` — the SAME instant as the lenient
///   settle. The set of moments at which the deadline-gated fallback could run and `timeout` could not was
///   EMPTY, so the fallback had zero exclusive width and anyone who disliked the cross could veto a
///   settleable batch by calling the cheaper `timeout` first. Both are external, permissionless and
///   require no stake, and neither transition can follow the other, so it was strictly first-come-wins —
///   decided, on a single-sequencer chain with no public mempool, by whoever holds the ordering privilege
///   rather than by entitlement. The frozen branch now opens one `freezeDuration` later.
///
/// WHAT IS AND IS NOT CLOSED, stated here so nobody has to infer it: giving the fallback a window DEFERS
/// the race, it does not remove it — if no settler acts inside the window both doors are open again from
/// the same state. And leniency is still anchored on the cutoff, so a freeze pressed later than
/// `cutoff + maxEpochLife − freezeDuration` still arrives with the lenient path already armed. Both are
/// pinned below rather than left to a reader's optimism.
///
/// TIME. `vm.warp(block.timestamp + d)` does NOT accumulate inside one call frame — solc caches
/// block.timestamp — so everything here moves an explicit `_clock` / `_height`.
contract AttackQueueSettlementClock is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------ config */

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;

    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 500;

    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant FUNDING = 100_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");
    address internal stranger = makeAddr("stranger");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;
    FreezeThenSettle internal composer;

    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;
    uint256 internal _epochOpenedAt;

    /* ------------------------------------------------------------------ harness */

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-clock", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _warmOracle() internal {
        _advance(90);
        _swap(true, 1e18);
        _advance(90);
        _swap(false, 1e18);
        _advance(90);
        _swap(true, 1e18);
        _advance(TWAP_WINDOW + 120);
    }

    function _fund(address who) internal {
        t0.transfer(who, FUNDING);
        t1.transfer(who, FUNDING);
        vm.startPrank(who);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    function _place(address who, bool zeroForOne, uint128 amount) internal returns (uint256 idx) {
        vm.prank(who);
        idx = queue.place(zeroForOne, amount);
    }

    function _claim(address who, uint64 e, uint256 index) internal returns (uint256) {
        vm.prank(who);
        return queue.claim(e, index);
    }

    function _frozenAt(uint64 e) internal view returns (uint256) {
        (, uint64 f,,,,,,) = queue.epochs(e);
        return uint256(f);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        address a = _hookAddr(1);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        poolKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(a)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );
        _warmOracle();

        queue = deployMoleQueue(
            manager,
            IMoleOracle(a),
            poolKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
        _epochOpenedAt = _clock;
        composer = new FreezeThenSettle();

        _fund(alice);
        _fund(carol);
        _fund(mallory);
        _fund(stranger);
    }

    /* ================================================================================
       1.  THE SETTLEMENT DELAY IS REAL — it runs from the press, not from the cutoff.
       ============================================================================= */

    /// @notice ATTACK, in one transaction, by an address with no privilege of any kind. The epoch closed
    ///         long ago and nobody pressed freeze — the default state of a quiet queue, since nobody is
    ///         obliged or paid to press it, and the participant who wants the option is exactly the party
    ///         who declines. Mallory now composes `freeze(e); settle(e);` in a single transaction, which
    ///         means she chooses the block the batch is priced in and can wrap the whole thing in a swap
    ///         out and a swap back. The premise assertion below is the point: the OLD gate
    ///         (`block.timestamp >= frozenAt + freezeDuration`) is already satisfied at the instant of the
    ///         freeze, so this composition used to go through.
    ///
    ///         MUTATION: gate settle on `ep.frozenAt + freezeDuration` again (drop `delayFrom`) -> the
    ///         composition succeeds -> RED.
    function test_lateFreeze_freezeAndSettleCannotBeComposedInOneTransaction() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);

        // Nobody presses freeze for a long while after the cutoff.
        uint256 cutoff = _epochOpenedAt + EPOCH_DURATION;
        _advance(EPOCH_DURATION + FREEZE_DURATION + 1_000);

        // PREMISE: the delay measured from the backdated cutoff is ALREADY exhausted, which is exactly
        // why this used to work.
        assertGe(_clock, cutoff + FREEZE_DURATION, "premise: the old gate is already satisfied");

        vm.prank(mallory);
        vm.expectRevert(MoleQueue.TooEarly.selector);
        composer.run(queue, 0);

        // Nothing happened: the epoch is untouched, still Open, still unfrozen.
        assertEq(uint8(queue.currentEpoch()), 0, "the reverted composition still advanced the epoch");

        // Split into two transactions it is refused just the same, right up to the last second.
        vm.prank(mallory);
        queue.freeze();
        assertEq(queue.frozenCallAt(0), uint64(_clock), "the freeze press was not recorded");
        assertEq(_frozenAt(0), cutoff, "17.4: frozenAt must still be the SCHEDULED cutoff");

        _advance(FREEZE_DURATION - 1);
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.TooEarly.selector);
        queue.settle(0);

        // And on the second, measured from the press, it opens — the delay is a delay, not a lock.
        _advance(1);
        vm.prank(mallory);
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "the batch could not settle after the wait");
        assertGt(_claim(alice, 0, iA), 0, "alice was paid nothing");
        assertGt(_claim(carol, 0, iC), 0, "carol was paid nothing");
    }

    /// @notice The delay is measured from the LATER of the two anchors, so a PROMPT freeze is unaffected:
    ///         the fix must not quietly lengthen the ordinary path. Pinned to the second on both sides.
    ///
    ///         MUTATION: gate settle on `frozenCallAt[e] + freezeDuration` alone (drop the `max`) -> this
    ///         stays green, which is why the late-freeze test above exists as well; gate it on
    ///         `delayFrom + freezeDuration + 1` -> RED here.
    function test_promptFreeze_theDelayIsUnchangedToTheSecond() public {
        _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        assertEq(queue.frozenCallAt(0), _frozenAt(0), "premise: a prompt freeze presses exactly at the cutoff");

        _advance(FREEZE_DURATION - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.TooEarly.selector);
        queue.settle(0);

        _advance(1);
        vm.prank(stranger);
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "a prompt freeze lost its settlement window");
    }

    /// @notice 17.4 IS NOT UNDONE, and this is the half that a fix to the delay could easily have broken.
    ///         A freeze pressed absurdly late must not buy the escrow any extra lock time: the escape
    ///         hatch is anchored to the CUTOFF, so it is already open when the press lands, and the
    ///         depositors are out immediately.
    ///
    ///         MUTATION: stamp `frozenAt = uint64(block.timestamp)` in `freeze()` (the pre-17.4 form) ->
    ///         the timeout clock restarts from the press and this reverts NotTimedOut -> RED.
    function test_lateFreeze_stillBuysNobodyAnyExtraLockTime() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 cutoff = _epochOpenedAt + EPOCH_DURATION;

        _advance(EPOCH_DURATION + MAX_EPOCH_LIFE * 2);
        vm.prank(stranger);
        queue.freeze();

        assertEq(_frozenAt(0), cutoff, "frozenAt must be the scheduled cutoff, not the button press");
        assertGt(queue.frozenCallAt(0), _frozenAt(0), "premise: the freeze really was late");

        // The escape hatch is measured from the cutoff and the cutoff is long past, so it is already open.
        vm.prank(stranger);
        queue.timeout(0);
        assertEq(_claim(alice, 0, iA), 100e18, "a late freeze cost the depositor time or money");
    }

    /// @notice PIN, and it is the part of F-05 this change does NOT close. Leniency is still anchored on
    ///         the cutoff, so a freeze pressed later than `cutoff + maxEpochLife − freezeDuration` arrives
    ///         with the lenient path already armed: the first settle that is legal is also the first that
    ///         can convert a bound breach into a refund, with no strict retry window before it.
    ///
    ///         Anchoring leniency on the press instead would delete the Q-3 fallback outright for any
    ///         freeze more than `freezeDuration` late — `press + maxEpochLife` would land after the escape
    ///         hatch at `cutoff + maxEpochLife + freezeDuration`, so the crossed portion would never be
    ///         rescued on an unattended queue, which is the common case. What the delay DOES take away is
    ///         the atomic version: the settler can no longer choose the block, because `freezeDuration`
    ///         separates the press from the settle and anyone — including the escape hatch — may act in
    ///         between. Pinned so the residue is visible rather than inferred.
    function test_PIN_aVeryLateFreezeStillArrivesWithTheLenientPathArmed() public {
        _place(alice, true, 100e18);
        uint256 cutoff = _epochOpenedAt + EPOCH_DURATION;

        _advance(EPOCH_DURATION + MAX_EPOCH_LIFE + 10);
        vm.prank(mallory);
        queue.freeze();

        // The one thing that IS enforced: she cannot do it in the same transaction.
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.TooEarly.selector);
        queue.settle(0);

        // And by the time she can settle at all, the escape hatch has been open to everyone else for the
        // whole wait — so what she holds is a race she can lose, not the atomic option she used to have.
        _advance(FREEZE_DURATION);
        assertGe(_clock, cutoff + MAX_EPOCH_LIFE + FREEZE_DURATION, "the escape hatch is open to anyone by now");
        assertGe(_clock, _frozenAt(0) + MAX_EPOCH_LIFE, "PIN: the first legal settle here is already lenient");
    }

    /* ================================================================================
       2.  THE DEADLINE FALLBACK HAS A WINDOW OF ITS OWN.
       ============================================================================= */

    /// @notice ATTACK: the veto. The epoch's residual cannot be executed within its bound, so no settlement
    ///         lands in the strict window and the batch reaches the deadline unresolved — the normal
    ///         outcome on a thin pool. At `frozenAt + maxEpochLife` the lenient settle would cross the
    ///         matched notional at the TWAP and hand back only the unswappable remainder. Mallory, who
    ///         dislikes that price, calls the cheaper `timeout` in the same instant to cancel the batch
    ///         and take her escrow back in kind, destroying carol's fill — which needed no pool at all and
    ///         was already priced. She is refused, and carol is filled.
    ///
    ///         MUTATION: `if (block.timestamp < uint256(ep.frozenAt) + maxEpochLife) revert NotTimedOut();`
    ///         (restore the old bound in timeout's Frozen branch) -> mallory's veto lands, the epoch goes
    ///         to Refunding and carol's cross never happens -> RED.
    function test_veto_timeoutCannotPreEmptASettleableBatchAtTheDeadline() public {
        // A residual far too large for this pool to execute inside the bound, plus a small opposite order
        // that is entirely absorbed by netting: exactly the shape Q-3 exists to rescue.
        (, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18);
        vm.startPrank(alice);
        t0.approve(address(q), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(carol);
        t1.approve(address(q), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(mallory);
        t0.approve(address(q), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 iA = q.place(true, 50_000e18);
        vm.prank(carol);
        uint256 iC = q.place(false, 10e18);

        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        // Strict, and it stays strict: nothing can settle inside the window.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        _advance(MAX_EPOCH_LIFE - FREEZE_DURATION);
        (, uint64 frozenAt,,,,,,) = q.epochs(0);
        assertEq(_clock, uint256(frozenAt) + MAX_EPOCH_LIFE, "premise: this is the deadline second");

        // THE VETO, refused.
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        q.timeout(0);

        // And the fallback does what it is for, from the identical state.
        vm.prank(stranger);
        q.settle(0);
        assertEq(uint8(q.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "the fallback could not act inside its window");

        uint256 c0Before = t0.balanceOf(carol);
        vm.prank(carol);
        uint256 carolOut = q.claim(0, iC);
        assertGt(carolOut, 0, "carol's cross was not paid");
        assertEq(t0.balanceOf(carol), c0Before + carolOut, "carol was not paid in currency0");
        assertGt(q.refundOf(0, iA), 0, "alice's unmatched part was not booked back in kind");
    }

    /// @notice The window is exactly one `freezeDuration` wide, pinned to the second on both edges, and it
    ///         is not a lock: once it closes the escape hatch opens for anyone, as it always did.
    ///
    ///         MUTATION: drop the `+ freezeDuration` from timeout's Frozen branch -> the first assertion
    ///         fails, the veto lands on the deadline second -> RED.
    function test_veto_theExclusiveWindowIsExactlyOneFreezeDuration() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        uint256 frozenAt = _frozenAt(0);

        _advance(MAX_EPOCH_LIFE);
        assertEq(_clock, frozenAt + MAX_EPOCH_LIFE, "premise: the lenient settle unlocks here");
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(FREEZE_DURATION - 1);
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(1);
        assertEq(_clock, frozenAt + MAX_EPOCH_LIFE + FREEZE_DURATION, "premise: the escape hatch opens here");
        vm.prank(mallory);
        queue.timeout(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "the escape hatch did not open");
        assertEq(_claim(alice, 0, iA), 100e18, "the escape hatch did not return the escrow in kind");
    }

    /// @notice THE HOLD IS STILL BOUNDED, and here is the number. With no settler, no freezer beyond the
    ///         one press, and no cooperation from anybody, escrow placed at the moment an epoch opens is
    ///         reclaimable in kind at `epochDuration + maxEpochLife + freezeDuration` after that moment —
    ///         one freezeDuration more than before, which is the price of giving the fallback a window.
    ///         The never-frozen path is unchanged and remains the earlier of the two.
    function test_veto_theMaximumHoldIsBoundedAndThisIsTheBound() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 c1 = t1.balanceOf(carol);
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();

        _advance(MAX_EPOCH_LIFE + FREEZE_DURATION - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(1);
        assertEq(
            _clock,
            _epochOpenedAt + EPOCH_DURATION + MAX_EPOCH_LIFE + FREEZE_DURATION,
            "the bound is not epochDuration + maxEpochLife + freezeDuration from the epoch opening"
        );

        vm.prank(stranger);
        queue.timeout(0);
        assertEq(_claim(alice, 0, iA), 100e18, "alice's escrow did not come back in full");
        assertEq(_claim(carol, 0, iC), 60e18, "carol's escrow did not come back in full");
        assertEq(t0.balanceOf(alice), a0, "alice not made whole in kind");
        assertEq(t1.balanceOf(carol), c1, "carol not made whole in kind");
        assertEq(t0.balanceOf(address(queue)), 0, "currency0 left behind");
        assertEq(t1.balanceOf(address(queue)), 0, "currency1 left behind");
    }

    /// @notice The NEVER-FROZEN branch is deliberately untouched: with no settlement pending there is no
    ///         fallback to protect, so holding the escrow the extra freezeDuration would buy nothing. It
    ///         still opens at `cutoff + maxEpochLife`, which keeps it the earlier of the two doors.
    function test_veto_theNeverFrozenEscapeHatchIsUnchanged() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 cutoff = _epochOpenedAt + EPOCH_DURATION;

        _advance(EPOCH_DURATION + MAX_EPOCH_LIFE - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(1);
        assertEq(_clock, cutoff + MAX_EPOCH_LIFE, "premise: the never-frozen bound is the cutoff clock");
        vm.prank(stranger);
        queue.timeout(0);
        assertEq(_claim(alice, 0, iA), 100e18, "the never-frozen escape hatch stopped working");
    }

    /* ------------------------------------------------------------------ internals */

    /// @dev A second pool on the same hook with deliberately anaemic, tightly concentrated liquidity, plus
    ///      its own queue — the world in which a residual genuinely cannot be executed and the epoch
    ///      therefore reaches the deadline unresolved. A different tickSpacing gives a different PoolId, so
    ///      it carries its own oracle ring.
    function _thinWorld(int24 spacing, int24 lower, int24 upper, uint128 liq)
        internal
        returns (PoolKey memory k, MoleQueue q)
    {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(hook))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(uint256(liq)),
                salt: 0
            }),
            ZERO_BYTES
        );

        // Warm this ring with tiny swaps, so the warm-up cannot move the price out of the band.
        PoolKey memory saved = poolKey;
        poolKey = k;
        _warmOracleTiny();
        poolKey = saved;

        q = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            k,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
    }

    function _warmOracleTiny() internal {
        _advance(90);
        _swap(true, 1e12);
        _advance(90);
        _swap(false, 1e12);
        _advance(90);
        _swap(true, 1e12);
        _advance(TWAP_WINDOW + 120);
    }
}
