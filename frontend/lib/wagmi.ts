"use client";

/**
 * wagmi.ts — the wallet + chain config for MoleSwap Pro. Robinhood Chain only.
 *
 * This is a clean single-chain wallet config — no cross-chain universal-wallet SDK, no
 * Solana-origin handling, no cross-chain Relay. The aggregator lives on one chain, so the config is one
 * chain and the standard EVM connectors — injected (MetaMask/Rabby/etc.) and, when a project id is set,
 * WalletConnect.
 */

import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, walletConnect } from "wagmi/connectors";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: {
      http: [process.env.NEXT_PUBLIC_RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com"],
    },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [
    injected({ shimDisconnect: true }),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
  ],
  transports: {
    [robinhoodChain.id]: http(),
  },
  ssr: true,
});
