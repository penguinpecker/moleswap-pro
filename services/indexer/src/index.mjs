/**
 * MoleSwap pool indexer — an always-on Railway service that keeps the aggregator's Supabase pool registry
 * current. Every REFRESH_MINUTES it enumerates PancakeSwap V3 PoolCreated events on Robinhood Chain,
 * measures each pool's in-range liquidity, and upserts the live ones into `mp_pools` (flipping drained
 * pools inactive). The frontend reads that registry to know which pools exist; the executor's on-chain
 * minAmountOut stays the only safety guarantee, so a stale registry can miss a route, never mis-settle.
 *
 * Dependency-light on purpose: raw JSON-RPC over fetch plus the Supabase client. No heavy web3 stack.
 */

import http from "node:http";
import { createClient } from "@supabase/supabase-js";

const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
// The indexer writes through a secret-gated SECURITY DEFINER function with the ANON key, so a full
// service-role key never lives in this service. The secret only gates pool-REGISTRY writes; the
// executor's on-chain minAmountOut remains the sole fund-safety guarantee, so even a leaked secret can
// at worst churn the registry, never mis-settle a swap.
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const WRITE_SECRET = process.env.INDEXER_SECRET;
const REFRESH_MS = (Number(process.env.REFRESH_MINUTES) || 10) * 60_000;
const PORT = Number(process.env.PORT) || 8080;

const PANCAKE_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
// keccak256("PoolCreated(address,address,uint24,int24,address)")
const POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";

if (!SUPABASE_URL || !ANON_KEY || !WRITE_SECRET) {
  console.error("SUPABASE_URL, SUPABASE_ANON_KEY and INDEXER_SECRET are required");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

let lastRun = null;
let lastCounts = { discovered: 0, active: 0 };
let lastError = null;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

async function rpcBatch(calls) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [c, "latest"] }))),
  });
  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];
  const byId = new Map(arr.map((r) => [r.id, r]));
  return calls.map((_, i) => byId.get(i)?.result ?? "0x");
}

const addr = (topic) => "0x" + topic.slice(-40);
const feeTierSpacing = (fee) => ({ 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 }[fee] ?? 60);

async function discoverPools() {
  const logs = await rpc("eth_getLogs", [
    { address: PANCAKE_FACTORY, topics: [POOL_CREATED_TOPIC], fromBlock: "0x0", toBlock: "latest" },
  ]);
  if (!Array.isArray(logs)) return [];
  return logs.map((l) => ({
    token0: addr(l.topics[1]),
    token1: addr(l.topics[2]),
    fee: parseInt(l.topics[3], 16),
    pool: addr(l.data),
  }));
}

async function measureLiquidity(pools) {
  const SEL_LIQUIDITY = "0x1a686502"; // liquidity()
  const out = [];
  for (let i = 0; i < pools.length; i += 40) {
    const chunk = pools.slice(i, i + 40);
    const results = await rpcBatch(chunk.map((p) => ({ to: p.pool, data: SEL_LIQUIDITY })));
    chunk.forEach((p, j) => {
      const v = results[j];
      out.push({ ...p, liquidity: v && v !== "0x" ? BigInt(v) : 0n });
    });
  }
  return out;
}

async function refresh() {
  const discovered = await discoverPools();
  const measured = await measureLiquidity(discovered);

  const rows = measured.map((p) => ({
    id: p.pool.toLowerCase(),
    venue: "pancake_v3",
    token0: p.token0.toLowerCase(),
    token1: p.token1.toLowerCase(),
    fee: p.fee,
    tick_spacing: feeTierSpacing(p.fee),
    address: p.pool.toLowerCase(),
    active: p.liquidity > 0n,
  }));

  // Upsert in batches through the secret-gated RPC (bypasses RLS for this one controlled write only).
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await supabase.rpc("mp_upsert_pools", { p_secret: WRITE_SECRET, p_pools: batch });
    if (error) throw new Error(`upsert: ${error.message}`);
  }

  lastCounts = { discovered: rows.length, active: rows.filter((r) => r.active).length };
  lastRun = new Date().toISOString();
  lastError = null;
  console.log(`[${lastRun}] indexed ${lastCounts.discovered} pools, ${lastCounts.active} active`);
}

async function loop() {
  try {
    await refresh();
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("refresh failed:", lastError);
  }
  setTimeout(loop, REFRESH_MS);
}

// Health endpoint so Railway (and a status page) can see the indexer is alive and current.
http
  .createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(lastError ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !lastError, lastRun, ...lastCounts, error: lastError }));
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`indexer health on :${PORT}`));

loop();
