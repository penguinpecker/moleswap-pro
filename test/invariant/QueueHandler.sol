// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MoleQueue} from "../../src/MoleQueue.sol";

/// @title QueueHandler
/// @notice The fuzzer's hands for MoleQueue. Every action a real participant or bystander can take, plus
///         the two things that make the world hostile: a third party moving the pool, and time passing.
///
/// WHAT THIS EXISTS TO CATCH. The queue holds other people's money between two transactions, which is the
/// one thing the rest of this protocol deliberately avoids — MolePositions custodies nothing, and INV-1
/// asserts exactly that. Escrow cannot make that claim, so it needs the opposite kind of invariant: not
/// "the contract holds nothing" but "the contract holds AT LEAST what it owes, always, under every
/// interleaving of place / cancel / freeze / settle / timeout / claim that the fuzzer can find."
///
/// GHOST STATE IS THE POINT. The contract's own view of what it owes is the thing under test, so it cannot
/// also be the oracle. This handler keeps its own independent record of every order it placed and every
/// payout it received, and the invariants compare the two.
///
/// TIME MOVES ON PURPOSE. `_advance` moves an explicit accumulating clock and the L1 height together —
/// `vm.warp(block.timestamp + d)` does NOT accumulate inside a call frame (solc caches block.timestamp),
/// a trap this repo has now walked into three times. Without real time the epoch machine never turns over
/// and the fuzzer would test one Open epoch forever.
contract QueueHandler is CommonBase, StdCheats, StdUtils {
    MoleQueue public immutable queue;
    IPoolManager public immutable manager;
    PoolSwapTest public immutable swapRouter;
    PoolKey internal key;
    MockERC20 public immutable t0;
    MockERC20 public immutable t1;

    address[4] public actors;

    /// @dev The handler's independent ledger of every order ever placed.
    struct Ghost {
        uint64 epoch;
        uint256 index;
        address owner;
        bool zeroForOne;
        uint128 amountIn;
        bool settledOut; // this handler has taken its payout
        /// @dev CANCELLED, specifically — not merely withdrawn. The two cannot be told apart from the
        ///      contract's `withdrawn` flag afterwards, and they mean opposite things to the epoch
        ///      totals: a cancel un-books the escrow, a claim leaves the denominator alone forever so
        ///      that claims stay independent of each other. QINV3 needs the distinction, so the ledger
        ///      records which one actually happened.
        bool cancelledOut;
    }

    Ghost[] public ghosts;

    /// @dev Cumulative, for the conservation invariant. Measured from the handler's side of the wall.
    uint256 public totalEscrowed0;
    uint256 public totalEscrowed1;
    uint256 public totalPaidOut0;
    uint256 public totalPaidOut1;

    // Non-vacuity counters. A run that never settled anything is not evidence about settlement.
    uint256 public placed;
    uint256 public cancelled;
    uint256 public claimed;
    uint256 public settled;
    uint256 public timedOut;
    uint256 public frozen;
    /// @dev Must stay ZERO. Any non-zero value means an order was paid twice.
    uint256 public doubleSpends;
    /// @dev Must stay ZERO. Any non-zero value means escrow moved on someone else's say-so.
    uint256 public thefts;

    uint256 internal _clock;
    uint256 internal _height;

    constructor(
        MoleQueue _queue,
        IPoolManager _manager,
        PoolSwapTest _swapRouter,
        PoolKey memory _key,
        address[4] memory _actors
    ) {
        queue = _queue;
        manager = _manager;
        swapRouter = _swapRouter;
        key = _key;
        actors = _actors;
        t0 = MockERC20(Currency.unwrap(_key.currency0));
        t1 = MockERC20(Currency.unwrap(_key.currency1));
        _clock = block.timestamp;
        _height = block.number;
    }

    function ghostCount() external view returns (uint256) {
        return ghosts.length;
    }

    function ghostAt(uint256 i) external view returns (Ghost memory) {
        return ghosts[i];
    }

    /// @dev RH pacing: ~12 seconds of Ethereum height per wall-clock 12s, because `block.number` on this
    ///      chain is the L1 height. Moving one without the other is what made an earlier deep run
    ///      unable to reach any L1-denominated bound at all.
    function _advance(uint256 s) internal {
        _clock += s;
        _height += 1 + s / 12;
        vm.warp(_clock);
        vm.roll(_height);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /* ------------------------------------------------------------------ actions */

    function place(uint256 actorSeed, bool zeroForOne, uint256 amountSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 200));
        address who = _actor(actorSeed);
        uint128 amount = uint128(bound(amountSeed, 1e12, 5_000e18));

        MockERC20 tok = zeroForOne ? t0 : t1;
        if (tok.balanceOf(who) < amount) return;

        vm.startPrank(who);
        tok.approve(address(queue), amount);
        try queue.place(zeroForOne, amount) returns (uint256 idx) {
            ghosts.push(
                Ghost({
                    epoch: queue.currentEpoch(),
                    index: idx,
                    owner: who,
                    zeroForOne: zeroForOne,
                    amountIn: amount,
                    settledOut: false,
                    cancelledOut: false
                })
            );
            if (zeroForOne) totalEscrowed0 += amount;
            else totalEscrowed1 += amount;
            placed++;
        } catch {}
        vm.stopPrank();
    }

    function cancel(uint256 ghostSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 200));
        if (ghosts.length == 0) return;
        uint256 g = ghostSeed % ghosts.length;
        Ghost storage gh = ghosts[g];
        if (gh.settledOut) return;

        uint256 b0 = t0.balanceOf(gh.owner);
        uint256 b1 = t1.balanceOf(gh.owner);
        vm.prank(gh.owner);
        try queue.cancel(gh.epoch, gh.index) {
            gh.settledOut = true;
            gh.cancelledOut = true;
            totalPaidOut0 += t0.balanceOf(gh.owner) - b0;
            totalPaidOut1 += t1.balanceOf(gh.owner) - b1;
            cancelled++;
        } catch {}
    }

    function claim(uint256 ghostSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 400));
        if (ghosts.length == 0) return;
        uint256 g = ghostSeed % ghosts.length;
        Ghost storage gh = ghosts[g];
        if (gh.settledOut) return;

        uint256 b0 = t0.balanceOf(gh.owner);
        uint256 b1 = t1.balanceOf(gh.owner);
        vm.prank(gh.owner);
        try queue.claim(gh.epoch, gh.index) {
            gh.settledOut = true;
            totalPaidOut0 += t0.balanceOf(gh.owner) - b0;
            totalPaidOut1 += t1.balanceOf(gh.owner) - b1;
            claimed++;
        } catch {}
    }

    /// @notice DELIBERATELY RE-ATTEMPT AN ALREADY-PAID ORDER. Without this the fuzzer could never even
    ///         TRY a double-spend: `claim` and `cancel` above both skip anything already marked paid, so
    ///         the one-shot `withdrawn` flag was never actually exercised and deleting it survived a full
    ///         16,384-call campaign. The ledger that keeps the invariants honest was also stopping the
    ///         fuzzer from attacking. If a repeat succeeds, the payout is recorded like any other and the
    ///         solvency invariant is what must notice.
    function claimAgain(uint256 ghostSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 200));
        if (ghosts.length == 0) return;
        uint256 g = ghostSeed % ghosts.length;
        Ghost storage gh = ghosts[g];
        if (!gh.settledOut) return; // only interesting for orders already paid

        uint256 b0 = t0.balanceOf(gh.owner);
        uint256 b1 = t1.balanceOf(gh.owner);
        vm.prank(gh.owner);
        try queue.claim(gh.epoch, gh.index) {
            totalPaidOut0 += t0.balanceOf(gh.owner) - b0;
            totalPaidOut1 += t1.balanceOf(gh.owner) - b1;
            doubleSpends++;
        } catch {}

        vm.prank(gh.owner);
        try queue.cancel(gh.epoch, gh.index) {
            totalPaidOut0 += t0.balanceOf(gh.owner) - b0;
            totalPaidOut1 += t1.balanceOf(gh.owner) - b1;
            doubleSpends++;
        } catch {}
    }

    /// @notice A STRANGER TRIES TO TAKE SOMEBODY ELSE'S ESCROW. Every payout in this contract goes to
    ///         `o.owner`, so the owner check is the only thing between a queued deposit and anyone who
    ///         can read an epoch number off a log. The fuzzer could not attack it before this action
    ///         existed, because every other one pranks the rightful owner.
    ///
    ///         Two attackers, because they have different powers: an address with no order at all, and a
    ///         CO-PARTICIPANT, who has a real motive — cancelling the other side reshapes the residual
    ///         that everybody else settles against.
    function strangerGrab(uint256 ghostSeed, uint256 attackerSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 300));
        if (ghosts.length == 0) return;
        Ghost storage gh = ghosts[ghostSeed % ghosts.length];

        address attacker = attackerSeed % 2 == 0 ? address(uint160(0xBAD)) : _actor(attackerSeed);
        if (attacker == gh.owner) return;

        uint256 a0 = t0.balanceOf(attacker);
        uint256 a1 = t1.balanceOf(attacker);

        vm.prank(attacker);
        try queue.claim(gh.epoch, gh.index) {
            thefts++;
        } catch {}
        vm.prank(attacker);
        try queue.cancel(gh.epoch, gh.index) {
            thefts++;
        } catch {}

        if (t0.balanceOf(attacker) != a0 || t1.balanceOf(attacker) != a1) thefts++;
    }

    /// @dev Permissionless on purpose, and driven by an address with no order in the book — a settlement
    ///      only participants can trigger is one that stops happening.
    function freeze(uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 400));
        try queue.freeze() {
            frozen++;
        } catch {}
    }

    function settle(uint256 epochSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 900));
        uint64 e = uint64(bound(epochSeed, 0, queue.currentEpoch()));
        try queue.settle(e) {
            settled++;
        } catch {}
    }

    function timeout(uint256 epochSeed, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 2000));
        uint64 e = uint64(bound(epochSeed, 0, queue.currentEpoch()));
        try queue.timeout(e) {
            timedOut++;
        } catch {}
    }

    /// @dev A third party moving the price. This is the adversary the TWAP band and the residual bound
    ///      exist for, and without it every settlement in the run would happen at a quiet pool.
    function poolSwap(uint256 amountSeed, bool zeroForOne, uint256 warpSeed) external {
        _advance(bound(warpSeed, 0, 300));
        uint256 amount = bound(amountSeed, 1e15, 20_000e18);
        address who = actors[0];
        MockERC20 tok = zeroForOne ? t0 : t1;
        if (tok.balanceOf(who) < amount) return;
        vm.startPrank(who);
        tok.approve(address(swapRouter), amount);
        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {} catch {}
        vm.stopPrank();
    }

    /// @dev Long jumps, so deadlines and timeouts are reachable inside a 256-call sequence.
    function skipAhead(uint256 warpSeed) external {
        _advance(bound(warpSeed, 600, 5000));
    }

    /// @dev Short jumps. Separate from `skipAhead` because that one has a 600s FLOOR — passing it a small
    ///      number does not produce a small wait, it maps into [600, 5000]. That bit me writing the
    ///      lifecycle test: a 130s wait became ~730s, pushed the epoch past its own cutoff, and the next
    ///      `place` failed with WrongPhase for a reason that had nothing to do with the contract.
    function skipShort(uint256 warpSeed) external {
        _advance(bound(warpSeed, 1, 500));
    }
}
