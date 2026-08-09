import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  formatUnits,
  type WalletClient,
  type PublicClient,
  type Chain,
  type Address,
} from "viem";
import { robinhoodChain } from "@/lib/pushchain/wagmi-config";

/**
 * Wallet/public client helpers — Robinhood Chain (4663) only.
 *
 * Same export surface as before (getWalletClient / getPublicClient / getTokenBalance), retargeted to
 * the single chain MoleSwap runs on. Balances for the exchange UI come from here.
 */
const RH_ID = robinhoodChain.id;
const RH_RPC =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) ||
  "https://rpc.mainnet.chain.robinhood.com";

const CHAIN_MAP: Record<number, Chain> = {
  [RH_ID]: robinhoodChain,
};

function getChain(chainId?: number): Chain {
  return (chainId && CHAIN_MAP[chainId]) || robinhoodChain;
}

export async function getWalletClient(chainId?: number): Promise<WalletClient | null> {
  if (typeof window === "undefined" || !window.ethereum) return null;
  try {
    return createWalletClient({ chain: getChain(chainId), transport: custom(window.ethereum) });
  } catch (e) {
    console.warn("Failed to create wallet client", e);
    return null;
  }
}

export async function getPublicClient(chainId?: number): Promise<PublicClient | null> {
  try {
    return createPublicClient({ chain: getChain(chainId), transport: http(RH_RPC) });
  } catch {
    if (typeof window !== "undefined" && window.ethereum) {
      try {
        return createPublicClient({ chain: getChain(chainId), transport: custom(window.ethereum) });
      } catch {}
    }
    return null;
  }
}

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
] as const;

export async function getTokenBalance(
  address: Address | string,
  tokenAddress: Address | string,
  chainId?: number,
  decimals?: number,
  _vmType?: string,
): Promise<string | null> {
  try {
    const client = await getPublicClient(chainId ?? RH_ID);
    if (!client) return null;

    const isNative =
      !tokenAddress ||
      tokenAddress === "0x0000000000000000000000000000000000000000" ||
      String(tokenAddress).toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

    let balance: bigint;
    if (isNative) {
      balance = await client.getBalance({ address: address as Address });
    } else {
      balance = (await client.readContract({
        address: tokenAddress as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address as Address],
      })) as bigint;
    }

    return formatUnits(balance, decimals ?? 18);
  } catch (error) {
    console.error("Error in getTokenBalance:", error);
    return null;
  }
}

declare global {
  interface Window {
    ethereum?: any;
  }
}
