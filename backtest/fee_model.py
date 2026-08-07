"""
fee_model.py — how a concentrated position earns fees, from OHLCV.

An LP earns feeTier * (volume through the POOL while price is in its range) * (its share of the active
liquidity at the tick where the trade happens). Three modelling choices, each standard:

  1. Pool volume, not venue volume. The raw Binance series is a whole exchange's turnover; a single
     on-chain pool of size `pool_tvl` sees far less. Using the raw series against a small pool implies an
     impossible turnover (a $3M pool "doing" $30B/yr) and blows fee APR up by orders of magnitude. So the
     series is CALIBRATED: its absolute level is scaled so the pool's annual volume equals
     `turnover_annual * pool_tvl`, while its SHAPE — when volume actually spiked, which is what drives
     in-range capture and recenter timing — is the real market series untouched. turnover_annual is a
     per-pool parameter (majors ~100-400x/yr, memecoins higher). This is the honest way to use real
     volume history for a pool whose absolute size differs from the venue's.

  2. in-range fraction of the bar = overlap of [low,high] with [pa,pb] over (high-low): the share of the
     bar's volume that traded while our position was in range (volume ~ uniform over the bar's territory).

  3. liquidity share = myL / (myL + refL). refL is the pool's other liquidity, from `pool_tvl` at a
     reference width. A narrower range gives our capital a larger myL, so the model correctly rewards
     concentration with a higher fee share — the tension being studied. For a small LP, pool_tvl cancels
     between (1) and (3), so fee APR depends on turnover, fee tier and concentration, NOT on pool size;
     the ranking of strategies is robust to it, which the robustness sweep confirms.
"""
import math
from clmath import liquidity_for_value, range_around

BARS_PER_YEAR_1H = 24 * 365


def in_range_fraction(low, high, close, pa, pb):
    if high <= low:
        return 1.0 if pa <= close <= pb else 0.0
    lo = max(low, pa)
    hi = min(high, pb)
    if hi <= lo:
        return 0.0
    return (hi - lo) / (high - low)


class FeeModel:
    """Turns a bar's volume into fee income for a position, given pool depth and turnover.

    Call calibrate(bars, years) once before use to scale the real volume series to the pool's turnover.
    Without calibration the scale is 1.0 (used by the synthetic unit tests in validate.py).
    """

    def __init__(self, fee_tier, pool_tvl_quote, turnover_annual=None, ref_half_width=0.25):
        self.fee_tier = fee_tier
        self.pool_tvl = pool_tvl_quote
        self.turnover_annual = turnover_annual
        self.ref_half_width = ref_half_width
        self.scale = 1.0

    def calibrate(self, bars, years):
        """Scale the volume series so annual pool volume == turnover_annual * pool_tvl, keeping its shape."""
        if not self.turnover_annual:
            self.scale = 1.0
            return self
        total_raw = sum(b["vol_quote"] for b in bars)
        if total_raw <= 0:
            self.scale = 0.0
            return self
        target_total = self.turnover_annual * self.pool_tvl * years
        self.scale = target_total / total_raw
        return self

    def ref_liquidity(self, price):
        """L of the reference 'rest of pool': pool_tvl quote deployed at +/-ref_half_width around price."""
        pa, pb = range_around(price, self.ref_half_width, geometric=True)
        return liquidity_for_value(price, pa, pb, self.pool_tvl)

    def bar_fee(self, bar, pa, pb, my_liquidity):
        """Fee income (quote) earned by a position [pa,pb] holding my_liquidity over one bar."""
        frac = in_range_fraction(bar["low"], bar["high"], bar["close"], pa, pb)
        if frac <= 0.0 or my_liquidity <= 0.0:
            return 0.0
        refL = self.ref_liquidity(bar["close"])
        share = my_liquidity / (my_liquidity + refL)
        pool_vol = bar["vol_quote"] * self.scale
        return self.fee_tier * pool_vol * frac * share
