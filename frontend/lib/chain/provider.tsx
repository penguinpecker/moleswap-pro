"use client";
/**
 * Wallet provider — Robinhood Chain (4663), wagmi-backed.
 *
 * `useWallet()` returns address, isConnected, connect, disconnect, chainClient, …
 * On a single chain `origin`, `uea`, and `address` are all the connected EVM address.
 * `chainClient` is a truthy sentinel while connected (screens gate the swap button on
 * it); the actual signing happens through wagmi's wallet client inside `executeSwap`.
 */
import React from "react";
import {
  WagmiProvider,
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig, robinhoodChain } from "./wagmi-config";
import {
  SUPPORTED_CHAINS,
  chainMetaFor,
  isSupportedChain,
  contractsFor,
  RH_CHAIN,
  type ChainMeta,
} from "./chains";

const RH_CHAIN_ID = robinhoodChain.id;

/**
 * Which chain a fresh connection should target. The switcher writes this so that picking Arc while
 * disconnected actually means something: the next connect lands on Arc rather than snapping back to
 * Robinhood. Read at call time rather than held in state, so every `useWallet()` instance agrees
 * without threading a context through the tree.
 */
export const PREFERRED_CHAIN_KEY = "moleswap.preferredChainId";

export function readPreferredChainId(): number {
  if (typeof window === "undefined") return RH_CHAIN_ID;
  try {
    const raw = window.localStorage.getItem(PREFERRED_CHAIN_KEY);
    const id = raw ? Number(raw) : NaN;
    return isSupportedChain(id) ? id : RH_CHAIN_ID;
  } catch {
    // Private mode / blocked storage — the default is always a safe answer.
    return RH_CHAIN_ID;
  }
}

export function writePreferredChainId(id: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFERRED_CHAIN_KEY, String(id));
  } catch {
    /* nothing to do — the preference is a convenience, not state we depend on */
  }
}

/* ─── Compatibility shims ──────────────────────────────────────────────────
 * A few files historically imported WalletUI / useWalletContext / useChainClient straight from
 * this module. They're re-exported here as thin no-op-ish shims so nothing has to change import sites,
 * and so a stray reference can never break the build. New code should use useWallet(). */
export const WalletUI = {
  CONSTANTS: {
    CONNECTION: {
      STATUS: {
        CONNECTED: "connected",
        CONNECTING: "connecting",
        AUTHENTICATING: "authenticating",
        NOT_CONNECTED: "notConnected",
      },
    },
    LOGIN: { LAYOUT: { SPLIT: "split" } },
    CONNECTED: { LAYOUT: { HOVER: "hover" } },
  },
} as const;

export function useWalletContext() {
  const w = useWallet();
  return {
    connectionStatus: w.connectionStatus,
    universalAccount: w.universalAccount,
    handleConnectWallet: w.connect,
    handleUserLogOutEvent: w.disconnect,
  };
}

export function useChainClient() {
  const w = useWallet();
  return { chainClient: w.chainClient };
}

/* ─── The hook everything uses ─────────────────────────────────────────── */
export function useWallet() {
  const { address: acct, isConnected, isConnecting, isReconnecting, chainId: walletChainId } = useAccount();
  const configChainId = useChainId();
  // The chain the WALLET is on while connected. `useChainId()` only ever answers with a configured chain,
  // so with it alone a wallet parked on Ethereum read as "Robinhood": the pill, the balances and the
  // quote all rendered Robinhood's, and the "Switch to Robinhood" state below was unreachable code.
  // Disconnected, the config chain (the switcher's preference) is the only sensible answer.
  const chainId = isConnected ? (walletChainId ?? configChainId) : configChainId;
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

  const address = (acct as string | undefined) ?? null;
  const onRH = chainId === RH_CHAIN_ID;

  // The chain the wallet is actually on, when we support it. Undefined means the wallet is somewhere
  // we have no deployment for, which the switcher renders as an explicit "unsupported network" state
  // rather than silently pretending to be on Robinhood.
  const activeChain: ChainMeta | undefined = chainMetaFor(chainId);
  const onSupportedChain = isSupportedChain(chainId);
  // Addresses for the CURRENT chain. Anything chain-aware must read these rather than the flat
  // Robinhood-only registry in contracts.ts, or it will aim an approval at the wrong network.
  const contracts = contractsFor(chainId);

  // Truthy while connected so the swap screens' `if (!chainClient)` gates pass. It also carries
  // the chain readiness so executeSwap can decide whether to prompt a network switch.
  const chainClient = isConnected ? { chainId, onRH, ready: true } : null;

  const connect = React.useCallback(async () => {
    try {
      const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];
      if (!injected) return;
      await connectAsync({ connector: injected, chainId: readPreferredChainId() });
    } catch {
      /* user rejected / no wallet — surfaced by the button UI */
    }
  }, [connectAsync, connectors]);

  // Connect with a specific wallet chosen from the picker.
  const connectWith = React.useCallback(
    async (connector: (typeof connectors)[number]) => {
      try {
        await connectAsync({ connector, chainId: readPreferredChainId() });
      } catch {
        /* user rejected / wallet unavailable */
      }
    },
    [connectAsync],
  );

  // Deduped list of selectable wallets (EIP-6963 discovery can surface duplicates by name).
  const wallets = React.useMemo(() => {
    const seen = new Set<string>();
    return connectors.filter((c) => {
      const key = (c.name || c.id || "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [connectors]);

  const connectionStatus = isConnected
    ? WalletUI.CONSTANTS.CONNECTION.STATUS.CONNECTED
    : isConnecting || isReconnecting
      ? WalletUI.CONSTANTS.CONNECTION.STATUS.CONNECTING
      : WalletUI.CONSTANTS.CONNECTION.STATUS.NOT_CONNECTED;

  return {
    address, // the connected EVM address on Robinhood Chain
    uea: address, // no origin/UEA split on a single chain
    origin: address,
    isConnected,
    isConnecting: isConnecting || isReconnecting,
    connectionStatus,
    chainClient,
    universalAccount: address ? { address, chain: `eip155:${RH_CHAIN_ID}` } : null,
    originChain: address ? `eip155:${RH_CHAIN_ID}` : null,
    onRH,
    switchToRH: () => switchChainAsync({ chainId: RH_CHAIN_ID }).catch(() => undefined),

    // ── multi-chain surface (Robinhood + Arc) ──
    chainId,
    activeChain,
    onSupportedChain,
    contracts,
    supportedChains: SUPPORTED_CHAINS,
    /** Ask the wallet to move to `id`. Resolves either way; the caller re-reads `activeChain`. */
    switchTo: (id: number) => switchChainAsync({ chainId: id }).catch(() => undefined),
    connect,
    connectWith,
    wallets,
    disconnect: () => disconnect(),
  };
}

interface Props {
  children: React.ReactNode;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false },
  },
});

export function WalletProvider({ children }: Props) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
