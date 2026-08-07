import type { ChainVM } from "@relayprotocol/relay-sdk";

/**
 * Wallet adapter interface for fetching balances across different chain types
 * Based on the AdaptedWallet pattern from Relay SDK
 */
export interface WalletAdapter {
  /**
   * The virtual machine type this adapter supports
   */
  vmType: ChainVM;

  /**
   * Fetches the balance of a token (native or token) for a given address
   * @param chainId - The chain ID
   * @param walletAddress - The wallet address to check balance for
   * @param tokenAddress - Optional token address. If not provided or native address, returns native token balance
   * @returns Balance as a bigint in the smallest unit, or undefined if not available
   */
  getBalance(
    chainId: number,
    walletAddress: string,
    tokenAddress?: string
  ): Promise<bigint | undefined>;

  /**
   * Checks if this adapter supports the given chain ID
   */
  supportsChain(chainId: number): boolean;
}

