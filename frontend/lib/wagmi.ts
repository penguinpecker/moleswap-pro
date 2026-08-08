"use client";

/**
 * wagmi.ts — the wallet + chain config for MoleSwap Pro. Robinhood Chain only.
 *
 * A clean single-chain wallet config: one chain and the standard EVM connectors — injected
 * (MetaMask/Rabby/etc.) and, when a project id is set, WalletConnect. Nothing cross-chain, no bespoke
 * universal-wallet layer.
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
