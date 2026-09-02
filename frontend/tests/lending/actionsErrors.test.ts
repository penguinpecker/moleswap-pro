/**
 * actionsErrors.test.ts — the lending ABIs can NAME every revert, and the native reserve reads ETH.
 *
 * Two quiet failures: (1) `simulateContract` can only name a custom error whose signature is in the ABI
 * it was handed, so with function-only ABIs `BorrowingHalted` and friends surfaced as a raw selector and
 * the sentences in actions.ts never matched; (2) the native-ETH reserve's "you hold X" read WETH, so a
 * wallet holding ETH was told it held none and Supply on the market's main collateral was disabled.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { decodeErrorResult, toFunctionSelector, encodeAbiParameters } from "viem";
import { poolAbi, gatewayAbi, lendingErrorsAbi, readUserPosition, LENDING_ASSETS } from "../../lib/lending/market";

const sel = (sig: string) => toFunctionSelector(sig) as `0x${string}`;

describe("lending ABIs name their reverts", () => {
  it("carries Aave's Errors.sol and the gate's two errors", () => {
    const names = new Set<string>(lendingErrorsAbi.map((e) => e.name as string));
    for (const n of [
      "BorrowingHalted",
      "LivenessGateUnreadable",
      "HealthFactorLowerThanLiquidationThreshold",
      "CollateralCannotCoverNewBorrow",
      "SupplyCapExceeded",
      "BorrowCapExceeded",
      "ReserveFrozen",
      "ReservePaused",
      "NotEnoughAvailableUserBalance",
      "MustNotLeaveDust",
    ]) expect(names.has(n), n).toBe(true);
    expect(lendingErrorsAbi.length).toBeGreaterThanOrEqual(85);
  });

  it("the Pool ABI decodes a BorrowingHalted revert by name — the veto the gateway path bubbles too", () => {
    const d = decodeErrorResult({ abi: poolAbi, data: sel("BorrowingHalted()") });
    expect(d.errorName).toBe("BorrowingHalted");
    const g = decodeErrorResult({ abi: gatewayAbi, data: sel("BorrowingHalted()") });
    expect(g.errorName).toBe("BorrowingHalted");
    const h = decodeErrorResult({ abi: poolAbi, data: sel("HealthFactorLowerThanLiquidationThreshold()") });
    expect(h.errorName).toBe("HealthFactorLowerThanLiquidationThreshold");
  });

  it("decodes the e-mode errors with their arguments", () => {
    const reserve = "0x0000000000000000000000000000000000000abc";
    const data = (sel("InvalidCollateralInEmode(address,uint256)") +
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [reserve, 3n]).slice(2)) as `0x${string}`;
    const d = decodeErrorResult({ abi: poolAbi, data });
    expect(d.errorName).toBe("InvalidCollateralInEmode");
    expect(d.args?.[1]).toBe(3n);
  });
});

describe("readUserPosition", () => {
  const USER = "0x00000000000000000000000000000000000000a1" as const;
  const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  afterEach(() => vi.unstubAllGlobals());

  it("reads the wallet's ETH for the native reserve, and never WETH's balanceOf", async () => {
    const eth = LENDING_ASSETS.find((a) => a.isWrappedNative)!;
    const calls: { method: string; to?: string; data?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: any) => {
        const body = JSON.parse(init.body);
        const reqs = Array.isArray(body) ? body : [body];
        const answers = reqs.map((r: any) => {
          const p = r.params?.[0] ?? {};
          calls.push({ method: r.method, to: p.to?.toLowerCase(), data: p.data });
          let result: string;
          if (r.method === "eth_getBalance") result = word(42n);
          else if (r.method === "eth_chainId") result = "0x1237";
          else if (r.method === "eth_call" && String(p.data).startsWith("0xbf92857c")) result = "0x" + "00".repeat(32 * 6); // getUserAccountData
          else result = word(5n); // every balanceOf
          return { jsonrpc: "2.0", id: r.id, result };
        });
        return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
      }),
    );
    const pos = await readUserPosition(USER, 4663);
    expect(pos).not.toBeNull();
    expect(pos!.walletBalance[eth.symbol]).toBe(42n);
    // the ERC-20 reserves still read their token
    const usdg = LENDING_ASSETS.find((a) => a.symbol === "USDG")!;
    expect(pos!.walletBalance[usdg.symbol]).toBe(5n);
    // and no balanceOf(user) was ever asked of the WETH contract itself
    const wethBalanceOf = calls.filter(
      (c) => c.method === "eth_call" && c.to === eth.address.toLowerCase() && String(c.data).startsWith("0x70a08231"),
    );
    expect(wethBalanceOf).toHaveLength(0);
    expect(calls.some((c) => c.method === "eth_getBalance")).toBe(true);
  });
});
