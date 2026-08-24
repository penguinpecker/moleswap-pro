/**
 * arcTokens.ts — the two tokens of Arc's live MoleSwap pool, read back from chain 5042.
 *
 * WHY THESE LIVE HERE AND NOT IN lib/mole/. `lib/mole/chain.ts` is the ROBINHOOD address book, and it
 * carries a standing rule that `tests/mole/chain.config.test.ts` enforces by reading the source: no
 * executable line under `lib/mole/` may name USDC. That is not pedantry — Robinhood Chain has no
 * canonical USDC, both explorer entries by that name are 18-decimal fakes, and the stable leg of the
 * Robinhood pool is USDG at SIX decimals. A module that names a "USDC" in that neighbourhood is one
 * careless import away from a 1e12 mispricing.
 *
 * Arc's USDC is real, so its metadata belongs where the MULTI-CHAIN registry lives — next to
 * `chains.ts`, which already declares it as Arc's gas symbol — rather than inside the Robinhood
 * address book where the name is a trap. `lib/api/chain-scope.ts` predicted exactly this file
 * ("when a canonical multi-chain token registry lands in lib/chain/, this module should read from it
 * instead of pinning its own copies"); the API's own pins are still there and should collapse into
 * these when that lane next touches them.
 *
 * NOTHING HERE IS ASSUMED. Every field below was read from the live contracts on 2026-08-24 through
 * https://www.moleswap.com/rpc/v1/arc:
 *   0x3600…0000  symbol() "USDC"        name() "USDC"        decimals() 6
 *   0x8bcb9427…  symbol() "Architects"  name() "Architects"  decimals() 18
 * The stable's `name()` is "USDC", not "USD Coin" — a UI that prints a nicer name than the token's own
 * teaches the user to trust a row their wallet will label differently.
 *
 * ============================================================================
 * ARC'S GAS TOKEN AND THIS ERC-20 ARE ONE BALANCE WITH TWO DECIMAL COUNTS.
 * `eth_getBalance` reports it with EIGHTEEN decimals; `balanceOf` on the facade below reports the very
 * same money with SIX. There is no wrapper and no conversion contract between them — verified live on
 * 2026-08-23: native 71085021252000000000000 against ERC-20 71085021252, exactly 1e12 apart. Never sum
 * the two, and never convert one into the other by pretending a wrapper exists.
 * ============================================================================
 */
import type { TokenMeta } from "@/lib/mole/chain";

/**
 * The SIX-decimal ERC-20 view of Arc's gas balance, at the system contract.
 *
 * This is the only view the pool and the vault ever see: `zapOpen` pulls with `transferFrom`, so a
 * deposit is always an ERC-20 amount in these 6 decimals even though the identical balance is
 * 18-decimal when the chain charges gas against it.
 */
export const ARC_USDC: TokenMeta = {
  address: "0x3600000000000000000000000000000000000000",
  symbol: "USDC",
  name: "USDC",
  decimals: 6,
};

/** Architects — 18 decimals, the volatile leg of Arc's first MoleSwap pool. Name verbatim from chain. */
export const ARC_ARCHITECTS: TokenMeta = {
  address: "0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0",
  symbol: "Architects",
  name: "Architects",
  decimals: 18,
};

/**
 * The pool's two legs in v4 CURRENCY ORDER (currency0 < currency1 by address), which is the order the
 * PoolKey — and therefore the PoolId — is built from.
 *
 * Consumers that must not name the stable in executable code destructure this pair instead of
 * importing the constants above; `lib/mole/vaultChain.ts` is the reason it exists. The ordering is not
 * a convention to be re-derived at each call site: get it backwards and every amount lands on the
 * wrong leg, with the 6/18 decimal gap turning that into a 1e12 error rather than a swapped label.
 */
export const ARC_POOL_CURRENCIES: readonly [TokenMeta, TokenMeta] = [ARC_USDC, ARC_ARCHITECTS];
