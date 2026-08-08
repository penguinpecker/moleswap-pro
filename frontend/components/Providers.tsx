"use client";

import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { wagmiConfig } from "@/lib/wagmi";

/**
 * The whole client-side provider stack for MoleSwap Pro: wagmi (Robinhood Chain) + react-query. That is
 * all the aggregator needs — the swap widget uses standard wagmi hooks, so there is no bespoke wallet
 * context and nothing chain-specific beyond the config.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
