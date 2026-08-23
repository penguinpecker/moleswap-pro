import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { FetchRequest } from "ethers";
import { request as httpsRequest } from "node:https";
import { gunzipSync } from "node:zlib";
import { GET as quoteGET } from "@/app/api/v1/quote/route";
import { POST as swapPOST } from "@/app/api/v1/tx/swap/route";
import { POST as addLiqPOST } from "@/app/api/v1/tx/add-liquidity/route";

/**
 * Let ethers reach the live RPC from inside vitest's jsdom environment.
 *
 * ethers' built-in node transport collects node-realm Buffers, but the ethers module in these
 * tests is instantiated in the jsdom realm, whose Uint8Array is a DIFFERENT class — so every
 * response fails isBytesLike ("invalid BytesLike value") and live reads 503. This getUrl override
 * does the same HTTP over node:https but hands ethers a Uint8Array built in the test realm.
 * (No accept-encoding is sent, so the body needs no decompression.) Registration is per test
 * file — vitest isolates module registries — and only affects requests that would otherwise
 * have failed on the realm mismatch.
 */
FetchRequest.registerGetUrl(async (req: any) => {
  const url = new URL(req.url);
  // ethers advertises accept-encoding: gzip (allowGzip) but its OWN transport is what would have
  // decompressed the body — this one hands ethers the raw bytes, so never ask for gzip.
  const reqHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers as Record<string, string>)) {
    if (k.toLowerCase() !== "accept-encoding") reqHeaders[k] = v;
  }
  return await new Promise<any>((resolve, reject) => {
    const r = httpsRequest(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: reqHeaders,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          let raw = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          }
          if ((headers["content-encoding"] || "").includes("gzip")) {
            raw = gunzipSync(raw); // defensive — should not happen without accept-encoding
            delete headers["content-encoding"];
          }
          const body = new Uint8Array(raw.length); // test-realm Uint8Array — the whole point
          body.set(raw);
          resolve({
            statusCode: res.statusCode || 0,
            statusMessage: res.statusMessage || "",
            headers,
            body,
          });
        });
        res.on("error", reject);
      },
    );
    r.on("error", reject);
    if (req.body) r.end(Buffer.from(req.body)); else r.end();
  });
});

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const REC = "0x47D1000000000000000000000000000000000814";
const ZERO = "0x0000000000000000000000000000000000000000";

function get(url: string) {
  return quoteGET(new NextRequest(url));
}
function post(url: string, body: any) {
  return swapPOST(
    new NextRequest(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  );
}

// These assert the deterministic validation/branch logic that runs BEFORE any RPC/Supabase call.
describe("/api/v1/quote validation", () => {
  it("400 on missing params", async () => {
    const r = await get("http://t/api/v1/quote");
    expect(r.status).toBe(400);
  });
  it("400 on non-numeric amountIn", async () => {
    const r = await get(`http://t/api/v1/quote?tokenIn=${WETH}&tokenOut=${USDG}&amountIn=abc`);
    expect(r.status).toBe(400);
  });
  it("400 on bad tokenIn address", async () => {
    const r = await get(`http://t/api/v1/quote?tokenIn=nope&tokenOut=${USDG}&amountIn=1`);
    expect(r.status).toBe(400);
  });
  it("native<->WETH is a 1:1 wrap quote (no route needed)", async () => {
    const r = await get(`http://t/api/v1/quote?tokenIn=${ZERO}&tokenOut=${WETH}&amountIn=1000`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.type).toBe("wrap_unwrap");
    expect(j.data.amountOut).toBe("1000");
  });
});

describe("/api/v1/tx/swap validation + wrap paths", () => {
  it("400 on missing fields", async () => {
    const r = await post("http://t/api/v1/tx/swap", { tokenIn: WETH });
    expect(r.status).toBe(400);
  });
  it("400 on bad recipient", async () => {
    const r = await post("http://t/api/v1/tx/swap", { tokenIn: WETH, tokenOut: USDG, amountIn: "1", recipient: "nope" });
    expect(r.status).toBe(400);
  });
  it("wrap path returns a real WETH.deposit() tx", async () => {
    const r = await post("http://t/api/v1/tx/swap", { tokenIn: ZERO, tokenOut: WETH, amountIn: "1000", recipient: REC });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.type).toBe("wrap");
    expect(j.data.transactions[0].to.toLowerCase()).toBe(WETH.toLowerCase());
    expect(j.data.transactions[0].value).toBe("1000");
    expect(j.data.transactions[0].data).toMatch(/^0xd0e30db0/); // deposit()
  });
  it("unwrap path returns a real WETH.withdraw() tx", async () => {
    const r = await post("http://t/api/v1/tx/swap", { tokenIn: WETH, tokenOut: ZERO, amountIn: "1000", recipient: REC });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.type).toBe("unwrap");
    expect(j.data.transactions[0].data).toMatch(/^0x2e1a7d4d/); // withdraw(uint256)
  });
});

// The route now BUILDS the two-sided MolePositions.open calldata (there is no v3 position manager on
// this chain, so `open` is the mint). Everything asserted here runs before the first RPC call.
function addLiq(body: any) {
  return addLiqPOST(
    new NextRequest("http://t/api/v1/tx/add-liquidity", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })
  );
}
const OK_BODY = {
  token0: WETH,
  token1: USDG,
  amount0Desired: "1000000000000000",
  amount1Desired: "4000000",
  recipient: REC,
  fee: 500,
};

describe("/api/v1/tx/add-liquidity validation", () => {
  it("400 on missing fields, naming every documented required parameter", async () => {
    const r = await addLiq({});
    expect(r.status).toBe(400);
    const j = await r.json();
    for (const f of ["token0", "token1", "amount0Desired", "amount1Desired", "recipient"]) {
      expect(j.error).toContain(f);
    }
  });
  it("400 on a bad recipient", async () => {
    const r = await addLiq({ ...OK_BODY, recipient: "nope" });
    expect(r.status).toBe(400);
  });
  it("400 when an amount is a JS number instead of a wei string", async () => {
    const r = await addLiq({ ...OK_BODY, amount1Desired: 4000000 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/STRING in wei/);
  });
  it("400 on a zero leg WITHOUT range params, explaining the one-sided contract", async () => {
    const r = await addLiq({ ...OK_BODY, amount1Desired: "0" });
    expect(r.status).toBe(400);
    const j = await r.json();
    // The refusal must teach the caller how to make the same request valid.
    expect(j.error).toMatch(/ONE-SIDED/i);
    expect(j.error).toMatch(/tickLower/);
    expect(j.error).toMatch(/preset/);
  });
  it("400 when both legs are zero, even with a preset", async () => {
    const r = await addLiq({ ...OK_BODY, amount0Desired: "0", amount1Desired: "0", preset: "tight" });
    expect(r.status).toBe(400);
  });
  it("400 on a malformed preset with a zero leg", async () => {
    const r = await addLiq({ ...OK_BODY, amount1Desired: "0", preset: "wide" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/preset/);
  });
  it("400 on a fee tier that is not the live dynamic-fee pool", async () => {
    const r = await addLiq({ ...OK_BODY, fee: 3000 });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/0x800000/);
  });
  it("400 on a pair the vault has not whitelisted, naming the real pair", async () => {
    const r = await addLiq({ ...OK_BODY, token1: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9" });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/WETH/);
    expect(j.error).toMatch(/USDG/);
  });
  it("400 on slippageBps out of range", async () => {
    const r = await addLiq({ ...OK_BODY, slippageBps: 10001 });
    expect(r.status).toBe(400);
  });
  // NOTE: the TWO-SIDED happy path (and the reversed-leg-order path) needs a live eth_call for slot0
  // and the vault's range bounds, so it is exercised out-of-band rather than pinned here.
});

// ONE-SIDED deposits: a zero leg + a preset (or explicit ticks) builds a real open() whose off-side
// cap is 0. These need the live tick (the range is placed relative to spot), so they do one
// eth_call each against the mainnet RPC — using a preset keeps them deterministic wherever the
// tick happens to be. ethers reads over node http(s), so the jsdom fetch mock does not interfere.
const VAULT_ADDR = "0x674625B6E6a2614ef6e247af099BEA2e65e1536A".toLowerCase();
const APPROVE_SELECTOR = /^0x095ea7b3/;

describe("/api/v1/tx/add-liquidity one-sided deposits", () => {
  it("zero token1 leg + preset → one-sided token0 (WETH) open ABOVE spot, off-side cap 0", async () => {
    const r = await addLiq({ ...OK_BODY, amount1Desired: "0", preset: "tight" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.depositMode).toBe("one-sided");
    expect(j.data.side).toBe("token0");
    expect(j.data.depositToken.address.toLowerCase()).toBe(WETH.toLowerCase());
    // THE one-sided guarantee: the off side's cap is 0 and the range is strictly above spot.
    expect(j.data.amount1Max).toBe("0");
    expect(j.data.tickLower).toBeGreaterThan(j.data.currentTick);
    // width inside the live band, ticks on the 60 spacing
    const width = j.data.tickUpper - j.data.tickLower;
    expect(width).toBeGreaterThanOrEqual(120);
    expect(width).toBeLessThanOrEqual(60000);
    expect(Math.abs(j.data.tickLower % 60)).toBe(0); // abs: negative ticks give -0
    expect(Math.abs(j.data.tickUpper % 60)).toBe(0);
    // exactly ONE approval (the deposit token), then the open() against the vault
    const approvals = j.data.transactions.filter((t: any) => APPROVE_SELECTOR.test(t.data));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].to.toLowerCase()).toBe(WETH.toLowerCase());
    const open = j.data.transactions[j.data.transactions.length - 1];
    expect(open.to.toLowerCase()).toBe(VAULT_ADDR);
  }, 30_000);

  it("zero token0 leg + preset → one-sided token1 (USDG) open BELOW spot, off-side cap 0", async () => {
    const r = await addLiq({ ...OK_BODY, amount0Desired: "0", preset: "launch" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.data.depositMode).toBe("one-sided");
    expect(j.data.side).toBe("token1");
    expect(j.data.depositToken.address.toLowerCase()).toBe(USDG.toLowerCase());
    expect(j.data.amount0Max).toBe("0");
    expect(j.data.tickUpper).toBeLessThanOrEqual(j.data.currentTick);
    const approvals = j.data.transactions.filter((t: any) => APPROVE_SELECTOR.test(t.data));
    expect(approvals).toHaveLength(1);
    expect(approvals[0].to.toLowerCase()).toBe(USDG.toLowerCase());
  }, 30_000);

  // The gate that decides whether ANY of the above is built runs against the real MoleHook. This is the
  // live-chain half of tests/api/addLiquidityAnchor.test.ts, which drives the manipulated cases against
  // stubbed reads: here the only thing asserted is that the oracle answers at all, over the window the
  // vault names, and that the route reports spot's real distance from it.
  it("the live route prices against MoleHook's TWAP and reports how far spot has walked from it", async () => {
    const r = await addLiq({ ...OK_BODY, amount1Desired: "0", preset: "tight" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(Number.isInteger(j.data.twapTick)).toBe(true);
    expect(j.data.twapWindowSeconds).toBe(1800);
    expect(j.data.maxTwapDeviationTicks).toBe(600);
    expect(j.data.twapDeviationTicks).toBe(Math.abs(j.data.currentTick - j.data.twapTick));
    expect(j.data.twapDeviationTicks).toBeLessThanOrEqual(j.data.maxTwapDeviationTicks);
  }, 30_000);

  it("explicit ticks on the WRONG side of spot are refused, not nudged across", async () => {
    // A token0 (above-spot) deposit with a range far BELOW any plausible spot tick: the route must
    // 400 with the side rule spelled out, never "fix" the range into a two-sided pull.
    const r = await addLiq({
      ...OK_BODY,
      amount1Desired: "0",
      tickLower: -886800,
      tickUpper: -886500,
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/ABOVE the current tick/);
  }, 30_000);
});
