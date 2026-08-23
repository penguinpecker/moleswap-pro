/**
 * swapPagePreflight.test.tsx — the confirm screen's sign button is gated by the pre-flight of the EXACT swap it
 * shows, and a blocked pre-flight renders the decoded reason, not a dead button.
 *
 * Rendered with react-dom directly (same reason as settingsPanel.test.tsx: @testing-library/dom is not
 * installed). amm.ts is mocked at its module boundary so the page is driven purely by verdicts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const prepareSwap = vi.fn();
const preflightSwap = vi.fn();
const executeSwap = vi.fn();

vi.mock("@/lib/chain/amm", () => ({ prepareSwap: (...a: any[]) => prepareSwap(...a), preflightSwap: (...a: any[]) => preflightSwap(...a), executeSwap: (...a: any[]) => executeSwap(...a) }));
vi.mock("@/lib/chain/provider", () => ({
  useWallet: () => ({ isConnected: true, isConnecting: false, chainClient: { ready: true }, address: ACCOUNT, connect: vi.fn() }),
}));
vi.mock("@/lib/wallet/walletClient", () => ({ getWalletClient: async () => null }));
vi.mock("../../screens/dapp/ExchangePage", () => ({ ExchangeHero: () => null }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PREPARED = {
  tokenIn: USDG,
  tokenOut: WETH,
  amountIn: 1_000_000n,
  recipient: ACCOUNT,
  encoded: {},
  calldata: "0xabcdef01",
  value: 0n,
  amountOut: 500_000_000_000_000n,
  minAmountOut: 497_500_000_000_000n,
  feeBps: 69,
  feeAmount: 6_900n,
  slippageBps: 50,
  deadline: 10n ** 12n,
  routeDescriptions: [],
  preparedAt: 0,
};

const swapData = {
  quote: { amountIn: "1000000" },
  fromToken: USDG,
  toToken: WETH,
  amount: "1",
  expectedOut: "0.0005",
  fromTokenMeta: { symbol: "USDG", decimals: 6, address: USDG, name: "USDG" } as any,
  toTokenMeta: { symbol: "WETH", decimals: 18, address: WETH, name: "Wrapped Ether" } as any,
  fromChain: { id: 4663, name: "Robinhood Chain" } as any,
  walletAddress: ACCOUNT,
  recipientAddress: ACCOUNT,
};

let container: HTMLDivElement;
let root: Root;

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

async function mount() {
  const { SwapPage } = await import("../../screens/dapp/SwapPage");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SwapPage onNext={vi.fn()} onBack={vi.fn()} swapData={swapData as any} />);
  });
  await flush();
}

const button = () => [...container.querySelectorAll("button.p-btn")].pop() as HTMLButtonElement;

beforeEach(() => {
  prepareSwap.mockReset();
  preflightSwap.mockReset();
  executeSwap.mockReset();
  prepareSwap.mockResolvedValue(PREPARED);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the sign button is gated by the pre-flight", () => {
  it("a BLOCKED pre-flight disables the button and shows the decoded reason with the raw data behind a disclosure", async () => {
    preflightSwap.mockResolvedValue({
      status: "blocked",
      kind: "revert",
      reason: { code: "router.InsufficientOutput", source: "router", title: "Price moved past your minimum", message: "Price moved — the route would deliver 0.00049 WETH, below your minimum of 0.0004975 WETH. Increase slippage, try a smaller amount, or refresh and retry.", raw: "0xdeadbeef" },
      providers: 1,
      blockNumber: 1n,
      at: 0,
    });
    await mount();
    expect(preflightSwap).toHaveBeenCalled();
    expect(preflightSwap.mock.calls[0]![0]).toBe(PREPARED); // the exact prepared swap, not a re-quote
    expect(preflightSwap.mock.calls[0]![1]).toBe(ACCOUNT); // simulated AS the signer
    const b = button();
    expect(b.disabled).toBe(true);
    expect(b.textContent).toMatch(/Blocked by pre-flight/);
    const blocked = container.querySelector('[data-testid="preflight-blocked"]')!;
    expect(blocked.textContent).toContain("Price moved past your minimum");
    expect(blocked.textContent).toContain("below your minimum");
    expect(blocked.querySelector("details summary")!.textContent).toBe("Raw error");
    expect(blocked.querySelector("details code")!.textContent).toBe("0xdeadbeef");
    // A click on the disabled button must not start a swap.
    await act(async () => { b.click(); });
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("an OK pre-flight renders the balance diff as a pre-flight (never 'guaranteed') and opens the button", async () => {
    preflightSwap.mockResolvedValue({ status: "ok", sent: 1_000_000n, received: 500_000_000_000_000n, amountOut: 500_000_000_000_000n, providers: 2, blockNumber: 1n, at: 0 });
    await mount();
    const box = container.querySelector('[data-testid="preflight"]')!;
    expect(box.textContent).toContain("You send");
    expect(box.textContent).toContain("−1 USDG");
    expect(box.textContent).toContain("You receive (simulated)");
    expect(box.textContent).toContain("+0.0005 WETH");
    expect(box.textContent).toMatch(/not a guarantee/);
    expect(box.textContent).toContain("2 providers agree");
    expect(box.textContent).not.toMatch(/guaranteed/i);
    const b = button();
    expect(b.disabled).toBe(false);
    expect(b.textContent).toMatch(/Start swapping/);
  });

  it("clicking Start hands executeSwap the SAME prepared object the pre-flight ran on", async () => {
    preflightSwap.mockResolvedValue({ status: "ok", sent: 1_000_000n, received: 500_000_000_000_000n, amountOut: 500_000_000_000_000n, providers: 1, blockNumber: 1n, at: 0 });
    executeSwap.mockImplementation(async () => new Promise(() => {})); // never resolves; we only inspect the call
    await mount();
    await act(async () => { button().click(); });
    await flush();
    expect(executeSwap).toHaveBeenCalledTimes(1);
    const args = executeSwap.mock.calls[0]![0];
    expect(args.prepared).toBe(PREPARED);
    expect(args.amountIn).toBe("1000000");
    expect(typeof args.onPreflight).toBe("function");
  });

  it("a rebuilt plan closes the button again until ITS OWN pre-flight returns", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "clearTimeout"] });
    try {
      const P2 = { ...PREPARED, calldata: "0xfeedface", preparedAt: 1 };
      prepareSwap.mockResolvedValueOnce(PREPARED).mockResolvedValue(P2);
      let resolveSecond: ((v: any) => void) | null = null;
      preflightSwap
        .mockResolvedValueOnce({ status: "ok", sent: 1_000_000n, received: 500_000_000_000_000n, amountOut: 500_000_000_000_000n, providers: 1, blockNumber: 1n, at: 0 })
        .mockImplementationOnce(() => new Promise((r) => { resolveSecond = r; }));
      const { SwapPage } = await import("../../screens/dapp/SwapPage");
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root.render(<SwapPage onNext={vi.fn()} onBack={vi.fn()} swapData={swapData as any} />);
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(button().disabled).toBe(false); // first cycle: P1 pre-flighted ok

      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); }); // second cycle rebuilds → P2, probe pending
      expect(preflightSwap).toHaveBeenCalledTimes(2);
      expect(preflightSwap.mock.calls[1]![0]).toBe(P2);
      expect(button().disabled).toBe(true); // the old verdict does not open the button for the new calldata
      expect(button().textContent).toMatch(/Waiting for pre-flight/);
      expect(container.querySelector('[data-testid="preflight"]')!.textContent).toMatch(/re-checking/);

      await act(async () => {
        resolveSecond!({ status: "ok", sent: 1_000_000n, received: 500_000_000_000_000n, amountOut: 500_000_000_000_000n, providers: 1, blockNumber: 2n, at: 0 });
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(button().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ONE provider answering is labelled as such — the missing second opinion is visible, never silent", async () => {
    preflightSwap.mockResolvedValue({ status: "ok", sent: 1_000_000n, received: 500_000_000_000_000n, amountOut: 500_000_000_000_000n, providers: 1, blockNumber: 1n, at: 0 });
    await mount();
    const box = container.querySelector('[data-testid="preflight"]')!;
    expect(box.textContent).toContain("second opinion unavailable");
    expect(box.textContent).not.toMatch(/providers agree/);
    expect(box.textContent).toMatch(/not a guarantee/);
    expect(button().disabled).toBe(false); // one honest provider still opens the button (T-37: unreachable ≠ mismatch)
  });

  it("a pre-flight that could not run keeps the button closed and offers a retry", async () => {
    preflightSwap.mockResolvedValue({ status: "unavailable", at: 0, reason: { code: "transport.unavailable", source: "transport", title: "RPC did not answer", message: "The RPC endpoint did not answer (network problem or rate limit). Retry in a moment.", raw: "fetch failed" } });
    await mount();
    expect(button().disabled).toBe(true);
    const un = container.querySelector('[data-testid="preflight-unavailable"]')!;
    expect(un.textContent).toMatch(/Pre-flight could not run/);
    const before = prepareSwap.mock.calls.length;
    await act(async () => { (un.querySelector("button.pf-retry") as HTMLButtonElement).click(); });
    await flush();
    expect(prepareSwap.mock.calls.length).toBeGreaterThan(before);
  });

  it("a quoter failure while preparing reads as a failure, a genuine no-route reads as no-route — and both keep the button closed", async () => {
    prepareSwap.mockRejectedValueOnce(new Error("quote failed: cannot build a plan from an incomplete split"));
    preflightSwap.mockResolvedValue({ status: "ok", sent: 1n, received: 1n, amountOut: 1n, providers: 1, blockNumber: 1n, at: 0 });
    await mount();
    let box = container.querySelector('[data-testid="preflight"]')!;
    expect(box.textContent).toMatch(/not a liquidity problem/);
    expect(box.textContent).toContain("incomplete split");
    expect(box.textContent).not.toMatch(/No route with live liquidity/);
    expect(button().disabled).toBe(true);
    expect(preflightSwap).not.toHaveBeenCalled();

    act(() => root.unmount());
    container.remove();
    prepareSwap.mockReset();
    prepareSwap.mockResolvedValue(null);
    await mount();
    box = container.querySelector('[data-testid="preflight"]')!;
    expect(box.textContent).toMatch(/No route with live liquidity/);
    expect(box.textContent).not.toMatch(/not a liquidity problem/);
    expect(button().disabled).toBe(true);
  });
});

/* ------------------------------------------------------ a mismatch halts the cycle; only the user restarts it */

const MISMATCH = {
  status: "blocked",
  kind: "mismatch",
  reason: { code: "preflight.mismatch", source: "preflight", title: "Simulation mismatch — do not sign", message: "Two RPC providers simulated the same swap at block 4096 and disagreed. One of them is wrong, and this swap must not be signed until they agree. This check is not retried automatically.", raw: "http://a.rpc: stage=0 out=1 sent=1 received=1\nhttp://b.rpc: stage=0 out=1 sent=1 received=2" },
  providers: 2,
  blockNumber: 4096n,
  at: 0,
} as const;
const OK1 = { status: "ok", sent: 1_000_000n, received: 500_000_000_000_000n, amountOut: 500_000_000_000_000n, providers: 2, blockNumber: 1n, at: 0 } as const;

/** Mount under fake timers so the 8 s cycle can be driven by hand. */
async function mountFake() {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearInterval", "clearTimeout"] });
  const { SwapPage } = await import("../../screens/dapp/SwapPage");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SwapPage onNext={vi.fn()} onBack={vi.fn()} swapData={swapData as any} />);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
}
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

describe("a 'simulation mismatch — do not sign' verdict is NEVER re-checked automatically (T-37 / S-68)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("after a mismatch the 8 s cycle stops: no re-prepare, no re-simulate at +8 s or +16 s, button stays blocked", async () => {
    // Attack: the second provider 'recovers' on the next cycle (or drops out, leaving the honest one alone):
    // if the page re-ran by itself, a looping retry would reopen the button. It must not run at all.
    preflightSwap.mockResolvedValueOnce(MISMATCH).mockResolvedValue(OK1);
    await mountFake();
    expect(preflightSwap).toHaveBeenCalledTimes(1);
    expect(prepareSwap).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toMatch(/Blocked by pre-flight/);
    expect(container.querySelector('[data-testid="preflight-blocked"]')!.textContent).toMatch(/do not sign/i);
    expect(container.querySelector('[data-testid="preflight-halted"]')!.textContent).toMatch(/not re-checked automatically/);

    await advance(8_100);
    expect(prepareSwap).toHaveBeenCalledTimes(1);
    expect(preflightSwap).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toMatch(/Blocked by pre-flight/);

    await advance(8_100);
    expect(prepareSwap).toHaveBeenCalledTimes(1);
    expect(preflightSwap).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("only the explicit Re-check button restarts the cycle — one click, one new pre-flight", async () => {
    preflightSwap.mockResolvedValueOnce(MISMATCH).mockResolvedValue(OK1);
    await mountFake();
    await advance(8_100);
    expect(preflightSwap).toHaveBeenCalledTimes(1);
    const recheck = container.querySelector('[data-testid="preflight-recheck"]') as HTMLButtonElement;
    expect(recheck).toBeTruthy();
    await act(async () => { recheck.click(); });
    await advance(10);
    expect(prepareSwap).toHaveBeenCalledTimes(2);
    expect(preflightSwap).toHaveBeenCalledTimes(2);
    // The user asked; the providers now agree; the verdict opens the button and the halt notice is gone.
    expect(button().disabled).toBe(false);
    expect(button().textContent).toMatch(/Start swapping/);
    expect(container.querySelector('[data-testid="preflight-halted"]')).toBeNull();
    expect(container.querySelector('[data-testid="preflight-recheck"]')).toBeNull();
  });

  it("a mismatch from the signing-time re-check latches the same halt: the cycle does not resume after the failed attempt", async () => {
    // Card pre-flight is green, the user clicks, and executeSwap's own gate sees a mismatch → the attempt fails.
    // The cycle that would normally resume after isExecuting flips back must NOT re-simulate on its own.
    preflightSwap.mockResolvedValue(OK1);
    executeSwap.mockImplementation(async (args: any) => {
      args.onPreflight(MISMATCH);
      return { success: false, error: MISMATCH.reason.message, preflight: MISMATCH };
    });
    await mountFake();
    expect(button().disabled).toBe(false);
    await act(async () => { button().click(); });
    await advance(50);
    expect(executeSwap).toHaveBeenCalledTimes(1);
    const callsAfterAttempt = preflightSwap.mock.calls.length;
    expect(button().disabled).toBe(true);
    expect(button().textContent).toMatch(/Blocked by pre-flight/);
    await advance(8_100);
    await advance(8_100);
    expect(preflightSwap).toHaveBeenCalledTimes(callsAfterAttempt);
    expect(button().disabled).toBe(true);
    expect(container.querySelector('[data-testid="preflight-halted"]')).toBeTruthy();
  });

  it("a non-mismatch block (a plain revert) does NOT halt the cycle — it keeps re-checking, as before", async () => {
    preflightSwap
      .mockResolvedValueOnce({ status: "blocked", kind: "revert", reason: { code: "router.DeadlinePassed", source: "router", title: "Quote expired", message: "This quote's deadline has passed. Refresh and try again.", raw: "0x" }, providers: 2, blockNumber: 1n, at: 0 })
      .mockResolvedValue(OK1);
    await mountFake();
    expect(button().disabled).toBe(true);
    expect(container.querySelector('[data-testid="preflight-halted"]')).toBeNull();
    expect(container.querySelector('[data-testid="preflight-recheck"]')).toBeNull();
    await advance(8_100);
    expect(preflightSwap).toHaveBeenCalledTimes(2);
    expect(button().disabled).toBe(false);
  });
});
