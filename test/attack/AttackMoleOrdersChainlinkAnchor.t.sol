// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";

import {MoleOrders} from "../../src/MoleOrders.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {MockAggregator, DirtyRoundAggregator} from "../helpers/MockAggregator.sol";
import {OrdersWorld} from "../helpers/OrdersWorld.sol";

interface IV3Callback {
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice A counterparty that pays exactly `payOut` of one named token. MoleRouter runs a v3 hop against
///         whatever address the plan names, so this is what a hostile keeper hands itself — and what lets a
///         test measure the CONTRACT's floor end to end, in the output token's own units, without a pool's
///         price impact in the way.
contract PayoutPool {
    MockERC20 public immutable out;
    uint256 public payOut;

    constructor(MockERC20 _out) {
        out = _out;
    }

    function setPayOut(uint256 v) external {
        payOut = v;
    }

    function swap(address recipient, bool, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256, int256)
    {
        uint256 amtIn = uint256(amountSpecified);
        uint256 o = payOut;
        IV3Callback(msg.sender).pancakeV3SwapCallback(int256(amtIn), -int256(o), data);
        out.transfer(recipient, o);
        return (int256(amtIn), -int256(o));
    }
}

/// THE CHAINLINK ANCHOR, DRIVEN AT EVERY EDGE THAT CAN COST MONEY.
///
/// Three claims are under test here, and they fail in three different ways:
///
///   1. THE DECIMALS. Fair value is the ratio of two 8-decimal USD feeds converted between an 18-decimal
///      token and a SIX-decimal one. Getting the scale wrong by one power of ten is not a rounding bug, it
///      is a 10x mispricing of every leg, and the live pair on Robinhood Chain (WETH 18 / USDG 6) is
///      exactly the shape that produces it. Both directions are priced against numbers computed
///      independently of the contract, and the mis-pinned answer is stated alongside the right one so the
///      assertions cannot be satisfied by the wrong scale.
///
///   2. THE FEED GUARDS. Each of the six conditions is broken ALONE, so a test proves a specific guard
///      fired rather than that something was wrong. The two that are easy to leave out are the ones that
///      look redundant: `updatedAt` in the FUTURE (which silently defeats the age bound rather than
///      tripping it) and `answeredInRound < roundId` (which is the feed contradicting its own bookkeeping
///      while every value it reports still looks reasonable).
///
///   3. THE EXIT. This contract takes a standing ERC-20 approval, so "the oracle broke and nobody can get
///      their money out" would be a worse outcome than any bad fill. `cancelOrder` is asserted to work
///      with every feed broken every way at once, including with the aggregator's code removed from the
///      chain and registration permanently sealed.
contract AttackMoleOrdersChainlinkAnchor is OrdersWorld {
    /* The live pair's real shape and its real numbers, measured on Robinhood Chain 4663:
       ETH/USD  = $2,503.51 at 8 decimals; USDG/USD = $0.9999 at 8 decimals;
       WETH is 18 decimals, USDG is SIX. */
    int256 internal constant ETH_USD = 250_351_000_000;
    int256 internal constant USDG_USD = 99_990_000;
    /// @dev 1 WETH at those two prices, in raw USDG units, computed outside this codebase:
    ///      2503.51 / 0.9999 = 2503.760376... , truncated at 6 decimals.
    uint256 internal constant ONE_WETH_IN_USDG = 2_503_760_376;
    /// @dev What the same leg comes to if USDG's decimals are mis-pinned at 18 — a factor of 1e12 out.
    ///      Named so the assertions below cannot accidentally be satisfied by the wrong scale.
    uint256 internal constant ONE_WETH_IN_USDG_IF_MISPINNED = 2_503_760_376_037_603_760_376;

    MockERC20 internal weth;
    MockERC20 internal usdg;
    MockAggregator internal ethFeed;
    MockAggregator internal usdgFeed;
    PayoutPool internal usdgVenue;
    PayoutPool internal wethVenue;

    function setUp() public {
        _buildWorld(address(0));

        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        ethFeed = new MockAggregator(FEED_DECIMALS, ETH_USD);
        usdgFeed = new MockAggregator(FEED_DECIMALS, USDG_USD);
        _liveFeeds.push(ethFeed);
        _liveFeeds.push(usdgFeed);

        // The two bounds the live chain actually needs: ETH/USD publishes on deviation (698 s old when
        // measured), USDG/USD is a 24-hour heartbeat (~23 h old at the same moment).
        _registerFeed(book, address(weth), ethFeed, MAX_AGE_FAST);
        _registerFeed(book, address(usdg), usdgFeed, MAX_AGE_HEARTBEAT);

        usdgVenue = new PayoutPool(usdg);
        wethVenue = new PayoutPool(weth);
        usdg.mint(address(usdgVenue), 100_000_000e6);
        weth.mint(address(wethVenue), 100_000e18);

        weth.mint(owner, 100e18);
        usdg.mint(owner, 1_000_000e6);
        vm.startPrank(owner);
        weth.approve(address(book), type(uint256).max);
        usdg.approve(address(book), type(uint256).max);
        vm.stopPrank();
    }

    function _pairPlan(address tokenIn, address tokenOut, address venue, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory)
    {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.PancakeV3,
            pool: venue,
            zeroForOne: true,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
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
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: owner,
            deadline: block.timestamp + 60,
            paths: paths
        });
    }

    function _order(address tokenIn, address tokenOut, uint256 leg, uint256 minOut) internal returns (uint256 id) {
        vm.prank(owner);
        id = book.createOrder(tokenIn, tokenOut, leg, leg, minOut, 0, SLIP_BPS);
    }

    /* ══════════════════════════════ 1. THE DECIMALS, IN BOTH DIRECTIONS ═══════════════════════════ */

    /// @notice A WETH-IN LEG. Eighteen decimals in, six out, at the live pair's real prices. The expected
    ///         number is computed outside this codebase and the mis-pinned alternative is asserted against
    ///         explicitly, so a scale error of 1e12 cannot pass by being "close".
    function test_bothDirectionsPriceCorrectly_wethIn() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);

        assertEq(book.fairOut(id, 1e18), ONE_WETH_IN_USDG, "1 WETH must be 2,503.760376 USDG, in USDG's 6 decimals");
        assertTrue(book.fairOut(id, 1e18) != ONE_WETH_IN_USDG_IF_MISPINNED, "and NOT the 18-decimal mis-pin");

        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        assertEq(legIn, 1e18, "one whole WETH");
        assertEq(floorOut, (ONE_WETH_IN_USDG * (10_000 - SLIP_BPS)) / 10_000, "floor is fair less the tolerance");

        // End to end, through the router, into the owner's balance — so the decimals are proved on the
        // path that moves money and not only in a view.
        usdgVenue.setPayOut(floorOut);
        uint256 ownerUsdg0 = usdg.balanceOf(owner);
        uint256 ownerWeth0 = weth.balanceOf(owner);
        vm.prank(keeper);
        book.fillLeg(id, _pairPlan(address(weth), address(usdg), address(usdgVenue), legIn, floorOut));

        assertEq(usdg.balanceOf(owner) - ownerUsdg0, floorOut, "the owner received the floor in real USDG");
        assertEq(ownerWeth0 - weth.balanceOf(owner), 1e18, "for exactly one WETH");
        assertApproxEqRel(usdg.balanceOf(owner) - ownerUsdg0, 2_478.72e6, 0.001e18, "~2,478.72 USDG, not 2.4 or 2.4e15");
    }

    /// @notice A USDG-IN LEG. The same pair the other way round: six decimals in, eighteen out. A single
    ///         scale factor written once and used for both directions is exactly the bug that passes a
    ///         one-direction test, so this direction is measured independently rather than inferred.
    function test_bothDirectionsPriceCorrectly_usdgIn() public {
        uint256 id = _order(address(usdg), address(weth), 1_000e6, 1);

        // 1,000 USDG at $0.9999 buys 999.9 / 2503.51 = 0.399399243462... WETH.
        assertEq(book.fairOut(id, 1_000e6), 399_399_243_462_179_100, "1,000 USDG must be 0.3993992434 WETH");

        (uint256 legIn, uint256 floorOut) = book.currentLeg(id);
        assertEq(legIn, 1_000e6, "one thousand whole USDG");
        assertEq(floorOut, (uint256(399_399_243_462_179_100) * (10_000 - SLIP_BPS)) / 10_000, "floor is fair less tolerance");

        wethVenue.setPayOut(floorOut);
        uint256 ownerWeth0 = weth.balanceOf(owner);
        uint256 ownerUsdg0 = usdg.balanceOf(owner);
        vm.prank(keeper);
        book.fillLeg(id, _pairPlan(address(usdg), address(weth), address(wethVenue), legIn, floorOut));

        assertEq(weth.balanceOf(owner) - ownerWeth0, floorOut, "the owner received the floor in real WETH");
        assertEq(ownerUsdg0 - usdg.balanceOf(owner), 1_000e6, "for exactly one thousand USDG");
        assertApproxEqRel(weth.balanceOf(owner) - ownerWeth0, 0.395405e18, 0.001e18, "~0.3954 WETH");
    }

    /// @notice THE ROUND TRIP. Price a WETH leg into USDG, then price that USDG back into WETH, and the
    ///         quantity has to come home. Any asymmetry in the scale factors — the shape of error where
    ///         one direction multiplies by 1e12 and the other forgets to divide — shows up here as an
    ///         answer that is out by orders of magnitude rather than by truncation.
    function test_theTwoDirectionsAreInversesOfEachOther() public {
        uint256 out = _order(address(weth), address(usdg), 1e18, 1);
        uint256 back = _order(address(usdg), address(weth), 1_000e6, 1);

        uint256 usdgForOneWeth = book.fairOut(out, 1e18);
        uint256 wethBack = book.fairOut(back, usdgForOneWeth);
        // The only loss is the truncation to USDG's six decimals in the middle: at most one raw USDG unit,
        // which at $2,503 an ether is about 4e8 wei. The tolerance is four orders of magnitude above that
        // and still twelve below a decimals error, so this cannot pass by being generous.
        assertApproxEqAbs(wethBack, 1e18, 1e12, "a WETH round-trips to a WETH, up to 6-decimal truncation");
        assertTrue(wethBack < 1e18, "and comes home slightly SHORT, because both conversions round down");
    }

    /// @notice THE TOKEN'S OWN DECIMALS ARE READ FROM THE TOKEN, never taken on trust, and the difference
    ///         is a factor of 1e12 on this pair. Two feeds with identical prices over tokens of different
    ///         precision must produce different raw quantities — if `tokenDecimals` were ignored (or
    ///         assumed 18 everywhere) these two would be equal.
    function test_theTokensOwnDecimalsAreWhatSeparatesTheseTwoQuotes() public {
        MockERC20 usdgLike18 = new MockERC20("Eighteen", "E18", 18);
        MockAggregator sameFeed = new MockAggregator(FEED_DECIMALS, USDG_USD);
        _liveFeeds.push(sameFeed);
        _registerFeed(book, address(usdgLike18), sameFeed, MAX_AGE_HEARTBEAT);

        uint256 toSix = _order(address(weth), address(usdg), 1e18, 1);
        uint256 toEighteen = _order(address(weth), address(usdgLike18), 1e18, 1);

        assertEq(book.fairOut(toSix, 1e18), ONE_WETH_IN_USDG, "six decimals");
        assertEq(book.fairOut(toEighteen, 1e18), ONE_WETH_IN_USDG_IF_MISPINNED, "eighteen decimals, same price");
        assertEq(
            book.fairOut(toEighteen, 1e18) / 1e12,
            book.fairOut(toSix, 1e18),
            "identical USD prices, twelve orders of magnitude apart in raw units"
        );
    }

    /// @notice THE FEED's decimals matter as much as the token's, and are pinned the same way: a 6-decimal
    ///         feed reporting the same price must price a leg identically to an 8-decimal one.
    function test_feedPrecisionIsNormalisedRatherThanAssumed() public {
        MockAggregator sixDecEth = new MockAggregator(6, 2_503_510_000); // $2,503.51 at SIX decimals
        _liveFeeds.push(sixDecEth);
        MockERC20 weth2 = new MockERC20("Wrapped Ether 2", "WETH2", 18);
        _registerFeed(book, address(weth2), sixDecEth, MAX_AGE_FAST);

        uint256 viaEight = _order(address(weth), address(usdg), 1e18, 1);
        uint256 viaSix = _order(address(weth2), address(usdg), 1e18, 1);
        assertEq(book.fairOut(viaSix, 1e18), book.fairOut(viaEight, 1e18), "same price, different feed precision");
    }

    /* ═══════════════════════════ 2. THE FEED GUARDS, ONE AT A TIME ════════════════════════════════ */

    /// @notice A FUTURE-DATED ROUND IS REFUSED, and this is the guard whose absence is invisible in every
    ///         test that only moves the clock forwards. `now - updatedAt <= maxAge` bounds only how OLD a
    ///         round may be, so a round dated thirty days ahead is PERMANENTLY fresh and the age bound
    ///         defeats itself — the feed could go silent immediately after and this book would keep
    ///         pricing every leg off that one answer for a month. Measured here: the age check is shown
    ///         to be satisfied at the same moment the future check refuses.
    function test_aFutureDatedRoundIsRefusedRatherThanTreatedAsPermanentlyFresh() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);
        _freezeFeeds();

        ethFeed.setUpdatedAt(block.timestamp + 30 days);

        (bool answered, uint8 codeIn, uint32 ageIn,,,,) = book.anchorStatus(id);
        assertFalse(answered, "not usable");
        assertEq(codeIn, book.FEED_FUTURE_DATED(), "and named as a clock problem, not a staleness problem");
        assertEq(ageIn, 0, "there is no age to report for a round that has not happened yet");

        vm.expectRevert(
            abi.encodeWithSelector(
                MoleOrders.FutureDatedRound.selector, address(ethFeed), block.timestamp + 30 days, block.timestamp
            )
        );
        book.currentLeg(id);

        // THE POINT OF THE GUARD: without it this feed is "fresh" for thirty days. Wander a week into the
        // future with no further transmission and the age bound STILL would not have fired.
        _advance(7 days);
        assertLt(block.timestamp, ethFeed.updatedAt(), "still future-dated a week later");
        (, codeIn,,,,,) = book.anchorStatus(id);
        assertEq(codeIn, book.FEED_FUTURE_DATED(), "and still refused, by the only check that can see it");

        // And it recovers the moment the feeds publish honest rounds (USDG is a week stale by now too,
        // which is the age bound doing its job on the side that was never lying about the clock).
        ethFeed.stamp();
        usdgFeed.stamp();
        assertTrue(book.fillable(id), "an honest transmission clears it");
    }

    /// @notice ZERO AND NEGATIVE ARE NOT PRICES. A zero answer would make the market floor zero and hand
    ///         the leg back to the owner's absolute floor, which is the stale-limit hole; a negative one
    ///         is nonsense that a signed cast would silently turn enormous.
    function test_aNonPositiveAnswerIsRefused() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);

        ethFeed.setRawAnswer(0);
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.NonPositiveAnswer.selector, address(ethFeed), int256(0)));
        book.currentLeg(id);
        (, uint8 code,,,,,) = book.anchorStatus(id);
        assertEq(code, book.FEED_NON_POSITIVE(), "reported without reverting");

        ethFeed.setRawAnswer(-1);
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.NonPositiveAnswer.selector, address(ethFeed), int256(-1)));
        book.currentLeg(id);

        // And the ZERO case is refused rather than degrading to the owner's own floor, which is the whole
        // reason it is a hard error: an order whose absolute floor is one wei must not become fillable.
        ethFeed.setRawAnswer(0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.NonPositiveAnswer.selector, address(ethFeed), int256(0)));
        book.fillLeg(id, _pairPlan(address(weth), address(usdg), address(usdgVenue), 1e18, 1));
    }

    /// @notice `answeredInRound < roundId` IS THE FEED CONTRADICTING ITS OWN BOOKKEEPING while every other
    ///         value it reports still looks perfectly reasonable — a current timestamp, a plausible price,
    ///         the right decimals. It is the one condition where nothing about the ANSWER is wrong and the
    ///         feed is still not to be believed.
    function test_answeredInRoundBehindRoundIdIsRefused() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);

        usdgFeed.setRounds(50, 49);
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.StaleRound.selector, address(usdgFeed), uint256(50), uint256(49)));
        book.currentLeg(id);
        (bool answered,,,, uint8 codeOut,,) = book.anchorStatus(id);
        assertFalse(answered, "not usable");
        assertEq(codeOut, book.FEED_STALE_ROUND(), "and named on the OUTPUT side, which is where it is");

        // Equality is fine — that is the normal case — so the guard is `<` and not `<=`.
        usdgFeed.setRounds(50, 50);
        assertTrue(book.fillable(id), "answeredInRound == roundId is a healthy feed");
    }

    /// @notice EACH FEED IS AGED AGAINST ITS OWN BOUND, and that is not a convenience: these two
    ///         heartbeats differ by two orders of magnitude. A single global bound is either a permanent
    ///         outage for the 24-hour feed or useless for the deviation feed, and this test walks the clock
    ///         through the window where exactly one of them is late — the window a global bound cannot
    ///         represent at all.
    function test_eachFeedIsAgedAgainstItsOwnBound() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);
        _freezeFeeds();

        // Under both bounds: healthy.
        _advance(MAX_AGE_FAST);
        assertTrue(book.fillable(id), "at exactly its bound the fast feed is still usable");

        // Past ETH's 1-hour bound, nowhere near USDG's 25-hour one.
        _advance(1);
        (bool answered, uint8 codeIn, uint32 ageIn, uint32 maxAgeIn, uint8 codeOut, uint32 ageOut, uint32 maxAgeOut) =
            book.anchorStatus(id);
        assertFalse(answered, "the pair is not priceable");
        assertEq(codeIn, book.FEED_STALE(), "because the FAST feed is late");
        assertEq(ageIn, MAX_AGE_FAST + 1, "by exactly one second");
        assertEq(maxAgeIn, MAX_AGE_FAST, "against its own bound");
        assertEq(codeOut, book.FEED_OK(), "while the heartbeat feed is perfectly healthy");
        assertEq(ageOut, MAX_AGE_FAST + 1, "at the same age");
        assertEq(maxAgeOut, MAX_AGE_HEARTBEAT, "against a bound 25 times larger");
        vm.expectRevert(
            abi.encodeWithSelector(
                MoleOrders.StalePrice.selector, address(ethFeed), uint32(MAX_AGE_FAST + 1), MAX_AGE_FAST
            )
        );
        book.currentLeg(id);

        // The fast feed publishes; now only the slow one can be the problem, and it is not yet.
        ethFeed.stamp();
        assertTrue(book.fillable(id), "one transmission on the late feed is enough");

        // Walk on past the heartbeat feed's own bound, keeping the fast one alive.
        _advance(MAX_AGE_HEARTBEAT + 1 - (MAX_AGE_FAST + 1));
        ethFeed.stamp();
        (answered, codeIn,,, codeOut, ageOut, maxAgeOut) = book.anchorStatus(id);
        assertFalse(answered, "now the other one is late");
        assertEq(codeIn, book.FEED_OK(), "the fast feed is current");
        assertEq(codeOut, book.FEED_STALE(), "and the heartbeat feed is not");
        assertEq(ageOut, MAX_AGE_HEARTBEAT + 1, "one second past ITS bound, which is 25x the other's");
        vm.expectRevert(
            abi.encodeWithSelector(
                MoleOrders.StalePrice.selector, address(usdgFeed), uint32(MAX_AGE_HEARTBEAT + 1), MAX_AGE_HEARTBEAT
            )
        );
        book.currentLeg(id);
    }

    /// @notice A PROXY THAT REPOINTS AT AN AGGREGATOR OF DIFFERENT PRECISION rescales the entire book by a
    ///         power of ten while every other field stays plausible. The precision is pinned at
    ///         registration and re-checked on EVERY read, so the change is caught rather than priced.
    function test_aFeedThatChangesItsDecimalsIsRefused() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);
        uint256 fairBefore = book.fairOut(id, 1e18);

        ethFeed.setDecimals(18);
        vm.expectRevert(
            abi.encodeWithSelector(MoleOrders.FeedDecimalsChanged.selector, address(ethFeed), uint8(8), uint256(18))
        );
        book.currentLeg(id);
        (, uint8 code,,,,,) = book.anchorStatus(id);
        assertEq(code, book.FEED_DECIMALS_CHANGED(), "reported, not reverted, in the view");

        // Put it back and the same order prices exactly as it did — so the refusal is the decimals change
        // and nothing else about the read.
        ethFeed.setDecimals(8);
        assertEq(book.fairOut(id, 1e18), fairBefore, "unchanged once the precision is what it was pinned as");
    }

    /// @notice AN AGGREGATOR THAT REVERTS, ONE THAT ANSWERS TOO SHORT, AND ONE WITH NO CODE AT ALL. All
    ///         three are the same thing to a floor — no price — and all three must leave the VIEWS
    ///         answering, because a codeless address returns success with EMPTY returndata, which is a
    ///         decode failure rather than a catchable revert and would walk straight past try/catch.
    function test_anUnreadableAggregatorIsRefusedAndTheViewsStillAnswer() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);

        ethFeed.setDown(true);
        (bool answered, uint8 code,,,,,) = book.anchorStatus(id);
        assertFalse(answered, "a reverting proxy is not a price");
        assertEq(code, book.FEED_UNREADABLE(), "and the view did not revert with it");
        assertFalse(book.fillable(id), "not fillable");
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.FeedUnreadable.selector, address(ethFeed)));
        book.currentLeg(id);
        ethFeed.setDown(false);

        ethFeed.setTruncated(true);
        (, code,,,,,) = book.anchorStatus(id);
        assertEq(code, book.FEED_UNREADABLE(), "two words is not a round");
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.FeedUnreadable.selector, address(ethFeed)));
        book.currentLeg(id);
        ethFeed.setTruncated(false);

        // The one that escapes a naive try/catch: no code at the address at all.
        vm.etch(address(ethFeed), hex"");
        (answered, code,,,,,) = book.anchorStatus(id);
        assertFalse(answered, "an address with no code is not an oracle");
        assertEq(code, book.FEED_UNREADABLE(), "and the view STILL answered");
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.FeedUnreadable.selector, address(ethFeed)));
        book.currentLeg(id);
    }

    /// @notice AN ANSWER TOO LARGE TO SCALE is refused as a NUMBER rather than allowed to become an
    ///         arithmetic panic three frames down. The bound is not a taste judgement: MAX_FEED_ANSWER is
    ///         exactly `type(uint256).max / 1e36`, and 1e36 is the largest scale factor the decimals caps
    ///         permit, so an answer at or under it provably cannot overflow the multiplication and one
    ///         above it is refused before the multiplication happens.
    function test_anAnswerTooLargeToScaleIsRefusedRatherThanPanicking() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);
        uint256 cap = book.MAX_FEED_ANSWER();

        // Exactly at the cap: still a price, and still priced.
        ethFeed.setRawAnswer(int256(cap));
        assertTrue(book.fillable(id), "the cap itself is inside the band");
        assertGt(book.fairOut(id, 1e18), 0, "and prices");

        ethFeed.setRawAnswer(int256(cap) + 1);
        (, uint8 code,,,,,) = book.anchorStatus(id);
        assertEq(code, book.FEED_ANSWER_TOO_LARGE(), "one above it is not");
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.AnswerTooLarge.selector, address(ethFeed), cap + 1));
        book.currentLeg(id);

        // And an answer that WOULD have overflowed at this pair's own scale gets the same named refusal
        // rather than a Panic(0x11).
        ethFeed.setRawAnswer(int256(1e70));
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.AnswerTooLarge.selector, address(ethFeed), uint256(1e70)));
        book.currentLeg(id);
    }

    /// @notice DIRTY HIGH BITS IN THE ROUND IDS CANNOT MAKE A VIEW REVERT. `abi.decode(ret, (uint80, ...))`
    ///         reverts on a word that does not fit the narrow type, and a hostile aggregator sets those
    ///         bits for free — the revert would escape straight out of `anchorStatus` and `fillable`, which
    ///         are required never to revert. Decoding into uint256 and comparing there cannot be tripped,
    ///         and the comparison the contract actually needs is exact in the wide type.
    function test_dirtyHighBitsInTheRoundIdsCannotMakeAViewRevert() public {
        DirtyRoundAggregator dirty = new DirtyRoundAggregator();
        MockERC20 tok = new MockERC20("Dirty", "DIRTY", 18);

        // Registration itself is the first proof: it reads the feed through the identical path.
        _registerFeed(book, address(tok), MockAggregator(address(dirty)), MAX_AGE_FAST);

        uint256 id = _order(address(tok), address(usdg), 1e18, 1);
        (bool answered, uint8 codeIn,,,,,) = book.anchorStatus(id);
        assertTrue(answered, "the price is good; only the round-id WIDTH is hostile");
        assertEq(codeIn, book.FEED_OK(), "and it decodes without reverting");
        assertTrue(book.fillable(id), "so the order is fillable");
        assertGt(book.fairOut(id, 1e18), 0, "and priced");
    }

    /* ═════════════════════════ 3. REGISTRATION IS STRICT, AND BOUNDED ═════════════════════════════ */

    /// @notice A FEED THAT CANNOT SERVE A CLEAN PRICE TODAY CANNOT BE REGISTERED TODAY. Nothing is at stake
    ///         in the admin's transaction and the admin is present to see the failure; at fill time the
    ///         same condition is a stalled order nobody is watching.
    function test_aFeedThatCannotServeAPriceCannotBeRegistered() public {
        MockERC20 tok = new MockERC20("T", "T", 18);
        MockAggregator dead = new MockAggregator(FEED_DECIMALS, ONE_USD);
        vm.warp(block.timestamp + 5 hours); // it stops publishing

        vm.startPrank(admin);
        vm.expectRevert(
            abi.encodeWithSelector(MoleOrders.StalePrice.selector, address(dead), uint32(5 hours), MAX_AGE_FAST)
        );
        book.registerFeed(address(tok), address(dead), MAX_AGE_FAST);

        dead.setRawAnswer(0);
        dead.stamp();
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.NonPositiveAnswer.selector, address(dead), int256(0)));
        book.registerFeed(address(tok), address(dead), MAX_AGE_FAST);

        dead.setRawAnswer(ONE_USD);
        dead.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                MoleOrders.FutureDatedRound.selector, address(dead), block.timestamp + 1, block.timestamp
            )
        );
        book.registerFeed(address(tok), address(dead), MAX_AGE_FAST);

        dead.setDown(true);
        vm.expectRevert(abi.encodeWithSelector(MoleOrders.FeedUnreadable.selector, address(dead)));
        book.registerFeed(address(tok), address(dead), MAX_AGE_FAST);

        // Healthy: accepted. So every refusal above was the condition and not the shape of the call.
        dead.setDown(false);
        dead.stamp();
        book.registerFeed(address(tok), address(dead), MAX_AGE_FAST);
        vm.stopPrank();

        (address agg, uint32 maxAge, uint8 fd, uint8 td, bool set) = book.feeds(address(tok));
        assertEq(agg, address(dead), "stored");
        assertEq(maxAge, MAX_AGE_FAST, "with its own bound");
        assertEq(fd, 8, "the feed's precision, read from the feed");
        assertEq(td, 18, "and the token's, read from the token");
        assertTrue(set, "and marked present");
    }

    /// @notice THE AGE BOUND HAS A BAND OF ITS OWN. Below MIN_FEED_MAX_AGE no feed on this chain can ever
    ///         satisfy it, so the pair would be bricked by a typo rather than protected; above
    ///         MAX_FEED_MAX_AGE a 24-hour heartbeat keeps being served two whole heartbeats after it died.
    function test_theAgeBoundIsItselfBounded() public {
        MockERC20 tok = new MockERC20("T", "T", 18);
        MockAggregator agg = new MockAggregator(FEED_DECIMALS, ONE_USD);
        uint32 lo = book.MIN_FEED_MAX_AGE();
        uint32 hi = book.MAX_FEED_MAX_AGE();

        vm.startPrank(admin);
        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(tok), address(agg), lo - 1);
        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(tok), address(agg), hi + 1);
        book.registerFeed(address(tok), address(agg), lo); // the boundary itself is legal
        book.registerFeed(address(tok), address(agg), hi); // both of them
        vm.stopPrank();
    }

    /// @notice DECIMALS ABOVE THE CAP, AND ADDRESSES THAT CANNOT ANSWER `decimals()` AT ALL. The cap is
    ///         what makes the scale factor provably at most 1e36 and therefore what makes MAX_FEED_ANSWER
    ///         a real overflow bound rather than a guess.
    function test_registrationRefusesUnpinnableDecimalsAndUnaskableAddresses() public {
        MockERC20 wide = new MockERC20("Wide", "WIDE", 19);
        MockERC20 ok18 = new MockERC20("Ok", "OK", 18);
        MockAggregator wideFeed = new MockAggregator(19, ONE_USD);
        MockAggregator goodFeed = new MockAggregator(FEED_DECIMALS, ONE_USD);

        vm.startPrank(admin);
        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(wide), address(goodFeed), MAX_AGE_FAST); // token too wide

        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(ok18), address(wideFeed), MAX_AGE_FAST); // feed too wide

        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(0), address(goodFeed), MAX_AGE_FAST);

        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(ok18), address(0), MAX_AGE_FAST);

        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(makeAddr("eoa"), address(goodFeed), MAX_AGE_FAST); // a token with no code

        vm.expectRevert(MoleOrders.BadFeedConfig.selector);
        book.registerFeed(address(ok18), makeAddr("eoa2"), MAX_AGE_FAST); // an aggregator with no code

        book.registerFeed(address(ok18), address(goodFeed), MAX_AGE_FAST); // the control
        vm.stopPrank();
    }

    function test_onlyTheAdminMayRegisterAFeed() public {
        MockERC20 tok = new MockERC20("T", "T", 18);
        MockAggregator agg = new MockAggregator(FEED_DECIMALS, ONE_USD);

        vm.prank(attacker);
        vm.expectRevert(MoleOrders.NotAdmin.selector);
        book.registerFeed(address(tok), address(agg), MAX_AGE_FAST);

        vm.prank(keeper);
        vm.expectRevert(MoleOrders.NotAdmin.selector);
        book.registerFeed(address(tok), address(agg), MAX_AGE_FAST);

        vm.prank(owner);
        vm.expectRevert(MoleOrders.NotAdmin.selector);
        book.sealFeeds();
    }

    /* ═══════════════ 4. THE ADMIN'S NEW POWER, AND EVERY BOUND PUT ON IT ══════════════════════════ */

    /// @notice THE ONE PROPERTY THAT MAKES THE ADMIN'S NEW POWER ACCEPTABLE: an order snapshots its feeds
    ///         at creation, so re-registering a token's feed changes what the NEXT order binds to and has
    ///         no power at all over money already committed. Driven as an attack: the admin swaps in a
    ///         feed quoting ETH at one dollar and the standing order does not notice.
    function test_reRegisteringAFeedCannotRetargetAnExistingOrder() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);
        uint256 fairBefore = book.fairOut(id, 1e18);
        (, uint256 floorBefore) = book.currentLeg(id);

        MockAggregator hostile = new MockAggregator(FEED_DECIMALS, ONE_USD); // ETH at $1.00
        _liveFeeds.push(hostile);
        _registerFeed(book, address(weth), hostile, MAX_AGE_FAST);

        assertEq(book.fairOut(id, 1e18), fairBefore, "the standing order prices off the feed it bound to");
        (, uint256 floorAfter) = book.currentLeg(id);
        assertEq(floorAfter, floorBefore, "so its floor is untouched");
        assertEq(book.boundOf(id).inFeed.aggregator, address(ethFeed), "and it still names the original feed");

        // A NEW order does bind to the new one, which is what registration is for.
        uint256 fresh = _order(address(weth), address(usdg), 1e18, 1);
        assertEq(book.boundOf(fresh).inFeed.aggregator, address(hostile), "the next order binds to the new feed");
        assertLt(book.fairOut(fresh, 1e18), fairBefore / 1000, "and prices off it");
    }

    /// @notice AND THE POWER CAN BE GIVEN UP, PERMANENTLY. After `sealFeeds` the admin is back to rotating
    ///         the keeper and nothing else: no registration, no replacement, no un-sealing, not even by a
    ///         new admin who accepts the handover afterwards.
    function test_sealingIsPermanentAndSurvivesAnAdminHandover() public {
        MockERC20 tok = new MockERC20("T", "T", 18);
        MockAggregator agg = new MockAggregator(FEED_DECIMALS, ONE_USD);

        assertFalse(book.feedsSealed(), "open to begin with");
        vm.prank(admin);
        book.sealFeeds();
        assertTrue(book.feedsSealed(), "sealed");

        vm.prank(admin);
        vm.expectRevert(MoleOrders.FeedsAreSealed.selector);
        book.registerFeed(address(tok), address(agg), MAX_AGE_FAST);

        // Even replacing an ALREADY-registered feed is refused, which is the case that matters: a sealed
        // book cannot have its live pair repointed.
        vm.prank(admin);
        vm.expectRevert(MoleOrders.FeedsAreSealed.selector);
        book.registerFeed(address(weth), address(agg), MAX_AGE_FAST);

        // A fresh admin inherits the seal, not a way around it.
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        book.transferAdmin(newAdmin);
        vm.prank(newAdmin);
        book.acceptAdmin();
        vm.prank(newAdmin);
        vm.expectRevert(MoleOrders.FeedsAreSealed.selector);
        book.registerFeed(address(tok), address(agg), MAX_AGE_FAST);

        // The keeper rotation still works, so the seal removed exactly one power and no others.
        vm.prank(newAdmin);
        book.setKeeper(makeAddr("k2"));
        assertEq(book.keeper(), makeAddr("k2"), "the admin can still rotate the keeper");
    }

    /* ═══════════════════════ 5. THE EXIT, WHICH NO FEED MAY EVER STAND IN ═════════════════════════ */

    /// @notice THE OWNER'S EXIT NEVER TOUCHES A FEED. This contract takes a standing ERC-20 approval, so
    ///         "the oracle broke and now nobody can get their money out" would be a worse outcome than any
    ///         bad fill. Every feed is broken every way at once — reverting, wrong decimals, hours stale,
    ///         and finally with its code removed from the chain entirely — while registration is sealed so
    ///         nothing can be repaired. Fills are refused throughout. The cancel still works.
    function test_cancelOrderNeverTouchesAFeed() public {
        uint256 wethOrder = _order(address(weth), address(usdg), 1e18, 1);
        uint256 usdgOrder = _order(address(usdg), address(weth), 1_000e6, 1);
        uint256 abOrder = _createOrder(1e18, 5e18, 1, 0);
        // A fourth order, created while the feeds are still healthy, kept back for the authorisation check
        // at the end: `createOrder` DOES read the feeds, so it cannot be the thing that proves the exit.
        uint256 fresh = _order(address(weth), address(usdg), 1e18, 1);

        // Seal first, so there is genuinely no repair path available to anybody.
        vm.prank(admin);
        book.sealFeeds();

        _freezeFeeds();
        ethFeed.setDown(true);
        usdgFeed.setDecimals(18);
        _advance(30 hours); // and every feed is now far past its own bound as well
        vm.etch(address(feedA), hex""); // the aggregator's code is gone from the chain

        // Nothing can be priced, and every fill path says so.
        assertFalse(book.fillable(wethOrder), "not fillable");
        assertFalse(book.fillable(usdgOrder), "not fillable");
        assertFalse(book.fillable(abOrder), "not fillable");
        vm.expectRevert();
        book.currentLeg(wethOrder);
        vm.prank(keeper);
        vm.expectRevert();
        book.fillLeg(wethOrder, _pairPlan(address(weth), address(usdg), address(usdgVenue), 1e18, 1));

        // The exit is unaffected — all three of them, in one transaction each, with no price read anywhere.
        vm.startPrank(owner);
        book.cancelOrder(wethOrder);
        book.cancelOrder(usdgOrder);
        book.cancelOrder(abOrder);
        vm.stopPrank();

        (,,,,,,,,, bool a1) = book.orders(wethOrder);
        (,,,,,,,,, bool a2) = book.orders(usdgOrder);
        (,,,,,,,,, bool a3) = book.orders(abOrder);
        assertFalse(a1, "cancelled");
        assertFalse(a2, "cancelled");
        assertFalse(a3, "cancelled");

        // And the cancel is still the OWNER's, not anyone else's — failing open on the feed must not have
        // failed open on authorisation.
        vm.prank(attacker);
        vm.expectRevert(MoleOrders.NotOrderOwner.selector);
        book.cancelOrder(fresh);
        vm.prank(admin);
        vm.expectRevert(MoleOrders.NotOrderOwner.selector);
        book.cancelOrder(fresh);
    }

    /// @notice THE SAME PROPERTY MEASURED IN GAS RATHER THAN IN OUTCOME. A cancel that reads a feed would
    ///         cost two external staticcalls per side; this one is three storage reads and a write. The
    ///         bound is loose on purpose — it is a shape check, not a gas budget — but it is low enough
    ///         that no feed read can hide under it.
    function test_cancelCostsNoOracleReads() public {
        uint256 id = _order(address(weth), address(usdg), 1e18, 1);
        vm.prank(owner);
        uint256 before = gasleft();
        book.cancelOrder(id);
        uint256 used = before - gasleft();
        emit log_named_uint("cancelOrder gas", used);
        assertLt(used, 15_000, "a cancel that consulted two aggregators could not fit in this");
    }
}
