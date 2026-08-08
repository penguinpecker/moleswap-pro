import SwapWidget from "@/components/aggregator/SwapWidget";

export const metadata = {
  title: "MoleSwap Pro — Aggregator",
  description: "Swap any token on Robinhood Chain at the best price across every venue.",
};

export default function SwapPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#0a0a10", paddingTop: 20 }}>
      <SwapWidget />
    </main>
  );
}
