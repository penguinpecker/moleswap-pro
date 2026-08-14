/**
 * swapSettings.ts — the single source of truth for the Swap Settings panel.
 *
 * WHY THIS FILE EXISTS. The Settings screen (screens/settings/index.tsx) used to hold Max Slippage,
 * Route Priority and Gas Price in component-local useState. Nothing outside the panel could read them,
 * and they were discarded on unmount. Meanwhile the quote path passed a hardcoded 50 bps, so a user who
 * picked a slippage tolerance signed a swap whose on-chain amountOutMin came from a literal they never
 * chose. On a real-money DEX that is a fund-safety bug, not a cosmetic one.
 *
 * THE ONE NUMBER THAT REACHES THE CHAIN is `slippageBps`. It flows:
 *   panel -> localStorage -> slippageBpsFor() -> getQuote(req.slippageBps)
 *         -> plan.minOutFor(netAmountOut, slippageBps) -> MoleRouter.swap(plan).amountOutMin
 * so every function here that touches it clamps into the same range the API routes enforce
 * (app/api/v1/quote/route.ts:52, app/api/v1/tx/swap/route.ts:50): 0..5000 bps.
 *
 * A 0-bps floor would demand the quoted output to the wei and revert on any movement at all, so the
 * floor here is 1 bps rather than 0 — the user asking for "as tight as possible" still gets a swap that
 * can execute.
 *
 * NO REACT HERE. lib/chain/amm.ts imports this from non-component code (executeSwap runs outside the
 * render tree), so the React binding lives in hooks/use-swap-settings.ts instead.
 */

export type RoutePriority = "BEST RETURN" | "FASTEST";
export type GasPriceTier = "SLOW" | "NORMAL" | "FAST";

export interface SwapSettings {
  /** NOT YET HONOURED by the router — see the note at the bottom of this file. Persisted only. */
  readonly routePriority: RoutePriority;
  /** "AUTO" (let the app pick) or a percent string such as "0.5". This one IS honoured on-chain. */
  readonly maxSlippage: string;
  /** NOT YET HONOURED — no transaction in the app sets a gas price. Persisted only. */
  readonly gasPrice: GasPriceTier;
}

/** The tolerance the app has always used and still uses when the user leaves Max Slippage on AUTO. */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Guard rails shared with the public API routes. */
export const MIN_SLIPPAGE_BPS = 1;
export const MAX_SLIPPAGE_BPS = 5000;

export const DEFAULT_SWAP_SETTINGS: SwapSettings = {
  routePriority: "BEST RETURN",
  maxSlippage: "AUTO",
  gasPrice: "NORMAL",
};

const STORAGE_KEY = "moleswap.swapSettings";
/** Same-tab change notification. `storage` only fires in OTHER tabs, so the panel needs this too. */
const CHANGE_EVENT = "moleswap:swap-settings";

/**
 * Turn a panel value into the basis points the quoter and the router will actually use.
 *
 * "AUTO" means "the app decides", which today is DEFAULT_SLIPPAGE_BPS — deliberately identical to the
 * behaviour every existing user already has, so wiring the panel up does not silently loosen or tighten
 * the on-chain floor for anyone who never opened it. Any numeric string is taken as a percent, so adding
 * a preset to the panel is a UI-only change: "1" already resolves to 100 bps here.
 */
export function slippageBpsFor(maxSlippage: string | null | undefined): number {
  const raw = (maxSlippage ?? "").trim();
  if (!raw || raw.toUpperCase() === "AUTO") return DEFAULT_SLIPPAGE_BPS;
  const pct = Number(raw.replace(/%$/, ""));
  if (!Number.isFinite(pct) || pct < 0) return DEFAULT_SLIPPAGE_BPS;
  const bps = Math.round(pct * 100);
  return Math.min(MAX_SLIPPAGE_BPS, Math.max(MIN_SLIPPAGE_BPS, bps));
}

/** Coerce anything read out of storage into a valid settings object — never throw, never return junk. */
export function normalizeSwapSettings(input: unknown): SwapSettings {
  const p = (input ?? {}) as Partial<Record<keyof SwapSettings, unknown>>;
  return {
    routePriority: p.routePriority === "FASTEST" ? "FASTEST" : "BEST RETURN",
    maxSlippage:
      typeof p.maxSlippage === "string" && p.maxSlippage.trim() !== ""
        ? p.maxSlippage.trim()
        : DEFAULT_SWAP_SETTINGS.maxSlippage,
    gasPrice: p.gasPrice === "SLOW" || p.gasPrice === "FAST" ? p.gasPrice : "NORMAL",
  };
}

export function readSwapSettings(): SwapSettings {
  if (typeof window === "undefined") return DEFAULT_SWAP_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SWAP_SETTINGS;
    return normalizeSwapSettings(JSON.parse(raw));
  } catch {
    // Corrupt or unavailable storage must never break quoting — fall back to the app default.
    return DEFAULT_SWAP_SETTINGS;
  }
}

export function writeSwapSettings(next: SwapSettings): SwapSettings {
  const value = normalizeSwapSettings(next);
  if (typeof window === "undefined") return value;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* private-mode / quota — the in-memory value below still drives this session */
  }
  try {
    window.dispatchEvent(new CustomEvent<SwapSettings>(CHANGE_EVENT, { detail: value }));
  } catch {
    /* no CustomEvent (very old browser) — subscribers just miss this tick */
  }
  return value;
}

/** Subscribe to changes from this tab (CustomEvent) and from other tabs (storage). */
export function subscribeSwapSettings(cb: (s: SwapSettings) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onLocal = () => cb(readSwapSettings());
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === STORAGE_KEY) cb(readSwapSettings());
  };
  window.addEventListener(CHANGE_EVENT, onLocal as EventListener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal as EventListener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * The tolerance to quote and sign with right now. Called from non-React code (lib/chain/amm.ts) so it
 * reads storage directly rather than depending on a rendered component being mounted.
 */
export function getSlippageBps(): number {
  return slippageBpsFor(readSwapSettings().maxSlippage);
}

/* ─── What the deployed router does NOT support ──────────────────────────────────────────────────────
 *
 * ROUTE PRIORITY (BEST RETURN / FASTEST): MoleRouter.swap() takes a fully-formed plan; the path choice
 * happens off-chain in lib/aggregator/route.ts, which always maximises output (bestSplitRoute). The
 * search knobs that could express "fastest" already exist as request fields — quote.ts:34-36
 * maxHops / maxPaths / splitParts — but nothing in the app sets them, and picking values for them
 * changes which pools a real trade executes against. Left persisted-but-inert on purpose.
 *
 * GAS PRICE (SLOW / NORMAL / FAST): no transaction in this app sets a gas price at all. Every send goes
 * through viem's writeContract with no gas fields (lib/chain/amm.ts), so the wallet's own estimate wins.
 * The eth_gasPrice read in lib/aggregator/live.ts is display-only, for the fee estimate on the quote
 * card. Honouring this control means threading fee overrides into every writeContract call. Left
 * persisted-but-inert on purpose.
 */
