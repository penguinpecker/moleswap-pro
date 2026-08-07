"""
summary.py — run the whole backtest and write results/results.txt + results/summary.md.

One command reproduces every number in README.md from the cached real data.
"""
import os
import sys
import io
import contextlib
from run import ASSETS, print_asset, cadence_sweep, turnover_sweep, pool_tvl_robustness

RESULTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")


def main():
    os.makedirs(RESULTS, exist_ok=True)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        print("STRATEGY PANEL — 2y real hourly Binance OHLCV, vs HODL-the-basket, min interval 24h\n")
        for sym, cfg in ASSETS.items():
            print_asset(sym, cfg, min_interval_bars=24)
        print("\n\nCADENCE SWEEP — Trailing(5/10), net APR + keeper gas/yr vs minimum rebalance interval")
        for sym in ["ETHUSDC", "SOLUSDC", "PEPEUSDT"]:
            cadence_sweep(sym, ASSETS[sym])
        print("\n\nTURNOVER SWEEP — beats-HODL verdict vs fee intensity (the free parameter that matters)")
        for sym in ["ETHUSDC", "BTCUSDC", "SOLUSDC", "DOGEUSDT", "PEPEUSDT"]:
            turnover_sweep(sym, ASSETS[sym])
        print("\n\nPOOL-DEPTH CHECK — confirms pool TVL analytically cancels (a check, not the robustness)")
        for sym in ["ETHUSDC", "PEPEUSDT"]:
            pool_tvl_robustness(sym, ASSETS[sym])
    out = buf.getvalue()
    print(out)
    with open(os.path.join(RESULTS, "results.txt"), "w") as f:
        f.write(out)
    print(f"\nwrote {os.path.join(RESULTS, 'results.txt')}")


if __name__ == "__main__":
    main()
