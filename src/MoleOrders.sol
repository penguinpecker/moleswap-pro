// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MoleRouter} from "./MoleRouter.sol";

/// @notice The only thing MoleOrders needs from a MoleHook: the arithmetic-mean tick over a window.
///         Declared as a minimal interface rather than importing the hook, so the order book stays
///         independent of the hook's implementation and does not carry its bytecode.
interface IMoleOracle {
    function consult(PoolId id, uint32 secondsAgo) external view returns (int24 arithmeticMeanTick);
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
///     from the pool TWAP at the moment of the fill, whichever is higher (see THE PRICE BOUND below),
///   - no more often than every `interval` seconds (so a DCA cannot be drained in one block).
///
/// The contract holds tokens only transiently inside `fillLeg` (pull → swap → out) and returns anything
/// the route hands back to the ORDER OWNER — never to the keeper, never to the admin, never to itself.
/// It is NOT upgradeable — an upgradeable approval target could be turned malicious, and that is the whole
/// risk we are avoiding. The admin can ONLY rotate the keeper address (which cannot steal either), never
/// the execution logic.
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
/// So the floor is now recomputed PER LEG, at fill time, from a price the keeper does not author: the
/// arithmetic-mean tick of a reference pool the ORDER OWNER named at creation, read through that pool's
/// own MoleHook oracle. The effective floor is `max(your absolute floor, TWAP fair value × (1 −
/// maxSlippageBps))`. Both halves matter: the TWAP half stops the keeper executing far from the market,
/// the absolute half keeps a limit order a limit order when the market is BETTER than your price.
///
/// THE ANCHOR IS THE TWAP, NEVER SPOT — the same rule MoleQueue states. Spot is whatever the last trade
/// left behind and an ordering-privileged party sets it for free; a swap sharing the fill's own
/// `block.timestamp` contributes exactly zero to the mean, so it cannot move this bound at all.
///
/// The reference pool is the owner's choice, exactly like the limit price is. It is checked at creation
/// to be a LIVE Uniswap v4 pool over precisely this order's two tokens with a non-zero hook — a key that
/// names a pool which does not exist cannot be stored, so a typo fails at creation rather than leaving an
/// order that can never fill. `maxSlippageBps` is capped at MAX_SLIPPAGE_BPS: whatever the client asks
/// for, the most a hostile keeper can ever take off the market price is that cap.
///
/// SIZING `maxSlippageBps`, because getting it wrong is a liveness bug rather than a safety one. The
/// floor is compared against the output the owner ACTUALLY RECEIVES, which is net of the pool's LP fee
/// and net of the aggregator fee MoleRouter skims from the input. So the tolerance has to cover the
/// round trip — LP fee + aggregator fee + price impact — or an honest fill simply never clears it and
/// the order stalls. At the shipped 30 bps LP fee and 69 bps dial that is ~100 bps of unavoidable cost
/// before any impact at all. Too tight only stops fills; too loose is what the cap above bounds.
contract MoleOrders {
    using PoolIdLibrary for PoolKey;

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

    /// @dev The market-referenced half of an order's price floor. A PARALLEL MAPPING rather than four more
    ///      fields on `Order`: `orders` is already populated in storage on a live deployment and the shape
    ///      of its generated getter is part of the client and keeper ABI, so widening the struct would
    ///      renumber every slot behind it and silently reinterpret existing orders. Appending a second
    ///      mapping after the last existing variable leaves every pre-existing (slot, offset, type)
    ///      byte-identical, which is the only migration a contract holding standing approvals may make.
    struct PriceBound {
        /// @dev The reference pool, as the id the oracle is keyed by. The full PoolKey is verified at
        ///      creation and then discarded — only the id and the orientation are needed to price a leg.
        bytes32 poolId;
        /// @dev That pool's hook, which is the oracle. Read from the key, so it is provably the hook the
        ///      live pool is actually bound to rather than an address supplied on the side.
        address oracle;
        uint32 twapWindow;
        uint16 maxSlippageBps;
        /// @dev Whether the order's INPUT token is the pool's currency0. Derived at creation from the key,
        ///      so the tick-to-price conversion cannot be pointed the wrong way round by a caller.
        bool inIsCurrency0;
    }

    mapping(uint256 => PriceBound) internal _bounds;

    /// @dev The hard ceiling on how far below the reference TWAP any single leg may execute. This is the
    ///      contract's own bound on the worst case, independent of what a client asks for: a hostile or
    ///      compromised keeper can extract at most this much of a leg, not the leg.
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000; // 10%
    /// @dev The window must be long enough that a single block cannot author it (a one-second "TWAP" is
    ///      spot wearing a hat) and short enough that it is still a price rather than a memory.
    uint32 public constant MIN_TWAP_WINDOW = 300; // 5 minutes
    uint32 public constant MAX_TWAP_WINDOW = 3600; // 1 hour
    uint256 internal constant BPS_DENOM = 10_000;

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
    event OrderBound(
        uint256 indexed id, bytes32 indexed poolId, address indexed oracle, uint32 twapWindow, uint16 maxSlippageBps
    );
    event OrderFilled(uint256 indexed id, uint256 legIn, uint256 amountOut, uint256 spent);
    /// @dev The route handed input back (a rounded-down multi-path split, or a short fill). It went to the
    ///      order owner and was NOT charged against the budget.
    event LegRefunded(uint256 indexed id, address indexed token, uint256 amount);
    event OrderClosed(uint256 indexed id, bool completed);
    event KeeperSet(address indexed keeper);
    event AdminTransferStarted(address indexed current, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed current);

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
    /// @notice The reference oracle answered with a tick outside the range a Uniswap price can occupy.
    error OracleTickOutOfRange();

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
    /// @param refPool       The live v4 pool whose TWAP prices this order. Must be over exactly
    ///                      {tokenIn, tokenOut} and carry a hook — that hook is the oracle.
    /// @param twapWindow    Seconds of smoothing on the reference price.
    /// @param maxSlippageBps How far below that TWAP a single leg may execute, capped at MAX_SLIPPAGE_BPS.
    ///
    /// The bound is MANDATORY, not opt-in. An order without a market reference is the exact order the
    /// audit found extractable to the last wei, and an opt-out is how every such order would be created.
    function createOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountPerLeg,
        uint256 totalBudget,
        uint256 minOutPerLeg,
        uint64 interval,
        PoolKey calldata refPool,
        uint32 twapWindow,
        uint16 maxSlippageBps
    ) external returns (uint256 id) {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert BadOrder();
        if (amountPerLeg == 0 || totalBudget < amountPerLeg || minOutPerLeg == 0) revert BadOrder();

        PriceBound memory b = _validateBound(tokenIn, tokenOut, refPool, twapWindow, maxSlippageBps, amountPerLeg);

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
        emit OrderBound(id, b.poolId, b.oracle, twapWindow, maxSlippageBps);
    }

    /// @notice Cancel an order. Only the owner. No funds are held, so nothing is returned — cancelling
    ///         simply stops future fills. (Revoking the ERC-20 approval also stops fills, belt-and-braces.)
    function cancelOrder(uint256 id) external {
        Order storage o = orders[id];
        if (o.owner != msg.sender) revert NotOrderOwner();
        if (!o.active) revert OrderInactive();
        o.active = false;
        emit OrderClosed(id, false);
    }

    /* ------------------------------------------------------------------------------------- keeper fill */

    /// @notice Fill one leg of `id` with a pre-computed route. Keeper-only. Every safety property the user
    ///         relies on is CHECKED here against the stored order and a live TWAP, not trusted from the
    ///         plan.
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

        // THE PRICE BOUND. `_legFloor` reads the reference TWAP live, so the number the keeper must clear
        // is authored by the market and the owner's own tolerance — never by the keeper's plan. The router
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

    /// @notice The market-referenced half of an order's floor, as stored.
    function boundOf(uint256 id) external view returns (PriceBound memory) {
        return _bounds[id];
    }

    /// @notice The next leg's size and the exact output floor it must clear, priced at the CURRENT TWAP.
    ///         The keeper builds `plan.minAmountOut` from this; a plan below it is refused.
    ///         Returns (0, 0) for an order with no budget left.
    function currentLeg(uint256 id) external view returns (uint256 legIn, uint256 floorOut) {
        Order storage o = orders[id];
        uint256 remaining = o.totalBudget - o.spent;
        if (remaining == 0) return (0, 0);
        legIn = remaining < o.amountPerLeg ? remaining : o.amountPerLeg;
        floorOut = _legFloor(id, legIn);
    }

    /// @notice True if the order can be filled right now (active, interval elapsed, budget left). The
    ///         PRICE condition is the keeper's job (it builds the plan); this covers the on-chain gates.
    function fillable(uint256 id) external view returns (bool) {
        Order storage o = orders[id];
        return o.active && o.spent < o.totalBudget
            && block.timestamp >= uint256(o.lastFill) + uint256(o.interval);
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

    /* ------------------------------------------------------------------------------------ price bound */

    /// @dev Check the owner's reference pool and reduce it to the two things a fill needs: the oracle key
    ///      and the orientation. Everything checkable is checked HERE, once, so `fillLeg` stays a read.
    function _validateBound(
        address tokenIn,
        address tokenOut,
        PoolKey calldata refPool,
        uint32 twapWindow,
        uint16 maxSlippageBps,
        uint256 amountPerLeg
    ) internal view returns (PriceBound memory b) {
        // The cap is the contract's own statement of the worst case, so it is enforced here rather than
        // trusted from a client: no order may be created that authorises giving away more than this.
        if (maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadBound();
        if (twapWindow < MIN_TWAP_WINDOW || twapWindow > MAX_TWAP_WINDOW) revert BadBound();

        address hook = address(refPool.hooks);
        // A hookless v4 pool keeps no observations, so it has no TWAP to consult. Naming one would store a
        // bound that can never be evaluated, i.e. an order that can never fill.
        if (hook == address(0)) revert BadBound();

        // The reference must price THIS pair, in a direction we can derive rather than be told.
        address c0 = Currency.unwrap(refPool.currency0);
        address c1 = Currency.unwrap(refPool.currency1);
        bool inIs0;
        if (c0 == tokenIn && c1 == tokenOut) inIs0 = true;
        else if (c1 == tokenIn && c0 == tokenOut) inIs0 = false;
        else revert BadBound();

        PoolId pid = refPool.toId();
        // A PoolId is the hash of the WHOLE key, hooks included, so a live pool at this id is proof that
        // the pool really is bound to `hook`. Without this check a key naming a pool that was never
        // created would be accepted and the order would be unfillable forever.
        (uint160 sqrtSpot,,,) = StateLibrary.getSlot0(router.poolManager(), pid);
        if (sqrtSpot == 0) revert BadBound();

        b = PriceBound({
            poolId: PoolId.unwrap(pid),
            oracle: hook,
            twapWindow: twapWindow,
            maxSlippageBps: maxSlippageBps,
            inIsCurrency0: inIs0
        });

        // Evaluate the bound once, now. An oracle that cannot answer this window, or a price so extreme
        // that a full leg is worth zero of the output token, must fail at creation — where the owner sees
        // it — rather than at every fill for the life of the order.
        if (_fairOut(b, amountPerLeg) == 0) revert BadBound();
    }

    /// @dev What `amountIn` of the order's input token is worth in its output token at the reference TWAP.
    ///      Same two-step conversion MoleQueue uses: tick → sqrtPrice → price, so nothing overflows.
    function _fairOut(PriceBound memory b, uint256 amountIn) internal view returns (uint256) {
        int24 tick = IMoleOracle(b.oracle).consult(PoolId.wrap(b.poolId), b.twapWindow);

        // BOUND THE ORACLE'S ANSWER HERE, WHERE IT IS READ, AND NAME THE PROBLEM AS AN ORACLE PROBLEM.
        //
        // `b.oracle` is `refPool.hooks` — an address the ORDER OWNER chose at creation. Nothing here
        // constrains it to be a MoleHook; it only has to be the hook of some pool that exists, which
        // anyone can create with any hook they like. So `consult` is an arbitrary external view returning
        // an arbitrary int24, and even the honest implementation narrows an int56 quotient to int24 with
        // a truncating cast — a cast that wraps rather than reverts — while living behind a proxy that
        // can be upgraded independently of this contract.
        //
        // A tick outside [MIN_TICK, MAX_TICK] is not a price. Fed straight to `TickMath`, it reverts
        // `InvalidTick` from inside a library three frames down, and the operator's report reads as
        // arithmetic gone wrong in the order book rather than "the reference pool's oracle gave an answer
        // that is not a price". Same refusal, wrong diagnosis, and the wrong diagnosis is what sends
        // someone looking for the fault in the wrong contract.
        //
        // FAIL CLOSED, deliberately: a leg that cannot be priced must not be filled. This is the ONLY
        // path that produces the market half of the floor, so refusing here refuses the fill — it can
        // never silently degrade to the owner's stale absolute floor, which is exactly the stale-limit
        // hole the price bound was written to close. It also refuses at `create`, where `_validateBound`
        // evaluates the bound once and the owner is present to see it.
        if (tick < TickMath.MIN_TICK || tick > TickMath.MAX_TICK) revert OracleTickOutOfRange();

        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        // price = (sqrtP / 2^96)^2 — currency1 per currency0, in raw units, so token decimals need no
        // handling of their own.
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
        if (priceX96 == 0) revert BadBound();
        return b.inIsCurrency0
            ? FullMath.mulDiv(amountIn, priceX96, FixedPoint96.Q96)
            : FullMath.mulDiv(amountIn, FixedPoint96.Q96, priceX96);
    }

    /// @dev The output floor for a leg of `legIn`: the higher of the owner's own absolute floor (scaled to
    ///      a partial final leg) and the live TWAP fair value less the owner's tolerance.
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
        uint256 market = FullMath.mulDiv(_fairOut(b, legIn), BPS_DENOM - b.maxSlippageBps, BPS_DENOM);
        if (market > floorOut) floorOut = market;
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
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
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
