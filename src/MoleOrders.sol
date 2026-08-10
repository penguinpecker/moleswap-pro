// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {MoleRouter} from "./MoleRouter.sol";

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
///   - and only if the output clears YOUR `minOutPerLeg` floor (so a keeper cannot execute at a bad price;
///     for a LIMIT order this floor IS your limit price),
///   - no more often than every `interval` seconds (so a DCA cannot be drained in one block).
///
/// The contract holds tokens only transiently inside `fillLeg` (pull → swap → out) and asserts zero
/// residual, exactly like MoleRouter. It is NOT upgradeable — an upgradeable approval target could be
/// turned malicious, and that is the whole risk we are avoiding. The admin can ONLY rotate the keeper
/// address (which cannot steal either), never the execution logic.
///
/// A DCA order is `interval > 0` with a slippage floor; a LIMIT order is `interval == 0` (fills as soon as
/// the price is met) with `minOutPerLeg` set to the limit. Same contract, one code path.
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
    event OrderFilled(uint256 indexed id, uint256 legIn, uint256 amountOut, uint256 spent);
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
    error IntervalNotElapsed();
    error BudgetExhausted();
    error PlanMismatch();
    error RecipientNotOwner();
    error FloorNotMet();
    error TransferFailed();
    error Reentrancy();
    error Residual();

    constructor(MoleRouter _router, address _admin, address _keeper) {
        if (address(_router) == address(0) || _admin == address(0)) revert BadOrder();
        router = _router;
        admin = _admin;
        keeper = _keeper;
        emit AdminTransferred(address(0), _admin);
        emit KeeperSet(_keeper);
    }

    /* --------------------------------------------------------------------------------- order lifecycle */

    /// @notice Create an order. Moves NO funds — you separately approve this contract for `tokenIn`, and
    ///         each leg pulls only what it needs when the keeper fills it. `interval == 0` is a limit order
    ///         (fills as soon as the price clears `minOutPerLeg`); `interval > 0` is DCA.
    function createOrder(
        address tokenIn,
        address tokenOut,
        uint256 amountPerLeg,
        uint256 totalBudget,
        uint256 minOutPerLeg,
        uint64 interval
    ) external returns (uint256 id) {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert BadOrder();
        if (amountPerLeg == 0 || totalBudget < amountPerLeg || minOutPerLeg == 0) revert BadOrder();

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
        _ownerOrders[msg.sender].push(id);
        emit OrderCreated(id, msg.sender, tokenIn, tokenOut, amountPerLeg, totalBudget, minOutPerLeg, interval);
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
    ///         relies on is CHECKED here against the stored order, not trusted from the plan.
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

        // The user's price floor, scaled to a partial final leg. The router enforces plan.minAmountOut on
        // the POST-fee output, so requiring plan.minAmountOut >= the floor makes the floor a real guarantee
        // — and for a limit order this is the limit price itself.
        uint256 floor = (o.minOutPerLeg * legIn) / o.amountPerLeg;
        if (plan.minAmountOut < floor) revert FloorNotMet();

        // Pull exactly this leg from the owner (owner approved THIS contract), hand it to the router, and
        // let the router deliver the output straight to the owner. Snapshot to prove zero residual.
        uint256 inBefore = _balance(o.tokenIn);
        _pull(o.tokenIn, o.owner, legIn);
        _approve(o.tokenIn, address(router), legIn);
        amountOut = router.swap(plan);

        o.spent += legIn;
        o.lastFill = uint64(block.timestamp);
        bool done = o.spent >= o.totalBudget;
        if (done) o.active = false;

        // The router pulled the input and sent the output to the owner; nothing may remain here. DEFENCE
        // IN DEPTH: mutation testing shows deleting this kills no test, because a correct MoleRouter always
        // leaves zero residual — so no reachable state distinguishes it. Kept as a fail-closed guard against
        // a future router change or an exotic token, at the cost of one balance read.
        if (_balance(o.tokenIn) != inBefore) revert Residual();

        emit OrderFilled(id, legIn, amountOut, o.spent);
        if (done) emit OrderClosed(id, true);
        _unlock();
    }

    /* ------------------------------------------------------------------------------------------- views */

    function ordersOf(address owner) external view returns (uint256[] memory) {
        return _ownerOrders[owner];
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

    /* ---------------------------------------------------------------------------------------- internal */

    function _pull(address token, address from, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount));
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
