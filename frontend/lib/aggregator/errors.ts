/**
 * errors.ts — turn a swap revert into a sentence a person can act on.
 *
 * A swap through MoleRouter can fail in four layers and every one of them speaks in 4-byte selectors: the
 * router's own custom errors (src/MoleRouter.sol), Uniswap v4 core (PoolManager / Pool / TickBitmap / Hooks /
 * TickMath / SqrtPriceMath …), our MoleHook, and the ERC-20s at the edges (OpenZeppelin typed errors, the
 * classic `Error(string)` reasons, Solidity panics). Left undecoded they all present as "transaction
 * failed", and support cannot tell a protection from a bug.
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

/** Solidity's own: `Error(string)` and `Panic(uint256)`. */
export const SOLIDITY_ERROR_ABI = parseAbi(["error Error(string reason)", "error Panic(uint256 code)"]);

/* ------------------------------------------------------------------------------------- explanations */

type Explain = {
  readonly title: string;
  readonly message: (args: readonly unknown[], ctx: DecodeContext, inner?: DecodedFailure) => string;
  readonly protection?: boolean;
};

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
  BadValue: { title: "ETH amount mismatch", message: () => "The ETH attached to the transaction does not match the swap: a native-ETH swap must send exactly the input amount, a token swap must send none." },
  UnexpectedEther: { title: "ETH sent outside a swap", message: () => "ETH was sent to the router outside a swap and was refused.", protection: true },
  NativeTransferFailed: { title: "Could not deliver ETH", message: () => "The recipient could not receive ETH (it rejects plain transfers). Use a different recipient or receive WETH instead." },
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
  NonzeroNativeValue: { title: "ETH attached to a token settlement", message: () => "ETH was attached to a token settlement. Refresh the quote and retry." },
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
  NativeTransferFailed: { title: "ETH transfer from the pool failed", message: (_a, _c, inner) => inner ? `The pool could not send ETH: ${inner.message}` : "The pool could not send ETH to its destination." },
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

const GROUPS: ReadonlyArray<{ source: FailureSource; abi: readonly unknown[]; explain: Record<string, Explain> }> = [
  { source: "router", abi: ROUTER_ERROR_ABI, explain: ROUTER_EXPLAIN },
  { source: "hook", abi: HOOK_ERROR_ABI, explain: HOOK_EXPLAIN },
  { source: "v4", abi: V4_ERROR_ABI, explain: V4_EXPLAIN },
  { source: "erc20", abi: ERC20_ERROR_ABI, explain: ERC20_EXPLAIN },
];

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

  for (const g of GROUPS) {
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
      const title = ctxExplain?.title ?? exp?.title ?? "Call inside the pool failed";
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
      title: exp?.title ?? d.errorName,
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
    return { code: "wallet.insufficientFunds", source: "wallet", title: "Not enough ETH", message: "Not enough ETH to pay for gas (or to send with the swap). Top up and retry.", raw: msg };
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
