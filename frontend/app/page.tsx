import SwapWidget from "@/components/aggregator/SwapWidget";

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", background: "#0a0a10" }}>
      <header style={{ padding: "20px 24px", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 22 }}>🐭</span>
        <span style={{ color: "#fff", fontWeight: 800, fontSize: 18, fontFamily: "system-ui, sans-serif" }}>
          MoleSwap<span style={{ color: "#5b5bff" }}> Pro</span>
        </span>
        <span style={{ marginLeft: "auto", color: "#667", fontSize: 13, fontFamily: "system-ui, sans-serif" }}>
          Robinhood Chain
        </span>
      </header>
      <SwapWidget />
      <footer style={{ textAlign: "center", color: "#556", fontSize: 12, padding: 30, fontFamily: "system-ui, sans-serif" }}>
        Aggregated across every venue on Robinhood Chain · minimum output guaranteed on-chain
      </footer>
    </main>
  );
}
