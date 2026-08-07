/**
 * WalletConnect provider - DEPRECATED
 * Now using PushChain Universal Wallet
 * Kept as stubs to prevent import errors
 */

export async function getWalletConnectProvider() {
  return null;
}

export async function connectWithWalletConnect(): Promise<string[]> {
  console.warn("WalletConnect removed. Use PushChain Universal Wallet instead.");
  return [];
}

export async function disconnectWalletConnect() {
  // no-op
}
