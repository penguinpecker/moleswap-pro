// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {MoleQueue} from "../../src/MoleQueue.sol";
import {ZapLogic} from "../../src/libraries/ZapLogic.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";
import {TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  the ERC-6909 surface of the PoolManager, as seen from MolePositions, MoleQueue, MoleRouter
           and MoleHook (dossier Part 2 §9; P-73 "setOperator never").
  Lens:    "An operator approval on the PoolManager is a blanket key to every claim balance the
            approver holds. A compromised keeper or router with operator status could move claim
            tokens." So: after EVERY flow of every contract, no address is an ERC-6909 operator FOR
            any of our contracts, no per-id allowance exists FROM any of our contracts, and none of
            the three custody-adjacent contracts holds a claim at all. Then the keeper is handed the
            one claim balance that does exist — the treasury's performance-fee claims — and tries to
            move it without being an operator. It cannot.

  RESULT: HOLDS on every flow. Mutation-verified by INJECTION rather than deletion (there is no guard
  to delete — the property is the ABSENCE of a call): a `poolManager.setOperator(keeper, true)` placed
  in MolePositions.unlockCallback, a `poolManager.approve(...)` in MoleQueue.unlockCallback and a
  `setOperator` in MoleRouter.unlockCallback each turn the corresponding flow's assertion RED.
//////////////////////////////////////////////////////////////////////////////*/
contract AttackHardeningNoOperator is HardeningBase {
    using PoolIdLibrary for PoolKey;

    address[] internal candidates;
    address[] internal ours;

    uint256 internal aliceId;

    function setUp() public {
        // Performance fee ON, so the treasury really does accrue claims — the keeper's attempt to
        // move them below is then an attempt against a non-zero balance.
        _buildWorld(1000);

        candidates.push(KEEPER);
        candidates.push(TREASURY);
        candidates.push(TEST_UPGRADE_ADMIN);
        candidates.push(mallory);
        candidates.push(alice);
        candidates.push(address(this));
        candidates.push(address(manager));
        candidates.push(address(0));
        candidates.push(address(vault));
        candidates.push(address(queue));
        candidates.push(address(router));
        candidates.push(address(hook));

        ours.push(address(vault));
        ours.push(address(queue));
        ours.push(address(router));
        ours.push(address(hook));

        aliceId = _open(alice, -600, 600, 100e18);
    }

    /// @dev THE ASSERTION. For every one of our contracts C and every candidate S: S is not an operator
    ///      for C, C has granted S no per-id allowance on either currency, and C holds no claims.
    function _assertNoGrants(string memory when) internal view {
        uint256 id0 = currency0.toId();
        uint256 id1 = currency1.toId();
        for (uint256 i; i < ours.length; ++i) {
            address c = ours[i];
            for (uint256 j; j < candidates.length; ++j) {
                address s = candidates[j];
                assertFalse(manager.isOperator(c, s), string.concat("an ERC-6909 operator was granted: ", when));
                assertEq(manager.allowance(c, s, id0), 0, string.concat("a 6909 allowance (c0) was granted: ", when));
                assertEq(manager.allowance(c, s, id1), 0, string.concat("a 6909 allowance (c1) was granted: ", when));
            }
            assertEq(manager.balanceOf(c, id0), 0, string.concat("one of ours holds 6909 claims (c0): ", when));
            assertEq(manager.balanceOf(c, id1), 0, string.concat("one of ours holds 6909 claims (c1): ", when));
        }
    }

    function _zp(uint256 amountIn, uint256 swapAmount) internal view returns (ZapLogic.ZapParams memory) {
        return ZapLogic.ZapParams({
            key: hookKey,
            tickLower: -6000,
            tickUpper: 6000,
            zeroForOne: true,
            amountIn: amountIn,
            swapAmount: swapAmount,
            minLiquidity: 1,
            amountOutMin: 0
        });
    }

    /* ================================================================ the vault's flows */

    function test_vault_noGrantAfterEveryFlow() public {
        _assertNoGrants("fresh world");

        _open(bob, -1200, 1200, 50e18);
        _assertNoGrants("after open");

        vm.prank(bob);
        uint256 zid = vault.zapOpen(_zp(10e18, 4e18), block.timestamp);
        _assertNoGrants("after zapOpen");

        // Trade so fees accrue and the performance-fee path actually mints claims to the treasury.
        _advance(120);
        _swap(hookKey, true, 500e18);
        _advance(120);
        _swap(hookKey, false, 500e18);

        vm.prank(KEEPER);
        vault.rebalance(aliceId, -660, 540);
        _assertNoGrants("after a fee-bearing rebalance");

        vm.prank(alice);
        vault.withdraw(aliceId, 1e18);
        _assertNoGrants("after a partial withdraw");

        vm.prank(bob);
        vault.withdrawAll(zid);
        _assertNoGrants("after withdrawAll");

        assertGt(
            manager.balanceOf(TREASURY, currency0.toId()) + manager.balanceOf(TREASURY, currency1.toId()),
            0,
            "premise: the treasury never accrued a claim, so the keeper attempt below is vacuous"
        );
    }

    /* ================================================================ the queue's flows */

    function test_queue_noGrantAfterEveryFlow() public {
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(bob);
        queue.place(false, 40e18);
        vm.prank(mallory);
        uint256 cIdx = queue.place(true, 5e18);
        _assertNoGrants("after place");

        vm.prank(mallory);
        queue.cancel(0, cIdx);
        _assertNoGrants("after cancel");

        _advance(EPOCH_DURATION);
        queue.freeze();
        _assertNoGrants("after freeze");

        _advance(FREEZE_DURATION);
        queue.settle(0);
        _assertNoGrants("after settle (crossed + residual swap)");

        vm.prank(alice);
        queue.claim(0, 0);
        vm.prank(bob);
        queue.claim(0, 1);
        _assertNoGrants("after claims");

        // And the timeout path.
        vm.prank(alice);
        queue.place(true, 1e18);
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION + MAX_EPOCH_LIFE);
        queue.timeout(1);
        vm.prank(alice);
        queue.claim(1, 0);
        _assertNoGrants("after timeout + reclaim");
    }

    /* ================================================================ the router's flow */

    function test_router_noGrantAfterAV4Swap() public {
        vm.prank(alice);
        router.swap(_v4Plan(true, 10e18, 1, alice));
        _assertNoGrants("after a v4 swap");
        vm.prank(alice);
        router.swap(_v4Plan(false, 10e18, 1, bob));
        _assertNoGrants("after a v4 swap the other way");
    }

    /* ================================================================ the keeper vs the claims */

    /// @notice The only claim balance in the system belongs to the TREASURY. The keeper — the one hot
    ///         key with any power here — is not an operator for it and holds no allowance on it, so
    ///         every way of moving those claims is refused. Operator status is something only the
    ///         claim HOLDER can grant, and the holder never does.
    function test_keeperCannotMoveTheTreasurysClaimsWithoutOperatorStatus() public {
        _advance(120);
        _swap(hookKey, true, 500e18);
        _advance(120);
        _swap(hookKey, false, 500e18);
        vm.prank(KEEPER);
        vault.rebalance(aliceId, -660, 540);

        uint256 id0 = currency0.toId();
        uint256 claims = manager.balanceOf(TREASURY, id0);
        assertGt(claims, 0, "premise: no claims to attack");

        assertFalse(manager.isOperator(TREASURY, KEEPER), "keeper is an operator for the treasury");
        assertEq(manager.allowance(TREASURY, KEEPER, id0), 0, "keeper holds a claim allowance");

        vm.startPrank(KEEPER);
        vm.expectRevert();
        manager.transferFrom(TREASURY, KEEPER, id0, claims);
        vm.expectRevert();
        manager.transferFrom(TREASURY, KEEPER, id0, 1);
        // Nor can the keeper grant ITSELF the power: setOperator binds msg.sender only.
        manager.setOperator(KEEPER, true);
        vm.stopPrank();
        assertFalse(manager.isOperator(TREASURY, KEEPER), "keeper became an operator for the treasury");
        assertEq(manager.balanceOf(TREASURY, id0), claims, "the treasury's claims moved");
        assertEq(manager.balanceOf(KEEPER, id0), 0, "the keeper received claims");
    }
}
