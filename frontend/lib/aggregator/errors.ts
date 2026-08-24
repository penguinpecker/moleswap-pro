/**
 * errors.ts — turn a revert into a sentence a person can act on.
 *
 * A swap through MoleRouter can fail in four layers and every one of them speaks in 4-byte selectors: the
 * router's own custom errors (src/MoleRouter.sol), Uniswap v4 core (PoolManager / Pool / TickBitmap / Hooks /
 * TickMath / SqrtPriceMath …), our MoleHook, and the ERC-20s at the edges (OpenZeppelin typed errors, the
 * classic `Error(string)` reasons, Solidity panics). Left undecoded they all present as "transaction
 * failed", and support cannot tell a protection from a bug.
 *
 * THE VAULT IS THE SECOND SURFACE, and the one where the distinction matters most. MolePositions (with
 * ZapLogic, the deposit library it delegatecalls) and MoleQueue speak the same four bytes, but most of what
 * they raise is a LIMIT FIRING, not a fault: the position-size band, the range-width band, spot-versus-TWAP,
 * the per-pool cap, the keeper's cadence, a caller's own withdrawal floor. Undecoded those read as a broken
 * app; decoded badly they read as an accusation. Each sentence below therefore names the limit that fired,
 * says whether anything moved, and says what the depositor can do next.
 *
 * SELECTORS COLLIDE ACROSS CONTRACTS. `DeadlinePassed()`, `TransferFailed()`, `NotPoolManager()`,
 * `NotUpgradeAdmin()`, `OwnerRequired()` and `UnexpectedCallback()` are declared by the router AND the vault
 * AND the queue, and on the wire they are the same four bytes with nothing to say which raised them. A caller that
 * knows which contract it called passes `prefer` in the context and reads that contract's wording; without
 * it the lookup order decides, which keeps every existing swap message exactly as it was.
 *
 * THE GAS TOKEN IS NOT ALWAYS CALLED ETH. Robinhood 4663 pays gas in ETH; Arc 5042 pays it in USDC and has
 * no WETH at all. The six sentences that name it therefore take it from `ctx.native` instead of typing it,
 * because "top up ETH" on Arc sends someone hunting for an asset that chain does not have — and offering to
 * "receive WETH instead" points at a contract that does not exist. Both fall back to ETH/WETH when the caller
 * names no chain, so a swap that passes no context reads exactly as it always did.
 *
 * Every selector here is DERIVED from an ABI signature (`parseAbi` + viem's selector matching), never typed
 * as hex — tests/aggregator/errors.decode.test.ts checks the signatures against the Solidity sources in this
 * repo, so an error added to a contract without a sentence here fails the suite. The raw revert data is always
 * carried alongside the sentence so a disclosure can show it.
 *
 * Two entry points:
 *   decodeRevertData(hex)   — pure: revert bytes → DecodedFailure (recurses into ERC-7751 WrappedError).
 *   decodeSwapFailure(err)  — anything thrown by viem / a JSON-RPC call / a wallet → DecodedFailure, by first
 *                             digging the revert bytes out of the error and otherwise classifying the message
 *                             (wallet rejection, insufficient gas, transport).
 */

import { decodeErrorResult, formatUnits, parseAbi, type Hex } from "viem";

export type FailureSource =
  | "router"
  | "v4"
  | "hook"
  | "vault"
  | "zap"
  | "queue"
  | "erc20"
  | "evm"
  | "wallet"
  | "transport"
  | "preflight"
  | "unknown";

export interface DecodedFailure {
  /** Stable machine code, e.g. "router.InsufficientOutput", "v4.TickLiquidityOverflow", "evm.panic.0x11". */
  readonly code: string;
  /** Which layer raised it. */
  readonly source: FailureSource;
  /** Short headline, e.g. "Price moved past your minimum". */
  readonly title: string;
  /** Plain-language explanation, with the suggested action folded in. */
  readonly message: string;
  /** The raw revert data (hex) or the original message, always present for the disclosure. */
  readonly raw: string;
  /** The typed error's name and decoded arguments when one matched. */
  readonly errorName?: string;
  readonly args?: readonly unknown[];
  /** For an ERC-7751 WrappedError: the decoded inner reason. */
  readonly inner?: DecodedFailure;
  /** True when a first-party guard (our hook / router invariant) refused the swap: a protection, not a bug. */
  readonly isProtection?: boolean;
}

/** Optional token context so amounts in messages come out in human units. */
export interface DecodeContext {
  readonly tokenIn?: { symbol?: string; decimals?: number };
  readonly tokenOut?: { symbol?: string; decimals?: number };
  /**
   * Which contract was called, when the caller knows — the vault page knows it is talking to MolePositions,
   * the queue page to MoleQueue. Only the handful of selectors declared by more than one contract change
   * their reading: a bare `DeadlinePassed()` from the vault otherwise inherits the router's "refresh the
   * quote" phrasing, because the revert itself carries nothing that could tell them apart.
   */
  readonly prefer?: FailureSource;
  /**
   * What this chain calls its gas token, for the handful of sentences that name it. "ETH" is right on
   * Robinhood 4663 and WRONG on Arc 5042, where gas is paid in USDC and telling someone to top up ETH sends
   * them looking for an asset the chain does not have. Pass `chainMetaFor(chainId)` 's `nativeSymbol` here.
   *
   * `wrapped` is the name of the wrapped form, and it is fail-closed on purpose: naming a `native` without a
   * `wrapped` means this chain has no wrapper, so the "receive WETH instead" advice disappears rather than
   * pointing at a contract that does not exist. Arc is exactly that case — there is no WETH, and the router's
   * weth slot is pinned to the USDC ERC-20 so native paths fail closed.
   *
   * Omitted entirely, both fall back to ETH/WETH, which is what every swap message said before this existed.
   */
  readonly native?: { symbol?: string; wrapped?: string | null };
}

/* ----------------------------------------------------------------------------------- the registries */

/** src/MoleRouter.sol — the executor's own errors, in declaration order. */
export const ROUTER_ERROR_ABI = parseAbi([
  "error Locked()",
  "error DeadlinePassed()",
  "error NothingToSwap()",
  "error PathSumMismatch(uint256 declared, uint256 summed)",
  "error EmptyPath()",
  "error HopChainBroken()",
  "error HopInputExceeded(uint256 paid, uint256 cap)",
  "error InsufficientOutput(uint256 got, uint256 minOut)",
  "error NotPoolManager()",
  "error UnexpectedCallback()",
  "error ZeroRecipient()",
  "error SameToken()",
  "error TransferFailed()",
  "error PayerReentrancy()",
  "error BadValue()",
  "error UnexpectedEther()",
  "error NativeTransferFailed()",
  "error BadFeeConfig()",
  "error NotUpgradeAdmin()",
  "error OwnerRequired()",
]);

/** src/MoleHook.sol — the first-party hook. A revert here is a guard doing its job. */
export const HOOK_ERROR_ABI = parseAbi([
  "error NotPoolManager()",
  "error NotPoolCreator()",
  "error FeeMustBeDynamic()",
  "error BadFeeBounds()",
  "error BadHookAddress()",
  "error LiquidityNotAllowed()",
  "error PoolNotInitialized()",
  "error InsufficientObservations()",
  "error NotUpgradeAdmin()",
  "error PoolCreatorRequired()",
]);

/** lib/v4-core/src — every custom error the singleton and its libraries can raise (non-test sources). */
export const V4_ERROR_ABI = parseAbi([
  // interfaces/IPoolManager.sol
  "error CurrencyNotSettled()",
  "error PoolNotInitialized()",
  "error AlreadyUnlocked()",
  "error ManagerLocked()",
  "error TickSpacingTooLarge(int24 tickSpacing)",
  "error TickSpacingTooSmall(int24 tickSpacing)",
  "error CurrenciesOutOfOrderOrEqual(address currency0, address currency1)",
  "error UnauthorizedDynamicLPFeeUpdate()",
  "error SwapAmountCannotBeZero()",
  "error NonzeroNativeValue()",
  "error MustClearExactPositiveDelta()",
  // interfaces/IProtocolFees.sol
  "error ProtocolFeeTooLarge(uint24 fee)",
  "error InvalidCaller()",
  "error ProtocolFeeCurrencySynced()",
  // libraries/Pool.sol
  "error TicksMisordered(int24 tickLower, int24 tickUpper)",
  "error TickLowerOutOfBounds(int24 tickLower)",
  "error TickUpperOutOfBounds(int24 tickUpper)",
  "error TickLiquidityOverflow(int24 tick)",
  "error PoolAlreadyInitialized()",
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)",
  "error NoLiquidityToReceiveFees()",
  "error InvalidFeeForExactOut()",
  // libraries/TickBitmap.sol
  "error TickMisaligned(int24 tick, int24 tickSpacing)",
  // libraries/Hooks.sol
  "error HookAddressNotValid(address hooks)",
  "error InvalidHookResponse()",
  "error HookCallFailed()",
  "error HookDeltaExceedsSwapAmount()",
  // libraries/CustomRevert.sol (ERC-7751)
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  // libraries/TickMath.sol
  "error InvalidTick(int24 tick)",
  "error InvalidSqrtPrice(uint160 sqrtPriceX96)",
  // libraries/SqrtPriceMath.sol
  "error InvalidPriceOrLiquidity()",
  "error InvalidPrice()",
  "error NotEnoughLiquidity()",
  "error PriceOverflow()",
  // libraries/LPFeeLibrary.sol
  "error LPFeeTooLarge(uint24 fee)",
  // libraries/SafeCast.sol
  "error SafeCastOverflow()",
  // libraries/Position.sol
  "error CannotUpdateEmptyPosition()",
  // NoDelegateCall.sol
  "error DelegateCallNotAllowed()",
  // types/Currency.sol
  "error NativeTransferFailed()",
  "error ERC20TransferFailed()",
]);

/** Common ERC-20 typed errors: OpenZeppelin v5 (IERC20Errors / SafeERC20) and the solady/solmate family. */
export const ERC20_ERROR_ABI = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
  "error SafeERC20FailedOperation(address token)",
  "error InsufficientBalance()",
  "error InsufficientAllowance()",
  "error TransferFromFailed()",
  "error ApproveFailed()",
  "error AllowanceOverflow()",
  "error AllowanceUnderflow()",
  "error TotalSupplyOverflow()",
  "error EnforcedPause()",
]);

/**
 * src/MolePositions.sol — the ALM vault. Live on Robinhood 4663 and Arc 5042, and the surface a depositor
 * touches directly, so this is the registry that decides whether a working guard reads as a working guard.
 * In declaration order, which is also roughly the order they were added to the contract.
 */
export const VAULT_ERROR_ABI = parseAbi([
  "error NotOwner()",
  "error NotKeeper()",
  "error NotPoolManager()",
  "error PoolNotWhitelisted()",
  "error NoSuchPosition()",
  "error ZeroLiquidity()",
  "error InsufficientLiquidity()",
  "error RebalanceTooSoon()",
  "error RangeWidthOutOfBounds()",
  "error TicksMisordered()",
  "error TickNotOnSpacing()",
  "error PoolAlreadyWhitelisted()",
  "error TransferFailed()",
  "error RebalanceNotSelfFunding()",
  "error HookNotPermitted()",
  "error WithdrawalWouldBeBlockable()",
  "error InvalidTickSpacing()",
  "error DeadlinePassed()",
  "error ExceedsMaxAmount()",
  "error DwellNotElapsed()",
  "error DepositWouldBeTaxable()",
  "error RangeTooFarFromTwap()",
  "error RebalanceBudgetExhausted()",
  "error EjectionTooLarge()",
  "error RecenterTooFar()",
  "error FeeAboveCeiling()",
  "error FeeRecipientRequired()",
  "error FeeRecipientCannotBeThisContract()",
  "error DepositAccruedFees()",
  "error NativeCurrencyNotSupported()",
  "error PositionTooSmall()",
  "error PositionTooLarge()",
  "error KeeperRevokedForPosition()",
  "error CapAboveCeiling()",
  "error KeeperExpired()",
  "error NativeRefundFailed()",
  "error OwnerRequired()",
  "error BadRangeBounds()",
  "error BadTwapDeviation()",
  "error TwapBoundNeedsAnOracle()",
  "error BadEjectionCap()",
  "error BadRecenterCap()",
  "error MintedBelowMinimum()",
  "error SpotTooFarFromTwap()",
  "error PoolTooLarge()",
  "error UnexpectedNativeValue()",
  "error NativeValueOverspent()",
  "error UnexpectedCallback()",
  "error WithdrawBelowMinimum()",
  "error NotUpgradeAdmin()",
]);

/**
 * src/libraries/ZapLogic.sol — the one-token deposit and the rebalance re-mint, an EXTERNAL library the
 * vault reaches by delegatecall. It executes in the vault's context, so these arrive from the vault's
 * address and are indistinguishable from the vault's own; five of the seven are declared in both contracts
 * and resolve to the vault's wording, which is why only `NotSelfFunding` and `SwapOutputBelowMinimum` can
 * ever reach a user under this group.
 */
export const ZAP_ERROR_ABI = parseAbi([
  "error ZeroLiquidity()",
  "error SwapOutputBelowMinimum()",
  "error DepositAccruedFees()",
  "error NotSelfFunding()",
  "error TransferFailed()",
  "error RebalanceNotSelfFunding()",
  "error EjectionTooLarge()",
]);

/**
 * src/MoleQueue.sol — the batch auction, Robinhood-only by deployment (there is no queue on Arc). Its
 * settlement guards are the unusual case in this file: they fire on a batch nobody in particular did
 * anything wrong in, and the honest reading is always the same one — the batch does not settle, it times
 * out, and every deposit comes back in kind.
 */
export const QUEUE_ERROR_ABI = parseAbi([
  "error WrongPhase()",
  "error ZeroAmount()",
  "error NotOrderOwner()",
  "error AlreadyWithdrawn()",
  "error TooEarly()",
  "error NotTimedOut()",
  "error NothingToSettle()",
  "error TransferFailed()",
  "error NotPoolManager()",
  "error TwapTooFarFromSpot()",
  "error ResidualSwapTooFarFromTwap()",
  "error ResidualShortFill()",
  "error ResidualSwapFailed()",
  "error NotUpgradeAdmin()",
  "error TwapBandRequired()",
  "error BadSlippageBps()",
  "error BadDurations()",
  "error LifeMustOutlastFreeze()",
  "error UpgradeAdminRequired()",
  "error UnsupportedCurrency()",
  "error EscrowNotReceived()",
  "error OracleTooStale()",
  "error ClearingJumpTooLarge()",
  "error InsufficientPoolDepth()",
  "error UnlockNotInitiated()",
  "error SettleWindowClosed()",
  "error BadGuardParams()",
]);

/** Solidity's own: `Error(string)` and `Panic(uint256)`. */
export const SOLIDITY_ERROR_ABI = parseAbi(["error Error(string reason)", "error Panic(uint256 code)"]);

/* ------------------------------------------------------------------------------------- explanations */

type Explain = {
  /** A function only where the headline names the gas token, which is not the same word on every chain. */
  readonly title: string | ((ctx: DecodeContext) => string);
  readonly message: (args: readonly unknown[], ctx: DecodeContext, inner?: DecodedFailure) => string;
  readonly protection?: boolean;
};

const titleOf = (t: Explain["title"] | undefined, ctx: DecodeContext): string | undefined =>
  typeof t === "function" ? t(ctx) : t;

/** The gas token's name, ETH unless the caller named the chain's own. */
const nat = (ctx: DecodeContext): string => ctx.native?.symbol ?? "ETH";
/** The wrapped form's name, or null on a chain that has none — see DecodeContext.native for why absence wins. */
const wrapped = (ctx: DecodeContext): string | null => (ctx.native ? (ctx.native.wrapped ?? null) : "WETH");

const fmtAmt = (v: unknown, t?: { symbol?: string; decimals?: number }): string => {
  if (typeof v !== "bigint") return String(v);
  const human = typeof t?.decimals === "number" ? formatUnits(v, t.decimals) : v.toString();
  return t?.symbol ? `${human} ${t.symbol}` : human;
};
const short = (a: unknown) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a));

const ROUTER_EXPLAIN: Record<string, Explain> = {
  Locked: { title: "Router busy", message: () => "The router was already inside a swap in this transaction. Retry the swap on its own." },
  DeadlinePassed: { title: "Quote expired", message: () => "This quote's deadline passed before it could execute. Go back and refresh the quote, then retry." },
  NothingToSwap: { title: "Nothing to swap", message: () => "The swap amount is zero. Enter an amount." },
  PathSumMismatch: {
    title: "Malformed route",
    message: ([declared, summed]) => `The route's parts (${String(summed)}) do not add up to its input (${String(declared)}). This is a quoting defect on our side, not a market problem — refresh the quote; if it persists, report it.`,
  },
  EmptyPath: { title: "Malformed route", message: () => "The route contains an empty path. This is a quoting defect on our side — refresh the quote; if it persists, report it." },
  HopChainBroken: { title: "Route could not be executed", message: () => "A hop in the route did not connect to the next, or a pool returned less than it should. Refresh the quote and retry; if it persists, report it." },
  // A per-hop input cap, added with audit finding F-08: the router calls a caller-supplied v3 pool and
  // the pool's own callback names the amount to be paid. Without a cap a hostile pool could name any
  // number the router was holding. Seeing this means a pool asked for more than its hop declared.
  HopInputExceeded: { title: "A pool asked for more than the route allowed", message: () => "One venue in this route tried to take more input than the quote allocated to it, so the swap was refused and nothing moved. Refresh the quote and retry; if it persists on the same route, report it." },
  InsufficientOutput: {
    title: "Price moved past your minimum",
    message: ([got, minOut], ctx) => `Price moved — the route would deliver ${fmtAmt(got, ctx.tokenOut)}, below your minimum of ${fmtAmt(minOut, ctx.tokenOut)}. Increase slippage, try a smaller amount, or refresh and retry.`,
    protection: true,
  },
  NotPoolManager: { title: "Unexpected caller", message: () => "Something other than the pool manager tried to drive the router's callback. The swap was refused for safety.", protection: true },
  UnexpectedCallback: { title: "Unexpected callback", message: () => "A pool called the router out of turn. The swap was refused for safety.", protection: true },
  ZeroRecipient: { title: "Invalid recipient", message: () => "The recipient address is invalid (zero or the router itself). Check the recipient and retry." },
  SameToken: { title: "Same asset on both sides", message: () => "The input and output resolve to the same asset. Pick two different tokens." },
  TransferFailed: { title: "Token transfer failed", message: () => "A token transfer failed. The usual causes: not enough balance, no allowance for the router, or a token that blocks transfers (fee-on-transfer, paused, blocklist). Check your balance and approval." },
  PayerReentrancy: { title: "Re-entrant payer refused", message: () => "The payer re-entered the router during a swap. Refused for safety.", protection: true },
  BadValue: {
    title: (c) => `${nat(c)} amount mismatch`,
    message: (_a, c) => `The ${nat(c)} attached to the transaction does not match the swap: a native-${nat(c)} swap must send exactly the input amount, a token swap must send none.`,
  },
  UnexpectedEther: { title: (c) => `${nat(c)} sent outside a swap`, message: (_a, c) => `${nat(c)} was sent to the router outside a swap and was refused.`, protection: true },
  NativeTransferFailed: {
    title: (c) => `Could not deliver ${nat(c)}`,
    message: (_a, c) => {
      const w = wrapped(c);
      return `The recipient could not receive ${nat(c)} (it rejects plain transfers). Use a different recipient${w ? ` or receive ${w} instead` : ""}.`;
    },
  },
  BadFeeConfig: { title: "Router fee configuration error", message: () => "The router's fee configuration is invalid. This is an operator problem, not yours — try again later." },
  NotUpgradeAdmin: { title: "Not authorised", message: () => "Only the router's upgrade admin may do that." },
  OwnerRequired: { title: "Owner required", message: () => "The router needs an owner to be set." },
};

const HOOK_EXPLAIN: Record<string, Explain> = {
  NotPoolManager: { title: "Hook refused the caller", message: () => "Only the pool manager may call the hook directly. Refused for safety.", protection: true },
  NotPoolCreator: { title: "Pool creator only", message: () => "Only the pool's creator may do that on this pool.", protection: true },
  FeeMustBeDynamic: { title: "Pool must use a dynamic fee", message: () => "This hook only serves dynamic-fee pools; the pool key's fee is not the dynamic sentinel.", protection: true },
  BadFeeBounds: { title: "Invalid fee bounds", message: () => "The hook's fee bounds are invalid." },
  BadHookAddress: { title: "Hook address mismatch", message: () => "The hook's address does not carry the permissions it needs. This pool cannot be used." },
  LiquidityNotAllowed: { title: "Liquidity restricted", message: () => "Only the vault may add liquidity to this pool. Deposits go through the vault, not the pool directly.", protection: true },
  PoolNotInitialized: { title: "Pool not initialised", message: () => "This pool has no price yet. Pick another route." },
  InsufficientObservations: { title: "Price oracle warming up", message: () => "The pool's price oracle has too little history yet to answer. Try again in a few minutes.", protection: true },
  NotUpgradeAdmin: { title: "Not authorised", message: () => "Only the hook's upgrade admin may do that." },
  PoolCreatorRequired: { title: "Pool creator cannot be zero", message: () => "The pool creator role cannot be handed to the zero address — that would freeze the liquidity allowlist, not renounce it.", protection: true },
};

const V4_EXPLAIN: Record<string, Explain> = {
  CurrencyNotSettled: { title: "Pool books left unbalanced", message: () => "The swap ended with the pool manager's books unbalanced — a hop did not settle what it owed. The route was refused; refresh and retry, and report it if it persists." },
  PoolNotInitialized: { title: "Pool not initialised", message: () => "This pool has no price yet. Pick another route." },
  AlreadyUnlocked: { title: "Pool manager already unlocked", message: () => "The pool manager was already unlocked by this transaction. Retry." },
  ManagerLocked: { title: "Pool manager locked", message: () => "The pool manager was locked when the swap tried to run. Retry." },
  TickSpacingTooLarge: { title: "Invalid pool key", message: ([s]) => `The pool's tick spacing (${String(s)}) is too large. This pool cannot be used.` },
  TickSpacingTooSmall: { title: "Invalid pool key", message: ([s]) => `The pool's tick spacing (${String(s)}) is too small. This pool cannot be used.` },
  CurrenciesOutOfOrderOrEqual: { title: "Invalid pool key", message: ([a, b]) => `The pool's currencies are out of order or equal (${short(a)}, ${short(b)}). This pool key cannot be used.` },
  UnauthorizedDynamicLPFeeUpdate: { title: "Unauthorised fee update", message: () => "Only the pool's hook may change its dynamic fee." },
  SwapAmountCannotBeZero: { title: "Amount too small", message: () => "A hop in this route tried to swap zero — the amount is too small to split this way. Try a larger amount." },
  NonzeroNativeValue: { title: (c) => `${nat(c)} attached to a token settlement`, message: (_a, c) => `${nat(c)} was attached to a token settlement. Refresh the quote and retry.` },
  MustClearExactPositiveDelta: { title: "Settlement mismatch", message: () => "The pool manager was asked to clear a different amount than it was owed. Refresh and retry." },
  ProtocolFeeTooLarge: { title: "Protocol fee too large", message: () => "A protocol fee above the cap was requested. Operator problem, not yours." },
  InvalidCaller: { title: "Not authorised", message: () => "Only the protocol-fee controller may do that." },
  ProtocolFeeCurrencySynced: { title: "Currency is synced", message: () => "The protocol fee cannot be collected for a currency that is mid-settlement." },
  TicksMisordered: { title: "Invalid range", message: ([l, u]) => `The position's range is reversed (${String(l)} ≥ ${String(u)}). Pick a lower tick below the upper one.` },
  TickLowerOutOfBounds: { title: "Invalid range", message: ([l]) => `The lower tick (${String(l)}) is below the minimum tick.` },
  TickUpperOutOfBounds: { title: "Invalid range", message: ([u]) => `The upper tick (${String(u)}) is above the maximum tick.` },
  TickLiquidityOverflow: {
    title: "Too much liquidity at one tick",
    message: ([t]) => `Too much liquidity is already stacked at tick ${String(t)} — the pool refuses more positions on that tick (a known Uniswap v4 limit). Pick a slightly different range.`,
  },
  PoolAlreadyInitialized: { title: "Pool already exists", message: () => "This pool has already been initialised. Use it rather than creating it again." },
  PriceLimitAlreadyExceeded: { title: "Price already past the limit", message: () => "The pool's price is already past the swap's price limit — the pool cannot move further in that direction. Refresh the quote and retry." },
  PriceLimitOutOfBounds: { title: "Price limit out of range", message: () => "The swap's price limit is outside the valid price range. Refresh the quote." },
  NoLiquidityToReceiveFees: { title: "No liquidity to receive fees", message: () => "The pool has no liquidity to receive a donation." },
  InvalidFeeForExactOut: { title: "Exact-output not possible", message: () => "A pool with a 100% fee cannot quote an exact output." },
  TickMisaligned: { title: "Tick not on the pool's spacing", message: ([t, s]) => `Tick ${String(t)} is not a multiple of the pool's spacing ${String(s)}. The range or route is malformed.` },
  HookAddressNotValid: { title: "Pool hook invalid", message: ([h]) => `The pool's hook (${short(h)}) does not match its declared permissions. This pool cannot be used.` },
  InvalidHookResponse: { title: "Hook returned garbage", message: () => "The pool's hook returned an invalid response. Avoid this pool." },
  HookCallFailed: { title: "Hook rejected the swap", message: (_a, _c, inner) => inner ? `The pool's hook rejected this swap: ${inner.message}` : "The pool's hook rejected this swap." },
  HookDeltaExceedsSwapAmount: { title: "Hook over-charged", message: () => "The pool's hook tried to take more than the swap amount. Refused." },
  WrappedError: {
    title: "Call inside the pool failed",
    message: (args, _c, inner) => {
      const target = short(args[0]);
      return inner ? `A call to ${target} inside the pool failed: ${inner.message}` : `A call to ${target} inside the pool failed without a reason.`;
    },
  },
  InvalidTick: { title: "Invalid tick", message: ([t]) => `Tick ${String(t)} is outside the valid range.` },
  InvalidSqrtPrice: { title: "Invalid price", message: () => "A price value is outside the valid range." },
  InvalidPriceOrLiquidity: { title: "Invalid price or liquidity", message: () => "The pool math was given an invalid price or zero liquidity. Refresh the quote." },
  InvalidPrice: { title: "Invalid price", message: () => "The pool math was given an invalid price. Refresh the quote." },
  NotEnoughLiquidity: { title: "Not enough liquidity", message: () => "The pool does not have enough liquidity for this trade size. Try a smaller amount or a different route." },
  PriceOverflow: { title: "Trade far too large", message: () => "The price math overflowed — this trade is far too large for the pool. Try a smaller amount." },
  LPFeeTooLarge: { title: "LP fee too large", message: ([f]) => `The pool's LP fee (${String(f)}) is above the maximum.` },
  SafeCastOverflow: { title: "Amount overflow", message: () => "A number overflowed inside the pool math — the trade is too large for this pool. Try a smaller amount." },
  CannotUpdateEmptyPosition: { title: "Empty position", message: () => "The position has no liquidity to update." },
  DelegateCallNotAllowed: { title: "Delegatecall refused", message: () => "The pool manager refuses delegatecalls." },
  NativeTransferFailed: { title: (c) => `${nat(c)} transfer from the pool failed`, message: (_a, c, inner) => inner ? `The pool could not send ${nat(c)}: ${inner.message}` : `The pool could not send ${nat(c)} to its destination.` },
  ERC20TransferFailed: { title: "Token transfer out of the pool failed", message: (_a, _c, inner) => inner ? `A token transfer out of the pool failed: ${inner.message}` : "A token transfer out of the pool failed — the token may block transfers or be paused." },
};

const ERC20_EXPLAIN: Record<string, Explain> = {
  ERC20InsufficientBalance: { title: "Insufficient balance", message: ([, bal, need], ctx) => `Not enough balance: you hold ${fmtAmt(bal, ctx.tokenIn)}, the swap needs ${fmtAmt(need, ctx.tokenIn)}.` },
  ERC20InvalidSender: { title: "Token rejects the sender", message: ([a]) => `The token refuses transfers from ${short(a)}.` },
  ERC20InvalidReceiver: { title: "Token rejects the recipient", message: ([a]) => `The token refuses transfers to ${short(a)}.` },
  ERC20InsufficientAllowance: { title: "Allowance too low", message: ([, al, need], ctx) => `The router's allowance is ${fmtAmt(al, ctx.tokenIn)} but the swap needs ${fmtAmt(need, ctx.tokenIn)}. Approve the router for at least that amount.` },
  ERC20InvalidApprover: { title: "Token rejects the approver", message: ([a]) => `The token refuses approvals from ${short(a)}.` },
  ERC20InvalidSpender: { title: "Token rejects the spender", message: ([a]) => `The token refuses ${short(a)} as a spender.` },
  SafeERC20FailedOperation: { title: "Token call failed", message: ([t]) => `A call to token ${short(t)} failed.` },
  InsufficientBalance: { title: "Insufficient balance", message: () => "Not enough token balance for this swap." },
  InsufficientAllowance: { title: "Allowance too low", message: () => "The router's allowance is too low. Approve the router and retry." },
  TransferFromFailed: { title: "Token pull failed", message: () => "The token refused the transfer from your wallet — check balance and allowance." },
  ApproveFailed: { title: "Approval failed", message: () => "The token refused the approval." },
  AllowanceOverflow: { title: "Allowance overflow", message: () => "The allowance arithmetic overflowed." },
  AllowanceUnderflow: { title: "Allowance too low", message: () => "The allowance is lower than the amount being spent. Approve the router and retry." },
  TotalSupplyOverflow: { title: "Supply overflow", message: () => "The token's total supply overflowed." },
  EnforcedPause: { title: "Token paused", message: () => "The token is paused and cannot be transferred right now." },
};

/**
 * MolePositions. Read the `protection` flags as the point of this map rather than a detail: a depositor who
 * trips the size band, the width band, the TWAP band or the pool cap has met a limit that is doing its job,
 * and a sentence that does not say so turns a working guard into a bug report. Everything an operator sets
 * and a user cannot influence says so plainly instead of offering an action nobody can take.
 */
const VAULT_EXPLAIN: Record<string, Explain> = {
  NotOwner: { title: "Not your position", message: () => "This position belongs to a different wallet, so this one cannot withdraw from it or change it. Switch to the wallet that opened it.", protection: true },
  NotKeeper: { title: "Keeper only", message: () => "Only the vault's keeper can move a position to a new range. Your own deposits and withdrawals never need it.", protection: true },
  NotPoolManager: { title: "Unexpected caller", message: () => "Something other than the pool manager tried to drive the vault's callback. Refused for safety; nothing moved.", protection: true },
  PoolNotWhitelisted: { title: "Pool not open for deposits", message: () => "The vault only manages pools it has been listed for, and this is not one of them. Pick a pool from the vault's list." },
  NoSuchPosition: { title: "Position not found", message: () => "There is no position with that id — most often it was already withdrawn in full. Reload to refresh your positions." },
  ZeroLiquidity: {
    title: "Amount too small for this range",
    message: () => "This deposit works out to zero liquidity: either the amount is too small, or the range sits so far from the current price that the tokens you are depositing buy none of it. Increase the amount, or move the range nearer the price.",
  },
  InsufficientLiquidity: { title: "More than this position holds", message: () => "You asked to withdraw more liquidity than the position currently holds — usually a stale page after an earlier withdrawal. Reload and retry; withdrawing everything always exits whatever is left." },
  RebalanceTooSoon: { title: "Rebalanced too recently", message: () => "This position was rebalanced inside the vault's minimum interval, so the keeper was refused. It becomes eligible again once the interval has passed — a rate limit on the keeper, not a fault in your position.", protection: true },
  RangeWidthOutOfBounds: { title: "Range width outside the allowed band", message: () => "The vault only mints ranges between a minimum and a maximum width, and this one falls outside that band (or an end of it is past the tick limits). Widen or narrow the range and retry.", protection: true },
  TicksMisordered: { title: "Range is upside down", message: () => "The lower end of a range must sit strictly below the upper end. Swap them and retry." },
  TickNotOnSpacing: { title: "Range is off the pool's grid", message: () => "Both ends of a range have to land on a multiple of the pool's tick spacing. Snap the range to the grid and retry." },
  PoolAlreadyWhitelisted: { title: "Pool already listed", message: () => "This pool is already open for deposits — there is nothing to do." },
  TransferFailed: { title: "Token transfer failed", message: () => "A token transfer in or out of the vault failed. The usual causes: not enough balance, no allowance for the vault, or a token that blocks transfers. Check your balance and approval, then retry." },
  RebalanceNotSelfFunding: { title: "Rebalance would not pay for itself", message: () => "The new range would have cost more than the old one returned, and the vault will not make up the difference out of anything it holds. Refused — your position is exactly where it was.", protection: true },
  HookNotPermitted: { title: "Not a MoleSwap pool", message: () => "The vault only manages pools running its own hook, and this pool's hook is a different contract. Pick a MoleSwap pool." },
  WithdrawalWouldBeBlockable: { title: "Pool could block withdrawals", message: () => "The vault refuses to manage any pool whose hook could ever stand in the way of a withdrawal — the exit has to work no matter what else breaks. This pool cannot be listed.", protection: true },
  InvalidTickSpacing: { title: "Invalid pool", message: () => "This pool's tick spacing is not a positive number, so it cannot be listed or used." },
  DeadlinePassed: { title: "Deadline passed", message: () => "The deadline on this deposit passed before the transaction was mined, so it was refused rather than executed at a price you approved minutes ago. Submit it again — allow a longer deadline if the network is busy.", protection: true },
  ExceedsMaxAmount: { title: "Deposit wanted more than your limit", message: () => "At the price when this ran, the mint would have pulled more of one token than the maximum you set. The price moved: refresh the deposit and retry, or raise the limit.", protection: true },
  DwellNotElapsed: { title: "Position too new to rebalance", message: () => "A position has to sit for a minimum number of Ethereum blocks before the keeper may reshape it, which is what stops an open and a reshape sharing one transaction. Working as intended; nothing moved.", protection: true },
  DepositWouldBeTaxable: { title: "Pool could tax deposits", message: () => "The vault refuses to manage a pool whose hook could take a cut of a deposit — deposits here are fee-free by construction, not by policy. This pool cannot be listed.", protection: true },
  RangeTooFarFromTwap: { title: "New range too far from the average price", message: () => "The keeper tried to centre the position further from the pool's time-weighted average price than the vault allows. Refused — this is the guard against a rebalance priced off a manipulated spot, and your position is untouched.", protection: true },
  RebalanceBudgetExhausted: { title: "Too many rebalances in this block", message: () => "The keeper has already spent this block's rebalance budget across all positions. Refused for now; the cap is what bounds how much a compromised keeper could reshape at once.", protection: true },
  EjectionTooLarge: { title: "Rebalance would hand back too much", message: () => "Moving to the new range would have returned more of the position as loose tokens than the vault's cap allows, so it was refused and the position was left where it is.", protection: true },
  RecenterTooFar: { title: "Rebalance would move the position too far", message: () => "One rebalance may only move each end of a range by a limited number of ticks, and this one asked for more. Refused; the position is untouched and the keeper can walk it there over several rebalances.", protection: true },
  FeeAboveCeiling: { title: "Performance fee above the ceiling", message: () => "A performance fee above the contract's hard ceiling was requested. An operator setting — nothing a depositor can hit." },
  FeeRecipientRequired: { title: "Fee recipient missing", message: () => "A live performance fee needs somewhere to send its cut; without a recipient the cut would be minted to nobody. An operator setting." },
  FeeRecipientCannotBeThisContract: { title: "Fee recipient invalid", message: () => "The vault cannot pay its performance fee to itself. An operator setting." },
  DepositAccruedFees: { title: "Deposit touched accrued fees", message: () => "A deposit is meant to realize no fees whatsoever, and this one appeared to. The vault refused rather than book the difference anywhere — nothing moved. Please report it.", protection: true },
  // Declared, never raised: the vault used to refuse pools with a native leg and now settles them with
  // `settle{value:}` instead. Kept decodable because an OLDER deployment can still raise it, and "we do not
  // know this selector" would be a worse answer than the truth.
  NativeCurrencyNotSupported: { title: "Native currency not supported", message: () => "This deployment refuses pools with a native currency leg. Newer ones support them — you are talking to an older vault than this app expects." },
  PositionTooSmall: { title: "Below the vault's minimum position", message: () => "The vault does not mint positions below its minimum size: one that small costs more gas to keep managed than it can earn. Deposit more.", protection: true },
  PositionTooLarge: { title: "Above the vault's maximum position", message: () => "The vault caps how much liquidity a single position may hold. Deposit less, or split it across two positions.", protection: true },
  KeeperRevokedForPosition: { title: "Keeper turned off for this position", message: () => "You revoked the keeper for this position, so it will not be rebalanced — your own setting, doing exactly what you asked. Re-enable the keeper if you want it managed again.", protection: true },
  CapAboveCeiling: { title: "Position size band inverted", message: () => "The minimum position size was set above the maximum. An operator setting." },
  KeeperExpired: { title: "Keeper's authority has expired", message: () => "The keeper's permission to rebalance ran out and has not been renewed, so nothing is being reshaped. Your deposits and withdrawals are unaffected.", protection: true },
  NativeRefundFailed: { title: "Could not return your unspent balance", message: () => "The deposit could not send the unspent native currency back to your wallet, so the whole thing was rolled back. Deposit from a wallet that can receive a plain transfer." },
  OwnerRequired: { title: "Vault has no admin", message: () => "The vault was initialised without an upgrade admin. A deployment problem, not something you did." },
  BadRangeBounds: { title: "Range width band invalid", message: () => "The vault's minimum and maximum range width are inconsistent. An operator setting." },
  BadTwapDeviation: { title: "Price band invalid", message: () => "The vault's allowed deviation from the average price cannot be negative. An operator setting." },
  TwapBoundNeedsAnOracle: { title: "Price band without an oracle", message: () => "A band around the average price cannot be enforced without an oracle and a window to read it over. An operator setting." },
  BadEjectionCap: { title: "Leftover cap invalid", message: () => "The cap on what a rebalance may hand back cannot exceed 100%. An operator setting." },
  BadRecenterCap: { title: "Recentre cap invalid", message: () => "The cap on how far one rebalance may move a position cannot be negative. An operator setting." },
  MintedBelowMinimum: { title: "Less liquidity than your minimum", message: () => "The price moved while this deposit was in flight, so the position it would have minted came out smaller than the minimum you set. Nothing moved — refresh the deposit and retry, or allow more slippage.", protection: true },
  // Spot vs TWAP, and NOT the same thing as RangeTooFarFromTwap: this one says the price the pool is quoting
  // right now is not one we will value a mint against. The contract keeps them apart on purpose, so the
  // sentences do too.
  SpotTooFarFromTwap: { title: "Live price too far from the average", message: () => "The pool's price right now sits far enough from its own time-weighted average that the vault will not value a deposit against it — that gap is what a manipulated pool looks like. Nothing moved; wait for the price to settle and retry.", protection: true },
  PoolTooLarge: { title: "Pool is at the vault's cap", message: () => "The vault limits how much liquidity it will hold in any one pool, and this deposit would push it past that cap. Deposit a smaller amount, or pick another pool.", protection: true },
  UnexpectedNativeValue: { title: "Native currency sent to a token-only pool", message: () => "This deposit carried native currency into a pool with no native leg, where nothing could spend it. Refused rather than quietly kept — send the deposit again without a value.", protection: true },
  NativeValueOverspent: { title: "Deposit tried to spend more than it carried", message: () => "Settling this deposit would have used more native currency than the transaction sent, meaning it would have been funded out of someone else's. Refused; nothing moved.", protection: true },
  UnexpectedCallback: { title: "Unexpected callback", message: () => "The vault's callback was reached without the vault having opened the unlock itself. Refused for safety.", protection: true },
  // The exit's floor, and the one guard here the CALLER sets: `withdrawWithMinimums(id, liquidity,
  // amount0Min, amount1Min)`. Nobody else can cause it, which is exactly why the exit is allowed to have it
  // when the exit is allowed no protocol gate at all.
  WithdrawBelowMinimum: { title: "Exit landed below your floor", message: () => "One of the two tokens came back below the minimum you set for it, so the withdrawal was rolled back and your position is untouched. Lower the floors and retry, or withdraw without them to exit at whatever the pool pays.", protection: true },
  NotUpgradeAdmin: { title: "Not authorised", message: () => "Only the vault's upgrade admin may do that." },
};

/**
 * ZapLogic. Only the two errors the vault does not also declare can surface under this group — the rest
 * collide with MolePositions' own and resolve there. They are kept complete anyway so the parity test can
 * hold this registry against the library's source.
 */
const ZAP_EXPLAIN: Record<string, Explain> = {
  ZeroLiquidity: VAULT_EXPLAIN.ZeroLiquidity,
  SwapOutputBelowMinimum: {
    title: "The swap inside your deposit came back short",
    message: () => "A one-token deposit sells part of what you put in before it mints, and that sale returned less than the minimum you set. The entire deposit was rolled back — nothing moved. Refresh and retry, or allow more slippage.",
    protection: true,
  },
  DepositAccruedFees: VAULT_EXPLAIN.DepositAccruedFees,
  NotSelfFunding: { title: "Deposit would not have paid for itself", message: () => "The deposit would have ended owing the pool more than it brought, so it was refused rather than funded out of what the vault holds for other positions. Nothing moved.", protection: true },
  TransferFailed: VAULT_EXPLAIN.TransferFailed,
  RebalanceNotSelfFunding: VAULT_EXPLAIN.RebalanceNotSelfFunding,
  EjectionTooLarge: VAULT_EXPLAIN.EjectionTooLarge,
};

/**
 * MoleQueue, Robinhood-only. The settlement guards all end the same way and the sentences say so: a batch
 * that cannot be priced safely is not settled at a bad price, it times out and returns every deposit in
 * kind. A user reading one of these has lost nothing and needs to know that first.
 */
const QUEUE_EXPLAIN: Record<string, Explain> = {
  WrongPhase: { title: "The batch has moved on", message: () => "Orders can only be placed or cancelled while a batch is open, and only claimed once it has settled or been refunded. Reload the queue to see where this one stands." },
  ZeroAmount: { title: "Nothing to queue", message: () => "Enter an amount above zero." },
  NotOrderOwner: { title: "Not your order", message: () => "That order belongs to a different wallet. Switch to the wallet that placed it.", protection: true },
  AlreadyWithdrawn: { title: "Already claimed", message: () => "This order has already been claimed or cancelled — its funds are in your wallet.", protection: true },
  TooEarly: { title: "Too early in the batch", message: () => "This batch has not run long enough yet: it can only be frozen once its trading window closes, and settled only after the freeze delay. Wait for the countdown." },
  NotTimedOut: { title: "Not timed out yet", message: () => "This batch can still settle normally, so it cannot be timed out yet. A timeout only opens up once the settle window has run out." },
  NothingToSettle: { title: "Empty batch", message: () => "Nobody placed an order in this batch, so there is nothing to settle." },
  TransferFailed: { title: "Token transfer failed", message: () => "A token transfer in or out of the queue failed. Check your balance and your allowance for the queue, and whether the token blocks transfers." },
  NotPoolManager: { title: "Unexpected caller", message: () => "Something other than the pool manager tried to drive the queue's callback. Refused for safety.", protection: true },
  TwapTooFarFromSpot: { title: "Price and its average disagree", message: () => "The pool's live price and the average this batch would clear at are too far apart to be trusted together, so the settlement was refused. Nothing is lost: the batch settles once they agree again, or times out and returns every deposit in kind.", protection: true },
  ResidualSwapTooFarFromTwap: { title: "Leftover trade priced too badly", message: () => "The unmatched part of this batch could only go through the pool well below the batch's own price — the shape a sandwich around the settlement leaves. Refused; the batch stays unsettled — it can settle later, or time out and return every deposit in kind.", protection: true },
  ResidualShortFill: { title: "Pool could not absorb the batch", message: () => "The pool ran out of liquidity partway through the unmatched leftover, and settling a partial fill would have stranded the rest of the escrow. Refused: the batch times out and everyone reclaims in kind.", protection: true },
  ResidualSwapFailed: { title: "Leftover trade failed without a reason", message: () => "The pool swap for the unmatched part of this batch reverted and gave no reason at all. The batch was left unsettled — it can be settled again later or timed out." },
  NotUpgradeAdmin: { title: "Not authorised", message: () => "Only the queue's upgrade admin may do that." },
  TwapBandRequired: { title: "Price band missing", message: () => "A queue cannot run without a band around the average price. An operator setting." },
  BadSlippageBps: { title: "Slippage bound invalid", message: () => "The bound on the leftover trade must be above zero and below 100%. An operator setting." },
  BadDurations: { title: "Batch timings invalid", message: () => "A batch needs a non-zero trading window, freeze delay and oracle window. An operator setting." },
  LifeMustOutlastFreeze: { title: "Batch timings invalid", message: () => "A batch has to outlive its own freeze, or it would time out before it could ever settle. An operator setting." },
  UpgradeAdminRequired: { title: "Queue has no admin", message: () => "The queue was initialised without an upgrade admin. A deployment problem." },
  UnsupportedCurrency: { title: "Currency the queue cannot hold", message: () => "One side of this pool is not a token contract the queue can escrow, so it will not accept orders against it." },
  EscrowNotReceived: { title: "Nothing arrived in escrow", message: () => "The queue credits what actually lands, and nothing did — the usual cause is a token that charges a fee on transfer, which this queue cannot price. Nothing was queued and nothing was taken." },
  OracleTooStale: { title: "Price history too old", message: () => "This pool has not traded recently enough for its average price to mean anything, so the batch will not clear against it. It settles once the pool trades again, or times out and returns every deposit in kind.", protection: true },
  ClearingJumpTooLarge: { title: "Price moved too far since the last batch", message: () => "This batch would clear a long way from the price the previous one cleared at, which is an excursion rather than a market — and a batch nobody can cancel out of is the wrong place to find out which. Refused; it times out and everyone reclaims in kind.", protection: true },
  InsufficientPoolDepth: { title: "No real liquidity behind this price", message: () => "There is not enough liquidity standing near the price this batch would clear at, so the queue will not settle against it. It waits for depth, or times out and returns every deposit in kind.", protection: true },
  UnlockNotInitiated: { title: "Unexpected callback", message: () => "The queue's callback was reached without the queue having asked for the unlock. Refused for safety.", protection: true },
  SettleWindowClosed: { title: "Settle window has closed", message: () => "This batch waited too long to settle, so the only resolution left is a timeout — which returns every deposit in kind, and which anyone can trigger." },
  BadGuardParams: { title: "Guard settings invalid", message: () => "The queue's short price window or its clearing-jump cap is out of range. An operator setting." },
};

/** Solidity panic codes — https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require */
const PANIC_TEXT: Record<string, string> = {
  "0x0": "a generic compiler panic",
  "0x1": "an assertion failed",
  "0x11": "an arithmetic overflow or underflow — usually an amount larger than a balance, or a trade too large for the pool's math",
  "0x12": "a division by zero — a pool with no liquidity or a zero price",
  "0x21": "an invalid enum value",
  "0x22": "a corrupted storage byte array",
  "0x31": "a pop on an empty array",
  "0x32": "an array index out of bounds",
  "0x41": "too much memory was allocated — the route is too large",
  "0x51": "a call to an uninitialised internal function",
};

/** Known `Error(string)` reasons from the venues and tokens this router touches. */
const STRING_REASONS: ReadonlyArray<{ re: RegExp; title: string; message: string; source: FailureSource }> = [
  { re: /insufficient allowance|exceeds allowance|allowance/i, title: "Allowance too low", message: "The router's allowance for this token is too low. Approve the router and retry.", source: "erc20" },
  { re: /exceeds balance|insufficient balance|balance too low/i, title: "Insufficient balance", message: "Not enough token balance for this swap.", source: "erc20" },
  { re: /^(STF|TF|TRANSFER_FROM_FAILED|TRANSFER_FAILED|SafeERC20: low-level call failed|ERC20: transfer failed)$/i, title: "Token transfer failed", message: "The token refused a transfer — check your balance and allowance, and whether the token charges a transfer fee or blocks this address.", source: "erc20" },
  { re: /paus/i, title: "Token paused", message: "The token is paused and cannot be transferred right now.", source: "erc20" },
  { re: /blacklist|blocklist|blocked|frozen|sanction/i, title: "Address blocked by the token", message: "The token blocks one of the addresses in this swap.", source: "erc20" },
  { re: /^SPL$/, title: "Price already past the limit", message: "The pool's price is already past the swap's price limit. Refresh the quote and retry.", source: "v4" },
  { re: /^LOK$/, title: "Pool locked", message: "The pool was locked (re-entered) when the swap ran. Retry.", source: "v4" },
  { re: /^IIA$/, title: "Pool under-paid", message: "The pool was paid less than it asked for in the swap callback — usually a fee-on-transfer input token. This token cannot be routed safely.", source: "v4" },
  { re: /^AS$/, title: "Amount too small", message: "A hop tried to swap zero — the amount is too small for this route. Try a larger amount.", source: "v4" },
  { re: /^(L|NP|M0|M1|T|R|TLU|TLM|TUM|LO|LS)$/, title: "Pool math refused the trade", message: "The pool's tick or liquidity math refused this trade (code in the raw error). Try a smaller amount or a different route.", source: "v4" },
  { re: /Too little received|Too much requested/i, title: "Price moved past your minimum", message: "The route would deliver less than your minimum. Increase slippage or retry.", source: "v4" },
];

/**
 * Lookup order, and it is load-bearing for the selectors more than one contract declares. The swap layers
 * come first so every message a swap could already produce is unchanged; the vault, its zap library and the
 * queue follow, in that order, so `ZeroLiquidity()` from inside a zap reads as the vault's sentence rather
 * than the library's. `prefer` in the context overrides the whole thing for a caller that knows better.
 */
const GROUPS: ReadonlyArray<{ source: FailureSource; abi: readonly unknown[]; explain: Record<string, Explain> }> = [
  { source: "router", abi: ROUTER_ERROR_ABI, explain: ROUTER_EXPLAIN },
  { source: "hook", abi: HOOK_ERROR_ABI, explain: HOOK_EXPLAIN },
  { source: "v4", abi: V4_ERROR_ABI, explain: V4_EXPLAIN },
  { source: "erc20", abi: ERC20_ERROR_ABI, explain: ERC20_EXPLAIN },
  { source: "vault", abi: VAULT_ERROR_ABI, explain: VAULT_EXPLAIN },
  { source: "zap", abi: ZAP_ERROR_ABI, explain: ZAP_EXPLAIN },
  { source: "queue", abi: QUEUE_ERROR_ABI, explain: QUEUE_EXPLAIN },
];

/** The lookup order for one decode: the caller's own contract first when it named one, else declaration order. */
function groupsFor(ctx: DecodeContext): typeof GROUPS {
  const p = ctx.prefer;
  if (!p) return GROUPS;
  const first = GROUPS.filter((g) => g.source === p);
  return first.length === 0 ? GROUPS : [...first, ...GROUPS.filter((g) => g.source !== p)];
}

const isHexData = (s: unknown): s is Hex => typeof s === "string" && /^0x([0-9a-fA-F]{2})*$/.test(s);

function tryDecode(abi: readonly unknown[], data: Hex): { errorName: string; args: readonly unknown[] } | null {
  try {
    const d = decodeErrorResult({ abi: abi as any, data });
    // viem decodes Solidity's own `Error(string)` / `Panic(uint256)` against ANY abi; only count a match the
    // group itself declares, so a string revert is never attributed to the router.
    if (!(abi as any[]).some((i) => i?.type === "error" && i?.name === d.errorName)) return null;
    return { errorName: d.errorName, args: (d.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

/**
 * Decode raw revert data into a sentence. Pure; never throws.
 *
 * Lookup order is router → hook → v4 → ERC-20 → Solidity builtins. A selector that collides across groups
 * (e.g. `TransferFailed()` exists in the router and in solady) is attributed to the first group that carries
 * it, which is also the one that can actually reach a swap: the router swallows token failures and raises its
 * own. WrappedError (ERC-7751) is unwrapped recursively so a hook's or a token's inner reason is what the user
 * reads, with the v4 context (HookCallFailed / ERC20TransferFailed / NativeTransferFailed) as the title.
 */
export function decodeRevertData(data: Hex | string | null | undefined, ctx: DecodeContext = {}): DecodedFailure {
  const raw = typeof data === "string" ? data : "";
  if (!isHexData(raw) || raw.length < 10) {
    return {
      code: "evm.empty",
      source: "evm",
      title: "Reverted without a reason",
      message:
        "The transaction reverted without a reason. Common causes: a token that blocks transfers, a pool that is locked or drained, or an inner call that ran out of gas. Refresh the quote and retry.",
      raw: raw || "0x",
    };
  }

  for (const g of groupsFor(ctx)) {
    const d = tryDecode(g.abi, raw);
    if (!d) continue;
    const exp = g.explain[d.errorName];
    let inner: DecodedFailure | undefined;
    if (g.source === "v4" && d.errorName === "WrappedError") {
      const [, , reason, details] = d.args as [string, Hex, Hex, Hex];
      inner = isHexData(reason) && reason.length >= 10 ? decodeRevertData(reason, ctx) : undefined;
      // `details` names the v4 context the wrap was raised from (a bare 4-byte selector).
      const ctxName = isHexData(details) && details.length === 10 ? tryDecode(V4_ERROR_ABI, details)?.errorName : undefined;
      const ctxExplain = ctxName ? V4_EXPLAIN[ctxName] : undefined;
      const title = titleOf(ctxExplain?.title, ctx) ?? titleOf(exp?.title, ctx) ?? "Call inside the pool failed";
      const message = ctxExplain
        ? ctxExplain.message(d.args, ctx, inner)
        : (exp?.message(d.args, ctx, inner) ?? `A call to ${short(d.args[0])} inside the pool failed.`);
      return {
        code: ctxName ? `v4.${ctxName}` : "v4.WrappedError",
        source: inner?.source === "hook" ? "hook" : "v4",
        title,
        message,
        raw,
        errorName: ctxName ?? "WrappedError",
        args: d.args,
        inner,
        isProtection: inner?.isProtection,
      };
    }
    return {
      code: `${g.source}.${d.errorName}`,
      source: g.source,
      title: titleOf(exp?.title, ctx) ?? d.errorName,
      message: exp?.message(d.args, ctx) ?? `${d.errorName} was raised by the ${g.source}.`,
      raw,
      errorName: d.errorName,
      args: d.args,
      isProtection: exp?.protection,
    };
  }

  const builtin = tryDecode(SOLIDITY_ERROR_ABI, raw);
  if (builtin?.errorName === "Error") {
    const reason = String(builtin.args[0] ?? "");
    const known = STRING_REASONS.find((r) => r.re.test(reason));
    return {
      code: known ? `string.${known.title.replace(/\W+/g, "_").toLowerCase()}` : "string.unknown",
      source: known?.source ?? "evm",
      title: known?.title ?? "Reverted with a message",
      message: known ? `${known.message} (reason: “${reason}”)` : `The contract reverted with: “${reason}”.`,
      raw,
      errorName: "Error",
      args: builtin.args,
    };
  }
  if (builtin?.errorName === "Panic") {
    const code = `0x${(builtin.args[0] as bigint).toString(16)}`;
    const text = PANIC_TEXT[code] ?? `panic code ${code}`;
    return {
      code: `evm.panic.${code}`,
      source: "evm",
      title: "Arithmetic or assertion failure",
      message: `The contract hit ${text}. Refresh the quote and try a smaller amount; report it if it persists.`,
      raw,
      errorName: "Panic",
      args: builtin.args,
    };
  }

  return {
    code: `unknown.${raw.slice(0, 10).toLowerCase()}`,
    source: "unknown",
    title: "Unrecognised error",
    message: `The contract reverted with an error this app does not know (selector ${raw.slice(0, 10)}). The raw data is below. Refresh the quote and retry; report it if it persists.`,
    raw,
  };
}

/* ---------------------------------------------------------------------------- anything that was thrown */

/** Walk an error's `cause` chain (viem and plain errors alike), root first. */
function* chain(err: unknown): Generator<any> {
  let cur: any = err;
  let guard = 0;
  while (cur && guard++ < 12) {
    yield cur;
    cur = cur.cause;
  }
}

/** Dig revert bytes out of whatever viem, a wallet or a raw JSON-RPC response threw. */
export function extractRevertData(err: unknown): Hex | null {
  for (const node of chain(err)) {
    if (typeof node !== "object") continue;
    // viem: ContractFunctionRevertedError.raw, RawContractError.data, RpcRequestError.data / .error.data
    for (const key of ["raw", "data"]) {
      const v = node[key];
      if (isHexData(v) && v.length >= 10) return v;
      if (v && typeof v === "object") {
        if (isHexData(v.data) && v.data.length >= 10) return v.data;
        if (isHexData(v.originalError?.data) && v.originalError.data.length >= 10) return v.originalError.data;
      }
    }
    if (node.error && typeof node.error === "object") {
      const v = node.error.data;
      if (isHexData(v) && v.length >= 10) return v;
      if (v && typeof v === "object" && isHexData(v.data) && v.data.length >= 10) return v.data;
    }
    // Some nodes put it in the message: "execution reverted: 0x…" / "revert data: 0x…"
    const m = typeof node.message === "string" ? /(0x[0-9a-fA-F]{8,})/.exec(node.message) : null;
    if (m && /revert/i.test(node.message) && (m[1].length - 2) % 2 === 0) return m[1] as Hex;
  }
  return null;
}

/**
 * Decode anything a swap path can throw. Revert bytes win; otherwise the message is classified into the
 * wallet / transport / balance buckets every swap UI needs, and the original text is kept as `raw`.
 */
export function decodeSwapFailure(err: unknown, ctx: DecodeContext = {}): DecodedFailure {
  if (err && typeof err === "object" && "code" in err && "message" in err && "raw" in err && "source" in err) {
    return err as DecodedFailure;
  }
  const data = extractRevertData(err);
  if (data) return decodeRevertData(data, ctx);

  const e: any = err;
  const msg: string = e?.shortMessage || e?.message || (typeof err === "string" ? err : String(err ?? "Unknown error"));
  const full: string = [msg, e?.details, e?.cause?.message, e?.cause?.details, e?.code, e?.cause?.code]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .map(String)
    .join(" | ");

  if (/user rejected|rejected the request|denied|user refused|cancel(l)?ed/i.test(full)) {
    return { code: "wallet.rejected", source: "wallet", title: "Rejected in wallet", message: "You rejected the request in your wallet.", raw: msg };
  }
  if (/insufficient funds/i.test(full)) {
    return { code: "wallet.insufficientFunds", source: "wallet", title: `Not enough ${nat(ctx)}`, message: `Not enough ${nat(ctx)} to pay for gas (or to send with the swap). Top up and retry.`, raw: msg };
  }
  if (/state override|stateOverride|unsupported|method not found|not supported|invalid params|-32601|-32602/i.test(full)) {
    return { code: "transport.unsupported", source: "transport", title: "RPC cannot run the simulation", message: "This RPC endpoint does not support the simulation the pre-flight needs. Retry — another endpoint will be tried.", raw: msg };
  }
  if (/fetch failed|failed to fetch|network|timeout|timed out|429|rate limit|too many requests|ECONNRESET|ECONNREFUSED|HTTP request failed|socket|aborted/i.test(full)) {
    return { code: "transport.unavailable", source: "transport", title: "RPC did not answer", message: "The RPC endpoint did not answer (network problem or rate limit). Retry in a moment.", raw: msg };
  }
  if (/execution reverted|reverted/i.test(full)) {
    return { code: "evm.reverted", source: "evm", title: "Reverted", message: `The transaction reverted: ${msg.split("\n")[0]}`, raw: msg };
  }
  return { code: "unknown", source: "unknown", title: "Swap failed", message: msg.split("\n")[0].slice(0, 200), raw: msg };
}
