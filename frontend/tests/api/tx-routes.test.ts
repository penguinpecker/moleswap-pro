import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET as quoteGET } from "@/app/api/v1/quote/route";
import { POST as swapPOST } from "@/app/api/v1/tx/swap/route";
import { POST as addLiqPOST } from "@/app/api/v1/tx/add-liquidity/route";

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
  it("400 on a zero leg, pointing at the one-sided zap instead", async () => {
    const r = await addLiq({ ...OK_BODY, amount1Desired: "0" });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatch(/zapOpen/);
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
  // NOTE: the happy path (and the reversed-leg-order path) needs a live eth_call for slot0 and the
  // vault's range bounds, so it is exercised out-of-band rather than pinned here — this file stays
  // RPC-free on purpose.
});
