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

interface IMoleOracle {
    function consult(PoolId id, uint32 secondsAgo) external view returns (int24 arithmeticMeanTick);
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

    /* ------------------------------------------------------------------ entry */

    /// @notice Queue an intent to sell `amountIn` of one side for the other, at the epoch's clearing rate.
    function place(bool zeroForOne, uint128 amountIn) external returns (uint256 index) {
        if (amountIn == 0) revert ZeroAmount();
        uint64 e = currentEpoch;
        if (_phase(e) != Phase.Open) revert WrongPhase();

        Currency cIn = zeroForOne ? key.currency0 : key.currency1;
        _pull(cIn, msg.sender, amountIn);

        index = orders[e].length;
        orders[e].push(Order({owner: msg.sender, zeroForOne: zeroForOne, amountIn: amountIn, withdrawn: false}));
        Epoch storage ep = epochs[e];
        if (zeroForOne) ep.totalIn0 += amountIn;
        else ep.totalIn1 += amountIn;

        emit OrderPlaced(e, index, msg.sender, zeroForOne, amountIn);
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
        if (block.timestamp < uint256(ep.frozenAt) + freezeDuration) revert TooEarly();
        if (ep.totalIn0 == 0 && ep.totalIn1 == 0) revert NothingToSettle();

        // THE ANCHOR IS THE TWAP, NEVER SPOT. Spot is whatever the last trade left behind and an
        // ordering-privileged party sets it for free; crossing there would let the sequencer price every
        // batch. `consult` fails CLOSED — it reverts rather than answering from an under-covered ring —
        // so an oracle that cannot support the window stops settlement instead of mispricing it.
        int24 tick = oracle.consult(key.toId(), twapWindow);

        // Q-2: REFUSE A STALE ANCHOR. If the market has moved away from the TWAP by more than the band,
        // this batch would cross at a price everyone can see is wrong, and the cutoff means the losing
        // side cannot walk away. Refusing is safe — the epoch times out and everyone reclaims in kind.
        (, int24 spotTick,,) = StateLibrary.getSlot0(poolManager, key.toId());
        int24 drift = spotTick > tick ? spotTick - tick : tick - spotTick;
        if (drift > maxTwapDeviationTicks) revert TwapTooFarFromSpot();

        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        // price = (sqrtP / 2^96)^2, applied in two steps so nothing overflows.
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);

        // How much of side 0 the side-1 escrow can absorb at that price, and vice versa.
        uint256 want0 = FullMath.mulDiv(ep.totalIn1, FixedPoint96.Q96, priceX96); // token0 the 1-sellers buy
        uint128 crossed0 = uint128(ep.totalIn0 < want0 ? ep.totalIn0 : want0);
        uint128 crossed1 = uint128(FullMath.mulDiv(crossed0, priceX96, FixedPoint96.Q96));

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
        (uint128 swapOut1, uint128 swapOut0, bool refunded) = _settleResidual(residual0, residual1, priceX96, lenient);

        if (refunded) {
            ep.refund0 = residual0;
            ep.refund1 = residual1;
            emit ResidualRefunded(e, residual0, residual1);
        }

        // Uniform per side: crossed at TWAP plus residual at whatever the single swap achieved.
        ep.out0 = crossed1 + swapOut1; // total currency1 owed to currency0 sellers
        ep.out1 = crossed0 + swapOut0; // total currency0 owed to currency1 sellers
        ep.phase = Phase.Settled;

        emit EpochSettled(e, tick, crossed0, crossed1);
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
        if (block.timestamp < uint256(ep.frozenAt) + maxEpochLife) revert NotTimedOut();
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
    }

    /// @dev True for `ResidualSwapTooFarFromTwap()` / `ResidualShortFill()`, matched by selector.
    ///
    ///      THE LENGTH CHECK IS UNKILLABLE BY TEST, and it is recorded here rather than quietly kept.
    ///      Mutation testing: deleting it turns nothing red. Nothing that can revert out of the unlock
    ///      produces data longer than four bytes that BEGINS with one of these two selectors — a token
    ///      failure is caught by `_rawTransfer` and re-raised as this contract's own `TransferFailed`, so
    ///      the token never gets to choose the reason data, and every v4 error is its own 4-byte selector.
    ///      It stays because the property it defends is "no counterparty may impersonate a price failure
    ///      to force a refund", and one comparison is the wrong place to economise on that.
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

        poolManager.sync(cIn);
        _rawTransfer(cIn, address(poolManager), uint256(uint128(-owed)));
        poolManager.settle();
        amountOut = uint128(got);
        poolManager.take(cOut, address(this), uint256(uint128(got)));
    }

    /* ------------------------------------------------------------- transfers */

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
        (bool ok, bytes memory ret) =
            Currency.unwrap(c).call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
