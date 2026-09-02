"use client";
/**
 * PoolActivity — what has actually happened in a pool, read from the chain.
 *
 * The pool detail could previously say TVL, a fee tier and an APY, all of which came from an indexer
 * table. When that indexer stopped on 2026-09-01 every one of those numbers froze and the page had no
 * way to know it was showing stale figures. Swap events are on the chain regardless of what is indexing
 * them, so everything below survives the indexer being down — which it currently is.
 *
 * WHAT IS DELIBERATELY NOT HERE: holders, and an all-time-high. Both need a full historical index this
 * page does not have, and inventing them is exactly the failure the fabricated liquidity chart was.
 */
import { useEffect, useState } from "react";
import { PoolChart } from "./PoolChart";
import { readPoolActivity, type PoolActivity as Activity } from "@/lib/mole/poolActivity";

const RPC_URL =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) ||
  "https://rpc.mainnet.chain.robinhood.com";

const WINDOWS = [
  { key: "6h", seconds: 21_600, candle: 300, label: "6 hours" },
  { key: "24h", seconds: 86_400, candle: 900, label: "24 hours" },
  { key: "7d", seconds: 604_800, candle: 3_600, label: "7 days" },
  { key: "30d", seconds: 2_592_000, candle: 14_400, label: "30 days" },
] as const;

function fmtNum(n: number | null, dp = 2): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n !== 0 && Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: dp });
}

function Pct({ v }: { v: number | null }) {
  if (v === null || !Number.isFinite(v)) return <span style={{ color: "var(--ink-3)" }}>—</span>;
  const up = v >= 0;
  return (
    <span style={{ color: up ? "var(--moss)" : "var(--rust)", fontWeight: 700 }}>
      {up ? "+" : ""}
      {v.toFixed(2)}%
    </span>
  );
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (ts: number) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

export function PoolActivityPanel({
  poolId,
  poolAddress,
  poolManager,
  decimals0,
  decimals1,
  symbol0,
  symbol1,
  explorerUrl,
}: {
  poolId?: string;
  poolAddress?: string;
  poolManager?: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
  explorerUrl: string;
}) {
  const [windowKey, setWindowKey] = useState<(typeof WINDOWS)[number]["key"]>("24h");
  const [data, setData] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const win = WINDOWS.find((w) => w.key === windowKey)!;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const rpc = async (method: string, params: unknown[]) => {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error.message);
      return json.result;
    };
    (async () => {
      try {
        const a = await readPoolActivity({
          rpc,
          poolManager,
          poolId,
          poolAddress,
          decimals0,
          decimals1,
          lookbackSeconds: win.seconds,
          candleSeconds: win.candle,
          maxTrades: 120,
        });
        if (!cancelled) setData(a);
      } catch (e) {
        // A read failure and an empty pool must not look the same — one is our problem, the other is
        // the market's. Say which.
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [poolId, poolAddress, poolManager, decimals0, decimals1, win.seconds, win.candle]);

  const stats: { l: string; v: React.ReactNode }[] = [
    { l: "Last traded", v: data?.lastPrice ? `${fmtNum(data.lastPrice, 6)} ${symbol1}` : "—" },
    { l: "1h", v: <Pct v={data?.changePct.h1 ?? null} /> },
    { l: "6h", v: <Pct v={data?.changePct.h6 ?? null} /> },
    { l: "24h", v: <Pct v={data?.changePct.h24 ?? null} /> },
    // Scoped to the window the user actually selected. These used to read from the fixed 24h bucket, so
    // a "Volume 30d" tile showed a 24-hour number — a different question, answered under the wrong label.
    { l: `Volume ${win.key}`, v: data ? `${fmtNum(data.windowTotals.volumeToken0, 4)} ${symbol0}` : "—" },
    {
      l: `Trades ${win.key}`,
      v: data ? `${data.complete ? "" : "≥"}${data.windowTotals.trades}` : "—",
    },
    { l: "24h high", v: data?.high24h ? fmtNum(data.high24h, 6) : "—" },
    { l: "24h low", v: data?.low24h ? fmtNum(data.low24h, 6) : "—" },
  ];

  return (
    <div className="p-card" style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h3>Market activity</h3>
        <div className="seg" role="tablist" aria-label="Chart range" style={{ display: "flex", gap: 4 }}>
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              role="tab"
              aria-selected={w.key === windowKey}
              onClick={() => setWindowKey(w.key)}
              className="pa-range"
              data-on={w.key === windowKey ? "1" : undefined}
            >
              {w.key}
            </button>
          ))}
        </div>
      </div>

      <style>{`
        .pa-range { font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
          padding: 4px 9px; border-radius: 8px; border: 1px solid rgba(120,96,64,.22);
          background: transparent; color: var(--ink-3); cursor: pointer; }
        .pa-range[data-on] { background: var(--amber, #f0a03c); color: #3a2a18; border-color: transparent; }
        .pa-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 10px;
          margin: 12px 0 4px; }
        .pa-stat .l { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
          color: var(--ink-3); }
        .pa-stat .v { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 13.5px;
          margin-top: 3px; }
        .pa-tbl { width: 100%; border-collapse: collapse; font-size: 12px;
          font-family: var(--font-num); font-variant-numeric: tabular-nums; }
        .pa-tbl th { text-align: left; font-size: 10px; letter-spacing: .06em; text-transform: uppercase;
          color: var(--ink-3); font-weight: 800; padding: 6px 8px; border-bottom: 1px solid rgba(120,96,64,.16); }
        .pa-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(120,96,64,.08); white-space: nowrap; }
        .pa-tbl tr:last-child td { border-bottom: 0; }
        .pa-buy { color: var(--moss); font-weight: 800; }
        .pa-sell { color: var(--rust); font-weight: 800; }
        .pa-scroll { max-height: 300px; overflow: auto; margin-top: 4px; }
        .pa-wrap { overflow-x: auto; }
      `}</style>

      <div className="pa-stats">
        {stats.map((s) => (
          <div className="pa-stat" key={s.l}>
            <div className="l">{s.l}</div>
            <div className="v">{loading && !data ? "…" : s.v}</div>
          </div>
        ))}
      </div>

      {error ? (
        <div className="p-mini" style={{ color: "var(--rust)", padding: "18px 0" }}>
          Could not read this pool&apos;s trades: {error}. This is a read failure, not an empty pool.
        </div>
      ) : (
        <PoolChart
          candles={data?.candles ?? []}
          quoteSymbol={symbol1}
          lookbackLabel={win.label}
          height={260}
        />
      )}

      {data && data.trades.length > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 16 }}>
            <h3 style={{ margin: 0 }}>Trades</h3>
            <span className="p-mini" style={{ color: "var(--ink-3)" }}>
              {data.complete ? `${data.trades.length} in the last ${win.label}` : `latest ${data.trades.length} — more exist`}
            </span>
          </div>
          <div className="pa-scroll pa-wrap">
            <table className="pa-tbl">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Side</th>
                  <th style={{ textAlign: "right" }}>{symbol0}</th>
                  <th style={{ textAlign: "right" }}>{symbol1}</th>
                  <th style={{ textAlign: "right" }}>Price</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {[...data.trades].reverse().map((t) => {
                  const a0 = Math.abs(Number(t.amount0)) / 10 ** decimals0;
                  const a1 = Math.abs(Number(t.amount1)) / 10 ** decimals1;
                  return (
                    <tr key={`${t.txHash}-${t.blockNumber}-${t.amount0}`}>
                      <td title={new Date(t.timestamp * 1000).toISOString()}>
                        {ago(t.timestamp)}
                        {!t.timestampExact && <span title="block time approximated"> ~</span>}
                      </td>
                      <td className={t.buysToken0 ? "pa-buy" : "pa-sell"}>{t.buysToken0 ? "BUY" : "SELL"}</td>
                      <td style={{ textAlign: "right" }}>{fmtNum(a0, 6)}</td>
                      <td style={{ textAlign: "right" }}>{fmtNum(a1, 6)}</td>
                      <td style={{ textAlign: "right" }}>{fmtNum(t.price, 6)}</td>
                      <td>
                        <a href={`${explorerUrl}/tx/${t.txHash}`} target="_blank" rel="noopener noreferrer">
                          {short(t.txHash)}
                        </a>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {data && (
        <div className="p-mini" style={{ color: "var(--ink-3)", marginTop: 10 }}>
          Read live from {data.venue === "v4" ? "the Uniswap v4 singleton" : "the pool contract"} over blocks{" "}
          {data.covered.fromBlock.toLocaleString()}–{data.covered.toBlock.toLocaleString()}. No indexer involved.
        </div>
      )}
    </div>
  );
}

