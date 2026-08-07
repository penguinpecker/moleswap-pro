"""
run.py — the actual product questions, answered on real data.

Answers the two things learnings.txt says block a real decision:
  Q1 (§1.8): does auto-recentering beat holding / passive-wide once gas and swap costs are counted?
  Q2 (§F-2 / Part-15 cadence conflict): what rebalance cadence is affordable, and what min deposit does
      the keeper's rebalance gas imply?

Method: each strategy is run over ~2 years of real hourly Binance OHLCV, versus a HODL-the-basket baseline.
The fee model's pool depth is a parameter; the strategy RANKING is robust to it (all strategies share it),
and Q2 is reported in the pool-independent form "keeper gas per position per year" plus the fee APR needed
to cover it.
"""
import sys
from fetch_data import get
from fee_model import FeeModel
from engine import run, run_hodl, BARS_PER_YEAR_1H
from strategies import PassiveWide, Trailing, VolScaled, LossAware, FullRangeLP, VeryWideLP
import costs

# Per-asset config: fee tier, a plausible pool TVL (quote), and the pool's annual turnover (volume/TVL).
# turnover is the ONE fee-model knob that does not cancel (pool_tvl provably cancels for a small LP), so it
# is calibrated to real on-chain levels AND swept (turnover_sweep) — the beats-HODL verdict is a function of
# fee intensity = turnover * fee_tier, and that is reported rather than hidden behind one assumed value.
# Calibration basis (public, order-of-magnitude): a major CEX/DEX pair turns over roughly 1-2x its TVL per
# day (~365-730x/yr) e.g. Uniswap ETH/USDC-5bps ~$100-300M/day on ~$100-150M TVL; memecoins churn harder.
ASSETS = {
    "ETHUSDC":  dict(fee_tier=0.0005, pool_tvl=120_000_000, turnover=365, slippage_bps=2.0),
    "BTCUSDC":  dict(fee_tier=0.0005, pool_tvl=150_000_000, turnover=250, slippage_bps=2.0),
    "SOLUSDC":  dict(fee_tier=0.0030, pool_tvl=15_000_000,  turnover=500, slippage_bps=5.0),
    "DOGEUSDT": dict(fee_tier=0.0100, pool_tvl=3_000_000,   turnover=700, slippage_bps=15.0),
    "PEPEUSDT": dict(fee_tier=0.0100, pool_tvl=1_500_000,   turnover=900, slippage_bps=25.0),
}


def make_fee_model(cfg, bars):
    years = len(bars) / BARS_PER_YEAR_1H
    return FeeModel(fee_tier=cfg["fee_tier"], pool_tvl_quote=cfg["pool_tvl"],
                    turnover_annual=cfg["turnover"]).calibrate(bars, years)


def strategy_panel():
    return [
        FullRangeLP(),          # genuine full-range (v2-like) baseline
        VeryWideLP(0.99),
        PassiveWide(0.5),
        PassiveWide(0.2),
        Trailing(0.15, 0.30),
        Trailing(0.05, 0.10),
        VolScaled(6.0, 168),
        LossAware(Trailing(0.05, 0.10)),
        LossAware(VolScaled(6.0, 168)),
    ]


def pct(x):
    return f"{x*100:+7.2f}%"


def run_asset(symbol, cfg, capital=1000.0, min_interval_bars=24):
    bars = get(symbol, "1h", 730)
    fm = make_fee_model(cfg, bars)
    hodl = run_hodl(bars, capital=capital).summarize(BARS_PER_YEAR_1H)

    rows = [("HODL (basket)", hodl, 0.0)]
    for strat in strategy_panel():
        res = run(bars, strat, fm, capital=capital, fee_tier=cfg["fee_tier"],
                  slippage_bps=cfg["slippage_bps"], min_interval_bars=min_interval_bars)
        s = res.summarize(BARS_PER_YEAR_1H)
        rows.append((strat.name, s, s["apr"] - hodl["apr"]))
    return hodl, rows


def print_asset(symbol, cfg, min_interval_bars):
    hodl, rows = run_asset(symbol, cfg, min_interval_bars=min_interval_bars)
    print(f"\n=== {symbol}  (fee {cfg['fee_tier']*1e4:.0f}bps, pool ${cfg['pool_tvl']/1e6:.0f}M, "
          f"min interval {min_interval_bars}h) ===")
    print(f"  {'strategy':<26}{'APR':>9}{'vs HODL':>10}{'rebal':>7}{'fees$':>9}"
          f"{'gas$':>8}{'swap$':>8}{'inRange':>8}")
    for name, s, excess in rows:
        print(f"  {name:<26}{pct(s['apr']):>9}{pct(excess):>10}{s['rebalances']:>7}"
              f"{s['fees']:>9.2f}{s['gas']:>8.3f}{s['swap']:>8.2f}{s['in_range_pct']*100:>7.1f}%")


def cadence_sweep(symbol, cfg, capital=1000.0):
    """Q2: net APR + keeper gas/yr as a function of the minimum rebalance interval."""
    bars = get(symbol, "1h", 730)
    fm = make_fee_model(cfg, bars)
    hodl = run_hodl(bars, capital=capital).summarize(BARS_PER_YEAR_1H)
    print(f"\n### cadence sweep — {symbol}  (Trailing 5/10, vs HODL APR {pct(hodl['apr'])})")
    print(f"  {'min interval':<14}{'net APR':>9}{'vs HODL':>10}{'rebal/yr':>10}"
          f"{'keeperGas$/yr':>14}{'minDeposit$*':>13}")
    for label, hrs in [("1h", 1), ("4h", 4), ("12h", 12), ("1d", 24), ("3d", 72),
                       ("7d", 168), ("14d", 336), ("30d", 720)]:
        res = run(bars, Trailing(0.05, 0.10), fm, capital=capital, fee_tier=cfg["fee_tier"],
                  slippage_bps=cfg["slippage_bps"], min_interval_bars=hrs)
        s = res.summarize(BARS_PER_YEAR_1H)
        years = len(bars) / BARS_PER_YEAR_1H
        rebal_yr = s["rebalances"] / years
        gas_yr = rebal_yr * costs.gas_usd("rebalance")
        # min deposit at which gross fee APR covers keeper gas/yr: gas_yr / fee_apr_on_capital
        fee_apr_on_cap = (s["fees"] / capital) / years
        min_dep = gas_yr / fee_apr_on_cap if fee_apr_on_cap > 0 else float("inf")
        print(f"  {label:<14}{pct(s['apr']):>9}{pct(s['apr']-hodl['apr']):>10}{rebal_yr:>10.1f}"
              f"{gas_yr:>14.2f}{min_dep:>13.2f}")
    print("  * minDeposit = keeper gas/yr / (gross fee APR on capital); pool-depth dependent, see robustness")


def turnover_sweep(symbol, cfg, capital=1000.0, min_interval_bars=24):
    """THE real robustness test: how the beats-HODL verdict moves with fee intensity (turnover * fee_tier).

    turnover is the one fee-model parameter that does not cancel, so the beats-HODL threshold is a function
    of it. This reports, for a few strategies, APR minus HODL as turnover ranges over an order of magnitude.
    """
    bars = get(symbol, "1h", 730)
    years = len(bars) / BARS_PER_YEAR_1H
    hodl = run_hodl(bars, capital=capital).summarize(BARS_PER_YEAR_1H)
    print(f"\n### turnover sweep — {symbol}  (fee {cfg['fee_tier']*1e4:.0f}bps, HODL APR {pct(hodl['apr'])}, "
          f"base turnover {cfg['turnover']}x)")
    print(f"  {'turnover':<10}{'feeIntensity':>13}{'FullRange':>11}{'PassiveW50':>12}"
          f"{'Trailing5/10':>14}{'LossAware(T)':>14}")
    for t in [50, 100, 200, 365, 500, 730, 1095]:
        fm = FeeModel(fee_tier=cfg["fee_tier"], pool_tvl_quote=cfg["pool_tvl"],
                      turnover_annual=t).calibrate(bars, years)
        out = {}
        for strat in [FullRangeLP(), PassiveWide(0.5), Trailing(0.05, 0.10), LossAware(Trailing(0.05, 0.10))]:
            s = run(bars, strat, fm, capital=capital, fee_tier=cfg["fee_tier"],
                    slippage_bps=cfg["slippage_bps"], min_interval_bars=min_interval_bars).summarize(BARS_PER_YEAR_1H)
            out[strat.name] = s["apr"] - hodl["apr"]
        intensity = t * cfg["fee_tier"]  # annual fee revenue / TVL
        print(f"  {t:<10}{intensity:>12.2f}x{pct(out['full_range_lp']):>11}{pct(out['passive_wide_50pct']):>12}"
              f"{pct(out['trailing_in5_w10']):>14}{pct(out['loss_aware+trailing_in5_w10']):>14}")
    print("  feeIntensity = turnover*feeTier = annual fee revenue / TVL. Beats-HODL turns positive above a threshold.")


def pool_tvl_robustness(symbol, cfg, capital=1000.0, min_interval_bars=24):
    """CHECK (not the main robustness): confirm pool depth analytically cancels for a small LP.

    This is a sanity check that pool_tvl does NOT move the answer — NOT evidence the verdict is robust to the
    fee assumptions (that is turnover_sweep). Included to show the cancellation is real, not asserted.
    """
    bars = get(symbol, "1h", 730)
    hodl = run_hodl(bars, capital=capital).summarize(BARS_PER_YEAR_1H)
    print(f"\n### pool-depth robustness — {symbol} (ranking should be stable)")
    print(f"  {'pool TVL':<12}{'PassiveWide50':>15}{'Trailing5/10':>14}{'LossAware(T)':>14}{'FullRange':>12}")
    years = len(bars) / BARS_PER_YEAR_1H
    for mult in [0.1, 0.5, 1.0, 2.0, 10.0]:
        fm = FeeModel(fee_tier=cfg["fee_tier"], pool_tvl_quote=cfg["pool_tvl"] * mult,
                      turnover_annual=cfg["turnover"]).calibrate(bars, years)
        out = {}
        for strat in [PassiveWide(0.5), Trailing(0.05, 0.10), LossAware(Trailing(0.05, 0.10)), FullRangeLP(0.99)]:
            s = run(bars, strat, fm, capital=capital, fee_tier=cfg["fee_tier"],
                    slippage_bps=cfg["slippage_bps"], min_interval_bars=min_interval_bars).summarize(BARS_PER_YEAR_1H)
            out[strat.name] = s["apr"] - hodl["apr"]
        print(f"  ${cfg['pool_tvl']*mult/1e6:>8.1f}M {pct(out['passive_wide_50pct']):>14}"
              f"{pct(out['trailing_in5_w10']):>14}{pct(out['loss_aware+trailing_in5_w10']):>14}"
              f"{pct(out['full_range_lp']):>12}")


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("all", "panel"):
        for sym, cfg in ASSETS.items():
            print_asset(sym, cfg, min_interval_bars=24)
    if which in ("all", "cadence"):
        for sym in ["ETHUSDC", "SOLUSDC", "PEPEUSDT"]:
            cadence_sweep(sym, ASSETS[sym])
    if which in ("all", "turnover"):
        for sym in ["ETHUSDC", "BTCUSDC", "SOLUSDC", "DOGEUSDT", "PEPEUSDT"]:
            turnover_sweep(sym, ASSETS[sym])
    if which in ("all", "robust"):
        for sym in ["ETHUSDC", "PEPEUSDT"]:
            pool_tvl_robustness(sym, ASSETS[sym])
