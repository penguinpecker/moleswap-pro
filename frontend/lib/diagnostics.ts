/**
 * MoleSwap Runtime Diagnostics
 *
 * Non-blocking checks that log warnings/errors to console.
 * These help detect race conditions and edge cases in production
 * without affecting user experience.
 */

const PREFIX = "[MoleSwap:Diagnostics]";

// Track timing of wallet state transitions
interface WalletTimings {
  connectStarted?: number;
  isConnectedAt?: number;
  pushChainClientReadyAt?: number;
  addressResolvedAt?: number;
  firstSwapAttemptAt?: number;
}

const walletTimings: WalletTimings = {};

/**
 * Log wallet connection started
 */
export function logConnectStart(): void {
  walletTimings.connectStarted = Date.now();
  console.log(PREFIX, "Wallet connect initiated");
}

/**
 * Log when isConnected becomes true
 */
export function logConnected(): void {
  walletTimings.isConnectedAt = Date.now();
  const elapsed = walletTimings.connectStarted
    ? walletTimings.isConnectedAt - walletTimings.connectStarted
    : null;
  console.log(PREFIX, "Wallet connected", elapsed ? `(${elapsed}ms)` : "");
}

/**
 * Log when pushChainClient becomes available
 */
export function logPushChainClientReady(client: any): void {
  walletTimings.pushChainClientReadyAt = Date.now();
  const sinceConnect = walletTimings.isConnectedAt
    ? walletTimings.pushChainClientReadyAt - walletTimings.isConnectedAt
    : null;

  console.log(
    PREFIX,
    "PushChainClient ready",
    sinceConnect ? `(${sinceConnect}ms after isConnected)` : "",
    {
      hasUniversal: !!client?.universal,
      hasAccount: !!client?.universal?.account,
    }
  );

  // INVARIANT CHECK: If there was a swap attempt before client was ready, log it
  if (walletTimings.firstSwapAttemptAt && walletTimings.firstSwapAttemptAt < walletTimings.pushChainClientReadyAt) {
    console.warn(
      PREFIX,
      "⚠️ RACE DETECTED: Swap was attempted before pushChainClient was ready!",
      {
        swapAttemptAt: walletTimings.firstSwapAttemptAt,
        clientReadyAt: walletTimings.pushChainClientReadyAt,
        gapMs: walletTimings.pushChainClientReadyAt - walletTimings.firstSwapAttemptAt,
      }
    );
  }
}

/**
 * Log when UEA address is resolved
 */
export function logAddressResolved(address: string | null, origin: string | null): void {
  walletTimings.addressResolvedAt = Date.now();
  const sinceConnect = walletTimings.isConnectedAt
    ? walletTimings.addressResolvedAt - walletTimings.isConnectedAt
    : null;

  console.log(
    PREFIX,
    "Address resolved",
    sinceConnect ? `(${sinceConnect}ms after isConnected)` : "",
    {
      address: address ? `${address.slice(0, 10)}...` : null,
      origin: origin ? `${origin.slice(0, 15)}...` : null,
    }
  );
}

/**
 * Log swap attempt with current wallet state
 */
export function logSwapAttempt(state: {
  isConnected: boolean;
  hasAddress: boolean;
  hasPushChainClient: boolean;
  hasUniversal: boolean;
  originChain: string | null;
}): void {
  if (!walletTimings.firstSwapAttemptAt) {
    walletTimings.firstSwapAttemptAt = Date.now();
  }

  const issues: string[] = [];

  if (!state.isConnected) issues.push("NOT_CONNECTED");
  if (!state.hasAddress) issues.push("NO_ADDRESS");
  if (!state.hasPushChainClient) issues.push("NO_PUSHCHAIN_CLIENT");
  if (state.hasPushChainClient && !state.hasUniversal) issues.push("NO_UNIVERSAL");

  if (issues.length > 0) {
    console.warn(PREFIX, "⚠️ Swap attempt with incomplete wallet state:", issues, state);
  } else {
    console.log(PREFIX, "Swap attempt - wallet state OK", {
      originChain: state.originChain,
      timeSinceConnect: walletTimings.isConnectedAt
        ? Date.now() - walletTimings.isConnectedAt
        : null,
    });
  }
}

/**
 * Log swap execution result
 */
export function logSwapResult(result: {
  success: boolean;
  txHash?: string;
  error?: string;
  durationMs: number;
}): void {
  if (result.success) {
    console.log(PREFIX, "✅ Swap succeeded", {
      txHash: result.txHash?.slice(0, 20) + "...",
      durationMs: result.durationMs,
    });
  } else {
    console.error(PREFIX, "❌ Swap failed", {
      error: result.error,
      durationMs: result.durationMs,
    });
  }
}

/**
 * Log wallet disconnect
 */
export function logDisconnect(): void {
  console.log(PREFIX, "Wallet disconnected");
  // Reset timings
  Object.keys(walletTimings).forEach(k => delete (walletTimings as any)[k]);
}

/**
 * Check and log invariants about wallet state
 * Call this periodically or before critical operations
 */
export function checkWalletInvariants(state: {
  isConnected: boolean;
  address: string | null;
  pushChainClient: any;
  originChain: string | null;
}): void {
  const invariants: Array<{ name: string; passed: boolean; detail?: string }> = [];

  // Invariant 1: If connected, should have address within reasonable time
  if (state.isConnected && !state.address) {
    const elapsed = walletTimings.isConnectedAt
      ? Date.now() - walletTimings.isConnectedAt
      : 0;
    invariants.push({
      name: "CONNECTED_HAS_ADDRESS",
      passed: elapsed < 5000, // Allow 5s grace period
      detail: `Connected but no address after ${elapsed}ms`,
    });
  }

  // Invariant 2: If connected, should have pushChainClient within reasonable time
  if (state.isConnected && !state.pushChainClient) {
    const elapsed = walletTimings.isConnectedAt
      ? Date.now() - walletTimings.isConnectedAt
      : 0;
    invariants.push({
      name: "CONNECTED_HAS_CLIENT",
      passed: elapsed < 5000,
      detail: `Connected but no pushChainClient after ${elapsed}ms`,
    });
  }

  // Invariant 3: If we have pushChainClient, it should have universal
  if (state.pushChainClient && !state.pushChainClient.universal) {
    invariants.push({
      name: "CLIENT_HAS_UNIVERSAL",
      passed: false,
      detail: "pushChainClient exists but has no universal property",
    });
  }

  // Invariant 4: Solana origin should not have 0x address as origin.
  // `origin` can be a string OR a wrapper object (PublicKey from @solana/web3.js
  // exposes toString()/toBase58() — calling .startsWith on it crashes the
  // interval every 10s, which is what we saw in prod logs). Coerce to string
  // defensively before any string-ish check.
  if (state.originChain?.toLowerCase().startsWith("solana:")) {
    const originRaw = (state.pushChainClient as any)?.universal?.origin;
    const originStr =
      typeof originRaw === "string"
        ? originRaw
        : originRaw && typeof originRaw.toString === "function"
          ? originRaw.toString()
          : null;
    if (originStr && originStr.startsWith("0x")) {
      invariants.push({
        name: "SOLANA_ORIGIN_FORMAT",
        passed: false,
        detail: `Solana origin chain but origin address is EVM format: ${originStr}`,
      });
    }
  }

  // Log any failed invariants
  const failed = invariants.filter(i => !i.passed);
  if (failed.length > 0) {
    console.warn(PREFIX, "⚠️ Wallet invariant check failed:", failed);
  }
}

/**
 * Log session/history management events
 */
export function logSessionEvent(event: string, details?: Record<string, any>): void {
  console.log(PREFIX, `Session: ${event}`, details || "");
}

/**
 * Performance tracking for critical operations
 */
export function measureAsync<T>(
  operationName: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  return fn()
    .then(result => {
      console.log(PREFIX, `⏱️ ${operationName} completed in ${Date.now() - start}ms`);
      return result;
    })
    .catch(err => {
      console.error(PREFIX, `⏱️ ${operationName} failed after ${Date.now() - start}ms:`, err?.message || err);
      throw err;
    });
}

/**
 * Check for common error patterns in error messages
 */
export function analyzeError(
  error: any,
  _context?: { originChain?: string | null },
): {
  category: string;
  suggestion: string;
  isRetryable: boolean;
} {
  const msg = error?.message || String(error);

  if (msg.includes("universal") && msg.includes("null")) {
    return {
      category: "SDK_NOT_READY",
      suggestion: "PushChain SDK not initialized. Wait for wallet to fully connect.",
      isRetryable: true,
    };
  }

  if (msg.includes("User rejected") || msg.includes("User denied") || error?.code === 4001) {
    return {
      category: "USER_REJECTED",
      suggestion: "User rejected the transaction in their wallet.",
      isRetryable: true,
    };
  }

  // Phantom on Solana throws a generic "Unexpected error" (the Push SDK wraps
  // it as "Signature request failed") for any instruction it can't simulate.
  // Common real-world causes we've seen: (1) wallet is on Mainnet, not Devnet;
  // (2) not enough Devnet SOL to cover bridge + fees. We no longer point the
  // user at one specific cause because both happen in production and guessing
  // wrong sends them down the wrong rabbit-hole. The message below gives the
  // two concrete checks; the preflight in SwapPage will throw a more specific
  // error first whenever it can verify the real cause.
  const looksLikePhantomReject =
    msg.includes("Signature request failed") ||
    msg.toLowerCase().includes("unexpected error");
  if (looksLikePhantomReject) {
    return {
      category: "PHANTOM_REJECTED",
      suggestion:
        "Phantom couldn't sign the transaction. Two common causes:\n\n" +
        "1. Phantom is on Solana Mainnet — Push Chain's bridge only works with " +
        "Solana Devnet. Toggle Phantom → Settings → Developer Settings → Testnet " +
        "Mode ON, then pick Solana Devnet as the network.\n\n" +
        "2. Not enough Devnet SOL to cover the bridge + fees. Get free Devnet " +
        "SOL from https://faucet.solana.com/.\n\n" +
        "If both look fine, reconnect Phantom and try again.",
      isRetryable: true,
    };
  }

  if (msg.includes("insufficient") || msg.includes("have 0 want") || (msg.includes("balance") && msg.includes("exceed"))) {
    // Extract amounts if available from viem error format
    const haveWantMatch = msg.match(/have (\d+) want (\d+)/);
    let suggestion = "Not enough tokens for this transaction.";
    if (haveWantMatch) {
      const have = BigInt(haveWantMatch[1]);
      const want = BigInt(haveWantMatch[2]);
      const wantEth = Number(want) / 1e18;
      if (have === 0n) {
        suggestion = `Your Push Chain account has 0 balance. You need ~${wantEth.toFixed(6)} PC to complete this swap. Bridge funds to Push Chain first.`;
      } else {
        const haveEth = Number(have) / 1e18;
        suggestion = `Insufficient balance. You have ${haveEth.toFixed(6)} PC but need ~${wantEth.toFixed(6)} PC.`;
      }
    }
    return {
      category: "INSUFFICIENT_BALANCE",
      suggestion,
      isRetryable: false,
    };
  }

  if (msg.includes("STF") || msg.includes("transfer rejected")) {
    return {
      category: "TRANSFER_FAILED",
      suggestion: "Token transfer failed. Check balance and approval.",
      isRetryable: true,
    };
  }

  if (msg.includes("slippage") || msg.includes("SPL")) {
    return {
      category: "SLIPPAGE_EXCEEDED",
      suggestion: "Price moved too much. Try increasing slippage tolerance.",
      isRetryable: true,
    };
  }

  if (msg.includes("Devnet") || msg.includes("cluster")) {
    return {
      category: "WRONG_NETWORK",
      suggestion: "Wallet is on wrong network. Switch to Devnet for testing.",
      isRetryable: true,
    };
  }

  if (msg.includes("timeout") || msg.includes("ETIMEDOUT")) {
    return {
      category: "TIMEOUT",
      suggestion: "Network request timed out. Check connection and retry.",
      isRetryable: true,
    };
  }

  return {
    category: "UNKNOWN",
    suggestion: msg.slice(0, 100),
    isRetryable: true,
  };
}

// Export singleton for tracking across modules
export const diagnostics = {
  logConnectStart,
  logConnected,
  logPushChainClientReady,
  logAddressResolved,
  logSwapAttempt,
  logSwapResult,
  logDisconnect,
  checkWalletInvariants,
  logSessionEvent,
  measureAsync,
  analyzeError,
};

export default diagnostics;
