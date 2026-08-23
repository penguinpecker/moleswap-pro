// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MoleOrders} from "../../src/MoleOrders.sol";
import {OrdersWorld} from "../helpers/OrdersWorld.sol";

interface IV3Callback {
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice A "pool" the keeper owns. MoleRouter executes a v3 hop against whatever address the plan names
///         and never validates it, so this is the counterparty a hostile keeper supplies to itself: it
///         collects the whole leg through the router's own payment callback and hands back exactly
///         `payOut` — which under the old contract could be one wei.
contract KeeperOwnedPool {
    MockERC20 public immutable tok0;
    MockERC20 public immutable tok1;
    uint256 public payOut;

    constructor(MockERC20 _t0, MockERC20 _t1) {
        tok0 = _t0;
        tok1 = _t1;
    }

    function setPayOut(uint256 v) external {
        payOut = v;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amtIn = uint256(amountSpecified); // positive = exact input, v3 convention
        uint256 out = payOut;
        // Demand payment exactly as a real pool does; the router pays from its own balance.
        IV3Callback(msg.sender).pancakeV3SwapCallback(int256(amtIn), -int256(out), data);
        tok1.transfer(recipient, out);
        return (int256(amtIn), -int256(out));
    }
}

/// F-02 mechanisms A, B and D — the theft path, the sandwich amplifier, and the truncated final leg.
///
/// The claim under test is the contract header's own: "a keeper that can TRIGGER an order but can never
/// steal from it". Before this fix that was false in three independent ways, and each test here drives the
/// attack rather than merely poking the guard:
///
///   A  The only price bound was `minOutPerLeg`, an absolute amount frozen at creation which the shipped
///      client set to ONE WEI for every DCA order. A keeper routing through a pool it owns therefore
///      collected the entire leg and returned a wei, with every stored check green.
///   B  The same 1-wei bound rode in the honest keeper's own transaction, so on a single-sequencer chain
///      with no public mempool any ordering-privileged party sandwiched every fill for ~100% of the leg.
///   D  `minOutPerLeg * legIn / amountPerLeg` rounded DOWN, so the final partial leg's floor reached ZERO
///      and the owner was charged for a leg that could legally deliver nothing.
///
/// Every assertion is on BALANCES and stored state, not on the fact that something reverted.
contract AttackMoleOrdersFloor is OrdersWorld {
    KeeperOwnedPool internal kp;

    function setUp() public {
        _buildWorld(address(0)); // feeless router — the numbers below are about price, not fees
        kp = new KeeperOwnedPool(tokenA, tokenB);
        tokenB.mint(address(kp), 1_000_000e18); // the keeper's pool has stock to hand back its crumb
    }

    /// @dev A plan routing the whole leg through the keeper's own "pool".
    function _keeperPlan(uint256 amountIn, uint256 minOut) internal view returns (MoleRouter.SwapPlan memory) {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.PancakeV3,
            pool: address(kp),
            zeroForOne: true,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            key: PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(0)),
                fee: 0,
                tickSpacing: 0,
                hooks: IHooks(address(0))
            })
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});
        return MoleRouter.SwapPlan({
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: owner,
            deadline: block.timestamp + 60,
            paths: paths
        });
    }

    /* ───────────────────────── MECHANISM A — the keeper as its own counterparty ───────────────────── */

    function test_keeperOwnPoolCannotTakeTheWholeLegAtTheOneWeiFloor() public {
        // The shipped client's DCA order, verbatim: 1000-unit legs, `minOut: 1n`.
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);

        uint256 ownerA0 = tokenA.balanceOf(owner);
        uint256 ownerB0 = tokenB.balanceOf(owner);

        kp.setPayOut(1); // the whole leg for one wei — the old floor allowed exactly this
        MoleRouter.SwapPlan memory p = _keeperPlan(1e18, 1);

        vm.prank(keeper);
        vm.expectRevert(MoleOrders.FloorNotMet.selector);
        book.fillLeg(id, p);

        // The attack must cost the owner NOTHING — not a wei of input, not a wei of budget.
        assertEq(tokenA.balanceOf(owner), ownerA0, "not a wei of the owner's input moved");
        assertEq(tokenB.balanceOf(owner), ownerB0, "no output was delivered");
        assertEq(tokenA.balanceOf(address(kp)), 0, "the keeper's pool collected nothing");
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 0, "the budget did not move");
    }

    /// @notice The keeper takes the MOST it can. The point of the fix is not that theft is impossible —
    ///         it is that the amount is now the owner's own published tolerance and nothing more.
    function test_keeperExtractionIsBoundedByTheOwnersSlippageTolerance() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);

        // The reference pool opened at 1:1 and has not traded, so a leg's fair value is the leg.
        uint256 fair = legIn;
        assertEq(floorOut, (fair * (10_000 - SLIP_BPS)) / 10_000, "floor is the TWAP less the tolerance");

        uint256 ownerB0 = tokenB.balanceOf(owner);
        kp.setPayOut(floorOut); // the keeper pays the least the contract will accept
        MoleRouter.SwapPlan memory p = _keeperPlan(legIn, floorOut);
        vm.prank(keeper);
        book.fillLeg(id, p);

        uint256 received = tokenB.balanceOf(owner) - ownerB0;
        assertEq(received, floorOut, "the owner received exactly the floor");
        uint256 extracted = fair - received;
        assertEq(tokenA.balanceOf(address(kp)), legIn, "the keeper's pool did collect the input");
        assertEq((extracted * 10_000) / fair, SLIP_BPS, "extraction is capped at the owner's tolerance");
        // The number that matters: before the fix this was 1e18 - 1, i.e. the whole leg.
        assertEq(extracted, 0.01e18, "worst case is 1% of the leg, not 100% of it");
    }

    function test_payingLessThanTheFloorIsRefusedByTheRouterToo() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);

        // A plan that DECLARES the floor but whose pool delivers one wei less. The book's own check
        // passes (it bounds the declaration); the router's post-fee check is what catches the delivery.
        kp.setPayOut(floorOut - 1);
        MoleRouter.SwapPlan memory p = _keeperPlan(legIn, floorOut);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MoleRouter.InsufficientOutput.selector, floorOut - 1, floorOut));
        book.fillLeg(id, p);
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 0, "nothing was charged");
    }

    /// @notice The second worked case from the audit: a limit order whose price went stale. The keeper
    ///         fills AT the old limit while the market is far past it and keeps the difference.
    function test_staleLimitCannotBeFilledOnceTheMarketMovesPastIt() public {
        // Sell 1 tokenA per leg, limit 0.5 tokenB — comfortably above the 1:1 market's floor at creation
        // is not required; what matters is that this number never changes again.
        uint256 id = _createOrder(1e18, 5e18, 0.5e18, 0);

        // The market moves: tokenA doubles against tokenB, and the TWAP absorbs it in full.
        _marketSwap(oraclePool, false, 83_000e18);
        _advance(2 * TWAP_WINDOW);

        (, uint256 floorOut) = book.currentLeg(id);
        assertGt(floorOut, 1.9e18, "the floor tracked the market, not the stale limit");

        uint256 ownerA0 = tokenA.balanceOf(owner);
        kp.setPayOut(0.5e18); // fill at the stale limit and pocket ~1.5 tokenB per leg
        MoleRouter.SwapPlan memory p = _keeperPlan(1e18, 0.5e18);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.FloorNotMet.selector);
        book.fillLeg(id, p);
        assertEq(tokenA.balanceOf(owner), ownerA0, "the stale limit bought the keeper nothing");
    }

    /* ───────────────────────── MECHANISM B — the sandwich on an honest keeper ────────────────────── */

    /// @notice No privileged role required. The keeper is honest; the SEQUENCER moves spot immediately
    ///         before the fill lands. The bound has to be immovable inside that block, and it is —
    ///         a swap sharing the fill's timestamp contributes exactly zero elapsed time to the TWAP.
    function test_sameBlockSpotManipulationCannotMoveTheFloorOrStealTheLeg() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        MoleRouter.SwapPlan memory honest = _honestPlan(id); // route through the real pool, floor pinned
        (, uint256 floorBefore) = book.currentLeg(id);

        uint256 ownerA0 = tokenA.balanceOf(owner);
        uint256 ownerB0 = tokenB.balanceOf(owner);

        // The sandwich: a large same-direction swap in the SAME block, before the keeper's transaction.
        _marketSwap(oraclePool, true, 20_000e18);

        (, uint256 floorAfter) = book.currentLeg(id);
        assertEq(floorAfter, floorBefore, "spot moved; the TWAP-anchored floor did not");

        // The fill now cannot execute at the manipulated price, so the sandwich has nothing to close on.
        vm.prank(keeper);
        vm.expectRevert();
        book.fillLeg(id, honest);

        assertEq(tokenA.balanceOf(owner), ownerA0, "the owner's input never left");
        assertEq(tokenB.balanceOf(owner), ownerB0, "and no output was delivered at the bad price");
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 0, "budget untouched");
    }

    /* ───────────────────────── MECHANISM D — the truncated final leg ─────────────────────────────── */

    function test_finalPartialLegFloorNeverTruncatesToZero() public {
        // A budget one wei past two whole legs — exactly the shape `perLeg = total / n` produces whenever
        // the total does not divide evenly.
        uint256 id = _createOrder(1e18, 2e18 + 1, 1, 0);
        vm.startPrank(keeper);
        book.fillLeg(id, _honestPlan(id));
        book.fillLeg(id, _honestPlan(id));
        vm.stopPrank();

        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        assertEq(legIn, 1, "a one-wei remainder leg");
        // Old math: (1 * 1) / 1e18 == 0, and the TWAP floor of one wei rounds to 0 as well, so the leg
        // could legally deliver NOTHING while the budget was charged for it.
        assertGt(floorOut, 0, "the scaled floor must never truncate to zero");

        kp.setPayOut(0);
        MoleRouter.SwapPlan memory p = _keeperPlan(1, 0);
        vm.prank(keeper);
        vm.expectRevert(MoleOrders.FloorNotMet.selector);
        book.fillLeg(id, p);

        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 2e18, "the zero-output leg was not charged");
    }

    /* ───────────────────────── the bound itself cannot be configured away ────────────────────────── */

    function test_slippageToleranceIsCappedAtCreation() public {
        // Read the cap BEFORE arming the cheatcode — an argument expression that is itself a call would
        // otherwise be the call `expectRevert` measures.
        uint16 overCap = book.MAX_SLIPPAGE_BPS() + 1;
        vm.startPrank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, oraclePool, TWAP_WINDOW, overCap);
        // 10_000 bps would be an outright opt-out — a zero market floor.
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, oraclePool, TWAP_WINDOW, 10_000);
        vm.stopPrank();
    }

    function test_twapWindowMustBeLongEnoughToBeAPriceAndShortEnoughToBeCurrent() public {
        uint32 tooShort = book.MIN_TWAP_WINDOW() - 1;
        uint32 tooLong = book.MAX_TWAP_WINDOW() + 1;
        vm.startPrank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, oraclePool, tooShort, SLIP_BPS);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, oraclePool, tooLong, SLIP_BPS);
        vm.stopPrank();
    }

    function test_referencePoolMustBeALiveHookedPoolOverTheOrdersOwnPair() public {
        // No hook: a hookless v4 pool keeps no observations, so it has no TWAP to consult.
        vm.prank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, plainPool, TWAP_WINDOW, SLIP_BPS);

        // A hooked key that was never initialised — same hook, different tickSpacing, so a different id.
        PoolKey memory ghost = oraclePool;
        ghost.tickSpacing = 120;
        vm.prank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, ghost, TWAP_WINDOW, SLIP_BPS);

        // A live hooked pool over the WRONG pair cannot price this order.
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        (Currency c0, Currency c1) = address(tokenC) < address(tokenB)
            ? (Currency.wrap(address(tokenC)), Currency.wrap(address(tokenB)))
            : (Currency.wrap(address(tokenB)), Currency.wrap(address(tokenC)));
        PoolKey memory wrongPair = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(wrongPair, SQRT_PRICE_1_1);
        vm.prank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, wrongPair, TWAP_WINDOW, SLIP_BPS);
    }

    /// @notice A reference whose price cannot express a leg is refused at creation rather than at every
    ///         fill forever. Two separate ways that happens, one per branch of the conversion.
    function test_aReferencePriceThatCannotValueALegIsRefusedAtCreation() public {
        // (1) So far below parity that the squared price itself floors to zero. Selling currency1 there
        //     would divide by that zero; selling currency0 would multiply by it.
        PoolKey memory abyss = oraclePool;
        abyss.tickSpacing = 10;
        manager.initialize(abyss, TickMath.getSqrtPriceAtTick(-880_000));

        // (2) A survivable price — one millionth — where a ONE-WEI leg is still worth zero output.
        PoolKey memory thin = oraclePool;
        thin.tickSpacing = 20;
        manager.initialize(thin, TickMath.getSqrtPriceAtTick(-138_160));

        _advance(TWAP_WINDOW + 100); // both pools now have a window of history to consult

        vm.prank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenB), address(tokenA), 1e18, 1e18, 1, 0, abyss, TWAP_WINDOW, SLIP_BPS);

        vm.prank(owner);
        vm.expectRevert(MoleOrders.BadBound.selector);
        book.createOrder(address(tokenA), address(tokenB), 1, 1, 1, 0, thin, TWAP_WINDOW, SLIP_BPS);

        // The same pool prices a leg that is big enough, so the refusal is about the leg, not the pool.
        vm.prank(owner);
        book.createOrder(address(tokenA), address(tokenB), 1e18, 1e18, 1, 0, thin, TWAP_WINDOW, SLIP_BPS);
    }

    /// @notice The bound is stored per order and priced live, so the SAME order's floor moves with the
    ///         market while nothing about the order changes. This is the property the stale constant
    ///         could not have.
    function test_theStoredBoundRepricesWithTheMarket() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 0);
        (, uint256 floorAtCreation) = book.currentLeg(id);

        _marketSwap(oraclePool, false, 83_000e18);
        _advance(2 * TWAP_WINDOW);
        (, uint256 floorLater) = book.currentLeg(id);
        assertGt(floorLater, (floorAtCreation * 19) / 10, "the floor roughly doubled with the market");

        _marketSwap(oraclePool, true, 83_000e18);
        _advance(2 * TWAP_WINDOW);
        (, uint256 floorBack) = book.currentLeg(id);
        assertLt(floorBack, floorLater, "and falls again when the market falls");
        assertLt(floorBack, floorAtCreation, "past its starting point, because the sell overshot");
    }
}
