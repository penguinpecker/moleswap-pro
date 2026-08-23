// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleOrders} from "../../src/MoleOrders.sol";
import {OrdersWorld} from "../helpers/OrdersWorld.sol";

/// Attacks on MoleOrders. The claim under test:
///   "a keeper can TRIGGER my order but can never steal from it — output goes only to me, bounded by my
///    budget and price floor and DCA interval, and a wrong-logic upgrade is impossible."
/// Each test tries to break one clause.
///
/// WHAT CHANGED HERE, and why none of it is a weakening. The order's price floor used to be a single
/// stored constant; it is now the HIGHER of that constant and a live TWAP floor (see MoleOrders'
/// "THE PRICE BOUND" header), and orders therefore carry a reference pool. Two mechanical consequences:
///   - `createOrder` takes three more arguments, so `_createOrder` in the shared world supplies them;
///   - a plan can no longer be built with `minAmountOut = 1`, because 1 wei is no longer a legal floor for
///     a real leg. Every fill here now asks the CONTRACT what the current leg and its floor are
///     (`currentLeg`) and pins the plan to exactly that — which is also what the keeper service does.
/// No assertion was relaxed, and the two clauses that were about the floor itself
/// (`test_floorEnforced_isTheLimitPrice`) now pin BOTH halves of it rather than one.
contract AttackMoleOrders is OrdersWorld {
    function setUp() public {
        _buildWorld(address(0)); // feeless router, for clean math
    }

    function _dcaOrder() internal returns (uint256 id) {
        // 1e18/leg, 5e18 budget (5 legs), 6h interval, the client's own 1-wei absolute floor.
        id = _createOrder(1e18, 5e18, 1, 6 hours);
    }

    /* ─── happy path: output to the owner, budget decrements, nothing stranded ─── */

    function test_fillLeg_deliversToOwner_decrementsBudget_zeroResidual() public {
        uint256 id = _dcaOrder();
        uint256 ownerB0 = tokenB.balanceOf(owner);
        uint256 ownerA0 = tokenA.balanceOf(owner);

        MoleRouter.SwapPlan memory p = _honestPlan(id);
        vm.prank(keeper);
        uint256 out = book.fillLeg(id, p);

        assertGt(out, 0);
        assertEq(tokenB.balanceOf(owner) - ownerB0, out, "output must land on the owner");
        assertEq(ownerA0 - tokenA.balanceOf(owner), 1e18, "exactly one leg of input pulled");
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 1e18, "budget decremented by the leg");
        assertEq(tokenA.balanceOf(address(book)), 0, "no input stranded in the book");
        assertEq(tokenB.balanceOf(address(book)), 0, "no output stranded in the book");
    }

    /* ─── clause: keeper can't redirect the output ─── */

    function test_keeperCannotRedirectOutput() public {
        uint256 id = _dcaOrder();
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.RecipientNotOwner.selector);
        book.fillLeg(id, _plan(attacker, 1e18, 0)); // recipient = attacker
    }

    /* ─── clause: keeper can't overspend a leg or the budget ─── */

    function test_keeperCannotExceedAmountPerLeg() public {
        uint256 id = _dcaOrder();
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.PlanMismatch.selector);
        book.fillLeg(id, _plan(owner, 2e18, 0)); // more than amountPerLeg
    }

    function test_budgetCapsTotalSpend_thenCloses() public {
        // 1e18/leg, 2.5e18 budget => 2 full legs + a 0.5e18 final leg, interval 0 for speed.
        uint256 id = _createOrder(1e18, 2.5e18, 1, 0);
        vm.startPrank(keeper);
        book.fillLeg(id, _honestPlan(id));
        book.fillLeg(id, _honestPlan(id));
        book.fillLeg(id, _honestPlan(id)); // final partial leg == remaining budget
        vm.stopPrank();
        (,,,,, uint256 spent,,,, bool active) = book.orders(id);
        assertEq(spent, 2.5e18, "spent exactly the budget");
        assertFalse(active, "order closes when the budget is exhausted");
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.OrderInactive.selector);
        book.fillLeg(id, _plan(owner, 0.5e18, 1));
    }

    /* ─── clause: DCA interval spacing (can't drain in one block) ─── */

    function test_intervalEnforced() public {
        uint256 id = _dcaOrder(); // 6h interval
        MoleRouter.SwapPlan memory p = _honestPlan(id);
        vm.prank(keeper);
        book.fillLeg(id, p);
        p = _honestPlan(id);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.IntervalNotElapsed.selector);
        book.fillLeg(id, p); // too soon
        _advance(6 hours);
        p = _honestPlan(id);
        vm.prank(keeper);
        book.fillLeg(id, p); // now allowed
    }

    /* ─── clause: the price floor IS the limit — a keeper can't fill below it ─── */

    function test_floorEnforced_isTheLimitPrice() public {
        // Discover an achievable output for a 1e18 swap.
        uint256 probe = _createOrder(1e18, 1e18, 1, 0);
        MoleRouter.SwapPlan memory pp = _honestPlan(probe);
        vm.prank(keeper);
        uint256 got = book.fillLeg(probe, pp);

        // LIMIT order whose stored limit sits ABOVE the TWAP floor, so it is the stored half that binds
        // and this test measures the limit rather than the market. `got` is what the pool paid a moment
        // ago; 99.9% of it is above the 1%-below-TWAP market floor and still achievable next block.
        uint256 limit = (got * 999) / 1000;
        uint256 id = _createOrder(1e18, 1e18, limit, 0);
        (, uint256 floorOut) = book.currentLeg(id);
        assertEq(floorOut, limit, "the stored limit must be the binding half here");

        vm.prank(keeper);
        vm.expectRevert(MoleOrders.FloorNotMet.selector);
        book.fillLeg(id, _plan(owner, 1e18, 0)); // minOut 0 < floor -> rejected by the FLOOR

        // Anything under the limit is refused, including a plan that would clear the market floor.
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.FloorNotMet.selector);
        book.fillLeg(id, _plan(owner, 1e18, limit - 1));

        // A plan that honours the floor still fills.
        vm.prank(keeper);
        uint256 out = book.fillLeg(id, _plan(owner, 1e18, limit));
        assertGe(out, limit, "a floor-honouring plan fills");
    }

    /* ─── clause: keeper-only, owner-only ─── */

    function test_onlyKeeperFills() public {
        uint256 id = _dcaOrder();
        vm.prank(attacker);
        vm.expectRevert(MoleOrders.NotKeeper.selector);
        book.fillLeg(id, _plan(owner, 1e18, 1));
    }

    function test_onlyOwnerCancels() public {
        uint256 id = _dcaOrder();
        vm.prank(attacker);
        vm.expectRevert(MoleOrders.NotOrderOwner.selector);
        book.cancelOrder(id);
        vm.prank(owner);
        book.cancelOrder(id);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.OrderInactive.selector);
        book.fillLeg(id, _plan(owner, 1e18, 1));
    }

    /* ─── admin can rotate the keeper but not steal; logic is immutable ─── */

    function test_adminRotatesKeeper_oldKeeperLosesAccess() public {
        uint256 id = _dcaOrder();
        address newKeeper = makeAddr("newKeeper");
        vm.prank(admin);
        book.setKeeper(newKeeper);
        MoleRouter.SwapPlan memory p = _honestPlan(id);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.NotKeeper.selector);
        book.fillLeg(id, p);
        vm.prank(newKeeper);
        book.fillLeg(id, p); // new keeper works
    }

    function test_nonAdminCannotRotateKeeper() public {
        vm.prank(attacker);
        vm.expectRevert(MoleOrders.NotAdmin.selector);
        book.setKeeper(attacker);
    }

    /* ─── bad order params rejected at creation ─── */

    function test_createRejectsBadParams() public {
        vm.startPrank(owner);
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(
            address(tokenA), address(tokenA), 1e18, 1e18, 1, 0, oraclePool, TWAP_WINDOW, SLIP_BPS
        ); // same token
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(address(tokenA), address(tokenB), 0, 1e18, 1, 0, oraclePool, TWAP_WINDOW, SLIP_BPS); // zero leg
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(
            address(tokenA), address(tokenB), 2e18, 1e18, 1, 0, oraclePool, TWAP_WINDOW, SLIP_BPS
        ); // budget < leg
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 0, 0, oraclePool, TWAP_WINDOW, SLIP_BPS); // zero floor
        vm.stopPrank();
    }
}
