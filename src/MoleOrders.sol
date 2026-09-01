// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {MoleRouter} from "./MoleRouter.sol";

/// @notice The two calls this book makes on a Chainlink AggregatorV3 proxy. Declared as a minimal
///         interface rather than imported, so the order book carries no dependency on a feed package —
///         and note that nothing here is ever invoked THROUGH this interface. Every read is a raw
///         `staticcall` on these selectors with the returndata length checked and decoded into wide
///         types, because a hostile or broken aggregator must be able to make a fill FAIL and must not
///         be able to make a view REVERT. See `_readFeed`.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title MoleOrders
/// @notice Non-custodial recurring / conditional swaps — DCA and limit orders — executed through
///         MoleRouter by a keeper that can TRIGGER an order but can never steal from it.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// THE TRUST MODEL, and why a keeper touching your funds is safe here.
///
/// You approve THIS contract for your input token and create an order with fixed terms. A keeper watches
/// the clock (DCA) or the price (limit) off-chain and calls `fillLeg`. But `fillLeg` can only:
///   - pull at most `amountPerLeg` of YOUR input token, and never more than `totalBudget` in total,
///   - swap it through MoleRouter with the output delivered DIRECTLY to YOU (the recipient is checked to
///     equal the order owner — the keeper cannot redirect a wei),
///   - and only at a price that clears BOTH of your floors — your own `minOutPerLeg` AND a floor derived
///     from two Chainlink feeds at the moment of the fill, whichever is higher (see THE PRICE BOUND),
///   - no more often than every `interval` seconds (so a DCA cannot be drained in one block).
///
/// The contract holds tokens only transiently inside `fillLeg` (pull → swap → out) and returns anything
/// the route hands back to the ORDER OWNER — never to the keeper, never to the admin, never to itself.
/// It is NOT upgradeable — an upgradeable approval target could be turned malicious, and that is the whole
/// risk we are avoiding.
///
/// A DCA order is `interval > 0` with a slippage floor; a LIMIT order is `interval == 0` (fills as soon as
/// the price is met) with `minOutPerLeg` set to the limit. Same contract, one code path.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// THE PRICE BOUND, and why a stored constant was never one.
///
/// The first version of this contract had exactly one price check: `plan.minAmountOut >= minOutPerLeg *
/// legIn / amountPerLeg`, an ABSOLUTE token amount frozen at order creation, validated only as non-zero.
/// That is not a price bound, it is a number, and it fails in both directions:
///
///   - A DCA order has no natural limit price, so the shipped client set `minOutPerLeg = 1` — one wei.
///     The keeper (or, since MoleRouter will execute against any caller-named pool, the keeper acting as
///     its own counterparty) could then take the ENTIRE leg and return one wei, and every stored check
///     stayed green. On a chain with one sequencer and no public mempool the same hole is open to any
///     ordering-privileged party sandwiching an HONEST keeper's `minAmountOut = 1` transaction, so no
///     privileged role was needed to exercise it.
///   - A limit order is DESIGNED to sit for months. A limit set when the pair traded at 4,000 is a
///     licence to fill at 4,000 forever — so once the market moves past it the keeper fills AT the stale
///     limit and keeps the difference, which on a 10,000-unit order measured out at roughly 6,370 units.
///
/// So the floor is recomputed PER LEG, at fill time, from a price the keeper does not author. The
/// effective floor is `max(your absolute floor, fair value × (1 − maxSlippageBps))`. Both halves matter:
/// the market half stops the keeper executing far from the market, the absolute half keeps a limit order
/// a limit order when the market is BETTER than your price. `maxSlippageBps` is capped at
/// MAX_SLIPPAGE_BPS: whatever the client asks for, the most a hostile keeper can ever take off the market
/// price is that cap, and `test_theCeilingHolds*` in test/attack/AttackMoleOrdersQuietReference.t.sol is
/// what makes that a checked claim rather than a comment.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// WHERE "FAIR VALUE" COMES FROM, AND WHY IT IS NO LONGER A POOL.
///
/// Three rounds of this contract derived fair value from `IMoleOracle.consult(refPool, twapWindow)` — the
/// arithmetic-mean tick of a REFERENCE POOL the owner named. Three rounds of guards over that read were
/// defeated at essentially unchanged cost, and the reason is structural rather than a missing condition:
///
///   A POOL CANNOT BE THE EVIDENCE FOR ITS OWN HONESTY.
///
/// The measurements, all from this repo's own harness and from the live chain:
///   - `consult` has a quiet-tail path: with no swap inside the window the tick was constant, so the
///     arithmetic mean IS that constant and the hook returns `lastTick` with zero averaging. Walking a
///     silent pool and waiting one window took 6,124 bps from a leg whose contract-guaranteed worst case
///     was 100 bps.
///   - Refusing `quietSpan >= twapWindow` (round three) moved the attacker's wait from `twapWindow` to
///     `twapWindow - 1` seconds and the extraction from 6,124 bps to 6,122 bps. At 50% silence it still
///     paid 3,805 bps. No threshold works, because the guard measures the same pool the attacker is
///     moving. The identical shape defeated MoleQueue's depth guard by parking spot one tick OUTSIDE the
///     band instead of one inside, at the same 13,133-unit cost.
///   - And on the live book's own reference pool (WETH/USDG on Robinhood Chain, silent for 4.66 days when
///     this was written) the anchor was tick -200461 = 1 WETH : 1,970.27 USDG while Chainlink ETH/USD read
///     $2,503.51 (698 seconds old) against USDG/USD $0.9999 — a 21.3% divergence. A fill against that
///     anchor lost 21% of the leg before anybody manipulated anything. The honest case was already the
///     worst case.
///
/// So fair value is now the ratio of two Chainlink USD feeds, one per token:
///
///     fairOut = amountIn × (priceIn / 10^feedDecIn) ÷ (priceOut / 10^feedDecOut)
///                        × 10^tokenDecOut ÷ 10^tokenDecIn
///
/// evaluated in one `FullMath.mulDiv` so it rounds exactly once. THE DECIMALS ARE THE DANGEROUS PART and
/// they are not assumed: the feed's own `decimals()` and the token's own `decimals()` are read at
/// registration, stored, and the feed's is re-checked on EVERY read (a proxy that repoints at an
/// aggregator with different precision silently rescales the whole book by a power of ten). On this pair
/// that is an 8-decimal feed over an 18-decimal token and an 8-decimal feed over a SIX-decimal token, and
/// both directions are priced in the tests — `test_bothDirectionsPriceCorrectly*` — because a decimals
/// error here is a fund-loss bug, not a rounding bug.
///
/// THE POOL TWAP IS GONE ENTIRELY, and this is a deliberate removal rather than an omission. The obvious
/// keep-it-as-a-second-opinion design is "refuse when Chainlink and the pool disagree wildly, which
/// catches a bad feed". It was rejected on evidence:
///   - It is a permissionless denial of service on every order in the book. The pool side of that
///     comparison costs one round trip's fee to move, exactly as measured above. Anyone who can walk the
///     reference pool can therefore force the divergence check to fire and stall every order priced
///     against it, for as long as they care to keep paying. The guard would hand an attacker who cannot
///     move Chainlink a lever over fills he otherwise has none over.
///   - The same is true of the "tighten only" variant. `max(chainlinkFloor, poolFloor)` never loosens the
///     bound, but an attacker walks the pool UP instead of down, the pool floor exceeds anything the
///     market can deliver, and no honest fill clears it. "Only tightens" and "cannot be used to grief" are
///     different properties and only the first one holds.
///   - And on the live pair it would refuse everything today: 21.3% divergence, with the POOL being the
///     wrong one.
/// A second opinion is only worth having if it is not cheaper to forge than the first. This one is, so it
/// is not consulted. What the pool is still used for is what it was always good for: being the venue the
/// route executes against, which MoleRouter checks by delivery, not by quotation.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// READING A FEED HONESTLY: WHAT IS CHECKED, AND WHY THE AGE BOUND IS PER FEED.
///
/// Every read validates, in this order, and the order is part of the contract:
///   - `decimals()` still equals what registration pinned      → FeedDecimalsChanged
///   - `answer > 0`                                            → NonPositiveAnswer   (zero is not a price)
///   - `answeredInRound >= roundId`                            → StaleRound (the feed contradicts itself)
///   - `updatedAt <= block.timestamp`                          → FutureDatedRound
///   - `block.timestamp - updatedAt <= maxAge`                 → StalePrice
///   - `answer <= MAX_FEED_ANSWER`                             → AnswerTooLarge
/// The FUTURE-DATED check is not decoration and it is not subsumed by the age bound: `now <= updatedAt +
/// maxAge` bounds only how OLD a round may be, so a round dated thirty days ahead is permanently "fresh"
/// and the staleness bound defeats itself. That is the same reasoning as
/// rh-lending/glue/src/oracle/ChainlinkFeedAdapter.sol's `FutureDatedRound`, and it is the one guard whose
/// absence is invisible in every test that only ever moves the clock forwards.
///
/// AGE BOUNDS ARE PER FEED because the heartbeats differ by two orders of magnitude. ETH/USD on Robinhood
/// Chain publishes on deviation and was 698 seconds old when measured; USDG/USD and USDC/USD are 24-hour
/// heartbeat feeds and were ~23 hours old at the same moment. A single global bound is either a permanent
/// outage for the stablecoin feeds (anything under 86,400 s) or useless for ETH (anything over it), and
/// there is no value in between that is honest about both. So `maxAge` is set per feed at registration,
/// inside [MIN_FEED_MAX_AGE, MAX_FEED_MAX_AGE] — the floor is there because a bound below a minute cannot
/// be met by any feed and would brick the pair, the ceiling because a bound past two days keeps serving a
/// 24-hour feed's price two whole heartbeats after it died.
///
/// THERE IS NO L2 SEQUENCER UPTIME FEED ON ROBINHOOD CHAIN. The usual Chainlink-on-an-L2 grace-period
/// guard cannot be written here because the input it needs does not exist on this chain, and a guard
/// pointed at a feed that is not deployed is worse than none. What replaces it is the per-feed age bound
/// and nothing else, and that is stated here rather than left to be discovered.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// FAIL CLOSED — AND EXACTLY WHAT THAT IS ALLOWED TO MEAN HERE.
///
/// A leg that cannot be priced is REFUSED: `_legFloor` reverts, so `fillLeg` and `currentLeg` both refuse
/// and the order stalls until the feeds are healthy again. It can never silently degrade to the owner's
/// absolute floor, which is exactly the stale-limit hole the price bound exists to close.
///
/// BUT THE OWNER'S EXIT NEVER TOUCHES A FEED. `cancelOrder` reads the order's owner and its active flag,
/// writes the flag, and returns — no feed, no router, no price, no admin state, no reentrancy lock to
/// contend for. "The oracle broke and now nobody can get their money out" is a worse outcome than any
/// fill, and this contract is not permitted to have it. `test_cancelNeverTouchesAFeed*` drives cancel with
/// every feed reverting, sealed, and dead, and asserts it still succeeds. That property is also why
/// failing closed is affordable at all: this book holds no escrow between calls, so a refused leg strands
/// nothing, costs the owner nothing but the leg's timing, needs no timeout to unwind, and reverses by
/// itself the moment the feeds come back.
///
/// AND THE STALL IS NOT SILENT. `anchorStatus(id)` reports both feeds' condition code, age and bound and
/// CANNOT revert; `fillable(id)` returns false while a feed is unusable instead of promising a fill that
/// reverts. Its one documented gap: a final partial leg so small that its entire fair value rounds to zero
/// output is refused by `LegNotPriceable` while `fillable` still reports true, because computing that
/// answer is the thing that can revert. The exposure is bounded by one raw unit of the output token and
/// the owner's exit is `cancelOrder`, unchanged.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// WHO CAN CHANGE THE ANCHOR, WHICH IS THE ONE POWER THIS REDESIGN ADDS.
///
/// The admin registers feeds. That is new — previously the admin could only rotate the keeper — so it is
/// bounded in three ways rather than asserted to be safe:
///   1. AN ORDER SNAPSHOTS ITS FEEDS AT CREATION. `_bounds[id]` stores the aggregator addresses, their
///      decimals, the token decimals and the age bounds as VALUES. Re-registering a token's feed changes
///      what NEW orders bind to and cannot retarget a single existing order. The admin therefore has no
///      price lever over money already committed, which is the property that matters.
///   2. REGISTRATION IS STRICT. A feed that cannot serve a clean price right now cannot be registered at
///      all: `registerFeed` runs the identical validation `fillLeg` will run, on the same arguments, and
///      refuses on any condition. An adapter over a dead, silent, future-dated or wrong-decimals feed is
///      not deployable, so the failure surfaces at the admin's transaction rather than at every fill.
///   3. IT CAN BE GIVEN UP. `sealFeeds()` is one-way and permanent; after it, `registerFeed` reverts
///      forever and the admin is back to rotating the keeper and nothing else. The intended operational
///      shape is: deploy, register WETH and USDG, verify, seal.
/// What a feed change still cannot do in any configuration: move funds anywhere but to the order owner,
/// raise `maxSlippageBps` past MAX_SLIPPAGE_BPS, lower an order's own `minOutPerLeg`, or stop a cancel.
///
/// WHAT THIS DOES NOT COVER, stated plainly rather than papered over:
///   - CHAINLINK ITSELF IS THE TRUST ANCHOR NOW. A compromised or wrong feed prices every leg on its
///     pair. The bound above it is the owner's own `minOutPerLeg`, which no feed can lower, and the age
///     and sanity checks, which catch a dead feed rather than a lying one.
///   - AN HONEST MARKET IS STILL ONLY BOUNDED BY `maxSlippageBps`. Every leg may execute up to that far
///     below fair value, every time, and nothing here narrows that.
///   - THE TWO FEEDS ARE READ IN THE SAME BLOCK BUT NOT THE SAME ROUND. One may be 10 minutes old and the
///     other 20 hours; the ratio is as fresh as its stalest leg, and `anchorStatus` reports both ages so
///     that is observable rather than hidden.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// SIZING `maxSlippageBps`, because getting it wrong is a liveness bug rather than a safety one. The
/// floor is compared against the output the owner ACTUALLY RECEIVES, which is net of the pool's LP fee
/// and net of the aggregator fee MoleRouter skims from the input. So the tolerance has to cover the
/// round trip — LP fee + aggregator fee + price impact + the gap between the feed price and the venue's
/// price — or an honest fill simply never clears it and the order stalls. At the shipped 30 bps LP fee
/// and 69 bps dial that is ~100 bps of unavoidable cost before any impact at all. Too tight only stops
/// fills; too loose is what the cap above bounds.
contract MoleOrders {
    /// @dev The immutable executor every order routes through. Fixed at deploy; users audit one router.
    MoleRouter public immutable router;

    address public admin;
    address public pendingAdmin;
    /// @dev The only address allowed to call `fillLeg`. Rotatable by the admin; cannot move funds anywhere
    ///      but the order owner, so a rotation (or a compromised keeper) cannot become a theft.
    address public keeper;

    struct Order {
        address owner;
        address tokenIn;
        address tokenOut;
        uint256 amountPerLeg; // max input per fill
        uint256 totalBudget; // max input across all fills
        uint256 spent; // input consumed so far
        uint256 minOutPerLeg; // output floor for a FULL amountPerLeg leg (scaled for a partial final leg)
        uint64 interval; // min seconds between fills; 0 = fill whenever the price clears the floor (limit)
        uint64 lastFill; // timestamp of the last fill
        bool active;
    }

    uint256 public orderCount;
    mapping(uint256 => Order) public orders;
    mapping(address => uint256[]) internal _ownerOrders;

    /// @notice One token's USD price source, as registered. Every field is pinned at registration and the
    ///         mutable ones are re-checked on every read.
    ///
    /// @dev `tokenDecimals` is the TOKEN's own `decimals()`, not the feed's — it is what converts a raw
    ///      balance into the whole units the USD price is quoted in, and getting it from the token rather
    ///      than from an argument is what stops a 6-vs-18 transcription error becoming a 1e12 mispricing.
    struct Feed {
        address aggregator;
        uint32 maxAge;
        uint8 feedDecimals;
        uint8 tokenDecimals;
        bool set;
    }

    /// @notice token => its registered USD feed. Empty (`set == false`) means no order may name that token.
    mapping(address => Feed) public feeds;

    /// @notice Once true, `registerFeed` reverts forever. One-way, by design — see WHO CAN CHANGE THE
    ///         ANCHOR in the header.
    bool public feedsSealed;

    /// @dev The market-referenced half of an order's price floor, SNAPSHOT AT CREATION. A PARALLEL MAPPING
    ///      rather than more fields on `Order`: the shape of `orders`' generated getter is part of the
    ///      client and keeper ABI, and widening the struct would renumber every slot behind it.
    ///
    ///      The feeds are stored BY VALUE, not by token. That is the whole of the admin bound: whatever is
    ///      registered later, this order prices against the aggregator, decimals and age bound that were
    ///      live when its owner signed for it.
    struct PriceBound {
        Feed inFeed;
        Feed outFeed;
        uint16 maxSlippageBps;
    }

    mapping(uint256 => PriceBound) internal _bounds;

    /// @dev The hard ceiling on how far below fair value any single leg may execute. This is the
    ///      contract's own bound on the worst case, independent of what a client asks for: a hostile or
    ///      compromised keeper can extract at most this much of a leg, not the leg.
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    uint256 internal constant BPS_DENOM = 10_000;

    /// @dev A per-feed age bound below this cannot be met by any feed that exists — the fastest cadence
    ///      measured on this chain is a deviation-triggered ETH/USD that was 698 s old — so a value under
    ///      it would brick the pair rather than protect it.
    uint32 public constant MIN_FEED_MAX_AGE = 60;
    /// @dev And above this a 24-hour heartbeat feed keeps being served two whole heartbeats after it died.
    uint32 public constant MAX_FEED_MAX_AGE = 2 days;
    /// @dev Both the feed's precision and the token's are capped here, which is what makes the decimal
    ///      scale factor `10 ** (feedDecimals + tokenDecimals)` provably at most 1e36.
    uint8 public constant MAX_DECIMALS = 18;
    /// @dev With the scale factor bounded by 1e36, an answer at or below this cannot overflow the scaling
    ///      multiplication — so the multiplication needs no separate overflow story and the sanity band
    ///      and the arithmetic bound are the same number.
    uint256 public constant MAX_FEED_ANSWER = type(uint256).max / 1e36;

    /* ------------------------------------------------------------------- feed condition codes (views) */

    /// @dev `anchorStatus` reports these instead of reverting. `_requireFeedPrice` maps the same codes on
    ///      to named errors. ONE implementation of the checks, two ways of reporting the outcome — a guard
    ///      weakened in `_readFeed` is weakened in both places at once, which is what the mutation matrix
    ///      is aimed at.
    uint8 public constant FEED_OK = 0;
    uint8 public constant FEED_UNREADABLE = 1;
    uint8 public constant FEED_DECIMALS_CHANGED = 2;
    uint8 public constant FEED_NON_POSITIVE = 3;
    uint8 public constant FEED_STALE_ROUND = 4;
    uint8 public constant FEED_FUTURE_DATED = 5;
    uint8 public constant FEED_STALE = 6;
    uint8 public constant FEED_ANSWER_TOO_LARGE = 7;
    /// @dev Not an aggregator problem at all: this side of the order has no feed bound to it. Separated
    ///      from FEED_UNREADABLE because they need different people to do different things — one is an
    ///      order that was never priceable, the other is an operational incident on a live pair.
    uint8 public constant FEED_UNSET = 8;

    /// @dev One validated feed read. `code == FEED_OK` is the only state in which `answer` is a price.
    struct Round {
        uint8 code;
        uint256 answer;
        int256 rawAnswer;
        uint256 roundId;
        uint256 answeredInRound;
        uint256 updatedAt;
        uint256 reportedDecimals;
        uint32 age;
    }

    /// @dev MoleRouter's native sentinel. Not a contract and not a token — never balance-checked here.
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // Reentrancy guard (transient, EIP-1153).
    bytes32 private constant _LOCK = keccak256("moleorders.lock");

    event OrderCreated(
        uint256 indexed id,
        address indexed owner,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountPerLeg,
        uint256 totalBudget,
        uint256 minOutPerLeg,
        uint64 interval
    );
    /// @dev Emitted alongside OrderCreated rather than folded into it: the existing event's signature is
    ///      what the indexer and the client decode, and changing it would break every historical decode.
    event OrderBound(uint256 indexed id, address indexed feedIn, address indexed feedOut, uint16 maxSlippageBps);
    event OrderFilled(uint256 indexed id, uint256 legIn, uint256 amountOut, uint256 spent);
    /// @dev The route handed input back (a rounded-down multi-path split, or a short fill). It went to the
    ///      order owner and was NOT charged against the budget.
    event LegRefunded(uint256 indexed id, address indexed token, uint256 amount);
    event OrderClosed(uint256 indexed id, bool completed);
    event KeeperSet(address indexed keeper);
    event AdminTransferStarted(address indexed current, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed current);
    event FeedRegistered(
        address indexed token, address indexed aggregator, uint32 maxAge, uint8 feedDecimals, uint8 tokenDecimals
    );
    event FeedsSealedForever();

    error NotAdmin();
    error NotPendingAdmin();
    error NotKeeper();
    error NotOrderOwner();
    error OrderInactive();
    error BadOrder();
    error BadBound();
    error IntervalNotElapsed();
    error BudgetExhausted();
    error PlanMismatch();
    error RecipientNotOwner();
    error FloorNotMet();
    error TransferFailed();
    error Reentrancy();
    error Residual();

    /// @notice No USD feed has been registered for this token, so no order over it can be priced.
    error FeedNotRegistered(address token);
    /// @notice `registerFeed` was given something it will not pin: a zero address, an age bound outside
    ///         [MIN_FEED_MAX_AGE, MAX_FEED_MAX_AGE], or a feed/token whose `decimals()` is unreadable or
    ///         above MAX_DECIMALS.
    error BadFeedConfig();
    /// @notice `sealFeeds()` has been called. Permanent.
    error FeedsAreSealed();

    /// @notice The aggregator did not answer at all: no code at the address, a reverting call, or
    ///         returndata too short to be a round.
    error FeedUnreadable(address feed);
    /// @notice This side of the order has no feed bound to it — the id was never created, or its bound is
    ///         empty. Distinct from `FeedNotRegistered`, which is what `createOrder` says about a TOKEN.
    error NoFeedBound();
    /// @notice The aggregator's precision is not what registration pinned, so the scale of every answer it
    ///         gives is unknown and nothing can be said about its value.
    error FeedDecimalsChanged(address feed, uint8 expected, uint256 reported);
    /// @notice Zero or negative is not a price.
    error NonPositiveAnswer(address feed, int256 answer);
    /// @notice `answeredInRound < roundId`: the feed contradicts its own bookkeeping.
    error StaleRound(address feed, uint256 roundId, uint256 answeredInRound);
    /// @notice `updatedAt` is in the FUTURE. Not lateness — the feed asserting something about the clock
    ///         that cannot be true, and the one condition that defeats the staleness bound itself.
    error FutureDatedRound(address feed, uint256 updatedAt, uint256 nowTs);
    /// @notice The latest round is older than this feed's own age bound. Transient by nature: the order
    ///         resumes filling when the feed publishes again.
    error StalePrice(address feed, uint32 age, uint32 maxAge);
    /// @notice An answer so large that scaling it by the pair's decimals would overflow. Not a price.
    error AnswerTooLarge(address feed, uint256 answer);
    /// @notice This leg's entire fair value rounds to zero of the output token, so there is no market
    ///         floor to impose and the absolute floor alone would be the stale-limit hole again.
    error LegNotPriceable();

    constructor(MoleRouter _router, address _admin, address _keeper) {
        if (address(_router) == address(0) || _admin == address(0)) revert BadOrder();
        router = _router;
        admin = _admin;
        keeper = _keeper;
        emit AdminTransferred(address(0), _admin);
        emit KeeperSet(_keeper);
    }

    /// @notice Accepts native ETH so that a stray wei arriving mid-swap cannot brick every fill.
    ///
    /// @dev THIS IS A LIVENESS FIX, AND IT COSTS THE ORDER OWNER NOTHING. MoleRouter sweeps the NET
    ///      INCREASE of every currency it touched — native ETH included — back to the PAYER, and on a
    ///      keeper fill the payer is this contract. That sweep forwards with `_sendNative`, which REVERTS
    ///      on a failed send. Without a `receive()` here, any ETH that reached the router during the swap
    ///      reverted the sweep and therefore the whole `fillLeg`. The router's own `receive()` accepts ETH
    ///      from anyone while its lock is held, so any pool, hook or token reachable inside the route
    ///      could push ONE WEI and permanently deny every order that routes that way — a free,
    ///      repeatable, permissionless DoS on the order book. Refusing was fail-closed but it was failing
    ///      closed on the wrong thing.
    ///
    ///      NONE OF IT IS THE OWNER'S MONEY. `fillLeg` is not payable and this contract never attaches
    ///      value, the leg's input is pulled as an ERC-20, and the router delivers the output DIRECTLY to
    ///      the owner — the recipient is checked to be the owner and nothing else. So the only ETH that
    ///      can arrive is what a third party pushed into the router mid-swap, and it is dust by
    ///      construction. This contract has no sweep, no rescue and no withdrawal — deliberately, since a
    ///      contract holding standing approvals must not also have a way to move value on demand — so
    ///      what lands here is burned. Burning a hostile wei is strictly better than letting a hostile wei
    ///      stop the owner's fills, and accepting it grants no new capability to anyone.
    receive() external payable {}

    /* --------------------------------------------------------------------------------- order lifecycle */

    /// @notice Create an order. Moves NO funds — you separately approve this contract for `tokenIn`, and
    ///         each leg pulls only what it needs when the keeper fills it. `interval == 0` is a limit order
    ///         (fills as soon as the price clears `minOutPerLeg`); `interval > 0` is DCA.
    ///
    /// @param maxSlippageBps How far below the Chainlink-derived fair value a single leg may execute,
    ///                       capped at MAX_SLIPPAGE_BPS.
    ///
    /// The bound is MANDATORY, not opt-in, and it is not parameterised by anything the caller supplies
    /// beyond the tolerance: both tokens must already have a registered feed, and the order snapshots
    /// those feeds. An order without a market reference is the exact order the audit found extractable to
    /// the last wei, and an opt-out is how every such order would be created.
    function createOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountPerLeg,
        uint256 totalBudget,
        uint256 minOutPerLeg,
        uint64 interval,
        uint16 maxSlippageBps
    ) external returns (uint256 id) {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert BadOrder();
        if (amountPerLeg == 0 || totalBudget < amountPerLeg || minOutPerLeg == 0) revert BadOrder();

        PriceBound memory b = _bindFeeds(tokenIn, tokenOut, maxSlippageBps, amountPerLeg);

        id = ++orderCount;
        orders[id] = Order({
            owner: msg.sender,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountPerLeg: amountPerLeg,
            totalBudget: totalBudget,
            spent: 0,
            minOutPerLeg: minOutPerLeg,
            interval: interval,
            lastFill: 0,
            active: true
        });
        _bounds[id] = b;
        _ownerOrders[msg.sender].push(id);
        emit OrderCreated(id, msg.sender, tokenIn, tokenOut, amountPerLeg, totalBudget, minOutPerLeg, interval);
        emit OrderBound(id, b.inFeed.aggregator, b.outFeed.aggregator, maxSlippageBps);
    }

    /// @notice Cancel an order. Only the owner. No funds are held, so nothing is returned — cancelling
    ///         simply stops future fills. (Revoking the ERC-20 approval also stops fills, belt-and-braces.)
    ///
    /// @dev THE EXIT, AND IT READS NO PRICE. Three storage reads and one write. It does not touch `feeds`,
    ///      `_bounds`, `router`, `admin`, `keeper` or the transient lock, so no feed condition — dead,
    ///      reverting, future-dated, sealed, decimals-changed — can stand between an owner and stopping
    ///      their own order. Keep it that way: a line added here that reads a price converts a refused
    ///      FILL into a trapped ORDER, and those are not the same failure.
    function cancelOrder(uint256 id) external {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOrderOwner();
        if (!o.active) revert OrderInactive();
        o.active = false;
        emit OrderClosed(id, false);
    }

    /* ------------------------------------------------------------------------------------- keeper fill */

    /// @notice Fill one leg of `id` with a pre-computed route. Keeper-only. Every safety property the user
    ///         relies on is CHECKED here against the stored order and a live feed pair, not trusted from
    ///         the plan.
    function fillLeg(uint256 id, MoleRouter.SwapPlan calldata plan) external returns (uint256 amountOut) {
        if (msg.sender != keeper) revert NotKeeper();
        _lock();

        Order storage o = orders[id];
        if (!o.active) revert OrderInactive();
        // The FIRST fill (lastFill == 0) is always allowed; the interval only spaces subsequent fills, so a
        // DCA cannot be drained faster than every `interval` seconds after it starts.
        if (o.lastFill != 0 && block.timestamp < uint256(o.lastFill) + uint256(o.interval)) {
            revert IntervalNotElapsed();
        }

        uint256 remaining = o.totalBudget - o.spent;
        if (remaining == 0) revert BudgetExhausted();
        uint256 legIn = remaining < o.amountPerLeg ? remaining : o.amountPerLeg;

        // The plan must be exactly this order's leg: same tokens, same input amount, and the output MUST
        // go to the order owner. This is what stops a keeper routing the user's funds anywhere else.
        if (plan.tokenIn != o.tokenIn || plan.tokenOut != o.tokenOut || plan.amountIn != legIn) revert PlanMismatch();
        if (plan.recipient != o.owner) revert RecipientNotOwner();

        // THE PRICE BOUND. `_legFloor` reads both feeds live, so the number the keeper must clear is
        // authored by the market and the owner's own tolerance — never by the keeper's plan. The router
        // enforces plan.minAmountOut on the POST-fee output delivered to the recipient, and the recipient
        // is the owner, so requiring plan.minAmountOut >= the floor makes the floor a real guarantee.
        if (plan.minAmountOut < _legFloor(id, legIn)) revert FloorNotMet();

        address tokenIn = o.tokenIn;
        address ownerAddr = o.owner;

        // WHAT THE ROUTE MAY HAND BACK. MoleRouter's own zero-residual contract returns the increase of
        // EVERY touched token to the PAYER — which for a keeper fill is this contract. Snapshot each of
        // those tokens now so that after the swap we return only what THIS fill produced, never a balance
        // that was already sitting here.
        address[] memory side = _sideTokens(plan, tokenIn);
        uint256[] memory sideBefore = new uint256[](side.length);
        for (uint256 i = 0; i < side.length; ++i) sideBefore[i] = _balance(side[i]);

        // Pull exactly this leg from the owner (owner approved THIS contract), hand it to the router, and
        // let the router deliver the output straight to the owner.
        uint256 inBefore = _balance(tokenIn);
        _pull(tokenIn, ownerAddr, legIn);
        _approve(tokenIn, address(router), legIn);
        amountOut = router.swap(plan);

        // THE MULTI-PATH FIX. The previous version asserted `_balance(tokenIn) == inBefore` exactly, and
        // that assertion — not the router — is what broke split routes. MoleRouter rescales each path by
        // mulDiv(path.amountIn, amountIn - fee, amountIn) rounding DOWN, so an n-path plan leaves up to
        // n-1 wei unrouted, and the router's `_sweep` correctly returns that wei to the payer. The router
        // honouring its own contract was therefore precisely what made every split fill revert, which is a
        // total liveness failure on exactly the routes the aggregator exists to produce. Single-path plans
        // are exact (mulDiv(A, A-f, A) == A-f), which is why nothing caught it.
        //
        // The unrouted wei now goes back to the OWNER and is not charged against the budget, so the owner
        // is billed for what was actually routed and nothing strands here.
        uint256 inAfter = _balance(tokenIn);
        // Fail closed if the fill left this contract holding LESS input than it started with. Nothing on
        // the honest path can do that — the router's allowance is set to exactly `legIn` — so this catches
        // only a token that moves a balance it was not asked to move, and refusing is the safe answer.
        if (inAfter < inBefore) revert Residual();
        uint256 back;
        unchecked {
            back = inAfter - inBefore;
        }
        // Saturating rather than checked: a route that produces the input token on an intermediate hop can
        // legitimately hand back MORE than the leg. The owner then paid nothing and receives the lot.
        uint256 charged = back < legIn ? legIn - back : 0;

        o.spent += charged;
        o.lastFill = uint64(block.timestamp);
        bool done = o.spent >= o.totalBudget;
        if (done) o.active = false;

        // State first, transfers after — the token calls below are the only untrusted code left in the
        // frame and the transient lock already forbids re-entering `fillLeg`.
        if (back != 0) {
            _push(tokenIn, ownerAddr, back);
            emit LegRefunded(id, tokenIn, back);
        }
        _returnStranded(id, side, sideBefore, ownerAddr);

        emit OrderFilled(id, charged, amountOut, o.spent);
        if (done) emit OrderClosed(id, true);
        _unlock();
    }

    /* ------------------------------------------------------------------------------------------- views */

    function ordersOf(address owner) external view returns (uint256[] memory) {
        return _ownerOrders[owner];
    }

    /// @notice The market-referenced half of an order's floor, as snapshot at creation.
    function boundOf(uint256 id) external view returns (PriceBound memory) {
        return _bounds[id];
    }

    /// @notice The next leg's size and the exact output floor it must clear, priced at the CURRENT feeds.
    ///         The keeper builds `plan.minAmountOut` from this; a plan below it is refused.
    ///         Returns (0, 0) for an order with no budget left.
    function currentLeg(uint256 id) external view returns (uint256 legIn, uint256 floorOut) {
        Order storage o = orders[id];
        uint256 remaining = o.totalBudget - o.spent;
        if (remaining == 0) return (0, 0);
        legIn = remaining < o.amountPerLeg ? remaining : o.amountPerLeg;
        floorOut = _legFloor(id, legIn);
    }

    /// @notice What `amountIn` of `id`'s input token is worth in its output token at the CURRENT feeds,
    ///         before the owner's tolerance is subtracted. Reverts on any unusable feed, exactly where a
    ///         fill would. Exposed because the keeper and the client both need to show a user the price
    ///         their order is being measured against, and re-deriving it off-chain is how the two drift.
    function fairOut(uint256 id, uint256 amountIn) external view returns (uint256) {
        return _fairOut(_bounds[id], amountIn);
    }

    /// @notice True if the order can be filled right now: active, interval elapsed, budget left, AND both
    ///         reference feeds are usable. Choosing the PRICE is still the keeper's job — it builds the
    ///         plan — but whether a price EXISTS to bound it is this contract's, and `fillable` used to
    ///         answer true for an order whose every fill reverted. A green light over a transaction that
    ///         always fails is the quiet failure this book cannot afford.
    ///
    /// @dev Never reverts, including for an id that does not exist. `anchorStatus` gives the numbers. The
    ///      one case it can still be optimistic about is documented in the header: a final partial leg too
    ///      small to price at all.
    function fillable(uint256 id) external view returns (bool) {
        Order storage o = orders[id];
        if (!o.active || o.spent >= o.totalBudget) return false;
        if (block.timestamp < uint256(o.lastFill) + uint256(o.interval)) return false;
        PriceBound memory b = _bounds[id];
        return _readFeed(b.inFeed).code == FEED_OK && _readFeed(b.outFeed).code == FEED_OK;
    }

    /// @notice WHY A FILL IS OR IS NOT PRICEABLE RIGHT NOW, without reverting — so a stalled DCA can be
    ///         reported as a stalled DCA instead of surfacing as a transaction that keeps failing. Both
    ///         feeds are reported separately, because their heartbeats differ by two orders of magnitude
    ///         and "the anchor is stale" without saying WHICH ONE is not an operational answer.
    ///
    /// @return answered  True only when BOTH feeds are usable, i.e. both codes are FEED_OK.
    /// @return codeIn    FEED_* for the input token's feed.
    /// @return ageIn     Seconds since that feed's latest round, or 0 if it could not be read.
    /// @return maxAgeIn  The bound `ageIn` must stay within. Zero for an id that was never created.
    /// @return codeOut   FEED_* for the output token's feed.
    /// @return ageOut    Seconds since that feed's latest round, or 0 if it could not be read.
    /// @return maxAgeOut The bound `ageOut` must stay within.
    function anchorStatus(uint256 id)
        external
        view
        returns (bool answered, uint8 codeIn, uint32 ageIn, uint32 maxAgeIn, uint8 codeOut, uint32 ageOut, uint32 maxAgeOut)
    {
        PriceBound memory b = _bounds[id];
        maxAgeIn = b.inFeed.maxAge;
        maxAgeOut = b.outFeed.maxAge;
        Round memory rIn = _readFeed(b.inFeed);
        Round memory rOut = _readFeed(b.outFeed);
        (codeIn, ageIn) = (rIn.code, rIn.age);
        (codeOut, ageOut) = (rOut.code, rOut.age);
        answered = codeIn == FEED_OK && codeOut == FEED_OK;
    }

    /* -------------------------------------------------------------------------------------------- admin */

    function setKeeper(address _keeper) external {
        if (msg.sender != admin) revert NotAdmin();
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    function transferAdmin(address _pending) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingAdmin = _pending;
        emit AdminTransferStarted(admin, _pending);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        emit AdminTransferred(admin, msg.sender);
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice Register (or replace) the USD price feed for one token, with ITS OWN age bound.
    ///
    /// @param token      The ERC-20 an order may name. Its `decimals()` is read here and pinned.
    /// @param aggregator The Chainlink AggregatorV3 proxy quoting that token in USD.
    /// @param maxAge     How old this feed's latest round may be, in seconds. Per feed on purpose: the
    ///                   heartbeats on this chain differ by two orders of magnitude, so one global bound
    ///                   is either a permanent outage for the stablecoin feeds or useless for ETH.
    ///
    /// @dev STRICT, and strict here is cheap in a way it is not at fill time. The feed is read through the
    ///      exact validation `fillLeg` will run and every condition refuses, so a feed that is dead,
    ///      silent past its own bound, future-dated, contradicting its own round bookkeeping or reporting
    ///      an absurd answer cannot be registered at all. Nothing is at stake in this transaction and the
    ///      admin is present to see the failure; at fill time the same failure is a stalled order.
    ///
    ///      RE-REGISTRATION IS ALLOWED (until sealed) and deliberately does NOT touch existing orders:
    ///      each one snapshot its feeds at creation. So this changes what the NEXT order binds to and has
    ///      no power over money already committed.
    function registerFeed(address token, address aggregator, uint32 maxAge) external {
        if (msg.sender != admin) revert NotAdmin();
        if (feedsSealed) revert FeedsAreSealed();
        if (token == address(0) || aggregator == address(0) || token == NATIVE) revert BadFeedConfig();
        if (maxAge < MIN_FEED_MAX_AGE || maxAge > MAX_FEED_MAX_AGE) revert BadFeedConfig();

        uint8 tokenDec = _readDecimals(token);
        uint8 feedDec = _readDecimals(aggregator);

        Feed memory f =
            Feed({aggregator: aggregator, maxAge: maxAge, feedDecimals: feedDec, tokenDecimals: tokenDec, set: true});
        Round memory r = _readFeed(f);
        if (r.code != FEED_OK) _revertFeed(f, r);

        feeds[token] = f;
        emit FeedRegistered(token, aggregator, maxAge, feedDec, tokenDec);
    }

    /// @notice Give up the power to register feeds, permanently. After this the admin can rotate the
    ///         keeper and nothing else, and no order's anchor can be influenced by anyone.
    ///
    /// @dev The price of it is stated rather than hidden: once sealed, a feed that dies cannot be
    ///      replaced, so every order on that pair stalls and its owner exits with `cancelOrder` — which
    ///      reads no feed and therefore still works. That is the intended trade. Seal after the pair is
    ///      registered and verified.
    function sealFeeds() external {
        if (msg.sender != admin) revert NotAdmin();
        feedsSealed = true;
        emit FeedsSealedForever();
    }

    /* ------------------------------------------------------------------------------------ price bound */

    /// @dev Resolve both tokens to registered feeds and snapshot them into the order's bound. Everything
    ///      checkable is checked HERE, once, so `fillLeg` stays a read.
    function _bindFeeds(address tokenIn, address tokenOut, uint16 maxSlippageBps, uint256 amountPerLeg)
        internal
        view
        returns (PriceBound memory b)
    {
        // The cap is the contract's own statement of the worst case, so it is enforced here rather than
        // trusted from a client: no order may be created that authorises giving away more than this.
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadBound();

        Feed memory fi = feeds[tokenIn];
        Feed memory fo = feeds[tokenOut];
        if (!fi.set) revert FeedNotRegistered(tokenIn);
        if (!fo.set) revert FeedNotRegistered(tokenOut);

        b = PriceBound({inFeed: fi, outFeed: fo, maxSlippageBps: maxSlippageBps});

        // Evaluate the bound once, now. A pair whose price is so extreme that a FULL leg is worth zero of
        // the output token must fail at creation — where the owner sees it — rather than at every fill for
        // the life of the order. This also re-reads both feeds through the strict path, so an order cannot
        // be created against a feed that has gone bad since it was registered.
        if (_fairOut(b, amountPerLeg) == 0) revert BadBound();
    }

    /// @dev What `amountIn` of the order's input token is worth in its output token, from two USD feeds.
    ///
    ///      THE ARITHMETIC, written out because this is where a decimals error becomes a fund-loss bug.
    ///      A raw input amount is `amountIn / 10^tokenDecIn` whole tokens; each whole token is worth
    ///      `priceIn / 10^feedDecIn` dollars; each dollar buys `10^feedDecOut / priceOut` whole output
    ///      tokens; and each whole output token is `10^tokenDecOut` raw units. Multiply the four:
    ///
    ///          out = amountIn × priceIn × 10^(feedDecOut + tokenDecOut)
    ///                         ÷ (priceOut × 10^(feedDecIn + tokenDecIn))
    ///
    ///      Both scale factors are at most 1e36 (MAX_DECIMALS caps each exponent's halves at 18) and both
    ///      answers are at most MAX_FEED_ANSWER = type(uint256).max / 1e36, so neither product can
    ///      overflow — that pairing is why MAX_FEED_ANSWER is defined the way it is rather than picked.
    ///      `FullMath.mulDiv` then takes the 512-bit product of `amountIn` with the numerator before
    ///      dividing, so the whole thing rounds exactly ONCE, down. Down is the direction that favours the
    ///      KEEPER — the floor lands at most one raw unit of the output token below exact — and that is
    ///      accepted rather than corrected: one raw unit against a floor already sitting `maxSlippageBps`
    ///      below fair value is not a lever, and rounding the other way would put an unreachable floor on
    ///      a leg whose fair value is exact.
    function _fairOut(PriceBound memory b, uint256 amountIn) internal view returns (uint256) {
        uint256 priceIn = _requireFeedPrice(b.inFeed);
        uint256 priceOut = _requireFeedPrice(b.outFeed);

        uint256 num = priceIn * (10 ** (uint256(b.outFeed.feedDecimals) + uint256(b.outFeed.tokenDecimals)));
        uint256 den = priceOut * (10 ** (uint256(b.inFeed.feedDecimals) + uint256(b.inFeed.tokenDecimals)));
        return FullMath.mulDiv(amountIn, num, den);
    }

    /// @dev The output floor for a leg of `legIn`: the higher of the owner's own absolute floor (scaled to
    ///      a partial final leg) and the live fair value less the owner's tolerance.
    function _legFloor(uint256 id, uint256 legIn) internal view returns (uint256 floorOut) {
        Order storage o = orders[id];
        // ROUNDED UP, and that is the whole fix for the final partial leg. Rounding DOWN made
        // `minOutPerLeg * legIn / amountPerLeg` reach ZERO whenever `minOutPerLeg * legIn < amountPerLeg`
        // — which the client's own `perLeg = total / n` guarantees for the remainder leg — and a zero
        // floor is a vacuous one: `plan.minAmountOut >= 0` always holds and MoleRouter's `_deliverOutput`
        // returns early on a zero output, so the owner was charged for the leg and received nothing.
        // Rounding up cannot reach zero for a non-empty leg, at a cost of at most one wei of strictness.
        floorOut = FullMath.mulDivRoundingUp(o.minOutPerLeg, legIn, o.amountPerLeg);

        PriceBound memory b = _bounds[id];
        uint256 fair = _fairOut(b, legIn);
        // FAIL CLOSED. A zero fair value is not "no market half", it is "this leg cannot be priced": the
        // market floor would be zero, only the owner's absolute floor would bind, and that silent
        // degradation to a stale constant is the exact hole the price bound exists to close. Refusing
        // costs the owner the timing of a leg whose whole fair output is under one raw unit; `cancelOrder`
        // is unaffected either way.
        if (fair == 0) revert LegNotPriceable();
        uint256 market = FullMath.mulDiv(fair, BPS_DENOM - b.maxSlippageBps, BPS_DENOM);
        if (market > floorOut) floorOut = market;
    }

    /* ------------------------------------------------------------------------------------- feed reads */

    /// @dev THE ONLY IMPLEMENTATION OF THE FEED GUARDS, and it never reverts.
    ///
    ///      Two callers need opposite behaviour from the same checks: `fillLeg` must REFUSE under a named
    ///      error, and `anchorStatus` / `fillable` must ANSWER so a client can explain a stall. Writing
    ///      the checks twice is how the two drift, and a drifted view is worse than no view — it shows a
    ///      green light over a transaction that reverts. So the conditions live here once, as codes, and
    ///      `_requireFeedPrice` maps them on to errors.
    ///
    ///      NOTHING IN HERE MAY REVERT, which dictates the shape:
    ///        - a raw `staticcall` rather than a call through IAggregatorV3, because an address with no
    ///          code returns success with empty data (a DECODE failure, not a catchable revert) and
    ///          because a reverting aggregator must be a code, not a bubbled revert;
    ///        - returndata length checked before decoding;
    ///        - every field decoded as uint256/int256 rather than uint80, because `abi.decode` into a
    ///          narrow type REVERTS on dirty high bits and a hostile aggregator can set them at will. The
    ///          comparisons that follow are exact in the wide type anyway.
    function _readFeed(Feed memory f) internal view returns (Round memory r) {
        // AND THERE IS DELIBERATELY NO `f.aggregator.code.length == 0` CLAUSE HERE. It would be
        // UNFIREABLE: a staticcall to an address with no code SUCCEEDS with empty returndata, which the
        // two length checks below already refuse as FEED_UNREADABLE. A clause no input can reach on its
        // own reads as protection while providing none — the same reasoning that kept `|| extrapolated`
        // out of the guard this contract used to carry. Mutating it away left every test green, which is
        // how it was found rather than argued. `test_anUnreadableAggregatorIsRefusedAndTheViewsStill
        // Answer` etches an aggregator's code off the chain and pins that the length checks catch it.
        if (!f.set) {
            r.code = FEED_UNSET;
            return r;
        }

        (bool okDec, bytes memory decRet) =
            f.aggregator.staticcall(abi.encodeWithSelector(IAggregatorV3.decimals.selector));
        if (!okDec || decRet.length < 32) {
            r.code = FEED_UNREADABLE;
            return r;
        }
        r.reportedDecimals = abi.decode(decRet, (uint256));

        (bool okRound, bytes memory roundRet) =
            f.aggregator.staticcall(abi.encodeWithSelector(IAggregatorV3.latestRoundData.selector));
        if (!okRound || roundRet.length < 160) {
            r.code = FEED_UNREADABLE;
            return r;
        }
        (r.roundId, r.rawAnswer,, r.updatedAt, r.answeredInRound) =
            abi.decode(roundRet, (uint256, int256, uint256, uint256, uint256));

        if (r.reportedDecimals != uint256(f.feedDecimals)) {
            r.code = FEED_DECIMALS_CHANGED;
            return r;
        }
        if (r.rawAnswer <= 0) {
            r.code = FEED_NON_POSITIVE;
            return r;
        }
        if (r.answeredInRound < r.roundId) {
            r.code = FEED_STALE_ROUND;
            return r;
        }
        // BOTH SIDES OF THE CLOCK. The age bound below only says how OLD a round may be, so a round dated
        // in the future is permanently "fresh" and the age bound defeats itself — a `updatedAt` thirty
        // days ahead keeps this feed usable for thirty days after it goes silent. A future timestamp is
        // not lateness; it is the feed asserting something about the clock that cannot be true.
        if (r.updatedAt > block.timestamp) {
            r.code = FEED_FUTURE_DATED;
            return r;
        }

        uint256 age = block.timestamp - r.updatedAt;
        r.age = age > type(uint32).max ? type(uint32).max : uint32(age);
        if (age > uint256(f.maxAge)) {
            r.code = FEED_STALE;
            return r;
        }
        // An answer above this cannot be scaled by the pair's decimals without overflowing, so it is
        // refused as a number rather than allowed to revert with an arithmetic panic three frames down.
        if (uint256(r.rawAnswer) > MAX_FEED_ANSWER) {
            r.code = FEED_ANSWER_TOO_LARGE;
            return r;
        }

        r.answer = uint256(r.rawAnswer);
        r.code = FEED_OK;
    }

    /// @dev The strict half: the same read, with every non-OK code raised under its own name. FAIL CLOSED
    ///      — a leg that cannot be priced must not be filled — and named, because "the ETH feed is 3 hours
    ///      past its 1-hour bound" and "the ETH feed's proxy now reports 18 decimals" need different
    ///      people to do different things, and a single `BadOracle()` tells neither of them which.
    function _requireFeedPrice(Feed memory f) internal view returns (uint256) {
        Round memory r = _readFeed(f);
        if (r.code != FEED_OK) _revertFeed(f, r);
        return r.answer;
    }

    function _revertFeed(Feed memory f, Round memory r) internal view {
        if (r.code == FEED_UNSET) revert NoFeedBound();
        if (r.code == FEED_UNREADABLE) revert FeedUnreadable(f.aggregator);
        if (r.code == FEED_DECIMALS_CHANGED) {
            revert FeedDecimalsChanged(f.aggregator, f.feedDecimals, r.reportedDecimals);
        }
        if (r.code == FEED_NON_POSITIVE) revert NonPositiveAnswer(f.aggregator, r.rawAnswer);
        if (r.code == FEED_STALE_ROUND) revert StaleRound(f.aggregator, r.roundId, r.answeredInRound);
        if (r.code == FEED_FUTURE_DATED) revert FutureDatedRound(f.aggregator, r.updatedAt, block.timestamp);
        if (r.code == FEED_STALE) revert StalePrice(f.aggregator, r.age, f.maxAge);
        revert AnswerTooLarge(f.aggregator, uint256(r.rawAnswer));
    }

    /// @dev `decimals()` off a token or an aggregator, refused if absent or above MAX_DECIMALS. Used only
    ///      at registration: a token that will not say how many decimals it has cannot be priced, and
    ///      guessing is the 6-vs-18 fund-loss bug this chain is full of.
    function _readDecimals(address target) internal view returns (uint8) {
        if (target.code.length == 0) revert BadFeedConfig();
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeWithSelector(IAggregatorV3.decimals.selector));
        if (!ok || ret.length < 32) revert BadFeedConfig();
        uint256 d = abi.decode(ret, (uint256));
        if (d > uint256(MAX_DECIMALS)) revert BadFeedConfig();
        return uint8(d);
    }

    /* ---------------------------------------------------------------------------------------- internal */

    /// @dev Every token this route can leave behind here EXCEPT the input token, which `fillLeg` accounts
    ///      for separately because what comes back reduces what the owner is charged.
    ///
    ///      The router sweeps the increase of every token it touched to the payer, and this contract is the
    ///      payer. It has no rescue, no owner withdrawal and no sweep of any kind — deliberately, since a
    ///      contract holding standing approvals should not also have a way to move tokens on demand — so
    ///      anything swept back that we do not forward in the same call is burned permanently. An
    ///      over-delivered output token or a short-filled intermediate is exactly that shape.
    function _sideTokens(MoleRouter.SwapPlan calldata plan, address tokenIn)
        internal
        pure
        returns (address[] memory out)
    {
        uint256 cap = 1;
        for (uint256 p = 0; p < plan.paths.length; ++p) cap += plan.paths[p].hops.length * 2;
        address[] memory buf = new address[](cap);
        uint256 n = _addUnique(buf, 0, plan.tokenOut, tokenIn);
        for (uint256 p = 0; p < plan.paths.length; ++p) {
            uint256 hn = plan.paths[p].hops.length;
            for (uint256 h = 0; h < hn; ++h) {
                n = _addUnique(buf, n, plan.paths[p].hops[h].tokenIn, tokenIn);
                n = _addUnique(buf, n, plan.paths[p].hops[h].tokenOut, tokenIn);
            }
        }
        out = new address[](n);
        for (uint256 i = 0; i < n; ++i) out[i] = buf[i];
    }

    /// @dev Linear dedup over a handful of entries — a route is a few hops, so this is the right shape.
    ///      Skips the input token (accounted separately), the zero address, and the router's native
    ///      sentinel, none of which are a token to ask for a balance.
    function _addUnique(address[] memory buf, uint256 n, address token, address skip)
        internal
        pure
        returns (uint256)
    {
        if (token == skip || token == address(0) || token == NATIVE) return n;
        for (uint256 i = 0; i < n; ++i) {
            if (buf[i] == token) return n;
        }
        buf[n] = token;
        return n + 1;
    }

    /// @dev Forward the increase of every side token to the order owner. The baseline is the pre-swap
    ///      snapshot, so a balance that was already stranded here from someone else's fill is untouched —
    ///      the same reasoning MoleRouter's own `_sweep` uses, and the reason this cannot become a way for
    ///      one order to harvest another's leftovers.
    function _returnStranded(uint256 id, address[] memory tokens, uint256[] memory before, address to) internal {
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 nowBal = _balance(tokens[i]);
            if (nowBal > before[i]) {
                uint256 stranded;
                unchecked {
                    stranded = nowBal - before[i];
                }
                _push(tokens[i], to, stranded);
                emit LegRefunded(id, tokens[i], stranded);
            }
        }
    }

    function _pull(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @dev The ONLY outbound transfer in this contract, and every call site pays the order owner. There
    ///      is deliberately no variant that takes a caller-supplied destination.
    function _push(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _balance(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }

    function _lock() internal {
        bytes32 s = _LOCK;
        uint256 v;
        assembly ("memory-safe") {
            v := tload(s)
        }
        if (v != 0) revert Reentrancy();
        assembly ("memory-safe") {
            tstore(s, 1)
        }
    }

    function _unlock() internal {
        bytes32 s = _LOCK;
        assembly ("memory-safe") {
            tstore(s, 0)
        }
    }
}
