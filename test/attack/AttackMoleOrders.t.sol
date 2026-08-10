// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleOrders} from "../../src/MoleOrders.sol";

/// Attacks on MoleOrders. The claim under test:
///   "a keeper can TRIGGER my order but can never steal from it — output goes only to me, bounded by my
///    budget and price floor and DCA interval, and a wrong-logic upgrade is impossible."
/// Each test tries to break one clause.
contract AttackMoleOrders is Test, Deployers {
    MoleRouter internal router;
    MoleOrders internal book;
    MockERC20 internal tokenA; // input
    MockERC20 internal tokenB; // output
    PoolKey internal key_;

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal admin = makeAddr("admin");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        deployFreshManagerAndRouters();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        if (address(tokenA) > address(tokenB)) (tokenA, tokenB) = (tokenB, tokenA);

        router = new MoleRouter(manager, makeAddr("weth"), address(0), address(0)); // feeless for clean math
        book = new MoleOrders(router, admin, keeper);

        key_ = PoolKey({
            currency0: Currency.wrap(address(tokenA)),
            currency1: Currency.wrap(address(tokenB)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        manager.initialize(key_, SQRT_PRICE_1_1);
        tokenA.mint(address(this), 500_000e18);
        tokenB.mint(address(this), 500_000e18);
        tokenA.approve(address(modifyLiquidityRouter), type(uint256).max);
        tokenB.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            key_, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200_000e18, salt: 0}), ""
        );

        // Owner funds + approves the order book (NOT the router — the book pulls, then routes).
        tokenA.mint(owner, 100e18);
        vm.prank(owner);
        tokenA.approve(address(book), type(uint256).max);
    }

    function _plan(address recipient, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.UniswapV4, pool: address(0), zeroForOne: true,
            tokenIn: address(tokenA), tokenOut: address(tokenB), key: key_
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});
        plan = MoleRouter.SwapPlan({
            tokenIn: address(tokenA), tokenOut: address(tokenB), amountIn: amountIn, minAmountOut: minOut,
            recipient: recipient, deadline: block.timestamp + 60, paths: paths
        });
    }

    function _dcaOrder() internal returns (uint256 id) {
        // 1e18/leg, 5e18 budget (5 legs), 6h interval, tiny floor.
        vm.prank(owner);
        id = book.createOrder(address(tokenA), address(tokenB), 1e18, 5e18, 1, 6 hours);
    }

    /* ─── happy path: output to the owner, budget decrements, zero residual ─── */

    function test_fillLeg_deliversToOwner_decrementsBudget_zeroResidual() public {
        uint256 id = _dcaOrder();
        uint256 ownerB0 = tokenB.balanceOf(owner);
        uint256 ownerA0 = tokenA.balanceOf(owner);

        vm.prank(keeper);
        uint256 out = book.fillLeg(id, _plan(owner, 1e18, 1));

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
        vm.prank(owner);
        uint256 id = book.createOrder(address(tokenA), address(tokenB), 1e18, 2.5e18, 1, 0);
        vm.startPrank(keeper);
        book.fillLeg(id, _plan(owner, 1e18, 1));
        book.fillLeg(id, _plan(owner, 1e18, 1));
        book.fillLeg(id, _plan(owner, 0.5e18, 1)); // final partial leg == remaining budget
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
        vm.prank(keeper);
        book.fillLeg(id, _plan(owner, 1e18, 1));
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.IntervalNotElapsed.selector);
        book.fillLeg(id, _plan(owner, 1e18, 1)); // too soon
        vm.warp(block.timestamp + 6 hours);
        vm.prank(keeper);
        book.fillLeg(id, _plan(owner, 1e18, 1)); // now allowed
    }

    /* ─── clause: the price floor IS the limit — a keeper can't fill below it ─── */

    function test_floorEnforced_isTheLimitPrice() public {
        // Discover an achievable output for a 1e18 swap.
        vm.prank(owner);
        uint256 probe = book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0);
        vm.prank(keeper);
        uint256 got = book.fillLeg(probe, _plan(owner, 1e18, 1));

        // LIMIT order, floor = an achievable `got`. The keeper must NOT be able to fill with a plan that
        // demands LESS than the floor — that is the "fill below my limit" attack, and it must revert on the
        // FLOOR (not merely on the router), so a plan.minAmountOut of 0 is the isolating case.
        // Floor = got/2, still achievable on the next swap of a deep pool.
        vm.prank(owner);
        uint256 id = book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, got / 2, 0);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.FloorNotMet.selector);
        book.fillLeg(id, _plan(owner, 1e18, 0)); // minOut 0 < floor -> rejected by the FLOOR

        // A plan that honours the floor still fills.
        vm.prank(keeper);
        uint256 out = book.fillLeg(id, _plan(owner, 1e18, got / 2));
        assertGe(out, got / 2, "a floor-honouring plan fills");
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
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.NotKeeper.selector);
        book.fillLeg(id, _plan(owner, 1e18, 1));
        vm.prank(newKeeper);
        book.fillLeg(id, _plan(owner, 1e18, 1)); // new keeper works
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
        book.createOrder(address(tokenA), address(tokenA), 1e18, 1e18, 1, 0); // same token
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(address(tokenA), address(tokenB), 0, 1e18, 1, 0); // zero leg
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(address(tokenA), address(tokenB), 2e18, 1e18, 1, 0); // budget < leg
        vm.expectRevert(MoleOrders.BadOrder.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 0, 0); // zero floor
        vm.stopPrank();
    }
}
