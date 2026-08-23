// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleOrders} from "../../src/MoleOrders.sol";
import {MoleFeeDial} from "../../src/MoleFeeDial.sol";
import {OrdersWorld} from "../helpers/OrdersWorld.sol";

/// F-02 mechanism C — the half of the CRITICAL that broke the honest path.
///
/// `fillLeg` used to assert `_balance(tokenIn) == inBefore` EXACTLY after the swap. MoleRouter, since the
/// fee moved to the input side, rescales every path by `mulDiv(path.amountIn, amountIn - fee, amountIn)`
/// rounding DOWN and returns the unrouted remainder to the payer — which for a keeper fill is MoleOrders.
/// So the router honouring its own documented zero-residual contract was precisely what made every
/// multi-path fill revert `Residual()`. The keeper's `simulateContract` swallowed it and logged "fill
/// skipped", so DCA and limit orders silently stopped progressing on exactly the split routes the
/// aggregator exists to produce, with no on-chain signal distinguishing that from "price not met".
///
/// Single-path plans are exact — `mulDiv(A, A-f, A) == A-f` — which is why the whole suite was green and
/// every `new MoleRouter.Path[](n)` in test/attack was n == 1. These are n == 2, against a LIVE fee dial
/// at the same 69 bps the deployed one carries.
contract AttackMoleOrdersResidual is OrdersWorld {
    MoleFeeDial internal dial;

    /// @dev The live dial's setting on Robinhood Chain at the time of the audit.
    uint16 internal constant FEE_BPS = 69;
    /// @dev The order's tolerance has to cover 69 bps of aggregator fee + 30 bps of pool fee + impact.
    uint16 internal constant SPLIT_SLIP_BPS = 300;

    function setUp() public {
        dial = new MoleFeeDial(address(this), FEE_BPS);
        _buildWorld(address(dial));
    }

    /// @dev The dust the router's rounding leaves for a given leg and split, computed independently of
    ///      the contract so the test knows what it is asserting rather than reading it back.
    function _expectedDust(uint256 legIn, uint256 firstShare) internal pure returns (uint256) {
        uint256 fee = (legIn * FEE_BPS) / 10_000;
        uint256 routable = legIn - fee;
        uint256 p0 = (firstShare * routable) / legIn;
        uint256 p1 = ((legIn - firstShare) * routable) / legIn;
        return routable - p0 - p1;
    }

    function test_twoPathFillSucceeds_andTheUnroutedWeiGoesBackToTheOwner() public {
        uint256 id = _createOrderWithSlip(100e18, 500e18, 1, 0, SPLIT_SLIP_BPS);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        uint256 firstShare = legIn / 3; // a 1/3 : 2/3 split — the shape the aggregator's splitter emits

        uint256 dust = _expectedDust(legIn, firstShare);
        assertEq(dust, 1, "the router's rounding really does leave a wei unrouted here");

        uint256 ownerA0 = tokenA.balanceOf(owner);
        uint256 ownerB0 = tokenB.balanceOf(owner);

        MoleRouter.SwapPlan memory p = _splitPlan(owner, legIn, floorOut, firstShare);
        vm.prank(keeper);
        uint256 out = book.fillLeg(id, p); // used to revert MoleOrders.Residual()

        assertGe(out, floorOut, "the split route cleared the floor");
        assertEq(tokenB.balanceOf(owner) - ownerB0, out, "all output landed on the owner");
        // The owner paid the leg MINUS the wei the router could not route — not the whole leg.
        assertEq(ownerA0 - tokenA.balanceOf(owner), legIn - dust, "owner charged only for what was routed");
        assertEq(tokenA.balanceOf(address(book)), 0, "no input stranded in the book");
        assertEq(tokenB.balanceOf(address(book)), 0, "no output stranded in the book");
    }

    function test_theBudgetIsChargedOnlyForWhatWasActuallyRouted() public {
        uint256 id = _createOrderWithSlip(100e18, 500e18, 1, 0, SPLIT_SLIP_BPS);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        uint256 firstShare = legIn / 3;
        uint256 dust = _expectedDust(legIn, firstShare);

        MoleRouter.SwapPlan memory p = _splitPlan(owner, legIn, floorOut, firstShare);
        vm.prank(keeper);
        book.fillLeg(id, p);

        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, legIn - dust, "the unrouted wei is not spent budget");
    }

    function test_aSplitRouteEmitsTheRefundSoTheDivergenceIsVisibleOnChain() public {
        uint256 id = _createOrderWithSlip(100e18, 500e18, 1, 0, SPLIT_SLIP_BPS);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        uint256 firstShare = legIn / 3;

        MoleRouter.SwapPlan memory p = _splitPlan(owner, legIn, floorOut, firstShare);
        vm.expectEmit(true, true, false, true, address(book));
        emit MoleOrders.LegRefunded(id, address(tokenA), _expectedDust(legIn, firstShare));
        vm.prank(keeper);
        book.fillLeg(id, p);
    }

    /// @notice The liveness claim in full: an order runs its whole schedule over split routes, which is
    ///         what it could never do before — the FIRST such fill used to revert.
    ///
    ///         Note the honest tail this fix creates and does not hide: because each leg is charged only
    ///         for what was routed, five legs consume five wei less than the budget, so the order finishes
    ///         its schedule holding a five-wei remainder rather than closing itself. That remainder is a
    ///         real leg with a real (non-zero, see mechanism D) floor, and the owner can cancel it. It is
    ///         dust arithmetic, not a stuck order: nothing reverts and nothing is stranded.
    function test_aDcaOrderRunsItsWholeScheduleOverSplitRoutes() public {
        uint256 id = _createOrderWithSlip(100e18, 500e18, 1, 0, SPLIT_SLIP_BPS);
        uint256 ownerB0 = tokenB.balanceOf(owner);

        uint256 fills;
        for (uint256 i = 0; i < 5; ++i) {
            (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
            assertEq(legIn, 100e18, "a full leg every time");
            MoleRouter.SwapPlan memory p = _splitPlan(owner, legIn, floorOut, legIn / 3);
            vm.prank(keeper);
            book.fillLeg(id, p);
            ++fills;
        }

        assertEq(fills, 5, "every scheduled leg filled");
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 500e18 - 5, "charged the budget less the five unrouted wei");
        assertGt(tokenB.balanceOf(owner) - ownerB0, 480e18, "and the owner actually got the output");
        assertEq(tokenA.balanceOf(address(book)), 0, "nothing stranded across the whole order");

        // The five-wei tail is a legitimate leg with a legitimate floor, not a hole.
        (uint256 tailIn, uint256 tailFloor) = book.currentLeg(id);
        assertEq(tailIn, 5, "a five-wei remainder");
        assertGt(tailFloor, 0, "which still carries a real floor");
        vm.prank(owner);
        book.cancelOrder(id);
    }

    /// @notice A single-path plan is exact, so nothing comes back and nothing is refunded. This is the
    ///         control that shows the refund path is driven by the router's rounding rather than by the
    ///         book handing money back unconditionally.
    function test_singlePathFillLeavesNoResidualAtAll() public {
        uint256 id = _createOrderWithSlip(100e18, 500e18, 1, 0, SPLIT_SLIP_BPS);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        uint256 ownerA0 = tokenA.balanceOf(owner);

        MoleRouter.SwapPlan memory p = _plan(owner, legIn, floorOut);
        vm.prank(keeper);
        book.fillLeg(id, p);

        assertEq(ownerA0 - tokenA.balanceOf(owner), legIn, "the whole leg routed");
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, legIn, "and the whole leg was charged");
    }

    /// @notice The aggregator fee is still paid, on the input side, out of the leg. Proving it here stops
    ///         the residual fix being mistaken for "the fee was turned off".
    function test_theAggregatorFeeIsStillTakenFromTheLeg() public {
        uint256 id = _createOrderWithSlip(100e18, 500e18, 1, 0, SPLIT_SLIP_BPS);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        uint256 treasury0 = tokenA.balanceOf(treasury);

        MoleRouter.SwapPlan memory p = _splitPlan(owner, legIn, floorOut, legIn / 3);
        vm.prank(keeper);
        book.fillLeg(id, p);

        assertEq(tokenA.balanceOf(treasury) - treasury0, (legIn * FEE_BPS) / 10_000, "fee paid in the source token");
    }
}
