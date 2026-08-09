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

describe("/api/v1/tx/add-liquidity honest failure", () => {
  it("returns 501 pointing to the ALM vault instead of 500 on an empty ABI", async () => {
    const r = await addLiqPOST(
      new NextRequest("http://t/api/v1/tx/add-liquidity", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })
    );
    expect(r.status).toBe(501);
    const j = await r.json();
    expect(j.error).toMatch(/vault/i);
  });
});
