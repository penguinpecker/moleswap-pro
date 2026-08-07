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
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice ATTACKING THE ESCROW OF MoleQueue.
///
/// MoleQueue is the only contract in this codebase that HOLDS USER MONEY BETWEEN TRANSACTIONS. The vault
/// mints and burns against a v4 position inside a single unlock; the hook never custodies anything at all.
/// The queue takes tokens in `place()` and gives them back in a LATER transaction, so every question that
/// matters about it is a question about that gap:
///
///   Can money get STUCK in the gap?   -> every phase must have an exit that nobody can withhold.
///   Can money get STOLEN in the gap?  -> the exits must fire at most once per order, for the order's owner
///                                        only, and must never pay out more than came in.
///
/// THE THREE EXITS, and the claim that there is no fourth:
///   1. cancel()  — Open only, free, returns escrow in kind.
///   2. claim()   — Settled only, pro-rata of the side's uniform clearing output.
///   3. claim()   — Refunding only (after timeout), returns escrow in kind with NO price applied (B4).
///
/// THE HOSTAGE QUESTION IS THE WHOLE FILE. The freeze window (B8) deliberately takes the free exit away:
/// after the cutoff you cannot cancel, and settlement is somebody else's transaction. That design only
/// survives if `timeout()` is real — permissionless, unconditional, reachable by a COMPLETE STRANGER with
/// no order, no stake and no relationship to the protocol. If timeout() needed the settler, the settler
/// could ransom every escrow in the epoch simply by not showing up.
/// `test_timeout_completeStrangerFreesEveryEscrow` is that test, and it is the most important one here.
///
/// TWO LIVE DEFECTS ARE PINNED BELOW BY PASSING TESTS THAT ASSERT WHAT THE CONTRACT ACTUALLY DOES. They
/// are numbered S-n so they cannot be confused with the Q-n numbering already used inside MoleQueue.sol.
///
///   S-1  A SHORT FILL SILENTLY BURNS THE DIFFERENCE. The residual leg is one v4 swap with
///        `sqrtPriceLimitX96` pinned at the extreme, so when the pool runs out of liquidity v4 fills
///        PARTIALLY and returns a smaller delta. MoleQueue hands the pool only what it consumed, credits
///        the sellers only what came back, and never looks at the difference again — there is no sweep, no
///        rescue, no fourth exit, and `timeout()` is closed to a Settled epoch. The new
///        `maxResidualSlippageBps` bound CAPS this (a badly short fill now reverts, which is the safe
///        outcome and is proven by `test_poolCannotFillTheResidual_...`) but it does not CLOSE it: any
///        short fill whose output still lands inside the band settles, and the unconsumed input is
///        stranded forever. Measured at ~3.5% of the epoch's escrow with a 5% band; the leak scales with
///        whatever band is deployed. See `test_S1_shortFillInsideTheSlippageBandStrandsEscrowForever`.
///
///   S-2  THE TIMEOUT CLOCK STARTS AT THE BUTTON PRESS, NOT AT THE CUTOFF. An epoch past `epochDuration`
///        but not yet `freeze()`d has NO exit at all: `_phase()` already reports Frozen so cancel and place
///        refuse, while the STORED phase is still Open so settle() and timeout() both revert WrongPhase.
///        It is recoverable — freeze() is permissionless — but freeze() writes `frozenAt = now`, so the
///        `maxEpochLife` hostage clock restarts from the press. An epoch nobody freezes for a month is
///        refundable a month PLUS maxEpochLife after it closed. See
///        `test_S2_unfrozenEpochHasNoExitAndRestartsTheHostageClock`.
///
/// TIME. `vm.warp(block.timestamp + d)` does NOT accumulate inside one call frame — solc caches
/// block.timestamp and block.number — so everything here moves an explicit `_clock` / `_height`.
contract AttackQueueSafety is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------ config */

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;

    /// @dev The two price guards. Both must be non-zero or the constructor refuses. The values are chosen
    ///      to be comfortably wider than anything these escrow tests do to the pool, so that a settlement
    ///      here can only fail for an escrow-accounting reason and never because a price bound tripped.
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 500; // 5%

    /// @dev A realistic chain timestamp. `consult` fails closed on `secondsAgo > block.timestamp`, so the
    ///      default timestamp of 1 would make every settlement revert for entirely the wrong reason.
    uint256 internal constant T0 = 1_750_000_000;

    uint256 internal constant FUNDING = 100_000e18;

    address internal treasury = makeAddr("treasury");

    // Participants. `stranger` is the load-bearing one: no order, no stake, no permission, no motive.
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal eve = makeAddr("eve");
    address internal stranger = makeAddr("stranger");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;

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

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-safety", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
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

    function _newPool(MoleHook h, int24 spacing) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    function _addLiquidity(PoolKey memory k, int24 lower, int24 upper, int256 liq) internal {
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liq, salt: 0}), ZERO_BYTES
        );
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

    /// @dev Real swaps, spaced beyond `OBS_INTERVAL`, so the observation ring actually advances and
    ///      `consult(TWAP_WINDOW)` can answer instead of failing closed at settlement time. The trailing
    ///      quiet period also means the TWAP over the last window equals the current tick, so the
    ///      `maxTwapDeviationTicks` guard reads zero drift and never masks an escrow failure.
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

    function _epoch(uint64 e)
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
        (phase, frozenAt, in0, in1, out0, out1, refund0, refund1) = queue.epochs(e);
    }

    function _qBal0() internal view returns (uint256) {
        return t0.balanceOf(address(queue));
    }

    function _qBal1() internal view returns (uint256) {
        return t1.balanceOf(address(queue));
    }

    /// @dev Drive an epoch all the way to Settled, in one place, so that no test can accidentally settle
    ///      through a path the others do not use.
    function _freezeAndSettle(uint64 e) internal {
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);
        queue.settle(e);
        (MoleQueue.Phase p,,,,,,,) = _epoch(e);
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
        poolKey = _newPool(hook, 60);
        // Deep and wide: the residual leg of a settlement must be able to fill COMPLETELY here, so the
        // conservation tests measure the queue's accounting rather than the pool's depth. The S-1 tests
        // build their own deliberately anaemic pools to attack the opposite case.
        _addLiquidity(poolKey, -60_000, 60_000, 200_000e18);
        _warmOracle(poolKey, 1e18);

        // Constructed AFTER the warm-up so epoch 0 starts with a full `epochDuration` ahead of it.
        queue = _newQueue(poolKey, RESIDUAL_SLIPPAGE_BPS);

        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(dave);
        _fund(eve);
        // The stranger is funded and approved too, so "could not afford it" can never be mistaken for
        // "was not allowed to". He never places an order.
        _fund(stranger);
    }

    /* ================================================================================
       1.  MONEY IS NEVER STUCK — every phase that can hold money has an exit.
       ============================================================================= */

    /// @notice OPEN: cancel returns exactly what was escrowed, in the same token, to the owner, and rolls
    ///         the epoch's totals back so a cancelled size cannot shape a later settlement.
    function test_exitOpen_cancelReturnsEscrowExactlyAndInKind() public {
        uint256 before0 = t0.balanceOf(alice);
        uint256 before1 = t1.balanceOf(alice);

        uint256 iA = _place(alice, true, 100e18); // sells currency0
        uint256 iB = _place(alice, false, 40e18); // sells currency1

        assertEq(t0.balanceOf(alice), before0 - 100e18, "escrow of currency0 not taken");
        assertEq(t1.balanceOf(alice), before1 - 40e18, "escrow of currency1 not taken");
        assertEq(_qBal0(), 100e18, "queue does not hold the currency0 escrow");
        assertEq(_qBal1(), 40e18, "queue does not hold the currency1 escrow");
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Open), "epoch should still be Open");

        vm.prank(alice);
        queue.cancel(0, iA);
        vm.prank(alice);
        queue.cancel(0, iB);

        // EXACTLY what went in, in the SAME token. No price, no fee, no haircut.
        assertEq(t0.balanceOf(alice), before0, "cancel did not return the currency0 escrow exactly");
        assertEq(t1.balanceOf(alice), before1, "cancel did not return the currency1 escrow exactly");
        assertEq(_qBal0(), 0, "currency0 left behind in the queue after cancel");
        assertEq(_qBal1(), 0, "currency1 left behind in the queue after cancel");

        (,, uint128 in0, uint128 in1,,,,) = _epoch(0);
        assertEq(in0, 0, "totalIn0 not rolled back by cancel");
        assertEq(in1, 0, "totalIn1 not rolled back by cancel");
    }

    /// @notice SETTLED: claim pays out on both sides, in the opposite token, and empties the queue.
    function test_exitSettled_claimPaysBothSidesAndEmptiesTheQueue() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);

        _freezeAndSettle(0);

        (,,,, uint128 out0, uint128 out1,,) = _epoch(0);
        assertGt(out0, 0, "side-0 sellers were owed nothing");
        assertGt(out1, 0, "side-1 sellers were owed nothing");

        uint256 aBefore1 = t1.balanceOf(alice);
        uint256 cBefore0 = t0.balanceOf(carol);

        vm.prank(alice);
        uint256 paidA = queue.claim(0, iA);
        vm.prank(carol);
        uint256 paidC = queue.claim(0, iC);

        assertEq(t1.balanceOf(alice), aBefore1 + paidA, "alice was not paid in currency1");
        assertEq(t0.balanceOf(carol), cBefore0 + paidC, "carol was not paid in currency0");
        assertEq(paidA, out0, "the only side-0 seller must receive the whole side-0 output");
        assertEq(paidC, out1, "the only side-1 seller must receive the whole side-1 output");

        assertEq(_qBal0(), 0, "currency0 stranded after every claim");
        assertEq(_qBal1(), 0, "currency1 stranded after every claim");
    }

    /// @notice REFUNDING: after a timeout the exit returns EXACTLY the escrow, in the SAME token, with no
    ///         price applied — B4. The market is deliberately moved a long way between the freeze and the
    ///         reclaim, so "no price applied" is a measurement rather than a coincidence of a flat tape.
    function test_exitRefunding_reclaimIsExactInKindAndPriceBlind() public {
        uint256 aBefore0 = t0.balanceOf(alice);
        uint256 aBefore1 = t1.balanceOf(alice);
        uint256 cBefore0 = t0.balanceOf(carol);
        uint256 cBefore1 = t1.balanceOf(carol);

        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();

        // Move the market hard while the epoch is hostage.
        _advance(60);
        _swap(poolKey, true, 20_000e18);
        _advance(60);
        _swap(poolKey, true, 20_000e18);

        _advance(MAX_EPOCH_LIFE);
        queue.timeout(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "timeout did not open the refund exit");

        vm.prank(alice);
        uint256 backA = queue.claim(0, iA);
        vm.prank(carol);
        uint256 backC = queue.claim(0, iC);

        assertEq(backA, 100e18, "refund is not exactly what alice escrowed");
        assertEq(backC, 60e18, "refund is not exactly what carol escrowed");

        // In kind means literally in kind: whole in the escrowed token, nothing of the other one.
        assertEq(t0.balanceOf(alice), aBefore0, "alice was not made whole in the token she escrowed");
        assertEq(t1.balanceOf(alice), aBefore1, "alice received currency1 from a refund that must be in kind");
        assertEq(t1.balanceOf(carol), cBefore1, "carol was not made whole in the token she escrowed");
        assertEq(t0.balanceOf(carol), cBefore0, "carol received currency0 from a refund that must be in kind");

        assertEq(_qBal0(), 0, "currency0 left in the queue after a full refund");
        assertEq(_qBal1(), 0, "currency1 left in the queue after a full refund");
    }

    /* ================================================================================
       2.  THE TIMEOUT IS REAL AND PERMISSIONLESS.
       ============================================================================= */

    /// @notice A COMPLETE STRANGER — no order, never placed, no stake, nobody's counterparty — ends a
    ///         frozen epoch that the settler abandoned, and all four participants then reclaim in full and
    ///         in kind. This is what stops the freeze window from being a hostage.
    function test_timeout_completeStrangerFreesEveryEscrow() public {
        uint128 aAmt = 137e18;
        uint128 bAmt = 41e18;
        uint128 cAmt = 89e18;
        uint128 dAmt = 7e18;

        uint256 a0 = t0.balanceOf(alice);
        uint256 b0 = t0.balanceOf(bob);
        uint256 c1 = t1.balanceOf(carol);
        uint256 d1 = t1.balanceOf(dave);

        uint256 iA = _place(alice, true, aAmt);
        uint256 iB = _place(bob, true, bAmt);
        uint256 iC = _place(carol, false, cAmt);
        uint256 iD = _place(dave, false, dAmt);

        assertEq(_qBal0(), uint256(aAmt) + bAmt, "queue is not holding the side-0 escrow");
        assertEq(_qBal1(), uint256(cAmt) + dAmt, "queue is not holding the side-1 escrow");

        // Freeze. From here the free exit is gone: this is the moment the design becomes a promise.
        _advance(EPOCH_DURATION);
        queue.freeze();

        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, iA);

        // THE SETTLER NEVER COMES. Not at the freeze deadline, not ever.
        _advance(FREEZE_DURATION + 1);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Frozen), "epoch should be awaiting settlement");

        // Still hostage right up to the last second of maxEpochLife.
        _advance(MAX_EPOCH_LIFE - FREEZE_DURATION - 2);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(1);

        // THE STRANGER ENDS IT. Nobody asked him, nobody paid him, and nobody can stop him.
        assertEq(queue.orderCount(0), 4, "sanity: four orders in the epoch");
        vm.prank(stranger);
        queue.timeout(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "a stranger could not free the escrow");

        // Every participant, reclaiming in an order chosen to be hostile to any hidden sequencing
        // assumption: last placed first, and the two sides interleaved.
        vm.prank(dave);
        uint256 backD = queue.claim(0, iD);
        vm.prank(alice);
        uint256 backA = queue.claim(0, iA);
        vm.prank(carol);
        uint256 backC = queue.claim(0, iC);
        vm.prank(bob);
        uint256 backB = queue.claim(0, iB);

        assertEq(backA, aAmt, "alice not made whole");
        assertEq(backB, bAmt, "bob not made whole");
        assertEq(backC, cAmt, "carol not made whole");
        assertEq(backD, dAmt, "dave not made whole");

        assertEq(t0.balanceOf(alice), a0, "alice's currency0 did not come back");
        assertEq(t0.balanceOf(bob), b0, "bob's currency0 did not come back");
        assertEq(t1.balanceOf(carol), c1, "carol's currency1 did not come back");
        assertEq(t1.balanceOf(dave), d1, "dave's currency1 did not come back");

        // NOTHING is left behind. Not a wei: a refund applies no price, so there is nothing to round.
        assertEq(_qBal0(), 0, "currency0 stranded in the queue after a full timeout refund");
        assertEq(_qBal1(), 0, "currency1 stranded in the queue after a full timeout refund");

        // And the stranger profited by exactly nothing, which is what makes it safe that he may do it.
        assertEq(t0.balanceOf(stranger), FUNDING, "the stranger extracted currency0 by calling timeout");
        assertEq(t1.balanceOf(stranger), FUNDING, "the stranger extracted currency1 by calling timeout");
    }

    /// @notice `timeout()` one second early is refused, by selector. Off-by-one on the hostage clock is the
    ///         difference between an escape hatch and a way to abort a settlement you happen to dislike.
    function test_timeoutBeforeMaxEpochLife_revertsNotTimedOut() public {
        _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        (, uint64 frozenAt,,,,,,) = _epoch(0);
        assertEq(frozenAt, uint64(_clock), "frozenAt is not the freeze moment");

        // The instant after freezing.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        // One second short of the deadline.
        _advance(MAX_EPOCH_LIFE - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        // Exactly on the deadline it opens.
        _advance(1);
        vm.prank(stranger);
        queue.timeout(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "timeout did not open on the deadline");
    }

    /// @notice A settler cannot come back after the timeout and force a price onto an epoch that has
    ///         already become an in-kind refund. If it could, a stale TWAP could be applied to escrow whose
    ///         owners have already been promised their own tokens back.
    function test_settleAfterTimeout_revertsWrongPhase() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);

        vm.prank(stranger);
        queue.timeout(0);

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.settle(0);

        // A second timeout cannot re-open it either.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.timeout(0);

        // The refund exit is still the only one, and it still works.
        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "refund broken after a rejected settle");
    }

    /// @notice The mirror image: once SETTLED, nobody can time the epoch out and turn claims back into
    ///         refunds. That would be a second, cheaper exit for whichever side disliked the clearing price.
    function test_timeoutAfterSettle_revertsWrongPhase() public {
        _place(alice, true, 100e18);
        _place(carol, false, 60e18);
        _freezeAndSettle(0);

        _advance(MAX_EPOCH_LIFE * 10);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.timeout(0);
    }

    /// @notice THE FREEZE WINDOW IS THE WHOLE POINT OF THE FREEZE. Settlement must wait `freezeDuration`
    ///         past the cutoff, and this test exists because deleting that wait killed nothing: with no
    ///         wait, `freeze()` and `settle()` fit in one transaction, which hands the settler the ability
    ///         to pick the exact block -- and therefore the exact spot price -- that the batch is measured
    ///         against. The window is what makes the anchor something nobody chose.
    function test_settleMustWaitOutTheFreezeWindow() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();

        // Same block as the freeze: refused.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.TooEarly.selector);
        queue.settle(0);

        // One second short of the window: still refused.
        _advance(FREEZE_DURATION - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.TooEarly.selector);
        queue.settle(0);

        // On the second: allowed.
        _advance(1);
        vm.prank(stranger);
        queue.settle(0);
        (MoleQueue.Phase ph,,,,,,,) = _epoch(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "the batch did not settle once the window closed");

        vm.prank(alice);
        assertGt(queue.claim(0, iA), 0, "a settled batch paid nothing");
    }

    /// @notice ESCROW BELONGS TO THE ADDRESS THAT PUT IT UP, AND ONLY THAT ADDRESS. Both `claim` and
    ///         `cancel` pay out to `o.owner`, so an unguarded either one lets any passer-by drain the
    ///         epoch order by order. Both checks are tested here because they are separate lines: removing
    ///         one while the other stands must still turn this red.
    function test_onlyTheOrderOwnerCanClaimOrCancel() public {
        uint256 iA = _place(alice, true, 100e18);

        // Before the cutoff: eve cannot cancel alice's order out from under her.
        vm.prank(eve);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.cancel(0, iA);

        // Drive the epoch to a state where a claim actually pays, so this is theft and not a no-op.
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        queue.timeout(0);

        uint256 eveBefore = t0.balanceOf(eve);
        vm.prank(eve);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.claim(0, iA);
        assertEq(t0.balanceOf(eve), eveBefore, "eve moved money she does not own");

        // And alice's own refund is untouched by the attempt.
        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "the owner's escrow was not returned in full");
    }

    /// @notice A SETTLEMENT THAT CAN NEVER SUCCEED IS NOT A TRAP. An epoch whose residual is far larger
    ///         than the pool can fill will refuse to settle, permanently. That is the right call --
    ///         settling would hand everyone a terrible fill -- but it is only safe because the timeout
    ///         still fires and hands every wei back in kind.
    ///
    ///         THE SELECTOR HERE IS `ResidualShortFill`, NOT the slippage bound, and the difference is the
    ///         S-1 fix. A residual this far past the pool's capacity exhausts the liquidity outright, so
    ///         v4 stops early and the input-consumed check refuses BEFORE the output bound is ever
    ///         evaluated. The two guards catch different failures and are both load-bearing: the output
    ///         bound catches a fill that completed at a bad price, this one catches a fill that never
    ///         completed at all. See `test_S1_shortFillIsRefusedAndEveryDepositComesBackInKind` for the
    ///         case that slips past the output bound entirely.
    function test_poolCannotFillTheResidual_settleRefusesAndTimeoutReturnsEverything() public {
        (, MoleQueue q) = _thinWorld(20, -60, 60, 100_000e18, RESIDUAL_SLIPPAGE_BPS);

        uint256 aBefore = t0.balanceOf(alice);
        uint128 amt = 50_000e18; // orders of magnitude beyond what that sliver of liquidity can absorb

        vm.prank(alice);
        t0.approve(address(q), type(uint256).max);
        vm.prank(alice);
        uint256 iA = q.place(true, amt);

        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        // While there is still time on the clock, settlement is STRICT: it refuses and says so by
        // selector, leaving an honest settler free to retry if the pool deepens.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        // Past the deadline the batch resolves anyway rather than waiting for someone to press timeout:
        // there is nothing to cross here, so the whole escrow is booked for return in kind (Q-3).
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        q.settle(0);

        (MoleQueue.Phase ph,,,, uint128 o0,, uint128 r0,) = q.epochs(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "the deadline settlement did not resolve the epoch");
        assertEq(o0, 0, "nothing could be swapped, so no output may be recorded");
        assertEq(r0, amt, "the whole unswappable side must be booked for return");
        assertEq(q.refundOf(0, iA), amt, "refundOf disagrees with what the epoch booked");

        // And alice is made exactly whole, in the token she deposited.
        vm.prank(alice);
        assertEq(q.claim(0, iA), 0, "no swap happened, so the output leg must be zero");
        assertEq(t0.balanceOf(alice), aBefore, "alice was not made whole after an unsettleable epoch");
        assertEq(t0.balanceOf(address(q)), 0, "escrow left behind after an unsettleable epoch was refunded");
    }

    /* ================================================================================
       3.  DOUBLE-SPEND. Every ordering of every exit, checked on BALANCES, not just on reverts.
       ============================================================================= */

    /// @notice cancel, then claim the same order after the epoch settles. Paid once.
    function test_doubleSpend_cancelThenClaim_revertsAlreadyWithdrawnAndPaysOnce() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 a1 = t1.balanceOf(alice);

        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        vm.prank(alice);
        queue.cancel(0, iA);
        assertEq(t0.balanceOf(alice), a0, "cancel did not pay");

        _freezeAndSettle(0);

        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.claim(0, iA);

        assertEq(t0.balanceOf(alice), a0, "alice was paid twice on the cancel-then-claim path");
        assertEq(t1.balanceOf(alice), a1, "alice extracted currency1 from a cancelled order");
    }

    /// @notice claim twice. Paid once.
    function test_doubleSpend_claimTwice_revertsAlreadyWithdrawnAndPaysOnce() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);
        _freezeAndSettle(0);

        uint256 a1 = t1.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = queue.claim(0, iA);
        assertGt(paid, 0, "sanity: the first claim paid something");
        assertEq(t1.balanceOf(alice), a1 + paid, "first claim did not land");

        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.claim(0, iA);

        assertEq(t1.balanceOf(alice), a1 + paid, "alice was paid twice by claiming twice");
    }

    /// @notice cancel twice. Paid once, and the epoch's accumulator is not decremented twice — a second
    ///         decrement would underflow `totalIn0` and poison every other order in the epoch.
    function test_doubleSpend_cancelTwice_revertsAlreadyWithdrawnAndPaysOnce() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 iA = _place(alice, true, 100e18);

        vm.prank(alice);
        queue.cancel(0, iA);
        assertEq(t0.balanceOf(alice), a0, "first cancel did not pay");

        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.cancel(0, iA);

        assertEq(t0.balanceOf(alice), a0, "alice was paid twice by cancelling twice");
        assertEq(_qBal0(), 0, "queue still holds escrow it already returned");

        (,, uint128 in0,,,,,) = _epoch(0);
        assertEq(in0, 0, "totalIn0 corrupted by the double cancel");
        _place(bob, true, 3e18);
        (,, uint128 in0After,,,,,) = _epoch(0);
        assertEq(in0After, 3e18, "totalIn0 accumulator is corrupt after a refused double cancel");
    }

    /// @notice claim, THEN try to cancel. Refused, and paid exactly once.
    ///
    /// @dev THE SELECTOR HERE IS `WrongPhase`, NOT `AlreadyWithdrawn`, AND THAT IS THE TRUTH RATHER THAN A
    ///      WEAKENED TEST. `cancel()` checks the phase before it looks at the order, and claiming is only
    ///      ever possible in Settled or Refunding — both non-Open — so a claim-then-cancel can never reach
    ///      the `withdrawn` guard at all. The property that matters (paid once, escrow conserved) is
    ///      asserted on balances below and holds either way; asserting `AlreadyWithdrawn` here would be
    ///      asserting something the contract does not and structurally cannot do.
    function test_doubleSpend_claimThenCancel_isRefusedAndPaysOnce() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);
        _freezeAndSettle(0);

        uint256 a0 = t0.balanceOf(alice);
        uint256 a1 = t1.balanceOf(alice);

        vm.prank(alice);
        uint256 paid = queue.claim(0, iA);

        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, iA);

        assertEq(t1.balanceOf(alice), a1 + paid, "claim payout changed after the refused cancel");
        assertEq(t0.balanceOf(alice), a0, "alice clawed her escrow back on top of her claim");
    }

    /// @notice reclaim twice out of a timed-out epoch. Paid once, in kind.
    function test_doubleSpend_reclaimTwiceAfterTimeout_revertsAlreadyWithdrawnAndPaysOnce() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        queue.timeout(0);

        uint256 a0 = t0.balanceOf(alice);

        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "first reclaim wrong");

        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.claim(0, iA);

        assertEq(t0.balanceOf(alice), a0 + 100e18, "alice reclaimed twice");
        assertEq(_qBal0(), 0, "the queue over-held or over-paid on the refund path");
    }

    /// @notice cancel, then reclaim the SAME order out of a timed-out epoch. This is the dangerous
    ///         permutation: the refund branch pays `o.amountIn` blindly, with no reference to the epoch
    ///         totals and no balance check, so if the `withdrawn` flag did not stop it the cancelled order
    ///         would be paid a second time straight out of somebody else's escrow.
    function test_doubleSpend_cancelThenReclaim_cannotDrainAnotherUsersEscrow() public {
        uint256 a0 = t0.balanceOf(alice);

        uint256 iA = _place(alice, true, 100e18);
        uint256 iB = _place(bob, true, 100e18);

        vm.prank(alice);
        queue.cancel(0, iA);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        queue.timeout(0);

        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.claim(0, iA);

        assertEq(t0.balanceOf(alice), a0, "alice was paid twice across cancel and refund");

        // Bob's escrow is untouched and still fully reclaimable, which is the point.
        assertEq(_qBal0(), 100e18, "bob's escrow was raided");
        vm.prank(bob);
        assertEq(queue.claim(0, iB), 100e18, "bob could not reclaim after the attempted double spend");
        assertEq(_qBal0(), 0, "queue not empty after the only remaining order was reclaimed");
    }

    /* ================================================================================
       4.  ISOLATION. One participant's behaviour — or absence — cannot block another's exit.
       ============================================================================= */

    /// @notice Three sellers on the same side; the MIDDLE and largest one never shows up. The other two
    ///         must still be paid, in any order, and the missing claim must not move the pro-rata
    ///         denominator for anyone else.
    function test_isolation_absentMiddleParticipantCannotBlockTheOthers() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iB = _place(bob, true, 250e18); // bob does not show up until the very end
        uint256 iD = _place(dave, true, 33e18);
        _place(carol, false, 90e18);

        _freezeAndSettle(0);

        (,, uint128 in0,, uint128 out0,,,) = _epoch(0);
        assertEq(in0, 383e18, "sanity: side-0 escrow");

        uint256 a1 = t1.balanceOf(alice);
        uint256 d1 = t1.balanceOf(dave);

        // Dave claims FIRST, out of queue order, while bob's much larger order is still outstanding.
        vm.prank(dave);
        uint256 paidD = queue.claim(0, iD);
        assertEq(paidD, FullMath.mulDiv(out0, 33e18, in0), "dave's share is not his pro-rata of the side output");
        assertEq(t1.balanceOf(dave), d1 + paidD, "dave was not paid");

        vm.prank(alice);
        uint256 paidA = queue.claim(0, iA);
        assertEq(paidA, FullMath.mulDiv(out0, 100e18, in0), "alice's share moved because bob did not claim");
        assertEq(t1.balanceOf(alice), a1 + paidA, "alice was not paid");

        // Bob's money is still there, still his, still claimable at any later time.
        uint256 bobsShare = FullMath.mulDiv(out0, 250e18, in0);
        assertGe(_qBal1(), bobsShare, "bob's unclaimed share is no longer covered by the queue's balance");

        _advance(365 days);
        uint256 b1 = t1.balanceOf(bob);
        vm.prank(bob);
        uint256 paidB = queue.claim(0, iB);
        assertEq(paidB, bobsShare, "bob's share changed while he was away");
        assertEq(t1.balanceOf(bob), b1 + paidB, "bob was not paid on his eventual return");
    }

    /// @notice The same isolation property across the refund path: a participant who never reclaims cannot
    ///         hold the others' escrow, and an epoch is not all-or-nothing.
    function test_isolation_absentParticipantCannotBlockRefunds() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 c1 = t1.balanceOf(carol);

        uint256 iA = _place(alice, true, 100e18);
        _place(bob, true, 250e18); // never reclaims
        uint256 iC = _place(carol, false, 90e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        queue.timeout(0);

        vm.prank(carol);
        assertEq(queue.claim(0, iC), 90e18, "carol's refund was affected by bob's absence");
        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "alice's refund was affected by bob's absence");

        assertEq(t0.balanceOf(alice), a0, "alice not made whole");
        assertEq(t1.balanceOf(carol), c1, "carol not made whole");
        assertEq(_qBal0(), 250e18, "bob's refund is not sitting untouched and fully covered");
        assertEq(_qBal1(), 0, "side-1 escrow not fully returned");
    }

    /* ================================================================================
       5.  NOT YOUR ORDER.
       ============================================================================= */

    /// @notice A stranger cannot cancel someone else's order — and neither can a CO-PARTICIPANT, which is
    ///         the version that matters, because a co-participant has a motive: cancelling the other side
    ///         reshapes the residual everybody else is pushed through the pool at.
    function test_notYourOrder_strangerCannotCancel_revertsNotOrderOwner() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.cancel(0, iA);

        vm.prank(carol);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.cancel(0, iA);

        vm.prank(alice);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.cancel(0, iC);

        // The queue itself is not an owner either.
        vm.prank(address(queue));
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.cancel(0, iA);

        assertEq(_qBal0(), 100e18, "escrow moved on a refused cancel");
        assertEq(_qBal1(), 60e18, "escrow moved on a refused cancel");
    }

    /// @notice A stranger cannot claim someone else's payout, and the refused attempts leave the real
    ///         owner's claim completely intact.
    function test_notYourOrder_strangerCannotClaim_revertsNotOrderOwner() public {
        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);
        _freezeAndSettle(0);

        uint256 s0 = t0.balanceOf(stranger);
        uint256 s1 = t1.balanceOf(stranger);

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.claim(0, iA);

        vm.prank(carol);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.claim(0, iA);

        assertEq(t0.balanceOf(stranger), s0, "stranger extracted currency0");
        assertEq(t1.balanceOf(stranger), s1, "stranger extracted currency1");

        vm.prank(alice);
        assertGt(queue.claim(0, iA), 0, "alice's claim was damaged by the attempts");
        vm.prank(carol);
        assertGt(queue.claim(0, iC), 0, "carol's claim was damaged by the attempts");
    }

    /// @notice Same on the refund path — the in-kind exit is the one an attacker would most like to point
    ///         at somebody else's order, because it pays a fixed amount with no price and no balance check.
    function test_notYourOrder_strangerCannotReclaimAfterTimeout_revertsNotOrderOwner() public {
        uint256 iA = _place(alice, true, 100e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        queue.timeout(0);

        uint256 s0 = t0.balanceOf(stranger);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.claim(0, iA);
        assertEq(t0.balanceOf(stranger), s0, "the stranger reclaimed alice's escrow");

        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "alice's refund was damaged");
    }

    /// @notice THERE IS NO FOURTH EXIT. `unlockCallback` is the only other function that can move money,
    ///         and it belongs to the PoolManager alone. Anyone else calling it — including with a payload
    ///         that names the entire escrow as a residual — is refused by selector.
    function test_noFourthExit_unlockCallbackIsPoolManagerOnly() public {
        _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotPoolManager.selector);
        queue.unlockCallback(abi.encode(uint128(100e18), uint128(60e18)));

        assertEq(_qBal0(), 100e18, "escrow moved through the callback");
        assertEq(_qBal1(), 60e18, "escrow moved through the callback");
    }

    /* ================================================================================
       6.  NO LEAKAGE, AND THE DUST MUST FALL THE RIGHT WAY.

       An overpay is not a rounding nicety, it is insolvency for whoever claims last. So the DIRECTION of
       every rounding is asserted, not merely its magnitude.
       ============================================================================= */

    /// @notice Five participants with deliberately indivisible sizes, so pro-rata rounding actually bites.
    ///         After the last claim the queue holds at most one wei per claimer — and every one of those
    ///         wei is dust the CONTRACT kept, never a wei it overpaid.
    function test_noLeakage_afterEveryoneClaims_dustStaysInTheContract() public {
        // Deliberately awkward sizes: nothing here divides cleanly into anything else.
        uint128 aAmt = 100_000_000_000_000_000_003;
        uint128 bAmt = 33_333_333_333_333_333_331;
        uint128 dAmt = 7_777_777_777_777_777_777;
        uint128 cAmt = 61_111_111_111_111_111_111;
        uint128 eAmt = 13_333_333_333_333_333_333;

        uint256 iA = _place(alice, true, aAmt);
        uint256 iB = _place(bob, true, bAmt);
        uint256 iD = _place(dave, true, dAmt);
        uint256 iC = _place(carol, false, cAmt);
        uint256 iE = _place(eve, false, eAmt);

        _freezeAndSettle(0);

        (,, uint128 in0, uint128 in1, uint128 out0, uint128 out1,,) = _epoch(0);
        assertGt(in0, 0, "sanity: side 0 escrowed");
        assertGt(in1, 0, "sanity: side 1 escrowed");
        assertGt(out0, 0, "sanity: side 0 earned something");
        assertGt(out1, 0, "sanity: side 1 earned something");

        // Side-0 sellers are paid in currency1, and vice versa.
        uint256 paidToSide0;
        vm.prank(alice);
        paidToSide0 += queue.claim(0, iA);
        vm.prank(bob);
        paidToSide0 += queue.claim(0, iB);
        vm.prank(dave);
        paidToSide0 += queue.claim(0, iD);

        uint256 paidToSide1;
        vm.prank(carol);
        paidToSide1 += queue.claim(0, iC);
        vm.prank(eve);
        paidToSide1 += queue.claim(0, iE);

        // DIRECTION FIRST. The payouts must never exceed what the epoch actually earned; if they could,
        // somebody else's escrow is what pays the difference.
        assertLe(paidToSide0, out0, "side-0 sellers were collectively OVERPAID -- that is insolvency");
        assertLe(paidToSide1, out1, "side-1 sellers were collectively OVERPAID -- that is insolvency");

        // And the shortfall is only rounding: at most one wei lost per claimer.
        assertGe(paidToSide0 + 3, out0, "side-0 payout lost more than pro-rata rounding dust");
        assertGe(paidToSide1 + 2, out1, "side-1 payout lost more than pro-rata rounding dust");

        // The queue is empty except for that dust — and the dust is in the contract, where it belongs.
        assertLe(_qBal1(), 3, "currency1 leaked: queue holds more than pro-rata dust after every claim");
        assertLe(_qBal0(), 2, "currency0 leaked: queue holds more than pro-rata dust after every claim");
    }

    /// @notice The last claimer must always be payable — that is the concrete damage an overpay does, so it
    ///         gets its own attack: claim in the worst possible order (largest first) and prove the
    ///         smallest, last order can still be paid out of what is left.
    function test_noLeakage_lastClaimerIsNeverStarved() public {
        uint256 iB = _place(bob, true, 999_999_999_999_999_999_999);
        uint256 iA = _place(alice, true, 500_000_000_000_000_000_001);
        uint256 iD = _place(dave, true, 1); // one wei. the last claimer.
        _place(carol, false, 250_000_000_000_000_000_007);

        _freezeAndSettle(0);

        vm.prank(bob);
        queue.claim(0, iB);
        vm.prank(alice);
        queue.claim(0, iA);

        uint256 d1 = t1.balanceOf(dave);
        vm.prank(dave);
        uint256 paidD = queue.claim(0, iD); // must not revert on an insufficient balance
        assertEq(t1.balanceOf(dave), d1 + paidD, "the last claimer could not be paid");
    }

    /// @notice A timed-out epoch leaves EXACTLY zero, because no price was applied and so nothing was
    ///         rounded. Any dust here would be a user's money that no one can ever reach.
    function test_noLeakage_afterEveryoneReclaims_queueIsExactlyZero() public {
        uint256 iA = _place(alice, true, 100_000_000_000_000_000_003);
        uint256 iB = _place(bob, true, 33_333_333_333_333_333_331);
        uint256 iC = _place(carol, false, 61_111_111_111_111_111_111);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        queue.timeout(0);

        vm.prank(alice);
        queue.claim(0, iA);
        vm.prank(bob);
        queue.claim(0, iB);
        vm.prank(carol);
        queue.claim(0, iC);

        assertEq(_qBal0(), 0, "a refund left currency0 dust behind -- refunds apply no price and must be exact");
        assertEq(_qBal1(), 0, "a refund left currency1 dust behind -- refunds apply no price and must be exact");
    }

    /// @notice Escrow does not bleed between epochs. Epoch 0 settles and is fully claimed while epoch 1 is
    ///         open and holding money; epoch 1's escrow must be untouched to the wei and still cancellable.
    function test_noLeakage_settlingOneEpochCannotSpendAnothersEscrow() public {
        uint256 b0 = t0.balanceOf(bob);
        uint256 d1 = t1.balanceOf(dave);

        uint256 iA = _place(alice, true, 100e18);
        uint256 iC = _place(carol, false, 60e18);

        _advance(EPOCH_DURATION);
        queue.freeze(); // epoch 0 frozen, epoch 1 now open

        // Epoch 1 fills up while epoch 0 is still unsettled.
        uint256 jB = _place(bob, true, 400e18);
        uint256 jD = _place(dave, false, 90e18);

        _advance(FREEZE_DURATION);
        queue.settle(0);

        vm.prank(alice);
        queue.claim(0, iA);
        vm.prank(carol);
        queue.claim(0, iC);

        // Epoch 1's escrow is still exactly there.
        assertEq(_qBal0(), 400e18, "epoch 1's currency0 escrow was consumed by epoch 0's settlement");
        assertEq(_qBal1(), 90e18, "epoch 1's currency1 escrow was consumed by epoch 0's settlement");

        vm.prank(bob);
        queue.cancel(1, jB);
        vm.prank(dave);
        queue.cancel(1, jD);
        assertEq(t0.balanceOf(bob), b0, "bob could not get his epoch-1 escrow back");
        assertEq(t1.balanceOf(dave), d1, "dave could not get his epoch-1 escrow back");
        assertEq(_qBal0(), 0, "leftover currency0 after both epochs were fully unwound");
        assertEq(_qBal1(), 0, "leftover currency1 after both epochs were fully unwound");
    }

    /* ================================================================================
       7.  FINDINGS. Two live defects, pinned by tests that assert what the contract ACTUALLY does.
       ============================================================================= */

    /// @notice S-2, FIXED, AND THIS TEST NOW ASSERTS THE FIX. The defect: an epoch past `epochDuration`
    ///         but not yet frozen had NO EXIT AT ALL. `_phase()` already reported Frozen, so cancel and
    ///         place refused; the STORED phase was still Open, so settle() and timeout() both reverted
    ///         WrongPhase. Money sat in escrow with every door shut. Worse, the recovery RESTARTED THE
    ///         CLOCK: freeze() stamped `frozenAt = block.timestamp`, so the maxEpochLife countdown began at
    ///         whenever somebody happened to press the button rather than at the cutoff depositors were
    ///         promised. An epoch nobody froze for three lifetimes was refundable three lifetimes PLUS
    ///         maxEpochLife after it closed -- and nobody is obliged to press it.
    ///
    ///         The fix is two lines in two places: `timeout()` accepts a never-frozen current epoch, and
    ///         `frozenAt` is stamped with the SCHEDULED cutoff instead of the button press.
    function test_S2_unfrozenEpochIsTimeoutableOnItsOwnCutoffClock() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        uint256 closedAt = _clock + EPOCH_DURATION;
        _advance(EPOCH_DURATION);

        // The cutoff closes the free exit, as designed -- that half was never the bug.
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Frozen), "epoch should be time-frozen at the cutoff");
        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, iA);

        // THE FIX, HALF ONE: timeout() no longer says WrongPhase to a never-frozen epoch. It says
        // NotTimedOut -- i.e. "this door exists, it is simply not open yet", which is a promise, where
        // WrongPhase was a locked room.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        // One second before the deadline measured from the CUTOFF, not from any button press.
        _advance(MAX_EPOCH_LIFE - 1);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        // And on it. No freeze() was ever called; nobody's cooperation was required.
        _advance(1);
        assertEq(_clock, closedAt + MAX_EPOCH_LIFE, "premise: the deadline is measured from the cutoff");
        vm.prank(stranger);
        queue.timeout(0);

        (MoleQueue.Phase ph,,,,,,,) = _epoch(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Refunding), "a timed-out epoch must be refunding");
        assertEq(queue.currentEpoch(), 1, "an abandoned epoch must not still be the one taking new orders");

        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "escrow is recoverable in kind, without anyone's permission");
        assertEq(_qBal0(), 0, "alice's leg is fully out");
    }

    /// @notice The other half of the S-2 fix, isolated: a LATE freeze must not buy itself more time.
    ///         `freeze()` is permissionless and nobody is obliged to call it promptly, so stamping the
    ///         button press made the maximum time escrow could be held UNBOUNDED -- the longer everyone
    ///         forgot, the longer everyone waited. Anchoring to the scheduled cutoff makes lateness free.
    function test_S2_lateFreezeDoesNotRestartTheTimeoutClock() public {
        uint256 iA = _place(alice, true, 100e18);
        _place(carol, false, 60e18);

        uint256 closedAt = _clock + EPOCH_DURATION;

        // The cutoff passes and then a very long time passes with nobody pressing anything.
        _advance(EPOCH_DURATION + MAX_EPOCH_LIFE * 2);

        vm.prank(stranger);
        queue.freeze();

        (, uint64 frozenAt,,,,,,) = _epoch(0);
        assertEq(frozenAt, uint64(closedAt), "frozenAt must be the scheduled cutoff, not the button press");
        assertLt(uint256(frozenAt), _clock, "premise: the freeze really was late");

        // Because the anchor is the cutoff and the cutoff is long past, the escape hatch is ALREADY open.
        vm.prank(stranger);
        queue.timeout(0);
        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "a late freeze costs depositors nothing");
    }

    /// @notice S-1, FIXED, AND THIS TEST NOW ASSERTS THE FIX. The defect: a SHORT FILL BURNED THE
    ///         DIFFERENCE. The residual leg is a single v4 swap with `sqrtPriceLimitX96` pinned at the
    ///         extreme, so when the pool runs out of liquidity v4 does not revert -- it STOPS, and returns
    ///         a delta smaller than the input. The queue transferred only what the pool consumed, recorded
    ///         only what the pool returned, and never referred to the difference again. The epoch was
    ///         Settled, so claim paid the pro-rata of `out0` and stopped, timeout was closed to a Settled
    ///         epoch, and there is no sweep. The unconsumed escrow was burned into the contract.
    ///
    ///         `maxResidualSlippageBps` CAPPED it but could not CLOSE it: that bound is on the OUTPUT, so
    ///         any short fill whose output still landed inside the band settled happily and stranded the
    ///         rest. This test sizes the residual just past what the pool can absorb, so the fill lands
    ///         inside a 5% band -- the exact case the bound waves through.
    ///
    ///         The fix compares the input the pool ACTUALLY took against what it was offered, and refuses.
    ///         The epoch then times out and every deposit comes back in kind, at no loss.
    function test_S1_shortFillIsRefusedAndEveryDepositComesBackInKind() public {
        int24 lower = -60;
        int24 upper = 60;
        uint128 liq = 100_000e18;
        (PoolKey memory thin, MoleQueue q) = _thinWorld(20, lower, upper, liq, RESIDUAL_SLIPPAGE_BPS);

        // How much currency0 this sliver of liquidity can absorb before it is exhausted, computed from the
        // pool's LIVE price rather than assumed, so the warm-up swaps cannot skew it.
        (uint160 sqrtNow,,,) = StateLibrary.getSlot0(manager, thin.toId());
        uint256 capacity = SqrtPriceMath.getAmount0Delta(TickMath.getSqrtPriceAtTick(lower), sqrtNow, liq, false);
        assertGt(capacity, 100e18, "sanity: the thin pool has a measurable capacity");

        // Just past it: enough to guarantee a short fill, little enough that the OUTPUT would still land
        // inside the 5% band. Under the old code this settled and stranded 3-5% of the escrow.
        uint128 amt = uint128((capacity * 104) / 100);

        uint256 aBefore0 = t0.balanceOf(alice);
        vm.prank(alice);
        t0.approve(address(q), type(uint256).max);
        vm.prank(alice);
        uint256 iA = q.place(true, amt);

        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);

        // THE FIX. Not ResidualSwapTooFarFromTwap -- the output bound is satisfied here, which is precisely
        // why it could never have caught this. The input-consumed check is what refuses.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.ResidualShortFill.selector);
        q.settle(0);

        // The refusal is not a trap. Past the deadline the batch resolves with the unswappable part
        // returned in kind, and the important number is that it is returned IN FULL -- the whole point of
        // the fix is that the short-filled difference is no longer quietly kept.
        _advance(MAX_EPOCH_LIFE);
        vm.prank(stranger);
        q.settle(0);
        assertEq(q.refundOf(0, iA), amt, "the short-filled escrow was not booked back in full");

        vm.prank(alice);
        q.claim(0, iA);

        assertEq(t0.balanceOf(alice), aBefore0, "alice must be made whole -- not one wei burned");
        assertEq(t0.balanceOf(address(q)), 0, "the contract must hold nothing after everyone is out");
    }

    /* ------------------------------------------------------------------ internals */

    /// @dev A second pool on the same hook with deliberately anaemic, tightly-concentrated liquidity, plus
    ///      its own queue. A different tickSpacing gives a different PoolId, so it carries its own oracle
    ///      state and cannot disturb the deep pool the conservation tests rely on.
    function _thinWorld(int24 spacing, int24 lower, int24 upper, uint128 liq, uint16 bps)
        internal
        returns (PoolKey memory k, MoleQueue q)
    {
        k = _newPool(hook, spacing);
        _addLiquidity(k, lower, upper, int256(uint256(liq)));
        _warmOracle(k, 1e12); // tiny, so the warm-up cannot itself move the price out of the band
        q = _newQueue(k, bps);
    }
}
