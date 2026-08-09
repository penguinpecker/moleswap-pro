"use client";
/**
 * Wallet provider — Robinhood Chain (4663), wagmi-backed.
 *
 * This file kept its original name (`PushChainWalletProvider` / `usePushWallet`) so every screen and
 * component that imports it keeps working unchanged. What changed is the engine underneath: there is
 * no Push universal wallet anymore — MoleSwap runs on Robinhood Chain, a single EVM chain, so a plain
 * injected/WalletConnect wagmi wallet is all that's needed.
 *
 * `usePushWallet()` returns the SAME shape it always did (address, isConnected, connect, disconnect,
 * pushChainClient, …). On a single chain there is no "origin vs UEA" distinction, so `origin`, `uea`,
 * and `address` are all the connected EVM address. `pushChainClient` is a truthy sentinel while
 * connected (screens gate the swap button on it); the actual signing happens through wagmi's wallet
 * client inside `executeSwap`.
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

const RH_CHAIN_ID = robinhoodChain.id;

/* ─── Compatibility shims ──────────────────────────────────────────────────
 * A few files historically imported PushUI / usePushWalletContext / usePushChainClient straight from
 * this module. They're re-exported here as thin no-op-ish shims so nothing has to change import sites,
 * and so a stray reference can never break the build. New code should use usePushWallet(). */
export const PushUI = {
  CONSTANTS: {
    CONNECTION: {
      STATUS: {
        CONNECTED: "connected",
        CONNECTING: "connecting",
        AUTHENTICATING: "authenticating",
        NOT_CONNECTED: "notConnected",
      },
    },
    PUSH_NETWORK: { MAINNET: "MAINNET", TESTNET_DONUT: "TESTNET_DONUT" },
    LOGIN: { LAYOUT: { SPLIT: "split" } },
    CONNECTED: { LAYOUT: { HOVER: "hover" } },
  },
} as const;

export function usePushWalletContext() {
  const w = usePushWallet();
  return {
    connectionStatus: w.connectionStatus,
    universalAccount: w.universalAccount,
    config: { network: PushUI.CONSTANTS.PUSH_NETWORK.MAINNET },
    handleConnectToPushWallet: w.connect,
    handleUserLogOutEvent: w.disconnect,
  };
}

export function usePushChainClient() {
  const w = usePushWallet();
  return { pushChainClient: w.pushChainClient };
}

/* ─── The hook everything uses ─────────────────────────────────────────── */
export function usePushWallet() {
  const { address: acct, isConnected, isConnecting, isReconnecting } = useAccount();
  const chainId = useChainId();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync } = useSwitchChain();

  const address = (acct as string | undefined) ?? null;
  const onRH = chainId === RH_CHAIN_ID;

  // Truthy while connected so the swap screens' `if (!pushChainClient)` gates pass. It also carries
  // the chain readiness so executeSwap can decide whether to prompt a network switch.
  const pushChainClient = isConnected ? { chainId, onRH, ready: true } : null;

  const connect = React.useCallback(async () => {
    try {
      const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];
      if (!injected) return;
      await connectAsync({ connector: injected, chainId: RH_CHAIN_ID });
    } catch {
      /* user rejected / no wallet — surfaced by the button UI */
    }
  }, [connectAsync, connectors]);

  // Connect with a specific wallet chosen from the picker.
  const connectWith = React.useCallback(
    async (connector: (typeof connectors)[number]) => {
      try {
        await connectAsync({ connector, chainId: RH_CHAIN_ID });
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
    ? PushUI.CONSTANTS.CONNECTION.STATUS.CONNECTED
    : isConnecting || isReconnecting
      ? PushUI.CONSTANTS.CONNECTION.STATUS.CONNECTING
      : PushUI.CONSTANTS.CONNECTION.STATUS.NOT_CONNECTED;

  return {
    address, // the connected EVM address on Robinhood Chain
    uea: address, // no origin/UEA split on a single chain
    origin: address,
    isConnected,
    isConnecting: isConnecting || isReconnecting,
    connectionStatus,
    pushChainClient,
    universalAccount: address ? { address, chain: `eip155:${RH_CHAIN_ID}` } : null,
    originChain: address ? `eip155:${RH_CHAIN_ID}` : null,
    onRH,
    switchToRH: () => switchChainAsync({ chainId: RH_CHAIN_ID }).catch(() => undefined),
    connect,
    connectWith,
    wallets,
    disconnect: () => disconnect(),
  };
}

interface Props {
  children: React.ReactNode;
  network?: "testnet" | "mainnet";
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, refetchOnWindowFocus: false },
  },
});

export function PushChainWalletProvider({ children }: Props) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
