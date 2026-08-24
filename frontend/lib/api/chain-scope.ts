/**
 * chain-scope.ts — how a request to the public API picks its chain.
 *
 * WHY THIS FILE EXISTS. Every route under `app/api/v1/` used to resolve its addresses from
 * `lib/chain/contracts.ts`, which is the flat ROBINHOOD-ONLY registry. That was fine while MoleSwap
 * ran on one chain. It stopped being fine the day the router and the ALM went live on Arc: a public
 * endpoint that answers confidently with Robinhood's router address, Robinhood's WETH and Robinhood's
 * prices while the caller believes they asked about Arc is not a missing feature, it is a fund-loss
 * bug with a 200 status code. So every route now names its chain, and every address it hands back
 * comes from `contractsFor(chainId)`.
 *
 * THE DEFAULT IS ROBINHOOD, AND STAYS ROBINHOOD. This is a public API with integrators already
 * calling it; silently re-pointing an existing caller at a different chain would be worse than the
 * gap this file closes. Omitting the parameter therefore means 4663, exactly as before.
 *
 * AN UNKNOWN CHAIN IS REFUSED, NEVER ABSORBED. `contractsFor()` deliberately falls back to Robinhood
 * for an unknown id — that is the right behaviour for internal callers who have already validated the
 * id, and the wrong behaviour at the edge of a public API. Resolution happens HERE, before any
 * address is looked up, so an unrecognised chain becomes a 400 rather than a Robinhood answer wearing
 * someone else's label.
 *
 * WHAT LIVES HERE THAT DOES NOT LIVE IN chains.ts. `chains.ts` is the address + availability registry.
 * The API additionally needs to know, per chain, which token universe it publishes, which single v4
 * pool its ALM runs, and which of its dependencies are chain-aware at all. Those are recorded below.
 * When a canonical multi-chain token/pool registry lands in `lib/chain/`, this module should read from
 * it instead of pinning its own copies — the pins are marked so they are easy to find.
 */
import {
  RH_CHAIN,
  ARC_CHAIN,
  SUPPORTED_CHAINS,
  chainMetaFor,
  contractsFor,
  isAvailable,
  chainsWith,
  type ChainMeta,
  type ChainContracts,
  type ProductKey,
} from "@/lib/chain/chains";
import {
  CONTRACTS,
  TOKENS as RH_TOKENS,
  RH_PUBLIC_RPC_URL,
  type TokenInfo,
} from "@/lib/chain/contracts";
import {
  LIVE_POOL_KEY,
  LIVE_POOL_ID,
  DYNAMIC_FEE_FLAG,
  WETH as RH_WETH,
  USDG as RH_USDG,
  type Address,
  type TokenMeta,
} from "@/lib/mole/chain";

/** Omitting the chain parameter means this. Never change it — see the header. */
export const DEFAULT_API_CHAIN_ID = RH_CHAIN.id;

/* ───────────────────────────── the Arc token universe ───────────────────────────── */

/**
 * ARC PAYS GAS IN USDC, AND THE SAME BALANCE HAS TWO DECIMAL COUNTS.
 *
 * The NATIVE unit (eth_getBalance, msg.value, gas) is 18-decimal; the ERC-20 view of that very same
 * balance at 0x3600…0000 is SIX-decimal. There is no wrapper and no conversion contract between them
 * — they are two windows onto one number. The pool's currency is the ERC-20 view, so THIS is the
 * decimals count every amount in a pool response is denominated in.
 *
 * Verified on chain 5042: `decimals()` → 6, `symbol()` → "USDC".
 */
export const ARC_USDC: TokenMeta = {
  address: "0x3600000000000000000000000000000000000000",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
};

/** Architects — the non-stable leg of Arc's first MoleSwap pool. 18 decimals, read from chain. */
export const ARC_ARCHITECTS: TokenMeta = {
  address: "0x8bcb94279FC2c984EC34e0C1f2192df8c69EA4F0",
  symbol: "Architects",
  name: "Architects",
  decimals: 18,
};

/**
 * Arc's published token universe.
 *
 * THERE IS NO NATIVE SENTINEL ENTRY, AND THAT IS DELIBERATE. Listing 0x0 as a swappable token invites
 * a caller to build a transfer to the zero address, which REVERTS on Arc, and there is no WETH to
 * wrap into either — the router's `weth` slot is pinned to the USDC ERC-20 precisely so every
 * native-ETH path fails closed instead of half-working. Callers spend Arc's gas token by using the
 * ERC-20 view above; the scope's `nativeCurrency` block is what tells them the two views are one balance.
 */
const ARC_TOKENS: TokenInfo[] = [
  {
    address: ARC_USDC.address,
    symbol: ARC_USDC.symbol,
    name: ARC_USDC.name,
    decimals: ARC_USDC.decimals,
    sourceChain: ARC_CHAIN.name,
    logoURI: "",
    swappable: true,
    isStable: true,
    displaySymbol: "USDC",
    displaySubtitle: "Arc gas token (ERC-20 view)",
  } as TokenInfo,
  {
    address: ARC_ARCHITECTS.address,
    symbol: ARC_ARCHITECTS.symbol,
    name: ARC_ARCHITECTS.name,
    decimals: ARC_ARCHITECTS.decimals,
    sourceChain: ARC_CHAIN.name,
    logoURI: "",
    swappable: true,
    displaySymbol: "Architects",
    displaySubtitle: "on Arc",
  } as TokenInfo,
];

/* ─────────────────────────────── the ALM's pool, per chain ─────────────────────────────── */

/** A v4 pool key plus the id it hashes to. The id is the pool's real identity; a key is immutable. */
export interface VaultPool {
  /**
   * The five fields, in the 0x-template address type the v4 encoders demand. `chains.ts` keeps its
   * addresses as plain strings because it is read by prose and by ethers alike; a PoolKey, by
   * contrast, is fed straight into viem's abi encoder as `open`'s first argument, and a plain
   * `string` there is not assignable to what the shared one-sided math (PoolKeyLike) accepts.
   */
  key: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  };
  id: string;
  /** Currency-order metadata. ALWAYS read decimals from here — never assume 18. */
  meta0: TokenMeta;
  meta1: TokenMeta;
  /** Which leg is the dollar, PINNED by address. Symbol lookup is banned on both chains — Robinhood
   *  has two 18-decimal impostors named "USDC", and a stable leg identified wrong misprices the pool. */
  stable: TokenMeta;
  /** How the pair is named in prose and refusals, e.g. "WETH/USDG". */
  label: string;
}

const RH_VAULT_POOL: VaultPool = {
  key: {
    currency0: LIVE_POOL_KEY.currency0,
    currency1: LIVE_POOL_KEY.currency1,
    fee: LIVE_POOL_KEY.fee,
    tickSpacing: LIVE_POOL_KEY.tickSpacing,
    hooks: LIVE_POOL_KEY.hooks,
  },
  id: LIVE_POOL_ID,
  meta0: RH_WETH,
  meta1: RH_USDG,
  stable: RH_USDG,
  label: `${RH_WETH.symbol}/${RH_USDG.symbol}`,
};

/**
 * Arc's first MoleSwap pool — USDC/Architects, opened at the live market price on 2026-08-23 and
 * proven with a real-fund open/withdraw round trip the same day (records.txt).
 *
 * The key below is not copied from a note: `keccak256(abi.encode(key))` was recomputed against the
 * deployed hook and both currencies and equals the id verbatim, so these five fields ARE the pool's
 * on-chain identity rather than a cache that can drift. Same discipline as the aggregator's
 * degraded-mode rows.
 */
const ARC_VAULT_POOL: VaultPool = {
  key: {
    currency0: ARC_USDC.address,
    currency1: ARC_ARCHITECTS.address,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: 60,
    // Cast, not a re-typing of chains.ts: the hook's low 14 bits are mined (0x38C4) and the address is
    // checksummed there verbatim, so the only thing missing is the 0x-template shape.
    hooks: contractsFor(ARC_CHAIN.id).MOLE_HOOK as Address,
  },
  id: "0x180a035b0d60290514969d7c9dc169cad5fad5c423295848130be25e82f31796",
  meta0: ARC_USDC,
  meta1: ARC_ARCHITECTS,
  stable: ARC_USDC,
  label: `${ARC_USDC.symbol}/${ARC_ARCHITECTS.symbol}`,
};

/* ─────────────────────────────────────── the scope ─────────────────────────────────────── */

export interface NativeCurrency {
  symbol: string;
  /** Decimals of the NATIVE unit — what eth_getBalance and msg.value are denominated in. */
  decimals: number;
  /** Wrapped native, or null where the chain has none. */
  wrapped: string | null;
  /** The ERC-20 that is the same balance under a different decimal count, where one exists. */
  erc20: string | null;
  erc20Decimals: number | null;
  note?: string;
}

export interface ApiChainScope {
  chainId: number;
  meta: ChainMeta;
  contracts: ChainContracts;
  /** Server-side RPC. May carry a provider key — NEVER echo this back to a caller. */
  rpcUrl: string;
  /** The public endpoint, safe to hand to anyone. This is what responses report. */
  publicRpcUrl: string;
  explorerUrl: string;
  /** The token universe this chain publishes. */
  tokens: TokenInfo[];
  nativeCurrency: NativeCurrency;
  /** Wrapped native, or null where the chain has none (Arc). Never the zero address: a caller who
   *  reads 0x000…0 as an address will build a transfer to it, and Arc reverts those. */
  wrappedNative: string | null;
  /** The v3-style factory `tx/create-pool` drives, or null where none is deployed. */
  v3Factory: string | null;
  /** MoleQueue, or null where the batch auction was deliberately not deployed. */
  queue: string | null;
  /** The single v4 pool this chain's ALM runs, or null where the vault is not deployed. */
  vaultPool: VaultPool | null;
  /**
   * Whether the OFF-CHAIN quoting engine can price this chain.
   *
   * This is not the same question as `isAvailable("swap", chainId)`. MoleRouter is live on Arc and
   * has moved real money there — swapping works in the app. What is Robinhood-only is
   * `lib/aggregator/serverPools.ts`: it reads `mp_pools` (every row of which carries chain_id 4663),
   * falls back to a hard-coded set of Robinhood v4 pools, and discovers v3 venues through the
   * PancakeSwap factory, which exists on Robinhood alone. Pointing that engine at Arc addresses does
   * not fail — it prices them against ROBINHOOD liquidity and returns a confident, wrong number. So
   * quote/tx-swap refuse out loud on a chain the engine cannot see, and this flag flips the day the
   * registry and the discovery path learn about chain ids.
   */
  quotable: boolean;
}

const RH_SCOPE = (): ApiChainScope => ({
  chainId: RH_CHAIN.id,
  meta: RH_CHAIN,
  contracts: contractsFor(RH_CHAIN.id),
  rpcUrl: RH_CHAIN.rpcUrl,
  publicRpcUrl: RH_PUBLIC_RPC_URL,
  explorerUrl: RH_CHAIN.explorerUrl,
  tokens: RH_TOKENS,
  nativeCurrency: {
    symbol: "ETH",
    decimals: 18,
    wrapped: CONTRACTS.WETH,
    erc20: null,
    erc20Decimals: null,
  },
  wrappedNative: CONTRACTS.WETH,
  v3Factory: CONTRACTS.FACTORY,
  queue: CONTRACTS.MOLE_QUEUE,
  vaultPool: RH_VAULT_POOL,
  quotable: true,
});

const ARC_SCOPE = (): ApiChainScope => ({
  chainId: ARC_CHAIN.id,
  meta: ARC_CHAIN,
  contracts: contractsFor(ARC_CHAIN.id),
  rpcUrl: ARC_CHAIN.rpcUrl,
  // Our own proxy IS the public Arc endpoint — rpc.arc-scan.org is the only keyless upstream and it
  // times out often enough that handing it out directly would be handing out an outage.
  publicRpcUrl: "https://www.moleswap.com/rpc/v1/arc",
  explorerUrl: ARC_CHAIN.explorerUrl,
  tokens: ARC_TOKENS,
  nativeCurrency: {
    symbol: "USDC",
    // 18, and it must stay 18: this is what a wallet divides eth_getBalance by. The SAME balance read
    // through the ERC-20 below is 6-decimal. One balance, two conventions, no wrapper between them.
    decimals: 18,
    wrapped: null,
    erc20: ARC_USDC.address,
    erc20Decimals: ARC_USDC.decimals,
    note:
      "Arc pays gas in USDC. The native unit is 18-decimal; the ERC-20 view of the same balance at " +
      `${ARC_USDC.address} is 6-decimal. They are one balance, not a token and its wrapper — there is ` +
      "nothing to wrap or unwrap, and there is no WETH on this chain.",
  },
  wrappedNative: null,
  // PancakeSwap's factory is a Robinhood deployment. Arc has the Uniswap v4 singleton and StateView
  // but no v3 factory of ours and no Uniswap periphery at all — do not infer one from the singleton.
  v3Factory: null,
  // No MoleQueue on Arc, and not for want of effort: the batch auction is bound to one pool key
  // forever and there is no second venue on Arc to make crossing worth the epoch latency.
  queue: null,
  vaultPool: ARC_VAULT_POOL,
  quotable: false,
});

const SCOPES: Record<number, () => ApiChainScope> = {
  [RH_CHAIN.id]: RH_SCOPE,
  [ARC_CHAIN.id]: ARC_SCOPE,
};

/* ────────────────────────────────────── resolution ────────────────────────────────────── */

export type ChainResolution =
  | { ok: true; scope: ApiChainScope }
  | { ok: false; error: string };

const supportedList = () =>
  SUPPORTED_CHAINS.map((c) => `${c.name} (chainId ${c.id})`).join(" and ");

/**
 * Turn whatever the caller wrote into a scope, or into a refusal.
 *
 * Accepts a decimal id, a 0x-prefixed hex id (that is how a wallet spells it), the registry key
 * ("rh" / "arc"), or the chain's name. `chain=Robinhood Chain` is accepted because that is what the
 * pre-multichain /v1/tokens filter took, and an integrator who wrote it still means 4663.
 */
export function resolveApiChain(raw: string | number | null | undefined): ChainResolution {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, scope: SCOPES[DEFAULT_API_CHAIN_ID]() };
  }

  const text = String(raw).trim();
  let id: number | undefined;

  if (/^-?\d+$/.test(text)) id = Number(text);
  else if (/^0x[0-9a-f]+$/i.test(text)) id = Number.parseInt(text, 16);
  else {
    const needle = text.toLowerCase();
    id = SUPPORTED_CHAINS.find(
      (c) =>
        c.key === needle ||
        c.name.toLowerCase() === needle ||
        c.shortName.toLowerCase() === needle,
    )?.id;
  }

  const meta = id === undefined ? undefined : chainMetaFor(id);
  if (!meta || !SCOPES[meta.id]) {
    return {
      ok: false,
      error:
        `Unsupported chain "${text}". This API serves ${supportedList()}. Pass ` +
        `chainId=${RH_CHAIN.id} or chainId=${ARC_CHAIN.id}; omitting it means ${DEFAULT_API_CHAIN_ID} ` +
        `(${RH_CHAIN.name}). The request was refused rather than answered for ${RH_CHAIN.name}, ` +
        "because an answer carrying another chain's addresses and prices is worse than no answer.",
    };
  }
  return { ok: true, scope: SCOPES[meta.id]() };
}

/** Read the chain out of a GET request's query string. `chainId` wins; `chain` is the older spelling. */
export function chainParamFrom(params: URLSearchParams): string | null {
  return params.get("chainId") ?? params.get("chain");
}

/** Read the chain out of a POST body. Same precedence as the query-string form. */
export function chainFieldFrom(body: any): string | number | null {
  if (!body || typeof body !== "object") return null;
  return body.chainId ?? body.chain ?? null;
}

/* ───────────────────────────────────── availability ───────────────────────────────────── */

const PRODUCT_LABEL: Record<ProductKey, string> = {
  swap: "Swapping",
  pools: "LP pools",
  lending: "The lending market",
};

/**
 * Why a product cannot be served on this chain, or null when it can.
 *
 * `isAvailable()` in chains.ts is the source of truth — the string below only explains it. Saying
 * "not on this chain" and naming the chains that DO have it is the whole point: a caller who gets a
 * flat 404 has no way to tell a wrong address from a wrong chain.
 */
export function productUnavailable(scope: ApiChainScope, product: ProductKey): string | null {
  if (isAvailable(product, scope.chainId)) return null;
  const live = chainsWith(product);
  return (
    `${PRODUCT_LABEL[product]} is not live on ${scope.meta.name} (chainId ${scope.chainId}). ` +
    (live.length
      ? `It runs on ${live.map((c) => `${c.name} (chainId ${c.id})`).join(", ")}.`
      : "It is not deployed on any chain yet.")
  );
}

/** Why the vault cannot be reached on this chain, or null when it can. */
export function vaultUnavailable(scope: ApiChainScope): string | null {
  const product = productUnavailable(scope, "pools");
  if (product) return product;
  if (!scope.vaultPool) {
    return `The MoleSwap vault runs no pool on ${scope.meta.name} (chainId ${scope.chainId}).`;
  }
  return null;
}

/** Why the batch auction cannot be reached on this chain, or null when it can. */
export function queueUnavailable(scope: ApiChainScope): string | null {
  if (scope.queue) return null;
  const on = SUPPORTED_CHAINS.filter((c) => SCOPES[c.id]?.().queue);
  return (
    `MoleQueue (the batch auction) is not deployed on ${scope.meta.name} (chainId ${scope.chainId}). ` +
    (on.length
      ? `It runs on ${on.map((c) => `${c.name} (chainId ${c.id})`).join(", ")} only.`
      : "It is not deployed on any chain.")
  );
}

/** Why the off-chain router cannot price this chain, or null when it can. See `quotable`. */
export function quotingUnavailable(scope: ApiChainScope): string | null {
  if (scope.quotable) return null;
  return (
    `Quoting is not served for ${scope.meta.name} (chainId ${scope.chainId}) yet. MoleRouter IS live ` +
    `there (${scope.contracts.MOLE_ROUTER}) and the app can swap on it, but this API's pricing engine ` +
    `reads a pool registry that only indexes ${RH_CHAIN.name} — it would price ${scope.meta.name} ` +
    `addresses against ${RH_CHAIN.name} liquidity and return a confident, wrong number. Refusing is ` +
    "the safe answer until the registry carries chain ids."
  );
}

/** Look a token up inside one chain's universe. By ADDRESS — never by symbol, on any chain. */
export function tokenIn(scope: ApiChainScope, address: string): TokenInfo | undefined {
  const needle = address.toLowerCase();
  return scope.tokens.find((t) => t.address.toLowerCase() === needle);
}

/**
 * The contract block the public API publishes for a chain.
 *
 * Robinhood's shape is byte-for-byte what it was before this file existed, because integrators read
 * these keys. Where a chain genuinely has no such contract the value is `null`, never the zero
 * address: 0x000…0 reads as an address a caller can send to, and on Arc a transfer to it reverts.
 */
export function publicContracts(scope: ApiChainScope) {
  const c = scope.contracts;
  const positions = scope.vaultPool ? c.MOLE_POSITIONS : null;
  return {
    chainId: scope.chainId,
    factory: scope.v3Factory,
    swapRouter: c.MOLE_ROUTER,
    quoterV2: scope.chainId === RH_CHAIN.id ? CONTRACTS.QUOTER_V2 : null,
    positionManager: positions,
    weth: scope.wrappedNative,
    moleswapFeeRouter: c.MOLE_ROUTER,
    moleswapLiquidityProxy: positions,
    moleHook: scope.vaultPool ? c.MOLE_HOOK : null,
    molePositions: positions,
    poolManager: c.POOL_MANAGER,
    moleFeeDial: c.MOLE_FEE_DIAL,
    moleQueue: scope.queue,
  };
}
