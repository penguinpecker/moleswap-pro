/**
 * Chain & Token API — the swap card's view of the chains MoleSwap is live on.
 *
 * WHAT WAS WRONG. `getChains()` returned a HARDCODED SINGLE-ELEMENT ARRAY: one "Robinhood Chain"
 * entry whose tokens came from the flat, Robinhood-only registry in `contracts.ts`. That was true
 * while MoleSwap ran on one chain. It stopped being true the day the router went live on Arc, and the
 * failure mode was not a missing feature — it was a LIE. The chrome's switcher said "Arc" while this
 * function kept handing the exchange screen Robinhood's ETH/WETH/USDG, so the card read
 * "Robinhood Chain / ETH → Robinhood Chain / USDG" with a Robinhood balance under it while the user
 * believed they were on Arc. A user cannot tell that apart from the app being broken.
 *
 * SO EACH CHAIN NOW CARRIES ITS OWN TOKEN SET, and the addresses are not restated here: Robinhood's
 * come from `contracts.ts` (still the Robinhood answer, untouched) and Arc's from
 * `lib/chain/arcTokens.ts`, where every field was read back from chain 5042. `chains.ts` remains the
 * one registry for ids, RPCs, explorers and gas symbols.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ARC'S GAS TOKEN AND ITS ERC-20 ARE ONE BALANCE, SO THIS FILE LISTS IT EXACTLY ONCE.
 *  `eth_getBalance` reports Arc's USDC with EIGHTEEN decimals; `balanceOf` at 0x3600…0000 reports the
 *  very same money with SIX. There is no wrapper and no conversion contract between the two views.
 *  Listing a "native USDC" beside the ERC-20 would put two rows in the picker that a user could try to
 *  swap between — a trade with no counterparty, against a pool that does not exist. Arc's `currency`
 *  therefore POINTS AT the ERC-20 (same address, 6 decimals, one featured row) and records the native
 *  convention alongside it rather than as a second asset.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
import { TOKENS, type TokenInfo } from "@/lib/chain/contracts";
import { ARC_USDC, ARC_ARCHITECTS } from "@/lib/chain/arcTokens";
import { ARC_CHAIN, RH_CHAIN, SUPPORTED_CHAINS, type ChainMeta } from "@/lib/chain/chains";

export interface TokenEntry {
  id: string;
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  logoURI?: string;
  sourceChain?: string;
  displaySymbol?: string;
  displaySubtitle?: string;
  originChainName?: string;
  originSymbol?: string;
  bridgeable?: boolean;
  /** Worth $1 for the card's USD line. Pinned per chain — NEVER inferred from a symbol. */
  isStable?: boolean;
  /**
   * How much of THIS token a MAX must keep back, as a RAW-UNITS STRING in this token's own decimals,
   * because this is what the chain charges gas in. Absent for a token that does not pay gas.
   *
   * Per-token and not per-chain on purpose: Robinhood's buffer is 18-decimal ETH and Arc's is
   * 6-decimal USDC, and one chain-level number would have to carry its decimals in a comment.
   */
  gasBuffer?: string;
}

export interface ChainEntry {
  id: number;
  key: ChainMeta["key"];
  name: string;
  displayName: string;
  shortName: string;
  iconUrl?: string;
  logoUrl?: string;
  /** Two-letter mark + accent, the same pair the chrome's switcher draws. */
  mark: string;
  accent: string;
  explorerUrl: string;
  vmType?: string;
  /** The unit this chain charges gas in, as the card should render it. See the header on Arc. */
  currency?: {
    id: string;
    symbol: string;
    name: string;
    address?: string;
    decimals: number;
    displaySymbol?: string;
    displaySubtitle?: string;
  };
  /**
   * Decimals of the NATIVE unit — what `eth_getBalance` and `msg.value` are denominated in. Equal to
   * `currency.decimals` everywhere except Arc, where the same balance is 18-decimal natively and
   * 6-decimal through the ERC-20 the pools actually use.
   */
  nativeDecimals: number;
  /** Wrapped native, or null where the chain has none. Never the zero address — see `contracts.ts`. */
  wrappedNative: string | null;
  /**
   * Why this chain has no native/wrap path, in words a user can act on; null when it HAS one.
   * Rendered, never used to silently hide a control — a missing wrap button with no sentence beside
   * it is indistinguishable from a bug.
   */
  nativePathUnavailable: string | null;
  erc20Currencies?: TokenEntry[];
  featuredTokens?: (TokenEntry & { metadata?: { logoURI?: string } })[];
  /** The pair the card opens on for this chain. Reset to when the wallet changes chains. */
  defaultPair: { from: string; to: string };
}

const RH_ICON = "/tokens/rh.svg";

/**
 * Deterministic per-token identicon for tokens without a hosted logo: a colored
 * coin with the symbol's first letters, hue derived from the address. Rendered
 * as an inline SVG data URI so it needs no asset and never 404s. This replaces
 * the old behaviour of showing the ETH logo for every unknown token, which
 * made imported tokens indistinguishable from ETH.
 */
export function tokenFallbackIcon(address?: string | null, symbol?: string | null): string {
  const addr = (address || "0x0").toLowerCase();
  let h = 0;
  for (let i = 2; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const label = (symbol || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() || "?";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` +
    `<rect width="48" height="48" rx="10" fill="hsl(${hue},55%,28%)"/>` +
    `<rect x="3" y="3" width="42" height="42" rx="8" fill="hsl(${hue},65%,42%)"/>` +
    `<text x="24" y="30" font-family="monospace" font-size="${label.length > 2 ? 14 : 18}" font-weight="bold" fill="#fff" text-anchor="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ────────────────────────────── per-chain gas buffers ────────────────────────────── */

/** Leave 0.0003 ETH behind on a MAX native swap — the amount this card has always reserved. */
const RH_GAS_BUFFER = "300000000000000";

/**
 * Leave 0.05 USDC behind on a MAX Arc swap, in the ERC-20's SIX decimals.
 *
 * This buffer matters far more on Arc than on Robinhood, because gas and the swap come out of the
 * SAME balance: a true MAX would leave the user unable to pay for the transaction that spends it. The
 * figure matches the vault's `ARC_GAS_BUFFER` — sized from the real funded run (a ~430k-gas write at
 * Arc's 20 gwei base fee costs on the order of 0.012 USDC), not guessed.
 */
const ARC_GAS_BUFFER = "50000";

/* ─────────────────────────────── per-chain token sets ─────────────────────────────── */

function rhFeaturedTokens(): (TokenEntry & { metadata?: { logoURI?: string } })[] {
  const swappable = TOKENS.filter((t) => t.swappable !== false && !t.hidden);
  return swappable.map((t: TokenInfo) => ({
    id: t.address,
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    logoURI: t.logoURI,
    sourceChain: t.sourceChain,
    metadata: { logoURI: t.logoURI },
    displaySymbol: t.displaySymbol,
    displaySubtitle: t.displaySubtitle,
    originChainName: t.sourceChain,
    originSymbol: t.originSymbol,
    bridgeable: t.bridgeable,
    isStable: (t as TokenInfo & { isStable?: boolean }).isStable === true,
    // Native ETH is the only Robinhood row that pays gas; WETH and USDG do not.
    gasBuffer: t.address === "0x0000000000000000000000000000000000000000" ? RH_GAS_BUFFER : undefined,
  }));
}

/**
 * Arc's two swappable assets — the live pool's two legs, and nothing else.
 *
 * There is deliberately NO 0x0 native row: a native path on Arc has nothing to wrap into (the
 * router's `weth` slot is pinned to the USDC ERC-20 so those paths fail closed) and a transfer to the
 * zero address REVERTS on this chain. The gas token reaches the user as the ERC-20 row below, which
 * is the same balance under the decimals the pools are denominated in.
 */
function arcFeaturedTokens(): (TokenEntry & { metadata?: { logoURI?: string } })[] {
  return [
    {
      id: ARC_USDC.address,
      symbol: ARC_USDC.symbol,
      name: ARC_USDC.name,
      address: ARC_USDC.address,
      decimals: ARC_USDC.decimals,
      logoURI: "",
      sourceChain: ARC_CHAIN.name,
      metadata: { logoURI: "" },
      displaySymbol: ARC_USDC.symbol,
      // Says the thing a user has to know before they hit MAX, in the row itself.
      displaySubtitle: `${ARC_CHAIN.name} gas token`,
      originChainName: ARC_CHAIN.name,
      originSymbol: ARC_USDC.symbol,
      isStable: true,
      gasBuffer: ARC_GAS_BUFFER,
    },
    {
      id: ARC_ARCHITECTS.address,
      symbol: ARC_ARCHITECTS.symbol,
      name: ARC_ARCHITECTS.name,
      address: ARC_ARCHITECTS.address,
      decimals: ARC_ARCHITECTS.decimals,
      logoURI: "",
      sourceChain: ARC_CHAIN.name,
      metadata: { logoURI: "" },
      displaySymbol: ARC_ARCHITECTS.symbol,
      displaySubtitle: `on ${ARC_CHAIN.name}`,
      originChainName: ARC_CHAIN.name,
      originSymbol: ARC_ARCHITECTS.symbol,
    },
  ];
}

/* ─────────────────────────────────── the chain entries ─────────────────────────────────── */

function rhEntry(): ChainEntry {
  const featuredTokens = rhFeaturedTokens();
  return {
    id: RH_CHAIN.id,
    key: RH_CHAIN.key,
    name: RH_CHAIN.name,
    displayName: RH_CHAIN.name,
    shortName: RH_CHAIN.shortName,
    iconUrl: RH_ICON,
    logoUrl: RH_ICON,
    mark: RH_CHAIN.mark,
    accent: RH_CHAIN.accent,
    explorerUrl: RH_CHAIN.explorerUrl,
    vmType: "evm",
    currency: {
      id: "eth",
      symbol: "ETH",
      name: "Ether",
      address: "0x0000000000000000000000000000000000000000",
      decimals: 18,
      displaySymbol: "ETH",
      displaySubtitle: RH_CHAIN.name,
    },
    nativeDecimals: RH_CHAIN.nativeDecimals,
    wrappedNative: TOKENS.find((t) => t.symbol === "WETH")?.address ?? null,
    nativePathUnavailable: null,
    featuredTokens,
    defaultPair: {
      // ETH → USDG: exactly the pair this card has always opened on.
      from: "0x0000000000000000000000000000000000000000",
      to: featuredTokens.find((t) => t.isStable)?.address ?? featuredTokens[0].address,
    },
  };
}

function arcEntry(): ChainEntry {
  const featuredTokens = arcFeaturedTokens();
  return {
    id: ARC_CHAIN.id,
    key: ARC_CHAIN.key,
    name: ARC_CHAIN.name,
    displayName: ARC_CHAIN.name,
    shortName: ARC_CHAIN.shortName,
    mark: ARC_CHAIN.mark,
    accent: ARC_CHAIN.accent,
    explorerUrl: ARC_CHAIN.explorerUrl,
    vmType: "evm",
    currency: {
      id: "arc-usdc",
      symbol: ARC_USDC.symbol,
      name: ARC_USDC.name,
      // The ERC-20 view, NOT 0x0: this is the address a swap actually moves, and the zero address
      // is not spendable on Arc (transfers to it revert).
      address: ARC_USDC.address,
      // SIX, because this is the decimals count the pools — and therefore every amount on this card —
      // are denominated in. `nativeDecimals` below records the other convention.
      decimals: ARC_USDC.decimals,
      displaySymbol: ARC_USDC.symbol,
      displaySubtitle: `${ARC_CHAIN.name} gas token`,
    },
    // 18: what a wallet divides eth_getBalance by on Arc. Same balance as the 6-decimal ERC-20 above.
    nativeDecimals: ARC_CHAIN.nativeDecimals,
    wrappedNative: null,
    nativePathUnavailable:
      `${ARC_CHAIN.name} has no wrapped-native token, so there is nothing to wrap or unwrap: MoleRouter's ` +
      `WETH slot is pinned to the ${ARC_USDC.symbol} ERC-20 there so native paths fail closed rather than ` +
      `half-work. Gas is paid in ${ARC_USDC.symbol}, and the balance you pay it with is the SAME balance ` +
      `you swap — the chain reports it with 18 decimals and the token reports it with ${ARC_USDC.decimals}.`,
    featuredTokens,
    defaultPair: { from: ARC_USDC.address, to: ARC_ARCHITECTS.address },
  };
}

const BUILDERS: Record<number, () => ChainEntry> = {
  [RH_CHAIN.id]: rhEntry,
  [ARC_CHAIN.id]: arcEntry,
};

/**
 * Every chain the swap card can be pointed at, in switcher order, each with its OWN token set.
 *
 * Built from `SUPPORTED_CHAINS` rather than listed here, so a chain added to the one registry cannot
 * be silently missing from the card — it fails loudly with no builder instead.
 */
export async function getChains(): Promise<ChainEntry[]> {
  return SUPPORTED_CHAINS.filter((c) => BUILDERS[c.id]).map((c) => BUILDERS[c.id]());
}

/** The entry for `chainId` out of a loaded list, or undefined when the wallet is somewhere else. */
export function chainEntryFor(chains: ChainEntry[], chainId: number | undefined): ChainEntry | undefined {
  return chains.find((c) => c.id === chainId);
}

/**
 * The pair the card should show on `chain`.
 *
 * This is what a chain change resets to. Leaving the previous chain's tokens on screen is the
 * reported bug — the card kept saying "Robinhood Chain / ETH" while the switcher said Arc — and it is
 * worse than an empty card, because every number under it (balance, quote, decimals) then belongs to
 * a chain the user is not on.
 */
export function defaultPairFor(chain: ChainEntry): { from: string; to: string } {
  return chain.defaultPair;
}

export function getTokensForChain(chain: ChainEntry): TokenEntry[] {
  return (chain.featuredTokens || []).map((t) => ({
    id: t.address,
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    logoURI: t.metadata?.logoURI || t.logoURI,
    sourceChain: (t as any).sourceChain,
    displaySymbol: (t as any).displaySymbol,
    displaySubtitle: (t as any).displaySubtitle,
    originChainName: (t as any).originChainName,
    originSymbol: (t as any).originSymbol,
    bridgeable: (t as any).bridgeable,
    isStable: (t as any).isStable,
    gasBuffer: (t as any).gasBuffer,
  }));
}
