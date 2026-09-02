"use client";
/**
 * PoolChart — a pool's real price history, drawn with TradingView's lightweight-charts.
 *
 * Every point comes from a Swap event the chain emitted; there is no synthetic data here. That matters
 * because the panel this sits beside used to draw a "liquidity distribution" whose bars were a fixed
 * triangular function around a hard-coded peak — decoration presented as data on a page that also shows
 * a cryptographic provenance card.
 *
 * A QUIET POOL IS NOT A BROKEN ONE. MoleSwap's own pools have tens of lifetime swaps, so the honest
 * rendering is often a nearly flat line with long gaps. The empty state says how far back it looked, so
 * "no trades" reads as a fact about the market rather than a failure of the page.
 */
import { useEffect, useRef } from "react";
import type { Candle } from "@/lib/mole/poolActivity";

export function PoolChart({
  candles,
  height = 260,
  quoteSymbol,
  lookbackLabel,
}: {
  candles: Candle[];
  height?: number;
  quoteSymbol: string;
  lookbackLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!box.current || candles.length === 0) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;

    // Imported lazily so the ~45KB charting bundle never lands on a route that does not draw a chart.
    (async () => {
      const lw = await import("lightweight-charts");
      if (disposed || !box.current) return;

      const css = getComputedStyle(document.documentElement);
      const ink = css.getPropertyValue("--ink-1")?.trim() || "#3a2a18";
      const grid = "rgba(120, 96, 64, 0.12)";

      const chart = lw.createChart(box.current, {
        height,
        layout: {
          background: { color: "transparent" },
          textColor: ink,
          fontFamily: css.getPropertyValue("--font-num")?.trim() || "ui-monospace, monospace",
          attributionLogo: false,
        },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        rightPriceScale: { borderColor: grid },
        timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
        crosshair: { mode: lw.CrosshairMode.Normal },
        handleScale: { axisPressedMouseMove: false },
      });
      chartRef.current = chart;

      const series = chart.addSeries(lw.CandlestickSeries, {
        upColor: "#43a06a",
        downColor: "#b4341c",
        wickUpColor: "#43a06a",
        wickDownColor: "#b4341c",
        borderVisible: false,
        // A pool priced in a 6-decimal stable needs more precision than the default 2 dp, and a
        // memecoin priced at 1e-8 needs far more still. Derive it from the data actually shown.
        priceFormat: (() => {
          const min = Math.min(...candles.map((c) => c.l).filter((v) => v > 0));
          const precision = !Number.isFinite(min) ? 4 : min >= 100 ? 2 : min >= 1 ? 4 : min >= 0.01 ? 6 : 10;
          return { type: "price" as const, precision, minMove: Math.pow(10, -precision) };
        })(),
      });
      series.setData(candles.map((c) => ({ time: c.t as any, open: c.o, high: c.h, low: c.l, close: c.c })));

      const vol = chart.addSeries(lw.HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "vol",
      });
      vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      vol.setData(
        candles.map((c) => ({
          time: c.t as any,
          value: c.v,
          color: c.c >= c.o ? "rgba(67,160,106,.35)" : "rgba(180,52,28,.35)",
        })),
      );

      chart.timeScale().fitContent();

      ro = new ResizeObserver(() => {
        if (box.current) chart.applyOptions({ width: box.current.clientWidth });
      });
      ro.observe(box.current);
      chart.applyOptions({ width: box.current.clientWidth });
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      try {
        chartRef.current?.remove();
      } catch {
        /* already torn down */
      }
      chartRef.current = null;
    };
  }, [candles, height]);

  if (candles.length === 0) {
    return (
      <div
        style={{
          height,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          color: "var(--ink-3)",
          fontSize: 12.5,
          textAlign: "center",
        }}
      >
        <b style={{ fontSize: 13.5, color: "var(--ink-2)" }}>No trades yet</b>
        <span>
          Nothing has swapped through this pool in the last {lookbackLabel}. Price below is the pool&apos;s
          current quote, not a traded price.
        </span>
      </div>
    );
  }

  return (
    <div>
      <div ref={box} style={{ width: "100%", height }} />
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>
        Price in {quoteSymbol}, from each swap&apos;s own post-trade pool price · last {lookbackLabel}
      </div>
    </div>
  );
}
