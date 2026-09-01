// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MoleOrders} from "../src/MoleOrders.sol";
import {MoleRouter} from "../src/MoleRouter.sol";

/* ─────────────────────────────────────────────────────────────────────────────────────────────────────
   Minimal external ABIs, declared locally and deliberately.

   `ILegacyBook` is the ABI of the ALREADY-DEPLOYED order books. It is frozen history and must NOT be
   expressed as `MoleOrders`: the new contract's `createOrder` and `OrderBound` already differ from the
   deployed ones, and decoding a legacy book through the new type is how a migration audit ends up
   misreading `active`. A local interface pinned to the deployed 10-tuple is the only shape that stays
   correct across a redeploy.
   ───────────────────────────────────────────────────────────────────────────────────────────────────── */

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ILegacyBook {
    function orderCount() external view returns (uint256);
    function orders(uint256)
        external
        view
        returns (
            address owner,
            address tokenIn,
            address tokenOut,
            uint256 amountPerLeg,
            uint256 totalBudget,
            uint256 spent,
            uint256 minOutPerLeg,
            uint64 interval,
            uint64 lastFill,
            bool active
        );
    function admin() external view returns (address);
    function keeper() external view returns (address);
    function router() external view returns (address);
}

interface IERC20Metadata {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title DeployMoleOrders
///
/// @notice Deploys the Chainlink-anchored MoleOrders to Robinhood Chain (4663), registers the price
///         feeds, reads every one of them back OFF CHAIN STATE, and audits the predecessor books for
///         value that must not be dropped. The keeper starts at address(0) on purpose.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// WHY THIS IS A REDEPLOY AND NOT AN UPGRADE
///
/// MoleOrders is not a proxy and never was: an upgradeable contract holding standing ERC-20 approvals can
/// be turned into a thief by whoever holds the upgrade key, so the book was deliberately shipped as
/// immutable bytecode. The bill for that decision falls due exactly here — changing the price anchor
/// means new bytecode at a new address, and every approval, order and integration is re-pointed by hand.
///
/// It is worth paying because the alternative was measured, not argued. The live book priced its fills
/// against the reference pool's OWN TWAP. On 2026-08-24 that anchor read tick -200461 = 1 WETH = 1,970.27
/// USDG while Chainlink ETH/USD ON THIS SAME CHAIN read $2,503.51 against USDG at $0.9999 — 21.3%
/// divergence, on a pool that had not traded for 4.66 days. A fill against that anchor lost a fifth of
/// the order before anybody manipulated anything, and three consecutive rounds of guards over `consult()`
/// were each defeated at unchanged cost, because a pool cannot be the evidence for its own honesty.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// WHAT THIS SCRIPT CHECKS THAT THE CONTRACT CANNOT
///
/// `MoleOrders.registerFeed` is already strict — it refuses a codeless aggregator, an out-of-range age
/// bound, a non-positive or absurd answer, a future-dated or incomplete round, and a feed already past
/// its own bound. Repeating those here is worth one thing only: they fail BEFORE anything is broadcast,
/// and they fail inside `audit()` where nothing is deployed at all.
///
/// TWO CHECKS HERE ARE NOT REDUNDANT, and they are the reason this file exists rather than a one-liner:
///
///   1. THE FEED'S IDENTITY. ETH/USD and WBTC/USD are both live on this chain, both 8 decimals, both
///      answering, both perfectly valid to `registerFeed`. NOTHING in the contract can tell them apart.
///      Only `description()` can, and pasting the wrong one prices ether at the price of bitcoin — a
///      fund-loss typo that every other check waves through.
///   2. THE TOKEN'S DECIMALS. The contract reads `decimals()` off the token, which is right, but it has
///      no opinion about what the answer SHOULD be. On this chain USDG is SIX decimals and WETH is
///      eighteen, there is no canonical USDC, and both explorer entries named "USD Coin" are 18-decimal
///      impostors. Pinning the expected width here is what makes a 6-vs-18 mix-up a failed script rather
///      than a 1e12 mispricing.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// THE AGE BOUNDS ARE MEASURED, NOT COPIED FROM A DOC
///
/// Every default below comes from reading the last several rounds of each aggregator on chain on
/// 2026-08-24 and taking the LARGEST OBSERVED GAP, not the advertised heartbeat:
///
///   ETH / USD   0x78F3556b…   gaps 390s … 3,168s across the last 13 rounds   → 7,200s (2h) bound
///   USDG / USD  0x61B7e565…   gaps 86,400s … 86,487s, a hard 24h heartbeat   → 93,600s (26h) bound
///
/// Three consequences the operator has to know rather than discover:
///   - A 3,600s BOUND ON ETH/USD WOULD ALREADY HAVE FAILED. A real 3,168s gap occurred within the four
///     hours before this was written. One hour is not a safe bound on this chain.
///   - USDG/USD UPDATES ONCE A DAY. Any USDG leg is priced by a number that may be almost 24 hours old,
///     and no bound below ~25h can be configured without making every USDG order permanently unfillable.
///     Acceptable for this asset and only this asset — USDG moved between $0.99984 and $1.00019 across
///     the eight days sampled, a 3.5 bps range — but it is a real property of the deployment.
///   - THE HEADROOM IS ONE HEARTBEAT. `MoleOrders.MAX_FEED_MAX_AGE` is 2 days, so a 24h-heartbeat feed
///     admits bounds only in roughly [86.5ks, 172.8ks]. There is no configuration in which a dead USDG
///     feed is noticed in under a day.
///
/// There is NO L2 sequencer uptime feed on Robinhood Chain. Nothing here pretends otherwise, and the per
/// feed age bound is therefore the only liveness evidence available.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// ENTRYPOINTS
///   audit()            read-only. Verifies the chain, proves every feed answers, and reports the
///                      migration position of BOTH predecessor books. Deploys nothing, broadcasts
///                      nothing. Run this first, every time.
///   run()              the deployment: audit, deploy, register feeds, read everything back.
///   seal(address)      the separate, deliberate, IRREVERSIBLE step that gives up feed registration.
///
/// Env (all optional; every default is a measured or pinned live value):
///   MOLE_ORDERS_ROUTER          executor to bind to        (default: the router the frontend uses)
///   MOLE_ORDERS_ROUTER_ACK      allow a router other than that one
///   MOLE_ORDERS_ADMIN           the new book's admin        (default: the broadcaster)
///   MOLE_ORDERS_ETH_MAX_AGE     ETH/USD age bound, seconds  (default 7200)
///   MOLE_ORDERS_USDG_MAX_AGE    USDG/USD age bound, seconds (default 93600)
///   MOLE_ORDERS_ACK_STRANDED    proceed even though a predecessor order still carries budget
contract DeployMoleOrders is Script {
    /* ─────────────────────────────────────────────────────────────────── pinned live addresses */

    uint256 internal constant RH_MAINNET = 4663;

    /// @dev The router the FRONTEND names as its approval and execution target (`CONTRACTS.MOLE_ROUTER`).
    ///      Binding the new book to anything else recreates the split-brain found below.
    address internal constant FRONTEND_ROUTER = 0xBd9B841d690E31B61aa3858EB145EA8BBe71122c;

    /// @dev PREDECESSOR #1 — the book the README and the migration brief name. Its keeper is already
    ///      address(0).
    address internal constant OLD_BOOK_README = 0x3279E08fE241669cD098F30156b9F1B8FCB0c67C;
    /// @dev PREDECESSOR #2 — the book `frontend/lib/mole/orders.ts`, `frontend/app/api/keeper/fill-plan`
    ///      and `services/keeper` ACTUALLY point at, redeployed 2026-08-15 for the fee-on-input router. It
    ///      is a DIFFERENT contract with different runtime bytecode and a DIFFERENT router, and its keeper
    ///      was never zeroed. Auditing only the first book would have declared the product frozen while
    ///      the live client still pointed somewhere else entirely.
    address internal constant OLD_BOOK_FRONTEND = 0x3bA3Ca1e5D411Dcd686E198C852e0d331384aE77;

    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    address internal constant FEED_ETH_USD = 0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9;
    address internal constant FEED_USDG_USD = 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2;
    /// @dev Answering on this chain, verified, and bound to NOTHING: there is no USDC token and no WBTC
    ///      token on Robinhood Chain to price. `audit()` probes them so the address book stays honest;
    ///      `run()` deliberately does not register a price for an asset that does not exist here.
    address internal constant FEED_USDC_USD = 0x9e6f4605992a899eE2999999F3Ec80C41F452546;
    address internal constant FEED_WBTC_USD = 0x62107b0d3adA75fc1697fD342d99eed947a3aA5E;

    /// @dev Every Chainlink USD feed on this chain reports 8 decimals. One that does not is not the feed
    ///      the caller thinks it is.
    uint8 internal constant FEED_DECIMALS = 8;

    /// @dev Mirrors of `MoleOrders.MIN_FEED_MAX_AGE` / `MAX_FEED_MAX_AGE`, so the pre-broadcast checks can
    ///      run before any book exists. `_requireConstantsAgree` asserts the mirrors still match the
    ///      deployed contract, so they cannot drift into a script that passes and a deploy that reverts.
    uint32 internal constant MIN_FEED_MAX_AGE = 60;
    uint32 internal constant MAX_FEED_MAX_AGE = 2 days;

    struct FeedSpec {
        address token; // the token this feed prices; address(0) for a probe-only feed
        uint8 tokenDecimals; // what the token's decimals() MUST report
        address aggregator;
        string description; // MUST match the aggregator's own description() exactly
        uint32 maxAge;
    }

    struct BookAudit {
        address book;
        uint256 orderCount;
        uint256 activeCount;
        uint256 activeWithBudget; // active AND still holding unspent budget — the only thing that strands
        address admin;
        address keeper;
        address router;
        uint256 wethBalance;
        uint256 usdgBalance;
        uint256 nativeBalance;
    }

    /* ═══════════════════════════════════════════════════════════════════ read-only entrypoint */

    /// @notice Pre-flight. Proves the chain, proves every feed, reports the migration position of both
    ///         predecessor books. Broadcasts nothing and deploys nothing.
    function audit() external view {
        _requireChain();

        console2.log("================================================================");
        console2.log(" MoleOrders redeploy - PRE-FLIGHT AUDIT (read only)");
        console2.log("================================================================");
        console2.log("chain id            :", block.chainid);
        console2.log("block.timestamp     :", block.timestamp);
        console2.log("");

        console2.log("---------------- chainlink feeds, read from chain ---------------");
        FeedSpec[] memory all = _allKnownFeeds();
        for (uint256 i = 0; i < all.length; i++) {
            _reportFeed(all[i]);
        }

        console2.log("--------------------- migration position -----------------------");
        BookAudit memory a = auditBook(OLD_BOOK_README);
        _reportBook("PREDECESSOR #1 (README / brief)", a);
        BookAudit memory b = auditBook(OLD_BOOK_FRONTEND);
        _reportBook("PREDECESSOR #2 (frontend + keeper service)", b);

        _reportMigrationVerdict(a, b);
    }

    /* ═════════════════════════════════════════════════════════════════════════════ deployment */

    function run() external {
        _requireChain();

        address routerAddr = vm.envOr("MOLE_ORDERS_ROUTER", FRONTEND_ROUTER);
        address newAdmin = vm.envOr("MOLE_ORDERS_ADMIN", msg.sender);
        bool routerAck = vm.envOr("MOLE_ORDERS_ROUTER_ACK", false);
        bool ackStranded = vm.envOr("MOLE_ORDERS_ACK_STRANDED", false);

        requireRouterSane(routerAddr, routerAck);
        requireAdminSane(newAdmin);

        // ── 1. Nothing is deployed until the predecessors are proven empty. ──────────────────────────
        BookAudit memory a = auditBook(OLD_BOOK_README);
        BookAudit memory b = auditBook(OLD_BOOK_FRONTEND);
        _reportBook("PREDECESSOR #1 (README / brief)", a);
        _reportBook("PREDECESSOR #2 (frontend + keeper service)", b);
        _reportMigrationVerdict(a, b);
        requireNothingStranded(a, ackStranded);
        requireNothingStranded(b, ackStranded);

        // ── 2. Every feed is proven BEFORE a byte of bytecode goes on chain. A book wired to a dead or
        //       misidentified feed is discovered here, where it costs a re-run, rather than after the
        //       deploy, where it costs the whole deploy. ─────────────────────────────────────────────
        FeedSpec[] memory feeds = _feedsToRegister();
        for (uint256 i = 0; i < feeds.length; i++) {
            checkFeed(feeds[i]);
        }

        // ── 3. Deploy. THE KEEPER IS address(0), DELIBERATELY. ──────────────────────────────────────
        //       A book born with a live keeper is fillable the instant its first order exists, which is
        //       before any human has read the readback below. Fills are switched on by a separate,
        //       deliberate transaction, after that readback has been checked.
        vm.startBroadcast();
        MoleOrders book = new MoleOrders(MoleRouter(payable(routerAddr)), newAdmin, address(0));
        for (uint256 i = 0; i < feeds.length; i++) {
            book.registerFeed(feeds[i].token, feeds[i].aggregator, feeds[i].maxAge);
        }
        vm.stopBroadcast();

        // ── 4. Read back EVERYTHING from chain state. A deployment that cannot prove what it deployed is
        //       not a deployment. ───────────────────────────────────────────────────────────────────
        verifyDeployment(book, routerAddr, newAdmin, feeds);

        _reportNextSteps(address(book), a, b);
    }

    /// @notice Re-runnable proof that a deployed book is wired the way this script intended. Called at the
    ///         end of `run()` and available on its own as `verify(address)`.
    ///
    /// @dev A SEPARATE, PUBLIC FUNCTION ON PURPOSE, for two reasons. The runbook has a step that says
    ///      "read the deployment back and check it before enabling fills", and that step needs to be
    ///      runnable minutes or days after the deploy, from a different machine, by someone who did not
    ///      run the deploy. And a readback buried inline inside `run()` can only be exercised by
    ///      performing a deployment, which means in practice it is never tested and its guards are
    ///      whatever they happened to be on the day.
    ///
    ///      Everything here compares CHAIN STATE to a PINNED EXPECTATION. Nothing compares a value to the
    ///      variable it was written from, which would prove only that assignment works.
    function verifyDeployment(MoleOrders book, address routerAddr, address expectedAdmin, FeedSpec[] memory feeds)
        public
        view
    {
        _requireConstantsAgree(book);
        require(address(book.router()) == routerAddr, "DeployMoleOrders: router readback mismatch");
        require(book.admin() == expectedAdmin, "DeployMoleOrders: admin readback mismatch");
        // G16. THE ONE THAT KEEPS FILLS OFF. A book that came back from the chain with a keeper already
        //      set is fillable now, and the operator would find out by reading a log line rather than by
        //      the script stopping.
        require(book.keeper() == address(0), "DeployMoleOrders: keeper did NOT start at address(0)");
        // G17. Sealed at this point means feed registration is already dead and whatever is registered is
        //      final — including a mistake. It must not be reported as a fresh, still-correctable deploy.
        require(!book.feedsSealed(), "DeployMoleOrders: feeds are already sealed");

        console2.log("================================================================");
        console2.log(" DEPLOYED");
        console2.log("================================================================");
        console2.log("MoleOrders (new)    :", address(book));
        console2.log("  router            :", address(book.router()));
        console2.log("  admin             :", book.admin());
        console2.log("  keeper            :", book.keeper());
        console2.log("    ^ address(0) ON PURPOSE - no fill can occur until setKeeper is called");
        console2.log("  feedsSealed       :", book.feedsSealed());
        console2.log("  MIN_FEED_MAX_AGE  :", book.MIN_FEED_MAX_AGE());
        console2.log("  MAX_FEED_MAX_AGE  :", book.MAX_FEED_MAX_AGE());
        console2.log("  MAX_SLIPPAGE_BPS  :", book.MAX_SLIPPAGE_BPS());
        console2.log("");
        console2.log("------------- feed registrations, read back from chain ----------");

        verifyFeeds(book, feeds);
    }

    /// @notice The feed half of the readback, on its own so `seal()` can re-prove the pair without also
    ///         demanding a keeper of address(0) — by the time anyone seals, fills are deliberately on.
    function verifyFeeds(MoleOrders book, FeedSpec[] memory feeds) public view {
        for (uint256 i = 0; i < feeds.length; i++) {
            _readBackFeed(book, feeds[i]);
        }
    }

    /// @notice Runbook step: prove an already-deployed book, without deploying anything.
    ///
    /// @dev The expected router and admin come from the SAME env defaults `run()` used — deliberately not
    ///      from the book itself. Reading the expectation out of the thing being tested would turn both
    ///      checks into `x == x` and produce a green readback for any book at any address.
    function verify(address bookAddr) external view {
        _requireChain();
        address routerAddr = vm.envOr("MOLE_ORDERS_ROUTER", FRONTEND_ROUTER);
        address expectedAdmin = vm.envAddress("MOLE_ORDERS_ADMIN");
        verifyDeployment(MoleOrders(payable(bookAddr)), routerAddr, expectedAdmin, _feedsToRegister());
    }

    /// @notice The IRREVERSIBLE step, kept out of `run()` on purpose. After this nobody — including the
    ///         admin — can change what any future order prices against. Run it only once the readback from
    ///         `run()` has been checked by a human and the pair is confirmed correct.
    function seal(address bookAddr) external {
        _requireChain();
        MoleOrders book = MoleOrders(payable(bookAddr));

        // Sealing a book whose feeds are wrong freezes the mistake permanently, so the pair is re-proved
        // here rather than assumed from a deploy that may have been days ago.
        FeedSpec[] memory feeds = _feedsToRegister();
        for (uint256 i = 0; i < feeds.length; i++) {
            checkFeed(feeds[i]);
        }
        verifyFeeds(book, feeds);
        // Re-sealing an already sealed book succeeds silently and would print a line claiming this run did
        // something it did not.
        require(!book.feedsSealed(), "DeployMoleOrders: seal target is already sealed");

        vm.startBroadcast();
        book.sealFeeds();
        vm.stopBroadcast();

        require(book.feedsSealed(), "DeployMoleOrders: sealFeeds did not take");
        console2.log("feeds SEALED FOREVER on", bookAddr);
    }

    /* ══════════════════════════════════════════════════════════════════════════════════ guards */

    /// @dev G1. Every constant in this file is a Robinhood Chain mainnet address. Elsewhere they are
    ///      different contracts or nothing at all — and 46630, the TESTNET, differs by one digit.
    function _requireChain() internal view {
        require(block.chainid == RH_MAINNET, "DeployMoleOrders: not Robinhood Chain mainnet (4663)");
    }

    /// @dev G2/G3. The executor must exist and must be the one the client actually approves. The live
    ///      deployment already contains exactly this mistake: predecessor #1 is bound to router
    ///      0x7D74a095 while the frontend approves 0xBd9B841d, so book and client disagreed about what a
    ///      fill even routes through.
    function requireRouterSane(address routerAddr, bool ack) public view {
        require(routerAddr.code.length > 0, "DeployMoleOrders: router has no code");
        require(routerAddr == FRONTEND_ROUTER || ack, "DeployMoleOrders: router is not the one the frontend uses");
    }

    /// @dev G18. An admin of address(0) is a book nobody can ever register a feed on or rotate a keeper on.
    ///      `MoleOrders`' constructor also refuses it, with `BadOrder`; saying so here means the failure
    ///      names the env var that caused it rather than a four-letter error from a constructor.
    function requireAdminSane(address newAdmin) public pure {
        require(newAdmin != address(0), "DeployMoleOrders: admin is address(0)");
    }

    /// @dev G4-G12. Everything that must hold of a feed before it may price a user's order. Each check is
    ///      separate so a failure names the actual defect rather than "bad feed".
    function checkFeed(FeedSpec memory s) public view returns (uint256 age, int256 answer) {
        // G4. A codeless "aggregator" answers every staticcall with empty returndata, which decodes to
        //     zero. Checking it first is what stops a typo'd address becoming a zero price.
        require(s.aggregator.code.length > 0, "DeployMoleOrders: aggregator has no code");

        // G5/G6. Outside this band `registerFeed` reverts. Failing here costs a re-run; failing there
        //        costs the deploy.
        require(s.maxAge >= MIN_FEED_MAX_AGE, "DeployMoleOrders: maxAge below MIN_FEED_MAX_AGE");
        require(s.maxAge <= MAX_FEED_MAX_AGE, "DeployMoleOrders: maxAge above MAX_FEED_MAX_AGE");

        // G7. THE TOKEN'S WIDTH. USDG is six decimals and WETH is eighteen; the contract reads the token's
        //     own answer but has no opinion about what it should be. This is where a 6-vs-18 transcription
        //     error stops being a 1e12 mispricing.
        require(s.token.code.length > 0, "DeployMoleOrders: token has no code");
        require(
            IERC20Metadata(s.token).decimals() == s.tokenDecimals, "DeployMoleOrders: token decimals is not as pinned"
        );

        IAggregatorV3 f = IAggregatorV3(s.aggregator);

        // G8. Eight decimals is the shape every USD feed on this chain reports.
        require(f.decimals() == FEED_DECIMALS, "DeployMoleOrders: feed decimals is not 8");

        // G9. THE IDENTITY CHECK, and the one thing the contract genuinely cannot do. ETH/USD and
        //     WBTC/USD are both live, both 8 decimals, both answering, both valid to `registerFeed`. Only
        //     the description separates them, and confusing them prices ether at the price of bitcoin.
        require(
            keccak256(bytes(f.description())) == keccak256(bytes(s.description)),
            "DeployMoleOrders: feed description does not match the expected pair"
        );

        uint80 roundId;
        uint256 updatedAt;
        uint80 answeredInRound;
        (roundId, answer,, updatedAt, answeredInRound) = f.latestRoundData();

        // G10. A non-positive price is not a price. The signed return is a real Chainlink shape.
        require(answer > 0, "DeployMoleOrders: feed answer is not positive");
        // G11. updatedAt == 0 is Chainlink's own "no data"; a future timestamp is a broken feed and would
        //      also underflow the age arithmetic below.
        require(updatedAt > 0, "DeployMoleOrders: feed has never been updated");
        require(updatedAt <= block.timestamp, "DeployMoleOrders: feed updatedAt is in the future");
        require(answeredInRound >= roundId, "DeployMoleOrders: feed round is incomplete");

        age = block.timestamp - updatedAt;

        // G12. A feed ALREADY staler than the bound it is being given is a registration that cannot fill on
        //      day one. Refuse here rather than ship a book whose orders all revert and call it a keeper
        //      bug next week.
        require(age <= s.maxAge, "DeployMoleOrders: feed is already staler than its configured maxAge");
    }

    /// @dev G13. THE MIGRATION GUARD. `activeWithBudget` counts orders still fillable AND still holding
    ///      unspent budget — the only orders that can actually strand a user. Deploying past one of these
    ///      without saying so is how a migration silently drops somebody's standing order. There is no
    ///      "move it for them" branch, because there cannot be one: `cancelOrder` is owner-only and this
    ///      script has no authority over another owner's order.
    function requireNothingStranded(BookAudit memory a, bool ack) public pure {
        require(a.activeWithBudget == 0 || ack, "DeployMoleOrders: predecessor holds an active order with budget");
    }

    /// @dev G14. The mirrors above are only safe while they are mirrors. If lane 1 retunes either bound,
    ///      this fails loudly instead of leaving a pre-check that passes in front of a deploy that reverts.
    function _requireConstantsAgree(MoleOrders book) internal view {
        require(book.MIN_FEED_MAX_AGE() == MIN_FEED_MAX_AGE, "DeployMoleOrders: MIN_FEED_MAX_AGE mirror drifted");
        require(book.MAX_FEED_MAX_AGE() == MAX_FEED_MAX_AGE, "DeployMoleOrders: MAX_FEED_MAX_AGE mirror drifted");
    }

    /* ═══════════════════════════════════════════════════════════════════════════ migration audit */

    /// @notice Read a predecessor book completely: every order, its owner, its active flag, its remaining
    ///         budget, plus the escrow the contract holds.
    ///
    /// @dev ORDER IDS ARE 1..orderCount, NOT 0..orderCount-1. The book allocates with `id = ++orderCount`,
    ///      so slot 0 is permanently empty — a loop from 0 reads a zeroed struct, and a loop ending at
    ///      orderCount-1 MISSES THE NEWEST ORDER, which is the one most likely to still carry budget.
    ///      Slot 0 is asserted empty below so the indexing base is proven rather than believed.
    function auditBook(address bookAddr) public view returns (BookAudit memory a) {
        a.book = bookAddr;
        if (bookAddr.code.length == 0) return a;

        ILegacyBook book = ILegacyBook(bookAddr);
        a.orderCount = book.orderCount();
        a.admin = book.admin();
        a.keeper = book.keeper();
        a.router = book.router();
        a.wethBalance = IERC20Metadata(WETH).balanceOf(bookAddr);
        a.usdgBalance = IERC20Metadata(USDG).balanceOf(bookAddr);
        a.nativeBalance = bookAddr.balance;

        // G15. The indexing base, proven.
        (address zeroOwner,,,,,,,,, bool zeroActive) = book.orders(0);
        require(
            zeroOwner == address(0) && !zeroActive, "DeployMoleOrders: order id 0 is populated - ids are not 1-based"
        );

        for (uint256 id = 1; id <= a.orderCount; id++) {
            (,,,, uint256 totalBudget, uint256 spent,,,, bool active) = book.orders(id);
            if (active) {
                a.activeCount++;
                if (totalBudget > spent) a.activeWithBudget++;
            }
        }
    }

    /* ═════════════════════════════════════════════════════════════════════════════ feed catalogue */

    function _feedsToRegister() internal view returns (FeedSpec[] memory out) {
        uint32 ethAge = uint32(vm.envOr("MOLE_ORDERS_ETH_MAX_AGE", uint256(7200)));
        uint32 usdgAge = uint32(vm.envOr("MOLE_ORDERS_USDG_MAX_AGE", uint256(93600)));

        // WETH and USDG, and nothing else. THE NATIVE SENTINEL IS NOT REGISTERED AND CANNOT BE:
        // `registerFeed` reverts on `token == NATIVE`, because a sentinel has no `decimals()` to read and
        // the contract will not invent one. The consequence is worth stating rather than discovering —
        // an order naming native ETH is not creatable on this book at all. Wrapped legs only.
        out = new FeedSpec[](2);
        out[0] = FeedSpec(WETH, 18, FEED_ETH_USD, "ETH / USD", ethAge);
        out[1] = FeedSpec(USDG, 6, FEED_USDG_USD, "USDG / USD", usdgAge);
    }

    /// @dev Everything verified on this chain, including the two feeds with no token to bind to. Probing
    ///      them keeps the address book honest without registering a price for an asset that does not
    ///      exist here.
    function _allKnownFeeds() internal pure returns (FeedSpec[] memory out) {
        out = new FeedSpec[](4);
        out[0] = FeedSpec(WETH, 18, FEED_ETH_USD, "ETH / USD", 7200);
        out[1] = FeedSpec(USDG, 6, FEED_USDG_USD, "USDG / USD", 93600);
        out[2] = FeedSpec(address(0), 0, FEED_USDC_USD, "USDC / USD", 93600);
        out[3] = FeedSpec(address(0), 0, FEED_WBTC_USD, "WBTC / USD", 10800);
    }

    /* ═══════════════════════════════════════════════════════════════════════════════════ readback */

    /// @dev Reads the registration back out of the BOOK'S OWN STORAGE, then reads the identity back out of
    ///      the AGGREGATOR ITSELF — not out of the spec that was just written. Comparing a value to the
    ///      variable it came from proves nothing; this compares chain state to a pinned expectation.
    function _readBackFeed(MoleOrders book, FeedSpec memory s) internal view {
        (address aggregator, uint32 maxAge, uint8 feedDecimals, uint8 tokenDecimals, bool set) = book.feeds(s.token);

        require(set, "DeployMoleOrders: feed readback says not set");
        require(aggregator == s.aggregator, "DeployMoleOrders: feed aggregator readback mismatch");
        require(maxAge == s.maxAge, "DeployMoleOrders: feed maxAge readback mismatch");
        require(feedDecimals == FEED_DECIMALS, "DeployMoleOrders: feed decimals readback is not 8");
        require(tokenDecimals == s.tokenDecimals, "DeployMoleOrders: token decimals readback mismatch");

        IAggregatorV3 f = IAggregatorV3(aggregator);
        require(
            keccak256(bytes(f.description())) == keccak256(bytes(s.description)),
            "DeployMoleOrders: readback description does not match the expected pair"
        );

        (, int256 answer,, uint256 updatedAt,) = f.latestRoundData();
        console2.log("  token             :", s.token);
        console2.log("    aggregator      :", aggregator);
        console2.log("    description     :", f.description());
        console2.log("    feed decimals   :", feedDecimals);
        console2.log("    token decimals  :", tokenDecimals);
        console2.log("    maxAge (config) :", maxAge);
        console2.log("    set             :", set);
        console2.log("    answer (8dp)    :", answer > 0 ? uint256(answer) : 0);
        console2.log("    age right now   :", updatedAt <= block.timestamp ? block.timestamp - updatedAt : 0);
        console2.log("");
    }

    /* ═════════════════════════════════════════════════════════════════════════════════ reporting */

    function _reportFeed(FeedSpec memory s) internal view {
        console2.log("feed                :", s.aggregator);
        if (s.aggregator.code.length == 0) {
            console2.log("  !! NO CODE AT THIS ADDRESS");
            console2.log("");
            return;
        }
        IAggregatorV3 f = IAggregatorV3(s.aggregator);
        console2.log("  description       :", f.description());
        console2.log("  decimals          :", f.decimals());
        console2.log("  version           :", f.version());
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = f.latestRoundData();
        console2.log("  roundId           :", uint256(roundId));
        console2.log("  answeredInRound   :", uint256(answeredInRound));
        console2.log("  answer (8dp)      :", answer > 0 ? uint256(answer) : 0);
        console2.log("  updatedAt         :", updatedAt);
        console2.log("  age (seconds)     :", updatedAt <= block.timestamp ? block.timestamp - updatedAt : 0);
        console2.log("  proposed maxAge   :", s.maxAge);
        if (s.token == address(0)) {
            console2.log("  binds to          : NOTHING - no such token on Robinhood Chain");
            console2.log("                      probed for honesty, NOT registered");
        } else {
            console2.log("  binds to          :", s.token);
            console2.log("  token decimals    :", IERC20Metadata(s.token).decimals());
        }
        console2.log("");
    }

    function _reportBook(string memory label, BookAudit memory a) internal view {
        console2.log(label);
        console2.log("  address           :", a.book);
        if (a.book.code.length == 0) {
            console2.log("  !! NO CODE AT THIS ADDRESS");
            console2.log("");
            return;
        }
        console2.log("  orderCount        :", a.orderCount);
        console2.log("  active orders     :", a.activeCount);
        console2.log("  active WITH budget:", a.activeWithBudget);
        console2.log("  admin             :", a.admin);
        console2.log("  keeper            :", a.keeper);
        if (a.keeper == address(0)) {
            console2.log("    keeper is address(0) - no fill can occur on this book");
        } else {
            console2.log("    !! KEEPER IS LIVE - this book fills the moment an order exists on it");
        }
        console2.log("  router            :", a.router);
        console2.log("  WETH escrow       :", a.wethBalance);
        console2.log("  USDG escrow       :", a.usdgBalance);
        console2.log("  native escrow     :", a.nativeBalance);

        // Per-order detail. The point of an audit is naming what is there, not counting it.
        ILegacyBook book = ILegacyBook(a.book);
        for (uint256 id = 1; id <= a.orderCount; id++) {
            (address owner,,,, uint256 totalBudget, uint256 spent,,,, bool active) = book.orders(id);
            console2.log("    order             :", id);
            console2.log("      owner           :", owner);
            console2.log("      active          :", active);
            console2.log("      budget          :", totalBudget);
            console2.log("      spent           :", spent);
            console2.log("      remaining       :", totalBudget > spent ? totalBudget - spent : 0);
            console2.log("      CARRIES VALUE   :", active && totalBudget > spent);
        }
        console2.log("");
    }

    function _reportMigrationVerdict(BookAudit memory a, BookAudit memory b) internal pure {
        uint256 stranded = a.activeWithBudget + b.activeWithBudget;
        uint256 escrow =
            a.wethBalance + a.usdgBalance + a.nativeBalance + b.wethBalance + b.usdgBalance + b.nativeBalance;

        console2.log("--------------------- migration verdict ------------------------");
        console2.log("orders carrying value, both books :", stranded);
        console2.log("total escrow, both books          :", escrow);
        if (stranded == 0 && escrow == 0) {
            console2.log("VERDICT: NOTHING TO MOVE. No order is active with unspent budget and neither");
            console2.log("         book holds a token balance. The migration is a re-point, not a");
            console2.log("         transfer. There is no state to carry across.");
        } else {
            console2.log("VERDICT: VALUE IS PRESENT - DO NOT CUT OVER. Every order marked");
            console2.log("         'CARRIES VALUE: true' above must be cancelled BY ITS OWNER first.");
            console2.log("         cancelOrder is owner-only; this script cannot do it for them, and");
            console2.log("         re-creating the order on the new book would need their approval.");
        }
        console2.log("");
    }

    function _reportNextSteps(address book, BookAudit memory a, BookAudit memory b) internal pure {
        console2.log("");
        console2.log("======================== NEXT STEPS ============================");
        console2.log("1. VERIFY THE READBACK ABOVE BY EYE. Every description is the pair you meant,");
        console2.log("   every feed decimals is 8, WETH is 18 and USDG is 6, every age is under");
        console2.log("   its bound. Nothing downstream re-checks the identity of a feed.");
        console2.log("2. FREEZE THE PREDECESSORS before re-pointing anything:");
        if (a.keeper != address(0)) {
            console2.log("   - setKeeper(address(0)) on", a.book);
        }
        if (b.keeper != address(0)) {
            console2.log("   - setKeeper(address(0)) on", b.book);
            console2.log("     ^ THIS ONE STILL HAS A LIVE KEEPER");
        }
        console2.log("   - revoke any standing ERC-20 approval to either address.");
        console2.log("3. RE-POINT THE CLIENT to:");
        console2.log("  ", book);
        console2.log("   frontend/lib/mole/orders.ts MOLE_ORDERS,");
        console2.log("   frontend/app/api/keeper/fill-plan/route.ts MOLE_ORDERS,");
        console2.log("   services/keeper MOLE_ORDERS env.");
        console2.log("   createOrder's ABI CHANGED - the PoolKey/twapWindow arguments are gone and");
        console2.log("   maxSlippageBps is now the last argument. This is not only an address swap.");
        console2.log("4. ONLY THEN ENABLE FILLS: setKeeper(<keeper>) from the admin, and read");
        console2.log("   keeper() back. This script deliberately left it at address(0).");
        console2.log("5. OPTIONALLY seal: forge script ... --sig 'seal(address)' <book>  - IRREVERSIBLE.");
        console2.log("================================================================");
    }
}
