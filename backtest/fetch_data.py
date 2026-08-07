"""
fetch_data.py — pull REAL historical OHLCV from Binance and cache it to CSV.

No synthetic data, ever. The whole point of this backtester (learnings.txt §1.8) is to answer
"does auto-recentering beat holding after gas and swap costs" with real numbers, so the inputs
must be real market history. Binance klines give open/high/low/close plus both base- and
quote-denominated volume, which is exactly what the concentrated-liquidity fee model needs.

Usage:
    python fetch_data.py                      # fetch the default panel
    python fetch_data.py ETHUSDC 1h 730       # symbol, interval, days back

Cached CSVs live in ./data/<symbol>_<interval>.csv and are reused on re-run.
"""
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.error

BINANCE = "https://api.binance.com/api/v3/klines"
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# Interval -> milliseconds, for pagination stepping.
_MS = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "15m": 900_000}


def _get(url, tries=5):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "moleswap-backtest/1.0"})
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode())
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"binance fetch failed after {tries} tries: {last}")


def fetch(symbol="ETHUSDC", interval="1h", days=730):
    """Fetch `days` of klines for `symbol` at `interval`, paginating forward in 1000-bar pages."""
    step = _MS[interval]
    end = int(time.time() * 1000)
    start = end - days * 86_400_000
    rows = []
    cursor = start
    while cursor < end:
        url = f"{BINANCE}?symbol={symbol}&interval={interval}&startTime={cursor}&limit=1000"
        page = _get(url)
        if not page:
            break
        for k in page:
            # kline: [openTime, open, high, low, close, volBase, closeTime, volQuote, trades, ...]
            rows.append({
                "ts": int(k[0]) // 1000,
                "open": float(k[1]),
                "high": float(k[2]),
                "low": float(k[3]),
                "close": float(k[4]),
                "vol_base": float(k[5]),
                "vol_quote": float(k[7]),
                "trades": int(k[8]),
            })
        nxt = int(page[-1][0]) + step
        if nxt <= cursor:
            break
        cursor = nxt
        time.sleep(0.15)  # be polite to the public endpoint
    # de-dup on timestamp, keep order
    seen = set()
    uniq = []
    for r in rows:
        if r["ts"] in seen:
            continue
        seen.add(r["ts"])
        uniq.append(r)
    return uniq


def save(rows, symbol, interval):
    os.makedirs(DATA_DIR, exist_ok=True)
    path = os.path.join(DATA_DIR, f"{symbol}_{interval}.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["ts", "open", "high", "low", "close", "vol_base", "vol_quote", "trades"])
        w.writeheader()
        w.writerows(rows)
    return path


def load(symbol, interval):
    path = os.path.join(DATA_DIR, f"{symbol}_{interval}.csv")
    if not os.path.exists(path):
        return None
    out = []
    with open(path) as f:
        for r in csv.DictReader(f):
            out.append({
                "ts": int(r["ts"]),
                "open": float(r["open"]), "high": float(r["high"]),
                "low": float(r["low"]), "close": float(r["close"]),
                "vol_base": float(r["vol_base"]), "vol_quote": float(r["vol_quote"]),
                "trades": int(r["trades"]),
            })
    return out


def get(symbol, interval, days, refetch=False):
    if not refetch:
        cached = load(symbol, interval)
        if cached and len(cached) > 100:
            return cached
    rows = fetch(symbol, interval, days)
    save(rows, symbol, interval)
    return rows


# The default panel: a clean liquid major (the MVP-scope pair, §1.8) plus genuinely volatile
# assets standing in for the memecoin tier the product actually targets (§1.6).
PANEL = [
    ("ETHUSDC", "1h", 730),   # major, the reference case
    ("BTCUSDC", "1h", 730),   # major, lower vol
    ("SOLUSDC", "1h", 730),   # high-beta L1
    ("DOGEUSDT", "1h", 730),  # memecoin proxy
    ("PEPEUSDT", "1h", 730),  # extreme-vol memecoin proxy
]

if __name__ == "__main__":
    if len(sys.argv) > 1:
        sym = sys.argv[1]
        itv = sys.argv[2] if len(sys.argv) > 2 else "1h"
        dys = int(sys.argv[3]) if len(sys.argv) > 3 else 730
        rows = get(sym, itv, dys, refetch=True)
        p = save(rows, sym, itv)
        print(f"{sym} {itv}: {len(rows)} bars -> {p}")
    else:
        for sym, itv, dys in PANEL:
            try:
                rows = get(sym, itv, dys, refetch=True)
                save(rows, sym, itv)
                span_days = (rows[-1]["ts"] - rows[0]["ts"]) / 86400 if rows else 0
                print(f"{sym:10s} {itv}: {len(rows):6d} bars, {span_days:6.1f} days")
            except Exception as e:
                print(f"{sym:10s} {itv}: FAILED — {e}")
