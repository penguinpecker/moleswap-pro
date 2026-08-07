import { createPublicClient, http, custom, type Address, formatUnits } from "viem";
import { 
  mainnet, base, arbitrum, optimism, polygon, bsc,
  sepolia, baseSepolia, arbitrumSepolia, optimismSepolia, polygonAmoy, bscTestnet
} from "viem/chains";
import type { WalletAdapter } from "./types";
import { getWalletConnectProvider } from "../walletconnect/provider";
import type { Chain } from "viem";

// Chain ID to viem Chain mapping (mainnet and testnet)
const CHAIN_MAP: Record<number, Chain> = {
  // Mainnets
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  137: polygon,
  56: bsc,
  // Testnets
  11155111: sepolia, // Ethereum Sepolia
  84532: baseSepolia, // Base Sepolia
  421614: arbitrumSepolia, // Arbitrum Sepolia
  11155420: optimismSepolia, // Optimism Sepolia
  80002: polygonAmoy, // Polygon Amoy (new testnet)
  97: bscTestnet, // BSC Testnet
};

/**
 * Gets RPC URLs for a chain ID (public RPC endpoints with fallbacks)
 * Supports both mainnet and testnet chains
 */
function getRpcUrls(chainId: number): string[] {
  const rpcUrlMap: Record<number, string[]> = {
    // Mainnets
    1: [
      "https://eth.llamarpc.com",
      "https://rpc.ankr.com/eth",
      "https://ethereum.publicnode.com",
      "https://eth.drpc.org",
    ],
    8453: [
      "https://base.llamarpc.com",
      "https://mainnet.base.org",
      "https://base.publicnode.com",
      "https://base.drpc.org",
    ],
    42161: [
      "https://arbitrum.llamarpc.com",
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.publicnode.com",
      "https://arbitrum.drpc.org",
    ],
    10: [
      "https://optimism.llamarpc.com",
      "https://mainnet.optimism.io",
      "https://optimism.publicnode.com",
      "https://optimism.drpc.org",
      "https://rpc.ankr.com/optimism",
    ],
    137: [
      "https://polygon.llamarpc.com",
      "https://polygon-rpc.com",
      "https://rpc.ankr.com/polygon",
      "https://polygon.publicnode.com",
    ],
    56: [
      "https://bsc.llamarpc.com",
      "https://bsc-dataseed1.binance.org",
      "https://rpc.ankr.com/bsc",
      "https://bsc.publicnode.com",
    ],
    // Testnets
    11155111: [ // Ethereum Sepolia
      "https://sepolia.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161",
      "https://rpc.sepolia.org",
      "https://sepolia.gateway.tenderly.co",
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://rpc.ankr.com/eth_sepolia",
    ],
    84532: [ // Base Sepolia
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.gateway.tenderly.co",
      "https://rpc.ankr.com/base_sepolia",
    ],
    421614: [ // Arbitrum Sepolia
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.gateway.tenderly.co",
      "https://rpc.ankr.com/arbitrum_sepolia",
    ],
    11155420: [ // Optimism Sepolia
      "https://sepolia.optimism.io",
      "https://optimism-sepolia-rpc.publicnode.com",
      "https://optimism-sepolia.gateway.tenderly.co",
      "https://rpc.ankr.com/optimism_sepolia",
    ],
    80002: [ // Polygon Amoy
      "https://rpc-amoy.polygon.technology",
      "https://polygon-amoy-rpc.publicnode.com",
      "https://rpc.ankr.com/polygon_amoy",
    ],
    97: [ // BSC Testnet
      "https://data-seed-prebsc-1-s1.binance.org:8545",
      "https://data-seed-prebsc-2-s1.binance.org:8545",
      "https://bsc-testnet-rpc.publicnode.com",
      "https://rpc.ankr.com/bsc_testnet",
    ],
  };
  return rpcUrlMap[chainId] || [];
}

/**
 * Gets a single RPC URL for a chain ID (for backward compatibility)
 */
function getRpcUrl(chainId: number): string | null {
  const urls = getRpcUrls(chainId);
  return urls[0] || null;
}

/**
 * ERC20 token balance ABI
 */
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

/**
 * EVM wallet adapter for fetching balances on EVM-compatible chains
 */
export class EVMWalletAdapter implements WalletAdapter {
  vmType: "evm" = "evm";

  supportsChain(chainId: number): boolean {
    // EVM chains typically have chain IDs > 0
    // Check if it's in our known chain map (mainnet or testnet) or has RPC URLs configured
    return chainId > 0 && (!!CHAIN_MAP[chainId] || getRpcUrls(chainId).length > 0);
  }

  async getBalance(
    chainId: number,
    walletAddress: string,
    tokenAddress?: string
  ): Promise<bigint | undefined> {
    try {
      const publicClient = await this.getPublicClient(chainId);
      if (!publicClient) {
        console.warn(`No public client available for EVM chain ${chainId}`);
        return undefined;
      }

      // Check if this is a native token address
      const nativeAddress = "0x0000000000000000000000000000000000000000";
      const tokenAddrLower = tokenAddress?.toLowerCase() || "";
      const isNative =
        !tokenAddress ||
        tokenAddress === "" ||
        tokenAddrLower === nativeAddress.toLowerCase() ||
        tokenAddrLower === "native" ||
        tokenAddrLower === "eth" ||
        tokenAddrLower === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // Wrapped native placeholder

      if (isNative) {
        try {
          const balance = await publicClient.getBalance({
            address: walletAddress as Address,
          });
          return balance;
        } catch (error: any) {
          const errorMessage = error?.message || String(error);
          
          // Check if it's a network error
          if (
            errorMessage.includes("Failed to fetch") ||
            errorMessage.includes("ERR_NAME_NOT_RESOLVED") ||
            errorMessage.includes("network") ||
            errorMessage.includes("timeout")
          ) {
            console.warn(
              `Network error fetching native balance, RPC may be unavailable:`,
              errorMessage
            );
          } else {
            console.error("Error fetching native EVM balance:", error);
          }
          return undefined;
        }
      }

      // ERC20 token
      try {
        // First, check if the address is a contract
        const bytecode = await publicClient.getBytecode({
          address: tokenAddress as Address,
        });

        // If no bytecode, it's not a contract - might be an invalid address or EOA
        if (!bytecode || bytecode === "0x") {
          console.warn(
            `Address ${tokenAddress} is not a contract, cannot fetch ERC20 balance`
          );
          return undefined;
        }

        // Try to read the balance
        const balance = (await publicClient.readContract({
          address: tokenAddress as Address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [walletAddress as Address],
        })) as bigint;
        return balance;
      } catch (error: any) {
        // Check if it's a contract-related error
        const errorMessage = error?.message || String(error);
        
        // Check if it's a network error first
        if (
          errorMessage.includes("Failed to fetch") ||
          errorMessage.includes("ERR_NAME_NOT_RESOLVED") ||
          errorMessage.includes("network") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("HTTP request failed")
        ) {
          console.warn(
            `Network error fetching ERC20 balance, RPC may be unavailable:`,
            errorMessage
          );
          return undefined;
        }
        
        // If the contract doesn't have the function or returned no data,
        // it might not be a valid ERC20 contract
        if (
          errorMessage.includes("returned no data") ||
          errorMessage.includes("does not have the function") ||
          errorMessage.includes("not a contract")
        ) {
          console.warn(
            `Address ${tokenAddress} may not be a valid ERC20 contract:`,
            errorMessage
          );
          return undefined;
        }

        // For other errors, log and return undefined
        console.error(
          `Error fetching ERC20 balance for ${tokenAddress}:`,
          error
        );
        return undefined;
      }
    } catch (error) {
      console.error("Error in EVMWalletAdapter.getBalance:", error);
      return undefined;
    }
  }

  private async getPublicClient(chainId: number) {
    if (typeof window === "undefined") return null;

    const chain = CHAIN_MAP[chainId];
    const rpcUrls = getRpcUrls(chainId);

    // Try each RPC URL in order until one works
    for (const rpcUrl of rpcUrls) {
      try {
        const client = createPublicClient({
          chain: chain || undefined,
          transport: http(rpcUrl, {
            retryCount: 1,
            retryDelay: 50,
            timeout: 10000, // 10 second timeout
          }),
        });
        
        // Test the connection with a quick call (with timeout)
        try {
          await Promise.race([
            client.getBlockNumber(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error("Connection timeout")), 3000)
            ),
          ]);
        } catch (testError) {
          // If test fails, continue to next RPC
          console.warn(`RPC ${rpcUrl} connection test failed, trying next...`);
          continue;
        }
        
        return client;
      } catch (e) {
        // Continue to next RPC URL
        console.warn(`Failed to create client for ${rpcUrl}, trying next...`);
        continue;
      }
    }

    // Try MetaMask / injected provider
    if (window.ethereum) {
      try {
        return createPublicClient({
          chain: chain || undefined,
          transport: custom(window.ethereum),
        });
      } catch (e) {
        console.warn("Failed to create public client from ethereum provider", e);
      }
    }

    // Fallback to WalletConnect
    try {
      const provider = await getWalletConnectProvider();
      if (provider) {
        return createPublicClient({
          chain: chain || undefined,
          transport: custom(provider),
        });
      }
    } catch (e) {
      console.warn("Failed to create public client from WalletConnect", e);
    }

    // Final fallback: HTTP with chain's default RPC
    if (chain) {
      try {
        return createPublicClient({
          chain,
          transport: http(),
        });
      } catch (e) {
        console.warn("Failed to create public client with HTTP transport", e);
      }
    }

    return null;
  }
}

