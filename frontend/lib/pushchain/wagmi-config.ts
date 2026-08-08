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
// Robinhood Chain mainnet — the chain the MoleSwap Pro aggregator runs on. Added alongside Push so the
// existing game screens keep working while /swap targets RH. viem's chain object doubles as the wagmi
// chain, so no separate definition is needed.
export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
});

export const wagmiConfig = createConfig({
  chains: [robinhoodChain, pushWalletDonut],
  transports: {
    [robinhoodChain.id]: http(),
    [pushWalletDonut.id]: http(),
  },
  ssr: true,
});
