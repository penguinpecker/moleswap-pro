import type { ChainVM } from "./types";
import type { WalletAdapter } from "./types";
import { EVMWalletAdapter } from "./evm";

/**
 * Registry of wallet adapters by VM type
 */
const adapterRegistry = new Map<ChainVM, WalletAdapter>();

// Initialize with EVM adapter
const evmAdapter = new EVMWalletAdapter();
adapterRegistry.set("evm", evmAdapter);

/**
 * Gets the appropriate wallet adapter for a given chain VM type
 */
export function getWalletAdapter(vmType: ChainVM): WalletAdapter | undefined {
  return adapterRegistry.get(vmType);
}

/**
 * Registers a custom wallet adapter
 */
export function registerWalletAdapter(adapter: WalletAdapter): void {
  adapterRegistry.set(adapter.vmType, adapter);
}

/**
 * Gets the wallet adapter for a chain ID by trying to determine the VM type
 * Falls back to EVM if chain type is unknown
 */
export async function getAdapterForChain(
  chainId: number,
  vmType?: ChainVM
): Promise<WalletAdapter | undefined> {
  // If VM type is provided, use it directly
  if (vmType) {
    return getWalletAdapter(vmType);
  }

  // For now, default to EVM for unknown chains
  // In the future, we can query the Relay API to get the VM type
  return getWalletAdapter("evm");
}

/**
 * Gets all registered adapters
 */
export function getAllAdapters(): WalletAdapter[] {
  return Array.from(adapterRegistry.values());
}

