/**
 * fakeRpc.ts — a scripted JSON-RPC node for the hooked-quote tests.
 *
 * The hooked path (hookedQuote.ts) sends ONE JSON-RPC batch per quote containing heterogeneous reads:
 * quoter eth_calls (V4 Quoter, selector 0xaa9d21cb), StateView getSlot0 / getLiquidity eth_calls, and
 * per-hook eth_getCode / eth_getStorageAt screens. Mocking each module function would test the mocks; this
 * answers at the WIRE level — the real encoders run, the real decoders run — from a small scripted world:
 * pools keyed by PoolId (quoter answer or revert, slot0, liquidity) and hooks keyed by address (code, slots).
 *
 * Install with `vi.doMock("../../lib/aggregator/rpcBatch", () => ({ jsonRpcBatch: fake.jsonRpcBatch }))`
 * (or stub global fetch with `fake.fetch`) — both shapes are provided.
 */
import { encodeAbiParameters, keccak256, encodePacked } from "viem";
import type { RpcBatchCall, RpcBatchResult } from "../../lib/aggregator/rpcBatch";

export const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
export const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const SEL_QUOTE = "0xaa9d21cb";
const SEL_SLOT0 = keccak256(encodePacked(["string"], ["getSlot0(bytes32)"])).slice(0, 10);
const SEL_LIQ = keccak256(encodePacked(["string"], ["getLiquidity(bytes32)"])).slice(0, 10);
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO_WORD = "0x" + "0".repeat(64);

export interface FakePool {
  /** Quoter answer for ANY amount/direction (the fake does not run curve math), or "revert". Can be a
   *  function of (zeroForOne, amountIn) for amount-dependent scripts. */
  quote: { amountOut: bigint; gasEstimate?: bigint } | "revert" | ((zeroForOne: boolean, amountIn: bigint) => { amountOut: bigint; gasEstimate?: bigint } | "revert");
  slot0?: { sqrtPriceX96: bigint; tick: number; protocolFee?: number; lpFee?: number } | "revert";
  liquidity?: bigint | "revert";
}

export interface FakeHook {
  code: string; // "0x" = no code
  impl?: string; // 32-byte word
  beacon?: string;
}

export interface FakeWorld {
  /** PoolId (lowercase 0x…) → pool script. */
  pools: Record<string, FakePool>;
  /** hook address (lowercase) → hook script. Unknown hooks answer "no code". */
  hooks: Record<string, FakeHook>;
  /** Optional: fail the whole batch (transport) this many times, then recover. */
  failBatches?: number;
}

/** Decode the quoter calldata we encoded: poolId from the key, zeroForOne, exactAmount. */
function parseQuoteCalldata(data: string): { poolId: string; zeroForOne: boolean; amountIn: bigint } {
  const body = data.slice(10); // strip selector
  const word = (i: number) => body.slice(i * 64, i * 64 + 64);
  // word0 = offset(0x20); then currency0, currency1, fee, tickSpacing, hooks, zeroForOne, exactAmount, hookData offset, len
  const currency0 = ("0x" + word(1).slice(24)) as `0x${string}`;
  const currency1 = ("0x" + word(2).slice(24)) as `0x${string}`;
  const fee = Number(BigInt("0x" + word(3)));
  let tickSpacing = Number(BigInt("0x" + word(4)) & 0xffffffn);
  if (tickSpacing >= 0x800000) tickSpacing -= 0x1000000;
  const hooks = ("0x" + word(5).slice(24)) as `0x${string}`;
  const zeroForOne = BigInt("0x" + word(6)) === 1n;
  const amountIn = BigInt("0x" + word(7));
  const poolId = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, fee, tickSpacing, hooks],
    ),
  ).toLowerCase();
  return { poolId, zeroForOne, amountIn };
}

export function makeFakeRpc(world: FakeWorld) {
  const calls: RpcBatchCall[][] = []; // every batch received, for assertions
  let failLeft = world.failBatches ?? 0;

  function answer(c: RpcBatchCall): RpcBatchResult {
    if (c.method === "eth_getCode") {
      const hook = String(c.params[0]).toLowerCase();
      return { ok: true, result: world.hooks[hook]?.code ?? "0x" };
    }
    if (c.method === "eth_getStorageAt") {
      const hook = String(c.params[0]).toLowerCase();
      const slot = String(c.params[1]).toLowerCase();
      const h = world.hooks[hook];
      if (slot === IMPL_SLOT) return { ok: true, result: h?.impl ?? ZERO_WORD };
      if (slot === BEACON_SLOT) return { ok: true, result: h?.beacon ?? ZERO_WORD };
      return { ok: true, result: ZERO_WORD };
    }
    if (c.method === "eth_call") {
      const { to, data } = c.params[0] as { to: string; data: string };
      const toLc = to.toLowerCase();
      const sel = data.slice(0, 10).toLowerCase();
      if (toLc === QUOTER && sel === SEL_QUOTE) {
        const { poolId, zeroForOne, amountIn } = parseQuoteCalldata(data);
        const p = world.pools[poolId];
        if (!p) return { ok: false, error: "execution reverted (unknown pool)" };
        const q = typeof p.quote === "function" ? p.quote(zeroForOne, amountIn) : p.quote;
        if (q === "revert") return { ok: false, error: "execution reverted" };
        return {
          ok: true,
          result: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [q.amountOut, q.gasEstimate ?? 1n]),
        };
      }
      if (toLc === STATE_VIEW && (sel === SEL_SLOT0 || sel === SEL_LIQ)) {
        const poolId = ("0x" + data.slice(10, 74)).toLowerCase();
        const p = world.pools[poolId];
        if (sel === SEL_SLOT0) {
          const s = p?.slot0;
          if (!s || s === "revert") return s === "revert" ? { ok: false, error: "reverted" } : { ok: true, result: encodeAbiParameters([{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }], [0n, 0, 0, 0]) };
          return {
            ok: true,
            result: encodeAbiParameters(
              [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
              [s.sqrtPriceX96, s.tick, s.protocolFee ?? 0, s.lpFee ?? 0],
            ),
          };
        }
        const l = p?.liquidity;
        if (l === "revert") return { ok: false, error: "reverted" };
        return { ok: true, result: encodeAbiParameters([{ type: "uint128" }], [l ?? 0n]) };
      }
      return { ok: false, error: `fakeRpc: unscripted eth_call to ${to} ${sel}` };
    }
    return { ok: false, error: `fakeRpc: unscripted method ${c.method}` };
  }

  const jsonRpcBatch = async (_url: string, batch: readonly RpcBatchCall[]): Promise<RpcBatchResult[]> => {
    calls.push([...batch]);
    if (failLeft > 0) {
      failLeft--;
      throw new Error("fakeRpc: transport failure");
    }
    return batch.map(answer);
  };

  /** A global-fetch stand-in with the same world, for code that still calls fetch directly. */
  const fetch = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const batch: { id: number; method: string; params: unknown[] }[] = Array.isArray(body) ? body : [body];
    calls.push(batch.map((b) => ({ method: b.method, params: b.params })));
    if (failLeft > 0) {
      failLeft--;
      throw new Error("fakeRpc: transport failure");
    }
    const out = batch.map((b) => {
      const a = answer({ method: b.method, params: b.params });
      return a.ok ? { id: b.id, jsonrpc: "2.0", result: a.result } : { id: b.id, jsonrpc: "2.0", error: { code: 3, message: a.error } };
    });
    return { ok: true, status: 200, json: async () => (Array.isArray(body) ? out : out[0]) };
  };

  return { jsonRpcBatch, fetch, calls, world };
}

/** The PoolId for a registry-shaped row, for keying the fake world. */
export function poolIdOfRow(row: { token0: string; token1: string; fee: number; tick_spacing: number; hooks: string | null }): string {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [row.token0 as `0x${string}`, row.token1 as `0x${string}`, row.fee, row.tick_spacing, (row.hooks ?? "0x0000000000000000000000000000000000000000") as `0x${string}`],
    ),
  ).toLowerCase();
}
