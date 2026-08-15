/**
 * arc-chain.ts — Arc mainnet (5042) as MoleSwap publishes it.
 *
 * Single source of truth for the values a wallet needs to add Arc. The GET descriptor
 * at /rpc/v1/arc and the chain-ID pin that guards the proxy both read from here, so the
 * id we advertise and the id we enforce can never disagree.
 *
 * ============================================================================
 * !!!  ARC'S NATIVE GAS TOKEN IS USDC, AND IT HAS 18 DECIMALS.  !!!
 *
 * The ERC-20 interface to the SAME balance (0x3600…0000) reports SIX decimals.
 * Native (eth_getBalance / msg.value / gas) is 18-decimal; the ERC-20 facade is
 * 6-decimal. Both views spend one underlying balance — there is no wrapping.
 *
 * `nativeCurrency.decimals` below MUST stay 18: it is what MetaMask divides
 * eth_getBalance by to render a balance. Setting it to 6 would inflate every
 * displayed balance by 1e12.
 * ============================================================================
 */

export const ARC_CHAIN_ID = 5042;

/** The same id as MetaMask sends it. Kept beside the decimal so neither drifts. */
export const ARC_CHAIN_ID_HEX = "0x13b2";

/** Arc's native gas token. See the decimals warning above. */
export const ARC_NATIVE_CURRENCY = {
  name: "USD Coin",
  symbol: "USDC",
  decimals: 18,
} as const;

/**
 * The USDC ERC-20 system contract — the SIX-decimal facade over the native balance.
 * Not used by the proxy; recorded here because the two decimal counts belong together.
 */
export const ARC_USDC_ERC20 = "0x3600000000000000000000000000000000000000";

/**
 * The public URL users paste into their wallet. Derived from the site origin so a
 * preview deployment advertises itself, not production.
 */
export function arcRpcUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/rpc/v1/arc`;
}

/**
 * Block explorers, reported by the GET descriptor.
 *
 * DELIBERATELY EMPTY. Circle ships no public Arc mainnet explorer — arc.network
 * redirects to the corporate site, explorer.arc.network does not resolve, and the
 * explorers that do exist are anonymously-registered third parties. Advertising an
 * unvetted one would put MoleSwap's name behind a site we do not control. Set
 * ARC_BLOCK_EXPLORER once an official one exists.
 */
export const ARC_BLOCK_EXPLORERS: readonly string[] = process.env.ARC_BLOCK_EXPLORER
  ? [process.env.ARC_BLOCK_EXPLORER]
  : [];
