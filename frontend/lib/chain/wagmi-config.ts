"use client";
import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, coinbaseWallet, walletConnect } from "wagmi/connectors";
import { RH_CHAIN, ARC_CHAIN } from "./chains";

/**
 * Robinhood Chain (4663) + Arc (5042) wagmi config.
 *
 * Multi-wallet by design: EIP-6963 `injected` discovery surfaces MetaMask / Rabby / Zerion / Brave /
 * Trust and any other browser wallet individually; Coinbase Wallet works out of the box; WalletConnect
 * (QR + mobile wallets) turns on automatically when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set.
 */
export const robinhoodChain = defineChain({
  id: RH_CHAIN.id,
  name: RH_CHAIN.name,
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [RH_CHAIN.rpcUrl] } },
  blockExplorers: {
    default: { name: "Blockscout", url: RH_CHAIN.explorerUrl },
  },
});

/**
 * Arc (5042). Gas is paid in USDC: the NATIVE unit is 18-decimal, while the ERC-20 view of the same
 * balance at 0x3600…0000 is 6-decimal. viem needs the native convention here, so `decimals: 18` is
 * correct and is NOT the ERC-20's 6 — see the note in chains.ts before touching this.
 */
export const arcChain = defineChain({
  id: ARC_CHAIN.id,
  name: ARC_CHAIN.name,
  nativeCurrency: { decimals: 18, name: "USD Coin", symbol: "USDC" },
  rpcUrls: { default: { http: [ARC_CHAIN.rpcUrl] } },
  blockExplorers: {
    default: { name: "Arc Scan", url: ARC_CHAIN.explorerUrl },
  },
});

const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

export const wagmiConfig = createConfig({
  chains: [robinhoodChain, arcChain],
  multiInjectedProviderDiscovery: true, // EIP-6963: list every installed browser wallet separately
  connectors: [
    injected({ shimDisconnect: true }),
    // The logo the wallet shows while connecting. Points at the live domain and the current mark —
    // it was still on the old moleswap-pro.vercel.app host and the pre-2026-08-16 artwork.
    coinbaseWallet({ appName: "MoleSwap", appLogoUrl: "https://www.moleswap.com/android-chrome-512x512.png" }),
    ...(wcProjectId ? [walletConnect({ projectId: wcProjectId, showQrModal: true })] : []),
  ],
  transports: {
    [robinhoodChain.id]: http(),
    [arcChain.id]: http(),
  },
  ssr: true,
});
