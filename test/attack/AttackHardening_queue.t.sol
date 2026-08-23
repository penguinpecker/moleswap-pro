// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {MoleQueue} from "../../src/MoleQueue.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  MoleQueue's settlement arithmetic against things that are NOT orders (P-73 "donation
           immunity"), the freeze cutoff against things that arrive after it (B8 "post-freeze
           immunity"), and the pro-rata payout under a dust grind (Bunni class, queue edition).
  Lens:    A batch's clearing price and each order's share of it must be a function of the epoch's
           ORDERS and nothing else. So: gift the queue tokens, gift it ERC-6909 claims, donate to the
           pool underneath it, place and cancel around the cutoff second, stuff the NEXT epoch with a
           whale — and settle the epoch under test against a byte-identical control world.

  RESULT: HOLDS. Every payout is identical to the control to the wei; a gift to the queue is neither
  distributed nor stolen (it stays where it was put); nothing enters or leaves a frozen epoch; a
  hundred indivisible orders against one whale all claim successfully and the queue keeps at most
  one wei of dust per order. Mutations (each run, each RED; see HARDENING-FINDINGS.md): delete the
  `_phase(e) != Phase.Open` check in `cancel` or in `place` -> the post-freeze tests go RED; round the
  0-side claim share UP (`mulDivRoundingUp`) -> the dust grind goes RED.
//////////////////////////////////////////////////////////////////////////////*/
contract AttackHardeningQueue is HardeningBase {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _buildWorld(0);
    }

    /* ------------------------------------------------------------------ helpers */

    function _freezeAndSettle(uint64 e) internal {
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);
        queue.settle(e);
    }

    /// @dev A control run: alice 100 t0, bob 40 t1 -> settled -> both claimed. Returns what each got
    ///      and the dust the queue kept. Run under a snapshot so the world is untouched afterwards.
    function _control() internal returns (uint256 aOut, uint256 bOut, uint256 dust0, uint256 dust1) {
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(bob);
        queue.place(false, 40e18);
        _freezeAndSettle(0);
        (, uint256 a1) = _bal(alice);
        (uint256 b0,) = _bal(bob);
        vm.prank(alice);
        queue.claim(0, 0);
        vm.prank(bob);
        queue.claim(0, 1);
        (, uint256 a1b) = _bal(alice);
        (uint256 b0b,) = _bal(bob);
        aOut = a1b - a1;
        bOut = b0b - b0;
        dust0 = t0.balanceOf(address(queue));
        dust1 = t1.balanceOf(address(queue));
        vm.revertToState(snap);
    }

    function _placeBoth() internal {
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(bob);
        queue.place(false, 40e18);
    }

    function _claimBoth() internal returns (uint256 aOut, uint256 bOut) {
        (, uint256 a1) = _bal(alice);
        (uint256 b0,) = _bal(bob);
        vm.prank(alice);
        queue.claim(0, 0);
        vm.prank(bob);
        queue.claim(0, 1);
        (, uint256 a1b) = _bal(alice);
        (uint256 b0b,) = _bal(bob);
        aOut = a1b - a1;
        bOut = b0b - b0;
    }

    /* ================================================================ 1. donation immunity */

    /// @notice Tokens sent straight to the queue after the freeze change no payout, and are not paid out
    ///         to anyone either: after both claims the queue holds exactly the control's dust PLUS the
    ///         gift. A gift is inert, not a backdoor.
    function test_donation_directTransferToTheQueueChangesNoPayoutAndIsNotDistributed() public {
        (uint256 cA, uint256 cB, uint256 cD0, uint256 cD1) = _control();

        _placeBoth();
        _advance(EPOCH_DURATION);
        queue.freeze();
        vm.startPrank(mallory);
        t0.transfer(address(queue), 7e18);
        t1.transfer(address(queue), 3e18);
        vm.stopPrank();
        _advance(FREEZE_DURATION);
        queue.settle(0);

        (uint256 aOut, uint256 bOut) = _claimBoth();
        assertEq(aOut, cA, "a gift to the queue changed alice's payout");
        assertEq(bOut, cB, "a gift to the queue changed bob's payout");
        assertEq(t0.balanceOf(address(queue)), cD0 + 7e18, "the gift (t0) was distributed or lost");
        assertEq(t1.balanceOf(address(queue)), cD1 + 3e18, "the gift (t1) was distributed or lost");
    }

    /// @notice A `donate()` to the pool underneath the queue, between freeze and settle, changes no
    ///         payout: it moves fee growth, not price, and the crossing reads the TWAP.
    function test_donation_poolDonateBeforeSettleChangesNoPayout() public {
        (uint256 cA, uint256 cB, uint256 cD0, uint256 cD1) = _control();

        _placeBoth();
        _advance(EPOCH_DURATION);
        queue.freeze();
        donateRouter.donate(hookKey, 1e18, 1e18, ZERO_BYTES);
        _advance(FREEZE_DURATION);
        queue.settle(0);

        (uint256 aOut, uint256 bOut) = _claimBoth();
        assertEq(aOut, cA, "a pool donation changed alice's payout");
        assertEq(bOut, cB, "a pool donation changed bob's payout");
        assertEq(t0.balanceOf(address(queue)), cD0, "queue dust (t0) changed");
        assertEq(t1.balanceOf(address(queue)), cD1, "queue dust (t1) changed");
    }

    /// @notice ERC-6909 claims gifted to the queue are never read: payouts are identical, and the claims
    ///         simply sit there.
    function test_donation_erc6909ClaimsGiftedToTheQueueChangeNothing() public {
        (uint256 cA, uint256 cB, uint256 cD0, uint256 cD1) = _control();

        _placeBoth();
        _advance(EPOCH_DURATION);
        queue.freeze();
        // Mint claims to ourselves, then gift them to the queue as plain ERC-6909 transfers.
        claimsRouter.deposit(currency0, address(this), 5e18);
        claimsRouter.deposit(currency1, address(this), 5e18);
        manager.transfer(address(queue), currency0.toId(), 5e18);
        manager.transfer(address(queue), currency1.toId(), 5e18);
        assertEq(manager.balanceOf(address(queue), currency0.toId()), 5e18, "premise: gift not credited");
        _advance(FREEZE_DURATION);
        queue.settle(0);

        (uint256 aOut, uint256 bOut) = _claimBoth();
        assertEq(aOut, cA, "gifted claims changed alice's payout");
        assertEq(bOut, cB, "gifted claims changed bob's payout");
        assertEq(t0.balanceOf(address(queue)), cD0, "queue dust (t0) changed");
        assertEq(t1.balanceOf(address(queue)), cD1, "queue dust (t1) changed");
        assertEq(manager.balanceOf(address(queue), currency0.toId()), 5e18, "the gifted claims were spent");
        assertEq(manager.balanceOf(address(queue), currency1.toId()), 5e18, "the gifted claims were spent");
    }

    /* ================================================================ 2. post-freeze immunity */

    /// @notice After the cutoff nothing enters or leaves the epoch: place and cancel are refused before
    ///         `freeze()` is even called; after it, a place lands in the NEXT epoch and a cancel is still
    ///         refused; a whale in the next epoch changes nothing about this one's settlement.
    function test_postFreeze_nothingEntersOrLeavesTheFrozenEpoch() public {
        (uint256 cA, uint256 cB,,) = _control();

        _placeBoth();
        (,, uint128 in0, uint128 in1,,,,) = queue.epochs(0);
        uint256 count = queue.orderCount(0);

        // Past the cutoff, before anyone presses freeze(): closed both ways, on the clock alone.
        _advance(EPOCH_DURATION);
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.place(true, 1e18);
        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, 0);

        queue.freeze();

        // After freeze(): a place goes to epoch 1, epoch 0 is untouched, cancel still refused.
        vm.prank(mallory);
        uint256 idx = queue.place(false, 5_000e18); // a whale on bob's side, in the NEXT epoch
        assertEq(queue.currentEpoch(), 1, "freeze did not open the next epoch");
        assertEq(queue.orderCount(0), count, "an order entered the frozen epoch");
        (,, uint128 in0b, uint128 in1b,,,,) = queue.epochs(0);
        assertEq(in0b, in0, "frozen totals (0) moved");
        assertEq(in1b, in1, "frozen totals (1) moved");
        vm.prank(bob);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, 1);

        _advance(FREEZE_DURATION);
        queue.settle(0);
        (uint256 aOut, uint256 bOut) = _claimBoth();
        assertEq(aOut, cA, "a whale in the next epoch changed alice's payout");
        assertEq(bOut, cB, "a whale in the next epoch changed bob's payout");

        // And the whale's order is exactly where it was put, cancellable in its own epoch.
        vm.prank(mallory);
        queue.cancel(1, idx);
    }

    /// @notice The cutoff is a single second: one second before it a cancel is free, AT it a cancel is
    ///         refused. The boundary itself is pinned, not just the direction.
    function test_postFreeze_theCutoffSecondItselfIsClosed() public {
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(alice);
        queue.place(true, 1e18);
        uint256 cutoff = uint256(queue.epochStartedAt()) + EPOCH_DURATION;

        vm.warp(cutoff - 1);
        vm.prank(alice);
        queue.cancel(0, 1); // free
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Open), "premise: not open one second before");

        vm.warp(cutoff);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Frozen), "the cutoff second reads Open");
        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, 0);
        vm.prank(mallory);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.place(true, 1e18);
    }

    /* ================================================================ 3. dust grind */

    /// @notice A hundred deliberately indivisible orders on one side against a single whale on the
    ///         other. Every one of the 101 claims must succeed — the last claimer is never starved —
    ///         the sum paid per side never exceeds that side's booked output, and the queue keeps at most
    ///         one wei per order of rounding dust. Rounding falls toward the CONTRACT, never toward a
    ///         claimant.
    function test_dustGrind_aHundredIndivisibleOrdersAgainstOneWhale_everyClaimPaysAndNothingOverpays() public {
        uint256 n = 100;
        address[] memory dusters = new address[](n);
        uint256[] memory sizes = new uint256[](n);
        uint256 totalDust;
        for (uint256 i; i < n; ++i) {
            dusters[i] = address(uint160(uint256(keccak256(abi.encode("duster", i)))));
            // Prime-ish, odd, non-aligned sizes so pro-rata rounding bites on every one of them.
            sizes[i] = 1e15 + (i * 7_919 + 13) * 1e9 + (i % 7) + 1;
            t0.mint(dusters[i], sizes[i]);
            vm.startPrank(dusters[i]);
            t0.approve(address(queue), type(uint256).max);
            queue.place(true, uint128(sizes[i]));
            vm.stopPrank();
            totalDust += sizes[i];
        }
        vm.prank(bob);
        uint256 whaleIdx = queue.place(false, 300e18); // more than enough to absorb every dust order at TWAP

        _freezeAndSettle(0);
        (,, uint128 in0, uint128 in1, uint128 out0, uint128 out1,,) = queue.epochs(0);
        assertEq(in0, totalDust, "premise: dust total");
        assertEq(in1, 300e18, "premise: whale total");

        uint256 paid1;
        for (uint256 i; i < n; ++i) {
            uint256 before = t1.balanceOf(dusters[i]);
            vm.prank(dusters[i]);
            queue.claim(0, i); // must not revert, for any of them
            paid1 += t1.balanceOf(dusters[i]) - before;
        }
        (uint256 b0,) = _bal(bob);
        vm.prank(bob);
        queue.claim(0, whaleIdx);
        (uint256 b0b,) = _bal(bob);
        uint256 paid0 = b0b - b0;

        assertLe(paid1, out0, "the dust side was paid MORE than its booked output");
        assertLe(paid0, out1, "the whale was paid MORE than its booked output");
        assertLe(out0 - paid1, n, "more than one wei of rounding dust per order was kept (t1)");
        assertLe(out1 - paid0, 1, "more than one wei of rounding dust was kept on the whale's side (t0)");
        // What the queue still holds is exactly the rounding dust and nothing else.
        assertEq(t1.balanceOf(address(queue)), out0 - paid1, "queue holds t1 beyond the rounding dust");
        assertEq(t0.balanceOf(address(queue)), out1 - paid0, "queue holds t0 beyond the rounding dust");
    }
}
