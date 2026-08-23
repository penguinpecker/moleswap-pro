/**
 * simulate.ts — the pre-sign pre-flight: run the EXACT swap calldata the transaction builder produced, as the
 * user, against live chain state, and report the balance diff the user would actually experience.
 *
 * HOW. One `eth_call` with a state override that places SwapPreflightProbe's runtime code over the user's own
 * address (src/periphery/SwapPreflightProbe.sol, runtime pinned in preflightProbe.json by a forge test). Inside
 * that call `address(this)` IS the user, so the router sees the real msg.sender, `transferFrom` pulls against
 * the real balance and allowance, a native swap is funded by the real ETH, and the approve the real flow sends
 * first is simulated first. The probe measures the user's tokenIn balance and the recipient's tokenOut balance
 * before and after and returns the deltas — or the raw revert data, which errors.ts turns into a sentence. No
 * key, no broadcast, no gas. (learnings.txt 20.7 — a high-fidelity executability test, not a mined tx.)
 *
 * WHY A BALANCE DIFF AND NOT THE RETURN VALUE. The router's `amountOut` is what it pushed; the recipient keeps
 * what the token let through. A fee-on-transfer output, a recipient the token refuses, or calldata that was
 * tampered with between quote and signature all pass a plain `eth_call` and only show up as a diff. The diff is
 * then held against what the user was shown: more pulled than the displayed input, or less received than the
 * slippage floor, BLOCKS signing with the reason.
 *
 * TWO PROVIDERS, ONE BLOCK. When more than one RPC is configured the probe runs on each at the SAME pinned
 * block; the EVM is deterministic, so any difference means a provider is lying or broken and the verdict is
 * "mismatch — do not sign". A second opinion that is merely unavailable is not a mismatch. A mismatch is NEVER
 * retried automatically (dossier S-68): the strongest anti-drainer control must not become a loop an attacker
 * only has to win once.
 *
 * WHAT IT DOES NOT PROVE. It is a pre-flight, labelled as such everywhere it is shown. State moves between
 * simulation and inclusion, and the real transaction's own `minAmountOut` remains the only on-chain promise.
 */

import { decodeFunctionResult, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import probeArtifact from "./preflightProbe.json";
import { decodeRevertData, decodeSwapFailure, type DecodeContext, type DecodedFailure } from "./errors";
import { minOutFor } from "./plan";

/** The probe's runtime bytecode and the `preflight` signature, pinned against the Solidity by forge. */
export const PREFLIGHT_PROBE_RUNTIME = probeArtifact.runtime as Hex;
export const PREFLIGHT_PROBE_SIGNATURE = probeArtifact.signature;
export const PREFLIGHT_PROBE_ABI = parseAbi([PREFLIGHT_PROBE_SIGNATURE]);

/** The NATIVE sentinel the plan and the probe share (MoleRouter.NATIVE). */
const NATIVE_LC = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** `SwapPreflightProbe.Stage`, by value. */
export const ProbeStage = { Ok: 0, InsufficientBalance: 1, ApproveFailed: 2, SwapFailed: 3 } as const;

/** Decoded `SwapPreflightProbe.Result`. */
export interface ProbeResult {
  readonly stage: number;
  readonly revertData: Hex;
  readonly amountOut: bigint;
  readonly sent: bigint;
  readonly received: bigint;
  readonly balanceBefore: bigint;
  readonly allowanceBefore: bigint;
}

export interface PreflightRequest {
  /** RPC endpoints; the first is primary, the rest are second opinions. Duplicates are ignored. */
  readonly rpcUrls: readonly string[];
  readonly router: Address;
  /** The swapper — the account that will sign. The probe runs AS this address. */
  readonly account: Address;
  /** The EXACT `MoleRouter.swap` calldata the transaction will carry. Forwarded verbatim. */
  readonly calldata: Hex;
  /** The ETH the transaction attaches (amountIn for native-in, else 0). */
  readonly value: bigint;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly recipient: Address;
  /** The plan's gross amountIn — what the user was shown as "you send". */
  readonly amountIn: bigint;
  /** What the user was shown as "you receive". */
  readonly quotedOut: bigint;
  /** The plan's on-chain floor. */
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
  /** Token metadata for human-readable amounts in messages. */
  readonly ctx?: DecodeContext;
  /** Providers further than this many blocks behind the freshest head are not consulted. */
  readonly maxProviderLagBlocks?: number;
}

export type PreflightBlockKind = "balance" | "approve" | "revert" | "overpull" | "shortfall" | "mismatch";

export type PreflightVerdict =
  | {
      readonly status: "ok";
      readonly sent: bigint;
      readonly received: bigint;
      readonly amountOut: bigint;
      /** How many providers agreed (1 = no second opinion was available). */
      readonly providers: number;
      readonly blockNumber: bigint | null;
      readonly at: number;
    }
  | {
      readonly status: "blocked";
      readonly kind: PreflightBlockKind;
      readonly reason: DecodedFailure;
      readonly sent?: bigint;
      readonly received?: bigint;
      readonly providers: number;
      readonly blockNumber: bigint | null;
      readonly at: number;
    }
  | {
      /** The probe could not run anywhere (transport / unsupported RPC). Not a verdict on the swap. */
      readonly status: "unavailable";
      readonly reason: DecodedFailure;
      readonly at: number;
    };

/* --------------------------------------------------------------------------------------- JSON-RPC */

export class RpcResponseError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(err: { code?: number; message?: string; data?: unknown }) {
    super(err?.message || "RPC error");
    this.name = "RpcResponseError";
    this.code = err?.code;
    this.data = err?.data;
  }
}

async function rpc<T = unknown>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from RPC`);
  const j: any = await res.json();
  if (j?.error) throw new RpcResponseError(j.error);
  return j?.result as T;
}

/** Transport-shaped failures get ONE retry; execution results (including reverts) never do. */
async function withOneRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const d = decodeSwapFailure(err);
    if (d.source !== "transport" || d.code === "transport.unsupported") throw err;
    await new Promise((r) => setTimeout(r, 400));
    return fn();
  }
}

/* ------------------------------------------------------------------------------------- the probe */

/** The `eth_call` argument set for one probe run — exported so a test can pin exactly what is sent. */
export function buildProbeCall(req: PreflightRequest, blockTag: string) {
  const data = encodeFunctionData({
    abi: PREFLIGHT_PROBE_ABI as any,
    functionName: "preflight",
    args: [req.router, req.calldata, req.value, req.tokenIn, req.tokenOut, req.recipient, req.amountIn],
  });
  return [
    { from: req.account, to: req.account, data, value: "0x0" },
    blockTag,
    { [req.account]: { code: PREFLIGHT_PROBE_RUNTIME } },
  ] as const;
}

export function decodeProbeResult(hex: Hex): ProbeResult {
  const r = decodeFunctionResult({ abi: PREFLIGHT_PROBE_ABI as any, functionName: "preflight", data: hex }) as any;
  return {
    stage: Number(r.stage),
    revertData: r.revertData as Hex,
    amountOut: BigInt(r.amountOut),
    sent: BigInt(r.sent),
    received: BigInt(r.received),
    balanceBefore: BigInt(r.balanceBefore),
    allowanceBefore: BigInt(r.allowanceBefore),
  };
}

async function probeOn(url: string, req: PreflightRequest, blockTag: string): Promise<ProbeResult> {
  const params = buildProbeCall(req, blockTag) as unknown as unknown[];
  const hex = await withOneRetry(() => rpc<Hex>(url, "eth_call", params));
  if (typeof hex !== "string" || !hex.startsWith("0x") || hex.length < 10) {
    throw new Error("probe returned no data — the RPC may not apply state overrides");
  }
  return decodeProbeResult(hex);
}

const sameResult = (a: ProbeResult, b: ProbeResult) =>
  a.stage === b.stage &&
  a.revertData.toLowerCase() === b.revertData.toLowerCase() &&
  a.amountOut === b.amountOut &&
  a.sent === b.sent &&
  a.received === b.received;

const fmt = (v: bigint, t?: { symbol?: string; decimals?: number }) => {
  const human = typeof t?.decimals === "number" ? formatUnitsSafe(v, t.decimals) : v.toString();
  return t?.symbol ? `${human} ${t.symbol}` : human;
};
function formatUnitsSafe(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Turn an agreed probe result into the verdict the confirm screen renders. Pure; exported for tests. */
export function judgeProbeResult(
  r: ProbeResult,
  req: PreflightRequest,
  meta: { providers: number; blockNumber: bigint | null; at: number },
): PreflightVerdict {
  const ctx = req.ctx ?? {};
  const nativeIn = req.tokenIn.toLowerCase() === NATIVE_LC;
  const tokenInMeta = nativeIn ? { symbol: ctx.tokenIn?.symbol ?? "ETH", decimals: ctx.tokenIn?.decimals ?? 18 } : ctx.tokenIn;

  if (r.stage === ProbeStage.InsufficientBalance) {
    return {
      status: "blocked",
      kind: "balance",
      reason: {
        code: "preflight.insufficientBalance",
        source: "preflight",
        title: `Not enough ${tokenInMeta?.symbol ?? "balance"}`,
        message: `You hold ${fmt(r.balanceBefore, tokenInMeta)} but the swap needs ${fmt(req.amountIn, tokenInMeta)}. Lower the amount.`,
        raw: r.revertData,
      },
      ...meta,
    };
  }
  if (r.stage === ProbeStage.ApproveFailed) {
    const inner = decodeRevertData(r.revertData, ctx);
    return {
      status: "blocked",
      kind: "approve",
      reason: {
        ...inner,
        code: `preflight.approve.${inner.code}`,
        title: "Token approval would fail",
        message: `The approval the swap needs would fail: ${inner.message}`,
      },
      ...meta,
    };
  }
  if (r.stage === ProbeStage.SwapFailed) {
    return { status: "blocked", kind: "revert", reason: decodeRevertData(r.revertData, ctx), ...meta };
  }

  if (r.sent > req.amountIn) {
    return {
      status: "blocked",
      kind: "overpull",
      reason: {
        code: "preflight.overpull",
        source: "preflight",
        title: "Simulation pulled more than shown",
        message: `The simulation took ${fmt(r.sent, tokenInMeta)} from your wallet, more than the ${fmt(req.amountIn, tokenInMeta)} you were shown. Do not sign — the transaction does not match the quote.`,
        raw: `sent=${r.sent} amountIn=${req.amountIn}`,
      },
      sent: r.sent,
      received: r.received,
      ...meta,
    };
  }
  // The floor the user accepted: the plan's own minimum, or the shown output less slippage — whichever is
  // stricter, so a stale displayed number can never loosen the check.
  const floor = req.minAmountOut > minOutFor(req.quotedOut, req.slippageBps) ? req.minAmountOut : minOutFor(req.quotedOut, req.slippageBps);
  if (r.received < floor) {
    return {
      status: "blocked",
      kind: "shortfall",
      reason: {
        code: "preflight.shortfall",
        source: "preflight",
        title: "You would receive less than your minimum",
        message: `The simulation delivered ${fmt(r.received, ctx.tokenOut)} to the recipient, below your minimum of ${fmt(floor, ctx.tokenOut)} — the output token may charge a transfer fee, or the recipient cannot receive it. Do not sign.`,
        raw: `received=${r.received} floor=${floor} routerAmountOut=${r.amountOut}`,
      },
      sent: r.sent,
      received: r.received,
      ...meta,
    };
  }
  return { status: "ok", sent: r.sent, received: r.received, amountOut: r.amountOut, ...meta };
}

/**
 * Run the pre-flight. Resolves to a verdict; never throws for a swap-side failure (those are `blocked` with a
 * decoded reason) and reports an RPC that cannot run the probe as `unavailable`, distinctly.
 */
export async function runSwapPreflight(req: PreflightRequest): Promise<PreflightVerdict> {
  const at = Date.now();
  const urls = [...new Set(req.rpcUrls.filter(Boolean))];
  if (urls.length === 0) {
    return {
      status: "unavailable",
      at,
      reason: { code: "preflight.noRpc", source: "transport", title: "No RPC configured", message: "No RPC endpoint is configured for the pre-flight.", raw: "" },
    };
  }

  // 1) Pin one block so every provider simulates the same state; drop providers lagging too far behind.
  const heads = await Promise.all(
    urls.map(async (u) => {
      try {
        const h = await withOneRetry(() => rpc<Hex>(u, "eth_blockNumber", []));
        return { url: u, head: BigInt(h) };
      } catch (err) {
        return { url: u, head: null as bigint | null, err };
      }
    }),
  );
  const live = heads.filter((h): h is { url: string; head: bigint } => h.head !== null);
  if (live.length === 0) {
    const first = heads.find((h) => "err" in h) as { err?: unknown } | undefined;
    return { status: "unavailable", at, reason: decodeSwapFailure(first?.err ?? new Error("RPC did not answer")) };
  }
  const maxLag = BigInt(req.maxProviderLagBlocks ?? 50);
  const freshest = live.reduce((m, h) => (h.head > m ? h.head : m), live[0]!.head);
  const kept = live.filter((h) => freshest - h.head <= maxLag);
  const pinned = kept.reduce((m, h) => (h.head < m ? h.head : m), kept[0]!.head);
  const blockTag = `0x${pinned.toString(16)}`;

  // 2) Probe on every kept provider at the pinned block.
  const runs = await Promise.all(
    kept.map(async (h) => {
      try {
        return { url: h.url, result: await probeOn(h.url, req, blockTag) };
      } catch (err) {
        return { url: h.url, result: null as ProbeResult | null, err };
      }
    }),
  );
  const ok = runs.filter((r): r is { url: string; result: ProbeResult } => r.result !== null);
  if (ok.length === 0) {
    const first = runs.find((r) => "err" in r) as { err?: unknown } | undefined;
    return { status: "unavailable", at, reason: decodeSwapFailure(first?.err ?? new Error("probe failed")) };
  }

  // 3) Agreement. Same block, same EVM: any difference is a provider problem, and it blocks signing.
  const base = ok[0]!.result;
  const disagree = ok.filter((r) => !sameResult(base, r.result));
  if (disagree.length > 0) {
    const lines = ok.map((r) => `${r.url}: stage=${r.result.stage} out=${r.result.amountOut} sent=${r.result.sent} received=${r.result.received}`);
    return {
      status: "blocked",
      kind: "mismatch",
      reason: {
        code: "preflight.mismatch",
        source: "preflight",
        title: "Simulation mismatch — do not sign",
        message: `Two RPC providers simulated the same swap at block ${pinned} and disagreed. One of them is wrong, and this swap must not be signed until they agree. This check is not retried automatically.`,
        raw: lines.join("\n"),
      },
      providers: ok.length,
      blockNumber: pinned,
      at,
    };
  }

  return judgeProbeResult(base, req, { providers: ok.length, blockNumber: pinned, at });
}
