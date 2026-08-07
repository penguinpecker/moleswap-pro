# moleswap-pro backtester

Answers the question `learnings.txt` §1.8 calls week-one, load-bearing work, and that F-2 turned into a
blocker: **does auto-recentering a concentrated-liquidity position actually beat just holding, once gas and
swap costs are counted — and at what rebalance cadence?** The dossier's warning is explicit: *"Most
auto-adjusting strategies underperform passive wide ranges once gas and swap costs are included. Get the
numbers before promising an APY."* This gets the numbers, on real data.

**Nothing here is synthetic.** Price and volume are real hourly Binance OHLCV, 2 years (2024-08-03 →
2026-08-03), 17,520 bars per asset, cached under `data/`. Over this window four of the five assets fell and
one rose (HODL total return: ETH −18%, BTC **+2%**, SOL −24%, DOGE −17%, PEPE −33%), so it is a genuine
stress window for LPing, not a bull-market flatter.

## Run it

```bash
python3 -m venv .venv && ./.venv/bin/pip install numpy
./.venv/bin/python validate.py     # prove the math first — 21 checks, must all PASS
./.venv/bin/python fetch_data.py    # refresh the real OHLCV cache (optional; already cached)
./.venv/bin/python summary.py       # full panel + cadence + turnover + pool-depth -> results/results.txt
```

## What it models

| Piece | File | What it does |
|---|---|---|
| CL position math | `clmath.py` | Uniswap v3 closed form: amounts↔liquidity, position value, IL. The same `getLiquidityForAmounts` the contract calls. |
| Fee accrual | `fee_model.py` | fee = feeTier × pool-volume-in-range × liquidity-share. Volume is the real series, calibrated to a realistic pool turnover (see Assumptions). |
| Costs | `costs.py` | Gas from records.txt (rebalance 203,465 @ 0.02 gwei = $0.0102), and the recenter swap (feeTier + slippage on the swapped notional). |
| Strategies | `strategies.py` | full-range, very-wide, passive-wide, trailing, vol-scaled, and the **loss-aware** gate (§1.4's inequality). |
| Engine | `engine.py` | Steps a strategy through the series, accrues fees, computes the real recenter swap, charges gas, marks value. No lookahead: fees for bar *i* accrue on the pre-bar range; rebalances use only info through bar *i*'s close. |
| Validation | `validate.py` | 21 adversarial checks of the math against closed forms and invariants. |

Reviewed adversarially (two independent passes that ran the code): the CL/fee/cost math is closed-form
correct, there is no lookahead, pool depth provably cancels, and HODL is a fair 50/50-basket baseline. The
review also caught real errors in an earlier draft — see *History* at the bottom.

## Assumptions (and how the conclusions depend on them)

1. **Fees are driven by pool turnover, not raw venue volume.** Binance's absolute volume is a whole
   exchange's; a single on-chain pool of size `pool_tvl` sees far less, so the series *level* is calibrated
   to `turnover_annual × pool_tvl` while its *shape* (when volume spiked) is the real market untouched.
   `turnover_annual` is **the one fee-model parameter that does not cancel**, so it is both calibrated to
   real levels (a major pair turns over ~1–2× its TVL/day ≈ 365–730×/yr; memecoins harder) **and swept**
   (`turnover_sweep`). The beats-HODL verdict is a function of fee intensity = `turnover × fee_tier` (annual
   fee revenue / TVL), and that function is reported rather than hidden behind one assumed value.
2. **Fees are banked as realized yield, not re-levered into the pool** — the standard fee-APR + IL
   decomposition. Re-levering creates a feedback loop where a high-yield position compounds until one small
   deposit "owns" a large share of the pool. Banking is conservative for the LP (understates compounding).
3. **Pool depth provably cancels for a small LP** — it appears in both the volume scale and the liquidity
   share and drops out. The `pool_tvl_robustness` run confirms this (identical to the cent across 100×); it
   is a *cancellation check*, not the robustness argument. The robustness argument is the turnover sweep.
4. **HODL means holding the same initial 50/50 basket** the LP started from, isolating the LP decision from
   the one-time entry swap.
5. **The loss-aware IL term is a forward, on-chain-computable estimate** (`move²/(4·width)`), and its horizon
   is a **disclosed, tunable knob** — both the fee and IL terms scale ~linearly in the horizon, so it sets
   how much fixed gas is amortized, not a first-principles constant. Labelled as a heuristic in the code.

## Findings

"Beats HODL" means "gained more / lost less than holding the same 50/50 basket," measured as annualized APR
minus the basket's APR over this 2-year window.

**1. The single most important result: the tight-vs-wide ranking INVERTS with fee intensity. There is no
universally best width — it is a function of `fee intensity = turnover × fee_tier` (annual fee revenue /
TVL).** The turnover sweeps show the crossover directly (APR minus HODL):

| asset (fee) | fee intensity | full-range | passive-±50% | tight-trailing ±10% |
|---|---|---|---|---|
| BTC (5bps) @ 50× | 0.03 | **+0.4%** | −8.0% | −33% |
| ETH (5bps) @ 365× base | 0.18 | **+1.1%** | −10% | −33% |
| BTC (5bps) @ 500× | 0.25 | +3.6% | +6.2% | **+7.9%** |
| SOL (30bps) @ 500× base | 1.50 | +18% | **+47%** | +42% |
| BTC (5bps) @ 1095× | 0.55 | +7.7% | +22% | **+46%** |
| DOGE (100bps) @ 700× base | 7.0 | +96% (worst) | +187% | **+230% (best)** |

Below fee intensity ≈ **0.2**, recentering costs more than its fees: **full-range is best and tight is
worst.** Above it, concentration pays: **tight can be best and full-range worst** (DOGE base: tight +230% is
the top strategy, full-range +96% the bottom). The earlier draft's "wider always beats tighter / tight is
worst on every asset" was **wrong** — true only on thin-fee majors; it flips on memecoins.

**2. A moderately-wide range (±50%) is the most robust single choice.** It is best or near-best across the
middle of the range (SOL base +47%, PEPE base +212%, BTC at 730× +22%), only losing to full-range at very
low intensity and to tight at very high intensity. If the product ships one default width, ±50% is it.

**3. Full-range LP is the downside-safe strategy — and *only* full-range, not "very-wide."** Across the
entire ETH turnover sweep its worst case is −1.0% vs HODL (and it is positive on BTC), and it needs no keeper
at all. The ±99% "very-wide" range does **not** qualify — it is −10% vs HODL on ETH at base, because it is
still concentrated enough to exit and pay recenter costs. The safe default is the genuine full range.

**4. The loss-aware gate reduces losses where recentering doesn't pay, and is a no-op where it does** — the
§1.4 inequality working as intended. On ETH it improves the tight strategies (trailing −33% → −25% vs HODL;
vol-scaled −13% → −8.5%); on SOL/DOGE/PEPE it approves nearly every rebalance and matches the base strategy.
It is worth shipping for upside capture, but it is **not** uniquely downside-safe — full-range is (Finding 3).

**5. F-2, reframed.** The keeper rebalances on *drift*, not every interval — ~12–134×/yr depending on the
minimum interval, because the trailing trigger only fires on a >5% move. So **keeper gas is $0.12/yr (30-day
interval) to ~$1.4/yr (1-hour-floor drift trigger) per position** — nowhere near F-2's per-interval worst
case. And **the recenter swap dominates gas by roughly one to two orders of magnitude** (ETH tight: $2.39
gas vs $18.65 swap over 2y ≈ 8×; DOGE passive-50 ≈ 460×). The keeper's gas was never the constraint; the
swap is. Longer minimum intervals reduce losses on majors and never much hurt memecoins, so the 1-hour
cadence the contract currently permits is never optimal here — resolving the Part-15 conflict toward longer
intervals / drift triggers.

## What this means for the product

- **Range width must be set per asset tier by fee intensity, not globally.** Thin-fee majors want full-range
  (recentering loses); high-fee memecoins (the actual target) want tight, and tight recentering there is the
  *best* strategy, beating hold by +100–230%. The crossover is around fee intensity ≈ 0.2 (annual
  fee-revenue/TVL); tight already beats hold well below memecoin levels (SOL 30bps base: tight +42% vs HODL).
- **If you must ship one default, use a moderately-wide (±50%) range with drift-triggered rebalancing** — it
  is best-or-near-best across the middle and never catastrophic.
- **A genuine full-range passive LP is the downside-safe product** (never worse than ~−1% vs HODL on the
  majors tested) and needs no keeper — good for a conservative tier. "Very-wide" (±99%) is not a substitute.
- **Raise `minRebalanceInterval`** off the 1-hour floor; the data never prefers it. **Bound the keeper's
  swap notional, not just its gas** — the swap is the real cost, and an unbounded-swap keeper can bleed a
  position via churn even though its gas is trivial.
- F-2's minimum-deposit fear is smaller than stated for *gas*, but the *swap* cost and the "no fee
  mechanism" gap remain the real economic issues.

## Caveats

Real price/volume, modelled fees. The fee model is standard but approximate (uniform intrabar volume,
turnover-calibrated level, parameterized pool depth). The *relative* conclusions (within-asset ranking,
swap≫gas, drift-triggered cadence) are robust to the knobs; the *beats-HODL thresholds* are conditional on
fee intensity, which is why the turnover sweep is reported in full rather than a single APR. This is a
decision tool, not a marketing number.

## History

Two rounds of adversarial review (reviewers who ran the code) fixed this, and the core engine math was found
correct and unchanged throughout — the errors were all in calibration and in the written claims.

- **Round 1** caught that the first draft's "every LP strategy loses to HODL on majors" hinged on a too-low
  turnover assumption (150× ≈ $49M/day on a $120M pool, 2–6× below real), that the loss-aware IL term was
  mis-described as √-in-time (it is linear), and that "loss-aware is uniquely safe" was false. Turnover was
  recalibrated and swept; the gate was corrected to project from in-range fee density; a genuine full-range
  baseline was added.
- **Round 2** caught that the *rewrite itself* then over-corrected: it asserted "wider always beats tighter /
  tight is worst on every asset," which its own turnover sweep refutes — the ranking **inverts** above fee
  intensity ≈ 0.2 (tight is the best strategy on memecoins). It also mislabeled DOGE's base row and called
  BTC a falling asset. Findings 1–2 were rewritten around the inversion, with the numbers pinned to output.

The lesson mirrors the contract side of this project: a confident claim that matches a happy-path reading can
still be false, and only an adversary who reruns the numbers catches it.
