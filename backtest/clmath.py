"""
clmath.py — Uniswap v3 / v4 concentrated-liquidity position math, closed form.

Conventions (fixed once, used everywhere):
  * token0 = base (e.g. ETH),  token1 = quote (e.g. USDC).
  * price P = quote per base = amount1 / amount0. A position's range is [pa, pb] with pa < pb,
    both expressed as prices P.
  * "value" always means value in QUOTE terms: value = amount0 * P + amount1.

These are the standard v3 formulas (Uniswap v3 whitepaper §6, and the canonical LiquidityAmounts
library the contract itself calls — MolePositions uses LiquidityAmounts.getLiquidityForAmounts). The
on-chain code works in Q64.96 fixed point; here we use float64 because the backtest asks a relative,
economic question (does recentering beat holding after costs), not a wei-exact one. Every function is
checked against its closed form in validate.py, including the classic IL identity.
"""
import math


def amounts_for_liquidity(P, pa, pb, L):
    """Token amounts (amount0 in base, amount1 in quote) held by liquidity L over [pa,pb] at price P."""
    if pa > pb:
        pa, pb = pb, pa
    sp = math.sqrt(P)
    spa = math.sqrt(pa)
    spb = math.sqrt(pb)
    if P <= pa:
        # entirely token0 (base)
        amount0 = L * (1.0 / spa - 1.0 / spb)
        amount1 = 0.0
    elif P >= pb:
        # entirely token1 (quote)
        amount0 = 0.0
        amount1 = L * (spb - spa)
    else:
        amount0 = L * (1.0 / sp - 1.0 / spb)
        amount1 = L * (sp - spa)
    return amount0, amount1


def liquidity_for_amounts(P, pa, pb, amount0, amount1):
    """Liquidity L obtainable from (amount0, amount1) over [pa,pb] at price P. Rounds to the binding leg."""
    if pa > pb:
        pa, pb = pb, pa
    sp = math.sqrt(P)
    spa = math.sqrt(pa)
    spb = math.sqrt(pb)
    if P <= pa:
        return amount0 * (spa * spb) / (spb - spa)
    elif P >= pb:
        return amount1 / (spb - spa)
    else:
        l0 = amount0 * (sp * spb) / (spb - sp)
        l1 = amount1 / (sp - spa)
        return min(l0, l1)


def position_value(P, pa, pb, L):
    """Value of liquidity L over [pa,pb] at price P, in quote terms."""
    a0, a1 = amounts_for_liquidity(P, pa, pb, L)
    return a0 * P + a1


def liquidity_for_value(P, pa, pb, value):
    """L such that a position over [pa,pb] opened at price P is worth `value` in quote terms.

    Value is linear in L, so compute the unit-L value once and scale. This is how the engine turns
    "I have V dollars to deploy into this range at this price" into a concrete position.
    """
    unit = position_value(P, pa, pb, 1.0)
    if unit <= 0:
        return 0.0
    return value / unit


def range_around(P, half_width_frac, geometric=True):
    """A range centred on price P. half_width_frac=0.5 => roughly +/-50%.

    geometric=True gives pa=P/(1+w), pb=P*(1+w): symmetric in log-price, which is how v3 ticks work.
    """
    w = half_width_frac
    if geometric:
        return P / (1.0 + w), P * (1.0 + w)
    return P * (1.0 - w), P * (1.0 + w)


def in_range(P, pa, pb):
    return pa <= P <= pb


def hodl_value(P, amount0_0, amount1_0):
    """Value now, in quote, of simply having held the initial token amounts."""
    return amount0_0 * P + amount1_0


def il_vs_hodl_fullrange(price_ratio):
    """Closed-form impermanent loss for a FULL-RANGE (v2-style) position, as a fraction (<=0).

    price_ratio = P_now / P_start. IL = 2*sqrt(r)/(1+r) - 1. Used only to validate the general
    engine against a known identity; the engine itself handles concentrated ranges numerically.
    """
    r = price_ratio
    return 2.0 * math.sqrt(r) / (1.0 + r) - 1.0
