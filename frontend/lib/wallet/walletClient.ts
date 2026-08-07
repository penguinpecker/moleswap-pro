import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  type WalletClient,
  type PublicClient,
  type Chain,
  type Address,
} from "viem";
import { mainnet, base, arbitrum, optimism, polygon, bsc } from "viem/chains";
import { formatUnits } from "viem";

const CHAIN_MAP: Record<number, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  137: polygon,
  56: bsc,
};

function getChain(chainId: number): Chain | undefined {
  return CHAIN_MAP[chainId];
}

export async function getWalletClient(chainId?: number): Promise<WalletClient | null> {
  if (typeof window === "undefined") return null;
  const chain = chainId ? getChain(chainId) : undefined;

  // Use injected provider (MetaMask etc.) or PushChain's provider
  if (window.ethereum) {
    try {
      return createWalletClient({
        chain: chain || undefined,
        transport: custom(window.ethereum),
      });
    } catch (e) {
      console.warn("Failed to create wallet client", e);
    }
  }
  return null;
}

function getRpcUrl(chainId: number): string | null {
  const rpcUrls: Record<number, string> = {
    1: "https://eth.llamarpc.com",
    8453: "https://base.llamarpc.com",
    42161: "https://arbitrum.llamarpc.com",
    10: "https://optimism.llamarpc.com",
    137: "https://polygon.llamarpc.com",
    56: "https://bsc.llamarpc.com",
    42101: "https://evm.donut.rpc.push.org/",
  };
  return rpcUrls[chainId] || null;
}

export async function getPublicClient(chainId?: number): Promise<PublicClient | null> {
  if (typeof window === "undefined") return null;
  const chain = chainId ? getChain(chainId) : undefined;

  if (chainId) {
    const rpcUrl = getRpcUrl(chainId);
    if (rpcUrl) {
      try {
        return createPublicClient({ chain, transport: http(rpcUrl) });
      } catch (e) {}
    }
  }

  if (window.ethereum) {
    try {
      return createPublicClient({ chain: chain || undefined, transport: custom(window.ethereum) });
    } catch (e) {}
  }

  return null;
}

const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
] as const;

export async function getTokenBalance(
  address: Address | string,
  tokenAddress: Address | string,
  chainId: number,
  decimals?: number,
  vmType?: string,
): Promise<string | null> {
  try {
    const client = await getPublicClient(chainId);
    if (!client) return null;

    const isNative =
      !tokenAddress ||
      tokenAddress === "0x0000000000000000000000000000000000000000";

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
