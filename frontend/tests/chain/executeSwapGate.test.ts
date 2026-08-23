/**
 * executeSwapGate.test.ts — executeSwap must not ask the wallet to sign past a pre-flight that is not "ok",
 * and what it sends when it does sign is the exact calldata that was simulated.
 *
 * The wallet is the setup.ts window.ethereum mock (viem's custom transport calls `request`); the public RPC
 * is a fetch mock; the quoter and the pre-flight are mocked at their module boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, decodeFunctionData } from "viem";
import { moleRouterAbi } from "../../lib/aggregator/router";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const ROUTER = "0xBd9B841d690E31B61aa3858EB145EA8BBe71122c";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";
const HASH = `0x${"ab".repeat(32)}`;

const nowS = () => BigInt(Math.floor(Date.now() / 1000));

const encodedPlan = (deadline: bigint) => ({
  tokenIn: NATIVE as `0x${string}`,
  tokenOut: USDG as `0x${string}`,
  amountIn: 10n ** 15n,
  minAmountOut: 2_000_000n,
  recipient: ACCOUNT as `0x${string}`,
  deadline,
  paths: [
    {
      amountIn: 10n ** 15n,
      hops: [
        {
          venue: 0,
          pool: "0x00000000000000000000000000000000000000aa" as `0x${string}`,
          zeroForOne: true,
          tokenIn: WETH as `0x${string}`,
          tokenOut: USDG as `0x${string}`,
          key: { currency0: ZERO as `0x${string}`, currency1: ZERO as `0x${string}`, fee: 0, tickSpacing: 0, hooks: ZERO as `0x${string}` },
        },
      ],
    },
  ],
});

const swapQuoteFor = (deadline: bigint) => ({
  quote: { netAmountOut: 2_010_000n, amountOut: 2_010_000n, minAmountOut: 2_000_000n, feeBps: 69, feeAmount: 6_900_000_000_000n, routeDescriptions: ["via WETH → USDG [0.05%]"] },
  encoded: encodedPlan(deadline),
  value: 10n ** 15n,
});

const OK = { status: "ok", sent: 10n ** 15n, received: 2_010_000n, amountOut: 2_010_000n, providers: 1, blockNumber: 1n, at: 0 } as const;
const BLOCKED = {
  status: "blocked",
  kind: "shortfall",
  reason: { code: "preflight.shortfall", source: "preflight", title: "You would receive less than your minimum", message: "The simulation delivered 1.9 USDG, below your minimum of 2 USDG. Do not sign.", raw: "received=1900000 floor=2000000" },
  providers: 1,
  blockNumber: 1n,
  at: 0,
} as const;
const UNAVAILABLE = { status: "unavailable", at: 0, reason: { code: "transport.unavailable", source: "transport", title: "RPC did not answer", message: "The RPC endpoint did not answer.", raw: "fetch failed" } } as const;

let walletRequests: { method: string; params?: any }[] = [];
let verdict: any = OK;
const quoteSwap = vi.fn();

function installWallet() {
  walletRequests = [];
  (window as any).ethereum = {
    isMetaMask: true,
    on: vi.fn(),
    removeListener: vi.fn(),
    request: vi.fn(async ({ method, params }: any) => {
      walletRequests.push({ method, params });
      switch (method) {
        case "eth_chainId": return "0x1237";
        case "eth_accounts":
        case "eth_requestAccounts": return [ACCOUNT];
        case "eth_sendTransaction": return HASH;
        default: return null;
      }
    }),
  };
}

function installRpc() {
  const receipt = {
    transactionHash: HASH, blockHash: `0x${"11".repeat(32)}`, blockNumber: "0x10", transactionIndex: "0x0", from: ACCOUNT, to: ROUTER,
    cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const answer = (req: any) => {
      switch (req.method) {
        case "eth_blockNumber": return "0x10";
        // The only eth_call executeSwap makes itself is the ERC-20 allowance read; answer "unlimited" so an
        // ERC-20-in path skips the approve step (the pre-flight is mocked at its module boundary).
        case "eth_call": return `0x${"ff".repeat(32)}`;
        case "eth_getTransactionReceipt": return receipt;
        case "eth_getTransactionByHash": return { hash: HASH, blockNumber: "0x10", blockHash: receipt.blockHash, from: ACCOUNT, to: ROUTER, nonce: "0x1", value: "0x0", input: "0x", gas: "0x5208", gasPrice: "0x1", transactionIndex: "0x0", type: "0x2", chainId: "0x1237" };
        case "eth_getBlockByNumber": return { number: "0x10", hash: receipt.blockHash, transactions: [HASH], timestamp: "0x1", baseFeePerGas: "0x1" };
        default: return null;
      }
    };
    const payload = Array.isArray(body) ? body.map((r) => ({ jsonrpc: "2.0", id: r.id, result: answer(r) })) : { jsonrpc: "2.0", id: body.id, result: answer(body) };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload), headers: new Headers({ "content-type": "application/json" }) } as any;
  }));
}

async function loadAmm() {
  vi.resetModules();
  vi.doMock("@/lib/aggregator/simulate", () => ({ runSwapPreflight: vi.fn(async () => verdict) }));
  vi.doMock("@/lib/aggregator/client", () => ({ quoteSwap: (...a: any[]) => quoteSwap(...a) }));
  vi.doMock("@/lib/aggregator/serverPools", async (orig) => {
    const real = (await orig()) as any;
    // Both registry readers are stubbed: loadPoolRows() reaches for the pair query first
    // (fetchPairRowsWithSimulate, which also pulls the simulate-eligible hooked rows) and falls back to
    // fetchPoolRowsByPair. This suite is about the pre-flight gate in front of signing, not the registry.
    return {
      ...real,
      fetchPoolRowsByPair: async () => [{ id: "p", venue: "pancake_v3", active: true }],
      fetchPairRowsWithSimulate: async () => [{ id: "p", venue: "pancake_v3", active: true }],
    };
  });
  vi.doMock("@/lib/supabase/client", () => ({ createClient: () => ({ from: () => ({}) }) }));
  vi.doMock("@/lib/mole/aggFee", () => ({ getAggFeeBps: async () => 69 }));
  return import("@/lib/chain/amm");
}

beforeEach(() => {
  installWallet();
  installRpc();
  quoteSwap.mockReset();
  quoteSwap.mockImplementation(async () => swapQuoteFor(nowS() + 60n));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/aggregator/simulate");
  vi.doUnmock("@/lib/aggregator/client");
  vi.doUnmock("@/lib/aggregator/serverPools");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/mole/aggFee");
});

const sends = () => walletRequests.filter((r) => r.method === "eth_sendTransaction");

describe("executeSwap signs nothing past a pre-flight that is not ok", () => {
  it("BLOCKED → returns the decoded reason, calls onPreflight, and never asks the wallet to sign", async () => {
    verdict = BLOCKED;
    const { executeSwap } = await loadAmm();
    const onPreflight = vi.fn();
    const res = await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, onPreflight });
    expect(res.success).toBe(false);
    expect(res.error).toBe(BLOCKED.reason.message);
    expect(res.preflight).toEqual(BLOCKED);
    expect(onPreflight).toHaveBeenCalledWith(BLOCKED);
    expect(sends()).toHaveLength(0);
  });

  it("UNAVAILABLE → fails closed: nothing is signed, and the message says the pre-flight could not run", async () => {
    verdict = UNAVAILABLE;
    const { executeSwap } = await loadAmm();
    const res = await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Pre-flight could not run, so nothing was signed/);
    expect(sends()).toHaveLength(0);
  });

  it("OK → sends exactly the simulated calldata to the router with the native value", async () => {
    verdict = OK;
    const { executeSwap, prepareSwap } = await loadAmm();
    const prepared = await prepareSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT });
    expect(prepared).not.toBeNull();
    const res = await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, prepared: prepared! });
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(res.txHash).toBe(HASH);
    const tx = sends()[0]!.params[0];
    expect(tx.to.toLowerCase()).toBe(ROUTER.toLowerCase());
    expect(tx.data).toBe(prepared!.calldata);
    expect(BigInt(tx.value)).toBe(10n ** 15n);
    // and the calldata IS MoleRouter.swap(plan) for the plan the quoter produced
    const decoded = decodeFunctionData({ abi: moleRouterAbi, data: tx.data }) as any;
    expect(decoded.functionName).toBe("swap");
    expect(decoded.args[0].recipient.toLowerCase()).toBe(ACCOUNT);
    expect(prepared!.calldata).toBe(encodeFunctionData({ abi: moleRouterAbi, functionName: "swap", args: [prepared!.encoded] }));
  });

  it("a FRESH handed-over swap is signed as-is (no re-quote); a STALE one is rebuilt first", async () => {
    verdict = OK;
    const { executeSwap, prepareSwap } = await loadAmm();
    const fresh = await prepareSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT });
    quoteSwap.mockClear();
    await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, prepared: fresh! });
    expect(quoteSwap).not.toHaveBeenCalled();
    expect(sends()[0]!.params[0].data).toBe(fresh!.calldata);

    // stale: deadline inside the rebuild margin
    quoteSwap.mockImplementationOnce(async () => swapQuoteFor(nowS() + 5n));
    const stale = await prepareSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT });
    quoteSwap.mockClear();
    walletRequests = [];
    await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, prepared: stale! });
    expect(quoteSwap).toHaveBeenCalledTimes(1);
    expect(sends()[0]!.params[0].data).not.toBe(stale!.calldata); // the rebuilt plan carries a new deadline
  });

  it("a handed-over swap for a DIFFERENT pair (tokenIn, or tokenOut) or a DIFFERENT recipient is not trusted — rebuilt", async () => {
    verdict = OK;
    const { executeSwap, prepareSwap } = await loadAmm();
    const handed = await prepareSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT });
    expect(handed).not.toBeNull();

    // tokenIn differs (ERC-20 WETH in, same amount/out/recipient): the handed native plan must not be signed.
    quoteSwap.mockClear();
    walletRequests = [];
    let res = await executeSwap({ tokenIn: WETH, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, prepared: handed! });
    expect(res.error).toBeUndefined();
    expect(quoteSwap).toHaveBeenCalledTimes(1);
    expect(quoteSwap.mock.calls[0]![1].tokenIn.toLowerCase()).toBe(WETH.toLowerCase());

    // tokenOut differs.
    quoteSwap.mockClear();
    walletRequests = [];
    res = await executeSwap({ tokenIn: ZERO, tokenOut: WETH, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, prepared: handed! });
    expect(res.error).toBeUndefined();
    expect(quoteSwap).toHaveBeenCalledTimes(1);
    expect(quoteSwap.mock.calls[0]![1].tokenOut.toLowerCase()).toBe(WETH.toLowerCase());

    // recipient differs (a custom destination typed after the card was prepared).
    const OTHER = "0x00000000000000000000000000000000000000b2";
    quoteSwap.mockClear();
    walletRequests = [];
    res = await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT, outputRecipient: OTHER, prepared: handed! });
    expect(res.error).toBeUndefined();
    expect(quoteSwap).toHaveBeenCalledTimes(1);
    expect(quoteSwap.mock.calls[0]![1].recipient.toLowerCase()).toBe(OTHER);
  });

  it("a handed-over swap for a DIFFERENT amount is not trusted — rebuilt", async () => {
    verdict = OK;
    const { executeSwap, prepareSwap } = await loadAmm();
    const other = await prepareSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (10n ** 15n).toString(), recipient: ACCOUNT });
    quoteSwap.mockClear();
    await executeSwap({ tokenIn: ZERO, tokenOut: USDG, amountIn: (2n * 10n ** 15n).toString(), recipient: ACCOUNT, prepared: other! });
    expect(quoteSwap).toHaveBeenCalledTimes(1);
  });
});
