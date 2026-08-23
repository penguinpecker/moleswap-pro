# MoleQueue fail-closed completeness — audit, tests, decision memo

**Scope.** `src/MoleQueue.sol` as deployed behind the live UUPS proxy `0x3dCb2494…DEbd` (RH 4663; epoch 300 s,
freeze 60 s, maxEpochLife 3600 s, TWAP window 1800 s, band 600 ticks, residual 300 bps), read in full and mapped
against the dossier's clearing-price guard block (P-49), the deferral policy (P-56, FLOW-3 D1-D5, C-7), the
internal-cross fee (C-3), the post-freeze immunity invariant (P-53 / FLOW-3 inv (f)) and Part 17.4/17.5.
**Evidence:** `test/attack/AttackQueueFailClosed.t.sol` — 20 tests against the real PoolManager + real MoleHook
oracle + proxied MoleQueue. 17 green, **3 RED on purpose** (`test_MISSING_*`, one per missing guard). Every
PRESENT guard was mutation-verified (guard deleted → test red → restored); the table at the end lists each kill,
and the depth test was additionally run under four candidate patches to prove which of them it can tell apart.
`src/` was not changed; every patch below is a proposal.
**Live reads (RH 4663, 2026-08-22, read-only):** hook `0xb2c9A0af…38C4` `restrictedLiquidity() = false` — anyone may
add liquidity to the queue's pool; pool `0x9aca9d2f…d029` slot0 tick −200,461, in-range liquidity 5.9e12
(`extsload` of the pool's liquidity slot); queue `currentEpoch = 2`, band 600.

Green gate for CI while the three guards are missing: `forge test --no-match-test MISSING_`.

---

## 1. The guard block, requirement by requirement

| # | Requirement (dossier) | Status | Where (file:line) | Test | Risk if absent | Minimal patch |
|---|---|---|---|---|---|---|
| 1 | Window coverage proof | **PRESENT** (in the oracle) | `MoleQueue.sol:286` → `MoleHook.sol:548-619` (`consult` reverts `PoolNotInitialized` / `InsufficientObservations` when no observation is older than `now - window`) | `test_coverage_anUncoveredWindowIsRefusedUntilTheRingCoversIt` (M1 killed) | — | none |
| 2 | Observation count + **staleness fail-closed** | **MISSING** | nothing reads `poolStates(id).lastObsTimestamp` / the ring depth; `consult` extends the last tick to now (`MoleHook.sol:568`) so an idle pool always answers | `test_MISSING_staleness_anIdleSeedOnlyPoolThirtyDaysOldIsAcceptedAsTheAnchor` (RED: a single 30-day-old seed observation anchors a 100e18 ⇄ 100e18 cross) | A pool nobody trades is detached from the market; its last tick prices every batch. On a pool whose only flow is the queue, whoever reacts to the outside market last crosses at a price the pool never discovered | Queue-side, no hook change: extend `IMoleOracle` with `poolStates(PoolId) returns (uint16,uint32,uint32,int24,int56,bool)` (the getter already exists on the hook) and in `settle()` after line 286: `(, , uint32 lastObs, , , ) = oracle.poolStates(id); if (block.timestamp - lastObs > maxAnchorAge) revert AnchorStale();` with `maxAnchorAge` a new storage param (append after `upgradeAdmin`, `MoleQueue.sol:200`). Suggested live value ≥ `twapWindow` (1800 s) and ≤ `maxEpochLife`; the queue's own residual swaps keep a live pool fresh. Min-observation count is optional and costs up to 256 SLOADs; the age bound is what matters |
| 3 | TWAP-vs-spot deviation band | **PRESENT** (both signs) | `MoleQueue.sol:291-293` | `test_band_spotBelowTheAnchorIsRefusedInsideTheStrictWindow`, `test_band_spotAboveTheAnchorIsRefusedEvenPastTheDeadline_andTimeoutIsTheOnlyDoor` (M2 killed both) | — | none. Note the band is never refund-eligible (it sits outside the try/catch), so a band trip past the deadline leaves `timeout()` as the only door — tested |
| 4 | Max jump vs last clearing | **MISSING** | no `lastClearingTick` storage; `settle` compares to nothing but spot | `test_MISSING_maxJump_aClearingTwentyThousandTicksFromTheLastOneIsAccepted` (RED: epoch 0 clears at ~0, epoch 1 clears 19,999 ticks away with no refusal; bob's 100e18 token0 fetched 13.53e18 token1) | The queue-side analogue of the vault's `maxRecenterTicks` — a bound that reads something the attacker cannot move for free. Without it, a walked anchor that also drags spot passes the band | Append `int24 lastClearingTick; bool hasCleared; int24 maxClearingJumpTicks;` after line 200; in `settle()` after the band check: `if (hasCleared) { int24 j = tick > lastClearingTick ? tick - lastClearingTick : lastClearingTick - tick; if (j > maxClearingJumpTicks) revert ClearingJumpedTooFar(); }` and write `lastClearingTick = tick; hasCleared = true;` where `ep.phase = Phase.Settled` is set (line 340). Must be fail-closed, i.e. the epoch then resolves by `timeout()` in kind — a genuine 50% market move between epochs ends in an in-kind refund, which is what P-49 RISK specifies ("roll the epoch, never route at spot"). Slows a patient walker: he can step < maxJump per cleared epoch, and a self-cross of his own two addresses (free under C-3, §2) is enough to advance the reference; each step also needs a full window of parked spot for the anchor to follow, so with maxJump = 600 a 20,000-tick walk costs ≥ 34 windows (≥ 17 h live) of a visibly parked pool. Does not stop him — and neither does a spot depth floor (#5); the JIT-proof options are in #5 |
| 5 | Depth / min-liquidity at the clearing tick | **MISSING** | nothing reads `StateLibrary.getLiquidity(poolManager, id)` or any harmonic-mean liquidity | `test_MISSING_depth_aFreeTwapWalkIntoZeroLiquidityClearsTheBatchAtTheWalkedPrice` (RED — **F-4 replayed against the queue**, in TWO ARMS from one frozen state. The walk: one limited-price swap exhausts the 60-tick band and parks spot at tick −20,000 with ZERO in-range liquidity; after one window TWAP = spot, drift 0. **Arm A — one-block depth:** the walker drops the band's own depth (100,000e18 at [−20,020, −19,980]) around the parked tick in the freeze block and again in the settle block, removing it the same block; `getLiquidity` reads 100,000e18 at settle, the dust residual fills, and the FIRST epoch crosses alice's 100e18 token0 (worth ~100e18 token1) for 13.53e18 token1 **in the STRICT window, no deadline wait**; the attacker takes 100.007e18 token0; the position's net is −7.37e15 token0 / +1.0e15 token1 — the dust trade only. **Arm B — no depth:** the same batch clears on the lenient path at the deadline, 13.53e18 for 100e18, attacker takes all 100e18; the walk pushed 301e18 token0 through the band at ~par, recoverable the same way) | **The highest-value finding here.** The crossed portion is priced at an anchor that can be parked anywhere there is no liquidity, for the cost of two LP fees on the band's capacity. The live pool is one thin concentrated region (in-range liquidity 5.9e12 at tick −200,461 on 2026-08-22) so zero-liquidity regions exist beyond it, and `restrictedLiquidity` is **false** live, so the one-block position of arm A is open to anyone, not only to allowlisted LPs. Practical constraint on live params: the walk must be in place ≥ `twapWindow − freezeDuration` = 1740 s before the cutoff — longer than the 300 s epoch — so victims queue against a visibly parked spot; the band then still lets the clearing sit up to 600 ticks (~6%) from spot, and a walker can move the anchor ~7% per epoch without ever tripping the band. Fail-closed is absent either way | **Re-graded: the obvious patch is PARTIAL, not a fix.** (1) A spot floor — `if (StateLibrary.getLiquidity(poolManager, key.toId()) < minClearingLiquidity) revert InsufficientDepth();` next to the band, `minClearingLiquidity` appended after line 200 — is **JIT-bypassable at ~zero cost**: the walker, or any settler (settle is permissionless), adds floor-sized liquidity around the parked tick in the settle block and removes it after; measured cost = the dust residual trade (−7.37e15 / +1.0e15 on a 100e18 theft). It raises the bar only to *floor-sized capital for one block* (flash-loanable). Arm A keeps the RED test red under it (verified: V1). (2) Sampling depth at `freeze()` as well and requiring both samples ≥ floor is the same thing twice: two one-block positions satisfy both (arm A does exactly this; verified: V2). (3) **What would be JIT-proof — i.e. what arm A cannot satisfy:** (i) *time-weighted depth over the settlement window* — P-8's `harmonicMeanLiquidity(id, window, lag)`, spec'd and not built — needs `secondsPerLiquidityCumulativeX128` in the hook's `Observation` (P-7): hook code, which the dossier files as new hook address = pool migration (HANDOFF register note) and whose ring must re-warm either way; the bypass then costs floor-sized capital held at an off-market tick for the whole window (1800 s live), arb-exposed, not flash-loanable. (ii) *a reference the walker cannot place* — and none is available today: NOT the vault's position range (`MolePositions.open()` is permissionless with a caller-chosen range, so the walker opens a vault position at the parked tick; and HANDOFF's 2026-08-22 read has vault custody at 0/0 of both tokens, so there is no protocol-owned range to refer to today); NOT `restrictedLiquidity` (false live, set only at initialize — no setter — and flipping it is the regime that creates F-4's zero-liquidity regions). (iii) #4 max-jump + #2 staleness read no liquidity, so they are not JIT-able, but they are walkable (row 4: ≥ 17 h per 20,000 ticks, visible) — they slow, they do not stop. **Recommendation:** do not ship the spot floor as "the depth guard" — it would look like a fix and stop nothing; if a queue-only upgrade is wanted now, ship #2 + #4 (+ the spot floor as a cheap extra) and document them as walk-slowing; the JIT-proof depth bound is the P-8 harmonic mean and belongs on the hook-change list. Until then the queue relies on the walk being visible (1740 s of parked spot before the cutoff) and on nobody queuing against it |
| 6 | Consumed-input check on the residual, both directions | **PRESENT** | `MoleQueue.sol:581` (one line in `_swapExactIn`, shared by both legs) | `test_consumedInput_aShortFillOnTheZeroForOneLegIsRefusedAndReturnedWhole`, `…OneForZeroLeg…` (M3 killed both; each sized so the OUTPUT lands inside a 10% band, so only the input check can refuse) | — | none |
| 7 | Deadline-gated fallback, limited to the two price selectors | **PRESENT** | gate `MoleQueue.sol:328`; rethrow `491`; selector match `505-512`; rethrow helper `515-520` | `test_fallback_isStrictUntilTheDeadlineThenRefundsTheUnmatchedPartInKind` (M4), `test_fallback_aNonPriceFailureIsRethrownEvenPastTheDeadline` (M5), `test_fallback_aCounterfeitPriceSelectorWithTrailingDataIsRethrownVerbatim` (M6 — the `err.length != 4` check recorded as unkillable IS killable with a mocked PoolManager revert of 36 bytes; kept, and now covered) | — | none |
| 8 | Deferral ceiling + always-available escape, no settler dependency | **PRESENT as a TIME bound, not a count** | `timeout()` `MoleQueue.sol:347-372` (never-frozen branch 356-366; frozen branch 368-371), clock anchored to the scheduled cutoff `267`; lenient settle `328` | `test_escape_aFrozenEpochWithATrippedGuardIsFreedByAStrangerOnTheCutoffClock` (M7), `test_escape_aNeverFrozenEpochWithATrippedGuardTimesOutOnTheCutoffClock` (M8) | There is no `MAX_CONSECUTIVE_DEFERRALS`, no `consecutiveTrips`, no `GuardTripped` event (D3): a tripped guard is a plain revert and leaves no on-chain trace except failed transactions. The bound that exists is `maxEpochLife` from the cutoff — at most 3600 s live — after which a stranger can end the epoch. That is a complete escape with no settler dependency (17.4 holds). D3 is the gap: a silent deferral is indistinguishable from censorship | Optional, queue-side: emit a `SettleRefused(epoch, selector)` event from a non-reverting `try this.settleStrict(e)` wrapper, or simply have the frontend/indexer surface failed settle calls. A count-based ceiling is redundant with the time bound and would need a stored counter per epoch — not proposed |
| 9 | Same-tx place + settle refusal | **PRESENT structurally** (phase gating), not as the named precheck | `settle` requires stored-Frozen `MoleQueue.sol:278`; `place` requires `_phase(currentEpoch) == Open` `220`; a frozen epoch is never `currentEpoch` (`268`) | `test_sameTx_placingIntoAnEpochAndSettlingItInOneTransactionIsRefused` (M9 killed — with line 278 deleted an OPEN epoch settles inside one tx); `test_PIN_sameTx_placingIntoTheNextEpochWhileSettlingThisOneChangesNothing` (placing into e+1 while settling e is allowed and provably inert) | The FLOW-3 precheck (`queuedAtBlock < block.number`) was about a participant settling its own epoch at a block of its choosing. MoleQueue lets a participant settle its own epoch — but so can anyone (settle is permissionless) and a second address defeats the precheck anyway. The real defences are the freeze window + band, both present — the freeze window is settle's `TooEarly` gate (`MoleQueue.sol:279`), covered by `AttackQueueSafety.t.sol::test_settleMustWaitOutTheFreezeWindow` (deleting line 279 turns that test red while this file stays green — V5 below), the band by #3. Nothing to add |
| 10 | Donation / post-freeze immunity (donate, ERC-20 transfer, ERC-6909 transfer between freeze and settle change no fill) | **PRESENT, structurally** | `settle` reads only `ep.totalIn*` + `consult` + slot0 tick (`286-307`); `claim` reads the epoch record and `o.amountIn` (`404-417`); no `balanceOf` anywhere; hook bitmap `0x38C4` mines no donate bit | `test_immunity_aDonateBetweenFreezeAndSettleChangesNoFill` (structural — no line to delete; non-vacuity asserted on fee growth), `test_immunity_anErc20TransferIntoTheQueue…` (M10, negative control: a balance-reading settle is detected), `test_immunity_anErc6909TransferIntoTheQueue…` (M11, negative control) | — (an ERC-20 gift to the queue is stranded forever: no sweep — by design, tested) | none |
| 11 | Lagged multi-window agreement, window-range sanity, absolute price bounds (rest of P-49) | **MISSING** (no tests — each would be a RED duplicate of #5) | — | Absolute bounds: settle reverts by accident below tick ≈ −665,000 (`priceX96` rounds to 0 → `FullMath` division by zero, empty revert data) and nowhere else. Multi-window agreement is defeated by the same patient walk as #4 | Covered well enough by #2 + #4 + #5; not proposed separately |

### What the residual bound is, and is not
`maxResidualSlippageBps` (Q-1, `536-549`) bounds the RESIDUAL leg only. The crossed portion is bounded by nothing
but the band and the oracle — which is why #5 matters: every guard on the residual is satisfied vacuously when the
matched part is what's being stolen. And a depth bound that reads the pool *now* is itself satisfied vacuously by a
position that exists only *now* — the residual's fill is what the one-block position buys, and the cross rides along.

---

## 2. C-3 — what MoleQueue ACTUALLY charges on the crossed portion

**Zero.** `MoleQueue.sol:295-302`: `crossed1 = mulDiv(crossed0, priceX96, Q96)` at the TWAP tick, no fee term, no
spread, no netting fee, no LP fee (no pool call), no hook fee. The contract header says so (`34-38`). Pinned by
`test_PIN_C3_theCrossedPortionIsChargedExactlyZero` (100e18 ⇄ 100e18 at tick 0, pool untouched, queue empty after
claims) and by the economics suite's `test_perfectlyBalancedEpoch_neverTouchesThePool_andPaysExactlyTheTwap`.

So the public copy "matched portion: zero fee" is TRUE today, and the dossier's wash-faucet concern (C6/A11) is
live: two cooperating addresses can cross any volume against themselves for free, forever. What they GAIN is no
value (a self-cross at TWAP nets zero) — what they get is free "volume" on any metric that counts crossed flow, and
the LPs lose the fee that volume would have paid through the pool. Decision queued for the owner: keep zero (and
never count crossed volume as volume anywhere public) or charge `internalCrossFeeBps ≥ poolFee − 5 bps` (queue-side
patch: skim `crossed1 * fee / 1e4` to `feeRecipient` at `302`; needs a queue upgrade and a recipient). No copy
should be written until this is decided.

## 3. C-7 — the deferral terminal action, as shipped

The code resolved C-7 as **DEFER-BY-REVERT, THEN IN-KIND AT A TIME CEILING — never forced tranches, never routing
at spot**:

1. Any guard trip (`InsufficientObservations`, `TwapTooFarFromSpot`, `ResidualShortFill`, `ResidualSwapTooFarFromTwap`,
   any non-price failure) → `settle` reverts; the epoch stays Frozen; nothing executes; retry is free (D1 holds).
2. From `frozenAt + maxEpochLife` (the cutoff, not the button press — 17.4) two doors open, both permissionless:
   - `settle` in **lenient** mode: if — and only if — the failure is one of the two residual PRICE selectors, the
     matched part clears at TWAP and the unmatched part is booked back in kind (17.5). A band or oracle trip is
     still a revert here.
   - `timeout`: everything back in kind, no price applied.
3. No counter, no `GuardTripped` event, no HALTED state, no K-clean-observations re-entry; the next epoch is
   simply the next epoch.

**A pin worth knowing (`test_PIN_C7_atTheDeadlineSettleAndTimeoutAreBothOpenAndDisagreeOnWhatCarolReceives`):** on
the deadline second both doors are open from the same state and they disagree — `settle` pays carol her cross in
currency0, `timeout` gives her her own currency1 back. Whoever calls first decides. A participant who dislikes
the cross can race `timeout`; one who likes it can race `settle`. Small (an hour's option on a TWAP-priced cross
on a thin pool), but it is a free option and it is the reason to decide C-7 explicitly rather than leave it to the
mempool-less sequencer. Two choices: (a) at the deadline, only `timeout` (pure in-kind; matches P-56's "in-kind
for everyone"; loses the Q-3 partial-clear) — this one closes the option arithmetically; or (b) at the deadline,
only lenient `settle`, with `timeout` opening one freeze-duration later (`frozenAt + maxEpochLife + freezeDuration`
in `timeout`'s frozen branch; keeps Q-3). **(b) does not remove the race — it defers it.** It gives a settle-only
window of one `freezeDuration`; if nobody settles inside it, both doors are open again from the same Frozen state
and whoever acts first still decides. The option is gone only if a settler acts in that window, i.e. (b) is a
PROMISE (our keeper settles at the deadline) and (a) is ARITHMETIC, in the dossier's own categories. A third shape
— an explicit terminal state, e.g. `timeout` refusing while a lenient `settle` would succeed — needs `timeout` to
know the settle outcome, which is a simulation it cannot do cheaply; not proposed. Decide between (a) and (b)
knowing that only (a) is a closed door.

---

## 4. Mutation record (every PRESENT guard)

| # | Mutation (applied, run, restored) | Tests that went RED |
|---|---|---|
| M1 | `MoleHook.sol:615` delete `if (!found) revert InsufficientObservations();` | `test_coverage_…` |
| M2 | `MoleQueue.sol:293` delete `if (drift > maxTwapDeviationTicks) revert TwapTooFarFromSpot();` | both `test_band_…` |
| M3 | `MoleQueue.sol:581` delete `if (uint128(-owed) < amountIn) revert ResidualShortFill();` | both `test_consumedInput_…` (+ two neighbours saw a different selector) |
| M4 | `MoleQueue.sol:328` `bool lenient = true;` | `test_fallback_isStrictUntilTheDeadline…` (+3 whose strict reverts became refunds) |
| M5 | `MoleQueue.sol:511` `return true;` (blanket catch) | `test_fallback_aNonPriceFailureIsRethrown…` |
| M6 | `MoleQueue.sol:506` delete `if (err.length != 4) return false;` | `test_fallback_aCounterfeitPriceSelector…` |
| M7 | `MoleQueue.sol:370` delete `ep.phase = Phase.Refunding;` (frozen branch) | `test_escape_aFrozenEpoch…` (+ C-7 pin arm B, + band-past-deadline) |
| M8 | `MoleQueue.sol:360` delete `ep.phase = Phase.Refunding;` (never-frozen branch) | `test_escape_aNeverFrozenEpoch…` |
| M9 | `MoleQueue.sol:278` delete `if (ep.phase != Phase.Frozen) revert WrongPhase();` | `test_sameTx_placingIntoAnEpoch…` (+ never-frozen escape saw a different selector) |
| M10 | after `MoleQueue.sol:280` insert `ep.totalIn0 = uint128(IERC20Minimal(Currency.unwrap(key.currency0)).balanceOf(address(this)));` | `test_immunity_anErc20Transfer…` (+ `test_PIN_sameTx_…`, whose composed escrow also inflates the balance) |
| M11 | after `MoleQueue.sol:280` insert `ep.totalIn1 += uint128(poolManager.balanceOf(address(this), uint256(uint160(Currency.unwrap(key.currency1)))));` | `test_immunity_anErc6909Transfer…` |

Not mutable (no guard line exists): the donate immunity (structural; non-vacuity on fee growth asserted), the two
`test_PIN_*` behaviour pins, the three `test_MISSING_*`.

All eleven re-run on 2026-08-22 after the depth test was rewritten; every one RED as listed, `src/` restored
byte-identically each time (`git diff --stat src/` empty afterwards).

### 4b. What the depth test can and cannot tell apart (temporary stand-ins applied to `src/`, then restored)

| # | Candidate depth patch (stand-in) | Depth test | What it proves |
|---|---|---|---|
| V1 | Spot floor: after the band, `if (StateLibrary.getLiquidity(poolManager, key.toId()) < 100_000e18) revert TwapTooFarFromSpot();` | **RED** (arm A cleared; the refused arm escaped in kind) | the spot floor is bypassed by the one-block position in the settle block; the test does not go green under it |
| V2 | Freeze + settle samples: `_depthAtFreeze[e]` written in `freeze()`, settle requires both samples ≥ 100_000e18 | **RED** (arm A cleared) | two one-block positions (freeze block, settle block) satisfy both samples; sampling is not dwell |
| V3 | A bound the one-block position cannot satisfy (stand-in: refuse any clearing tick outside ±10,000) | **GREEN** (1 passed) | the test's guard-present path is real: both arms refused, `timeout` escape in kind for alice and the attacker |
| V4 | The same bound placed INSIDE the unlock, raising a forgiven selector (`ResidualSwapTooFarFromTwap`) | **RED** (arm B cleared) | a depth guard that sits where the deadline fallback forgives it is caught: arm A is refused (strict), arm B clears at the deadline |
| V5 | `MoleQueue.sol:279` `TooEarly` gate deleted (row 9 cross-reference) | this file GREEN; `AttackQueueSafety.t.sol` RED: test_settleMustWaitOutTheFreezeWindow() | the freeze window is covered elsewhere, as row 9 states |

A first pass of V1–V3 went RED for the wrong reason: the test's strict no-depth probe pinned
`ResidualSwapTooFarFromTwap` with `expectRevert`, so any depth guard tripped the premise before either arm ran. The
probe now asserts only "refused, nothing written" (the selector is what arm B demonstrates), and V1–V4 were re-run
on the corrected test; the table above is that re-run.

## 5. Not covered

- Live reads were done (header): `restrictedLiquidity = false`, in-range liquidity 5.9e12 at tick −200,461,
  `currentEpoch = 2`. Not read: the live position set around the tick (who holds that liquidity, its range), so
  how far the live spot can be walked for free is inferred from the shape, not measured.
- Multi-window agreement / absolute price bounds / window-range sanity: no tests (would duplicate #5's RED).
- A post-freeze JIT liquidity ADD is now exercised (arm A of the depth test) as the bypass of a spot or sampled depth
  guard. The harness has no arbitrageur, so nothing prices a liquidity hold longer than one block: a test cannot
  tell a whole-window hold from a JIT, which is why the RED test uses one-block positions and why "JIT-proof" above
  means "bypass costs arb-exposed capital for the window", not "unbypassable". A JIT add that changes an HONEST
  residual's fill (arguably helpful) is untested.
- No candidate depth patch was implemented; V1–V4 are temporary stand-ins applied to `src/` to classify the test's
  behaviour under each shape, restored byte-identically afterwards.
- `GuardTripped`/D3 observability: nothing to test against; noted as a gap.
- The `timeout`-vs-`settle` race is pinned, not priced; no attempt to bound the option's value.
- No deploy/upgrade script; every queue-side patch above needs a queue implementation upgrade (UUPS) —
  `needs_contract_upgrade` if any of #2/#4/#5(1)/C-3/C-7 is taken; new storage must be appended after `upgradeAdmin`
  (`MoleQueue.sol:200`). The JIT-proof depth bound (#5(3)(i)) is hook code (P-7/P-8), not a queue upgrade.
- Frontend untouched; the "matched = zero fee" copy question (C-3) is the owner's call before any copy changes.
