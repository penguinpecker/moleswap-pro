/**
 * WalletConnect provider — stubs.
 *
 * WalletConnect is handled by the wagmi connector configured in wagmi-config.ts.
 * These no-op stubs remain only so legacy dynamic imports don't break the build.
 */

export async function getWalletConnectProvider() {
  return null;
}

export async function connectWithWalletConnect(): Promise<string[]> {
  return [];
}

export async function disconnectWalletConnect() {
  // no-op
}
