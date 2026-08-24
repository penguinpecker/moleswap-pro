// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

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
/// THE 2026-08-23 AUDIT FOUND THAT LAST SENTENCE WAS PROSE, NOT CODE, and it is worth saying exactly how,
/// because the repair is what the venue branches now look like. "We only call pools" is a weaker claim
/// than it sounds: a hop's pool address, and a v4 hop's whole PoolKey, are caller data, so "a pool" meant
/// "any contract the route names". Both venues then took NUMBERS from that contract and acted on them —
/// v3 paid whatever its callback demanded and reported whatever output it liked, v4 spent whichever
/// currency its key named for whatever amount its (attacker-supplied) hook made the delta say. The route
/// could not reach a third party's approval, but it could reach anything the ROUTER itself was holding.
/// The fix is one rule applied at every venue boundary: a hop may spend at most the input the route
/// declared for it, and produces at most what it measurably delivered in the currency the route declared.
/// Untrusted addresses are still called; nothing they say is believed. See `_ACTIVE_BUDGET_SLOT`,
/// `_swapV3`'s measured delta, and `_swapV4`'s currency binding.
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
///      Stated precisely, because "holds nothing" was the loose reading that hid two defects: the sweep
///      is over NET CHANGE, not final balance. What the router was already holding before the swap — an
///      airdrop, a mis-sent transfer, force-fed ETH — is preserved, not harvested by whoever calls next;
///      what the swap caused to arrive leaves with the payer. Native ETH is included in that as of the
///      2026-08-23 audit fix: it used to have no sweep leg at all, so ETH pushed in mid-swap (which
///      `receive()` permits, since the lock is held) sat here permanently.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// UPGRADEABLE — AND THIS IS THE CONTRACT'S LARGEST TRUST ASSUMPTION. READ IT BEFORE APPROVING.
///
/// The previous router was immutable ON PURPOSE, and the argument for that has not become wrong: for a
/// contract users grant standing token approvals to, immutability is the STRONGER guarantee, because an
/// upgradeable approval target IS the standing-approval-turned-malicious risk described above. That is
/// still true. This deployment accepts it deliberately (operator decision, 2026-08-15) in exchange for
/// being able to change routing and fee logic without forcing every user to re-approve a new address.
///
/// STATE PLAINLY WHAT THAT COSTS, because the paragraphs above would otherwise overclaim:
///
///   - `upgradeAdmin` can replace every line of this contract, including the two-verbs claim. A future
///     implementation COULD contain `call(target, data)` or a direct `transferFrom(user, attacker, ...)`.
///     The bound is therefore not "this code cannot escalate an approval" but "whoever holds
///     `upgradeAdmin` will not". Every wallet that has ever approved this router is exposed up to its
///     allowance — and the app approves `type(uint256).max`.
///   - `feeRecipient`, `feeDial` and the effective fee ceiling were immutables and are now upgradeable
///     state. "The fee can never exceed 1%" is consequently a statement about the CURRENT implementation,
///     not about the address. The dial's own clamp still holds against a compromised DIAL key; it does
///     not hold against a compromised UPGRADE key.
///   - As deployed, `upgradeAdmin` is the same key used for the keeper, the fee recipient and deployment.
///     A compromise of that hot key is therefore a compromise of every approval granted here. This is
///     recorded as a known, accepted exposure rather than papered over.
///
/// WHAT SURVIVES ANY UPGRADE: nothing at this layer. Unlike MoleHook — whose permission bits live in its
/// ADDRESS and so cannot be acquired by any implementation — a router's powers are entirely code. The only
/// mechanical guarantee available is to surrender the key: `transferUpgradeAdmin(address(0))` makes this
/// contract permanently immutable and restores the original property in full. It is built, and it is the
/// intended end state once the fee model has settled.
///
/// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/// THE AGGREGATOR FEE. Every clause below is scoped to the CURRENT implementation — see the upgrade
/// section above, which supersedes any reading of these as properties of the ADDRESS.
///
/// The router reads `feeBps` from a tiny external dial (MoleFeeDial) at swap time, so the fee can be tuned
/// with one transaction there — but, against a compromised DIAL key specifically:
///
///   - the router clamps whatever the dial returns at the compiled-in `MAX_FEE_BPS` (1%). A fully
///     compromised dial key moves a number inside [0, 1%] and can do nothing else;
///   - the fee DESTINATION (`feeRecipient`) is not readable or writable by the dial, so the dial cannot
///     redirect a wei. (It IS writable by an upgrade — that is the upgrade key's power, not the dial's.);
///   - the dial is read with a gas-capped STATICCALL and ANY failure — revert, empty return, gas burn —
///     resolves to fee = 0. A broken or hostile dial makes swaps free, never stuck;
///   - the zero-residual invariant is unchanged: the input splits into fee + routed amount, both leave in
///     the same transaction, and the sweep still returns every other increase to the payer.
///
/// THE FEE IS TAKEN FROM THE INPUT (the source currency), NOT THE OUTPUT.
///
/// The earlier router skimmed the fee off the route's OUTPUT. That is the common design and it is wrong for
/// this venue: on a memecoin BUY the output is the memecoin, so the treasury accrued whatever token the user
/// happened to be buying — illiquid, sometimes unsellable, and costing that pool's LP fee again to convert.
/// Uniswap's own interface fee sidesteps this by only charging on a list of liquid majors. Here every route
/// is a hub route, so the INPUT is overwhelmingly ETH or USDG: taking the fee there pays the treasury in the
/// asset the user already chose to spend, at identical cost to the user (0.69% is 0.69% wherever it is
/// clipped along the path).
///
/// Known and accepted: on a SELL (memecoin -> ETH) the source currency IS the memecoin, so that direction
/// still collects the long-tail token. This is the MetaMask model and it is a deliberate trade, not an
/// oversight — most volume is buys, and no in-kind fee can avoid it on both sides at once.
///
/// TWO CONSEQUENCES THAT CHANGE THE PLAN CONTRACT, both load-bearing:
///
///   1. `minAmountOut` is now enforced on the FULL route output, because the whole output belongs to the
///      recipient. Off-chain the quote routes (amountIn − fee) and floors that: quote(amountIn − fee) ×
///      (1 − slippage). The fee is no longer subtracted from the output at all.
///   2. `plan.paths[i].amountIn` sum to the GROSS `plan.amountIn`, and the router scales each path
///      pro-rata by (amountIn − fee)/amountIn AT EXECUTION TIME. This is what keeps the dial's
///      no-re-approval property honest: a fee change landing between quote and execution re-splits the
///      route on-chain instead of invalidating a plan whose paths were summed for the old fee. Per-path
///      rounding is DOWN, so the scaled parts can leave a few wei unrouted; the sweep returns it to the
///      payer, and zero-residual holds.
///
/// The fee push FAILS OPEN, like the dial read: if the source token refuses to pay the treasury, the fee is
/// forgone and the FULL input is routed to the user instead. A fee misconfiguration can never block a swap.
contract MoleRouter is IUnlockCallback, Initializable, UUPSUpgradeable {
    /// @dev The v4 singleton. The router opens exactly one unlock per swap and does all venue work inside
    ///      it, so a route may freely mix v4 and v3 hops in a single atomic transaction.
    ///
    ///      NOTE: this and the four fields below were `immutable` in the pre-proxy router. Behind a proxy
    ///      an immutable lives in the IMPLEMENTATION's bytecode, not the proxy's storage, so it would be
    ///      silently re-set by every upgrade and read as zero until `initialize` ran. They are storage now.
    ///      Their ORDER IS PART OF THE ABI FOR EVERY FUTURE UPGRADE — append only, never reorder.
    IPoolManager public poolManager;

    /// @dev The wrapped-native token (WETH on Robinhood Chain). Native ETH is a wrapper at the EDGES only:
    ///      the router wraps incoming ETH to WETH before the first hop and unwraps the final WETH to ETH
    ///      after the last, so every pool ever sees an ERC-20 and the routing math never special-cases it.
    address public weth;

    /// @dev The sentinel a plan uses to mean "native ETH" for `tokenIn`/`tokenOut`. The de-facto standard
    ///      0xEeee… address, distinct from address(0) so a native leg can never be confused with an unset
    ///      field. The hops themselves always name the real WETH address — the sentinel lives only on the
    ///      plan's outer tokenIn/tokenOut.
    address internal constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @dev The fee dial — the ONLY mutable input to this contract, and only ever a number. address(0)
    ///      deploys the router permanently feeless.
    address public feeDial;

    /// @dev Where the fee goes. IMMUTABLE so a compromised dial key cannot redirect a wei; changing the
    ///      treasury means deploying a new router, which is the intended cost for that action.
    address public feeRecipient;

    /// @dev The hard ceiling on the fee, compiled in. The dial is clamped to this no matter what it
    ///      returns — the trust statement is "the fee can never exceed 1%", enforced by immutable code.
    uint256 public constant MAX_FEE_BPS = 100;
    uint256 internal constant BPS_DENOM = 10_000;
    /// @dev Gas ceiling for the dial staticcall: a plain storage read costs ~2.6k; anything that needs
    ///      more than this is not a fee dial and resolves to fee = 0.
    uint256 internal constant FEE_READ_GAS = 20_000;

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
    // The CEILING on what the active v3 swap may be made to pay, and the half the pin above was missing.
    //
    // WHY (audit 2026-08-23, F-08 mechanism A): the pool address in a hop is untrusted caller input, and
    // the v3 calling convention is "the pool tells us what we owe in a callback". Pinning only the TOKEN
    // bounded WHICH token a hostile pool could demand but not HOW MUCH — `amountIn` was not even in scope
    // inside `_payV3Callback`, so a fake pool could call back demanding the router's ENTIRE balance of the
    // pinned token and be paid it, then return (0,0). Worse, the callback may be invoked repeatedly inside
    // one `pool.swap()` (the active pin is only cleared after the call returns), so within a multi-path
    // route path 1's pool could consume path 2's slice. The budget is set to exactly the amount this hop
    // was allotted and is DECREMENTED as it is paid, so the cumulative demand across any number of
    // callback invocations can never exceed what the route declared for this one hop. A real V3 pool never
    // asks for more than the exact input it was offered, so this costs the honest path nothing.
    bytes32 private constant _ACTIVE_BUDGET_SLOT = keccak256("molerouter.active.budget");
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
    /// @dev A v3 pool's callback demanded more than the hop it belongs to was allotted. `budget` is what
    ///      remained of this hop's input after any earlier demand in the same `pool.swap()` call.
    error HopInputExceeded(uint256 demanded, uint256 budget);
    /// @dev msg.value must equal amountIn for a native-in swap, and be zero otherwise — no stray ETH.
    error BadValue();
    /// @dev Only WETH may send the router native ETH (during an unwrap). Everything else is refused.
    error UnexpectedEther();
    error NativeTransferFailed();

    error BadFeeConfig();

    /// @dev `amountIn` is the GROSS input the payer supplied; `fee` is what went to `feeRecipient`, in the
    ///      INPUT token (WETH for a native-in swap), so amountIn − fee is what was actually routed.
    ///      `amountOut` is the route's full output, all of which went to the recipient.
    event Swapped(
        address indexed payer,
        address indexed recipient,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee
    );

    error NotUpgradeAdmin();
    error OwnerRequired();

    /// @notice The key that can replace this implementation. See the upgrade section in the header: it can
    ///         replace every line of this contract, and every wallet that approved this router is exposed
    ///         up to its allowance. `transferUpgradeAdmin(address(0))` surrenders it permanently.
    address public upgradeAdmin;

    /// @dev The implementation must never be initializable in its own right — an attacker who initializes
    ///      a bare implementation owns nothing here (the proxy holds the state), but leaving it open is
    ///      free to close and removes a whole class of confusing findings.
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time setup behind the proxy. Carries the same fee-config proofs the immutable router
    ///         checked in its constructor — a mis-set dial is still a deploy-time failure, not a live bug.
    function initialize(IPoolManager _poolManager, address _weth, address _feeDial, address _feeRecipient, address _upgradeAdmin)
        external
        initializer
    {
        if (_upgradeAdmin == address(0)) revert OwnerRequired();
        upgradeAdmin = _upgradeAdmin;
        poolManager = _poolManager;
        weth = _weth;
        // Every plausible fee-config mistake fails the DEPLOY loudly here. (It is now fixable by upgrade
        // rather than permanent — but a misconfiguration that reaches users is still a misconfiguration,
        // and the cheapest place to catch it is before the proxy is ever pointed at.)
        if (_feeDial != address(0)) {
            // A codeless dial (a typo, or the router deployed before the dial) makes the gas-capped
            // staticcall return empty -> _feeBps silently resolves to 0 forever, so the router runs
            // permanently feeless with nothing on-chain to reveal the mistake. Require real code.
            if (_feeDial.code.length == 0) revert BadFeeConfig();
            // The fee push must land somewhere that accounts for it. address(0) reverts every fee-bearing
            // swap; the router itself strands the fee and breaks zero-residual; WETH or the PoolManager
            // would receive a raw, unaccounted mid-unlock transfer that is simply lost. All rejected.
            if (
                _feeRecipient == address(0) || _feeRecipient == address(this) || _feeRecipient == _weth
                    || _feeRecipient == address(_poolManager)
            ) revert BadFeeConfig();
        }
        feeDial = _feeDial;
        feeRecipient = _feeRecipient;
    }

    /// @dev The whole trust assumption, in one line. See the header.
    function _authorizeUpgrade(address) internal override {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
    }

    event UpgradeAdminTransferred(address indexed from, address indexed to);

    /// @notice Hand the upgrade key to somebody else — a multisig, a timelock, or **address(0) to give it
    ///         up permanently**, which makes this contract immutable and restores the guarantee an approval
    ///         target really wants: what you audit is what runs, forever. That is the intended end state
    ///         once the fee model has settled, and it is the only mechanical protection available here.
    /// @dev Deliberately one-step and deliberately allows address(0): a two-step handshake cannot express
    ///      "burn it", and burning is the option that matters most for this particular contract.
    /// @notice Rotate where the router's fee is paid. `upgradeAdmin` only.
    /// @dev `feeRecipient` was initializer-only on a UUPS proxy, so moving the fee destination to a
    ///      treasury multisig required shipping a new implementation. The validation mirrors
    ///      `initialize` exactly rather than approximately, and reuses its error: the destination must
    ///      not be zero (the fee would be burned on every swap), must not be this contract (the router
    ///      is supposed to hold nothing between transactions, and paying itself quietly breaks the
    ///      zero-residual invariant every test asserts), and must not be `weth` or the PoolManager,
    ///      because both are addresses the swap path already moves value to for other reasons.
    function setFeeRecipient(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        if (to == address(0) || to == address(this) || to == weth || to == address(poolManager)) {
            revert BadFeeConfig();
        }
        emit FeeRecipientSet(feeRecipient, to);
        feeRecipient = to;
    }

    event FeeRecipientSet(address indexed from, address indexed to);

    function transferUpgradeAdmin(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        emit UpgradeAdminTransferred(upgradeAdmin, to);
        upgradeAdmin = to;
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
    ///         Reverts unless the recipient nets at least `plan.minAmountOut` AFTER the aggregator fee.
    /// @return amountOut the post-fee output delivered to `plan.recipient` (native ETH if
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
        (uint256 userOut, uint256 fee) = abi.decode(result, (uint256, uint256));
        amountOut = userOut;

        // The promise is on what the RECIPIENT received, post-fee — so a quote that priced in the fee
        // is honoured exactly, and no fee configuration can quietly eat into the quoted floor.
        if (amountOut < plan.minAmountOut) revert InsufficientOutput(amountOut, plan.minAmountOut);

        emit Swapped(payer, plan.recipient, plan.tokenIn, plan.tokenOut, plan.amountIn, amountOut, fee);
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
        (uint256 userOut, uint256 fee) = _execute(plan, payer);
        return abi.encode(userOut, fee);
    }

    /// @dev The whole swap, run inside the unlock. Split into `_acquireInput` / `_deliverOutput` / `_sweep`
    ///      deliberately, and NOT only for readability: the combined function held enough locals that the
    ///      via_ir codegen at this project's optimizer_runs sat one variable from a Yul stack-too-deep — so
    ///      any later edit would tip it over. Keeping each frame small keeps the contract compilable as it
    ///      grows. `effIn`/`effOut` (the real ERC-20 behind a possible NATIVE sentinel) are the only
    ///      cross-cutting locals kept here; native-ness is re-derived cheaply inside the sub-calls.
    function _execute(SwapPlan memory plan, address payer) internal returns (uint256 userOut, uint256 fee) {
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

        // NATIVE ETH GETS THE SAME NET-CHANGE TREATMENT AS AN ERC-20 (audit 2026-08-23, F-10, router half).
        // `receive()` accepts ETH from anyone while the lock is held — i.e. from any hostile token, any
        // route-named "pool", or any v4 hook reached mid-swap — but `_sweep` only ever walked ERC-20s, so
        // ETH pushed in mid-swap sat here forever with no recovery path: dead value, and the standing
        // balance the F-08 drain existed to monetise. The baseline is deliberately the balance we came in
        // with MINUS this swap's own attached msg.value, not zero: sweeping the whole balance to the caller
        // would hand any force-fed ETH (SELFDESTRUCT, a block fee recipient) to whoever called next, which
        // is the same whole-balance-to-msg.sender shape the audit faults elsewhere. Net change only — so a
        // pre-existing native donation is preserved exactly as a pre-existing token airdrop is.
        uint256 nativeBase = address(this).balance - (plan.tokenIn == NATIVE ? plan.amountIn : 0);

        _acquireInput(plan, payer, effIn);

        // The fee comes off the INPUT, immediately after acquisition and before any hop runs, so the
        // treasury is paid in the source currency. Fails open: if the token refuses to pay the treasury,
        // `fee` stays 0 and the full input is routed to the user.
        fee = _takeInputFee(effIn, plan.amountIn);

        userOut = _deliverOutput(plan, effOut, _runPaths(plan, fee, effIn, effOut));

        _sweep(tokens, startBal, payer, plan.tokenIn == NATIVE || plan.tokenOut == NATIVE);

        // Last, because `_sweep`'s WETH leg unwraps and forwards and so passes through the native balance
        // on its way out. Anything still above the baseline arrived during this swap and belongs to the
        // payer, not to the contract.
        _sweepNative(nativeBase, payer);
    }

    /// @dev Return native ETH received during this swap to the payer. See the baseline's derivation in
    ///      `_execute`: this is a NET-CHANGE sweep, never a whole-balance one.
    function _sweepNative(uint256 base, address payer) internal {
        uint256 nowBal = address(this).balance;
        if (nowBal > base) _sendNative(payer, nowBal - base);
    }

    /// @dev Acquire the input AFTER the balance snapshot so it counts as this swap's own contribution.
    ///      Native: wrap the ETH that came attached to the call. ERC-20: pull from the payer.
    function _acquireInput(SwapPlan memory plan, address payer, address effIn) internal {
        if (plan.tokenIn == NATIVE) IWETH(weth).deposit{value: plan.amountIn}();
        else _pull(effIn, payer, plan.amountIn);
    }

    /// @dev Run every path against the POST-FEE budget, each scaled pro-rata by (amountIn − fee)/amountIn.
    ///      Rounding DOWN per path can leave a few wei unrouted; `_sweep` returns it to the payer, so
    ///      nothing strands. Scaling here rather than off-chain is what lets the fee dial move between
    ///      quote and execution without invalidating a plan whose paths were summed for the old fee.
    ///
    ///      Its own function, not an inlined loop, for the reason `_execute`'s header gives: the combined
    ///      frame sits one variable from a Yul stack-too-deep at this project's optimizer settings, and
    ///      adding `fee`/`routable` to it tipped it over during this change. Small frames keep the
    ///      contract compilable.
    ///      The scale is written into the path's own MEMORY copy rather than passed as an extra argument:
    ///      `plan` is already a memory decode, the calldata plan the payer signed is untouched, and it
    ///      keeps `_runPath`'s signature — and therefore its stack frame — exactly as it was.
    function _runPaths(SwapPlan memory plan, uint256 fee, address effIn, address effOut)
        internal
        returns (uint256 totalOut)
    {
        for (uint256 i = 0; i < plan.paths.length; ++i) {
            if (fee != 0) {
                plan.paths[i].amountIn = FullMath.mulDiv(plan.paths[i].amountIn, plan.amountIn - fee, plan.amountIn);
            }
            if (plan.paths[i].amountIn != 0) totalOut += _runPath(plan.paths[i], effIn, effOut);
        }
    }

    /// @dev Skim the aggregator fee from the INPUT, in the source currency (WETH for a native-in swap, so
    ///      the treasury handles one asset shape). Called after the input is acquired and before any hop,
    ///      so what routes is already net.
    ///
    ///      FAILS OPEN, exactly like the dial read: if the source token refuses to pay the treasury (e.g.
    ///      an issuer dynamically blacklists it — the one recipient failure a deploy-time guard cannot
    ///      catch), the fee is FORGONE for this swap and the full input is routed for the user instead of
    ///      reverting. So "a fee misconfiguration can never block a swap" holds on this leg too, and
    ///      zero-residual is preserved: the fee reaches the treasury OR is routed for the user, never
    ///      stranded here.
    ///
    ///      Rounding is DOWN, so the fee can never exceed feeBps of the input, and a dust input rounds to
    ///      a zero fee rather than eating the whole trade.
    function _takeInputFee(address effIn, uint256 amountIn) internal returns (uint256 fee) {
        uint256 rawFee = (amountIn * _feeBps()) / BPS_DENOM;
        if (rawFee == 0) return 0;
        // Never let the fee consume the entire input.
        //
        // DOCUMENTED MUTATION SURVIVOR, recorded rather than quietly kept (same treatment as MoleQueue's
        // `err.length` check and `refundOf`'s Settled gate). Deleting this line kills no test, and cannot:
        // `_feeBps()` clamps to MAX_FEE_BPS = 100 bps first, so `rawFee` is at most 1% of `amountIn` and
        // the condition is unreachable from any dial value, hostile or not. It is kept because it is the
        // only thing standing between a future MAX_FEE_BPS change and handing a payer's entire balance to
        // the treasury — the clamp and this guard fail independently, which is the point of having both.
        if (rawFee >= amountIn) return 0;
        return _tryPush(effIn, feeRecipient, rawFee) ? rawFee : 0;
    }

    /// @dev Deliver the tracked output — the per-hop total, NOT balanceOf, so an airdropped output token
    ///      cannot inflate what we claim to have produced (it is swept instead). The whole output belongs
    ///      to the recipient now that the fee is taken on the input side.
    ///      Native out: unwrap and forward; ERC-20 out: transfer directly.
    function _deliverOutput(SwapPlan memory plan, address effOut, uint256 totalOut)
        internal
        returns (uint256 userOut)
    {
        userOut = totalOut;
        if (userOut == 0) return 0;
        if (plan.tokenOut == NATIVE) {
            IWETH(weth).withdraw(userOut);
            _sendNative(plan.recipient, userOut);
        } else {
            _push(effOut, plan.recipient, userOut);
        }
    }

    /// @dev Read the fee from the dial, failing CLOSED TO ZERO: no dial, a reverting dial, a gas-burning
    ///      dial, or a malformed return all mean "no fee" — a fee misconfiguration must never be able to
    ///      block swaps. The clamp to MAX_FEE_BPS is the immutable half of the fee's trust story.
    function _feeBps() internal view returns (uint256 bps) {
        address dial = feeDial;
        if (dial == address(0)) return 0;
        (bool ok, bytes memory ret) = dial.staticcall{gas: FEE_READ_GAS}(abi.encodeWithSignature("feeBps()"));
        if (!ok || ret.length < 32) return 0;
        bps = abi.decode(ret, (uint256));
        if (bps > MAX_FEE_BPS) bps = MAX_FEE_BPS;
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
            // A hop that claims to swap a token for ITSELF is not a hop. It is also the one shape that
            // would make the v3 branch's measured output delta ambiguous — the payment and the proceeds
            // would net inside one balance read — so refusing it keeps that measurement meaning exactly
            // "what this hop produced". No real pool has token0 == token1, so nothing legitimate is lost.
            if (hop.tokenIn == hop.tokenOut) revert HopChainBroken();
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
        // MEASURE, DO NOT TAKE THE POOL'S WORD (audit 2026-08-23, F-08 mechanism B). `hop.pool` is an
        // arbitrary caller-supplied address; before this snapshot the hop's output was read straight out
        // of the return value of a call to that address. A contract that transfers nothing could therefore
        // DECLARE an output, and `_deliverOutput` would push that many tokens to the recipient out of the
        // router's own balance — a standing airdrop, a mis-sent transfer, or a future residual drained by
        // whoever noticed it first, with `minAmountOut = 0` waving the result through. Bracketing the call
        // with a balance read turns "what the pool says it paid" into "what the pool actually paid".
        uint256 outBefore = _balance(hop.tokenOut);
        // Pin the authorised pool, the token it may be paid, and the CEILING on how much of it (F-08 A).
        _setActive(hop.pool, hop.tokenIn, amountIn);
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
        // The negative delta is what the pool CLAIMS it paid us.
        int256 outDelta = hop.zeroForOne ? -amount1 : -amount0;
        if (outDelta < 0) revert HopChainBroken();

        // The claim is kept only as a CEILING, and the measurement decides. Both directions matter:
        //   - measured < claimed is the lie above, and taking the measurement refuses to hand out tokens
        //     the route never produced;
        //   - measured > claimed is the honest over-receive (a generous pool, or a token airdropped
        //     mid-swap), and keeping the claim is what stops an untracked windfall inflating the tracked
        //     output. `_sweep` returns the excess to the payer, exactly as it did before.
        uint256 nowBal = _balance(hop.tokenOut);
        uint256 measured = nowBal > outBefore ? nowBal - outBefore : 0;
        uint256 claimed = uint256(outDelta);
        amountOut = measured < claimed ? measured : claimed;
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
        uint256 owed;
        if (amount0Delta > 0) {
            owed = uint256(amount0Delta);
        } else if (amount1Delta > 0) {
            owed = uint256(amount1Delta);
        } else {
            return;
        }
        // AND NOT MORE THAN THIS HOP WAS ALLOTTED (audit 2026-08-23, F-08 mechanism A). The pin above
        // fixed the token; this fixes the amount. Before it, the only ceiling on a hostile pool's demand
        // was the router's whole balance of the pinned token, and the demand could be repeated inside one
        // `pool.swap()` because the pin is not cleared until the call returns — so a route's first path
        // could eat the second path's slice, and any standing balance was payable in full. An honest
        // exact-input pool asks for exactly what it was offered, so the honest path is untouched; the
        // budget is decremented rather than merely compared so repeats are bounded in aggregate.
        uint256 budget = _activeBudget();
        if (owed > budget) revert HopInputExceeded(owed, budget);
        _spendBudget(owed);
        _push(tokenIn, msg.sender, owed);
    }

    /// @dev A Uniswap v4 exact-input swap, inside the router's unlock. We owe the input currency (negative
    ///      delta) and are owed the output (positive delta); settle the first, take the second, so the
    ///      hop nets to zero v4 delta and the unlock can close.
    function _swapV4(Hop memory hop, uint256 amountIn) internal returns (uint256 amountOut) {
        // THE EXECUTED CURRENCIES MUST BE THE DECLARED ONES (audit 2026-08-23, F-09). `_runPath` verifies
        // the hop chain — first hop consumes the input, hop i feeds hop i+1, last hop produces the output —
        // and `_touchedTokens` builds the snapshot/sweep set, and BOTH read `hop.tokenIn`/`hop.tokenOut`.
        // This function used to read neither: it took the real currencies from `hop.key`, which is
        // unvalidated caller data, so the labels that were validated and the currencies that actually moved
        // were two different sets. That made the chain check and the zero-residual invariant vacuous on
        // this venue — a plan could declare (A, B), execute (C, D), pay out C from a balance nothing
        // snapshotted, and strand D forever because nothing swept it. Binding them here is what makes the
        // v4 branch as tight as the v3 one, where the payment token is pinned before the pool is called.
        // It costs the honest path nothing: the off-chain planner derives tokenIn/tokenOut from the very
        // currency ordering it puts in the key, so for a real route these are already equal.
        (Currency declaredIn, Currency declaredOut) = hop.zeroForOne
            ? (hop.key.currency0, hop.key.currency1)
            : (hop.key.currency1, hop.key.currency0);
        if (Currency.unwrap(declaredIn) != hop.tokenIn || Currency.unwrap(declaredOut) != hop.tokenOut) {
            revert HopChainBroken();
        }

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

        // AND NOT MORE THAN THIS HOP WAS ALLOTTED — the v4 twin of the v3 callback budget, and the second
        // half of F-09. `amountIn` used to appear only in `amountSpecified` and never bounded what we then
        // paid, while the guard above rejects only a POSITIVE owed. `hop.key.hooks` is attacker-supplied,
        // and a hook carrying BEFORE_SWAP_RETURNS_DELTA has its returned delta applied to the swapper's
        // deltas by v4-core — so `owed` is hook-controlled, not pool-math-controlled, and could be made
        // arbitrarily negative to make `_settle` hand an attacker-chosen amount to the PoolManager where
        // the hook collects it. An exact-input swap can never legitimately spend more than it specified.
        uint256 spend = uint256(uint128(-owed));
        if (spend > amountIn) revert HopInputExceeded(spend, amountIn);

        _settle(inCur, spend);
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

    /// @dev Non-reverting transfer, used ONLY for the aggregator-fee leg so a recipient the output token
    ///      refuses to pay forgoes the fee instead of blocking the swap. Returns whether it succeeded; the
    ///      caller folds a failed fee back into the user's output, so no value is ever stranded.
    function _tryPush(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
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

    /// @dev Pin the pool, the token it may be paid, AND the most it may be paid — all three before the
    ///      pool can call back. See `_ACTIVE_BUDGET_SLOT` for why the third one is load-bearing.
    function _setActive(address pool, address tokenIn, uint256 budget) internal {
        bytes32 poolSlot = _ACTIVE_POOL_SLOT;
        bytes32 inSlot = _ACTIVE_IN_SLOT;
        bytes32 budgetSlot = _ACTIVE_BUDGET_SLOT;
        assembly ("memory-safe") {
            tstore(poolSlot, pool)
            tstore(inSlot, tokenIn)
            tstore(budgetSlot, budget)
        }
    }

    function _clearActive() internal {
        bytes32 poolSlot = _ACTIVE_POOL_SLOT;
        bytes32 inSlot = _ACTIVE_IN_SLOT;
        bytes32 budgetSlot = _ACTIVE_BUDGET_SLOT;
        assembly ("memory-safe") {
            tstore(poolSlot, 0)
            tstore(inSlot, 0)
            tstore(budgetSlot, 0)
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

    function _activeBudget() internal view returns (uint256 budget) {
        bytes32 slot = _ACTIVE_BUDGET_SLOT;
        assembly ("memory-safe") {
            budget := tload(slot)
        }
    }

    /// @dev Spend against the active hop's budget. Writing the remainder back is what makes the ceiling
    ///      CUMULATIVE across repeated callback invocations inside a single `pool.swap()`, rather than a
    ///      per-invocation limit a pool could simply ask for twice.
    function _spendBudget(uint256 amount) internal {
        bytes32 slot = _ACTIVE_BUDGET_SLOT;
        assembly ("memory-safe") {
            tstore(slot, sub(tload(slot), amount))
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
