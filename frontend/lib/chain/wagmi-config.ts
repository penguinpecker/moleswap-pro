"use client";
import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { injected, coinbaseWallet, walletConnect } from "wagmi/connectors";

/**
 * Robinhood Chain (4663) wagmi config.
 *
 * Multi-wallet by design: EIP-6963 `injected` discovery surfaces MetaMask / Rabby / Zerion / Brave /
 * Trust and any other browser wallet individually; Coinbase Wallet works out of the box; WalletConnect
 * (QR + mobile wallets) turns on automatically when NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is set.
 */
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
  },
  ssr: true,
});
