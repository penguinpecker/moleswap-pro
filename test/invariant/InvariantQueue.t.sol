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
import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";
import {QueueHandler} from "./QueueHandler.sol";

/// @title InvariantQueue
/// @notice THE ESCROW INVARIANTS. `MolePositions` custodies nothing and INV-1 asserts exactly that; the
///         queue cannot make that claim, because holding money between two transactions is its whole job.
///         So it needs the opposite property, and these are it.
///
/// QINV1 is the one that matters: if the queue can ever owe more than it holds, somebody's claim reverts
/// and their money is gone in practice even though every individual function looked correct — which is the
/// exact shape of the 2026-08-01 custody break, where every permission check held and the accounting still
/// lost. QINV6 is its mirror and closes the other direction: S-1 worked by the contract quietly KEEPING
/// value, which no solvency check can see.
///
/// WHAT THESE WORLDS DO AND DO NOT KILL, measured rather than claimed. Mutation results:
///   KILLED  claim's owner check, cancel's owner check, claim's one-shot flag  -> QINV1
///   KILLED  settle booking the refund legs, claim paying the in-kind leg      -> QINV6 (tight world only)
///   KILLED  cancel un-booking the escrow, claim paying pro-rata               -> QINV1
///   SURVIVES  cancel's one-shot flag, and the S-1 short-fill refusal.
/// Both survivors are already mutation-killed by the deterministic attack suite, and both survive HERE for
/// a structural reason worth writing down. A second `cancel` also runs `ep.totalIn0 -= o.amountIn` a
/// second time, which underflows and reverts on its own in most states — it only becomes a theft when
/// there is other escrow in the same epoch to absorb it, a window the fuzzer does not reliably reach. And
/// the short-fill refusal needs a pool too thin to fill the residual, which these worlds deliberately are
/// not. Fuzzing is not a superset of the deterministic tests; it covers a different axis.
contract InvariantQueue is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH = 600;
    uint32 internal constant FREEZE = 120;
    uint32 internal constant LIFE = 2400;
    uint32 internal constant TWAP_WINDOW = 300;
    int24 internal constant TWAP_BAND = 600;
    /// @dev Wide on purpose. A tight bound would make almost every settlement in the run refuse, and the
    ///      fuzzer would spend its calls proving that the guard fires rather than exercising the
    ///      accounting underneath it. The bound's own behaviour is pinned by deterministic tests.
    uint16 internal constant RESIDUAL_BPS = 5_000;

    /// @dev Overridden by the tight-bound world below. The bound decides which HALF of the settlement
    ///      machinery a run exercises, and that turned out to matter: with a wide bound the residual
    ///      always swaps, so the in-kind refund legs are never written and a mutation deleting them
    ///      SURVIVED the whole fuzz campaign. One world cannot cover both paths.
    function _residualBps() internal view virtual returns (uint16) {
        return RESIDUAL_BPS;
    }
    uint256 internal constant T0 = 1_750_000_000;

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;
    QueueHandler internal handler;
    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        uint160 high = uint160(uint256(keccak256("invariant-queue"))) & ~HookPermissions.ALL_HOOK_MASK;
        address a = address(high | HookPermissions.REQUIRED_FLAGS);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(
                manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), makeAddr("t"), TEST_UPGRADE_ADMIN
            ),
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
            ModifyLiquidityParams({tickLower: -120_000, tickUpper: 120_000, liquidityDelta: 500_000e18, salt: 0}),
            ZERO_BYTES
        );
        _warmOracle();

        queue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            poolKey,
            EPOCH,
            FREEZE,
            LIFE,
            TWAP_WINDOW,
            TWAP_BAND,
            _residualBps(),
            TEST_UPGRADE_ADMIN
        );

        address[4] memory actors =
            [makeAddr("q.alice"), makeAddr("q.bob"), makeAddr("q.carol"), makeAddr("q.dave")];
        for (uint256 i = 0; i < actors.length; i++) {
            t0.mint(actors[i], 1_000_000e18);
            t1.mint(actors[i], 1_000_000e18);
        }

        handler = new QueueHandler(queue, manager, swapRouter, poolKey, actors);
        targetContract(address(handler));
    }

    function _warmOracle() internal {
        for (uint256 i = 0; i < 10; i++) {
            _clock += 90;
            _height += 8;
            vm.warp(_clock);
            vm.roll(_height);
            swapRouter.swap(
                poolKey,
                SwapParams({
                    zeroForOne: i % 2 == 0,
                    amountSpecified: -1e18,
                    sqrtPriceLimitX96: i % 2 == 0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
        }
        _clock += TWAP_WINDOW + 120;
        _height += 30;
        vm.warp(_clock);
        vm.roll(_height);
    }

    /* --------------------------------------------------------- what the queue owes, independently */

    /// @dev Recomputed here from the handler's own ledger plus the epoch's published outputs. It does NOT
    ///      call any "how much do I owe" helper on the contract, because that helper is part of what is
    ///      under test.
    function _owed() internal view returns (uint256 owed0, uint256 owed1) {
        uint256 n = handler.ghostCount();
        for (uint256 i = 0; i < n; i++) {
            QueueHandler.Ghost memory g = handler.ghostAt(i);
            if (g.settledOut) continue;

            (MoleQueue.Phase ph,, uint128 in0, uint128 in1, uint128 out0, uint128 out1, uint128 r0, uint128 r1) =
                queue.epochs(g.epoch);

            if (ph == MoleQueue.Phase.Settled) {
                if (g.zeroForOne) {
                    owed1 += FullMath.mulDiv(out0, g.amountIn, in0);
                    if (r0 != 0) owed0 += FullMath.mulDiv(r0, g.amountIn, in0);
                } else {
                    owed0 += FullMath.mulDiv(out1, g.amountIn, in1);
                    if (r1 != 0) owed1 += FullMath.mulDiv(r1, g.amountIn, in1);
                }
            } else {
                // Open, Frozen or Refunding: the escrow is owed back in kind, at face value.
                if (g.zeroForOne) owed0 += g.amountIn;
                else owed1 += g.amountIn;
            }
        }
    }

    /* ------------------------------------------------------------------- the invariants */

    /// @notice QINV1 — THE QUEUE IS ALWAYS SOLVENT. At every observable point it holds at least what it
    ///         owes, on both tokens, so no claim can ever revert for want of funds. An escrow contract
    ///         that fails this has already lost somebody's money, whatever its functions look like.
    function invariant_QINV1_queueHoldsAtLeastWhatItOwes() public view {
        (uint256 owed0, uint256 owed1) = _owed();
        assertGe(t0.balanceOf(address(queue)), owed0, "QINV1: the queue owes more currency0 than it holds");
        assertGe(t1.balanceOf(address(queue)), owed1, "QINV1: the queue owes more currency1 than it holds");
    }

    /// @notice QINV2 — NO FREE MONEY. Everything paid out came from something escrowed or something the
    ///         pool returned; the queue never pays out of thin air, and never out of the next epoch's
    ///         escrow. Checked as a conservation statement across the whole run rather than per call,
    ///         because cross-epoch theft is precisely what a per-call check would miss.
    function invariant_QINV2_payoutsAreCoveredByEscrowPlusPoolProceeds() public view {
        (uint256 owed0, uint256 owed1) = _owed();
        // Everything that ever went in, minus everything still owed, is the most that can have come out
        // of escrow. Anything beyond it must have come from the pool — which is legitimate, so this is
        // the direction that matters: the queue must never hold LESS than (escrowed - paid out - traded).
        uint256 held0 = t0.balanceOf(address(queue));
        uint256 held1 = t1.balanceOf(address(queue));
        assertGe(held0 + handler.totalPaidOut0(), owed0, "QINV2: currency0 left the system unaccounted");
        assertGe(held1 + handler.totalPaidOut1(), owed1, "QINV2: currency1 left the system unaccounted");
    }

    /// @notice QINV3 — THE EPOCH TOTALS ARE THE SUM OF THEIR LIVE ORDERS. `totalIn0`/`totalIn1` are the
    ///         denominators every payout is divided by, so a drift here silently mis-prices every claim in
    ///         the epoch. A double decrement in `cancel` would underflow this to ~2^128 and poison the lot.
    function invariant_QINV3_epochTotalsMatchTheirOrders() public view {
        uint64 latest = queue.currentEpoch();
        for (uint64 e = 0; e <= latest; e++) {
            (,, uint128 in0, uint128 in1,,,,) = queue.epochs(e);
            (uint256 sum0, uint256 sum1) = _sumLiveOrders(e);
            assertEq(uint256(in0), sum0, "QINV3: totalIn0 disagrees with the orders that make it up");
            assertEq(uint256(in1), sum1, "QINV3: totalIn1 disagrees with the orders that make it up");
        }
    }

    /// @dev Summed from the HANDLER'S ledger, not from the contract's order array, and the difference is
    ///      the whole point: a CANCEL un-books the escrow, a CLAIM does not — the totals stay as the
    ///      settlement denominator forever so that claims remain independent of one another. Those two
    ///      set the same `withdrawn` flag, so the contract's own storage cannot tell them apart after the
    ///      fact. Reading it back would make this invariant agree with the contract by construction.
    function _sumLiveOrders(uint64 e) internal view returns (uint256 sum0, uint256 sum1) {
        uint256 n = handler.ghostCount();
        for (uint256 i = 0; i < n; i++) {
            QueueHandler.Ghost memory g = handler.ghostAt(i);
            if (g.epoch != e) continue;
            if (g.cancelledOut) continue;
            if (g.zeroForOne) sum0 += g.amountIn;
            else sum1 += g.amountIn;
        }
    }

    /// @notice QINV4 — ONE PAYOUT PER ORDER, EVER. The handler's ledger marks an order the moment it is
    ///         paid; the contract's own flag must agree. A disagreement is a double-spend in one direction
    ///         or a lost claim in the other.
    function invariant_QINV4_theWithdrawnFlagAgreesWithWhatWasPaid() public view {
        uint256 n = handler.ghostCount();
        for (uint256 i = 0; i < n; i++) {
            QueueHandler.Ghost memory g = handler.ghostAt(i);
            (,,, bool withdrawn) = queue.orders(g.epoch, g.index);
            if (g.settledOut) {
                assertTrue(withdrawn, "QINV4: an order this handler was paid for is not marked withdrawn");
            }
        }
    }

    /// @notice QINV5 — AN ORDER'S OWNER IS SET ONCE AND NEVER MOVES. Every payout goes to `o.owner`, so if
    ///         it could change, the escrow could be redirected without touching a balance.
    function invariant_QINV5_orderOwnersAreImmutable() public view {
        uint256 n = handler.ghostCount();
        for (uint256 i = 0; i < n; i++) {
            QueueHandler.Ghost memory g = handler.ghostAt(i);
            (address owner,, uint128 amountIn,) = queue.orders(g.epoch, g.index);
            assertEq(owner, g.owner, "QINV5: an order's owner changed after it was placed");
            assertEq(amountIn, g.amountIn, "QINV5: an order's escrowed amount changed after it was placed");
        }
    }

    /// @notice QINV6 — THE QUEUE DOES NOT HOARD. The mirror of QINV1, and the pair is what pins the
    ///         accounting exactly: QINV1 says it never holds LESS than it owes, this says it never holds
    ///         meaningfully MORE. A contract that quietly keeps value is how S-1 worked — a short fill's
    ///         unconsumed input was burned into the contract where no claim, timeout or sweep could reach
    ///         it, and every balance-side assertion still passed because the money was simply *there*.
    ///
    /// @dev The tolerance is per-order dust, not a fudge factor: every pro-rata payout is a `mulDiv` that
    ///      rounds DOWN, deliberately, so the contract keeps at most one wei per claim rather than ever
    ///      overpaying the last claimer. Anything beyond that is retention.
    function invariant_QINV6_theQueueDoesNotRetainValue() public view {
        (uint256 owed0, uint256 owed1) = _owed();
        uint256 dust = handler.ghostCount() + 2;
        assertLe(t0.balanceOf(address(queue)), owed0 + dust, "QINV6: the queue is holding currency0 it owes nobody");
        assertLe(t1.balanceOf(address(queue)), owed1 + dust, "QINV6: the queue is holding currency1 it owes nobody");
    }

    /// @notice QINV7 — NO ORDER IS EVER PAID TWICE. Stated directly as well as via solvency, because the
    ///         two fail at different times: a double payout only breaches QINV1 once the queue has been
    ///         drained past what it still owes, which may be many calls later or never within a run. This
    ///         fires on the first one.
    function invariant_QINV7_noOrderIsEverPaidTwice() public view {
        assertEq(handler.doubleSpends(), 0, "QINV7: an already-paid order was paid a second time");
    }

    /// @notice QINV8 — ESCROW ONLY EVER MOVES ON ITS OWNER'S SAY-SO. Asserted directly, because a
    ///         successful theft shows up in the solvency invariants only later and indirectly, if at all —
    ///         the queue can be robbed and still hold enough to cover everyone who has not claimed yet.
    function invariant_QINV8_onlyTheOwnerCanMoveAnOrdersEscrow() public view {
        assertEq(handler.thefts(), 0, "QINV8: escrow moved for someone who did not own the order");
    }

    /* ------------------------------------------------------------------- non-vacuity */

    /// @notice A run that never settled, never timed out and never cancelled is not evidence about any of
    ///         them. This is a deterministic test rather than an `invariant_`/`afterInvariant` assertion
    ///         on purpose: Foundry evaluates invariants once immediately after setUp, before any call, so
    ///         a counter check there fails at call zero by construction — and `afterInvariant` is
    ///         incompatible with the shrinker, which minimises any failure to a single call that then
    ///         trivially "did nothing". Both traps are already recorded in this repo; this is the shape
    ///         that works.
    function test_theHandlerCanReachEveryPhaseOfTheQueue() public {
        // Drive one full lifecycle deterministically, then one abandoned epoch, and assert the handler's
        // own actions are the ones doing it.
        handler.place(0, true, 400e18, 0);
        handler.place(1, false, 300e18, 0);
        assertEq(handler.placed(), 2, "the handler could not place");

        handler.cancel(1, 0);
        assertEq(handler.cancelled(), 1, "the handler could not cancel an open order");

        handler.skipAhead(EPOCH + 10);
        handler.freeze(0);
        assertEq(handler.frozen(), 1, "the handler could not freeze");

        // NOT skipAhead: that one has a 600s FLOOR, so a "130s" argument becomes ~730s and would push the
        // next epoch past its own cutoff. Short waits go through skipShort.
        handler.skipShort(FREEZE + 10);
        handler.settle(0, 0);
        assertEq(handler.settled(), 1, "the handler could not settle");

        handler.claim(0, 0);
        assertEq(handler.claimed(), 1, "the handler could not claim a settled order");

        // A second epoch that nobody settles must still reach the escape hatch.
        handler.place(2, true, 500e18, 0);
        handler.skipAhead(EPOCH + 10);
        handler.freeze(0);
        handler.skipAhead(LIFE + 10);
        handler.timeout(1, 0);
        assertEq(handler.timedOut(), 1, "the handler could not time out an abandoned epoch");

        handler.claim(2, 0);
        assertEq(handler.claimed(), 2, "the handler could not reclaim after a timeout");

        invariant_QINV1_queueHoldsAtLeastWhatItOwes();
        invariant_QINV3_epochTotalsMatchTheirOrders();
    }
}

/// @notice The same world with a TIGHT residual bound, so the settlement path that REFUSES the swap and
///         returns the unmatched remainder in kind (Q-3) is the one actually being fuzzed.
///
/// This exists because of a specific miss. With the wide bound above, the residual always executes, so
/// `ep.refund0`/`refund1` were never written in 16,384 calls — and deleting the lines that write them
/// survived the entire campaign. The invariants were fine; the WORLD could not reach the code. Same
/// lesson as the deep custody run that fuzzed a build with every keeper bound disabled.
contract InvariantQueueTightBound is InvariantQueue {
    function _residualBps() internal pure override returns (uint16) {
        return 50; // 0.5% — most residuals in this world cannot execute, so they come back in kind
    }

    /// @notice Non-vacuity for THIS world specifically: if nothing ever gets refunded in kind here, the
    ///         world is not doing the job it was added for, and its green means nothing.
    function test_thisWorldActuallyReachesTheInKindRefundPath() public {
        handler.place(0, true, 4_000e18, 0);
        handler.place(1, false, 50e18, 0);
        handler.skipAhead(EPOCH + 10);
        handler.freeze(0);
        handler.skipShort(FREEZE + 10);

        // Strict window: the residual is far too big for a 0.5% bound, so settlement refuses outright.
        handler.settle(0, 0);
        assertEq(handler.settled(), 0, "premise: this residual must NOT be settleable inside the bound");

        // Past the deadline it resolves anyway, with the unmatched part booked back in kind.
        handler.skipAhead(LIFE + 10);
        handler.settle(0, 0);
        assertEq(handler.settled(), 1, "the deadline did not resolve the batch");

        (,,,,,, uint128 refund0,) = queue.epochs(0);
        assertGt(refund0, 0, "this world never books an in-kind refund -- it tests the same path as the other");

        invariant_QINV1_queueHoldsAtLeastWhatItOwes();
        invariant_QINV6_theQueueDoesNotRetainValue();
    }
}
