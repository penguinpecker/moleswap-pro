// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleOrders} from "../../src/MoleOrders.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {OrdersWorld} from "../helpers/OrdersWorld.sol";

interface IV3Callback {
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Same shape as AttackMoleOrdersFloor's KeeperOwnedPool: MoleRouter runs a v3 hop against any
///         address the plan names, so this is the counterparty a hostile keeper (or a sandwiching
///         sequencer) supplies to itself. It hands back exactly `payOut`, which is what lets every test
///         below measure the CONTRACT's floor rather than a venue's price impact.
contract OwnedPool {
    MockERC20 public immutable tok1;
    uint256 public payOut;

    constructor(MockERC20 _t1) {
        tok1 = _t1;
    }

    function setPayOut(uint256 v) external {
        payOut = v;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256, int256)
    {
        uint256 amtIn = uint256(amountSpecified);
        uint256 out = payOut;
        IV3Callback(msg.sender).pancakeV3SwapCallback(int256(amtIn), -int256(out), data);
        tok1.transfer(recipient, out);
        return (int256(amtIn), -int256(out));
    }
}

/// THE CLAIM UNDER TEST is MoleOrders' own, at `MAX_SLIPPAGE_BPS`:
///   "The hard ceiling on how far below fair value any single leg may execute. This is the contract's own
///    bound on the worst case, independent of what a client asks for: a hostile or compromised keeper can
///    extract at most this much of a leg, not the leg."
///
/// EVERY TERMINAL ASSERTION IN THIS FILE IS THAT CEILING, and that is deliberate history. For three rounds
/// the anchor was the reference POOL's own TWAP, and this file measured it being defeated:
///
///   round 1  `consult` returns `lastTick` verbatim for any window lying wholly after the last swap — no
///            averaging at all — so walking a silent pool and waiting one window took 6,124 bps from a leg
///            whose contract-guaranteed worst case was 100 bps.
///   round 3  refusing `quietSpan >= twapWindow` moved the attacker's wait to `twapWindow - 1` seconds and
///            the extraction to 6,122 bps. At 50% silence it still paid 3,805 bps.
///
/// After round three this file had been edited so that four of its attacks asserted "the fill REVERTS"
/// instead of "extraction stays under the ceiling", and one asserted `lossBps > MAX_SLIPPAGE_BPS` as the
/// EXPECTED outcome. The effect was that no test anywhere in the repo asserted the ceiling held — a green
/// suite edited to agree with the fix, which is worse than the bug it hid. The ceiling assertions are back,
/// pointed at the Chainlink anchor, and every one of them FAILS if MAX_SLIPPAGE_BPS stops being a ceiling.
///
/// The SETUPS are unchanged from the rounds that broke: the same walk, the same silence, the same wash
/// trade, the same restoration inside the fill block. Each test still MEASURES the old anchor (the hook is
/// still deployed and `consult` still answers) so that it is checked rather than assumed that the exploit
/// conditions are genuinely reproduced — the attacks fail because the floor no longer listens to that
/// number, not because the harness stopped creating it.
contract AttackMoleOrdersQuietReference is OrdersWorld {
    using PoolIdLibrary for PoolKey;

    OwnedPool internal kp;

    function setUp() public {
        _buildWorld(address(0));
        kp = new OwnedPool(tokenB);
        tokenB.mint(address(kp), 5_000_000e18);
    }

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

    /// @dev THE MEASUREMENT EVERY ATTACK BELOW ENDS ON. The keeper fills at the lowest number the contract
    ///      will accept, through a counterparty it owns, and this returns how much of the leg's TRUE value
    ///      it kept — in basis points, against the same fair value the contract itself would quote.
    ///
    ///      The denominator is `book.fairOut(id, legIn)` rather than the leg size, so the number stays
    ///      honest if a test moves the feeds: "how far below fair did this execute" is the quantity
    ///      MAX_SLIPPAGE_BPS is a bound on, and comparing against anything else would be measuring a
    ///      different claim.
    function _extractAtTheFloor(uint256 id) internal returns (uint256 lossBps, uint256 floorOut) {
        uint256 legIn;
        (legIn, floorOut) = book.currentLeg(id);
        uint256 fair = book.fairOut(id, legIn);

        uint256 ownerB0 = tokenB.balanceOf(owner);
        kp.setPayOut(floorOut);
        vm.prank(keeper);
        book.fillLeg(id, _keeperPlan(legIn, floorOut));
        uint256 received = tokenB.balanceOf(owner) - ownerB0;

        assertEq(received, floorOut, "the keeper paid exactly the floor and not a wei more");
        lossBps = ((fair - received) * 10_000) / fair;
    }

    /// @dev The old anchor, still deployed and still answering. Used only to PROVE each setup reproduces
    ///      the condition that broke rounds one to three.
    function _oldAnchorTick() internal view returns (int24) {
        return hook.consult(oraclePool.toId(), TWAP_WINDOW);
    }

    /* ───────────────────────────────── the control, and the ceiling ──────────────────────────────── */

    /// @notice CONTROL. A live market, nothing manipulated. Every delta below is attributable to the
    ///         attack and not to the harness, because this is the same measurement with no attack in it.
    function test_control_extractionIsCappedAtTheOwnersTolerance() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        assertEq(floorOut, (legIn * (10_000 - SLIP_BPS)) / 10_000, "floor is fair less the tolerance");

        (uint256 lossBps,) = _extractAtTheFloor(id);
        assertEq(lossBps, SLIP_BPS, "control: exactly the owner's own 100 bps");
        assertLe(lossBps, book.MAX_SLIPPAGE_BPS(), "and inside the contract's own ceiling");
    }

    /* ──────────────────────── round one: walk the reference pool, then wait ──────────────────────── */

    /// @notice THE ORIGINAL EXPLOIT, DRIVEN AGAINST THE NEW CODE. One round trip's capital walks the
    ///         reference pool down and nobody trades it for a full window — the exact three steps that
    ///         took 6,124 bps. The old anchor still follows the walk one-for-one, and this test asserts
    ///         that it does. The FLOOR does not follow it by one wei, and the extraction is back inside
    ///         the ceiling.
    function test_theCeilingHolds_whenTheReferencePoolIsWalkedAndLeftSilent() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (, uint256 floorHonest) = book.currentLeg(id);
        int24 tickBefore = _oldAnchorTick();

        // 1. ONE round trip's worth of capital walks the reference pool down.
        _marketSwap(oraclePool, true, 120_000e18);
        // 2. Wait out ONE window with no further trade on that pool.
        _advance(TWAP_WINDOW + 1);

        // The exploit conditions are genuinely present: the old anchor IS the walked spot, with zero
        // averaging, which is what made the floor purchasable for a pool fee.
        int24 tickAfter = _oldAnchorTick();
        (, int24 spotTick,,) = StateLibrary.getSlot0(manager, oraclePool.toId());
        assertEq(tickAfter, spotTick, "the 30-minute pool TWAP is EXACTLY the walked spot: zero averaging");
        assertLt(tickAfter, tickBefore, "and it moved a long way");
        emit log_named_int("old anchor tick before the walk", tickBefore);
        emit log_named_int("old anchor tick after 1 window of silence", tickAfter);

        // 3. The fill. The floor is the same number it was before the walk.
        (, uint256 floorNow) = book.currentLeg(id);
        assertEq(floorNow, floorHonest, "the walk bought no movement in the floor at all");

        (uint256 lossBps,) = _extractAtTheFloor(id);
        emit log_named_uint("extraction after walking a silent reference pool, bps", lossBps);
        assertLe(lossBps, book.MAX_SLIPPAGE_BPS(), "THE CEILING HOLDS: this measured 6,124 bps in round one");
        assertEq(lossBps, SLIP_BPS, "and is still exactly the owner's own tolerance");
    }

    /// @notice THE EXACT VARIANT THAT DEFEATED ROUND THREE. Round three refused an answer resting on
    ///         `quietSpan >= twapWindow`; the attacker waited `twapWindow - 1` seconds instead and took
    ///         6,122 bps — two basis points less than with no guard at all. Same setup here, one second
    ///         short of the old boundary, and the ceiling holds because the boundary is gone rather than
    ///         moved.
    function test_theCeilingHolds_atTheWindowMinusOneSecondThatDefeatedRoundThree() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (, uint256 floorHonest) = book.currentLeg(id);

        _marketSwap(oraclePool, true, 120_000e18);
        _advance(TWAP_WINDOW - 1);

        (uint32 quietSpan,) = hook.consultEvidence(oraclePool.toId(), TWAP_WINDOW);
        assertEq(quietSpan, TWAP_WINDOW - 1, "one second under round three's bound, which is where it broke");
        (, int24 spotTick,,) = StateLibrary.getSlot0(manager, oraclePool.toId());
        assertLt(_oldAnchorTick(), 0, "the old anchor still sits at the walked price");
        emit log_named_int("spot after the walk", spotTick);

        (, uint256 floorNow) = book.currentLeg(id);
        assertEq(floorNow, floorHonest, "the floor did not move");

        (uint256 lossBps,) = _extractAtTheFloor(id);
        emit log_named_uint("extraction at twapWindow - 1 seconds of silence, bps", lossBps);
        assertLe(lossBps, book.MAX_SLIPPAGE_BPS(), "THE CEILING HOLDS: this measured 6,122 bps in round three");
    }

    /// @notice AND AT EVERY OTHER AMOUNT OF SILENCE. Round three's defeat was not "the threshold was set
    ///         wrong", it was "no threshold works" — at 50% silence the same walk still paid 3,805 bps. So
    ///         this sweeps the silence from well under the old boundary to well past it and asserts the
    ///         ceiling at every point, which is the assertion no single-value test can make.
    function test_theCeilingHolds_atEverySilenceFromZeroToFourWindows() public {
        uint32[8] memory silences = [
            uint32(1),
            TWAP_WINDOW / 4,
            TWAP_WINDOW / 2,
            TWAP_WINDOW - 2,
            TWAP_WINDOW - 1,
            TWAP_WINDOW,
            TWAP_WINDOW + 1,
            4 * TWAP_WINDOW
        ];
        for (uint256 i = 0; i < silences.length; ++i) {
            uint256 snap = vm.snapshotState();

            uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
            (, uint256 floorHonest) = book.currentLeg(id);
            _marketSwap(oraclePool, true, 120_000e18);
            _advance(silences[i]);

            (, uint256 floorNow) = book.currentLeg(id);
            assertEq(floorNow, floorHonest, "the floor moved with the silence");
            (uint256 lossBps,) = _extractAtTheFloor(id);
            emit log_named_uint("silence (seconds)", silences[i]);
            emit log_named_uint("  extraction, bps", lossBps);
            assertLe(lossBps, book.MAX_SLIPPAGE_BPS(), "THE CEILING HOLDS at this amount of silence");

            vm.revertToState(snap);
        }
    }

    /// @notice NO PRIVILEGED ROLE AT ALL. The keeper is honest and a stranger walked the reference pool and
    ///         stopped trading it. Under the pool anchor this was the worst case, because the honest keeper
    ///         had no way to know the anchor was a fossil and every fill it built was already far below
    ///         market. The untouched second venue is still quoting the true market — that measurement is
    ///         kept, because it is what made the old fills wrong.
    function test_theCeilingHolds_forAnHonestKeeperAfterAStrangerWalksTheVenue() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (uint256 legIn0, uint256 floorHonest) = book.currentLeg(id);

        // A stranger — not the keeper, not the owner, no role anywhere in this system.
        _marketSwap(oraclePool, true, 120_000e18);
        _advance(TWAP_WINDOW + 1);

        // The plain pool never moved: it is still quoting the true market, ~1:1.
        (uint160 sqrtPlain,,,) = StateLibrary.getSlot0(manager, plainPool.toId());
        (uint160 sqrtOracle,,,) = StateLibrary.getSlot0(manager, oraclePool.toId());
        assertLt(sqrtOracle, sqrtPlain, "the reference venue is walked, the honest venue is not");

        // The honest keeper reads the SAME floor it would have read before the stranger showed up.
        (uint256 legIn1, uint256 floorNow) = book.currentLeg(id);
        assertEq(legIn1, legIn0, "same leg");
        assertEq(floorNow, floorHonest, "and the same floor, because the walked venue is not the anchor");

        (uint256 lossBps,) = _extractAtTheFloor(id);
        assertLe(lossBps, book.MAX_SLIPPAGE_BPS(), "THE CEILING HOLDS with no privileged role in the attack");
    }

    /// @notice THE MANIPULATION DOES NOT HAVE TO STILL BE STANDING WHEN THE FILL LANDS. Restoring spot in
    ///         the fill's own block used to leave the anchor exactly where the silence had put it, so the
    ///         attacker paid for the walk once and kept the position flat. The anchor still survives the
    ///         restoration — asserted here — and the floor still does not care.
    function test_theCeilingHolds_whenTheWalkIsRestoredInsideTheFillBlock() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (, uint256 floorHonest) = book.currentLeg(id);

        uint256 manipB0 = tokenB.balanceOf(address(this));
        _marketSwap(oraclePool, true, 120_000e18);
        _advance(TWAP_WINDOW + 1);

        // Price back to (near) where it started, in the block the fill happens in.
        _marketSwap(oraclePool, false, tokenB.balanceOf(address(this)) - manipB0);
        (, int24 spotNow,,) = StateLibrary.getSlot0(manager, oraclePool.toId());
        int24 anchorNow = _oldAnchorTick();
        assertLt(anchorNow, spotNow, "spot is back but the OLD anchor is not: the fossil survived");
        emit log_named_int("spot at fill time (restored)", spotNow);
        emit log_named_int("old anchor at fill time (still walked)", anchorNow);

        (, uint256 floorNow) = book.currentLeg(id);
        assertEq(floorNow, floorHonest, "the floor never followed the walk, so it has nothing to restore");

        (uint256 lossBps,) = _extractAtTheFloor(id);
        assertLe(lossBps, book.MAX_SLIPPAGE_BPS(), "THE CEILING HOLDS across a walk that was undone");
    }

    /// @notice THE WASH-TRADED HEARTBEAT. This is the attack round three explicitly did not close and
    ///         whose test asserted `lossBps > MAX_SLIPPAGE_BPS` as the expected outcome — the single
    ///         assertion that stated the ceiling did not hold. The setup is unchanged: walk the pool, then
    ///         keep it "alive" with dust at the walked tick so no stretch of silence ever reaches a window.
    ///         Under the pool anchor every check passed and the floor followed the walk. It does not now.
    function test_theCeilingHolds_underAWashTradedHeartbeat() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 0);
        (, uint256 floorHonest) = book.currentLeg(id);

        _marketSwap(oraclePool, true, 120_000e18);
        _advanceLive(TWAP_WINDOW + 200); // dust trades all the way, so quietSpan never reaches the window

        (uint32 quietSpan,) = hook.consultEvidence(oraclePool.toId(), TWAP_WINDOW);
        assertLt(quietSpan, TWAP_WINDOW, "the heartbeat held round three's guard open, exactly as before");
        assertLt(_oldAnchorTick(), 0, "and the old anchor is sitting at the walked tick it was bought at");

        (, uint256 floorNow) = book.currentLeg(id);
        assertEq(floorNow, floorHonest, "the floor did NOT follow the walked tick");

        (uint256 lossBps,) = _extractAtTheFloor(id);
        emit log_named_uint("loss with a manufactured heartbeat, bps of the leg", lossBps);
        assertLe(
            lossBps,
            book.MAX_SLIPPAGE_BPS(),
            "THE CEILING HOLDS: round three's own test asserted this number was ABOVE the ceiling"
        );
    }

    /* ─────────────────────── what changing the anchor bought back in liveness ────────────────────── */

    /// @notice ROUND THREE'S LIVENESS COST, GONE. Its guard refused any leg whose reference window rested
    ///         on a window-wide silence, so a DCA on a pool with no other flow ran exactly ONE leg and then
    ///         waited for a market that never came — pinned at the time as `test_aDcaWhoseOwnFillsAreThe
    ///         OnlyTradesStallsBetweenLegs`. The floor no longer asks the pool anything, so it fills.
    function test_aDcaWhoseOwnFillsAreTheOnlyTradesNoLongerStallsBetweenLegs() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        // The plan is built BEFORE the prank: `_honestPlan` calls `currentLeg`, and an argument
        // expression that is itself a call would be the call the prank is spent on.
        MoleRouter.SwapPlan memory leg1 = _honestPlan(id);
        vm.prank(keeper);
        book.fillLeg(id, leg1);

        _advance(6 hours); // nobody else trades this pair, at all
        (uint32 quietSpan,) = hook.consultEvidence(oraclePool.toId(), TWAP_WINDOW);
        assertGt(quietSpan, TWAP_WINDOW, "the pool has been silent for far longer than a window");

        assertTrue(book.fillable(id), "and the second leg is fillable anyway");
        uint256 ownerB0 = tokenB.balanceOf(owner);
        MoleRouter.SwapPlan memory leg2 = _honestPlan(id);
        vm.prank(keeper);
        book.fillLeg(id, leg2);
        assertGt(tokenB.balanceOf(owner), ownerB0, "the leg filled");
        (,,,,, uint256 spent,,,,) = book.orders(id);
        assertEq(spent, 2e18, "two legs charged");
    }

    /// @notice A DORMANT VENUE IS NOT AN OBSTACLE ANY MORE — not to creating an order, and not to filling
    ///         one. On the live RH pool, silent for days, this is the difference between a product whose
    ///         orders wait forever and one that works.
    function test_anOrderIsCreatableAndFillableWhileTheVenueIsDormant() public {
        _advance(10 * TWAP_WINDOW);
        uint256 id = _createOrder(1e18, 5e18, 1, 6 hours);
        (,,,,,,,,, bool active) = book.orders(id);
        assertTrue(active, "the order exists and is active");

        (, uint256 floorOut) = book.currentLeg(id);
        assertEq(floorOut, 0.99e18, "and it is priced, at fair less the owner's tolerance");
        assertTrue(book.fillable(id), "and fillable");
    }

    /* ─────────────────────────────── the stall that remains, and its shape ───────────────────────── */

    /// @notice THE ANCHOR CAN STILL STALL — on a DEAD FEED rather than a quiet pool — and when it does the
    ///         stall must be visible without reverting. `anchorStatus` reports both feeds separately,
    ///         because their bounds differ by two orders of magnitude and "the anchor is stale" without
    ///         saying which one is not an operational answer.
    function test_theStallIsVisibleWithoutReverting() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 0);

        (bool answered, uint8 codeIn, uint32 ageIn, uint32 maxAgeIn, uint8 codeOut,, uint32 maxAgeOut) =
            book.anchorStatus(id);
        assertTrue(answered, "live feeds: the anchor answers");
        assertEq(codeIn, book.FEED_OK(), "input feed healthy");
        assertEq(codeOut, book.FEED_OK(), "output feed healthy");
        assertEq(ageIn, 0, "just stamped");
        assertEq(maxAgeIn, MAX_AGE_FAST, "and the bounds reported are the ones registration pinned");
        assertEq(maxAgeOut, MAX_AGE_HEARTBEAT, "which differ by two orders of magnitude, per feed");
        assertTrue(book.fillable(id), "so the order is fillable");

        // The feeds stop publishing. tokenA's bound is one hour; tokenB's is twenty-five.
        _freezeFeeds();
        _advance(2 hours);

        (answered, codeIn, ageIn, maxAgeIn, codeOut,,) = book.anchorStatus(id);
        assertFalse(answered, "the anchor no longer answers");
        assertEq(codeIn, book.FEED_STALE(), "and says WHICH feed and WHY");
        assertEq(ageIn, 2 hours, "with the age in seconds");
        assertEq(maxAgeIn, MAX_AGE_FAST, "against the bound it broke");
        assertEq(codeOut, book.FEED_OK(), "while the 25-hour feed is still perfectly healthy");
        assertFalse(book.fillable(id), "so the book no longer claims this order can be filled");

        vm.expectRevert(
            abi.encodeWithSelector(MoleOrders.StalePrice.selector, address(feedA), uint32(2 hours), MAX_AGE_FAST)
        );
        book.currentLeg(id);
    }

    /// @notice THE REFUSAL IS TRANSIENT, which is what makes failing closed affordable. Nothing is
    ///         stranded, nothing times out, no key is needed: the feed publishes and the order resumes —
    ///         and it resumes on ONE transmission, where the pool anchor needed a full window of trading.
    function test_aStalledOrderResumesOnItsOwnWhenTheFeedComesBack() public {
        uint256 id = _createOrder(1e18, 5e18, 1, 0);
        _freezeFeeds();
        _advance(3 hours);
        assertFalse(book.fillable(id), "stalled");

        feedA.stamp();
        assertTrue(book.fillable(id), "one transmission is enough");

        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        uint256 ownerB0 = tokenB.balanceOf(owner);
        kp.setPayOut(floorOut);
        vm.prank(keeper);
        book.fillLeg(id, _keeperPlan(legIn, floorOut));
        assertEq(tokenB.balanceOf(owner) - ownerB0, floorOut, "and the leg fills exactly as before");
    }

    /// @notice The view a client polls has to be TOTAL, including for an id that was never created — and
    ///         it must say WHICH kind of nothing it found. An id with no bound is not the same operational
    ///         event as a live pair whose aggregator has stopped answering: one is an order that was never
    ///         priceable, the other is an incident. They get separate codes, and the strict path maps the
    ///         first to its own error rather than reporting `FeedUnreadable(address(0))`.
    function test_anchorStatusIsTotalForAnIdThatWasNeverCreated() public {
        (bool answered, uint8 codeIn, uint32 ageIn, uint32 maxAgeIn, uint8 codeOut, uint32 ageOut, uint32 maxAgeOut) =
            book.anchorStatus(999);
        assertFalse(answered, "no bound, so no anchor");
        assertEq(codeIn, book.FEED_UNSET(), "an id with no bound is UNSET, not a broken aggregator");
        assertEq(codeOut, book.FEED_UNSET(), "both of them");
        assertEq(ageIn, 0, "and nothing to report");
        assertEq(ageOut, 0, "on either side");
        assertEq(maxAgeIn, 0, "no bound of its own");
        assertEq(maxAgeOut, 0, "on either side");
        assertFalse(book.fillable(999), "and it is certainly not fillable");

        vm.expectRevert(MoleOrders.NoFeedBound.selector);
        book.fairOut(999, 1e18);

        // `currentLeg` short-circuits on an empty budget BEFORE it reaches a feed, so it answers (0, 0)
        // for an id that never existed rather than reverting. That is the same early return a completed
        // order takes, and it is the reason the keeper can poll a finished order without a feed read.
        (uint256 legIn, uint256 floorOut) = book.currentLeg(999);
        assertEq(legIn, 0, "no leg");
        assertEq(floorOut, 0, "and no floor to quote for it");
    }
}
