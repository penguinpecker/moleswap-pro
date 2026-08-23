/**
 * preflight.test.ts — the pre-sign simulation must (1) run the EXACT calldata as the user, (2) judge the balance
 * diff against what the user was shown and BLOCK on every bad shape, (3) treat a provider disagreement as a
 * block that is never retried, and (4) keep "could not run" distinct from "ran and failed".
 *
 * The RPC is a fetch mock that answers eth_blockNumber / eth_call per URL; probe results are produced with viem
 * from the probe ABI, so the decoding under test is the same code path the browser runs.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeFunctionData, encodeErrorResult, encodeFunctionResult, type Hex } from "viem";
import {
  PREFLIGHT_PROBE_ABI,
  PREFLIGHT_PROBE_RUNTIME,
  buildProbeCall,
  judgeProbeResult,
  runSwapPreflight,
  ProbeStage,
  type PreflightRequest,
  type ProbeResult,
} from "../../lib/aggregator/simulate";
import { ROUTER_ERROR_ABI } from "../../lib/aggregator/errors";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const ROUTER = "0xBd9B841d690E31B61aa3858EB145EA8BBe71122c";
const TOKEN_IN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TOKEN_OUT = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const CALLDATA = "0xabcdef0100000000000000000000000000000000000000000000000000000000000000ff" as Hex;

const req = (over: Partial<PreflightRequest> = {}): PreflightRequest => ({
  rpcUrls: ["http://a.rpc"],
  router: ROUTER,
  account: ACCOUNT,
  calldata: CALLDATA,
  value: 0n,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  recipient: ACCOUNT,
  amountIn: 1_000_000n, // 1 USDG
  quotedOut: 500_000_000_000_000n, // 0.0005 WETH
  minAmountOut: 497_500_000_000_000n, // 50 bps
  slippageBps: 50,
  ctx: { tokenIn: { symbol: "USDG", decimals: 6 }, tokenOut: { symbol: "WETH", decimals: 18 } },
  ...over,
});

const result = (over: Partial<ProbeResult> = {}): Hex =>
  encodeFunctionResult({
    abi: PREFLIGHT_PROBE_ABI as any,
    functionName: "preflight",
    result: {
      stage: ProbeStage.Ok,
      revertData: "0x",
      amountOut: 500_000_000_000_000n,
      sent: 1_000_000n,
      received: 500_000_000_000_000n,
      balanceBefore: 5_000_000n,
      allowanceBefore: 0n,
      ...over,
    } as any,
  });

type Handler = (method: string, params: any[]) => { result?: unknown; error?: { code: number; message: string } } | never;

/** One fetch mock, routed by URL; records every JSON-RPC call. */
function mockRpc(byUrl: Record<string, Handler>) {
  const calls: { url: string; method: string; params: any[] }[] = [];
  const fetchMock = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params });
    const h = byUrl[url];
    if (!h) throw new TypeError("fetch failed");
    const r = h(body.method, body.params);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, ...r }) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const headAnd = (head: number, call: () => Hex): Handler => (method) => {
  if (method === "eth_blockNumber") return { result: `0x${head.toString(16)}` };
  if (method === "eth_call") return { result: call() };
  throw new Error(`unexpected ${method}`);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------- the call that is made */

describe("the probe runs the exact calldata, as the user, with the probe's code over the user's address", () => {
  it("sends from==to==account, the pinned block, and a code override equal to the shipped runtime", async () => {
    const { calls } = mockRpc({ "http://a.rpc": headAnd(0x1234, () => result()) });
    const v = await runSwapPreflight(req());
    expect(v.status).toBe("ok");
    const call = calls.find((c) => c.method === "eth_call")!;
    const [tx, blockTag, overrides] = call.params;
    expect(tx.from.toLowerCase()).toBe(ACCOUNT);
    expect(tx.to.toLowerCase()).toBe(ACCOUNT);
    expect(blockTag).toBe("0x1234");
    expect(overrides[ACCOUNT].code).toBe(PREFLIGHT_PROBE_RUNTIME);
    expect(PREFLIGHT_PROBE_RUNTIME.length).toBeGreaterThan(200); // a real runtime, not the placeholder
    // The probe's arguments carry the swap calldata VERBATIM — what is simulated is what will be signed.
    const decoded = decodeFunctionData({ abi: PREFLIGHT_PROBE_ABI as any, data: tx.data }) as any;
    expect(decoded.functionName).toBe("preflight");
    expect(decoded.args[0].toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(decoded.args[1]).toBe(CALLDATA);
    expect(decoded.args[2]).toBe(0n);
    expect(decoded.args[5].toLowerCase()).toBe(ACCOUNT);
    expect(decoded.args[6]).toBe(1_000_000n);
  });

  it("a custom recipient is forwarded in the recipient slot — `received` is measured where the output lands, not at the signer", () => {
    const OTHER = "0x00000000000000000000000000000000000000b2";
    const [tx, blockTag, overrides] = buildProbeCall(req({ recipient: OTHER }), "0x77");
    expect(tx.from.toLowerCase()).toBe(ACCOUNT); // the probe still runs AS the signer
    expect(tx.to.toLowerCase()).toBe(ACCOUNT);
    expect(blockTag).toBe("0x77");
    expect(Object.keys(overrides)).toEqual([ACCOUNT]); // only the signer's code is overridden
    const decoded = decodeFunctionData({ abi: PREFLIGHT_PROBE_ABI as any, data: tx.data }) as any;
    expect(decoded.functionName).toBe("preflight");
    // Every positional argument, in the probe's order: router, calldata, value, tokenIn, tokenOut, recipient, amountIn.
    expect(decoded.args).toHaveLength(7);
    expect(decoded.args[0].toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(decoded.args[1]).toBe(CALLDATA);
    expect(decoded.args[2]).toBe(0n);
    expect(decoded.args[3].toLowerCase()).toBe(TOKEN_IN.toLowerCase());
    expect(decoded.args[4].toLowerCase()).toBe(TOKEN_OUT.toLowerCase());
    expect(decoded.args[5].toLowerCase()).toBe(OTHER);
    expect(decoded.args[5].toLowerCase()).not.toBe(ACCOUNT);
    expect(decoded.args[6]).toBe(1_000_000n);
  });

  it("buildProbeCall attaches the native value through the probe, not on the outer call", () => {
    const [tx] = buildProbeCall(req({ tokenIn: NATIVE, value: 1_000_000n }), "latest");
    expect(tx.value).toBe("0x0"); // the probe funds the router call from the account's own balance
    const decoded = decodeFunctionData({ abi: PREFLIGHT_PROBE_ABI as any, data: tx.data }) as any;
    expect(decoded.args[2]).toBe(1_000_000n);
    expect(decoded.args[3].toLowerCase()).toBe(NATIVE.toLowerCase());
  });
});

/* ---------------------------------------------------------------------------------- the verdicts */

describe("the balance diff is judged against what the user was shown", () => {
  const meta = { providers: 1, blockNumber: 1n, at: 0 };
  const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
    stage: ProbeStage.Ok,
    revertData: "0x",
    amountOut: 500_000_000_000_000n,
    sent: 1_000_000n,
    received: 500_000_000_000_000n,
    balanceBefore: 5_000_000n,
    allowanceBefore: 0n,
    ...over,
  });

  it("ok when sent ≤ amountIn and received ≥ the floor", () => {
    const v = judgeProbeResult(probe(), req(), meta);
    expect(v.status).toBe("ok");
    if (v.status === "ok") {
      expect(v.sent).toBe(1_000_000n);
      expect(v.received).toBe(500_000_000_000_000n);
    }
  });

  it("ok at exactly the floor, blocked one wei under it", () => {
    const floor = 497_500_000_000_000n;
    expect(judgeProbeResult(probe({ received: floor }), req(), meta).status).toBe("ok");
    const v = judgeProbeResult(probe({ received: floor - 1n }), req(), meta);
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("shortfall");
      expect(v.reason.message).toMatch(/below your minimum/);
      expect(v.reason.message).toContain("WETH");
      expect(v.reason.message).not.toMatch(/guarantee/i);
    }
  });

  it("the floor is the STRICTER of the plan's minimum and the shown output less slippage", () => {
    // plan floor loose (1 wei), but the shown quote with 50 bps demands 497.5e12: received 400e12 is blocked.
    const v = judgeProbeResult(probe({ received: 400_000_000_000_000n }), req({ minAmountOut: 1n }), meta);
    expect(v.status).toBe("blocked");
    // and the other way round: shown quote tiny, plan floor strict — still blocked.
    const w = judgeProbeResult(probe({ received: 400_000_000_000_000n }), req({ quotedOut: 1n }), meta);
    expect(w.status).toBe("blocked");
  });

  it("blocks when more was pulled than the displayed input — even if the output looks fine", () => {
    const v = judgeProbeResult(probe({ sent: 1_000_001n, received: 10n ** 18n }), req(), meta);
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("overpull");
      expect(v.reason.message).toMatch(/Do not sign/);
      expect(v.reason.message).toContain("1.000001 USDG");
    }
    // Less pulled than shown (router swept dust back) is favourable, not a block.
    expect(judgeProbeResult(probe({ sent: 999_999n }), req(), meta).status).toBe("ok");
  });

  it("a router revert is decoded into the sentence for its selector", () => {
    const data = encodeErrorResult({ abi: ROUTER_ERROR_ABI, errorName: "InsufficientOutput", args: [490_000_000_000_000n, 497_500_000_000_000n] });
    const v = judgeProbeResult(probe({ stage: ProbeStage.SwapFailed, revertData: data, sent: 0n, received: 0n }), req(), meta);
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("revert");
      expect(v.reason.code).toBe("router.InsufficientOutput");
      expect(v.reason.message).toMatch(/Price moved/);
      expect(v.reason.message).toContain("0.00049 WETH");
      expect(v.reason.message).toContain("0.0004975 WETH");
      expect(v.reason.raw).toBe(data);
    }
  });

  it("a failed approve is reported as the approval, with the token's reason inside", () => {
    const data = encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ type: "string", name: "r" }] }], errorName: "Error", args: ["Pausable: paused"] });
    const v = judgeProbeResult(probe({ stage: ProbeStage.ApproveFailed, revertData: data }), req(), meta);
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("approve");
      expect(v.reason.title).toBe("Token approval would fail");
      expect(v.reason.message).toMatch(/paused/i);
    }
  });

  it("insufficient balance is named with both numbers in token units", () => {
    const v = judgeProbeResult(probe({ stage: ProbeStage.InsufficientBalance, balanceBefore: 250_000n }), req(), meta);
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("balance");
      expect(v.reason.message).toContain("0.25 USDG");
      expect(v.reason.message).toContain("1 USDG");
    }
    const n = judgeProbeResult(probe({ stage: ProbeStage.InsufficientBalance, balanceBefore: 10n ** 17n }), req({ tokenIn: NATIVE, value: 10n ** 18n, amountIn: 10n ** 18n, ctx: {} }), meta);
    if (n.status === "blocked") expect(n.reason.message).toContain("0.1 ETH");
  });
});

/* ------------------------------------------------------------------------------ two providers */

describe("a second provider must agree at the same block; disagreement blocks and is never retried", () => {
  it("both providers are asked at the SAME pinned block (the lower head) and agreement counts as 2", async () => {
    const { calls } = mockRpc({
      "http://a.rpc": headAnd(0x1000, () => result()),
      "http://b.rpc": headAnd(0x0ffe, () => result()),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("ok");
    if (v.status === "ok") {
      expect(v.providers).toBe(2);
      expect(v.blockNumber).toBe(0x0ffen);
    }
    const tags = calls.filter((c) => c.method === "eth_call").map((c) => c.params[1]);
    expect(tags).toEqual(["0xffe", "0xffe"]);
  });

  it("DISAGREEMENT → blocked 'mismatch — do not sign', and no further eth_call is attempted", async () => {
    const { calls } = mockRpc({
      "http://a.rpc": headAnd(0x1000, () => result()),
      "http://b.rpc": headAnd(0x1000, () => result({ received: 400_000_000_000_000n })),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("mismatch");
      expect(v.reason.title).toMatch(/do not sign/i);
      expect(v.reason.message).toMatch(/not retried automatically/);
      expect(v.reason.raw).toContain("http://a.rpc");
      expect(v.reason.raw).toContain("http://b.rpc");
    }
    expect(calls.filter((c) => c.method === "eth_call")).toHaveLength(2);
  });

  it("a disagreement ONLY in `sent` (the pulled amount) is a mismatch — the over-pull field cannot be hidden by one provider", async () => {
    // Attack: the honest provider reports the over-pull; the other reports the displayed input exactly. With
    // identical `received`, only the `sent` comparison stands between this and an 'ok' verdict.
    const { calls } = mockRpc({
      "http://a.rpc": headAnd(0x1000, () => result()),
      "http://b.rpc": headAnd(0x1000, () => result({ sent: 1_000_001n })),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("mismatch");
      expect(v.reason.raw).toContain("sent=1000001");
    }
    expect(calls.filter((c) => c.method === "eth_call")).toHaveLength(2);
  });

  it("a disagreement ONLY in the router's `amountOut` is a mismatch — even with identical balance deltas", async () => {
    const { calls } = mockRpc({
      "http://a.rpc": headAnd(0x1000, () => result()),
      "http://b.rpc": headAnd(0x1000, () => result({ amountOut: 500_000_000_000_001n })),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") {
      expect(v.kind).toBe("mismatch");
      expect(v.reason.raw).toContain("out=500000000000001");
    }
    expect(calls.filter((c) => c.method === "eth_call")).toHaveLength(2);
  });

  it("a disagreement ONLY in `stage` (one says the swap reverted with empty data, one says ok) is a mismatch", async () => {
    mockRpc({
      "http://a.rpc": headAnd(0x1000, () => result()),
      "http://b.rpc": headAnd(0x1000, () => result({ stage: ProbeStage.SwapFailed, revertData: "0x" })),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") expect(v.kind).toBe("mismatch");
  });

  it("a disagreement in the REVERT data is a mismatch too — not a revert verdict from whichever answered first", async () => {
    const data = encodeErrorResult({ abi: ROUTER_ERROR_ABI, errorName: "DeadlinePassed" });
    mockRpc({
      "http://a.rpc": headAnd(0x1000, () => result({ stage: ProbeStage.SwapFailed, revertData: data, sent: 0n, received: 0n })),
      "http://b.rpc": headAnd(0x1000, () => result()),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("blocked");
    if (v.status === "blocked") expect(v.kind).toBe("mismatch");
  });

  it("a second opinion that cannot be reached is NOT a mismatch: verdict from the primary, providers=1", async () => {
    mockRpc({ "http://a.rpc": headAnd(0x1000, () => result()) /* b.rpc: fetch throws */ });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("ok");
    if (v.status === "ok") expect(v.providers).toBe(1);
  });

  it("a provider lagging more than the allowed blocks is not consulted, so a stale node cannot drag the pin back", async () => {
    const { calls } = mockRpc({
      "http://a.rpc": headAnd(0x2000, () => result()),
      "http://b.rpc": headAnd(0x1000, () => result()),
    });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("ok");
    if (v.status === "ok") {
      expect(v.providers).toBe(1);
      expect(v.blockNumber).toBe(0x2000n);
    }
    expect(calls.filter((c) => c.method === "eth_call" && c.url === "http://b.rpc")).toHaveLength(0);
  });

  it("duplicate URLs are one provider", async () => {
    const { calls } = mockRpc({ "http://a.rpc": headAnd(0x1000, () => result()) });
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://a.rpc"] }));
    expect(v.status).toBe("ok");
    if (v.status === "ok") expect(v.providers).toBe(1);
    expect(calls.filter((c) => c.method === "eth_call")).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------- could-not-run is its own thing */

describe("an RPC that cannot run the probe is 'unavailable', never a verdict on the swap", () => {
  it("every provider down → unavailable with a transport reason", async () => {
    mockRpc({});
    const v = await runSwapPreflight(req({ rpcUrls: ["http://a.rpc", "http://b.rpc"] }));
    expect(v.status).toBe("unavailable");
    if (v.status === "unavailable") expect(v.reason.source).toBe("transport");
  });

  it("an RPC that rejects the state override → unavailable, flagged as unsupported", async () => {
    mockRpc({
      "http://a.rpc": (method) =>
        method === "eth_blockNumber" ? { result: "0x10" } : { error: { code: -32602, message: "invalid argument 2: state override not supported" } },
    });
    const v = await runSwapPreflight(req());
    expect(v.status).toBe("unavailable");
    if (v.status === "unavailable") expect(v.reason.code).toBe("transport.unsupported");
  });

  it("a transient transport failure is retried ONCE; an execution answer is not", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === "eth_blockNumber") return { ok: true, json: async () => ({ result: "0x10" }) } as any;
      n++;
      if (n === 1) throw new TypeError("fetch failed");
      return { ok: true, json: async () => ({ result: result() }) } as any;
    });
    vi.stubGlobal("fetch", fetchMock);
    const v = await runSwapPreflight(req());
    expect(v.status).toBe("ok");
    expect(n).toBe(2);
  });

  it("no RPC configured → unavailable, not ok", async () => {
    const v = await runSwapPreflight(req({ rpcUrls: [] }));
    expect(v.status).toBe("unavailable");
  });
});
