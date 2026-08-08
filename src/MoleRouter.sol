// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";

/// @title MoleRouter
/// @notice The aggregator's on-chain executor. It performs a pre-computed swap route across venues and
///         guarantees the user receives at least `minAmountOut` — nothing else.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// THE DESIGN CLAIM, AND WHY IT IS A HIGHER BAR THAN THE INCUMBENTS.
///
/// Every widely-used aggregator executor — 1inch's AggregationRouter, 0x's Settler, and the
/// `DexAggregatorCore` already deployed on this chain — accepts an arbitrary `(target, calldata)` and
/// executes it. That is what makes them general, and it is also why granting one an ERC-20 approval is
/// dangerous: a bug, a malicious route, or a compromised backend can turn your standing approval into
/// `transferFrom(you, attacker)` through the executor, because the executor will call anything.
///
/// This router calls NOTHING arbitrary. It speaks exactly two verbs — a PancakeSwap-V3-style pool swap
/// and a Uniswap-v4 PoolManager swap — and the only addresses it ever calls are the pools named in the
/// route and the v4 PoolManager. There is no `call(target, data)` anywhere in this contract. An approval
/// to this router therefore cannot be escalated into an arbitrary transfer, no matter what route is
/// submitted. The route is UNTRUSTED input: a hostile route can waste the user's own gas and, at worst,
/// produce a bad price — which `minAmountOut` then rejects. It can never move funds the user did not send.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// THE TWO INVARIANTS THAT MAKE THAT TRUE, both asserted by the test suite rather than asserted in prose:
///
///   1. minAmountOut is the ONLY promise. Routing is computed off-chain and is not trusted here. The
///      contract does not check that the route is sane, optimal, or even profitable. It checks one thing:
///      the recipient received at least what they demanded. Off-chain math is a convenience; on-chain
///      minOut is the guarantee.
///
///   2. ZERO RESIDUAL. After any successful swap the router holds none of the input token and none of the
///      output token — the output goes to the recipient, the unspent input is refunded to the payer.
///      Nothing accumulates for a later caller to sweep. This is the same property the vault enforces on
///      itself, and it is what makes the router safe to leave standing approvals against.
///
/// IMMUTABLE ON PURPOSE, unlike the rest of this project. MolePositions is a UUPS proxy because it
/// custodies funds across time and its policy must be able to change. This router custodies nothing
/// between transactions — it is in the MoleFeeCollector category — and for a contract that users grant
/// token approvals to, immutability is the STRONGER guarantee: an upgradeable approval target is exactly
/// the standing-approval-turned-malicious risk stated above. So there is no admin, no upgrade path, and
/// no privileged address. What you audit is what runs, forever.
contract MoleRouter is IUnlockCallback {
    /// @dev The v4 singleton. The router opens exactly one unlock per swap and does all venue work inside
    ///      it, so a route may freely mix v4 and v3 hops in a single atomic transaction.
    IPoolManager public immutable poolManager;

    /// @dev The wrapped-native token (WETH on Robinhood Chain). Native ETH is a wrapper at the EDGES only:
    ///      the router wraps incoming ETH to WETH before the first hop and unwraps the final WETH to ETH
    ///      after the last, so every pool ever sees an ERC-20 and the routing math never special-cases it.
    address public immutable weth;

    /// @dev The sentinel a plan uses to mean "native ETH" for `tokenIn`/`tokenOut`. The de-facto standard
    ///      0xEeee… address, distinct from address(0) so a native leg can never be confused with an unset
    ///      field. The hops themselves always name the real WETH address — the sentinel lives only on the
    ///      plan's outer tokenIn/tokenOut.
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @dev A single hop: swap `tokenIn` for `tokenOut` on one pool. `venue` selects the calling
    ///      convention; the route is built off-chain and every field is untrusted.
    struct Hop {
        Venue venue;
        /// @dev PancakeV3: the pool address. Uniswap v4: ignored (the pool is identified by `key`).
        address pool;
        bool zeroForOne;
        address tokenIn;
        address tokenOut;
        /// @dev Uniswap v4 only: the pool key. Zeroed for PancakeV3 hops.
        PoolKey key;
    }

    /// @dev One path through the graph. `amountIn` is this path's slice of the total; the hops are run in
    ///      order, each fed the exact output of the last, so parallel paths never contaminate each other.
    struct Path {
        uint256 amountIn;
        Hop[] hops;
    }

    /// @dev A complete route. `paths` are independent splits whose `amountIn` must sum to `amountIn`.
    struct SwapPlan {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        address recipient;
        uint256 deadline;
        Path[] paths;
    }

    enum Venue {
        PancakeV3,
        UniswapV4
    }

    /* ------------------------------------------------------------------------ transient state (EIP-1153) */

    // The v3 swap callback is a public entry point that any address could call. During a swap we record
    // the ONE pool we are currently calling into a transient slot, and the callback refuses to pay anyone
    // else. Transient rather than storage because it must not survive the transaction, and cannot: a
    // stale active-pool authorisation leaking into a later call is precisely the hole this guards.
    bytes32 private constant _ACTIVE_POOL_SLOT = keccak256("molerouter.active.pool");
    // The token the active v3 swap is entitled to be paid. Pinned in transient storage by _swapV3 so the
    // callback pays THIS, not a token named in the pool-echoed `data`. Without it, a hostile pool could
    // call the callback with crafted data naming any token the router holds; with it, the callback's
    // payment token is fixed by us before the pool is ever called.
    bytes32 private constant _ACTIVE_IN_SLOT = keccak256("molerouter.active.tokenIn");
    // Reentrancy guard, also transient. `swap` is the only unguarded entry; unlockCallback and the swap
    // callbacks are only reachable while it holds the lock and are pinned to their expected caller.
    bytes32 private constant _LOCK_SLOT = keccak256("molerouter.lock");

    error Locked();
    error DeadlinePassed();
    error NothingToSwap();
    error PathSumMismatch(uint256 declared, uint256 summed);
    error EmptyPath();
    error HopChainBroken();
    error InsufficientOutput(uint256 got, uint256 minOut);
    error NotPoolManager();
    error UnexpectedCallback();
    error ZeroRecipient();
    error SameToken();
    error TransferFailed();
    error PayerReentrancy();
    /// @dev msg.value must equal amountIn for a native-in swap, and be zero otherwise — no stray ETH.
    error BadValue();
    /// @dev Only WETH may send the router native ETH (during an unwrap). Everything else is refused.
    error UnexpectedEther();
    error NativeTransferFailed();

    event Swapped(
        address indexed payer,
        address indexed recipient,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(IPoolManager _poolManager, address _weth) {
        poolManager = _poolManager;
        weth = _weth;
    }

    /// @notice Accept native ETH ONLY while a swap is in flight — which is exactly when WETH sends it back
    ///         during an unwrap. The reentrancy lock is set for the whole swap, so this both permits the
    ///         unwrap and refuses stray sends outside one, meaning native ETH can never accumulate here
    ///         between swaps. The msg.value that funds a native-in swap arrives ATTACHED to the payable
    ///         `swap` call, not through this function, so this staying strict does not block the happy path.
    ///
    ///         (Gated on the transient lock rather than `msg.sender == weth`: reading the `weth` immutable
    ///         inside `receive()` tripped an internal via_ir codegen error at this project's optimizer
    ///         settings. The lock is a strictly-narrower window — mid-swap only — so nothing is lost.)
    receive() external payable {
        if (_lockValue() == 0) revert UnexpectedEther();
    }

    /* ------------------------------------------------------------------------------- external entrypoint */

    /// @notice Execute `plan`, pulling the input from the caller via a prior ERC-20 approval to this
    ///         router — or, for a native-ETH input (`plan.tokenIn == NATIVE`), from the attached msg.value.
    ///         Reverts unless the recipient nets at least `plan.minAmountOut`.
    /// @return amountOut the output token amount delivered to `plan.recipient` (native ETH if
    ///         `plan.tokenOut == NATIVE`).
    function swap(SwapPlan calldata plan) external payable returns (uint256 amountOut) {
        return _swap(plan, msg.sender);
    }

    /// @notice The core, with the payer made explicit. Kept internal so the only funding source is the
    ///         message sender — the router never pulls tokens from an address that did not call it, which
    ///         is what stops a submitted route from naming someone else as the payer.
    function _swap(SwapPlan calldata plan, address payer) internal returns (uint256 amountOut) {
        _lock();

        if (block.timestamp > plan.deadline) revert DeadlinePassed();
        if (plan.amountIn == 0) revert NothingToSwap();
        if (plan.recipient == address(0)) revert ZeroRecipient();
        // The recipient must not be the router itself, or `_push(tokenOut, recipient, totalOut)` is a
        // self-transfer and the whole output is stranded here — a direct violation of the zero-residual
        // invariant that an adversarial route could trigger simply by naming us as the recipient.
        if (plan.recipient == address(this)) revert ZeroRecipient();

        // Native ETH is compared on the EFFECTIVE tokens: NATIVE resolves to WETH, so a WETH->native swap
        // (or the reverse) is a real swap, while native<->WETH or token<->itself is refused.
        bool nativeIn = plan.tokenIn == NATIVE;
        bool nativeOut = plan.tokenOut == NATIVE;
        address effIn = nativeIn ? weth : plan.tokenIn;
        address effOut = nativeOut ? weth : plan.tokenOut;
        if (effIn == effOut) revert SameToken();

        // Exactly amountIn of native ETH for a native-in swap; strictly zero otherwise. Accepting stray
        // ETH on an ERC-20 swap would let it sit here — the router must never hold value it was not asked
        // to route.
        if (nativeIn) {
            if (msg.value != plan.amountIn) revert BadValue();
        } else if (msg.value != 0) {
            revert BadValue();
        }

        // The paths' slices must account for exactly the declared input. A mismatch is a malformed route,
        // not something to paper over by swapping less or pulling more — either would surprise the payer.
        uint256 summed;
        uint256 n = plan.paths.length;
        for (uint256 i = 0; i < n; ++i) {
            if (plan.paths[i].hops.length == 0) revert EmptyPath();
            summed += plan.paths[i].amountIn;
        }
        if (summed != plan.amountIn) revert PathSumMismatch(plan.amountIn, summed);

        // All venue work — the pull, the swaps, delivery, and the residual sweep — happens inside one v4
        // unlock. v3 hops do not need it, but running everything in one context keeps the code path single
        // and auditable, lets a route interleave v4 and v3 hops atomically, and lets the sweep snapshot the
        // router's balances BEFORE the input is pulled. v4 deltas are settled hop-by-hop, so an empty
        // (v3-only) route closes the unlock with zero deltas and succeeds.
        bytes memory result = poolManager.unlock(abi.encode(plan, payer));
        amountOut = abi.decode(result, (uint256));

        if (amountOut < plan.minAmountOut) revert InsufficientOutput(amountOut, plan.minAmountOut);

        emit Swapped(payer, plan.recipient, plan.tokenIn, plan.tokenOut, plan.amountIn, amountOut);
        _unlock();
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        // DEFENCE IN DEPTH, and mutation testing confirms it is redundant rather than load-bearing:
        // deleting it kills no test, because `poolManager.unlock` only ever calls back the address that
        // CALLED unlock, and the only place that calls unlock is `_swap` — which holds the lock and passes
        // its own plan. There is no reachable path where this callback runs with the lock clear. Kept
        // because it costs one transient load and pins the assumption ("we only get here mid-swap")
        // explicitly, so a future refactor that opened a second unlock site could not silently violate it.
        if (_lockValue() == 0) revert UnexpectedCallback();

        (SwapPlan memory plan, address payer) = abi.decode(data, (SwapPlan, address));
        return abi.encode(_execute(plan, payer));
    }

    /// @dev The whole swap, run inside the unlock. Split into `_acquireInput` / `_deliverOutput` / `_sweep`
    ///      deliberately, and NOT only for readability: the combined function held enough locals that the
    ///      via_ir codegen at this project's optimizer_runs sat one variable from a Yul stack-too-deep — so
    ///      any later edit would tip it over. Keeping each frame small keeps the contract compilable as it
    ///      grows. `effIn`/`effOut` (the real ERC-20 behind a possible NATIVE sentinel) are the only
    ///      cross-cutting locals kept here; native-ness is re-derived cheaply inside the sub-calls.
    function _execute(SwapPlan memory plan, address payer) internal returns (uint256 totalOut) {
        address effIn = plan.tokenIn == NATIVE ? weth : plan.tokenIn;
        address effOut = plan.tokenOut == NATIVE ? weth : plan.tokenOut;

        // ZERO RESIDUAL, MADE PROVABLE FOR ANY ROUTE — the heart of the contract's safety claim, and the
        // naive version (refund only plan.tokenIn) did not hold it. An audit found three ways a successful
        // swap could leave value stuck: an intermediate token short-filled by a middle hop, a recipient set
        // to the router, and an airdropped token harvested by the next caller. The fix reasons about NET
        // CHANGE, not final balance: snapshot every touched token BEFORE acquiring input, then after
        // execution deliver the tracked output and sweep every token's increase-beyond-snapshot to the
        // payer — so a pre-existing airdrop is preserved, and no short fill, dust, or self-transfer strands.
        address[] memory tokens = _touchedTokens(plan, effIn, effOut);
        uint256[] memory startBal = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; ++i) startBal[i] = _balance(tokens[i]);

        _acquireInput(plan, payer, effIn);

        for (uint256 i = 0; i < plan.paths.length; ++i) {
            totalOut += _runPath(plan.paths[i], effIn, effOut);
        }

        _deliverOutput(plan, effOut, totalOut);

        _sweep(tokens, startBal, payer, plan.tokenIn == NATIVE || plan.tokenOut == NATIVE);
    }

    /// @dev Acquire the input AFTER the balance snapshot so it counts as this swap's own contribution.
    ///      Native: wrap the ETH that came attached to the call. ERC-20: pull from the payer.
    function _acquireInput(SwapPlan memory plan, address payer, address effIn) internal {
        if (plan.tokenIn == NATIVE) IWETH(weth).deposit{value: plan.amountIn}();
        else _pull(effIn, payer, plan.amountIn);
    }

    /// @dev Deliver the tracked output — the per-hop total, NOT balanceOf, so an airdropped output token
    ///      cannot inflate what we claim to have produced (it is swept instead). Native out: unwrap and
    ///      forward the ETH; ERC-20 out: transfer directly.
    function _deliverOutput(SwapPlan memory plan, address effOut, uint256 totalOut) internal {
        if (totalOut == 0) return;
        if (plan.tokenOut == NATIVE) {
            IWETH(weth).withdraw(totalOut);
            _sendNative(plan.recipient, totalOut);
        } else {
            _push(effOut, plan.recipient, totalOut);
        }
    }

    /// @dev Restore every touched token to its pre-swap balance by returning the increase to the payer.
    ///      The baseline is simply the snapshot — the delivered output was already pushed OUT, so it is no
    ///      longer in `nowBal` and must NOT be subtracted again. (An earlier version subtracted it too;
    ///      mutation testing showed that double-count would strand an over-received output token in
    ///      (startBal, startBal + totalOut].) WETH residual on a native swap is unwrapped so the payer gets
    ///      ETH back rather than a wrapped dust.
    function _sweep(address[] memory tokens, uint256[] memory startBal, address payer, bool nativeInvolved)
        internal
    {
        for (uint256 i = 0; i < tokens.length; ++i) {
            uint256 nowBal = _balance(tokens[i]);
            if (nowBal > startBal[i]) {
                uint256 residual = nowBal - startBal[i];
                if (tokens[i] == weth && nativeInvolved) {
                    IWETH(weth).withdraw(residual);
                    _sendNative(payer, residual);
                } else {
                    _push(tokens[i], payer, residual);
                }
            }
        }
    }

    /// @dev Every distinct token the route names — the EFFECTIVE in/out (WETH, never the NATIVE sentinel,
    ///      because the sentinel is not a real token to sweep) plus every hop's in/out. The set is small
    ///      (a route is a handful of hops), so a linear-dedup memory array is the right shape.
    function _touchedTokens(SwapPlan memory plan, address effIn, address effOut)
        internal
        pure
        returns (address[] memory)
    {
        // Upper bound: 2 (effective in/out) + 2 per hop. Trim to the real count at the end.
        uint256 cap = 2;
        for (uint256 p = 0; p < plan.paths.length; ++p) cap += plan.paths[p].hops.length * 2;
        address[] memory buf = new address[](cap);
        uint256 count;

        count = _addUnique(buf, count, effIn);
        count = _addUnique(buf, count, effOut);
        for (uint256 p = 0; p < plan.paths.length; ++p) {
            Hop[] memory hops = plan.paths[p].hops;
            for (uint256 h = 0; h < hops.length; ++h) {
                count = _addUnique(buf, count, hops[h].tokenIn);
                count = _addUnique(buf, count, hops[h].tokenOut);
            }
        }

        address[] memory out = new address[](count);
        for (uint256 i = 0; i < count; ++i) out[i] = buf[i];
        return out;
    }

    function _addUnique(address[] memory buf, uint256 count, address token) internal pure returns (uint256) {
        for (uint256 i = 0; i < count; ++i) {
            if (buf[i] == token) return count;
        }
        buf[count] = token;
        return count + 1;
    }

    /* ---------------------------------------------------------------------------------------- execution */

    /// @dev Run one path end to end. Each hop is fed the EXACT output of the previous one, tracked as a
    ///      return value rather than read from balanceOf, so two paths that share an intermediate token
    ///      (e.g. both routing through WETH) cannot spend each other's balance.
    function _runPath(Path memory path, address startToken, address finalToken) internal returns (uint256 out) {
        uint256 amount = path.amountIn;
        uint256 hn = path.hops.length;
        // The route's own hop chain is verified here rather than trusted: the first hop must consume the
        // (effective) input token, hop i's output must be hop i+1's input, and the last hop must produce
        // the (effective) output token. A broken chain reverts before any value moves further — and the
        // first-hop check is what stops a plan claiming a native/tokenIn it then routes away from.
        if (path.hops[0].tokenIn != startToken) revert HopChainBroken();
        for (uint256 i = 0; i < hn; ++i) {
            Hop memory hop = path.hops[i];
            if (i > 0 && hop.tokenIn != path.hops[i - 1].tokenOut) revert HopChainBroken();
            amount = hop.venue == Venue.PancakeV3 ? _swapV3(hop, amount) : _swapV4(hop, amount);
        }
        if (path.hops[hn - 1].tokenOut != finalToken) revert HopChainBroken();
        out = amount;
    }

    /// @dev A PancakeSwap-V3-style exact-input swap. Output lands on the router; the callback pays the
    ///      input from the router's balance. `sqrtPriceLimit` is pinned at the extreme because the price
    ///      guarantee is enforced once, at the end, by minAmountOut — a per-hop limit here would only
    ///      turn a bad route into a revert instead of a rejected quote, with no safety gain.
    function _swapV3(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut) {
        // Pin BOTH the authorised pool and the token it may be paid, before the pool can call back.
        _setActive(hop.pool, hop.tokenIn);
        (int256 amount0, int256 amount1) = IPancakeV3Pool(hop.pool).swap(
            address(this),
            hop.zeroForOne,
            int256(amountIn),
            hop.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1,
            ""
        );
        // Clear the transient authorisation the instant the swap returns. DEFENCE IN DEPTH: mutation
        // testing shows deleting this kills no test, because every swap SETS the active pool immediately
        // before use and the reentrancy lock forbids any nested entry, so a stale value is never consulted.
        // Kept so that between two hops the authorised set is empty rather than "the previous pool" — the
        // narrowest possible window, which is the right default for a value that gates who we will pay.
        _clearActive();
        // The negative delta is what the pool paid us.
        int256 outDelta = hop.zeroForOne ? -amount1 : -amount0;
        if (outDelta < 0) revert HopChainBroken();
        amountOut = uint256(outDelta);
    }

    /// @dev The PancakeSwap V3 / Uniswap V3 swap callback. The pool calls back demanding payment; we pay
    ///      the exact positive delta, and only for the pool we are actively swapping through.
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payV3Callback(amount0Delta, amount1Delta, data);
    }

    /// @dev Some V3 forks emit the Uniswap-named callback; accept both, identically.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payV3Callback(amount0Delta, amount1Delta, data);
    }

    function _payV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata) internal {
        // Only the pool we deliberately called may reach this and be paid. Any other caller — including a
        // pool the route named but we are not currently inside — is refused, so a malicious "pool" cannot
        // invoke the callback to make the router pay out.
        if (msg.sender != _activePool()) revert UnexpectedCallback();
        // Pay the token WE pinned before the swap, never a token named in the pool-echoed data. A hostile
        // pool controls the callback arguments but not this: it can at most demand more of the one token
        // the current swap legitimately spends, which is bounded by the router's balance and rejected by
        // minAmountOut downstream.
        address tokenIn = _activeTokenIn();
        // Exactly one delta is positive: what we owe. We never owe both, and paying the positive side
        // only means we cannot be tricked into paying more than the swap requires.
        if (amount0Delta > 0) {
            _push(tokenIn, msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0) {
            _push(tokenIn, msg.sender, uint256(amount1Delta));
        }
    }

    /// @dev A Uniswap v4 exact-input swap, inside the router's unlock. We owe the input currency (negative
    ///      delta) and are owed the output (positive delta); settle the first, take the second, so the
    ///      hop nets to zero v4 delta and the unlock can close.
    function _swapV4(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut) {
        BalanceDelta delta = poolManager.swap(
            hop.key,
            SwapParams({
                zeroForOne: hop.zeroForOne,
                amountSpecified: -int256(amountIn), // negative = exact input, in v4's convention
                sqrtPriceLimitX96: hop.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        (Currency inCur, Currency outCur, int128 owed, int128 received) = hop.zeroForOne
            ? (hop.key.currency0, hop.key.currency1, d0, d1)
            : (hop.key.currency1, hop.key.currency0, d1, d0);

        if (owed > 0 || received < 0) revert HopChainBroken();

        _settle(inCur, uint256(uint128(-owed)));
        amountOut = uint256(uint128(received));
        poolManager.take(outCur, address(this), amountOut);
    }

    /// @dev sync → pay → settle, the v4 payment handshake for an ERC-20 currency.
    function _settle(Currency currency, uint256 amount) internal {
        poolManager.sync(currency);
        _push(Currency.unwrap(currency), address(poolManager), amount);
        poolManager.settle();
    }

    /* ---------------------------------------------------------------------------------------- transfers */

    function _pull(address token, address from, uint256 amount) internal {
        // A payer that is a contract calling swap re-entrantly could otherwise route around the lock; the
        // lock already blocks that, and pulling only from msg.sender means we never touch a third party.
        (bool ok, bytes memory ret) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, address(this), amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _balance(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) =
            token.staticcall(abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }

    /// @dev Forward native ETH, reverting on failure rather than swallowing it. Used only to deliver an
    ///      unwrapped output and to refund unspent native input, both to caller-supplied addresses inside
    ///      the reentrancy lock, so a recipient with a reverting fallback fails the whole swap cleanly.
    function _sendNative(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    /* -------------------------------------------------------------------------------- transient helpers */

    function _lock() internal {
        if (_lockValue() != 0) revert Locked();
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
    }

    function _unlock() internal {
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    function _lockValue() internal view returns (uint256 v) {
        bytes32 slot = _LOCK_SLOT;
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _setActive(address pool, address tokenIn) internal {
        bytes32 poolSlot = _ACTIVE_POOL_SLOT;
        bytes32 inSlot = _ACTIVE_IN_SLOT;
        assembly ("memory-safe") {
            tstore(poolSlot, pool)
            tstore(inSlot, tokenIn)
        }
    }

    function _clearActive() internal {
        bytes32 poolSlot = _ACTIVE_POOL_SLOT;
        bytes32 inSlot = _ACTIVE_IN_SLOT;
        assembly ("memory-safe") {
            tstore(poolSlot, 0)
            tstore(inSlot, 0)
        }
    }

    function _activePool() internal view returns (address pool) {
        bytes32 slot = _ACTIVE_POOL_SLOT;
        assembly ("memory-safe") {
            pool := tload(slot)
        }
    }

    function _activeTokenIn() internal view returns (address tokenIn) {
        bytes32 slot = _ACTIVE_IN_SLOT;
        assembly ("memory-safe") {
            tokenIn := tload(slot)
        }
    }
}

/// @dev Wrapped-native (WETH9) surface: deposit wraps the attached ETH, withdraw unwraps to the caller.
interface IWETH {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

/// @dev Minimal PancakeSwap-V3 / Uniswap-V3 pool surface. Only `swap` is used.
interface IPancakeV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}
