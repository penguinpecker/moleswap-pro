"""
strategies.py — range-setting policies (learnings.txt §1.4) plus the loss-aware gate (§1.4 differentiator).

A strategy owns ONLY the policy: what range to open, and when/whether to recenter. All mechanics
(value, fees, the recenter swap, costs) live in engine.py, so a strategy cannot accidentally fudge value.

Policies:
  PassiveWide(w)          — wide range, recenter only when price EXITS it. Low IL, low fee density.
  Trailing(inner, w)      — recenter when price drifts > `inner` from the range midpoint. The classic
                            "auto-adjusting" ALM that §1.8 warns usually loses to passive once costs count.
  VolScaled(k, lookback)  — width = k * realized vol: tight in chop, wide in trends.
LossAware(base)           — wraps any policy and blocks a recenter unless the recentered position is
                            projected to earn back gas + swap before the next decision. The one inequality
                            in §1.4: rebalance only when expected fee income > IL-of-moving + gas + swap fee.
"""
import math
from clmath import range_around


class Strategy:
    name = "base"

    def initial_range(self, price):
        raise NotImplementedError

    def target_width(self, ctx):
        """Half-width fraction the policy wants right now (used for recenter sizing)."""
        return self._w

    def wants_rebalance(self, ctx):
        """Policy-level trigger, ignoring cost. Returns (bool, new_pa, new_pb)."""
        raise NotImplementedError


class PassiveWide(Strategy):
    def __init__(self, w=0.5):
        self._w = w
        self.name = f"passive_wide_{int(w*100)}pct"

    def initial_range(self, price):
        return range_around(price, self._w, geometric=True)

    def wants_rebalance(self, ctx):
        # only when price has left the range
        if ctx["in_range"]:
            return False, None, None
        pa, pb = range_around(ctx["price"], self._w, geometric=True)
        return True, pa, pb


class Trailing(Strategy):
    def __init__(self, inner=0.15, w=0.30):
        self._inner = inner
        self._w = w
        self.name = f"trailing_in{int(inner*100)}_w{int(w*100)}"

    def initial_range(self, price):
        return range_around(price, self._w, geometric=True)

    def wants_rebalance(self, ctx):
        pa, pb = ctx["pa"], ctx["pb"]
        mid = math.sqrt(pa * pb)  # geometric midpoint
        drift = abs(math.log(ctx["price"] / mid))
        if drift < math.log(1.0 + self._inner):
            return False, None, None
        npa, npb = range_around(ctx["price"], self._w, geometric=True)
        return True, npa, npb


class VolScaled(Strategy):
    def __init__(self, k=6.0, lookback=168, w_min=0.06, w_max=1.2, inner_frac=0.5):
        self._k = k
        self._lookback = lookback
        self._w_min = w_min
        self._w_max = w_max
        self._inner_frac = inner_frac  # recenter when drift exceeds inner_frac * current width
        self.name = f"vol_scaled_k{int(k)}"

    def _w(self, ctx):
        vol = ctx.get("realized_vol", 0.0)  # per-bar stdev of log returns
        # width scaled to the vol accumulated over the lookback horizon
        w = self._k * vol * math.sqrt(self._lookback)
        return max(self._w_min, min(self._w_max, w))

    def target_width(self, ctx):
        return self._w(ctx)

    def initial_range(self, price):
        return range_around(price, self._w_min, geometric=True)

    def wants_rebalance(self, ctx):
        pa, pb = ctx["pa"], ctx["pb"]
        mid = math.sqrt(pa * pb)
        drift = abs(math.log(ctx["price"] / mid))
        w = self._w(ctx)
        # recenter if we drifted past inner band OR the desired width moved a lot from the current one
        cur_w = math.sqrt(pb / pa) - 1.0
        width_moved = abs(w - cur_w) / max(cur_w, 1e-9)
        if drift < self._inner_frac * math.log(1.0 + w) and width_moved < 0.5:
            return False, None, None
        npa, npb = range_around(ctx["price"], w, geometric=True)
        return True, npa, npb


class LossAware(Strategy):
    """Wrap a base policy: only recenter when projected fees over the next horizon beat gas + swap.

    This operationalizes §1.4's inequality. `ctx` carries a live estimate of the position's recent fee
    rate (quote/bar) and the concrete gas+swap cost the engine computed for THIS recenter. We project the
    recentered (typically tighter, re-centred) position's fee rate over `horizon_bars` and require it to
    exceed the cost with a margin. Concentration lift = how much higher the new range's fee density is.
    """
    def __init__(self, base, horizon_bars=24 * 365, margin=1.0):
        # Evaluate profitability on an annual horizon. NOTE: both terms below scale ~linearly in the
        # horizon H (projected fees = rate*H; expected IL = rv^2*H/(4w), capped), so H does not change
        # their ratio — it only sets how much the fixed gas+swap is amortised. The horizon is therefore a
        # DISCLOSED, TUNABLE knob, not a first-principles constant; annual gives the right directional
        # behaviour (approve where fee-density dominates IL, veto where it doesn't) but the precise APR is
        # tuning-sensitive. This gate is pitched on upside capture at high fee density, NOT as uniquely
        # downside-safe — a very-wide passive range is the downside-safe default and needs no keeper.
        self.base = base
        self.horizon = horizon_bars
        self.margin = margin
        self.name = f"loss_aware+{base.name}"

    def initial_range(self, price):
        return self.base.initial_range(price)

    def target_width(self, ctx):
        return self.base.target_width(ctx)

    def wants_rebalance(self, ctx):
        want, npa, npb = self.base.wants_rebalance(ctx)
        if not want:
            return False, None, None
        # The §1.4 inequality: recenter only when expected fee income of the new range over the holding
        # horizon exceeds realized IL of moving + gas + swap. All three terms are estimates the CONTRACT
        # could actually compute on-chain (recent fee rate, realized vol, the concrete gas+swap), which is
        # what makes this a faithful model of the gate rather than hindsight.
        recent_rate = ctx.get("recent_fee_rate", 0.0)          # in-range fee density (quote per in-range bar)
        lift = ctx.get("concentration_lift", 1.0)              # >= 1 when the new range is tighter/centred
        projected_fees = recent_rate * lift * self.horizon
        cost = ctx.get("recenter_cost", 0.0)                   # gas + swap, in quote, for this move
        expected_il = ctx.get("expected_il", 0.0)              # expected IL of holding the NEW range over the horizon
        if projected_fees < self.margin * (expected_il + cost):
            return False, None, None
        return True, npa, npb


# Baselines handled specially by the engine (not concentrated recentering policies):
class FullRangeLP(Strategy):
    """A genuinely full-range (v2-like) position that never needs recentering — the passive-LP baseline.

    w=50 => pa=P/51, pb=P*51, i.e. -98%/+5000%, which for these assets' 2-year paths is effectively the
    full range (always in range), so it reproduces constant-product IL (validate.py checks this identity).
    """
    def __init__(self, w=50.0):
        self._w = w
        self.name = "full_range_lp"

    def initial_range(self, price):
        return range_around(price, self._w, geometric=True)

    def wants_rebalance(self, ctx):
        return False, None, None


class VeryWideLP(Strategy):
    """A wide but finite +/-99%/-50% range — wider than passive-50 but still concentrated enough to exit."""
    def __init__(self, w=0.99):
        self._w = w
        self.name = "very_wide_99pct"

    def initial_range(self, price):
        return range_around(price, self._w, geometric=True)

    def wants_rebalance(self, ctx):
        if ctx["in_range"]:
            return False, None, None
        pa, pb = range_around(ctx["price"], self._w, geometric=True)
        return True, pa, pb
