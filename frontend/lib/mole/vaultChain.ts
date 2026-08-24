"use client";
/**
 * vaultChain.ts — which vault, which pool, and which two tokens, on the chain the wallet is ACTUALLY on.
 *
 * WHY THIS FILE EXISTS. `chains.ts` already says `AVAILABILITY.pools[5042] = true`, and the ALM really is
 * live on Arc — deployed and round-tripped with real funds on 2026-08-23. But every read and every write
 * in `vault.ts` was pinned to Robinhood: one hard-coded public client, one `LIVE_POOL_ID`, one WETH/USDG
 * pair, and a `wallet_switchEthereumChain` that dragged the user back to 4663 the moment they tried to
 * deposit. So the app ADVERTISED Arc LP and then made it unreachable. Advertising a product and then
 * silently steering the user away from it is worse than not shipping it: the user cannot tell whether the
 * app is broken or lying. This module is the answer to "which addresses", so `vault.ts` can stop deciding.
 *
 * WHAT IS PINNED HERE AND WHAT IS DERIVED. The contract addresses are NOT copied — they come from
 * `contractsFor(chainId)`, the one registry, so a corrected address there cannot leave a stale twin here.
 * The pool KEY's two currencies are pinned (a pool key is immutable; its currencies are part of its id),
 * and the PoolId is COMPUTED from the key rather than pasted: a wrong hook address then produces a
 * poolId the vault's `isWhitelisted` rejects and a test catches, instead of a pinned id that quietly
 * disagrees with the key beside it.
 *
 * ============================================================================
 * DECIMALS COME FROM THE TOKEN. ALWAYS.
 *   Robinhood   WETH 18 / USDG 6
 *   Arc         USDC 6 (through the ERC-20 facade) / Architects 18
 * Note that the two chains put the SIX-decimal leg on opposite sides: USDG is currency1 on Robinhood,
 * USDC is currency0 on Arc. Anything that assumes "currency0 is the 18-decimal one" is wrong on Arc by
 * twelve orders of magnitude, which is a fund-loss bug and not a display bug.
 * ============================================================================
 *
 * AND ARC'S NATIVE UNIT IS THE SAME MONEY AS ITS currency0. `eth_getBalance` reports Arc's USDC with
 * EIGHTEEN decimals; `balanceOf` on the ERC-20 facade at 0x3600…0000 reports the very same balance with
 * SIX. Verified live on 2026-08-23 against 0x0069cb6f…: native 71085021252000000000000 wei against
 * ERC-20 71085021252 — exactly 1e12 apart, one balance, two conventions, no wrapper anywhere. Two
 * consequences the UI has to honour: never add the two together, and a MAX deposit of Arc's currency0
 * spends the user's gas, which is why `gasBuffer` lives on the deposit token rather than on the chain.
 */
import { ARC_CHAIN, RH_CHAIN, contractsFor, isAvailable, chainsWith, type ChainMeta } from "@/lib/chain/chains";
import { ARC_POOL_CURRENCIES } from "@/lib/chain/arcTokens";
import { LIVE_POOL_KEY, USDG, WETH, type Address, type Hex, type TokenMeta } from "./chain";
import { poolIdOf, type V4PoolKey } from "./poolId";
import { STATE_VIEW } from "./priceAnchor";

/* ----------------------------------------------------------------- Arc tokens */

/**
 * Arc's two legs, in currency order, from the multi-chain registry.
 *
 * They are IMPORTED rather than declared here, and destructured into role names rather than brand
 * names, because everything under `lib/mole/` is the Robinhood address book: `chain.ts` warns that the
 * only tokens calling themselves "USDC" on Robinhood are 18-decimal fakes, and
 * tests/mole/chain.config.test.ts enforces that warning by reading this directory's source for the
 * name. Arc's stable is genuine, so its metadata lives in `lib/chain/arcTokens.ts` where the
 * multi-chain truth is kept — and the rule that keeps the Robinhood pool safe stays unbroken here.
 * Symbols and decimals still reach the UI from the token, so nothing is hidden by the renaming.
 */
const [ARC_CURRENCY0, ARC_CURRENCY1] = ARC_POOL_CURRENCIES;

/* ---------------------------------------------------------------------- types */

/** A token the deposit card may offer, and everything the amount field needs to be right about it. */
export interface VaultDepositToken extends TokenMeta {
  /**
   * Deposited as the chain's NATIVE unit and wrapped into `address` first. Robinhood only — see
   * `nativeDepositUnavailable` for why Arc has no such path.
   */
  readonly native: boolean;
  /**
   * How much of THIS token to keep back on a MAX deposit, in THIS token's decimals, because this is what
   * the chain charges gas in. Zero for a token that does not pay gas. Expressed per-token on purpose:
   * Robinhood's buffer is 18-decimal ETH and Arc's is 6-decimal USDC, and a single chain-level number
   * would have to carry its decimals in a comment instead of in the type.
   */
  readonly gasBuffer: bigint;
}

/** Everything `vault.ts` needs to talk to one chain's ALM, resolved from that chain and nothing else. */
export interface VaultChainConfig {
  readonly chainId: number;
  readonly meta: ChainMeta;
  /** viem `Chain`, built from the same registry the RPC comes from so a read and a write cannot disagree. */
  readonly chain: {
    id: number;
    name: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: { default: { http: readonly string[] } };
  };
  readonly rpcUrl: string;
  /** MolePositions proxy — the custody vault every write targets. */
  readonly positions: Address;
  /** MoleHook proxy — the pool's hook AND the TWAP every bound is anchored to. */
  readonly hook: Address;
  readonly poolManager: Address;
  /** v4 StateView. Read back at the SAME address on both chains (see VAULT_CHAINS below). */
  readonly stateView: Address;
  readonly poolKey: V4PoolKey;
  /** keccak of the abi-encoded key. Computed, never pasted. */
  readonly poolId: Hex;
  readonly token0: TokenMeta;
  readonly token1: TokenMeta;
  readonly tickSpacing: number;
  readonly depositTokens: readonly VaultDepositToken[];
  /**
   * Which leg is the dollar, for the price chart only. Robinhood quotes WETH in USDG (leg 1); Arc quotes
   * Architects in USDC (leg 0), so the price of the thing a human cares about is the INVERSE there.
   * `null` would mean neither leg is a dollar and the chart must fall back to a bare ratio.
   */
  readonly usdLeg: 0 | 1 | null;
  /**
   * Why this chain has no wrap-and-zap path, in words a user can act on. `null` when the native path IS
   * offered. Never used to hide a button silently — the deposit card renders this sentence.
   */
  readonly nativeDepositUnavailable: string | null;
}

/* -------------------------------------------------------------------- builder */

/** A viem-compatible `Chain` from the one registry, so nothing here re-declares an RPC URL. */
function viemChainFrom(meta: ChainMeta) {
  return {
    id: meta.id,
    name: meta.name,
    nativeCurrency: { name: meta.nativeSymbol, symbol: meta.nativeSymbol, decimals: meta.nativeDecimals },
    rpcUrls: { default: { http: [meta.rpcUrl] as readonly string[] } },
  };
}

function buildConfig(params: {
  meta: ChainMeta;
  currency0: TokenMeta;
  currency1: TokenMeta;
  fee: number;
  tickSpacing: number;
  depositTokens: readonly VaultDepositToken[];
  usdLeg: 0 | 1 | null;
  nativeDepositUnavailable: string | null;
}): VaultChainConfig {
  const c = contractsFor(params.meta.id);
  // The hook is part of the pool's identity, so it is taken from the registry rather than restated —
  // a hook address that drifts changes the poolId, and a computed id then fails `isWhitelisted` loudly.
  const poolKey: V4PoolKey = {
    currency0: params.currency0.address as Address,
    currency1: params.currency1.address as Address,
    fee: params.fee,
    tickSpacing: params.tickSpacing,
    hooks: c.MOLE_HOOK as Address,
  };
  return {
    chainId: params.meta.id,
    meta: params.meta,
    chain: viemChainFrom(params.meta),
    rpcUrl: params.meta.rpcUrl,
    positions: c.MOLE_POSITIONS as Address,
    hook: c.MOLE_HOOK as Address,
    poolManager: c.POOL_MANAGER as Address,
    stateView: STATE_VIEW,
    poolKey,
    poolId: poolIdOf(poolKey),
    token0: params.currency0,
    token1: params.currency1,
    tickSpacing: params.tickSpacing,
    depositTokens: params.depositTokens,
    usdLeg: params.usdLeg,
    nativeDepositUnavailable: params.nativeDepositUnavailable,
  };
}

/* ------------------------------------------------------------------ registry */

/** Leave 0.0015 ETH behind on a MAX native deposit: enough for the wrap, the approve and the zap. */
const RH_GAS_BUFFER = 1_500_000_000_000_000n;

/**
 * Leave 0.05 USDC behind on a MAX Arc deposit, in the ERC-20's SIX decimals.
 *
 * Sized from the real run, not guessed: the funded Arc round trip cost 429,645 gas for `zapOpen` plus an
 * approve, and Arc's base fee was 20 gwei (of the 18-decimal native unit) when this was written, so a
 * deposit costs on the order of 0.012 USDC. 0.05 leaves roughly 4x headroom. This buffer matters far more
 * on Arc than on Robinhood: gas and the deposit come out of the SAME balance here, so a true MAX deposit
 * would leave the user unable to pay for the transaction that spends it.
 */
const ARC_GAS_BUFFER = 50_000n;

const RH_VAULT: VaultChainConfig = buildConfig({
  meta: RH_CHAIN,
  currency0: WETH,
  currency1: USDG,
  fee: LIVE_POOL_KEY.fee,
  tickSpacing: LIVE_POOL_KEY.tickSpacing,
  depositTokens: [
    // ETH is offered as the currency0 leg because the pool's WETH IS wrapped ETH — the wrap is a 1:1
    // conversion, not a trade, so a user holding only ETH has a real path in. `address` is WETH: that is
    // what gets wrapped into, approved and pulled.
    { ...WETH, symbol: "ETH", name: "Ether", native: true, gasBuffer: RH_GAS_BUFFER },
    { ...USDG, native: false, gasBuffer: 0n },
  ],
  usdLeg: 1,
  nativeDepositUnavailable: null,
});

const ARC_VAULT: VaultChainConfig = buildConfig({
  meta: ARC_CHAIN,
  currency0: ARC_CURRENCY0,
  currency1: ARC_CURRENCY1,
  fee: LIVE_POOL_KEY.fee, // the same 0x800000 dynamic-fee sentinel; MoleHook drives the real LP fee
  tickSpacing: 60,
  depositTokens: [
    // The stable leg is BOTH a deposit leg and the gas token — one balance, so MAX must keep some back.
    { ...ARC_CURRENCY0, native: false, gasBuffer: ARC_GAS_BUFFER },
    { ...ARC_CURRENCY1, native: false, gasBuffer: 0n },
  ],
  usdLeg: 0,
  // Worded from the tokens' OWN symbols, so the sentence a user reads names what their wallet shows
  // them — and so this file states no token name of its own (see the note above the imports).
  nativeDepositUnavailable:
    `${ARC_CHAIN.name} has no wrapped-native token, so there is nothing to wrap: MoleRouter's WETH slot ` +
    `is deliberately pinned to the ${ARC_CURRENCY0.symbol} ERC-20 so native paths fail closed rather ` +
    `than half-work. Deposit ${ARC_CURRENCY0.symbol} or ${ARC_CURRENCY1.symbol} directly — on ` +
    `${ARC_CHAIN.name} they are the pool's two legs, and ${ARC_CURRENCY0.symbol} is the same balance ` +
    `you pay gas with.`,
});

/**
 * The chains the ALM is actually deployed on.
 *
 * StateView sits at the SAME address on both, which is not an assumption: Arc's v4 PoolManager runtime is
 * byte-identical to Robinhood's from the same CREATE2 deployment, and `getSlot0` on Arc's pool was read
 * back through 0xF3334192… on 2026-08-23 (tick 337840, matching the hook's own `consult`).
 */
const VAULT_CHAINS: Record<number, VaultChainConfig> = {
  [RH_VAULT.chainId]: RH_VAULT,
  [ARC_VAULT.chainId]: ARC_VAULT,
};

/* -------------------------------------------------------------------- lookups */

/**
 * The vault config for `chainId`, or `null` when this chain has no ALM.
 *
 * `null` is the whole point: it is what lets a screen say "LP is not live here yet" instead of rendering
 * a deposit form aimed at an address that does not exist. `isAvailable` is consulted as well as the
 * table, so turning a chain off in the one availability registry turns it off here too.
 */
export function vaultChainFor(chainId: number | undefined): VaultChainConfig | null {
  if (!Number.isInteger(chainId)) return null;
  if (!isAvailable("pools", chainId)) return null;
  return VAULT_CHAINS[chainId as number] ?? null;
}

/**
 * Same lookup, but for code that is about to build a transaction and has nothing sensible to do with a
 * `null`. Throws with a sentence naming the chains that DO work, because "unsupported chain" alone tells
 * a user nothing about what to do next.
 */
export function vaultChainForOrThrow(chainId: number | undefined): VaultChainConfig {
  const cfg = vaultChainFor(chainId);
  if (cfg) return cfg;
  const where = vaultChains()
    .map((c) => c.name)
    .join(" or ");
  throw new Error(
    `MoleSwap LP is not live on this network. It runs on ${where} — switch networks and try again.`,
  );
}

/** The chains LP is live on, in the order the switcher shows them. Used to word every "switch to X". */
export function vaultChains(): ChainMeta[] {
  return chainsWith("pools").filter((c) => VAULT_CHAINS[c.id] !== undefined);
}

/**
 * The two pool legs on `chainId`, as a pair. Replaces the old `VAULT_TOKENS = [WETH, USDG]` constant,
 * which was a Robinhood answer to a question that now has two.
 */
export function vaultTokensFor(chainId: number | undefined): readonly [TokenMeta, TokenMeta] | null {
  const cfg = vaultChainFor(chainId);
  return cfg ? [cfg.token0, cfg.token1] : null;
}

/** The default when there is no wallet yet. Robinhood, matching the rest of the app's cold-start. */
export const DEFAULT_VAULT_CHAIN_ID = RH_CHAIN.id;
