/**
 * tokensSwappable.test.ts — `swappable` on /api/v1/tokens is scoped to where the engine can quote.
 *
 * The pricing engine indexes Robinhood venues only, so on Arc every token used to publish
 * `swappable: true` while /api/v1/quote refused the chain outright.
 */
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../../app/api/v1/tokens/route";

const call = async (qs: string) => {
  const res = await GET(new NextRequest(`http://localhost/api/v1/tokens?${qs}`));
  return (await res.json()) as any;
};

describe("/api/v1/tokens swappable", () => {
  it("is false for every Arc token, because quoting is not served there", async () => {
    const j = await call("chainId=5042");
    expect(j.success).toBe(true);
    expect(j.data.tokens.length).toBeGreaterThan(0);
    for (const t of j.data.tokens) expect(t.swappable, t.symbol).toBe(false);
  });

  it("keeps Robinhood's per-token truth (WETH yes, USDe no)", async () => {
    const j = await call("chainId=4663");
    const by = new Map(j.data.tokens.map((t: any) => [t.symbol, t]));
    expect((by.get("WETH") as any).swappable).toBe(true);
    expect((by.get("USDe") as any).swappable).toBe(false);
  });
});
