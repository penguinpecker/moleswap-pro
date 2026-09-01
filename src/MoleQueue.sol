// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickBitmap} from "v4-core/libraries/TickBitmap.sol";
import {BitMath} from "v4-core/libraries/BitMath.sol";
import {LiquidityMath} from "v4-core/libraries/LiquidityMath.sol";

interface IMoleOracle {
    function consult(PoolId id, uint32 secondsAgo) external view returns (int24 arithmeticMeanTick);

    /// @notice HOW MUCH DEAD AIR THE ANCHOR RESTS ON. `consult` answers by extending the cumulative past
    ///         the newest ring entry with the tick in force since it, which is exactly right for a pool
    ///         that trades and exactly USELESS for one that has not traded in a month: the answer is
    ///         confident, well-formed and made entirely of extrapolation from a fossil. Nothing in
    ///         `consult`'s return value distinguishes the two, so the freshness question is asked
    ///         separately — and it must be asked of something an attacker cannot answer for free.
    ///         `quietSpan` is the widest stretch of recorded-nothing behind the answer; `extrapolated`
    ///         says the window contained no trade at all. See `_requireAnchorIsFresh`.
    /// @dev Matches MoleHook's `consultEvidence` field-for-field.
    function consultEvidence(PoolId id, uint32 secondsAgo)
        external
        view
        returns (uint32 quietSpan, bool extrapolated);

    /// @notice The oracle's own bookkeeping for a pool.
    /// @dev DELIBERATELY NO LONGER THE FRESHNESS INSTRUMENT, and that is this declaration's remaining job:
    ///      to say so where the next reader will look. `lastObsTimestamp` is the last RING WRITE, which
    ///      MoleHook stamps on ANY swap past `minObservationInterval` regardless of size and regardless of
    ///      whether the tick moved — so one raw unit resets it to zero while the cumulative it writes
    ///      merely carries the fossil tick forward. Gating settlement on it gated settlement on a number
    ///      the attacker sets in the same transaction that settles. Kept declared because it is a genuine
    ///      part of the oracle's surface and integrations read it; NOT read by any guard here.
    ///      Matches MoleHook's public `poolStates` getter field-for-field.
    function poolStates(PoolId id)
        external
        view
        returns (
            uint16 index,
            uint32 lastTimestamp,
            uint32 lastObsTimestamp,
            int24 lastTick,
            int56 tickCumulative,
            bool initialized
        );
}

/// @title MoleQueue
/// @notice The batch auction: opposing swap intents cross against each other at TWAP, and only the
///         residual touches the pool.
///
/// WHAT IT CROSSES, AND WHY THAT IS THE SWAP RATHER THAN THE POSITION. A depositor turning one token into
/// a two-sided position must SELL some of it. A withdrawer leaving with one token must sell the other.
/// Those two are on opposite sides of the same trade — so the thing to net is the swap, not the position.
/// Netting there means this contract needs no reach into MolePositions at all: no `openFor`, no owner
/// parameter, no allowlisted caller, no new trust anywhere in the custody core. Users get better
/// execution here and then open a position exactly as they do today.
///
/// WHY QUEUING BEATS GOING INSTANTLY, which is the condition the owner's "ship both" decision rests on:
/// a crossed order pays NO pool fee and NO slippage, because no pool trade happens for the matched part.
/// An instant swap pays both. The advantage is structural rather than a surcharge we invented, so the
/// zero-deposit-fee promise survives intact. If crossing ever stopped being better, nobody would queue and
/// the netting thesis would die quietly — so `test_queued_beats_instant` exists to fail loudly instead.
///
/// UNIFORM PRICE. Everyone on the same side of an epoch settles at the same blended rate: the crossed
/// portion at TWAP, the residual at whatever one aggregated pool swap achieved. Nobody is advantaged by
/// being early in the queue, which is the entire point of a batch.
///
/// THE THREE WAYS MONEY LEAVES, and there is deliberately no fourth:
///   1. CANCEL, free and permissionless, any time before the epoch freezes.
///   2. CLAIM, after settlement.
///   3. RECLAIM, permissionless and unconditional, if an epoch is not settled within `maxEpochLife` of
///      freezing. This is the answer to "what if the settler disappears" and it is why the freeze window
///      is a delay rather than a hostage. Without it a dead operator would trap escrow forever, which
///      would contradict the one promise this whole protocol is built on.
contract MoleQueue is IUnlockCallback, Initializable, UUPSUpgradeable {
    using PoolIdLibrary for PoolKey;

    enum Phase {
        Open, // accepting orders; cancel is free
        Frozen, // no new orders, no cancels; awaiting settlement
        Settled, // crossed and swapped; owners may claim
        Refunding // timed out; owners may reclaim their escrow in full

    }

    struct Order {
        address owner;
        bool zeroForOne; // true = selling currency0 for currency1
        uint128 amountIn;
        bool withdrawn; // claimed or cancelled or reclaimed — one shot, whichever it was
    }

    struct Epoch {
        Phase phase;
        uint64 frozenAt;
        uint128 totalIn0; // escrowed by sellers of currency0
        uint128 totalIn1; // escrowed by sellers of currency1
        // Settlement output, per side, as a rate: how much of the OTHER token each unit gets.
        uint128 out0; // total currency1 owed to the currency0 sellers
        uint128 out1; // total currency0 owed to the currency1 sellers
        // Q-3. The part of each side that was NOT swapped and comes back in the token it arrived in.
        // Non-zero only when the residual leg could not be executed within its bound by the deadline;
        // see `settle`. Kept per side because the two sides are refunded independently.
        uint128 refund0;
        uint128 refund1;
    }

    IPoolManager public poolManager;
    IMoleOracle public oracle;
    PoolKey public key;

    /// @notice Seconds an epoch stays open, then the freeze window, then the deadline to settle.
    /// @dev All three are immutable. The freeze is what closes the reshape-the-residual grief: a cancel
    ///      that lands after the cutoff cannot change what settlement executes. `maxEpochLife` is what
    ///      stops the freeze becoming a trap.
    uint32 public epochDuration;
    uint32 public freezeDuration;
    uint32 public maxEpochLife;
    uint32 public twapWindow;

    /// @notice Refuse to settle when the anchor and the market have visibly diverged.
    /// @dev THE OTHER HALF OF CHOOSING A TWAP ANCHOR, and it was missing. Crossing at TWAP rather than
    ///      spot is right — an ordering-privileged party sets spot for free. But a TWAP is a lagging
    ///      number, and when the market moves inside the window the batch would otherwise cross
    ///      confidently at a price it can already see is stale. The honest party who queued BEFORE the
    ///      move cannot leave (the cutoff, by design), so they eat it; someone who merely REACTS after
    ///      the move takes the other side at a better-than-market rate with no capital at risk.
    ///      MolePositions already declines to act on a stale anchor — `maxTwapDeviationTicks` — and this
    ///      is the same guard for the same reason. Refusing to settle is safe: the epoch times out and
    ///      everyone reclaims in kind.
    int24 public maxTwapDeviationTicks;

    /// @notice How far the aggregated residual swap may execute from the TWAP before settlement refuses.
    /// @dev `settle` is PERMISSIONLESS, which is deliberate — a settlement only one party can trigger
    ///      stops happening the day that party stops caring — but it means the bound cannot be a caller
    ///      argument: whoever calls could simply pass a useless one. So the bound is immutable and
    ///      measured against the TWAP the contract read itself. Without it the residual swap ran with no
    ///      price limit and no minimum out, and a sandwicher could take a cut of every batch.
    uint16 public maxResidualSlippageBps;

    uint64 public currentEpoch;
    uint64 public epochStartedAt;

    mapping(uint64 => Epoch) public epochs;
    mapping(uint64 => Order[]) public orders;

    event OrderPlaced(uint64 indexed epoch, uint256 indexed index, address indexed owner, bool zeroForOne, uint128 amountIn);
    event OrderCancelled(uint64 indexed epoch, uint256 indexed index, address indexed owner);
    event EpochFrozen(uint64 indexed epoch);
    event EpochSettled(uint64 indexed epoch, int24 twapTick, uint128 crossed0, uint128 crossed1);
    event EpochTimedOut(uint64 indexed epoch);
    /// @notice The crossed portion settled at TWAP; the unmatched remainder is coming back in kind.
    event ResidualRefunded(uint64 indexed epoch, uint128 refund0, uint128 refund1);
    event Claimed(uint64 indexed epoch, uint256 indexed index, address indexed owner, uint256 amountOut, uint256 refunded);

    error WrongPhase();
    error ZeroAmount();
    error NotOrderOwner();
    error AlreadyWithdrawn();
    error TooEarly();
    error NotTimedOut();
    error NothingToSettle();
    error TransferFailed();
    error NotPoolManager();
    error TwapTooFarFromSpot();
    error ResidualSwapTooFarFromTwap();
    /// @dev S-1. See `_swapExactIn`.
    error ResidualShortFill();
    /// @dev The residual swap failed with no reason data at all — re-thrown rather than swallowed.
    error ResidualSwapFailed();
    error NotUpgradeAdmin();
    error TwapBandRequired();
    error BadSlippageBps();
    error BadDurations();
    error LifeMustOutlastFreeze();
    error UpgradeAdminRequired();
    /// @dev F-03. A currency this contract cannot actually move. See `initialize`.
    error UnsupportedCurrency();
    /// @dev F-03 / H-2. `place` credited what it was told rather than what arrived. See `place`.
    error EscrowNotReceived();
    /// @dev F-04. The anchor is not backed by a recent observation — it is pure extrapolation.
    error OracleTooStale();
    /// @dev The clearing price moved further from the previous batch's than one settlement may move it.
    error ClearingJumpTooLarge();
    /// @dev Nothing is in range to back the price this batch would clear at.
    error InsufficientPoolDepth();
    /// @dev H-1. `unlockCallback` reached without this contract having asked for the unlock.
    error UnlockNotInitiated();
    /// @dev The settle window has closed; the epoch's only remaining resolution is `timeout`.
    error SettleWindowClosed();
    error BadGuardParams();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Bounds and schedule, set once. STORAGE RATHER THAN IMMUTABLE, and the distinction is not
    ///         weaker than it looks: behind a UUPS proxy `immutable` buys nothing a determined upgrade
    ///         admin could not take anyway, since replacing the implementation replaces the constants
    ///         baked into it. What the bounds still guarantee is what they were for — `settle` is
    ///         PERMISSIONLESS, so the price bounds cannot be caller arguments, or whoever called would
    ///         simply pass useless ones. These are set by the deployer and readable by anyone.
    function initialize(
        IPoolManager _poolManager,
        IMoleOracle _oracle,
        PoolKey memory _key,
        uint32 _epochDuration,
        uint32 _freezeDuration,
        uint32 _maxEpochLife,
        uint32 _twapWindow,
        int24 _maxTwapDeviationTicks,
        uint16 _maxResidualSlippageBps,
        address _upgradeAdmin
    ) external initializer {
        if (_maxTwapDeviationTicks <= 0) revert TwapBandRequired();
        if (_maxResidualSlippageBps == 0 || _maxResidualSlippageBps >= 10_000) revert BadSlippageBps();
        if (_epochDuration == 0 || _freezeDuration == 0) revert BadDurations();
        // A zero TWAP window makes `consult` revert on every settlement, so the queue would be dead on
        // arrival with no on-chain signal until the first batch failed. It is also the divisor the
        // derived short window comes from.
        if (_twapWindow == 0) revert BadDurations();
        // F-03: REFUSE A POOL THIS CONTRACT CANNOT ACTUALLY MOVE MONEY FOR, at the one moment it is
        // still cheap to refuse. Every value movement here is a raw `call` to `Currency.unwrap(c)` that
        // treats empty returndata as success. For a native pool the unwrapped address is address(0) — a
        // CODELESS account — so the call returns success with no returndata, the transfer guard cannot
        // fire, and `place` credits escrow that never arrived while `claim` pays the honest side nothing
        // and marks them withdrawn. The queue has no `receive()` and no payable entry point, so it could
        // never have supported native anyway; half-supporting it is the failure mode. The same reasoning
        // covers any codeless currency: an EOA or an undeployed address behaves identically. MolePositions
        // learned this in `whitelistPool`; this is the same refusal in the one contract that had none.
        if (Currency.unwrap(_key.currency0).code.length == 0) revert UnsupportedCurrency();
        if (Currency.unwrap(_key.currency1).code.length == 0) revert UnsupportedCurrency();
        // The timeout must outlast the freeze, or an epoch would be reclaimable before it was ever
        // settleable and no batch could complete.
        if (_maxEpochLife <= _freezeDuration) revert LifeMustOutlastFreeze();
        if (_upgradeAdmin == address(0)) revert UpgradeAdminRequired();
        poolManager = _poolManager;
        oracle = _oracle;
        key = _key;
        epochDuration = _epochDuration;
        freezeDuration = _freezeDuration;
        maxEpochLife = _maxEpochLife;
        twapWindow = _twapWindow;
        maxTwapDeviationTicks = _maxTwapDeviationTicks;
        maxResidualSlippageBps = _maxResidualSlippageBps;
        upgradeAdmin = _upgradeAdmin;
        epochStartedAt = uint64(block.timestamp);
    }

    /// @notice Whoever holds this can replace every line of this contract, INCLUDING the escrow accounting.
    ///         Stated plainly rather than buried: that is the price of the proxy, the same trade the
    ///         custody core already makes. `transferUpgradeAdmin(address(0))` surrenders it permanently.
    address public upgradeAdmin;

    event UpgradeAdminTransferred(address indexed from, address indexed to);

    function _authorizeUpgrade(address) internal override {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
    }

    function transferUpgradeAdmin(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        emit UpgradeAdminTransferred(upgradeAdmin, to);
        upgradeAdmin = to;
    }

    /// @notice When `freeze()` was actually called, as opposed to the cutoff it stamps into `frozenAt`.
    /// @dev THIS OCCUPIES SLOT 10 ON THE LIVE ROBINHOOD PROXY and must stay there. It shipped on
    ///      2026-08-23 in implementation 0x12B48457 as the F-05 fix, and a later change briefly dropped
    ///      it — which silently moved every variable appended after it onto storage that already held
    ///      something else. It is restored here ahead of the newer fields for that reason alone: on a
    ///      live proxy the layout is the ABI, and a deleted variable is not a deletion, it is a
    ///      reinterpretation of somebody's money. Anything new goes AFTER this line, never before it.
    mapping(uint64 => uint64) public frozenCallAt;

    /* ------------------------------------------------- settlement guards (appended state) */

    // APPENDED, NOT INSERTED, and every default below is DERIVED rather than required. These variables
    // landed on a proxy that was already holding escrow, and an upgrade cannot re-run `initialize` — so
    // the instant the new implementation is live they all read zero. A guard whose zero value means
    // "refuse everything" would have bricked the queue at the moment of the upgrade; a guard whose zero
    // value means "check nothing" would not be a guard. So zero means DERIVE FROM THE EXISTING SCHEDULE,
    // and `setSettlementGuards` exists for the operator to tighten past the derived default afterwards.
    //
    // ORDER MATTERS HERE FOR A REASON THAT IS NOT STYLE. `upgradeAdmin` is an address, so eleven bytes of
    // its slot are free and any small type declared next would be packed into them — legal under the
    // append-only rule (those bytes have never been written on chain, so they read zero, which is exactly
    // the derive-the-default path) but it would put NEW state in the SAME slot as state the live proxy
    // already holds, and a reader would then have to reason about masked writes to be sure. Leading with
    // the uint128 is sixteen bytes, which cannot fit in eleven, so the whole group starts a fresh slot and
    // nothing new shares a slot with anything old. The `forge inspect storage-layout` diff says so.

    /// @notice The in-range liquidity the pool must carry for a batch to clear against it.
    /// @dev Zero derives 1 — i.e. the pool must have SOME liquidity in range. Raise it for a pool whose
    ///      realistic depth is known.
    uint128 public minSettleLiquidity;

    /// @notice The window of the SECOND, short TWAP that `settle` measures the clearing anchor against.
    /// @dev F-04. The staleness check used to compare the clearing TWAP against `slot0` spot — the one
    ///      number the permissionless settler can move for free, inside the very transaction that
    ///      settles. Zero derives 60 seconds (capped at `twapWindow`): short enough that a genuine market
    ///      move registers within a block or two, long enough that dominating it costs the attacker a
    ///      position held ACROSS blocks at real risk rather than a free round trip inside one.
    uint32 public shortTwapWindow;

    /// @notice How old the oracle's newest observation may be before settlement refuses.
    /// @dev Zero derives `twapWindow + 4 * maxEpochLife` — long enough that a pool which trades at all
    ///      during an epoch's life never trips it, short enough that a pool nobody has touched for hours
    ///      stops being settleable. Tighten it with `setSettlementGuards` for a pool with real flow.
    uint32 public maxOracleStaleness;

    /// @notice How far one settlement's clearing tick may sit from the previous settlement's.
    /// @dev Zero derives `maxTwapDeviationTicks * 8`, capped at the tick range. A batch is not the place
    ///      to discover that the price moved 200%: refusing costs the participants nothing (the epoch
    ///      times out and everyone reclaims in kind) and a manufactured excursion is exactly the shape
    ///      this refuses to price against.
    int24 public maxClearingJumpTicks;

    /// @notice The clearing tick of the last epoch this queue settled, and whether there has been one.
    int24 public lastClearingTick;
    bool public clearingTickSet;

    /// @notice WHEN that clearing tick was recorded.
    /// @dev THE ANCHOR IS EVIDENCE WITH A SHELF LIFE, AND UNTIL THIS EXISTED NOTHING RECORDED THE DATE.
    ///      `lastClearingTick` had exactly one writer, and it sat DOWNSTREAM of the check that reads it —
    ///      so the reachable clearing ticks were a chain of at-most-one-band steps, and each step needed a
    ///      settleable epoch to exist at the moment the TWAP sat on that intermediate tick. A market that
    ///      drifted past the band while no batch happened to settle left every later `settle` reverting
    ///      `ClearingJumpTooLarge` for ever: the guard was an ABSORBING STATE, escapable only by the root
    ///      key, and this queue's normal state is exactly the one that reaches it (one settlement in three
    ///      weeks). `setSettlementGuards` writes the other four guard variables and not this one, so there
    ///      was no re-anchor path at all. See `clearingJumpAllowance` for the fix and its defence.
    ///
    ///      APPEND-ONLY, AND THIS IS THE PART TO GET RIGHT: the live proxy has written slots 0..11 and
    ///      nothing else. `clearingTickSet` ends slot 11 with ONE spare byte, a uint64 does not fit in it,
    ///      so this opens slot 12 — a slot the live queue has never written — and nothing above moves,
    ///      resizes or disappears. The `forge inspect storage-layout` diff is the proof.
    ///
    ///      ZERO IS A LEGITIMATE VALUE and it means "age unknown", which is the state a queue upgraded
    ///      into this code is in if it had already cleared an epoch. Unknown age reads as ANCIENT rather
    ///      than as fresh: the age is genuinely not known, and the four other settlement guards do not
    ///      depend on it.
    uint64 public lastClearingAt;

    event SettlementGuardsSet(
        uint32 shortTwapWindow, uint32 maxOracleStaleness, int24 maxClearingJumpTicks, uint128 minSettleLiquidity
    );
    event EpochCleared(uint64 indexed epoch, int24 clearingTick);

    /// @notice Tighten (or loosen) the four settlement guards. Admin-only, and deliberately NOT a
    ///         `settle` argument: settlement is permissionless, so anything a caller could pass would be
    ///         a bound the caller chose for themselves.
    function setSettlementGuards(
        uint32 _shortTwapWindow,
        uint32 _maxOracleStaleness,
        int24 _maxClearingJumpTicks,
        uint128 _minSettleLiquidity
    ) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        // A short window longer than the anchor's own window is not a freshness reference, it is a
        // second opinion from further in the past. Zero is legal and means "use the derived default".
        if (_shortTwapWindow > twapWindow) revert BadGuardParams();
        if (_maxClearingJumpTicks < 0) revert BadGuardParams();
        shortTwapWindow = _shortTwapWindow;
        maxOracleStaleness = _maxOracleStaleness;
        maxClearingJumpTicks = _maxClearingJumpTicks;
        minSettleLiquidity = _minSettleLiquidity;
        emit SettlementGuardsSet(_shortTwapWindow, _maxOracleStaleness, _maxClearingJumpTicks, _minSettleLiquidity);
    }

    function effectiveShortTwapWindow() public view returns (uint32 w) {
        w = shortTwapWindow;
        if (w != 0) return w;
        w = 60;
        if (w > twapWindow) w = twapWindow;
    }

    function effectiveMaxOracleStaleness() public view returns (uint256) {
        uint32 s = maxOracleStaleness;
        if (s != 0) return uint256(s);
        return uint256(twapWindow) + 4 * uint256(maxEpochLife);
    }

    function effectiveMaxClearingJumpTicks() public view returns (int256 j) {
        j = int256(maxClearingJumpTicks);
        if (j != 0) return j;
        j = int256(maxTwapDeviationTicks) * 8;
        if (j > int256(TickMath.MAX_TICK)) j = int256(TickMath.MAX_TICK);
    }

    function effectiveMinSettleLiquidity() public view returns (uint128) {
        uint128 m = minSettleLiquidity;
        return m == 0 ? 1 : m;
    }

    /// @notice How far this settlement's clearing tick may sit from the recorded anchor, RIGHT NOW.
    ///
    /// @dev THE BAND IS A DRIFT BUDGET, NOT A FENCE, AND A BUDGET HAS TO ACCRUE.
    ///
    ///      `effectiveMaxClearingJumpTicks` is calibrated for ONE batch: "the market does not move this
    ///      far between two consecutive clearings". Applied to an anchor of any age it stops being that
    ///      claim and becomes "the market has not moved this far since some unspecified day", which
    ///      ordinary drift falsifies eventually — and, because the anchor can only advance through a
    ///      settlement that itself passes this check, falsifying it once used to end settlement PERMANENTLY.
    ///      A guard whose failure mode is "this queue never settles again" is not a safety property.
    ///
    ///      So the same band is spent per `_anchorGrace()` of silence: full band while the anchor is
    ///      younger than one grace, two bands at one grace, three at two, and so on, until the allowance
    ///      reaches the widest jump the tick range itself admits, at which point the anchor constrains
    ///      nothing at all. That last state is the correct one for a price nobody has quoted in days: an
    ///      anchor from three weeks ago says NOTHING about whether today's honest price was manufactured,
    ///      and pretending otherwise is what bricked settlement.
    ///
    ///      WHY LINEAR AND NOT A CLIFF. A cliff ("ignore the anchor once it is older than X") answers the
    ///      brick but leaves a discontinuity an attacker can sit just inside, and it throws away a
    ///      one-hour-old anchor's real evidentiary value wholesale. Growing with elapsed time keeps the
    ///      RATE the base band already asserts — this much movement per epoch life is normal — constant,
    ///      which is the only thing the base number was ever evidence for.
    ///
    ///      WHAT IT STILL REFUSES. In normal operation (a batch every epoch) the allowance is one to two
    ///      bands, so the 20,000-tick excursion the jump guard exists for is refused exactly as before,
    ///      and `test_maxJumpGuard_refusesAClearingNineteenThousandNineHundredTicksFromTheLast` still
    ///      proves it. The settler's remaining lever — waiting for a wider allowance — is bounded by
    ///      `SettleWindowClosed` at `2 * maxEpochLife` past the cutoff, i.e. two extra bands, and every
    ///      other settlement guard (short-TWAP drift, spot drift, depth, oracle staleness) binds at the
    ///      moment they finally settle regardless.
    ///
    ///      NOT AN ADMIN RE-ANCHOR. Adding one would fix the brick and leave the root key as the recovery
    ///      path for an ORDINARY MARKET MOVE, which is the wrong shape for a permissionless settlement
    ///      that fails closed on real money: recovery from a market doing market things must not require a
    ///      human. It would also hand the admin a lever to narrow the guard's evidence at will.
    function clearingJumpAllowance() public view returns (int256) {
        int256 base = effectiveMaxClearingJumpTicks();

        // The widest jump the tick range can express. Beyond this the comparison is vacuous by
        // construction, so saturating here is what makes "the anchor eventually stops binding" a fact
        // about the arithmetic rather than a hope about the numbers.
        int256 widest = int256(TickMath.MAX_TICK) - int256(TickMath.MIN_TICK);

        uint256 stampedAt = uint256(lastClearingAt);
        uint256 elapsed = block.timestamp > stampedAt ? block.timestamp - stampedAt : 0;

        // `base` is non-negative (`setSettlementGuards` refuses a negative and the derived default is
        // positive), it is at most MAX_TICK, and `elapsed` is a timestamp, so the product is nowhere near
        // overflowing. `_anchorGrace()` is non-zero by `initialize`, so this cannot divide by zero.
        uint256 allowance = uint256(base) + (uint256(base) * elapsed) / _anchorGrace();
        return allowance >= uint256(widest) ? widest : int256(allowance);
    }

    /// @dev How long an anchor is worth one full band. `maxEpochLife` is this contract's existing answer to
    ///      "how long is a batch relevant for" — it bounds the settle window and the timeout — so an anchor
    ///      older than one of them is older than the entire lifetime of the batch it would constrain.
    ///      Non-zero for every queue that can exist: `initialize` requires `maxEpochLife > freezeDuration`
    ///      and `freezeDuration != 0`. Deliberately NOT a new admin knob: a knob here is a number nobody
    ///      can calibrate whose wrong values are exactly the two failure modes this fix is about.
    function _anchorGrace() private view returns (uint256) {
        return uint256(maxEpochLife);
    }

    /* ------------------------------------------------------------------ entry */

    /// @notice Queue an intent to sell `amountIn` of one side for the other, at the epoch's clearing rate.
    function place(bool zeroForOne, uint128 amountIn) external returns (uint256 index) {
        if (amountIn == 0) revert ZeroAmount();
        uint64 e = currentEpoch;
        if (_phase(e) != Phase.Open) revert WrongPhase();

        Currency cIn = zeroForOne ? key.currency0 : key.currency1;

        // H-2 / F-03: CREDIT WHAT ARRIVED, NOT WHAT WAS DECLARED. The escrow ledger is this contract's
        // own bookkeeping and never touches a v4 delta that could refuse to balance, so it was the one
        // place in the system that failed OPEN. A currency whose `transferFrom` returns success without
        // moving anything — address(0), a codeless account, a blacklisting or pausable token on its
        // silent path — used to mint escrow out of nothing, and because ONE commingled balance backs
        // EVERY live epoch, the forged claim is paid out of some other epoch's deposits. Measuring the
        // balance either side of the pull makes the ledger say what the contract actually holds; the
        // same measurement also stops a fee-on-transfer currency over-stating the pot.
        uint256 balBefore = _balanceOfSelf(cIn);
        _pull(cIn, msg.sender, amountIn);
        uint256 received = _balanceOfSelf(cIn) - balBefore;
        if (received == 0) revert EscrowNotReceived();
        // Never credit MORE than was asked for: a donation into the contract between the two reads, or a
        // positively-rebasing currency, is not this order's money.
        uint128 credited = received < uint256(amountIn) ? uint128(received) : amountIn;

        index = orders[e].length;
        orders[e].push(Order({owner: msg.sender, zeroForOne: zeroForOne, amountIn: credited, withdrawn: false}));
        Epoch storage ep = epochs[e];
        if (zeroForOne) ep.totalIn0 += credited;
        else ep.totalIn1 += credited;

        emit OrderPlaced(e, index, msg.sender, zeroForOne, credited);
    }

    /// @notice Take an order back. Free, permissionless, and only before the freeze.
    /// @dev The cutoff is the whole defence. Without it: queue big on the scarce side so the batch looks
    ///      balanced, cancel at the last moment, and force everyone else through the pool at a worse
    ///      price. With it, what settlement executes is fixed before anyone can know the outcome.
    function cancel(uint64 e, uint256 index) external {
        if (_phase(e) != Phase.Open) revert WrongPhase();
        Order storage o = orders[e][index];
        if (o.owner != msg.sender) revert NotOrderOwner();
        if (o.withdrawn) revert AlreadyWithdrawn();

        o.withdrawn = true;
        Epoch storage ep = epochs[e];
        if (o.zeroForOne) ep.totalIn0 -= o.amountIn;
        else ep.totalIn1 -= o.amountIn;

        _push(o.zeroForOne ? key.currency0 : key.currency1, o.owner, o.amountIn);
        emit OrderCancelled(e, index, msg.sender);
    }

    /* ------------------------------------------------------------- settlement */

    /// @notice Freeze the current epoch and open the next one. Permissionless.
    function freeze() external {
        uint64 e = currentEpoch;
        if (block.timestamp < uint256(epochStartedAt) + epochDuration) revert TooEarly();
        if (epochs[e].phase != Phase.Open) revert WrongPhase();

        epochs[e].phase = Phase.Frozen;
        // THE SCHEDULED CUTOFF, NOT THE BUTTON PRESS. `freeze` is permissionless and nobody is obliged
        // to call it promptly. Stamping `block.timestamp` here meant a LATE freeze restarted the timeout
        // clock, so the total time escrow could be locked was unbounded — the longer everyone forgot,
        // the longer everyone waited for the escape hatch. Anchoring to the moment the epoch actually
        // closed makes lateness cost nothing.
        epochs[e].frozenAt = uint64(uint256(epochStartedAt) + epochDuration);
        frozenCallAt[e] = uint64(block.timestamp);
        currentEpoch = e + 1;
        epochStartedAt = uint64(block.timestamp);
        emit EpochFrozen(e);
    }

    /// @notice Cross the two sides at TWAP and push only the residual through the pool. Permissionless —
    ///         anyone may settle, because a settlement that only one party can trigger is a settlement
    ///         that stops happening the day that party stops caring.
    function settle(uint64 e) external {
        Epoch storage ep = epochs[e];
        if (ep.phase != Phase.Frozen) revert WrongPhase();
        // F-05: THE DELAY RUNS FROM WHICHEVER CAME LATER, the scheduled cutoff or the freeze that
        // actually happened. `freeze()` backdates `frozenAt` to the cutoff, so anchoring the wait there
        // meant a freeze later than `freezeDuration` left NO wait at all — `freeze(e); settle(e);` fit in
        // one transaction and the settler picked the exact block, and therefore the exact price, the batch
        // was measured against. `frozenCallAt` is zero for any epoch frozen before it existed, and the
        // cutoff wins that comparison, so pre-upgrade epochs behave exactly as they did.
        uint256 delayFrom = frozenCallAt[e] > ep.frozenAt ? frozenCallAt[e] : ep.frozenAt;
        if (block.timestamp < delayFrom + freezeDuration) revert TooEarly();
        // F-04, THE SECOND HALF: THE SETTLER MUST NOT GET TO PICK THE MOMENT. `settle` had a lower time
        // bound and no upper one, so a Frozen epoch nobody timed out stayed settleable forever and the
        // caller could wait for whichever hour paid them best. Past this bound the epoch's only remaining
        // resolution is `timeout`, which returns every deposit in kind at no loss — the same fail-closed
        // answer the rest of the contract gives when it cannot price something safely.
        if (block.timestamp > uint256(ep.frozenAt) + 2 * uint256(maxEpochLife)) revert SettleWindowClosed();
        if (ep.totalIn0 == 0 && ep.totalIn1 == 0) revert NothingToSettle();

        // THE ANCHOR IS THE TWAP, NEVER SPOT. Spot is whatever the last trade left behind and an
        // ordering-privileged party sets it for free; crossing there would let the sequencer price every
        // batch. `consult` fails CLOSED — it reverts rather than answering from an under-covered ring —
        // so an oracle that cannot support the window stops settlement instead of mispricing it.
        int24 tick = oracle.consult(key.toId(), twapWindow);

        _requireAnchorIsFresh(tick);
        _requireTheMarketCanBackThisPrice(tick);

        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        // price = (sqrtP / 2^96)^2, applied in two steps so nothing overflows.
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);

        // How much of side 0 the side-1 escrow can absorb at that price, and vice versa.
        uint256 want0 = FullMath.mulDiv(ep.totalIn1, FixedPoint96.Q96, priceX96); // token0 the 1-sellers buy
        uint128 crossed0 = uint128(ep.totalIn0 < want0 ? ep.totalIn0 : want0);

        // F-01, PART ONE: THE FULLY ABSORBED SIDE CROSSES IN FULL — NEVER RE-FLOORED.
        //
        // `want0` is already `floor(totalIn1 * Q96 / priceX96)`. Converting it BACK with
        // `crossed1 = floor(crossed0 * priceX96 / Q96)` floors an already-floored number, and whenever
        // side 1 is the absorbed one — which includes the perfectly balanced case — the round trip comes
        // back one raw unit short. The epoch then reported a PHANTOM one-unit residual on a side that by
        // definition had nothing left over, that crumb was submitted to the pool as a real exact-input
        // swap, the LP fee truncated it to zero output, the residual bound fired on the zero fill, and
        // the whole settlement reverted — the large legitimate residual on the other side included, and
        // the crossed portion that needed no pool at all. That is the live 2026-08-07 revert, and one
        // raw unit on the light side was enough for anyone to manufacture it on demand.
        //
        // The sub-unit remainder is part of the MATCH, not a leftover: it is worth strictly less than one
        // raw unit of currency0, which is the granularity these two sides can trade in at all. So the
        // absorbed side crosses whole and the flooring loss stays with it, exactly as the flooring loss
        // in the mirrored branch stays with side 0.
        //
        // THE `crossed0 == 0` GUARD IS NOT DEFENSIVE, IT IS THE OTHER HALF OF THE FIX. `want0` floors to
        // zero whenever the whole currency1 escrow buys less than one raw unit of currency0 — a sub-unit
        // order in a pool where currency0 is the dear side. "Side 1 is absorbed, cross it in full" would
        // then hand that entire escrow to the currency0 side in exchange for NOTHING, and book it no
        // refund either, leaving it unreachable by every exit for ever. Nothing crossed, so nothing
        // crosses: the escrow stays a residual and takes the ordinary residual path.
        //
        // AND THE SAME GUARD ON THE OTHER BRANCH, WHICH IS THE ONE THAT CAN ACTUALLY FIRE HERE. The
        // `crossed0 == 0` test above is DEAD CODE on any pool where `priceX96 < Q96` — i.e. wherever
        // currency1 is the dearer raw unit, which is the live WETH/USDG pool at tick -200461 — because
        // `want0 = mulDiv(totalIn1, Q96, priceX96)` is then at least `totalIn1`, so it cannot floor to
        // zero while side 1 holds anything at all. On exactly those pools the MIRRORED failure is
        // reachable instead, and it was unguarded: in this branch `crossed0 == totalIn0`, so
        // `residual0` is zero by construction, and when `crossed0 * price` floors away the whole of
        // side 0's escrow crosses for NOTHING, is booked no refund, and is paid out to the currency1
        // sellers as part of `out1`. `claim` then pays that owner zero and burns their one-shot flag —
        // the "unreachable by every exit for ever" outcome named in the paragraph above, arrived at
        // from the other side. The two branches are one property and they get one answer: nothing
        // crossed, so nothing crosses, and the escrow takes the ordinary in-kind residual path.
        uint128 crossed1;
        if (uint256(ep.totalIn0) >= want0) {
            crossed1 = crossed0 == 0 ? 0 : ep.totalIn1;
        } else {
            crossed1 = uint128(FullMath.mulDiv(crossed0, priceX96, FixedPoint96.Q96));
            if (crossed1 == 0) crossed0 = 0;
        }

        // Whatever did not cross goes through the pool as ONE aggregated swap. One swap for the whole
        // epoch is the other half of the saving: N users pay one lot of slippage between them, not N.
        uint128 residual0 = ep.totalIn0 - crossed0;
        uint128 residual1 = ep.totalIn1 - crossed1;

        // Q-3: THE CROSSED PORTION MUST NOT BE HELD HOSTAGE BY THE RESIDUAL. The residual bound is
        // simultaneously an anti-sandwich guard and, unavoidably, a cap on how big a one-sided epoch may
        // get relative to pool depth — a batch's own honest price impact is indistinguishable from an
        // attacker's. Nothing can enforce that cap at `place()` time: the residual depends on orders that
        // have not arrived yet, and a v4 swap cannot be simulated in a view. So the whole batch used to
        // fail, wait out `maxEpochLife` and refund EVERYTHING unswapped — including the crossed portion,
        // which needs no pool at all and was already priced at the TWAP. The bigger the batch, the more
        // it was worth netting, and the likelier it could not settle. That is backwards.
        //
        // So: attempt the residual, and if it cannot be executed within its bound, hand the UNMATCHED
        // remainder back in kind and settle the matched part anyway. The bounds now live inside the
        // unlock callback so a breach reverts the callback, which rolls the pool back atomically, leaving
        // this frame free to take the in-kind path with nothing half-done.
        //
        // THE FALLBACK IS DEADLINE-GATED, and that gate is load-bearing. Made available immediately, a
        // single sandwich in the settle block would permanently convert that epoch's residual into a
        // refund — the attacker denies the trade for the price of one round trip, irreversibly. Before
        // the deadline settlement stays STRICT and simply reverts, so an honest settler can retry once
        // the price recovers. Only once the epoch is out of time does the batch resolve regardless.
        bool lenient = block.timestamp >= uint256(ep.frozenAt) + maxEpochLife;

        // F-01, PART TWO: A RESIDUAL THE POOL CANNOT EXECUTE NEVER REACHES THE POOL. See `_splitResidual`
        // for the floor itself. The fair outputs handed in are the SAME two numbers `unlockCallback`
        // measures its bound against, computed here from the same anchor, so the question asked is
        // exactly "can this leg clear the bound it is about to be held to".
        (uint128 swapIn0, uint128 dust0) =
            _splitResidual(residual0, FullMath.mulDiv(residual0, priceX96, FixedPoint96.Q96));
        (uint128 swapIn1, uint128 dust1) =
            _splitResidual(residual1, FullMath.mulDiv(residual1, FixedPoint96.Q96, priceX96));

        (uint128 swapOut1, uint128 swapOut0, bool refunded) = _settleResidual(swapIn0, swapIn1, priceX96, lenient);

        // Did this batch reach the market at all? Answered here, while both residual legs are still in
        // hand, and consumed at the very end by the anchor write. `_splitResidual` has already zeroed a
        // leg that was dust, and `refunded` means the whole residual came back in kind at the deadline —
        // so this is true exactly when real tokens changed hands in the pool at this tick.
        bool tradedAtThePool = !refunded && (swapIn0 != 0 || swapIn1 != 0);

        // Two ways a residual comes back in kind, and they compose. `refunded` means the bound-breaching
        // fallback fired at the deadline and the WHOLE residual is coming back; otherwise only the dust
        // legs are, and the rest was swapped. Booking `dust` on the `refunded` path too would double
        // count, because `residual` already contains it.
        uint128 back0 = refunded ? residual0 : dust0;
        uint128 back1 = refunded ? residual1 : dust1;
        if (back0 != 0 || back1 != 0) {
            ep.refund0 = back0;
            ep.refund1 = back1;
            emit ResidualRefunded(e, back0, back1);
        }

        // Uniform per side: crossed at TWAP plus residual at whatever the single swap achieved.
        ep.out0 = crossed1 + swapOut1; // total currency1 owed to currency0 sellers
        ep.out1 = crossed0 + swapOut0; // total currency0 owed to currency1 sellers
        ep.phase = Phase.Settled;

        // The anchor this batch actually cleared at, recorded so the NEXT one can be measured against it,
        // TOGETHER WITH THE MOMENT it happened — the tick is only evidence for as long as the timestamp
        // says it is, so recording one without the other is what made the guard un-ageable.
        // Written only once the epoch has resolved, so a settlement that reverted for any reason leaves
        // the chain of clearing prices untouched.
        //
        // AND ONLY IF THIS BATCH ACTUALLY TRANSACTED. Unconditionally, ONE RAW UNIT set the number every
        // later batch is measured against: a single dust order crosses nothing, is refunded to itself in
        // kind, never touches the pool — and still armed the guard, stamped it fresh, and (before the
        // aging above) bought permanent denial of settlement for one wei plus gas. An anchor is a claim
        // that this queue cleared a batch at this price; a batch that transacted nothing has no price to
        // claim. So the write asks for the same thing the rest of settlement asks for: either the two
        // sides crossed at least one meaningful unit against each other, or the residual reached the pool
        // — `_dustFloor` is the same line `_splitResidual` already draws, so "material" means one thing in
        // this contract rather than two.
        //
        // WHAT THIS DOES NOT CLAIM: the floor is the dust floor, not an economic bar. It stops the
        // one-wei arming named above, not a funded adversary. What makes that acceptable is the aging: a
        // deliberately-fresh anchor can only ever be written AT THE CURRENT HONEST TWAP (this settlement
        // had to pass every other guard to get here), and the band it pins widens back out on its own
        // within an epoch life. A notional floor would need a number nobody can calibrate, and set too
        // high it would stop the anchor ever updating — the guard switched off in silence, which is worse
        // than the thing it would fix.
        uint256 floorUnits = _dustFloor();
        if (tradedAtThePool || uint256(crossed0) >= floorUnits || uint256(crossed1) >= floorUnits) {
            lastClearingTick = tick;
            lastClearingAt = uint64(block.timestamp);
            clearingTickSet = true;
            emit EpochCleared(e, tick);
        }

        emit EpochSettled(e, tick, crossed0, crossed1);
    }

    /* ------------------------------------------------------- the settlement guards */

    /// @dev F-04. THE FRESHNESS REFERENCE MUST NOT BE A NUMBER THE SETTLER OWNS.
    ///
    ///      Q-2 was right about the danger and wrong about the instrument. It priced the cross at the
    ///      TWAP — provably immovable inside one transaction, because MoleHook advances the cumulative by
    ///      `elapsed * lastTick` and a swap sharing the settler's `block.timestamp` contributes EXACTLY
    ///      ZERO seconds — and then gated that price on `slot0`, which is the last trade and nothing more.
    ///      Every input to the guard was therefore free for the settler to set, and the guard did not
    ///      merely fail to protect: it handed out a MONOPOLY. When the market genuinely moved past the
    ///      band, honest settlement reverted and only someone willing to push spot back toward the stale
    ///      TWAP could settle at all — swap in, settle the whole batch at the stale price, swap out, all
    ///      in one transaction, with the counterparties unable to cancel because the cutoff had passed.
    ///      Tightening `maxTwapDeviationTicks` made it worse, not better: it only told the attacker how
    ///      close to the anchor to push. This is the Arrakis shape — a bound anchored to a price the
    ///      attacker can move is not a bound.
    ///
    ///      So the reference now comes from the SAME oracle over a SHORTER window. A short TWAP still
    ///      reacts to a real market move within a minute or so, which is all the guard ever needed, but a
    ///      same-transaction swap contributes zero seconds to it exactly as it does to the long one — so
    ///      moving it costs the attacker a position held across blocks, at real risk, which is the price
    ///      the guard is supposed to charge.
    ///
    ///      AND THE ANCHOR MUST BE BACKED BY SOMETHING. `consult` extends the cumulative past the newest
    ///      observation with the tick in force since it, so a pool seeded a month ago and never traded
    ///      answers every window confidently with its seeding tick. Both TWAPs then agree perfectly, drift
    ///      reads zero, and the batch clears against a fossil. The two checks are one property: the
    ///      anchor must be recent AND corroborated.
    ///
    ///      ------------------------------------------------------------------------------------------
    ///      THE QUIET POOL, AND WHY THREE GUARDS WERE ONE GUARD WEARING THREE HATS.
    ///
    ///      On a pool that has not traded inside the window, `consult` takes its quiet-tail path and
    ///      returns EXACTLY `lastTick` for EVERY window. That is not a bug in `consult` — with the tick
    ///      constant across the whole window `lastTick` IS the arithmetic mean — but it is fatal here,
    ///      because settlement then reads ONE number through three different names:
    ///        - `consult(twapWindow)`       -> lastTick   (the clearing anchor)
    ///        - `consult(shortTwapWindow)`  -> lastTick   (the drift reference, below)
    ///        - `slot0.tick`                -> lastTick   (the spot band, in `_requireTheMarketCanBackThisPrice`)
    ///      so the short-vs-long drift and the spot-vs-long drift both compute ZERO BY CONSTRUCTION and
    ///      cannot fire however old the price is. Two of the three guards are decoration on such a pool,
    ///      and the whole defence collapses onto whatever measures AGE.
    ///
    ///      WHICH IS WHY THE AGE MEASUREMENT HAD TO CHANGE. It read `poolStates(id).lastObsTimestamp` —
    ///      the last RING WRITE — and `MoleHook._write` stamps that on ANY swap past
    ///      `minObservationInterval`, regardless of size and regardless of whether the tick moved. ONE RAW
    ///      UNIT qualifies, and the cumulative it writes advances by `elapsed * lastTick`: it carries the
    ///      fossil tick forward and adds no information at all. So the entire remaining defence was a
    ///      heartbeat the attacker could restart from inside the settling transaction.
    ///
    ///      THE ATTACK THAT BOUGHT: queue on the side the fossil price favours; wait for the freeze, after
    ///      which nobody can cancel BY DESIGN; then in ONE transaction swap one raw unit and call `settle`
    ///      (permissionless). Every guard passed and the batch crossed at a price the pool had not quoted
    ///      for days. If the fossil never favoured them they simply never settled — the epoch times out
    ///      and they reclaim in kind at zero cost. A free option on the whole batch, exercised after
    ///      seeing the market. `minSettleLiquidity` is no obstacle either: with `restrictedLiquidity`
    ///      FALSE on the live RH hook the attacker mints the required depth at the target tick themselves.
    ///
    ///      WHAT IS ASKED NOW: `MoleHook.consultEvidence(id, twapWindow).quietSpan` — the widest stretch
    ///      of time the anchor rests on in which this pool recorded NOTHING, measured across the window
    ///      and across the bracket its left edge was interpolated over, unclipped. The dust swap adds one
    ///      recorded point at `now` and leaves the month behind it exactly as empty; the month is what
    ///      gets reported. The bound is the SAME dial, `maxOracleStaleness`, in the same units and with
    ///      the same error — the dial was never wrong, it was pointed at the wrong clock.
    ///
    ///      ------------------------------------------------------------------------------------------
    ///      THE RESIDUAL, STATED PLAINLY RATHER THAN PAPERED OVER.
    ///
    ///      THIS DOES NOT CLOSE THE HOLE. It prices it. `quietSpan` proves that trades HAPPENED; nothing
    ///      in this pool can prove they were ARM'S LENGTH. A party willing to wash-trade its own pool on a
    ///      schedule — one dust swap per `maxOracleStaleness` seconds, at the fossil tick, against its own
    ///      liquidity — holds `quietSpan` arbitrarily low and every guard above still passes. What changed
    ///      is the shape of the cost: from one byte appended to the exploit transaction, free and
    ///      invisible until it lands, to a public commitment maintained across blocks for the whole life
    ///      of the window, which an honest counterparty can watch and which the operator can make
    ///      arbitrarily expensive by tightening `maxOracleStaleness`. That is a real change and it is not
    ///      a fix.
    ///
    ///      THE ACTUAL FIX IS A PRICE THIS POOL DOES NOT PRODUCE. Every number reachable from here is
    ///      derived from the same tick, so no arrangement of them can corroborate that tick; a pool nobody
    ///      trades has no honest price and no amount of self-referential guarding invents one. Crossing a
    ///      batch that its participants cannot cancel requires an INDEPENDENT anchor — a second venue, a
    ///      signed feed, anything not written by the party who benefits — and until one exists the honest
    ///      operating posture for a thin pool is a `maxOracleStaleness` short enough that the manufactured
    ///      heartbeat costs more than the batch is worth, accepting that settlement then halts whenever
    ///      the market is genuinely quiet. Halting is safe: the epoch times out and every deposit comes
    ///      back in kind, at no loss, to everyone.
    function _requireAnchorIsFresh(int24 tick) private view {
        PoolId id = key.toId();

        // Only the AGE is asked here. Whether the oracle knows this pool at all was already settled by
        // the `consult` above, which reverts `PoolNotInitialized()` on an unseeded pool — a check here
        // would be one no test could ever turn red, and it would report the problem under a worse name.
        //
        // AND THE AGE IS MEASURED ON THE ANCHOR'S OWN WINDOW, NOT ON A HEARTBEAT. `quietSpan` is the
        // widest stretch of time the answer to `consult(twapWindow)` rests on in which this pool recorded
        // NOTHING — including, unclipped, the bracket its left edge was interpolated across. A dust swap
        // adds one recorded point and leaves that stretch exactly as empty as it found it.
        (uint32 quietSpan,) = oracle.consultEvidence(id, twapWindow);
        // No rollover branch is needed or wanted here: `consultEvidence` does its subtraction in uint32
        // exactly as `MoleHook._write` does, which is correct modulo 2^32 and cannot read a negative age
        // as a fresh one. The old code needed the guard because it did the arithmetic itself.
        if (uint256(quietSpan) > effectiveMaxOracleStaleness()) revert OracleTooStale();

        int24 refTick = oracle.consult(id, effectiveShortTwapWindow());
        int24 drift = refTick > tick ? refTick - tick : tick - refTick;
        if (drift > maxTwapDeviationTicks) revert TwapTooFarFromSpot();
    }

    /// @dev THE PRICE MUST BE ONE THE POOL COULD ACTUALLY TRADE AT, and it must not be a cliff.
    ///
    ///      DEPTH. MolePositions already records what makes this reachable: with `restrictedLiquidity` on,
    ///      "a pool has regions of ZERO liquidity where a dust swap moves spot arbitrarily far for almost
    ///      nothing". Walk spot into such a region, wait for the TWAP to follow, and the batch clears at a
    ///      price that no liquidity has ever stood behind — the crossed portion never touches the pool, so
    ///      nothing else in settlement would notice.
    ///
    ///      AND THE DEPTH MUST BE MEASURED WHERE THE BATCH WOULD CLEAR, NOT WHERE SPOT HAPPENS TO SIT.
    ///      This read used to be `getLiquidity`, i.e. `pool.liquidity`, which is the liquidity active at
    ///      the CURRENT tick and nowhere else, paired with the spot band above on the theory that the band
    ///      pinned the measurement near the clearing tick. It does not, and the live book is the
    ///      counter-example: RH 4663's queue pool has exactly two initialized ticks, -201060 and -200460,
    ///      one position spanning them, spot resting at -200461 — ONE tick under the top. A one-for-zero
    ///      swap of about 1,140 raw USDG crosses -200460; v4 subtracts that position's `liquidityNet` and
    ///      `pool.liquidity` becomes exactly ZERO, while the clearing tick one tick below still has the
    ///      whole book standing under it. Every later `settle` then reverted `InsufficientPoolDepth` — and
    ///      the spot band could not see it, because a one-tick move is a drift of ONE against a band of
    ///      six hundred, and the attacker's own swap wrote a ring observation at `now` so the short anchor
    ///      followed it. Park the tick and walk away: every frozen epoch runs out its clock and resolves
    ///      through timeout. Permissionless, repeatable, indefinite, for a fraction of a cent — including
    ///      by a participant who has seen where the cross would land and wants out after the cutoff took
    ///      cancellation away. No principal moves, so the whole loss is the product.
    ///
    ///      A guard that a one-wei move of a number the settler does not even have to own can turn into a
    ///      permanent refusal is not a safety property; it is the kill switch wearing the safety
    ///      property's name. So the question is asked at the tick this batch will actually cross at:
    ///      `_liquidityActiveAt` starts from `pool.liquidity` and replays v4's OWN crossing arithmetic
    ///      — `+liquidityNet` walking up, `-liquidityNet` walking down, over the initialized ticks between
    ///      spot and the anchor — to produce the liquidity that would be in range AT the clearing tick.
    ///      Moving spot moves the START of that walk and the ticks it crosses in exactly compensating
    ///      amounts, so the answer is a function of the BOOK and the ANCHOR only. Neither is something the
    ///      settler can move inside one transaction: the book is other people's capital, and the anchor is
    ///      a TWAP that a same-block swap contributes exactly zero seconds to. The guard stops being
    ///      satisfiable — or defeatable — by putting spot somewhere.
    ///
    ///      This is a REPLACEMENT, not an addition. One depth read became one better-aimed depth read:
    ///      same dial (`minSettleLiquidity`), same revert, same fail-closed answer, no new state, no new
    ///      entry point. It is also strictly STRONGER against the attack the guard was built for — walking
    ///      the TWAP into a desert now fails because the DESERT is measured, where before an attacker who
    ///      had walked the TWAP into a desert could have stepped spot back onto a live band inside the
    ///      600-tick window and passed the old check with liquidity that stands nowhere near the price.
    ///
    ///      WHAT IT DOES NOT COVER, PLAINLY. It does not make anyone provide depth: if the market durably
    ///      leaves the vault's range the anchor follows, the clearing tick genuinely has nothing under it,
    ///      and settlement halts until liquidity exists there again — exactly as the old read halted, but
    ///      now only for a sustained TWAP-scale move instead of a one-block nudge. It does not ask whether
    ///      that depth is ARM'S LENGTH; on this pool one LP is the entire book, so "there is depth" means
    ///      "the vault is in range", not "an independent market agrees". It says nothing about how far the
    ///      residual swap pushes the price — that is `maxResidualSlippageBps`, inside the callback,
    ///      untouched. And its cost grows with the number of initialized ticks between spot and the
    ///      anchor, which the spot band above bounds to `maxTwapDeviationTicks / tickSpacing` BECAUSE it
    ///      runs first: on the live pool that is at most ten, on a spacing-1 pool with a very wide band it
    ///      would be hundreds, and an operator widening `maxTwapDeviationTicks` is widening this too.
    ///
    ///      JUMP. A clearing price twenty thousand ticks from the last one this queue cleared at is not a
    ///      market, it is an excursion — a manufactured one if someone stands to gain, a broken oracle if
    ///      not. Either way a batch whose participants cannot cancel is the wrong place to find out.
    ///      Refusing costs them nothing: the epoch times out and everyone reclaims in kind.
    function _requireTheMarketCanBackThisPrice(int24 tick) private view {
        PoolId id = key.toId();

        (, int24 spotTick,,) = StateLibrary.getSlot0(poolManager, id);
        int24 spotDrift = spotTick > tick ? spotTick - tick : tick - spotTick;
        if (spotDrift > maxTwapDeviationTicks) revert TwapTooFarFromSpot();

        if (_liquidityActiveAt(id, spotTick, tick) < effectiveMinSettleLiquidity()) {
            revert InsufficientPoolDepth();
        }

        if (clearingTickSet) {
            int256 jump = int256(tick) - int256(lastClearingTick);
            if (jump < 0) jump = -jump;
            // AGAINST THE AGED BAND, NOT THE RAW ONE. "The price did not LEAP since the last batch" is
            // evidence about manipulation only while "the last batch" was recent; an anchor from three
            // weeks ago is evidence about nothing, and measuring today's honest price against it is how a
            // guard that fails closed turns into a queue that never settles again. `clearingJumpAllowance`
            // carries the full defence.
            if (jump > clearingJumpAllowance()) revert ClearingJumpTooLarge();
        }
    }

    /// @dev THE LIQUIDITY THAT WOULD BE IN RANGE AT `target`, computed from the pool's own book.
    ///
    ///      `pool.liquidity` answers only about the tick the pool is sitting on. To ask about a different
    ///      tick there is exactly one honest method: replay what a swap to that tick would do to the
    ///      number. v4's `Pool.swap` adds `liquidityNet` when it crosses an initialized tick moving UP and
    ///      subtracts it moving DOWN, so the liquidity active at `target` is `pool.liquidity` plus the net
    ///      of every initialized tick in `(spot, target]` (walking up) or minus the net of every
    ///      initialized tick in `(target, spot]` (walking down). Those are the same half-open intervals
    ///      v4 itself crosses, which is why this cannot disagree with the pool about where a position
    ///      starts and stops: `tickUpper` is exclusive here for the same reason it is exclusive there.
    ///
    ///      THE WALK IS BOUNDED BY THE CHECK ABOVE IT, not by a cap of its own. `_requireTheMarketCanBack
    ///      ThisPrice` has already refused unless `|spot - target| <= maxTwapDeviationTicks`, so the
    ///      number of iterations cannot exceed that span divided by `tickSpacing`, and uninitialized
    ///      stretches are skipped a whole bitmap word at a time. A cap here would be a second refusal
    ///      reason for the same question and a second thing to get wrong; the ordering already carries it.
    ///
    ///      `addDelta` reverts on underflow, which is unreachable: a pool's active liquidity is
    ///      non-negative at every tick by construction, and this replays the pool's own arithmetic over
    ///      the pool's own ticks. Unreachable and fail-closed is the right way round for a settlement that
    ///      can always resolve through `timeout`.
    function _liquidityActiveAt(PoolId id, int24 spot, int24 target) private view returns (uint128 liq) {
        liq = StateLibrary.getLiquidity(poolManager, id);
        int24 spacing = key.tickSpacing;

        // One loop, both directions, because they are one property read in a mirror. `target == spot` is
        // the ordinary case and enters the loop zero times, so the common path costs exactly what the old
        // `getLiquidity` read cost.
        bool down = target < spot;
        int24 t = spot;
        while (down ? t > target : t < target) {
            (int24 next, bool init) = _nextInitializedTick(id, t, spacing, down);
            // Nothing initialized is left between here and `target`: `next` is either the nearest
            // initialized tick in this direction or the edge of its word, and either way it has overshot.
            if (down ? next <= target : next > target) break;
            if (init) {
                (, int128 net) = StateLibrary.getTickLiquidity(poolManager, id, next);
                // Crossing downward is the mirror of crossing upward, exactly as `Pool.swap` writes it.
                // `liquidityNet` cannot be `type(int128).min` — the per-tick liquidity cap is far below
                // it — so the negation is not a reachable revert.
                liq = LiquidityMath.addDelta(liq, down ? -net : net);
            }
            // Downward, v4 lands on `tickNext - 1`; upward it lands on `tickNext`. Same step, same reason:
            // the tick just crossed must not be considered twice.
            t = down ? next - 1 : next;
        }
    }

    /// @dev `TickBitmap.nextInitializedTickWithinOneWord`, against a bitmap word that lives in the
    ///      PoolManager rather than in this contract's storage. The bit arithmetic is copied from v4-core
    ///      unchanged and deliberately so: a walk that indexed the book differently from the pool would
    ///      answer a question about a book that does not exist. Only the word fetch differs — `extsload`
    ///      through `StateLibrary` instead of a `mapping` this contract does not own.
    function _nextInitializedTick(PoolId id, int24 tick, int24 spacing, bool lte)
        private
        view
        returns (int24 next, bool initialized)
    {
        unchecked {
            int24 compressed = TickBitmap.compress(tick, spacing);

            if (lte) {
                (int16 wordPos, uint8 bitPos) = TickBitmap.position(compressed);
                uint256 mask = type(uint256).max >> (uint256(type(uint8).max) - bitPos);
                uint256 masked = StateLibrary.getTickBitmap(poolManager, id, wordPos) & mask;

                initialized = masked != 0;
                next = initialized
                    ? (compressed - int24(uint24(bitPos - BitMath.mostSignificantBit(masked)))) * spacing
                    : (compressed - int24(uint24(bitPos))) * spacing;
            } else {
                (int16 wordPos, uint8 bitPos) = TickBitmap.position(++compressed);
                uint256 mask = ~((1 << bitPos) - 1);
                uint256 masked = StateLibrary.getTickBitmap(poolManager, id, wordPos) & mask;

                initialized = masked != 0;
                next = initialized
                    ? (compressed + int24(uint24(BitMath.leastSignificantBit(masked) - bitPos))) * spacing
                    : (compressed + int24(uint24(type(uint8).max - bitPos))) * spacing;
            }
        }
    }

    /// @notice Anyone may time out an epoch that was frozen and never settled. Escrow becomes reclaimable
    ///         in full, in kind, with no price applied and no permission needed.
    function timeout(uint64 e) external {
        Epoch storage ep = epochs[e];

        // A NEVER-FROZEN EPOCH MUST BE TIMEOUTABLE TOO, and this branch is not a convenience. Past its
        // duration an open epoch stops accepting cancels — `_phase` reports Frozen on the clock alone, so
        // the cutoff never depends on somebody pressing a button. But `timeout` required the STORED phase
        // to be Frozen, which only `freeze()` sets. Between those two moments escrow had NO exit at all:
        // cancel refused, timeout refused, settle refused, claim refused. An adversarial test held real
        // money in that state for three full epoch lifetimes.
        if (ep.phase == Phase.Open) {
            // Only the current epoch can still be stored Open; older ones were frozen on the way past.
            if (e != currentEpoch) revert WrongPhase();
            if (block.timestamp < uint256(epochStartedAt) + epochDuration + maxEpochLife) revert NotTimedOut();
            ep.phase = Phase.Refunding;
            // Move on, so an abandoned epoch is not also the one still taking new orders.
            currentEpoch = e + 1;
            epochStartedAt = uint64(block.timestamp);
            emit EpochTimedOut(e);
            return;
        }

        if (ep.phase != Phase.Frozen) revert WrongPhase();
        // F-06: THE DEADLINE FALLBACK NEEDS A WINDOW OF ITS OWN. Lenient `settle` unlocks at
        // `frozenAt + maxEpochLife`; while this door unlocked on the SAME second, the set of moments at
        // which the fallback could run and settle could not was EMPTY — so any participant who disliked
        // the cross could veto a settleable batch by calling `timeout` first, and the crossed portion,
        // which needs no pool and was already priced, simply never happened. Whoever the sequencer
        // orders first decides, which is not entitlement. `freezeDuration` is already required non-zero
        // by `initialize`, so reusing it needs no new parameter, and the escrow's hold stays BOUNDED: a
        // frozen epoch is reclaimable at `frozenAt + maxEpochLife + freezeDuration` at the latest. It
        // defers the race rather than closing it — if nobody settles inside the window both doors are
        // open again — but a fallback with a window is the thing the deadline gate was for.
        if (block.timestamp < uint256(ep.frozenAt) + maxEpochLife + freezeDuration) revert NotTimedOut();
        ep.phase = Phase.Refunding;
        emit EpochTimedOut(e);
    }

    /* ---------------------------------------------------------------- payout */

    /// @notice Take what an order earned, or take the escrow back if the epoch timed out.
    /// @dev Per-order and independent: one participant's claim can never be blocked by another's, and a
    ///      claim that fails for one order leaves every other order untouched.
    /// @return amountOut the OUTPUT-token leg — what the order was bought. A settled epoch whose residual
    ///         was returned in kind (Q-3) also pays a second, input-token leg in the same call; read it
    ///         with `refundOf` or from the `Claimed` event. One return value is kept because a tuple here
    ///         would make `claim` unusable inside an expression, and the second leg is derivable.
    function claim(uint64 e, uint256 index) external returns (uint256 amountOut) {
        uint256 refunded;
        Epoch storage ep = epochs[e];
        Order storage o = orders[e][index];
        if (o.owner != msg.sender) revert NotOrderOwner();
        if (o.withdrawn) revert AlreadyWithdrawn();
        o.withdrawn = true;

        if (ep.phase == Phase.Refunding) {
            // IN KIND, exactly what was escrowed. No price is applied to a batch that never cleared.
            amountOut = o.amountIn;
            _push(o.zeroForOne ? key.currency0 : key.currency1, o.owner, amountOut);
        } else if (ep.phase == Phase.Settled) {
            // Pro-rata of the side's total output — the uniform price, expressed as a share.
            //
            // Q-3: A SETTLED EPOCH CAN OWE TWO TOKENS. When the residual could not be executed within its
            // bound by the deadline, `settle` cleared the matched part at the TWAP and booked the
            // unmatched part for return in kind. Both are the same order's money, so both are paid here,
            // on the same one-shot flag — never in two withdrawals that could disagree about it.
            // `refunded` stays zero on the ordinary path, where it costs one cold read of a slot the
            // epoch never wrote.
            if (o.zeroForOne) {
                amountOut = FullMath.mulDiv(ep.out0, o.amountIn, ep.totalIn0);
                _push(key.currency1, o.owner, amountOut);
                if (ep.refund0 != 0) {
                    refunded = FullMath.mulDiv(ep.refund0, o.amountIn, ep.totalIn0);
                    _push(key.currency0, o.owner, refunded);
                }
            } else {
                amountOut = FullMath.mulDiv(ep.out1, o.amountIn, ep.totalIn1);
                _push(key.currency0, o.owner, amountOut);
                if (ep.refund1 != 0) {
                    refunded = FullMath.mulDiv(ep.refund1, o.amountIn, ep.totalIn1);
                    _push(key.currency1, o.owner, refunded);
                }
            }
        } else {
            revert WrongPhase();
        }

        emit Claimed(e, index, o.owner, amountOut, refunded);
    }

    /* --------------------------------------------------------------- views */

    /// @notice The in-kind leg an order is entitled to: its pro-rata share of whatever part of its side
    ///         `settle` could not swap and booked for return (Q-3). Zero on an ordinary settlement.
    /// @dev An ENTITLEMENT, not a pending balance — it reads the same before and after the order is
    ///      claimed, because it is derived from the epoch totals rather than from the withdrawn flag.
    ///      Pair it with `orders(e, index).withdrawn` to tell "owed" from "already paid".
    function refundOf(uint64 e, uint256 index) external view returns (uint256) {
        Epoch storage ep = epochs[e];
        // Redundant, and mutation testing proved it: `refund0`/`refund1` are written in exactly one place,
        // `settle`, which sets Settled in the same breath — so they are zero in every other phase and this
        // returns zero anyway. Kept as a statement of intent for a reader deciding what this view means
        // before an epoch resolves.
        if (ep.phase != Phase.Settled) return 0;
        Order storage o = orders[e][index];
        if (o.zeroForOne) {
            return ep.refund0 == 0 ? 0 : FullMath.mulDiv(ep.refund0, o.amountIn, ep.totalIn0);
        }
        return ep.refund1 == 0 ? 0 : FullMath.mulDiv(ep.refund1, o.amountIn, ep.totalIn1);
    }

    function phaseOf(uint64 e) external view returns (Phase) {
        return _phase(e);
    }

    function orderCount(uint64 e) external view returns (uint256) {
        return orders[e].length;
    }

    function _phase(uint64 e) internal view returns (Phase) {
        Epoch storage ep = epochs[e];
        if (ep.phase != Phase.Open) return ep.phase;
        // An epoch past its duration is closed to new orders and to cancels even before `freeze()` is
        // called, so the cutoff does not depend on somebody remembering to press a button.
        if (e == currentEpoch && block.timestamp >= uint256(epochStartedAt) + epochDuration) {
            return Phase.Frozen;
        }
        if (e != currentEpoch) return Phase.Frozen;
        return Phase.Open;
    }

    /* ------------------------------------------------------------ pool plumbing */

    /// @dev F-01, PART TWO. Split one residual leg into the part the pool can actually execute and the
    ///      part that has to go back to its owners in kind.
    ///
    ///      THE FLOOR IS NOT A TASTE, IT IS `unlockCallback`'S OWN ARITHMETIC READ BACKWARDS. That bound
    ///      demands `out >= floor(fairOut * (10_000 - bps) / 10_000)`, i.e. it tolerates a shortfall of
    ///      `fairOut * bps / 10_000` raw units. Below `ceil(10_000 / bps)` units that entire tolerance is
    ///      worth less than ONE raw unit, so a single unit of rounding — the LP fee alone guarantees at
    ///      least that — already breaches it. The leg cannot clear its own bound however well the pool
    ///      behaves, and offering it anyway has exactly two outcomes, both bad:
    ///
    ///        * inside the strict window it reverts the WHOLE settlement, crossed portion and healthy
    ///          other leg included, for as long as the window lasts; and
    ///        * where `fairOut` itself floors to zero the bound floors to zero with it — `out >= 0` is
    ///          satisfied by a fill of NOTHING — so the pool keeps the input, returns nothing, and the
    ///          units leave the sellers' escrow with no error raised anywhere. Silent loss, which is
    ///          worse than the revert.
    ///
    ///      BOTH LEGS ARE MEASURED, and they are genuinely different questions. `amountIn` catches a
    ///      residual too small to survive its own rounding; `fairOut` catches one that is large in its own
    ///      units but worth nearly nothing in the token it is being sold for — mirrored decimals, or
    ///      simply a very lopsided price. Neither test implies the other.
    ///
    ///      Returning it in kind is not a consolation prize: the owner gets back precisely what they
    ///      escrowed, and the matched part of the batch — which needed no pool at all — settles.
    function _splitResidual(uint128 amountIn, uint256 fairOut) private view returns (uint128 toSwap, uint128 toRefund) {
        if (amountIn == 0) return (0, 0);
        uint256 floorUnits = _dustFloor();
        if (uint256(amountIn) < floorUnits || fairOut < floorUnits) return (0, amountIn);
        return (amountIn, 0);
    }

    /// @dev The least amount this contract treats as an amount at all: the smallest `n` with
    ///      `n * maxResidualSlippageBps >= 10_000`, i.e. the point below which a slippage bound rounds away
    ///      to nothing. `_splitResidual` uses it to keep dust away from the pool and the anchor write uses
    ///      it to keep dust away from the guard — one definition, not two.
    ///      `maxResidualSlippageBps` is non-zero by `initialize`, so this cannot divide by zero.
    function _dustFloor() private view returns (uint256) {
        uint256 bps = uint256(maxResidualSlippageBps);
        return (10_000 + bps - 1) / bps;
    }

    /// @dev Runs the aggregated residual swap, or reports that it could not be run within its bound.
    /// @param lenient when true, a bound breach becomes an in-kind refund instead of a revert. See the
    ///        Q-3 note in `settle` for why that is gated on the deadline rather than always available.
    /// @return out1 currency1 received for the currency0 residual, zero if it was refunded instead.
    /// @return out0 currency0 received for the currency1 residual, zero if it was refunded instead.
    /// @return refunded true when nothing was swapped and the residual belongs back with its owners.
    function _settleResidual(uint128 residual0, uint128 residual1, uint256 priceX96, bool lenient)
        private
        returns (uint128 out1, uint128 out0, bool refunded)
    {
        if (residual0 == 0 && residual1 == 0) return (0, 0, false);

        // H-1 / P-28: PIN THE CALLBACK TO AN UNLOCK WE ASKED FOR. `unlockCallback` is a public entry
        // point; v4 refuses a nested unlock, which makes third-party reachability hard to argue for
        // rather than impossible to state. The sentinel states it: the callback runs only between these
        // two lines. Transient rather than storage because it must not survive the transaction — a
        // leftover authorisation is precisely the hole. Copied from MoleRouter, which pins its own
        // callbacks the same way and for the same reason.
        _armUnlock();
        // A revert inside the callback unwinds every pool operation it performed, so the catch branch is
        // reached with the pool exactly as it was — no partial swap, no stranded take, nothing to undo.
        try poolManager.unlock(abi.encode(residual0, residual1, priceX96)) returns (bytes memory res) {
            (out1, out0) = abi.decode(res, (uint128, uint128));
        } catch (bytes memory err) {
            // ONLY the two failures that mean "the pool cannot do this trade at an acceptable price" are
            // eligible. Everything else — an oracle fault, a token that stopped transferring, a bug —
            // is re-thrown verbatim rather than silently converted into a refund. A blanket catch here
            // would turn any future error into a quiet no-swap settlement, which is exactly the kind of
            // failure that gets discovered by its victims.
            if (!lenient || !_isResidualPriceFailure(err)) _rethrow(err);
            refunded = true;
        }
        // Cleared the moment the unlock returns. On the re-thrown path the whole `settle` frame reverts,
        // which discards the transient write with it, so the sentinel is never left armed either way.
        _disarmUnlock();
    }

    /// @dev True for `ResidualSwapTooFarFromTwap()` / `ResidualShortFill()`, matched by selector.
    ///
    ///      H-2: THE CLAIM THIS FILTER USED TO MAKE WAS NOT TRUE. The note here said the token never gets
    ///      to choose the reason data because a token failure is caught by `_rawTransfer` and re-raised as
    ///      `TransferFailed`. That covers the transfer this contract makes itself — and missed the two
    ///      that PoolManager makes on its behalf. `sync` and `settle` both read `currency.balanceOfSelf()`
    ///      through an ordinary high-level call, so a currency whose `balanceOf` reverts with four bytes
    ///      of its own choosing bubbles them straight out of `unlock` and into the catch above. Four bytes
    ///      reading `ResidualSwapTooFarFromTwap()` and the lenient path books the whole residual back in
    ///      kind: an order that could not be cancelled after the cutoff is cancelled anyway, at will, by
    ///      the counterparty who dislikes the price — and because ONE commingled balance backs every live
    ///      epoch, the in-kind leg it then claims is paid out of the NEXT epoch's deposits.
    ///
    ///      The filter is not where that gets fixed — no selector test can tell a forged four bytes from
    ///      a real one. It is fixed at the source, in `_swapExactIn`, by denying the currency a channel to
    ///      the caller's reason data at all. This stays as the second half of the same property: only the
    ///      two price selectors are eligible, and now they can only have come from here.
    ///
    ///      THE LENGTH CHECK IS UNKILLABLE BY TEST, and it is recorded here rather than quietly kept.
    ///      Mutation testing: deleting it turns nothing red. It stays because the property it defends is
    ///      "no counterparty may impersonate a price failure to force a refund", and one comparison is the
    ///      wrong place to economise on that.
    function _isResidualPriceFailure(bytes memory err) private pure returns (bool) {
        if (err.length != 4) return false;
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(err, 0x20))
        }
        return sel == ResidualSwapTooFarFromTwap.selector || sel == ResidualShortFill.selector;
    }

    /// @dev Re-throw a caught revert with its data intact, so the original reason reaches the caller.
    function _rethrow(bytes memory err) private pure {
        if (err.length == 0) revert ResidualSwapFailed();
        assembly ("memory-safe") {
            revert(add(err, 0x20), mload(err))
        }
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        // H-1: AND WE MUST HAVE ASKED FOR IT. `msg.sender == poolManager` says who called, not why. The
        // sentinel says the call is the return leg of the unlock `_settleResidual` opened two lines ago —
        // so the swap arguments in `data` are ones this contract encoded, not ones handed to a
        // PoolManager that happened to be re-entered. Defence in depth today (v4 refuses a nested unlock)
        // and the difference between "unreachable by construction" and "refused" tomorrow.
        if (!_unlockArmed()) revert UnlockNotInitiated();
        (uint128 residual0, uint128 residual1, uint256 priceX96) = abi.decode(data, (uint128, uint128, uint256));
        uint128 out1;
        uint128 out0;

        // Q-1: BOUND THE RESIDUAL SWAP against the TWAP `settle` already read. Without it the aggregated
        // swap ran with no price limit and no minimum out, so anyone could sandwich the settlement and
        // take a slice of every participant's fill. The bound is immutable rather than a caller argument
        // precisely because `settle` is permissionless — whoever called could otherwise pass a useless one.
        //
        // THE CHECKS LIVE HERE, INSIDE THE UNLOCK, so that breaching one reverts the callback and unwinds
        // the swap with it. Checked in `settle` instead, a breach on the second leg would leave the first
        // leg's swap already executed and taken.
        if (residual0 > 0) {
            out1 = _swapExactIn(true, residual0);
            uint256 fair1 = FullMath.mulDiv(residual0, priceX96, FixedPoint96.Q96);
            if (out1 < FullMath.mulDiv(fair1, 10_000 - maxResidualSlippageBps, 10_000)) {
                revert ResidualSwapTooFarFromTwap();
            }
        }
        if (residual1 > 0) {
            out0 = _swapExactIn(false, residual1);
            uint256 fair0 = FullMath.mulDiv(residual1, FixedPoint96.Q96, priceX96);
            if (out0 < FullMath.mulDiv(fair0, 10_000 - maxResidualSlippageBps, 10_000)) {
                revert ResidualSwapTooFarFromTwap();
            }
        }
        return abi.encode(out1, out0);
    }

    function _swapExactIn(bool zeroForOne, uint128 amountIn) private returns (uint128 amountOut) {
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        Currency cIn = zeroForOne ? key.currency0 : key.currency1;
        Currency cOut = zeroForOne ? key.currency1 : key.currency0;
        int128 owed = zeroForOne ? d.amount0() : d.amount1();
        int128 got = zeroForOne ? d.amount1() : d.amount0();

        // S-1: A SHORT FILL MUST NOT BE SETTLED. `sqrtPriceLimitX96` is pinned at the extreme, so when the
        // pool runs out of liquidity v4 does not revert — it STOPS, consuming less than it was offered and
        // returning a proportionally smaller output. Before this check the queue transferred only what the
        // pool took, recorded only what the pool returned, and never referred to the difference again: the
        // unconsumed escrow was burned into this contract, unreachable by claim (the epoch is Settled, so
        // claim pays the pro-rata of `out0` and stops), by timeout (closed to a Settled epoch) or by any
        // sweep (there is none). `maxResidualSlippageBps` capped the damage but could not close it — that
        // bound is on the OUTPUT, so any short fill whose output still landed inside the band settled
        // happily and stranded the rest. Measured: several percent of an epoch's entire escrow, gone.
        //
        // Refusing is the honest answer rather than a limitation. A short fill means the pool cannot
        // absorb this batch at all, and the contract's response to "cannot price this safely" is the same
        // everywhere else: fail closed, let the epoch time out, return every deposit in kind at no loss.
        if (uint128(-owed) < amountIn) revert ResidualShortFill();

        // H-2: THE CURRENCY MUST NOT GET TO WRITE THE REASON DATA. `sync` and `settle` each read
        // `currency.balanceOfSelf()` through a plain high-level call, so whatever the token reverts with
        // bubbles verbatim out of `unlock` and lands in `_settleResidual`'s catch — where four chosen
        // bytes buy a lenient refund of the whole residual and, through the commingled balance, the next
        // epoch's escrow. `take` is already safe (v4 wraps a failed transfer in ERC-7751, which is far
        // longer than four bytes) but is wrapped alongside them so the property is stated once for the
        // whole leg rather than resting on the shape of somebody else's error. `swap` is deliberately NOT
        // wrapped: for an ERC-20 pool it calls no token, only this protocol's own hook, and masking a v4
        // core error would cost a real diagnostic for no gain.
        //
        // Everything that comes back out of here is now either this contract's own error or a v4 core
        // one, and only the two selectors raised in `unlockCallback` can ever reach the lenient path.
        try poolManager.sync(cIn) {}
        catch {
            revert TransferFailed();
        }
        _rawTransfer(cIn, address(poolManager), uint256(uint128(-owed)));
        try poolManager.settle() returns (uint256) {}
        catch {
            revert TransferFailed();
        }
        amountOut = uint128(got);
        try poolManager.take(cOut, address(this), uint256(uint128(got))) {}
        catch {
            revert TransferFailed();
        }
    }

    /* ------------------------------------------------------------- transfers */

    /// @dev No `_requireMovableCurrency` here on purpose: `place` reads `_balanceOfSelf` immediately
    ///      before this, and that read already refuses a codeless currency — with a stronger check, since
    ///      it also refuses one that answers a balance query with fewer than 32 bytes. A second guard
    ///      behind it would be one no test could ever turn red, which is not a guard.
    function _pull(Currency c, address from, uint256 amount) private {
        (bool ok, bytes memory ret) = Currency.unwrap(c).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(Currency c, address to, uint256 amount) private {
        if (amount == 0) return;
        _rawTransfer(c, to, amount);
    }

    function _rawTransfer(Currency c, address to, uint256 amount) private {
        _requireMovableCurrency(c);
        (bool ok, bytes memory ret) =
            Currency.unwrap(c).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    /// @dev F-03, ON THE PAYOUT SIDE, WHERE THERE IS NO BALANCE READ TO HIDE BEHIND. `initialize`
    ///      refuses a codeless currency at deploy, which is where it should be refused — but a proxy
    ///      outlives its initializer, and a currency can lose its code afterwards (a self-destructing
    ///      token, an upgradeable one pointed at nothing). Empty returndata is how a correct ERC-20
    ///      reports success and how a codeless account reports nothing at all, and the guard below cannot
    ///      tell them apart: the whole of F-03 is that one ambiguity. `extcodesize` can, at one cold read,
    ///      and paying somebody nothing while marking them withdrawn is the outcome worth that read.
    function _requireMovableCurrency(Currency c) private view {
        if (Currency.unwrap(c).code.length == 0) revert UnsupportedCurrency();
    }

    /// @dev This contract's own balance of a currency, read the way MoleRouter reads one: a staticcall
    ///      that refuses a short answer. A codeless account returns zero bytes and would otherwise decode
    ///      as a balance of zero — the same fail-open that F-03 turns into forged escrow.
    function _balanceOfSelf(Currency c) private view returns (uint256 bal) {
        (bool ok, bytes memory ret) =
            Currency.unwrap(c).staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        bal = abi.decode(ret, (uint256));
    }

    /* -------------------------------------------------- transient unlock sentinel (EIP-1153) */

    bytes32 private constant _UNLOCK_SLOT = keccak256("molequeue.unlock.initiated");

    function _armUnlock() private {
        bytes32 slot = _UNLOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    function _disarmUnlock() private {
        bytes32 slot = _UNLOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    function _unlockArmed() private view returns (bool armed) {
        bytes32 slot = _UNLOCK_SLOT;
        assembly ("memory-safe") {
            armed := tload(slot)
        }
    }
}
