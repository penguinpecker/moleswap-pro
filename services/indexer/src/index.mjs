/**
 * MoleSwap indexer — an always-on Railway service that keeps the Robinhood Chain token list and pool
 * registry fresh for the aggregator. It runs INCREMENTALLY every REFRESH_SECONDS (default 60):
 *
 *   1. Discover — read PoolCreated logs from a persisted block cursor forward across every executable V3
 *      factory (sub-chunked, fail-closed), upsert new pools into `mp_pools`, and register brand-new
 *      tokens (symbol/name/decimals) into `mp_tokens`.
 *   2. Refresh liquidity — re-measure the hub-pool (WETH/USDG) reserve behind every VERIFIED token each
 *      cycle, plus a rotating slice of the unverified long tail, keep the DEEPEST pool per token, and
 *      write `liquidity`/`verified` back. This keeps the verified list current: a token that loses its
 *      liquidity de-verifies, one that gains it verifies.
 *
 * Safety invariant: the block cursor only advances after a range is FULLY processed (all factories, all
 * sub-chunks), and only up to a finality lag, so no PoolCreated is ever silently skipped. All writes go
 * through secret-gated SECURITY DEFINER RPCs — no service-role key lives on the box. The executor's
 * on-chain minAmountOut stays the only fund-safety guarantee, so a stale registry can at worst miss a
 * route, never mis-settle.
 */

import http from "node:http";
import { createClient } from "@supabase/supabase-js";
import { checkOracleLiveness, oracleHealthView, LIVE_POOL_ID as ORACLE_LIVE_POOL_ID, ORACLE_STALE_SECONDS } from "./oracleHealth.mjs";
import { classifyV4Pool, isTickRoutable, MOLE_HOOK } from "./v4Class.mjs";

/* ---------------------------------------------------------------------------------------------- config */
const RPC = process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const WRITE_SECRET = process.env.INDEXER_SECRET;
const REFRESH_MS = (Number(process.env.REFRESH_SECONDS) || 60) * 1000;
const PORT = Number(process.env.PORT) || 8080;

const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS) || 20_000; // abort a stalled RPC socket
const GETLOGS_CHUNK = Number(process.env.GETLOGS_CHUNK) || 5_000; // block span per eth_getLogs (provider-safe)
const MAX_BLOCKS_PER_CYCLE = Number(process.env.MAX_BLOCKS_PER_CYCLE) || 200_000; // discovery work per cycle
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS) || 5; // finality lag so the cursor never rides the tip
const UNVERIFIED_REFRESH_BATCH = Number(process.env.UNVERIFIED_REFRESH_BATCH) || 4000;
const STALE_MULTIPLIER = Number(process.env.STALE_MULTIPLIER) || 5; // /health = 503 after this × REFRESH_MS

/* ---- USDG per WETH ----------------------------------------------------------------------------
 * This number converts a USDG-hub reserve into WETH-equivalent depth (measureDeepest) and a WETH-side
 * swap notional into USD (refreshVolume). Depth then decides `verified` (>= 0.05) inside
 * mp_refresh_tokens — i.e. whether a token is offered in the picker at all — so a frozen price is a
 * frozen threshold: it was a hardcoded 1900 read from an env var that is set NOWHERE, ~1.8% above the
 * live pool, with no mechanism to track the market. An ETH move of any size would silently redraw the
 * verified list with no code change and a green /health.
 *
 * It is now READ FROM THE CHAIN (the WETH/USDG pool's slot0) and re-read every PRICE_TTL_SECONDS.
 * PRICE_USDG_PER_ETH still works, but now as an explicit PIN: set it and the live read is skipped.
 * The old 1900 survives only as the last-resort fallback if the very first read fails, and any read
 * outside [PRICE_MIN, PRICE_MAX] is refused rather than allowed to re-verify the whole token list. */
const PRICE_POOL = (process.env.PRICE_POOL || "0x88a8e96e7785d378825e8b5d7fc0e6f62487061e").toLowerCase();
const PRICE_PIN = Number(process.env.PRICE_USDG_PER_ETH) || 0; // 0 = read live
const PRICE_FALLBACK = Number(process.env.PRICE_USDG_PER_ETH_FALLBACK) || 1900;
const PRICE_TTL_MS = (Number(process.env.PRICE_TTL_SECONDS) || 300) * 1000;
const PRICE_MIN = 50;
const PRICE_MAX = 500_000;

const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

// The Uniswap-v4 singleton. v4 pools have no factory and no address — a pool is a PoolKey hashed
// into an id inside this contract — so they are discovered from its Initialize event instead of from
// a factory's PoolCreated. Measured on this chain: 8,490 external v4 pools, and launchpad tokens are
// going there, which is why v4-only tokens quoted "no route" while trading fine on-chain.
const POOL_MANAGER = (process.env.POOL_MANAGER || "0x8366a39CC670B4001A1121B8F6A443A643e40951").toLowerCase();
// keccak("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)")
const V4_INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
// MoleSwap's own hook (MOLE_HOOK, from v4Class.mjs so the classifier and this skip name ONE address) —
// pools carrying it are operator-registered as venue mole_v4 and are deliberately invisible to the
// generic v4 scan (see discoverV4).
// How a discovered v4 pool may be quoted — 'ticks' (tick math, active=true), 'simulate' (return-delta
// hook, priced by on-chain simulation in the frontend, active=false but loaded on demand by pair) or
// 'native' (a native leg the router cannot settle, active=false and unroutable). The rule lives in
// ./v4Class.mjs so the frontend's mirror (lib/aggregator/hookClass.ts) can be tested against it.

const FACTORIES = [
  { f: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", venue: "uniswap_v3" },
  { f: "0xe51960f1b45f1c9fb6d166e6a884f866fc70433b", venue: "uniswap_v3" },
  { f: "0x3fdabf7ab5d871b89f1d9da04dc2e0733db70caf", venue: "uniswap_v3" },
  { f: "0xd479e71c45aeb1e846a7b549c346d62fe77b39ba", venue: "uniswap_v3" },
  { f: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", venue: "pancake_v3" },
  { f: "0x0ec554f0bff0be6c99d1e95c8015bb0950f6a2c7", venue: "pancake_v3" },
];
const POOL_CREATED_TOPIC = "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118";
const SPACING = { 80: 1, 100: 1, 250: 5, 500: 10, 2500: 50, 3000: 60, 10000: 200 };

/* ---- swap-volume config: real per-pool 24h volume/fees for the pools page ----
 * We scan Swap events for a small set of tracked pools, bucket the USD notional by ~1h block windows,
 * and store it in mp_pool_volume. The 24h view sums the last 24h. This is REAL on-chain volume, not a
 * model. The tracked set is the pools the app displays (WETH/USDG tiers) — extend via VOLUME_POOLS. */
const UNI_V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const PANCAKE_V3_SWAP = "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83";
// keccak("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)") — the v4 PoolManager's Swap
// (IPoolManager.sol:91). A v4 pool has NO ADDRESS, so it can never appear in an address-filtered V3-shaped
// scan: the swap is emitted by the singleton with the PoolId in topic1. Verified against the live chain.
const V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const BLOCKS_PER_BUCKET = Number(process.env.VOL_BLOCKS_PER_BUCKET) || 36000; // ~1h at RH's ~0.0999s/block
const BLOCKS_24H = Number(process.env.VOL_BLOCKS_24H) || 864000; // measured 864,691 blocks / 24h
const MAX_VOL_BLOCKS_PER_CYCLE = Number(process.env.MAX_VOL_BLOCKS_PER_CYCLE) || 900000; // backfill the full 24h in the first cycle (~173 getLogs for 3 pools, ~11s); tiny incremental reads after
/**
 * The tracked set, as ids in `mp_pools`. Two SHAPES live here and the difference is load-bearing:
 *   - a 42-char string is a V3 pool ADDRESS  (venue pancake_v3 / uniswap_v3)
 *   - a 66-char string is a v4 bytes32 PoolId (venue mole_v4 / uniswap_v4 — those rows have no address)
 * Volume is stored under the SAME id, because that is the key the reader joins on: /pools renders
 * venue='mole_v4' rows (lib/chain/livePools.ts) and looks their volume up by `poolId`. The default used
 * to be three V3 addresses ONLY, so every row the page rendered missed the lookup and the 24h volume /
 * fees columns and the fee-APY were structurally 0 — real indexed volume that nothing could ever render.
 * The MoleSwap WETH/USDG pool id (LIVE_POOL_ID in lib/mole/chain.ts) is therefore tracked by default.
 * The three V3 addresses are kept: they hold real, already-indexed volume and cost nothing to maintain.
 */
const VOLUME_POOLS = (process.env.VOLUME_POOLS ||
  "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029," +
  "0x88a8e96e7785d378825e8b5d7fc0e6f62487061e,0x4520f3f932ae530c58cc332b532951e5814e6cb8,0x0ff6bdd6ac5db3426c3c2c922f93a5749887e28d")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!SUPABASE_URL || !ANON_KEY || !WRITE_SECRET) {
  console.error("SUPABASE_URL, SUPABASE_ANON_KEY and INDEXER_SECRET are required");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });

let status = { lastRun: null, lastRunMs: 0, cursor: 0, latest: 0, newPools: 0, newTokens: 0, refreshed: 0, verified: 0, error: null };

/* ---- oracle observation liveness (its OWN health signal) ----------------------------------------
 * Per mole pool: age of the newest MoleHook ring observation, its TWAP mid, and a stale flag; plus the
 * Chainlink ETH/USD cross-check for the live pool. Starts STALE (never checked) on purpose — the
 * never-ran case must not read as healthy. Not folded into `ok`/503: a quiet pool is not a wedged
 * process, and restarting this service cannot un-stale a ring nobody has swapped on. Alert on
 * `oracle.stale` separately. Extra ids via ORACLE_POOLS (comma-separated bytes32); the live pool and
 * every mp_pools row with venue mole_v4 are always included. */
const ORACLE_POOLS = (process.env.ORACLE_POOLS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
let oracleStatus = { checkedAt: null, checkedAtMs: 0, thresholdSec: ORACLE_STALE_SECONDS, stale: true, pools: {}, crossCheck: null, error: null };

/* ------------------------------------------------------------------------------------------- rpc utils */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params, tries = 4) {
  let lastErr;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS), // a stalled socket must not hang the whole loop
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`${method}: ${json.error.message}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      if (a < tries - 1) await sleep(300 * (a + 1));
    }
  }
  throw lastErr;
}
const lc = (a) => a.toLowerCase();
const topicAddr = (t) => "0x" + t.slice(-40);
const dataAddr = (data, word) => "0x" + data.slice(2 + word * 64 + 24, 2 + word * 64 + 64);
const pad32 = (h) => h.replace(/^0x/, "").padStart(64, "0");

const AGG3_SELECTOR = "0x82ad56cb";
function encodeAggregate3(calls) {
  const head = [];
  const bodies = [];
  for (const c of calls) {
    const data = c.callData.replace(/^0x/, "");
    const len = data.length / 2;
    const padded = data.padEnd(Math.ceil(len / 32) * 64, "0");
    bodies.push(pad32(c.target) + pad32("1") + pad32((0x60).toString(16)) + pad32(len.toString(16)) + padded);
  }
  let off = calls.length * 32;
  for (const b of bodies) { head.push(pad32(off.toString(16))); off += b.length / 2; }
  return AGG3_SELECTOR + pad32((0x20).toString(16)) + pad32(calls.length.toString(16)) + head.join("") + bodies.join("");
}
function decodeAggregate3(hex) {
  const body = hex.replace(/^0x/, "");
  const word = (i) => body.slice(i * 64, i * 64 + 64);
  const uintAt = (i) => Number(BigInt("0x" + word(i)));
  const base = uintAt(0) / 32;
  const len = uintAt(base);
  const out = [];
  for (let i = 0; i < len; i++) {
    const off = base + 1 + uintAt(base + 1 + i) / 32;
    const success = BigInt("0x" + word(off)) === 1n;
    const bOff = off + uintAt(off + 1) / 32;
    const bLen = uintAt(bOff);
    const data = "0x" + body.slice((bOff + 1) * 64, (bOff + 1) * 64 + bLen * 2);
    out.push({ success, data });
  }
  return out;
}
async function multicall(calls) {
  const out = [];
  const CHUNK = 500;
  for (let i = 0; i < calls.length; i += CHUNK) {
    const batch = calls.slice(i, i + CHUNK);
    const raw = await rpc("eth_call", [{ to: MC3, data: encodeAggregate3(batch) }, "latest"]);
    out.push(...decodeAggregate3(raw));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- decoding */
const PRINTABLE = /[^\x20-\x7e]/g;
const CTRL = /[\x00-\x1f\x7f]/g;
function decodeStr(hex) {
  if (!hex || hex === "0x") return null;
  try {
    const b = hex.replace(/^0x/, "");
    const len = Number(BigInt("0x" + b.slice(64, 128)));
    if (len > 0 && len < 256 && b.length >= 128 + len * 2) {
      const s = Buffer.from(b.slice(128, 128 + len * 2), "hex").toString("utf8").replace(PRINTABLE, "").trim();
      if (s) return s;
    }
  } catch {}
  try {
    const s = Buffer.from(hex.replace(/^0x/, "").slice(0, 64), "hex").toString("utf8").replace(PRINTABLE, "").trim();
    return s || null;
  } catch { return null; }
}
const sanitize = (s, max) => (s ? s.replace(CTRL, "").replace(/[<>]/g, "").trim().slice(0, max) || null : null);
const SEL = { symbol: "0x95d89b41", name: "0x06fdde03", decimals: "0x313ce567" };
const POOL_SEL = { slot0: "0x3850c7bd", token0: "0x0dfe1681", token1: "0xd21220a7" };
const balanceOf = (holder) => "0x70a08231" + pad32(holder);

/* -------------------------------------------------------------------------------------- eth price */
let _price = { at: 0, value: 0 };

/**
 * USDG per WETH, read live from PRICE_POOL's slot0 and cached for PRICE_TTL_MS.
 *
 * Never throws: a failed read reuses the last good value, or PRICE_FALLBACK if there has never been one,
 * and says so — a silent fallback here would mis-measure every USDG-hub token's depth and quietly move
 * the verified/unverified line.
 */
async function usdgPerEth() {
  if (PRICE_PIN > 0) return PRICE_PIN;
  if (_price.value > 0 && Date.now() - _price.at < PRICE_TTL_MS) return _price.value;
  try {
    const [t0, t1, s0] = await Promise.all([
      rpc("eth_call", [{ to: PRICE_POOL, data: POOL_SEL.token0 }, "latest"]),
      rpc("eth_call", [{ to: PRICE_POOL, data: POOL_SEL.token1 }, "latest"]),
      rpc("eth_call", [{ to: PRICE_POOL, data: POOL_SEL.slot0 }, "latest"]),
    ]);
    const a0 = "0x" + String(t0).slice(-40).toLowerCase();
    const a1 = "0x" + String(t1).slice(-40).toLowerCase();
    // The orientation is PROVEN, not assumed: WETH has 18 decimals and USDG 6, so reading the pair the
    // wrong way round is a 1e24 error, not a rounding one.
    const wethFirst = a0 === WETH && a1 === USDG;
    const usdgFirst = a0 === USDG && a1 === WETH;
    if (!wethFirst && !usdgFirst) throw new Error(`PRICE_POOL ${PRICE_POOL} is not WETH/USDG (${a0}/${a1})`);
    const sqrt = Number(BigInt("0x" + String(s0).replace(/^0x/, "").slice(0, 64))) / 2 ** 96;
    const ratio = sqrt * sqrt; // raw token1 per raw token0
    // human price = ratio * 10^(dec0 - dec1); WETH=18, USDG=6.
    const price = wethFirst ? ratio * 1e12 : 1e12 / ratio;
    if (!Number.isFinite(price) || price < PRICE_MIN || price > PRICE_MAX) {
      throw new Error(`implausible USDG/WETH price ${price} from ${PRICE_POOL}`);
    }
    _price = { at: Date.now(), value: price };
    return price;
  } catch (e) {
    const fallback = _price.value > 0 ? _price.value : PRICE_FALLBACK;
    console.warn(`price read failed (${e instanceof Error ? e.message : String(e)}); using ${fallback}`);
    return fallback;
  }
}

/* ---------------------------------------------------------------------------------------- discovery */
/** Read PoolCreated across all factories for [from,to], sub-chunked and FAIL-CLOSED: any failure throws
 *  so the caller does NOT advance the cursor past a range that wasn't fully read. */
async function discover(from, to) {
  const pools = [];
  for (const { f, venue } of FACTORIES) {
    for (let lo = from; lo <= to; lo += GETLOGS_CHUNK) {
      const hi = Math.min(to, lo + GETLOGS_CHUNK - 1);
      const logs = await rpc("eth_getLogs", [
        { address: f, topics: [POOL_CREATED_TOPIC], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) },
      ]); // throws on persistent failure → whole cycle aborts, cursor stays put
      if (!Array.isArray(logs)) continue;
      for (const l of logs) {
        pools.push({
          token0: lc(topicAddr(l.topics[1])),
          token1: lc(topicAddr(l.topics[2])),
          fee: parseInt(l.topics[3], 16),
          pool: lc(dataAddr(l.data, 1)), // data = [tickSpacing, pool]
          venue,
        });
      }
    }
  }
  return pools;
}

/** Read v4 Initialize across [from,to]. Same chunking and fail-closed contract as discover(). */
async function discoverV4(from, to) {
  const pools = [];
  for (let lo = from; lo <= to; lo += GETLOGS_CHUNK) {
    const hi = Math.min(to, lo + GETLOGS_CHUNK - 1);
    const logs = await rpc("eth_getLogs", [
      { address: POOL_MANAGER, topics: [V4_INITIALIZE_TOPIC], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + hi.toString(16) },
    ]); // throws on persistent failure → cycle aborts, cursor stays put
    if (!Array.isArray(logs)) continue;
    for (const l of logs) {
      const currency0 = lc(topicAddr(l.topics[2]));
      const currency1 = lc(topicAddr(l.topics[3]));
      const d = (l.data || "0x").slice(2);
      if (d.length < 192) continue;
      const fee = parseInt(d.slice(0, 64), 16);
      let tickSpacing = parseInt(d.slice(64, 128), 16);
      if (tickSpacing >= 0x800000) tickSpacing -= 0x1000000; // int24, two's complement
      const hooks = lc("0x" + d.slice(128, 192).slice(-40));
      // MoleSwap's own pools appear in this same Initialize stream (same PoolManager). They are
      // registered as venue mole_v4 by the operator create-pool flow and routed through the hook-aware
      // path, so the generic scan must not touch them: on 2026-08-15 the history backfill classified
      // them by the generic hook rules (MoleHook's address carries a return-delta bit), upserted
      // active=false over the operator rows, and silently unrouted the DEX's own pools. The upsert RPC
      // now refuses to overwrite mole_v4 rows as well — this skip keeps the writer honest regardless.
      if (hooks === MOLE_HOOK) continue;
      // Classify the pool: 'ticks' (tick-math routable → active), 'simulate' (return-delta hook, priced
      // by on-chain simulation in the frontend → active=false but loaded on demand), or 'native' (native
      // leg the router cannot settle → active=false, unroutable). See classifyV4Pool.
      const quoteMode = classifyV4Pool(currency0, currency1, hooks);
      pools.push({
        id: l.topics[1], // the PoolId IS the identity; there is no address
        venue: "uniswap_v4",
        token0: currency0,
        token1: currency1,
        fee,
        tick_spacing: tickSpacing,
        hooks,
        address: "",
        quoteMode,
        routable: isTickRoutable(quoteMode),
      });
    }
  }
  return pools;
}

async function registerNewTokens(tokenAddrs) {
  if (tokenAddrs.length === 0) return 0;
  const known = new Set();
  for (let i = 0; i < tokenAddrs.length; i += 300) {
    const { data, error } = await supabase.from("mp_tokens").select("address").in("address", tokenAddrs.slice(i, i + 300));
    if (error) throw new Error(`select tokens: ${error.message}`);
    for (const r of data || []) known.add(lc(r.address));
  }
  const fresh = tokenAddrs.filter((t) => !known.has(t) && t !== WETH && t !== USDG);
  if (fresh.length === 0) return 0;

  const calls = [];
  for (const t of fresh) for (const sel of [SEL.symbol, SEL.name, SEL.decimals]) calls.push({ target: t, callData: sel });
  const res = await multicall(calls);
  const rows = fresh.map((addr, i) => {
    const sy = res[i * 3], nm = res[i * 3 + 1], dc = res[i * 3 + 2];
    const symbol = sanitize(sy?.success ? decodeStr(sy.data) : null, 40) || addr.slice(0, 8);
    const name = sanitize(nm?.success ? decodeStr(nm.data) : null, 120) || symbol;
    let decimals = 18;
    if (dc?.success && dc.data && dc.data !== "0x") { try { const d = Number(BigInt(dc.data)); if (d >= 0 && d <= 36) decimals = d; } catch {} }
    return { address: addr, symbol, name, decimals };
  });
  for (let i = 0; i < rows.length; i += 2000) {
    const { error } = await supabase.rpc("mp_upsert_tokens", { p_secret: WRITE_SECRET, p_tokens: rows.slice(i, i + 2000) });
    if (error) throw new Error(`upsert_tokens: ${error.message}`);
  }
  return rows.length;
}

/**
 * Measure many candidate pools and reduce to the DEEPEST pool per token. `candidates` is a Map of
 * address -> [{pool, hub}, …]. Returns [{address, liquidity, pool, hub}] using the pool with the max
 * hub reserve — so a token is NOT de-verified just because a shallow new pool was created alongside its
 * deep one.
 */
async function measureDeepest(candidates) {
  const flat = [];
  for (const [address, pools] of candidates) for (const p of pools) flat.push({ address, pool: p.pool, hub: p.hub });
  if (flat.length === 0) return [];
  const calls = flat.map((r) => ({ target: r.hub === "usdg" ? USDG : WETH, callData: balanceOf(r.pool) }));
  const res = await multicall(calls);
  const price = await usdgPerEth(); // one live read per cycle, shared by every USDG-hub row below
  const best = new Map(); // address -> {liquidity, pool, hub}
  flat.forEach((r, i) => {
    let bal = 0n;
    const x = res[i];
    if (x?.success && x.data && x.data !== "0x") { try { bal = BigInt(x.data); } catch {} }
    const weth = r.hub === "usdg" ? Number(bal) / 1e6 / price : Number(bal) / 1e18;
    const prev = best.get(r.address);
    if (!prev || weth > prev.liquidity) best.set(r.address, { liquidity: Number(weth.toFixed(9)), pool: r.pool, hub: r.hub });
  });
  return [...best.entries()].map(([address, v]) => ({ address, ...v }));
}

async function writeLiquidity(rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const { data, error } = await supabase.rpc("mp_refresh_tokens", { p_secret: WRITE_SECRET, p_rows: rows.slice(i, i + 2000) });
    if (error) throw new Error(`refresh_tokens: ${error.message}`);
    n += Number(data) || 0;
  }
  return n;
}

/* PostgREST caps a single response at 1000 rows, so page through with .range() up to `max`. */
async function pageRows(build, max) {
  const out = [];
  const PAGE = 1000;
  for (let off = 0; off < max; off += PAGE) {
    const { data, error } = await build().range(off, off + PAGE - 1);
    if (error) throw new Error(`select: ${error.message}`);
    const batch = data || [];
    out.push(...batch);
    if (batch.length < PAGE) break;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- one cycle */
async function refresh() {
  const { data: cursorData, error: cursorErr } = await supabase.rpc("mp_indexer_cursor", { p_secret: WRITE_SECRET });
  if (cursorErr) throw new Error(`cursor: ${cursorErr.message}`); // don't fall back to 0 and skip blocks
  const cursor = Number(cursorData ?? 0);
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const safeHead = latest - CONFIRMATIONS; // never scan the unfinalized tip
  status.cursor = cursor;
  status.latest = latest;

  // 1. DISCOVER new pools in a fully-processed, finality-lagged, bounded range.
  const from = cursor > 0 ? cursor + 1 : Math.max(0, safeHead - 5000);
  const to = Math.min(safeHead, from + MAX_BLOCKS_PER_CYCLE - 1);
  let newTokenCount = 0;
  let newPoolCount = 0;
  const newHubByToken = new Map(); // address -> [{pool, hub}]
  if (to >= from) {
    const pools = await discover(from, to); // throws (no cursor advance) if any factory/sub-range fails
    if (pools.length) {
      newPoolCount = pools.length;
      const liqRes = await multicall(pools.map((p) => ({ target: p.pool, callData: "0x1a686502" })));
      const poolRows = pools.map((p, i) => {
        let liq = 0n;
        const x = liqRes[i];
        if (x?.success && x.data && x.data !== "0x") { try { liq = BigInt(x.data); } catch {} }
        return { id: p.pool, venue: p.venue, token0: p.token0, token1: p.token1, fee: p.fee, tick_spacing: SPACING[p.fee] ?? 60, address: p.pool, active: liq > 0n };
      });
      for (let i = 0; i < poolRows.length; i += 200) {
        const { error } = await supabase.rpc("mp_upsert_pools", { p_secret: WRITE_SECRET, p_pools: poolRows.slice(i, i + 200) });
        if (error) throw new Error(`upsert_pools: ${error.message}`);
      }
    }

    // 1b. DISCOVER v4 pools over the SAME range. Kept separate from the factory scan because a v4
    // pool has no address to read liquidity() from — its state lives in the singleton and is read at
    // quote time via StateView, so the registry only needs to record the key.
    const v4 = await discoverV4(from, to);
    if (v4.length) {
      newPoolCount += v4.length;
      const v4Rows = v4.map((p) => ({
        id: p.id, venue: p.venue, token0: p.token0, token1: p.token1,
        fee: p.fee, tick_spacing: p.tick_spacing, hooks: p.hooks, address: p.address,
        // active gates routing: native-currency and value-taking-hook pools stay indexed but unrouted.
        active: p.routable,
      }));
      for (let i = 0; i < v4Rows.length; i += 200) {
        const { error } = await supabase.rpc("mp_upsert_pools", { p_secret: WRITE_SECRET, p_pools: v4Rows.slice(i, i + 200) });
        if (error) throw new Error(`upsert_pools(v4): ${error.message}`);
      }
      const simulateCount = v4.filter((p) => p.quoteMode === "simulate").length;
      console.log(
        `v4: +${v4.length} pools (${v4Rows.filter((r) => r.active).length} routable, ${simulateCount} simulate-eligible)`,
      );
      const tokenSet = new Set();
      for (const p of pools) { tokenSet.add(p.token0); tokenSet.add(p.token1); }
      newTokenCount = await registerNewTokens([...tokenSet]);
      for (const p of pools) {
        let tok, hub;
        if (p.token0 === WETH || p.token0 === USDG) { tok = p.token1; hub = p.token0 === USDG ? "usdg" : "weth"; }
        else if (p.token1 === WETH || p.token1 === USDG) { tok = p.token0; hub = p.token1 === USDG ? "usdg" : "weth"; }
        else continue;
        if (!newHubByToken.has(tok)) newHubByToken.set(tok, []);
        newHubByToken.get(tok).push({ pool: p.pool, hub });
      }
    }
  }

  // 2. REFRESH liquidity: every verified token (paged) + a rotating slice of the unverified long tail,
  //    plus this cycle's new hub pools. Each token measures ALL its candidate pools; the deepest wins.
  const verifiedRows = await pageRows(
    () => supabase.from("mp_tokens").select("address,pool,pool_hub").eq("verified", true).not("pool", "is", null)
      .order("last_refreshed", { ascending: true, nullsFirst: true }),
    30000,
  );
  const staleRows = await pageRows(
    () => supabase.from("mp_tokens").select("address,pool,pool_hub").eq("verified", false).not("pool", "is", null)
      .order("last_refreshed", { ascending: true, nullsFirst: true }),
    UNVERIFIED_REFRESH_BATCH,
  );

  const candidates = new Map(); // address -> [{pool, hub}]
  const addCand = (address, pool, hub) => {
    const a = lc(address);
    if (!candidates.has(a)) candidates.set(a, []);
    candidates.get(a).push({ pool: lc(pool), hub: hub || "weth" });
  };
  for (const r of [...verifiedRows, ...staleRows]) if (r.pool) addCand(r.address, r.pool, r.pool_hub);
  for (const [address, list] of newHubByToken) for (const c of list) addCand(address, c.pool, c.hub);

  let refreshed = 0;
  if (candidates.size) refreshed = await writeLiquidity(await measureDeepest(candidates));

  // 3. advance the cursor ONLY after the whole range was processed without throwing
  if (to >= from) {
    const { error } = await supabase.rpc("mp_indexer_advance", { p_secret: WRITE_SECRET, p_block: to });
    if (error) throw new Error(`advance: ${error.message}`);
  }

  const { count } = await supabase.from("mp_tokens").select("*", { count: "exact", head: true }).eq("verified", true);
  const now = Date.now();
  status = { lastRun: new Date(now).toISOString(), lastRunMs: now, cursor: Math.max(cursor, to >= from ? to : cursor), latest, newPools: newPoolCount, newTokens: newTokenCount, refreshed, verified: count ?? status.verified, error: null };
  console.log(`[${status.lastRun}] blocks ${from}-${to}/${safeHead} · +${newPoolCount} pools · +${newTokenCount} tokens · refreshed ${refreshed} · verified ${status.verified}`);
}

/* ------------------------------------------------------------------------------------- swap volume */
const hexnum = (n) => "0x" + n.toString(16);
function i256(word) {
  const v = BigInt("0x" + word);
  return v >= (1n << 255n) ? v - (1n << 256n) : v;
}
const tsCache = new Map();
async function blockTs(n) {
  if (tsCache.has(n)) return tsCache.get(n);
  const b = await rpc("eth_getBlockByNumber", [hexnum(n), false]);
  const ts = b && b.timestamp ? parseInt(b.timestamp, 16) : Math.floor(Date.now() / 1000);
  tsCache.set(n, ts);
  return ts;
}

/**
 * REAL 24h volume: scan Swap events for the tracked pools from a persisted cursor forward, convert each
 * swap's hub-token notional to USD (USDG side = exact USD; WETH side = WETH x price), bucket by ~1h block
 * window, and upsert additively. The upsert also advances the cursor atomically and is idempotent, so a
 * retried range never double-counts. Non-fatal: a failure here logs and leaves fund-safety untouched —
 * volume is a display metric, the on-chain minAmountOut is the only guarantee.
 */
async function refreshVolume() {
  if (VOLUME_POOLS.length === 0) return { from: 0, to: 0, swaps: 0 };
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const safeHead = latest - CONFIRMATIONS;

  // Resolve immutables (token0/token1/fee) for the tracked pools from the registry we already maintain.
  const { data: poolRows, error: pErr } = await supabase
    .from("mp_pools").select("id,venue,address,token0,token1,fee").in("id", VOLUME_POOLS);
  if (pErr) throw new Error(`vol pools: ${pErr.message}`);
  // Keyed by the id the READER joins on, which is the row's own id: a V3 pool's address, a v4 pool's
  // 66-char PoolId. Writing a v4 pool's volume under anything else is unjoinable by construction.
  const metaById = new Map();
  for (const r of poolRows || []) {
    const t0 = lc(r.token0), t1 = lc(r.token1);
    let hub = null, hubIsToken0 = false;
    if (t0 === USDG || t1 === USDG) { hub = "usdg"; hubIsToken0 = t0 === USDG; }
    else if (t0 === WETH || t1 === WETH) { hub = "weth"; hubIsToken0 = t0 === WETH; }
    if (!hub) continue;
    const isV4 = !r.address || r.venue === "mole_v4" || r.venue === "uniswap_v4";
    // A V3 row's id IS its address (see the discover writer), so keying by the address keeps every
    // already-indexed bucket accumulating under exactly the key it has today; a v4 row has no address,
    // so its 66-char PoolId is both the identity and the key the page looks it up by.
    metaById.set(lc(isV4 ? r.id : r.address || r.id), { hub, hubIsToken0, fee: Number(r.fee), isV4 });
  }
  const addrs = [...metaById.entries()].filter(([, m]) => !m.isV4).map(([k]) => k);
  const v4Ids = [...metaById.entries()].filter(([, m]) => m.isV4).map(([k]) => k);
  if (addrs.length === 0 && v4Ids.length === 0) return { from: 0, to: 0, swaps: 0 };

  const curRaw = await supabase.rpc("mp_volume_cursor", { p_secret: WRITE_SECRET });
  if (curRaw.error) throw new Error(`vol cursor: ${curRaw.error.message}`);
  const cur = Number(curRaw.data ?? 0);
  const from = cur > 0 ? cur + 1 : Math.max(0, safeHead - BLOCKS_24H); // first run: only look back 24h
  const to = Math.min(safeHead, from + MAX_VOL_BLOCKS_PER_CYCLE - 1);
  if (to < from) return { from, to, swaps: 0 };

  const byBucket = new Map(); // `${pool}|${bucket}` -> {pool,bucket,volume_usd,fees_usd,swaps}
  const price = await usdgPerEth();
  let swapCount = 0;
  for (let lo = from; lo <= to; lo += GETLOGS_CHUNK) {
    const hi = Math.min(to, lo + GETLOGS_CHUNK - 1);
    // Two scans, because the two venues emit the same economic event in structurally different places.
    // Both throw on persistent failure → cursor not advanced, range re-read next cycle (idempotent).
    const hits = [];
    if (addrs.length > 0) {
      const logs = await rpc("eth_getLogs", [
        { address: addrs, topics: [[UNI_V3_SWAP, PANCAKE_V3_SWAP]], fromBlock: hexnum(lo), toBlock: hexnum(hi) },
      ]);
      if (Array.isArray(logs)) for (const l of logs) hits.push({ key: lc(l.address), l, isV4: false });
    }
    // v4 has no per-pool contract: the PoolManager singleton emits every pool's Swap with the PoolId in
    // topic1, so it is filtered by TOPIC, not by address. Skipped entirely when nothing v4 is tracked —
    // an empty topic list is read by the node as "any pool" and would sweep in all 8k+ foreign pools.
    if (v4Ids.length > 0) {
      const logs = await rpc("eth_getLogs", [
        { address: POOL_MANAGER, topics: [V4_SWAP, v4Ids], fromBlock: hexnum(lo), toBlock: hexnum(hi) },
      ]);
      if (Array.isArray(logs)) for (const l of logs) hits.push({ key: lc(l.topics?.[1] || ""), l, isV4: true });
    }
    for (const { key, l, isV4 } of hits) {
      const meta = metaById.get(key);
      // v3 data = (amount0 int256, amount1 int256, …); v4 data = (amount0 int128, amount1 int128,
      // sqrtPriceX96, liquidity, tick, fee). The first two words hold the amounts in BOTH layouts — the
      // ABI sign-extends an int128 across the full word — so one decoder serves both. v4 needs all six.
      const minLen = 2 + (isV4 ? 384 : 128);
      if (!meta || !l.data || l.data.length < minLen) continue;
      const body = l.data.replace(/^0x/, "");
      const amount0 = i256(body.slice(0, 64));
      const amount1 = i256(body.slice(64, 128));
      const amt = meta.hubIsToken0 ? amount0 : amount1;
      const abs = amt < 0n ? -amt : amt;
      const volUsd = meta.hub === "usdg"
        ? Number(abs) / 1e6
        : (Number(abs) / 1e18) * price;
      if (!(volUsd > 0)) continue;
      // A v4 pool may charge a DYNAMIC fee — mp_pools stores the 0x800000 sentinel for those, which as a
      // rate would read as 838% — so take the fee the swap ACTUALLY paid from the event's last word.
      const feePips = isV4 ? Number(BigInt("0x" + body.slice(320, 384))) : meta.fee;
      const feeUsd = Number.isFinite(feePips) && feePips >= 0 && feePips <= 1e6 ? (volUsd * feePips) / 1e6 : 0;
      const blockNum = parseInt(l.blockNumber, 16);
      const bucket = Math.floor(blockNum / BLOCKS_PER_BUCKET);
      const bkey = `${key}|${bucket}`;
      const b = byBucket.get(bkey) || { pool: key, bucket, volume_usd: 0, fees_usd: 0, swaps: 0 };
      b.volume_usd += volUsd; b.fees_usd += feeUsd; b.swaps += 1;
      byBucket.set(bkey, b);
      swapCount++;
    }
  }

  const rows = [];
  for (const b of byBucket.values()) {
    const startBlock = Math.min(b.bucket * BLOCKS_PER_BUCKET, safeHead);
    rows.push({ ...b, bucket_ts: await blockTs(startBlock) });
  }
  // Atomic idempotent apply + cursor advance (safe even with empty rows: it just advances the cursor).
  const up = await supabase.rpc("mp_upsert_volume", {
    p_secret: WRITE_SECRET, p_rows: rows, p_from_block: from, p_to_block: to,
  });
  if (up.error) throw new Error(`upsert_volume: ${up.error.message}`);
  return { from, to, swaps: swapCount };
}

/**
 * Observation liveness for every mole pool. Reads the hook's oracle head (`poolStates`) and `consult`
 * per pool plus Chainlink for the live pool — three or four eth_calls, no writes, no DB dependency
 * beyond a best-effort read of the mole_v4 ids (the live pool is checked even if that read fails).
 * Errors surface in `oracle.error`; a failed pass leaves the previous pass's data standing and lets
 * `checkStale` (below) say how old it is.
 */
async function refreshOracle() {
  const ids = new Set([ORACLE_LIVE_POOL_ID, ...ORACLE_POOLS]);
  try {
    const { data, error } = await supabase.from("mp_pools").select("id").eq("venue", "mole_v4");
    if (!error) for (const r of data || []) if (/^0x[0-9a-f]{64}$/i.test(r.id || "")) ids.add(lc(r.id));
  } catch {
    /* registry read is best-effort: the live pool is always in the set */
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const r = await checkOracleLiveness({
    call: (to, data) => rpc("eth_call", [{ to, data }, "latest"]),
    poolIds: [...ids],
    nowSeconds,
  });
  oracleStatus = { ...r, checkedAt: new Date(nowSeconds * 1000).toISOString(), checkedAtMs: Date.now(), error: null };
  const staleIds = Object.entries(r.pools).filter(([, p]) => p.stale).map(([id]) => id.slice(0, 10));
  const x = r.crossCheck;
  console.log(
    `[oracle] ${Object.keys(r.pools).length} pool(s) · stale ${staleIds.length ? staleIds.join(",") : "none"}` +
      (x && x.error === null ? ` · twap $${x.ourUsd.toFixed(2)} vs chainlink $${x.chainlinkUsd.toFixed(2)} (${(x.deviationBps / 100).toFixed(2)}%${x.warn ? " WARN" : ""})` : x ? ` · cross-check error: ${x.error}` : ""),
  );
}

async function loop() {
  const started = Date.now();
  try {
    await refresh();
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e);
    console.error("refresh failed:", status.error);
  }

  // Oracle liveness runs INDEPENDENTLY too, for the same reason as volume: a discovery failure must not
  // hide a stalled oracle, and a stalled oracle must not be mistaken for an indexer fault.
  try {
    await refreshOracle();
  } catch (e) {
    oracleStatus.error = e instanceof Error ? e.message : String(e);
    console.error("oracle liveness failed:", oracleStatus.error);
  }

  // Volume runs INDEPENDENTLY of discovery/liquidity: it has its own cursor + idempotent apply, so a
  // heavier token-refresh step timing out must not starve the pools page of real volume. Non-fatal.
  try {
    const v = await refreshVolume();
    if (v.to >= v.from) {
      await supabase.rpc("mp_volume_prune", { p_secret: WRITE_SECRET }); // best-effort; bounds the table
      console.log(`[vol] ${v.from}-${v.to} +${v.swaps} swaps`);
    }
  } catch (e) {
    console.error("volume refresh failed:", e instanceof Error ? e.message : String(e));
  }

  setTimeout(loop, Math.max(1000, REFRESH_MS - (Date.now() - started)));
}

// Health: 503 when the last successful run is stale (loop wedged) or the last cycle errored, so the
// platform can restart a hung instance.
http
  .createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      const stale = status.lastRunMs > 0 && Date.now() - status.lastRunMs > STALE_MULTIPLIER * REFRESH_MS;
      const ok = !status.error && !stale;
      // The oracle signal is its own: `checkStale` = this service has not completed a liveness pass
      // recently (or ever), `stale` = a mole pool's newest observation is older than thresholdSec, OR
      // the pass itself is too old to vouch for anything. Neither gates `ok` — see oracleStatus.
      const oracle = oracleHealthView(oracleStatus, Date.now(), STALE_MULTIPLIER * REFRESH_MS);
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok, stale, ...status, oracle }));
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(PORT, () => console.log(`indexer health on :${PORT}, refreshing every ${REFRESH_MS / 1000}s`));

loop();
