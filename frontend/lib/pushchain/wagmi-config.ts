"use client";
import { createConfig, http } from "wagmi";
import { defineChain } from "viem";

// Canonical Push Testnet Donut chain — matches @pushchain/ui-kit's internal definition
// Source: @pushchain/ui-kit/src/lib/providers/walletProviders/ethereum/chains.js
export const pushWalletDonut = defineChain({
  id: 42101,
  name: "Push Testnet Donut",
  nativeCurrency: {
    decimals: 18,
    name: "Push Chain",
    symbol: "PC",
  },
  rpcUrls: {
    default: {
      http: ["https://evm.donut.rpc.push.org/"],
      webSocket: ["wss://evm.donut.rpc.push.org"],
    },
  },
  blockExplorers: {
    default: {
      name: "Push Testnet Explorer",
      url: "https://donut.push.network/",
    },
  },
});

// Wagmi config — mirrors RamenFi's setup.
// `multiInjectedProviderDiscovery: true` (default) fires the EIP-6963
// `requestProvider` event on mount, which lets MetaMask (and Rabby/Zerion/etc.)
// announce themselves. The @pushchain/ui-kit's internal MetaMaskSDK listens
// for that announcement and then reports MetaMask as installed in its modal.
// `ssr: true` is required for Next.js App Router.
export const wagmiConfig = createConfig({
  chains: [pushWalletDonut],
  transports: {
    [pushWalletDonut.id]: http(),
  },
  ssr: true,
});
