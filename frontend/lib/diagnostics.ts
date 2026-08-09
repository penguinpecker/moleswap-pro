/**
 * diagnostics — lightweight, dependency-free telemetry shim.
 *
 * The original module wired deep into the Push universal-wallet lifecycle. On Robinhood Chain there's
 * no such lifecycle, so this is a thin console logger that preserves the exact method surface the app
 * calls (logConnected, logSwapAttempt, analyzeError, …). Everything is best-effort and never throws.
 */

type Any = any;

function log(tag: string, ...args: Any[]) {
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.debug(`[MoleSwap] ${tag}`, ...args);
  }
}

export const diagnostics = {
  logConnected: () => log("wallet connected"),
  logDisconnect: () => log("wallet disconnected"),
  logPushChainClientReady: (_client?: Any) => log("wallet client ready"),
  logAddressResolved: (address?: string | null, origin?: string | null) =>
    log("address resolved", { address, origin }),
  checkWalletInvariants: (_state?: Any) => {},
  logSessionEvent: (msg?: string, data?: Any) => log(`session: ${msg ?? ""}`, data),
  logSwapAttempt: (data?: Any) => log("swap attempt", data),
  logSwapResult: (data?: Any) => log("swap result", data),
  analyzeError: (err: Any): string => {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    return err?.shortMessage || err?.message || "Transaction failed";
  },
};

export type Diagnostics = typeof diagnostics;
