"""
costs.py — the cost model that makes this backtest honest.

learnings.txt §1.8: "Most auto-adjusting strategies underperform passive wide ranges once gas and
swap costs are included." So both are modelled explicitly, from measured numbers:

GAS — from records.txt (forge --gas-report over test/attack/*, RH mainnet 0.0200 gwei):
    open      396,996 gas
    rebalance 203,465 gas   (this is the keeper cost the whole F-2 finding is about)
    withdraw  121,491 gas
Gas is paid in the chain's ETH-denominated gas token, so USD cost = gas * gasPrice(gwei) * 1e-9 * ethUsd.
At 0.02 gwei and ETH $2500 a rebalance costs 203465 * 0.02e-9 * 2500 = $0.0102 — matches records.txt.

SWAP — a recenter burns the position and re-mints it centred on the new price, which requires swapping
the surplus token into the deficit token. That swap crosses the pool and pays the LP fee plus slippage
(learnings.txt 07 V2: "each rebalance crosses the spread, pays the LP fee, and converts unrealized IL
into realized loss"). The swapped notional is computed by the engine from the actual token deltas; here
we price it at feeTier + half-spread slippage.
"""

# Measured RH gas (records.txt, 2026-08-04).
GAS = {"open": 396_996, "rebalance": 203_465, "withdraw": 121_491}

DEFAULT_GAS_PRICE_GWEI = 0.0200   # RH mainnet, records.txt
DEFAULT_ETH_USD = 2500.0          # gas token price; swept in the sensitivity run


def gas_usd(op, gas_price_gwei=DEFAULT_GAS_PRICE_GWEI, eth_usd=DEFAULT_ETH_USD):
    return GAS[op] * gas_price_gwei * 1e-9 * eth_usd


def swap_cost(swap_notional_quote, fee_tier, slippage_bps):
    """Cost in quote terms of swapping `swap_notional_quote` worth of tokens during a recenter.

    fee_tier is a fraction (e.g. 0.003 = 30 bps). slippage_bps is extra price impact + spread.
    """
    return swap_notional_quote * (fee_tier + slippage_bps / 10_000.0)
