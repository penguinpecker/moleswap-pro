import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { GET as tokensGET } from "@/app/api/v1/tokens/route";
import { GET as poolsGET } from "@/app/api/v1/pools/route";
import { GET as poolDetailGET } from "@/app/api/v1/pool/[address]/route";
import { GET as quoteGET } from "@/app/api/v1/quote/route";
import { POST as swapPOST } from "@/app/api/v1/tx/swap/route";
import { POST as createPoolPOST } from "@/app/api/v1/tx/create-pool/route";
import { POST as addLiqPOST } from "@/app/api/v1/tx/add-liquidity/route";

import {
  resolveApiChain,
  productUnavailable,
  queueUnavailable,
  quotingUnavailable,
  DEFAULT_API_CHAIN_ID,
} from "@/lib/api/chain-scope";
import {
  RH_CHAIN,
  ARC_CHAIN,
  SUPPORTED_CHAINS,
  AVAILABILITY,
  isAvailable,
  type ProductKey,
} from "@/lib/chain/chains";

/**
 * WHICH CHAIN THE PUBLIC API ANSWERS FOR.
 *
 * Every v1 route used to resolve its addresses from the flat Robinhood-only registry. The failure
 * mode that matters is not a 500 — it is a 200 carrying Robinhood's router address, Robinhood's WETH
 * and Robinhood's prices while the caller believed they asked about Arc. Nothing about such a
 * response looks wrong until an approval has already landed on the wrong chain. So the four
 * properties pinned below are, per route:
 *
 *   1. omitting the parameter still answers for Robinhood, byte-compatibly with the pre-Arc API;
 *   2. `chainId=5042` resolves ARC's addresses, and no Robinhood address survives into the answer;
 *   3. a chain we do not serve is REFUSED, before any address is looked up or any RPC is opened;
 *   4. a product that is not live on the requested chain is refused BY NAME, pointing at the chains
 *      that do have it.
 *
 * Everything here is deterministic: each case is chosen to return before the route opens an RPC
 * connection, so the suite cannot go red because a node was slow.
 */

/* ─────────────────────────────── addresses, pinned ─────────────────────────────── */

const RH = {
  router: "0xBd9B841d690E31B61aa3858EB145EA8BBe71122c",
  hook: "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4",
  positions: "0x674625B6E6a2614ef6e247aF099BEA2e65e1536A",
  queue: "0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  feeDial: "0x242263f3Ea6165a70B463d8b65F8DdFdd66762EA",
};
const ARC = {
  router: "0xE4192C72574e6E387D4C29Eb89feCeADa105F3e3",
  hook: "0xfFDCBf2f5b53C0fa2c5D7d25A87F99514Fbe78c4",
  positions: "0x8e6bB60d6A75e0390Ee3Da2b280aec2e39769D77",
  usdc: "0x3600000000000000000000000000000000000000",
  architects: "0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0",
  poolId: "0x180a035b0d60290514969d7c9dc169cad5fad5c423295848130be25e82f31796",
};
/** Shared by both chains — the v4 singleton is at the same address everywhere, so it is NOT evidence
 *  of Robinhood leaking into an Arc answer and must be excluded from the contamination sweep. */
const SHARED_POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";

const ZERO = "0x0000000000000000000000000000000000000000";
const REC = "0x47D1000000000000000000000000000000000814";

const lower = (a: string) => a.toLowerCase();

/* ───────────────────────────────── request plumbing ───────────────────────────────── */

/**
 * A fresh caller identity per request.
 *
 * The rate limiter counts per IP and every request in a test file otherwise arrives from the same
 * "unknown" one — 60 reads and the file starts asserting against 429s instead of against chain
 * resolution. Handing each request its own forwarded-for keeps what is being tested visible.
 */
let caller = 0;
const headers = () => ({ "x-forwarded-for": `198.51.100.${++caller}` });

function getReq(url: string) {
  return new NextRequest(url, { headers: headers() });
}
function postReq(url: string, body: any) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers() },
  });
}
async function json(res: Response) {
  return (await res.json()) as any;
}

const tokens = (qs = "") => tokensGET(getReq(`http://t/api/v1/tokens${qs}`));
const pools = (qs = "") => poolsGET(getReq(`http://t/api/v1/pools${qs}`));
const quote = (qs = "") => quoteGET(getReq(`http://t/api/v1/quote${qs}`));
const swap = (body: any, qs = "") => swapPOST(postReq(`http://t/api/v1/tx/swap${qs}`, body));
const createPool = (body: any) => createPoolPOST(postReq("http://t/api/v1/tx/create-pool", body));
const addLiq = (body: any) => addLiqPOST(postReq("http://t/api/v1/tx/add-liquidity", body));
const poolDetail = (address: string, qs = "") =>
  poolDetailGET(getReq(`http://t/api/v1/pool/${address}${qs}`), {
    params: Promise.resolve({ address }),
  });

/* ═════════════════════════════════ resolution ═════════════════════════════════ */

describe("chain resolution", () => {
  it("no parameter means Robinhood, and that is the documented default", () => {
    expect(DEFAULT_API_CHAIN_ID).toBe(RH_CHAIN.id);
    for (const raw of [null, undefined, ""]) {
      const r = resolveApiChain(raw);
      expect(r.ok).toBe(true);
      expect(r.ok && r.scope.chainId).toBe(4663);
    }
  });

  it("accepts every spelling a caller plausibly writes", () => {
    const arc = ["5042", 5042, "0x13b2", "0x13B2", "arc", "Arc", "ARC"];
    for (const raw of arc) {
      const r = resolveApiChain(raw);
      expect(r.ok, `${raw} should resolve`).toBe(true);
      expect(r.ok && r.scope.chainId, `${raw}`).toBe(ARC_CHAIN.id);
    }
    // "Robinhood Chain" is what the pre-multichain /v1/tokens filter took; it still means 4663.
    for (const raw of ["4663", 4663, "0x1237", "rh", "Robinhood", "Robinhood Chain"]) {
      const r = resolveApiChain(raw);
      expect(r.ok, `${raw} should resolve`).toBe(true);
      expect(r.ok && r.scope.chainId, `${raw}`).toBe(RH_CHAIN.id);
    }
  });

  it("refuses an unserved chain instead of quietly answering for Robinhood", () => {
    for (const raw of ["1", 1, "0x1", "137", "base", "polygon", "not-a-chain", "-4663"]) {
      const r = resolveApiChain(raw);
      expect(r.ok, `${raw} must NOT resolve`).toBe(false);
      if (!r.ok) {
        // The refusal has to be actionable: it names both served chains and both ids.
        expect(r.error).toContain("4663");
        expect(r.error).toContain("5042");
        expect(r.error).toMatch(/Robinhood/);
        expect(r.error).toMatch(/Arc/);
      }
    }
  });

  it("every supported chain in the registry has a scope — no half-registered chain", () => {
    for (const c of SUPPORTED_CHAINS) {
      const r = resolveApiChain(c.id);
      expect(r.ok, `${c.name} is in SUPPORTED_CHAINS but has no API scope`).toBe(true);
    }
  });
});

/* ═════════════════════════════════ availability ═════════════════════════════════ */

describe("availability refusals read from chains.ts, not from a second opinion", () => {
  it("productUnavailable agrees with isAvailable for every product × chain", () => {
    const products = Object.keys(AVAILABILITY) as ProductKey[];
    for (const c of SUPPORTED_CHAINS) {
      const r = resolveApiChain(c.id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      for (const p of products) {
        const refusal = productUnavailable(r.scope, p);
        expect(refusal === null, `${p} on ${c.name}`).toBe(isAvailable(p, c.id));
        if (refusal) {
          expect(refusal).toContain(c.name);
          expect(refusal).toContain(String(c.id));
        }
      }
    }
  });

  it("lending is refused on both chains and says it is nowhere yet", () => {
    for (const c of SUPPORTED_CHAINS) {
      const r = resolveApiChain(c.id);
      if (!r.ok) throw new Error("scope missing");
      const refusal = productUnavailable(r.scope, "lending");
      expect(refusal).toBeTruthy();
      expect(refusal).toMatch(/not deployed on any chain/i);
    }
  });

  it("the queue is Robinhood-only, and the refusal names where it does run", () => {
    const rh = resolveApiChain(RH_CHAIN.id);
    const arc = resolveApiChain(ARC_CHAIN.id);
    if (!rh.ok || !arc.ok) throw new Error("scope missing");
    expect(queueUnavailable(rh.scope)).toBeNull();
    expect(rh.scope.queue?.toLowerCase()).toBe(lower(RH.queue));

    const refusal = queueUnavailable(arc.scope);
    expect(refusal).toBeTruthy();
    expect(refusal).toMatch(/MoleQueue/);
    expect(refusal).toContain("Arc");
    expect(refusal).toContain("Robinhood Chain");
    expect(arc.scope.queue).toBeNull();
  });

  it("quoting is refused on Arc without pretending the router is missing there", () => {
    const rh = resolveApiChain(RH_CHAIN.id);
    const arc = resolveApiChain(ARC_CHAIN.id);
    if (!rh.ok || !arc.ok) throw new Error("scope missing");
    expect(quotingUnavailable(rh.scope)).toBeNull();

    const refusal = quotingUnavailable(arc.scope) || "";
    // Swapping IS live on Arc — the refusal must say so, or an integrator reads it as "no router".
    expect(refusal).toMatch(/MoleRouter IS live/);
    expect(refusal.toLowerCase()).toContain(lower(ARC.router));
    expect(isAvailable("swap", ARC_CHAIN.id)).toBe(true);
  });
});

/* ═════════════════════════════════ GET /tokens ═════════════════════════════════ */

describe("GET /api/v1/tokens", () => {
  it("default chain answers exactly as the pre-Arc API did", async () => {
    const r = await tokens();
    expect(r.status).toBe(200);
    const { data } = await json(r);
    expect(data.chainId).toBe(4663);
    expect(data.chain).toBe("Robinhood Chain");
    expect(data.rpc).toBe("https://rpc.mainnet.chain.robinhood.com");
    expect(lower(data.contracts.swapRouter)).toBe(lower(RH.router));
    expect(lower(data.contracts.weth)).toBe(lower(RH.weth));
    expect(lower(data.contracts.moleQueue)).toBe(lower(RH.queue));
    expect(lower(data.contracts.molePositions)).toBe(lower(RH.positions));
    expect(lower(data.contracts.factory)).toBe(lower(RH.factory));
    // Native ETH is a listed currency here, and the wrapped form is flagged.
    expect(data.tokens.some((t: any) => t.isNative)).toBe(true);
    expect(data.tokens.find((t: any) => t.isWrappedNative)?.address.toLowerCase()).toBe(
      lower(RH.weth),
    );
    expect(data.nativeCurrency).toMatchObject({ symbol: "ETH", decimals: 18, erc20: null });
  });

  it("chainId=5042 hands back ARC's approval targets", async () => {
    const r = await tokens("?chainId=5042");
    expect(r.status).toBe(200);
    const { data } = await json(r);
    expect(data.chainId).toBe(5042);
    expect(data.chain).toBe("Arc");
    expect(lower(data.contracts.swapRouter)).toBe(lower(ARC.router));
    expect(lower(data.contracts.moleHook)).toBe(lower(ARC.hook));
    expect(lower(data.contracts.molePositions)).toBe(lower(ARC.positions));
    // Absent, not zero: 0x000…0 reads as an address somebody will send to, and Arc reverts those.
    expect(data.contracts.weth).toBeNull();
    expect(data.contracts.moleQueue).toBeNull();
    expect(data.contracts.factory).toBeNull();
    expect(data.contracts.quoterV2).toBeNull();
  });

  it("Arc's gas token is published as ONE balance under two decimal counts", async () => {
    const { data } = await json(await tokens("?chainId=5042"));
    expect(data.nativeCurrency.symbol).toBe("USDC");
    // 18 is what a wallet divides eth_getBalance by; 6 is what the pool's currency is denominated in.
    expect(data.nativeCurrency.decimals).toBe(18);
    expect(lower(data.nativeCurrency.erc20)).toBe(lower(ARC.usdc));
    expect(data.nativeCurrency.erc20Decimals).toBe(6);
    expect(data.nativeCurrency.wrapped).toBeNull();
    expect(data.nativeCurrency.note).toMatch(/no WETH/i);

    const usdc = data.tokens.find((t: any) => lower(t.address) === lower(ARC.usdc));
    expect(usdc.decimals).toBe(6);
    // Listing 0x0 would invite a transfer to the zero address, which reverts on Arc.
    expect(data.tokens.some((t: any) => t.address === ZERO)).toBe(false);
    expect(data.tokens.some((t: any) => t.isWrappedNative)).toBe(false);
  });

  it("no Robinhood address survives into an Arc answer", async () => {
    const body = JSON.stringify(await json(await tokens("?chainId=5042"))).toLowerCase();
    for (const [name, addr] of Object.entries(RH)) {
      expect(body.includes(lower(addr)), `Arc response leaks Robinhood ${name}`).toBe(false);
    }
    // The v4 singleton IS the same address on both chains — proving the sweep above is not vacuous.
    expect(body).toContain(lower(SHARED_POOL_MANAGER));
  });

  it("an unserved chain is a 400, not a Robinhood answer wearing another label", async () => {
    const r = await tokens("?chainId=1");
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.success).toBe(false);
    expect(body.error).toContain("5042");
    expect(JSON.stringify(body).toLowerCase()).not.toContain(lower(RH.router));
  });

  it("the older ?chain= spelling still names a chain", async () => {
    expect((await json(await tokens("?chain=arc"))).data.chainId).toBe(5042);
    expect((await json(await tokens("?chain=Robinhood%20Chain"))).data.chainId).toBe(4663);
    expect((await tokens("?chain=ethereum")).status).toBe(400);
  });
});

/* ═════════════════════════════════ GET /pools ═════════════════════════════════ */

describe("GET /api/v1/pools", () => {
  it("refuses an unserved chain before opening an RPC connection", async () => {
    const r = await pools("?chainId=42161");
    expect(r.status).toBe(400);
    expect((await json(r)).error).toContain("4663");
  });

  it("advertises the pool list per chain, matching chains.ts", () => {
    // The route answers over live RPC, so what is pinned here is the decision it makes first: pools
    // are available on both chains, which is precisely why /pools must not be Robinhood-only.
    for (const c of SUPPORTED_CHAINS) {
      const r = resolveApiChain(c.id);
      if (!r.ok) throw new Error("scope missing");
      expect(isAvailable("pools", c.id)).toBe(true);
      expect(r.scope.vaultPool, `${c.name} advertises pools but names no vault pool`).toBeTruthy();
    }
    const arc = resolveApiChain(ARC_CHAIN.id);
    if (!arc.ok) throw new Error("scope missing");
    expect(arc.scope.vaultPool!.id).toBe(ARC.poolId);
    expect(lower(arc.scope.vaultPool!.key.hooks)).toBe(lower(ARC.hook));
    expect(arc.scope.vaultPool!.key.tickSpacing).toBe(60);
    expect(arc.scope.vaultPool!.key.fee).toBe(0x800000);
  });
});

/* ═════════════════════════════ GET /pool/:address ═════════════════════════════ */

describe("GET /api/v1/pool/:address", () => {
  it("resolves the chain BEFORE it looks at the address", async () => {
    // Both are wrong. The chain has to be the one reported, because reading a good-looking address
    // over the wrong RPC is the failure this parameter exists to prevent.
    const r = await poolDetail("not-an-address", "?chainId=1");
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/Unsupported chain/);
  });

  it("still validates the address on the default chain", async () => {
    const r = await poolDetail("not-an-address");
    expect(r.status).toBe(400);
    expect((await json(r)).error).toBe("Invalid pool address");
  });

  it("v4 pools are not addressable here on either chain", () => {
    // The Arc pool has no address at all — it is a key hashed into the singleton — so there is
    // nothing for this route to read, on any chain. /pools reports it by PoolId instead.
    expect(ARC.poolId).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

/* ═════════════════════════════════ GET /quote ═════════════════════════════════ */

describe("GET /api/v1/quote", () => {
  it("default chain still prices the 1:1 wrap without a route", async () => {
    const r = await quote(`?tokenIn=${ZERO}&tokenOut=${RH.weth}&amountIn=1000`);
    expect(r.status).toBe(200);
    const { data } = await json(r);
    expect(data.type).toBe("wrap_unwrap");
    expect(data.amountOut).toBe("1000");
    expect(data.chainId).toBe(4663);
  });

  it("Arc is refused with 501 — and the refusal explains it is the pricing engine, not the router", async () => {
    const r = await quote(`?chainId=5042&tokenIn=${ARC.usdc}&tokenOut=${ARC.architects}&amountIn=1000000`);
    expect(r.status).toBe(501);
    const err = (await json(r)).error;
    expect(err).toMatch(/MoleRouter IS live/);
    expect(err).toMatch(/registry/i);
  });

  it("the chain refusal comes before parameter validation", async () => {
    // No tokens, no amount — and still a 501, not a 400 about missing params. A caller who fixed the
    // params would only have got the same refusal one round trip later.
    expect((await quote("?chainId=5042")).status).toBe(501);
    expect((await quote("?chainId=1")).status).toBe(400);
    expect((await quote("")).status).toBe(400); // default chain: the params really are missing
  });
});

/* ═══════════════════════════════ POST /tx/swap ═══════════════════════════════ */

describe("POST /api/v1/tx/swap", () => {
  const wrapBody = { tokenIn: ZERO, tokenOut: RH.weth, amountIn: "1000", recipient: REC };

  it("default chain still builds the Robinhood wrap unchanged", async () => {
    const r = await swap(wrapBody);
    expect(r.status).toBe(200);
    const { data } = await json(r);
    expect(data.type).toBe("wrap");
    expect(lower(data.transactions[0].to)).toBe(lower(RH.weth));
    expect(data.chainId).toBe(4663);
  });

  it("takes the chain from the body", async () => {
    const r = await swap({ ...wrapBody, chainId: 5042 });
    expect(r.status).toBe(501);
    expect((await json(r)).error).toMatch(/Quoting is not served/);
  });

  it("takes the chain from the query string too", async () => {
    const r = await swap(wrapBody, "?chainId=5042");
    expect(r.status).toBe(501);
  });

  it("refuses an unserved chain", async () => {
    const r = await swap({ ...wrapBody, chainId: 1 });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/Unsupported chain/);
  });
});

/* ═══════════════════════════ POST /tx/create-pool ═══════════════════════════ */

describe("POST /api/v1/tx/create-pool", () => {
  it("default chain still validates its own fields", async () => {
    const r = await createPool({});
    expect(r.status).toBe(400);
    const err = (await json(r)).error;
    for (const f of ["tokenA", "tokenB", "recipient"]) expect(err).toContain(f);
  });

  it("Arc is refused by name, and pointed at the v4 pool it should deposit into", async () => {
    const r = await createPool({
      chainId: 5042,
      tokenA: ARC.usdc,
      tokenB: ARC.architects,
      recipient: REC,
    });
    expect(r.status).toBe(400);
    const err = (await json(r)).error;
    expect(err).toMatch(/no.*v3 factory/i);
    expect(err.toLowerCase()).toContain(lower(ARC.hook));
    expect(err).toContain(ARC.poolId);
    expect(err).toMatch(/add-liquidity/);
    // Never the Robinhood factory under an Arc request.
    expect(err.toLowerCase()).not.toContain(lower(RH.factory));
  });

  it("refuses an unserved chain before it reaches the factory question", async () => {
    const r = await createPool({ chainId: 999, tokenA: RH.weth, tokenB: RH.usdg, recipient: REC });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/Unsupported chain/);
  });
});

/* ═════════════════════════ POST /tx/add-liquidity ═════════════════════════ */

describe("POST /api/v1/tx/add-liquidity", () => {
  const rhLegs = {
    token0: RH.weth,
    token1: RH.usdg,
    amount0Desired: "1000000000000000",
    amount1Desired: "4000000",
    recipient: REC,
  };

  it("default chain still names the Robinhood pair when the pair is wrong", async () => {
    const r = await addLiq({ ...rhLegs, token1: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9" });
    expect(r.status).toBe(400);
    const err = (await json(r)).error;
    expect(err).toMatch(/WETH/);
    expect(err).toMatch(/USDG/);
    expect(err.toLowerCase()).toContain(lower(RH.positions));
  });

  it("on Arc the whitelisted pair is Arc's, so Robinhood's legs are refused with Arc's named", async () => {
    const r = await addLiq({ ...rhLegs, chainId: 5042 });
    expect(r.status).toBe(400);
    const err = (await json(r)).error;
    expect(err.toLowerCase()).toContain(lower(ARC.usdc));
    expect(err.toLowerCase()).toContain(lower(ARC.architects));
    expect(err.toLowerCase()).toContain(lower(ARC.positions));
    expect(err).toContain("Arc");
    // The Robinhood pool must not be offered as the answer to an Arc request.
    expect(err.toLowerCase()).not.toContain(lower(RH.positions));
    expect(err.toLowerCase()).not.toContain(lower(RH.weth));
  });

  it("0x0 is refused on Arc rather than wrapped into something that is not a WETH", async () => {
    const r = await addLiq({ ...rhLegs, chainId: 5042, token0: ZERO, token1: ARC.architects });
    expect(r.status).toBe(400);
    const err = (await json(r)).error;
    expect(err).toMatch(/no wrapped native/i);
    expect(err).toMatch(/nothing to wrap/i);
    // It explains what to spend instead — the ERC-20 view of the gas balance.
    expect(err.toLowerCase()).toContain(lower(ARC.usdc));
  });

  it("refuses an unserved chain before touching the pool", async () => {
    const r = await addLiq({ ...rhLegs, chainId: 10 });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/Unsupported chain/);
  });
});

/* ═══════════════════════ the routes, read from disk ═══════════════════════ */

/**
 * Derived from the filesystem rather than from a list kept here, for the same reason the aggregator's
 * error test derives its selectors from the .sol sources: a list maintained by hand goes stale the
 * first time somebody adds a route, and the stale list is exactly what let the single-chain
 * assumption survive the Arc launch.
 */
function v1RouteFiles(): string[] {
  const root = path.resolve(process.cwd(), "app/api/v1");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "route.ts") out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Not a chain-scoped endpoint: it reports usage of the Arc RPC proxy itself, gated on the write
 *  secret, and takes no chain because there is nothing per-chain about a request counter. */
const NOT_CHAIN_SCOPED = ["rpc-stats"];

describe("every public v1 route names its chain", () => {
  const files = v1RouteFiles();

  it("finds the routes at all", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it("resolves the chain through chain-scope, with no exceptions but the documented one", () => {
    for (const f of files) {
      const rel = path.relative(process.cwd(), f);
      if (NOT_CHAIN_SCOPED.some((s) => rel.includes(s))) continue;
      const src = readFileSync(f, "utf8");
      expect(src, `${rel} must resolve its chain`).toContain("resolveApiChain");
      expect(src, `${rel} must resolve it from chain-scope`).toContain("@/lib/api/chain-scope");
    }
  });

  it("no route reads addresses from the flat Robinhood registry", () => {
    for (const f of files) {
      const rel = path.relative(process.cwd(), f);
      const codeOnly = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments — they may still explain the old registry
        .replace(/\/\/.*$/gm, "");
      // `CONTRACTS.X` is the single-chain answer by construction. ABIs and tick tables from the same
      // module are chain-independent and stay allowed; addresses come from contractsFor(chainId).
      expect(codeOnly, `${rel} reads a Robinhood-only address from CONTRACTS`).not.toMatch(
        /\bCONTRACTS\s*\./,
      );
    }
  });

  it("no route hard-codes a chain id or an RPC url in what it returns", () => {
    // This is the regression that actually happened: the routes were converted to `scope`, and two
    // response tails kept echoing `chainId: RH_CHAIN_ID` / `rpc: RH_PUBLIC_RPC_URL`. The transactions
    // were Arc's, the label on them said Robinhood, and nothing threw. Comments may still name a
    // chain — prose explaining why Arc has no queue is the point — so only executable code is read.
    const banned: [RegExp, string][] = [
      [/\b4663\b/, "a literal Robinhood chain id"],
      [/\b5042\b/, "a literal Arc chain id"],
      [/rpc\.mainnet\.chain\.robinhood/, "a literal Robinhood RPC url"],
      [/RH_CHAIN_ID|RH_PUBLIC_RPC_URL/, "a Robinhood-only module constant"],
    ];
    for (const f of v1RouteFiles()) {
      const rel = path.relative(process.cwd(), f);
      const codeOnly = readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      for (const [pattern, what] of banned) {
        expect(codeOnly, `${rel} contains ${what} — use the resolved scope`).not.toMatch(pattern);
      }
    }
  });
});

/* ═══════════════════════════ the docs match the routes ═══════════════════════════ */

describe("the API docs document the chain parameter", () => {
  const docs = readFileSync(path.resolve(process.cwd(), "screens/docs/index.tsx"), "utf8");

  /** The endpoint sections, taken from the docs page's OWN nav — add an endpoint without documenting
   *  its chain parameter and this fails, which is the only way docs stay true to a growing API. */
  function endpointSectionIds(): string[] {
    const group = docs.split('{ title: "API Reference", items: [')[1]?.split("]}")[0] ?? "";
    return [...group.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  }

  it("the hero stops claiming the API is one chain", () => {
    expect(docs).toContain("5042");
    expect(docs).toMatch(/Robinhood Chain and Arc/);
  });

  it("every endpoint section documents chainId", () => {
    const ids = endpointSectionIds();
    expect(ids.length).toBeGreaterThanOrEqual(7);
    for (const id of ids) {
      const section = docs.split(`<section id="${id}"`)[1]?.split("</section>")[0];
      expect(section, `docs have no section for ${id}`).toBeTruthy();
      expect(
        /CHAIN_QUERY_PARAM|CHAIN_BODY_PARAM/.test(section!),
        `${id} does not document chainId`,
      ).toBe(true);
    }
  });

  it("the contract table is rendered from the registry, never typed out", () => {
    // What it replaced was seven hand-written addresses, none of which had any code on Robinhood
    // Chain — a docs page telling integrators to approve a spender that does not exist. A generated
    // table cannot drift from what the API answers; a typed one already had.
    const section = docs.split('<section id="contracts"')[1]?.split("</section>")[0] ?? "";
    expect(section).toContain("contractsFor(chain.id)");
    expect(section).toContain("SUPPORTED_CHAINS.map");
    expect(section, "an address literal in the contract table is a hand-written address").not.toMatch(
      /0x[0-9a-fA-F]{40}/,
    );
  });

  it("the chains page states the default, the refusal and Arc's two decimal counts", () => {
    const section = docs.split('<section id="chains"')[1]?.split("</section>")[0] ?? "";
    expect(section).toMatch(/4663/);
    expect(section).toMatch(/5042/);
    expect(section).toMatch(/refused|Refused/);
    expect(section).toMatch(/18-decimal/);
    expect(section).toMatch(/6-decimal/);
    expect(section).toContain("0x3600000000000000000000000000000000000000");
  });
});
