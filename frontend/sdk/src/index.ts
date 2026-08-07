/**
 * MoleSwap SDK
 * TypeScript SDK for integrating with MoleSwap DEX on PushChain
 *
 * Usage:
 *   import { MoleSwap } from "@moleswap/sdk";
 *   const mole = new MoleSwap();
 *   const quote = await mole.getQuote({ ... });
 *
 * Or with a custom base URL:
 *   const mole = new MoleSwap("https://your-deployment.vercel.app");
 */

// ═══ TYPES ═══

export interface MoleSwapConfig {
  baseUrl?: string;
  timeout?: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  sourceChain: string;
  logoURI: string;
  isNative?: boolean;
  isWrappedNative?: boolean;
}

export interface PoolInfo {
  address: string;
  name: string;
  fee: number;
  feeTier: string;
  token0: { address: string; symbol: string; name: string; decimals: number; poolBalance?: string };
  token1: { address: string; symbol: string; name: string; decimals: number; poolBalance?: string };
  sqrtPriceX96: string;
  tick: number;
  liquidity: string;
  hasLiquidity: boolean;
  price: number;
}

export interface QuoteResult {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  amountOutFormatted?: string;
  fee: number;
  feeTier?: string;
  pool?: string;
  type: "direct" | "multi_hop" | "wrap_unwrap";
  effectivePrice?: number;
  gasEstimate: string;
  route: string;
  hops?: { pool: string; fee: number }[];
}

export interface TransactionStep {
  to: string;
  value: string;
  data: string;
  description: string;
  note?: string;
}

export interface TxBuildResult {
  type: string;
  description: string;
  pool?: string | null;
  transactions: TransactionStep[];
  chainId: number;
  rpc: string;
  note?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  timestamp: number;
  error?: string;
}

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fee?: number;
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin?: string;
  recipient: string;
  fee?: number;
  slippageBps?: number;
  deadline?: number;
}

export interface CreatePoolParams {
  tokenA: string;
  tokenB: string;
  fee?: number;
  initialPrice?: number;
  amount0Desired?: string;
  amount1Desired?: string;
  recipient: string;
  tickLower?: number;
  tickUpper?: number;
  slippageBps?: number;
  deadline?: number;
}

export interface AddLiquidityParams {
  token0: string;
  token1: string;
  fee?: number;
  amount0Desired: string;
  amount1Desired: string;
  recipient: string;
  tickLower?: number;
  tickUpper?: number;
  slippageBps?: number;
  deadline?: number;
}

// ═══ CONSTANTS ═══

export const CONTRACTS = {
  FACTORY: "0x81b8Bca02580C7d6b636051FDb7baAC436bFb454",
  SWAP_ROUTER: "0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037",
  QUOTER_V2: "0x83316275f7C2F79BC4E26f089333e88E89093037",
  POSITION_MANAGER: "0xf9b3ac66aed14A2C7D9AA7696841aB6B27a6231e",
  WPC: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9",
} as const;

export const PUSHCHAIN_RPC = "https://evm.donut.rpc.push.org/";
export const PUSHCHAIN_CHAIN_ID = 2442;
export const PUSHCHAIN_EXPLORER = "https://donut.push.network";

// ═══ SDK CLASS ═══

export class MoleSwap {
  private baseUrl: string;
  private timeout: number;

  constructor(config?: string | MoleSwapConfig) {
    if (typeof config === "string") {
      this.baseUrl = config.replace(/\/$/, "");
      this.timeout = 30000;
    } else {
      this.baseUrl = config?.baseUrl?.replace(/\/$/, "") || "https://moleswap-eight.vercel.app";
      this.timeout = config?.timeout || 30000;
    }
  }

  // ═══ INTERNAL FETCH ═══

  private async request<T>(
    path: string,
    options?: { method?: string; body?: any }
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method: options?.method || "GET",
        headers: options?.body ? { "Content-Type": "application/json" } : undefined,
        body: options?.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const json: ApiResponse<T> = await res.json();

      if (!json.success) {
        throw new MoleSwapError(
          (json as any).error || "API request failed",
          res.status
        );
      }

      return json.data;
    } catch (err: any) {
      if (err instanceof MoleSwapError) throw err;
      if (err.name === "AbortError") {
        throw new MoleSwapError("Request timeout", 408);
      }
      throw new MoleSwapError(err.message || "Network error", 0);
    } finally {
      clearTimeout(timer);
    }
  }

  // ═══ READ ENDPOINTS ═══

  async getTokens(filters?: { chain?: string; search?: string }): Promise<{
    count: number;
    tokens: TokenInfo[];
    contracts: typeof CONTRACTS;
  }> {
    const params = new URLSearchParams();
    if (filters?.chain) params.set("chain", filters.chain);
    if (filters?.search) params.set("search", filters.search);
    const qs = params.toString();
    return this.request(`/tokens${qs ? `?${qs}` : ""}`);
  }

  async getPools(includeEmpty = false): Promise<{
    count: number;
    chainId: number;
    rpc: string;
    pools: PoolInfo[];
  }> {
    return this.request(`/pools${includeEmpty ? "?includeEmpty=true" : ""}`);
  }

  async getPool(address: string): Promise<PoolInfo & { explorer: string }> {
    return this.request(`/pool/${address}`);
  }

  async getQuote(params: QuoteParams): Promise<QuoteResult> {
    const qs = new URLSearchParams({
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
    });
    if (params.fee) qs.set("fee", params.fee.toString());
    return this.request(`/quote?${qs.toString()}`);
  }

  // ═══ TX BUILDER ENDPOINTS ═══

  async buildSwapTx(params: SwapParams): Promise<TxBuildResult> {
    return this.request("/tx/swap", { method: "POST", body: params });
  }

  async buildCreatePoolTx(params: CreatePoolParams): Promise<TxBuildResult> {
    return this.request("/tx/create-pool", { method: "POST", body: params });
  }

  async buildAddLiquidityTx(params: AddLiquidityParams): Promise<TxBuildResult> {
    return this.request("/tx/add-liquidity", { method: "POST", body: params });
  }

  // ═══ HELPERS ═══

  getExplorerUrl(txHash: string): string {
    return `${PUSHCHAIN_EXPLORER}/tx/${txHash}`;
  }

  getAddressUrl(address: string): string {
    return `${PUSHCHAIN_EXPLORER}/address/${address}`;
  }
}

// ═══ ERROR CLASS ═══

export class MoleSwapError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "MoleSwapError";
    this.status = status;
  }
}

// ═══ DEFAULT EXPORT ═══

export default MoleSwap;
