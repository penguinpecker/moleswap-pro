// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {MoleOrders} from "../src/MoleOrders.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {DeployMoleOrders} from "../script/DeployMoleOrders.s.sol";
import {MockAggregator} from "./helpers/MockAggregator.sol";

/// @notice The deploy script's own guards, each fired on its own.
///
/// A deploy script is the one piece of code that runs exactly once, against real money, with no second
/// chance — and the one piece that habitually ships untested because "it is just a script". Every
/// `require` in `script/DeployMoleOrders.s.sol` is a claim about the deployment, and a claim nothing can
/// falsify is decoration. Each test below breaks exactly ONE precondition and leaves every other one
/// intact, so a failure names the actual guard rather than proving that something, somewhere, was wrong.
///
/// TWO OF THESE GUARDS ARE NOT REDUNDANT WITH THE CONTRACT and are the reason the script exists:
///   - `test_checkFeed_rejectsTheWrongPairEvenWhenEverythingElseIsPerfect` — ETH/USD and WBTC/USD are both
///     live on Robinhood Chain, both 8 decimals, both answering, and `MoleOrders.registerFeed` accepts
///     either without complaint. Only `description()` separates them.
///   - `test_checkFeed_rejectsATokenWhoseDecimalsAreNotAsPinned` — the contract reads the token's own
///     `decimals()`, which is right, but has no opinion about what it should be. USDG is SIX decimals on
///     this chain and WETH is eighteen.
/// The rest deliberately duplicate checks `registerFeed` also makes. That duplication buys one thing: they
/// fail BEFORE anything is broadcast, and inside `audit()` where nothing is deployed at all.
contract DeployMoleOrdersTest is Test {
    /* ------------------------------------------------------------------ the script's pinned addresses */

    uint256 internal constant RH_MAINNET = 4663;
    address internal constant FRONTEND_ROUTER = 0xBd9B841d690E31B61aa3858EB145EA8BBe71122c;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant FEED_ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant FEED_USDG_USD = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;

    /// @dev The live answers measured on 2026-08-24, so the fixture prices are the real ones.
    int256 internal constant ETH_USD_8DP = 251_664_000_000; // $2,516.64
    int256 internal constant USDG_USD_8DP = 99_986_755; // $0.99986755

    uint32 internal constant ETH_MAX_AGE = 7200;
    uint32 internal constant USDG_MAX_AGE = 93_600;

    DeployHarness internal script;
    DescribedAggregator internal ethFeed;
    MockToken internal weth;

    function setUp() public {
        vm.chainId(RH_MAINNET);
        vm.warp(1_787_585_073); // the timestamp the live simulation ran at
        script = new DeployHarness();

        ethFeed = new DescribedAggregator(8, ETH_USD_8DP, "ETH / USD");
        weth = new MockToken(18);

        // `auditBook` reads each predecessor's WETH and USDG escrow, so the two pinned tokens have to
        // exist for any audit test to run. On the live chain they always do; `_requireChain` is what makes
        // that a fact rather than a hope.
        vm.etch(WETH, address(new MockToken(18)).code);
        vm.etch(USDG, address(new MockToken(6)).code);
    }

    /* ---------------------------------------------------------------------------------- the fixture */

    /// @dev A spec in which EVERY condition holds. Each test takes this and breaks one field.
    function _goodSpec() internal view returns (DeployMoleOrders.FeedSpec memory) {
        return DeployMoleOrders.FeedSpec({
            token: address(weth),
            tokenDecimals: 18,
            aggregator: address(ethFeed),
            description: "ETH / USD",
            maxAge: ETH_MAX_AGE
        });
    }

    /* ══════════════════════════════════════════════════════════════════ G1 — the chain guard */

    function test_chainGuard_rejectsEveryChainButRobinhoodMainnet() public {
        vm.chainId(46_630); // the TESTNET, one digit away
        vm.expectRevert("DeployMoleOrders: not Robinhood Chain mainnet (4663)");
        script.exposedRequireChain();

        vm.chainId(1);
        vm.expectRevert("DeployMoleOrders: not Robinhood Chain mainnet (4663)");
        script.exposedRequireChain();

        vm.chainId(RH_MAINNET);
        script.exposedRequireChain(); // and passes on the one chain the address book is for
    }

    /* ═══════════════════════════════════════════════════════════ G2/G3 — the router guards */

    function test_routerGuard_rejectsARouterWithNoCode() public {
        vm.expectRevert("DeployMoleOrders: router has no code");
        script.requireRouterSane(FRONTEND_ROUTER, false); // pinned address, but nothing etched there yet
    }

    function test_routerGuard_rejectsARouterTheFrontendDoesNotApprove() public {
        address other = address(new MockToken(18)); // any contract that is not the frontend's router
        vm.expectRevert("DeployMoleOrders: router is not the one the frontend uses");
        script.requireRouterSane(other, false);

        script.requireRouterSane(other, true); // ...unless the operator says so explicitly
    }

    function test_routerGuard_acceptsTheRouterTheFrontendApproves() public {
        vm.etch(FRONTEND_ROUTER, address(new MockToken(18)).code);
        script.requireRouterSane(FRONTEND_ROUTER, false);
    }

    /* ═══════════════════════════════════════════════════════════════ G4-G12 — the feed guards */

    function test_checkFeed_acceptsAHealthyFeed() public view {
        (uint256 age, int256 answer) = script.checkFeed(_goodSpec());
        assertEq(age, 0, "a freshly stamped feed is zero seconds old");
        assertEq(answer, ETH_USD_8DP, "the answer is passed through unchanged");
    }

    function test_checkFeed_rejectsAnAggregatorWithNoCode() public {
        DeployMoleOrders.FeedSpec memory s = _goodSpec();
        s.aggregator = address(0xBAD);
        vm.expectRevert("DeployMoleOrders: aggregator has no code");
        script.checkFeed(s);
    }

    function test_checkFeed_rejectsAMaxAgeBelowTheContractMinimum() public {
        DeployMoleOrders.FeedSpec memory s = _goodSpec();
        s.maxAge = 59; // MoleOrders.MIN_FEED_MAX_AGE is 60
        vm.expectRevert("DeployMoleOrders: maxAge below MIN_FEED_MAX_AGE");
        script.checkFeed(s);
    }

    function test_checkFeed_rejectsAMaxAgeAboveTheContractMaximum() public {
        DeployMoleOrders.FeedSpec memory s = _goodSpec();
        s.maxAge = uint32(2 days) + 1; // MoleOrders.MAX_FEED_MAX_AGE is 2 days
        vm.expectRevert("DeployMoleOrders: maxAge above MAX_FEED_MAX_AGE");
        script.checkFeed(s);
    }

    function test_checkFeed_rejectsATokenWithNoCode() public {
        DeployMoleOrders.FeedSpec memory s = _goodSpec();
        s.token = address(0xC0FFEE);
        vm.expectRevert("DeployMoleOrders: token has no code");
        script.checkFeed(s);
    }

    /// @notice THE 6-VS-18 GUARD. `registerFeed` reads the token's decimals and believes them; only this
    ///         check knows that on Robinhood Chain USDG is six and WETH is eighteen. Getting it wrong is a
    ///         twelve-order-of-magnitude mispricing, not a rounding error.
    function test_checkFeed_rejectsATokenWhoseDecimalsAreNotAsPinned() public {
        DeployMoleOrders.FeedSpec memory s = _goodSpec();
        s.token = address(new MockToken(6)); // a six-decimal token in the eighteen-decimal slot
        vm.expectRevert("DeployMoleOrders: token decimals is not as pinned");
        script.checkFeed(s);
    }

    function test_checkFeed_rejectsFeedDecimalsOtherThanEight() public {
        ethFeed.setDecimals(18);
        vm.expectRevert("DeployMoleOrders: feed decimals is not 8");
        script.checkFeed(_goodSpec());
    }

    /// @notice THE IDENTITY GUARD, and the only check here the contract genuinely cannot make. This feed
    ///         is live, 8 decimals, freshly stamped, positive, complete — perfect in every way the
    ///         contract can see — and it is bitcoin's price in ether's slot.
    function test_checkFeed_rejectsTheWrongPairEvenWhenEverythingElseIsPerfect() public {
        DescribedAggregator wbtc = new DescribedAggregator(8, 7_954_631_951_015, "WBTC / USD");
        DeployMoleOrders.FeedSpec memory s = _goodSpec();
        s.aggregator = address(wbtc); // everything else about the spec still says ETH / USD

        vm.expectRevert("DeployMoleOrders: feed description does not match the expected pair");
        script.checkFeed(s);
    }

    function test_checkFeed_rejectsANonPositiveAnswer() public {
        ethFeed.setRawAnswer(0);
        vm.expectRevert("DeployMoleOrders: feed answer is not positive");
        script.checkFeed(_goodSpec());

        ethFeed.setRawAnswer(-1);
        vm.expectRevert("DeployMoleOrders: feed answer is not positive");
        script.checkFeed(_goodSpec());
    }

    function test_checkFeed_rejectsAFeedThatHasNeverBeenUpdated() public {
        ethFeed.setUpdatedAt(0); // Chainlink's own "no data"
        vm.expectRevert("DeployMoleOrders: feed has never been updated");
        script.checkFeed(_goodSpec());
    }

    function test_checkFeed_rejectsAFutureDatedRound() public {
        ethFeed.setUpdatedAt(block.timestamp + 1);
        vm.expectRevert("DeployMoleOrders: feed updatedAt is in the future");
        script.checkFeed(_goodSpec());
    }

    function test_checkFeed_rejectsAnIncompleteRound() public {
        ethFeed.setRounds(9, 8); // answeredInRound behind roundId: a carried-over answer
        vm.expectRevert("DeployMoleOrders: feed round is incomplete");
        script.checkFeed(_goodSpec());
    }

    /// @notice A feed already past the bound it is being handed ships a book that cannot fill on day one.
    ///         Sized against the REAL heartbeat: ETH/USD showed a 3,168 s gap in the four hours before this
    ///         was written, so the 3,600 s bound an unmeasured guess would have picked was already broken.
    function test_checkFeed_rejectsAFeedAlreadyStalerThanItsOwnBound() public {
        ethFeed.setUpdatedAt(block.timestamp - ETH_MAX_AGE - 1);
        vm.expectRevert("DeployMoleOrders: feed is already staler than its configured maxAge");
        script.checkFeed(_goodSpec());

        // ...and exactly at the bound is still fine, so the boundary is not off by one.
        ethFeed.setUpdatedAt(block.timestamp - ETH_MAX_AGE);
        (uint256 age,) = script.checkFeed(_goodSpec());
        assertEq(age, ETH_MAX_AGE, "the bound is inclusive");
    }

    /* ═════════════════════════════════════════════════════ G13/G15 — the migration guards */

    function test_requireNothingStranded_rejectsAnActiveOrderThatStillHoldsBudget() public {
        DeployMoleOrders.BookAudit memory a;
        a.activeWithBudget = 1;

        vm.expectRevert("DeployMoleOrders: predecessor holds an active order with budget");
        script.requireNothingStranded(a, false);

        script.requireNothingStranded(a, true); // ...unless the operator acknowledges it in writing
    }

    function test_requireNothingStranded_allowsABookOfPurelyHistoricalOrders() public view {
        DeployMoleOrders.BookAudit memory a;
        a.activeWithBudget = 0;
        script.requireNothingStranded(a, false);
    }

    /// @notice The audit must count only orders that can actually strand someone: still fillable AND still
    ///         holding unspent budget. The live predecessor has orders that are inactive-with-budget
    ///         (cancelled) and active-with-nothing-left (completed); neither carries value, and counting
    ///         either would block a migration that has nothing to move.
    function test_auditBook_countsOnlyOrdersThatAreBothActiveAndUnspent() public {
        MockLegacyBook book = new MockLegacyBook();
        book.push(address(1), 500, 500, true); // active, fully spent   -> no value
        book.push(address(2), 500, 0, false); // cancelled with budget -> no value
        book.push(address(3), 500, 100, true); // active, 400 remaining -> VALUE
        book.push(address(4), 500, 500, false); // completed             -> no value

        DeployMoleOrders.BookAudit memory a = script.auditBook(address(book));
        assertEq(a.orderCount, 4, "every order is seen");
        assertEq(a.activeCount, 2, "two are still active");
        assertEq(a.activeWithBudget, 1, "but only one of them can strand its owner");
    }

    /// @notice The off-by-one this loop is written to avoid. Ids run 1..orderCount, and the LAST id is the
    ///         newest order — the one most likely to still carry budget. A loop ending at orderCount-1
    ///         would miss exactly it.
    function test_auditBook_readsTheLastIdAndNotSlotZero() public {
        MockLegacyBook book = new MockLegacyBook();
        book.push(address(1), 500, 500, true); // id 1: no value
        book.push(address(2), 900, 0, true); // id 2: the newest, and the only one with value

        DeployMoleOrders.BookAudit memory a = script.auditBook(address(book));
        assertEq(a.activeWithBudget, 1, "the newest order was read");
    }

    function test_auditBook_rejectsABookWhoseIdsAreNotOneBased() public {
        MockLegacyBook book = new MockLegacyBook();
        book.populateSlotZero(address(9), 100, 0, true);

        vm.expectRevert("DeployMoleOrders: order id 0 is populated - ids are not 1-based");
        script.auditBook(address(book));
    }

    function test_auditBook_returnsEmptyForAnAddressWithNoCode() public view {
        DeployMoleOrders.BookAudit memory a = script.auditBook(address(0xDEAD));
        assertEq(a.orderCount, 0);
        assertEq(a.activeWithBudget, 0);
    }

    /* ═══════════════════════════════════════════ G14/G16/G17 — the post-deploy readback */

    /// @dev Builds the world the script expects at its PINNED addresses, deploys a real MoleOrders against
    ///      it and registers the real pair. Everything after this point is chain state, not a variable.
    function _deployRealBook() internal returns (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) {
        vm.etch(FRONTEND_ROUTER, address(new MockToken(18)).code);
        vm.etch(WETH, address(new MockToken(18)).code);
        vm.etch(USDG, address(new MockToken(6)).code);
        vm.etch(FEED_ETH_USD, address(new EthUsdStub()).code);
        vm.etch(FEED_USDG_USD, address(new UsdgUsdStub()).code);

        book = new MoleOrders(MoleRouter(payable(FRONTEND_ROUTER)), address(this), address(0));
        book.registerFeed(WETH, FEED_ETH_USD, ETH_MAX_AGE);
        book.registerFeed(USDG, FEED_USDG_USD, USDG_MAX_AGE);

        feeds = new DeployMoleOrders.FeedSpec[](2);
        feeds[0] = DeployMoleOrders.FeedSpec(WETH, 18, FEED_ETH_USD, "ETH / USD", ETH_MAX_AGE);
        feeds[1] = DeployMoleOrders.FeedSpec(USDG, 6, FEED_USDG_USD, "USDG / USD", USDG_MAX_AGE);
    }

    function test_verifyDeployment_passesOnACorrectlyWiredBook() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    /// @notice THE GUARD THAT KEEPS FILLS OFF. The whole point of deploying with `keeper == address(0)` is
    ///         that no fill can happen until a human has read the readback; a book that came back with a
    ///         keeper already set must stop the script, not print a line.
    function test_verifyDeployment_rejectsABookWhoseKeeperIsAlreadyLive() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        book.setKeeper(address(0xBEEF));

        vm.expectRevert("DeployMoleOrders: keeper did NOT start at address(0)");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    function test_verifyDeployment_rejectsAnAlreadySealedBook() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        book.sealFeeds();

        vm.expectRevert("DeployMoleOrders: feeds are already sealed");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    function test_verifyDeployment_rejectsAnAdminThatIsNotTheIntendedOne() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        vm.expectRevert("DeployMoleOrders: admin readback mismatch");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(0xA11CE), feeds);
    }

    function test_verifyDeployment_rejectsARouterThatIsNotTheIntendedOne() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        vm.expectRevert("DeployMoleOrders: router readback mismatch");
        script.verifyDeployment(book, address(0xB0B), address(this), feeds);
    }

    /// @notice The readback must compare chain state to a PINNED expectation, not to the spec it was
    ///         written from. Registering the ETH feed under USDG's token and then claiming the USDG
    ///         registration is correct is exactly the failure a self-referential readback would miss.
    function test_verifyDeployment_rejectsAFeedRegisteredAgainstTheWrongAggregator() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        // USDG re-registered against the ETH aggregator: still a live, valid, 8-decimal feed.
        book.registerFeed(USDG, FEED_ETH_USD, USDG_MAX_AGE);

        vm.expectRevert("DeployMoleOrders: feed aggregator readback mismatch");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    function test_verifyDeployment_rejectsAnUnregisteredToken() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        MockToken stranger = new MockToken(18);
        feeds[0].token = address(stranger); // never registered on the book

        vm.expectRevert("DeployMoleOrders: feed readback says not set");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    function test_verifyDeployment_rejectsAMaxAgeThatIsNotWhatWasAskedFor() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        book.registerFeed(WETH, FEED_ETH_USD, ETH_MAX_AGE + 1);

        vm.expectRevert("DeployMoleOrders: feed maxAge readback mismatch");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    /// @notice The mirrors of MoleOrders' own age bounds are only safe while they are mirrors. If lane 1
    ///         retunes either constant, the pre-broadcast checks would silently start passing in front of
    ///         a `registerFeed` that reverts.
    function test_constantsMirror_rejectsABoundThatDriftedFromTheContract() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();

        vm.mockCall(address(book), abi.encodeWithSignature("MIN_FEED_MAX_AGE()"), abi.encode(uint32(30)));
        vm.expectRevert("DeployMoleOrders: MIN_FEED_MAX_AGE mirror drifted");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
        vm.clearMockedCalls();

        vm.mockCall(address(book), abi.encodeWithSignature("MAX_FEED_MAX_AGE()"), abi.encode(uint32(3 days)));
        vm.expectRevert("DeployMoleOrders: MAX_FEED_MAX_AGE mirror drifted");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
        vm.clearMockedCalls();
    }

    /// @notice The readback must re-read the feed's IDENTITY from the aggregator, not trust that the
    ///         identity checked before the deploy is still the identity registered. Here the registration
    ///         is perfect and the aggregator sitting at that address is bitcoin's.
    function test_verifyDeployment_rejectsAnAggregatorThatDescribesTheWrongPairAtReadback() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        vm.etch(FEED_ETH_USD, address(new WbtcUsdStub()).code);

        vm.expectRevert("DeployMoleOrders: readback description does not match the expected pair");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
    }

    function test_verifyDeployment_rejectsAStoredFeedWidthThatIsNotEight() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        vm.mockCall(
            address(book),
            abi.encodeWithSignature("feeds(address)", WETH),
            abi.encode(FEED_ETH_USD, ETH_MAX_AGE, uint8(18), uint8(18), true)
        );

        vm.expectRevert("DeployMoleOrders: feed decimals readback is not 8");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
        vm.clearMockedCalls();
    }

    /// @notice The stored token width is what converts a raw balance into the units the USD price is
    ///         quoted in. A book that recorded eighteen for USDG prices it 1e12 too high.
    function test_verifyDeployment_rejectsAStoredTokenWidthThatIsNotAsPinned() public {
        (MoleOrders book, DeployMoleOrders.FeedSpec[] memory feeds) = _deployRealBook();
        vm.mockCall(
            address(book),
            abi.encodeWithSignature("feeds(address)", USDG),
            abi.encode(FEED_USDG_USD, USDG_MAX_AGE, uint8(8), uint8(18), true)
        );

        vm.expectRevert("DeployMoleOrders: token decimals readback mismatch");
        script.verifyDeployment(book, FRONTEND_ROUTER, address(this), feeds);
        vm.clearMockedCalls();
    }

    /* ════════════════════════════════════════════════════════════════════ G18 — the admin guard */

    function test_requireAdminSane_rejectsAnAdminOfZero() public {
        vm.expectRevert("DeployMoleOrders: admin is address(0)");
        script.requireAdminSane(address(0));

        script.requireAdminSane(address(0xA11CE));
    }

    /* ══════════════════════════════════════════════════════════════════ the catalogue itself */

    /// @notice The native sentinel must NOT be in the registration set. `registerFeed` reverts on it —
    ///         a sentinel has no `decimals()` and the contract will not invent one — so including it would
    ///         abort the deploy after the book was already on chain, at the second broadcast transaction.
    function test_feedCatalogue_registersOnlyWrappedTokensAndPinsTheirWidths() public view {
        DeployMoleOrders.FeedSpec[] memory feeds = script.exposedFeedsToRegister();
        assertEq(feeds.length, 2, "WETH and USDG, and nothing else");

        assertEq(feeds[0].token, WETH);
        assertEq(feeds[0].tokenDecimals, 18, "WETH is eighteen decimals");
        assertEq(feeds[0].aggregator, FEED_ETH_USD);

        assertEq(feeds[1].token, USDG);
        assertEq(feeds[1].tokenDecimals, 6, "USDG is SIX decimals on this chain");
        assertEq(feeds[1].aggregator, FEED_USDG_USD);

        for (uint256 i = 0; i < feeds.length; i++) {
            assertTrue(feeds[i].token != 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, "no native sentinel");
        }
    }

    /// @notice The measured bounds, pinned so an unmeasured "round number" edit fails here. ETH/USD showed
    ///         a real 3,168 s gap, so 3,600 s is not safe; USDG/USD is a hard 24 h heartbeat, so nothing
    ///         under ~25 h can be configured without bricking every USDG order.
    function test_feedCatalogue_defaultBoundsClearTheMeasuredHeartbeats() public view {
        DeployMoleOrders.FeedSpec[] memory feeds = script.exposedFeedsToRegister();
        assertGe(feeds[0].maxAge, 3168 * 2, "ETH/USD bound must clear its largest observed gap with room");
        assertGe(feeds[1].maxAge, 86_487 + 3600, "USDG/USD bound must clear a full 24h heartbeat with room");
        assertLe(feeds[1].maxAge, 2 days, "and still fit under MoleOrders.MAX_FEED_MAX_AGE");
    }
}

/* ═════════════════════════════════════════════════════════════════════════════════════════ harness */

/// @dev Exposes the script's internal guards. The script keeps them internal because nothing outside it
///      should call them; the test needs to fire them one at a time.
contract DeployHarness is DeployMoleOrders {
    function exposedRequireChain() external view {
        _requireChain();
    }

    function exposedFeedsToRegister() external view returns (FeedSpec[] memory) {
        return _feedsToRegister();
    }
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════ mocks */

/// @dev `MockAggregator` plus the one selector the deploy script reads and the contract does not:
///      `description()`, which is the only thing on chain that tells ETH/USD from WBTC/USD.
contract DescribedAggregator is MockAggregator {
    string public description;
    uint256 public constant version = 6;

    constructor(uint8 _decimals, int256 _answer, string memory _description) MockAggregator(_decimals, _answer) {
        description = _description;
    }
}

contract MockToken {
    uint8 public immutable decimals;

    constructor(uint8 d) {
        decimals = d;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }
}

/* --- storage-free stubs, so `vm.etch` can put them at the script's pinned addresses --- */

contract EthUsdStub {
    string public constant description = "ETH / USD";
    uint8 public constant decimals = 8;
    uint256 public constant version = 6;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 251_664_000_000, block.timestamp, block.timestamp, 1);
    }
}

/// @dev Live, 8 decimals, fresh, positive, complete — and the wrong asset entirely.
contract WbtcUsdStub {
    string public constant description = "WBTC / USD";
    uint8 public constant decimals = 8;
    uint256 public constant version = 6;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 7_954_631_951_015, block.timestamp, block.timestamp, 1);
    }
}

contract UsdgUsdStub {
    string public constant description = "USDG / USD";
    uint8 public constant decimals = 8;
    uint256 public constant version = 6;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 99_986_755, block.timestamp, block.timestamp, 1);
    }
}

/// @dev A stand-in for the DEPLOYED order books, in their frozen ABI. Ids are 1-based like the real ones,
///      and `populateSlotZero` exists so the 1-based assumption can be violated on purpose.
contract MockLegacyBook {
    struct O {
        address owner;
        uint256 totalBudget;
        uint256 spent;
        bool active;
    }

    uint256 public orderCount;
    mapping(uint256 => O) internal _o;

    address public admin = address(0xAAAA);
    address public keeper = address(0);
    address public router = address(0xEE);

    function push(address owner, uint256 totalBudget, uint256 spent, bool active) external {
        _o[++orderCount] = O(owner, totalBudget, spent, active);
    }

    function populateSlotZero(address owner, uint256 totalBudget, uint256 spent, bool active) external {
        _o[0] = O(owner, totalBudget, spent, active);
    }

    function orders(uint256 id)
        external
        view
        returns (address, address, address, uint256, uint256, uint256, uint256, uint64, uint64, bool)
    {
        O memory o = _o[id];
        return (o.owner, address(0), address(0), 0, o.totalBudget, o.spent, 0, 0, 0, o.active);
    }
}
