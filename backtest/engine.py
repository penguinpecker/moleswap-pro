"""
engine.py — step a strategy through a real price/volume series and account for everything.

Per bar:
  1. Accrue fees for the bar into a fee bank (quote), from the fee model.
  2. Ask the strategy whether to recenter. If yes and the min interval has elapsed, compute the ACTUAL
     recenter: redeem the position at the current price, add the fee bank, work out the token swap needed
     to re-centre, charge that swap (feeTier + slippage) and the rebalance gas, and re-mint. Fees compound
     into the new position, exactly as the contract does (rebalance conserves amounts, fees ride inside).
  3. Record mark-to-market value = position value + fee bank.

The realized IL is not a separate charge — it is already in the position value math: a recentred position
that the price then moves away from is worth less than HODL, and the engine marks that automatically. The
explicit charges are the two the dossier says people forget: swap cost and gas.

Returns a Result with the value path and a summary (net APR, #rebalances, fees, gas, swap, in-range%).
"""
import math
from clmath import (amounts_for_liquidity, liquidity_for_value, position_value,
                    hodl_value, in_range)
from fee_model import FeeModel
import costs

BARS_PER_YEAR_1H = 24 * 365


class Result:
    def __init__(self, name):
        self.name = name
        self.values = []       # mark-to-market value per bar (quote)
        self.rebalances = 0
        self.blocked_rebalances = 0   # loss-aware vetoes
        self.fees = 0.0
        self.gas = 0.0
        self.swap = 0.0
        self.in_range_bars = 0
        self.bars = 0
        self.start_value = 0.0

    def summarize(self, bars_per_year):
        end = self.values[-1] if self.values else 0.0
        n = len(self.values)
        years = n / bars_per_year if n else 1.0
        total_ret = (end / self.start_value - 1.0) if self.start_value else 0.0
        apr = ((end / self.start_value) ** (1.0 / years) - 1.0) if (self.start_value > 0 and years > 0) else 0.0
        return {
            "strategy": self.name,
            "start": self.start_value,
            "end": end,
            "total_return": total_ret,
            "apr": apr,
            "rebalances": self.rebalances,
            "blocked_rebalances": self.blocked_rebalances,
            "fees": self.fees,
            "gas": self.gas,
            "swap": self.swap,
            "cost_total": self.gas + self.swap,
            "in_range_pct": (self.in_range_bars / self.bars) if self.bars else 0.0,
        }


def realized_vol(bars, i, lookback):
    """Per-bar stdev of log returns over the trailing `lookback` bars ending at i."""
    j0 = max(1, i - lookback + 1)
    rs = []
    for j in range(j0, i + 1):
        p0 = bars[j - 1]["close"]
        p1 = bars[j]["close"]
        if p0 > 0 and p1 > 0:
            rs.append(math.log(p1 / p0))
    if len(rs) < 2:
        return 0.0
    m = sum(rs) / len(rs)
    var = sum((r - m) ** 2 for r in rs) / (len(rs) - 1)
    return math.sqrt(var)


def run(bars, strategy, fee_model, *, capital=1000.0, fee_tier=0.003, slippage_bps=5.0,
        min_interval_bars=24, gas_price_gwei=costs.DEFAULT_GAS_PRICE_GWEI, eth_usd=costs.DEFAULT_ETH_USD,
        vol_lookback=168, bars_per_year=BARS_PER_YEAR_1H, fee_rate_window=168):
    """Run one strategy over `bars`. capital is the starting quote value of a 50/50 basket."""
    res = Result(strategy.name)
    res.start_value = capital

    P0 = bars[0]["close"]
    pa, pb = strategy.initial_range(P0)
    # Deploy the full capital (a 50/50 basket, so a centred range needs ~no entry swap) into the range.
    L = liquidity_for_value(P0, pa, pb, capital)
    # Fees are BANKED as realized yield, not re-levered into pool liquidity. Re-levering creates a
    # feedback loop — a high-yield position compounds until a single small deposit "owns" a large share
    # of the pool, which is unphysical and blows fee APR up super-linearly. Banking gives the standard
    # fee-APR + IL decomposition and keeps the position a realistic (small, stable) share of the pool.
    banked = 0.0
    last_rebalance = 0
    recent_fees = []   # rolling window of per-bar fee income
    recent_flags = []  # parallel window of in-range flags, so the gate can use IN-RANGE fee density

    for i, bar in enumerate(bars):
        P = bar["close"]
        res.bars += 1
        here_in_range = in_range(P, pa, pb)
        if here_in_range:
            res.in_range_bars += 1

        # 1. fees for the bar -> banked as realized yield
        fee = fee_model.bar_fee(bar, pa, pb, L)
        banked += fee
        res.fees += fee
        recent_fees.append(fee)
        recent_flags.append(here_in_range)
        if len(recent_fees) > fee_rate_window:
            recent_fees.pop(0)
            recent_flags.pop(0)

        # 2. rebalance? The POLICY trigger (unwrapped from any loss-aware gate) proposes a candidate;
        #    the loss-aware gate, if present, then vetoes it using the concrete cost computed below.
        rv = realized_vol(bars, i, vol_lookback)
        ctx = {"price": P, "pa": pa, "pb": pb, "in_range": in_range(P, pa, pb), "realized_vol": rv}
        base_policy = strategy.base if hasattr(strategy, "base") else strategy
        want, npa, npb = base_policy.wants_rebalance(ctx)

        if want and (i - last_rebalance) >= min_interval_bars:
            # concrete redemption of the PRINCIPAL at P (banked fees stay banked, not re-levered).
            a0, a1 = amounts_for_liquidity(P, pa, pb, L)
            principal = a0 * P + a1

            # target token split for the new range at P.
            L_new_pre = liquidity_for_value(P, npa, npb, principal)
            a0_new, _a1_new = amounts_for_liquidity(P, npa, npb, L_new_pre)

            # swap needed to re-centre: the change in base-side value must cross the pool. Notional is
            # the quote value of the tokens swapped; it is charged feeTier + slippage.
            swap_notional = abs(a0 * P - a0_new * P)
            swap_c = costs.swap_cost(swap_notional, fee_tier, slippage_bps)
            gas_c = costs.gas_usd("rebalance", gas_price_gwei, eth_usd)

            proceed = True
            if hasattr(strategy, "base"):  # loss-aware wrapper: apply the §1.4 inequality
                # Project fees for the NEW (re-centred, in-range) range from the fee density earned on
                # recent IN-RANGE bars — not the current position's stale rate, which is suppressed toward
                # zero precisely when the position is out of range and a recenter is most warranted.
                inrange_n = sum(recent_flags)
                if inrange_n > 0:
                    recent_rate = sum(f for f, ir in zip(recent_fees, recent_flags) if ir) / inrange_n
                else:
                    recent_rate = (sum(recent_fees) / len(recent_fees)) if recent_fees else 0.0
                cur_w = math.sqrt(pb / pa) - 1.0
                new_w = math.sqrt(npb / npa) - 1.0
                lift = max(1.0, cur_w / max(new_w, 1e-9))  # tighter new range -> higher fee density
                # Expected IL of holding the NEW range over the horizon. Price moves ~sigma*sqrt(horizon),
                # and concentrated-position divergence loss ~ move^2/(4w) = sigma^2 * horizon / (4w) — i.e.
                # LINEAR in the horizon, then capped at a heuristic 25% for a fully-exited range. Projected
                # fees are also linear in the horizon, so the horizon does NOT change their ratio; it only
                # sets how much the fixed gas+swap is amortized (a disclosed, tunable knob, see LossAware).
                # This is the term the dossier's inequality names ("realized IL of moving").
                horizon = getattr(strategy, "horizon", BARS_PER_YEAR_1H)
                move = rv * math.sqrt(horizon)
                il_frac = min(0.25, (move ** 2) / (4.0 * max(new_w, 1e-9)))
                expected_il = principal * il_frac
                ctx2 = {**ctx, "recent_fee_rate": recent_rate, "concentration_lift": lift,
                        "recenter_cost": gas_c + swap_c, "expected_il": expected_il}
                proceed, _, _ = strategy.wants_rebalance(ctx2)

            if not proceed:
                res.blocked_rebalances += 1
            else:
                # Costs are paid out of principal (burn, pay gas from proceeds, re-mint slightly less).
                new_principal = max(0.0, principal - swap_c - gas_c)
                L = liquidity_for_value(P, npa, npb, new_principal)
                pa, pb = npa, npb
                res.gas += gas_c
                res.swap += swap_c
                res.rebalances += 1
                last_rebalance = i

        res.values.append(position_value(P, pa, pb, L) + banked)

    return res


def run_hodl(bars, *, capital=1000.0, bars_per_year=BARS_PER_YEAR_1H):
    """Hold the same initial 50/50 basket. No fees, no costs — the honest thing an LP is beaten against."""
    res = Result("hodl_5050")
    res.start_value = capital
    P0 = bars[0]["close"]
    base = (capital / 2.0) / P0
    quote = capital / 2.0
    for bar in bars:
        res.bars += 1
        res.values.append(hodl_value(bar["close"], base, quote))
    return res
