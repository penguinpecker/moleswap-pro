"""
validate.py — prove the backtest's math before trusting a single result it produces.

learnings.txt §1.8 warns that a wrong backtest gives a confidently wrong product decision ("get the
numbers before promising an APY"). So the concentrated-liquidity math, the IL behaviour, the fee model
and the engine's conservation are checked against closed forms and known invariants here. Run this first;
if anything prints FAIL, no downstream number is trustworthy.
"""
import math
from clmath import (amounts_for_liquidity, liquidity_for_amounts, position_value,
                    liquidity_for_value, range_around, hodl_value, il_vs_hodl_fullrange, in_range)
from fee_model import FeeModel, in_range_fraction
from engine import run, run_hodl
import costs

FAILS = []


def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    if not cond:
        FAILS.append(name)
    print(f"  [{tag}] {name}" + (f"  — {detail}" if detail and not cond else ""))


def approx(a, b, tol=1e-6):
    return abs(a - b) <= tol * max(1.0, abs(a), abs(b))


def test_boundaries():
    P, pa, pb, L = 100.0, 80.0, 125.0, 1000.0
    # price at/below lower -> all base (token0), amount1 == 0
    a0, a1 = amounts_for_liquidity(pa - 1, pa, pb, L)
    check("below range -> all token0", a1 == 0.0 and a0 > 0)
    # price at/above upper -> all quote (token1), amount0 == 0
    a0, a1 = amounts_for_liquidity(pb + 1, pa, pb, L)
    check("above range -> all token1", a0 == 0.0 and a1 > 0)


def test_roundtrip():
    P, pa, pb, L = 100.0, 64.0, 156.25, 500.0
    a0, a1 = amounts_for_liquidity(P, pa, pb, L)
    L2 = liquidity_for_amounts(P, pa, pb, a0, a1)
    check("liquidity<->amounts round trip", approx(L, L2, 1e-9), f"{L} vs {L2}")


def test_value_linear_in_L():
    P, pa, pb = 100.0, 70.0, 140.0
    v1 = position_value(P, pa, pb, 1.0)
    v7 = position_value(P, pa, pb, 7.0)
    check("value linear in L", approx(v7, 7.0 * v1))


def test_liquidity_for_value():
    P, pa, pb = 100.0, 70.0, 140.0
    L = liquidity_for_value(P, pa, pb, 1000.0)
    check("liquidity_for_value hits target", approx(position_value(P, pa, pb, L), 1000.0))


def test_il_is_a_loss_and_zero_at_start():
    # A symmetric LP is worth <= HODL for any price != start, and == HODL at start.
    P0, pa, pb = 100.0, 50.0, 200.0
    L = liquidity_for_value(P0, pa, pb, 1000.0)
    a0_0, a1_0 = amounts_for_liquidity(P0, pa, pb, L)
    worst = 0.0
    ok = True
    for P in [60, 70, 80, 90, 100, 110, 130, 160, 190]:
        lp = position_value(P, pa, pb, L)
        hd = hodl_value(P, a0_0, a1_0)
        il = lp - hd
        worst = min(worst, il)
        if P == 100:
            ok = ok and approx(lp, hd, 1e-6)
        else:
            ok = ok and (il <= 1e-6)
    check("IL <= 0 off-start and == 0 at start", ok, f"worst IL {worst:.4f}")


def test_nearfullrange_matches_v2_IL():
    # A near-full-range position should track the constant-product IL formula 2*sqrt(r)/(1+r)-1.
    P0 = 100.0
    pa, pb = P0 * 1e-6, P0 * 1e6
    L = liquidity_for_value(P0, pa, pb, 1000.0)
    a0_0, a1_0 = amounts_for_liquidity(P0, pa, pb, L)
    ok = True
    for r in [0.5, 0.8, 1.25, 2.0, 4.0]:
        P = P0 * r
        lp = position_value(P, pa, pb, L)
        hd = hodl_value(P, a0_0, a1_0)
        model_il = (lp - hd) / hd
        closed = il_vs_hodl_fullrange(r)
        ok = ok and approx(model_il, closed, 2e-3)
    check("near-full-range IL matches v2 closed form", ok)


def test_tighter_range_more_liquidity():
    # Same capital, tighter range -> more liquidity (higher fee density) AND more IL for a given move.
    P0 = 100.0
    wide_a, wide_b = range_around(P0, 0.5)
    tight_a, tight_b = range_around(P0, 0.1)
    Lw = liquidity_for_value(P0, wide_a, wide_b, 1000.0)
    Lt = liquidity_for_value(P0, tight_a, tight_b, 1000.0)
    check("tighter range -> more liquidity per $", Lt > Lw, f"tight {Lt:.2f} vs wide {Lw:.2f}")
    # IL at +8% move
    P = P0 * 1.08
    a0w, a1w = amounts_for_liquidity(P0, wide_a, wide_b, Lw)
    a0t, a1t = amounts_for_liquidity(P0, tight_a, tight_b, Lt)
    il_w = position_value(P, wide_a, wide_b, Lw) - hodl_value(P, a0w, a1w)
    il_t = position_value(P, tight_a, tight_b, Lt) - hodl_value(P, a0t, a1t)
    check("tighter range -> more IL for same move", il_t < il_w, f"tight {il_t:.3f} vs wide {il_w:.3f}")


def test_fee_model_bounds():
    fm = FeeModel(fee_tier=0.003, pool_tvl_quote=1_000_000)
    # in-range fraction basics
    check("in_range_fraction full when bar inside", approx(in_range_fraction(95, 105, 100, 90, 110), 1.0))
    check("in_range_fraction zero when bar outside", in_range_fraction(120, 130, 125, 90, 110) == 0.0)
    check("in_range_fraction partial overlap",
          approx(in_range_fraction(100, 120, 110, 90, 110), 0.5))
    # fee is zero out of range, positive in range, and share in (0,1)
    bar_out = {"low": 200, "high": 210, "close": 205, "vol_quote": 1e6}
    bar_in = {"low": 99, "high": 101, "close": 100, "vol_quote": 1e6}
    pa, pb = range_around(100, 0.2)
    L = liquidity_for_value(100, pa, pb, 1000.0)
    check("fee 0 when out of range", fm.bar_fee(bar_out, pa, pb, L) == 0.0)
    f_in = fm.bar_fee(bar_in, pa, pb, L)
    share = L / (L + fm.ref_liquidity(100))
    check("fee positive in range", f_in > 0)
    check("fee share in (0,1)", 0 < share < 1, f"share {share:.4f}")


def test_flat_price_earns_only_fees():
    # A perfectly flat price series: no IL, no rebalance triggers; value = capital + accrued fees.
    bars = [{"ts": i, "open": 100, "high": 100, "low": 100, "close": 100,
             "vol_base": 1000, "vol_quote": 100_000, "trades": 100} for i in range(500)]
    from strategies import PassiveWide
    fm = FeeModel(fee_tier=0.003, pool_tvl_quote=1_000_000)
    res = run(bars, PassiveWide(0.5), fm, capital=1000.0, min_interval_bars=24)
    end = res.values[-1]
    check("flat price: zero rebalances", res.rebalances == 0)
    check("flat price: end == capital + fees",
          approx(end, 1000.0 + res.fees, 1e-6), f"end {end:.4f} vs {1000.0 + res.fees:.4f}")
    check("flat price: fees strictly positive", res.fees > 0)


def test_no_fee_lp_underperforms_hodl_on_trend():
    # Monotonic up-trend, fees off, no rebalance: LP must underperform HODL by IL, but stay positive.
    bars = [{"ts": i, "open": 100 + i, "high": 100 + i, "low": 100 + i, "close": 100.0 + i,
             "vol_base": 0, "vol_quote": 0.0, "trades": 0} for i in range(300)]
    from strategies import PassiveWide
    fm = FeeModel(fee_tier=0.003, pool_tvl_quote=1_000_000)
    lp = run(bars, PassiveWide(2.0), fm, capital=1000.0, min_interval_bars=10**9)  # never rebalance
    hd = run_hodl(bars, capital=1000.0)
    check("no-fee LP <= HODL on trend", lp.values[-1] <= hd.values[-1] + 1e-6,
          f"lp {lp.values[-1]:.2f} hodl {hd.values[-1]:.2f}")
    check("LP still solvent/positive", lp.values[-1] > 0)


def test_gas_matches_records():
    # records.txt: rebalance 203,465 gas @ 0.02 gwei, ETH 2500 -> $0.0102.
    g = costs.gas_usd("rebalance", 0.02, 2500.0)
    check("rebalance gas == $0.0102 @ ETH2500", approx(g, 0.010173, 1e-4), f"${g:.6f}")


def main():
    print("clmath / fee model / engine validation")
    for t in [test_boundaries, test_roundtrip, test_value_linear_in_L, test_liquidity_for_value,
              test_il_is_a_loss_and_zero_at_start, test_nearfullrange_matches_v2_IL,
              test_tighter_range_more_liquidity, test_fee_model_bounds, test_flat_price_earns_only_fees,
              test_no_fee_lp_underperforms_hodl_on_trend, test_gas_matches_records]:
        t()
    print()
    if FAILS:
        print(f"VALIDATION FAILED: {len(FAILS)} check(s) — {FAILS}")
        raise SystemExit(1)
    print("ALL VALIDATION CHECKS PASSED")


if __name__ == "__main__":
    main()
