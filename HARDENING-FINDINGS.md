# HARDENING-FINDINGS — invariant/adversarial hardening pass (wave1 item 8)

Scope: MoleRouter (UUPS proxy 0xBd9B841d…), MolePositions (0x674625B6…), MoleQueue (0x3dCb2494…),
MoleHook (0xb2c9A0af…) as they are on RH mainnet 4663. Dossier refs: Part 2 §1/§4/§8/§9/§12/§14,
P-27/P-28/P-29, P-45, P-73, D-6. New suites: `test/attack/AttackHardening_*.t.sol` (8 files, 52 tests,
shared harness `test/helpers/HardeningBase.sol`). **No live contract was patched.** Three tests are left
RED on purpose; each maps to a finding below. The deep invariant suite is untouched.

| # | Where | Severity | Reachable on the live deployment? | Test left RED |
|---|---|---|---|---|
| H-1 | MolePositions.unlockCallback, MoleQueue.unlockCallback | INFO (defence-in-depth, P-28 second check absent) | No — only if `poolManager` is re-pointed by an upgrade or the PoolManager itself misbehaves | `test_check2_vault_refusesACallbackItDidNotInitiate`, `test_check2_queue_refusesACallbackItDidNotInitiate` |
| H-2 | MoleQueue.settle / timeout / claim re-entrancy (CEI) | MEDIUM, gated on a hostile pool currency (token with a transfer hook controlled by the attacker) | Not on the live WETH/USDG queue (neither token has hooks); yes on any future queue whose currency is attacker-controlled | `test_queue_hostileCurrencyCanFlipALenientSettleIntoARefundAndDrainTheNextEpoch` |

Everything else attacked in this pass **HOLDS** and is mutation-verified; the per-file headers carry
the detail and the mutation each guard was killed by. Summary at the bottom.

---

## H-1 — P-28's second check (the unlock-initiator sentinel) is absent on MolePositions and MoleQueue

**Rule (dossier P-28, Part 2 §14):** `require(msg.sender == poolManager)` *and* verification of the
callback payload against a transient initiator sentinel written immediately before `poolManager.unlock()`.
"Who called you and what they claim are two different questions."

**State of the three contracts.**
- MoleRouter: BOTH checks present. `_swap` sets a transient lock before `unlock`; `unlockCallback`
  refuses when the lock is clear (`UnexpectedCallback`). Mutation M4 (delete the sentinel) turns the
  router's check-2 test RED; the guard is real.
- MolePositions: msg.sender check only. The payload (`Action`, `id`, `owner`, `liquidityDelta`, …) is
  decoded and ACTED ON with no proof that this contract authored it.
- MoleQueue: msg.sender check only. `(residual0, residual1, priceX96)` — including the Q-1 slippage
  anchor — is read from the payload.

**Why it is unreachable today.** The canonical v4 PoolManager calls back only `msg.sender` of `unlock`,
and the only `unlock` callers in our code are our own entrypoints with self-built payloads. The suite
proves that: a direct EOA, a foreign unlock initiator forwarding our payload from inside *its* callback on
the real manager, a hostile "PoolManager" look-alike, and a byte-identical second PoolManager are all
refused with `NotPoolManager` (check-1 tests, mutation-verified by M1–M3). The sentinel only matters if a
call reaches `unlockCallback` with `msg.sender == poolManager` but a payload we did not build — which the
RED tests reproduce by initiating a real unlock from the test contract and impersonating the manager for
one call from inside it.

**Measured consequence if the condition were ever met** (`_probe`, same harness, 1:1 pool, position
range [-600, 600]):
- Vault, payload `(Open, <attacker's id>, <victim>, +1e18, …, max, max)`: the VICTIM's standing allowance
  paid 29,557,995,854,287,069 wei of currency0 and 29,548,025,928,837,125 wei of currency1; the attacker's
  on-chain liquidity went 1e18 → 2e18 while the STORED liquidity stayed 1e18, so the extra 1e18 is
  **stranded under the attacker's salt forever** (withdraw is capped by the stored number; a rebalance
  burns the stored number at the stored range). A grief against the victim's allowance, not a theft.
  Payload `(Rebalance, <victim id>, …, newLower, newUpper)` would move ANY position to ANY legal range
  with every keeper bound bypassed (the Rebalance branch writes `p.tickLower/Upper/liquidity`). Payload
  `(Withdraw, …)` pays the stored owner early and leaves a zombie record (no loss).
- Queue, payload `(100e18, 0, priceX96 = 1)`: the queue's 100e18 currency0 escrow was swapped to
  99,649,331,307,732,624,073 wei of currency1 (bound defeated — `fair` computed from the payload's price is
  0) and left **unattributed** in the queue; the depositor's `cancel` then reverts `TransferFailed` and the
  in-kind `claim` after timeout would too. Escrow converted and stranded.

**Severity reasoning.** INFO. The trust root (the PoolManager) is immutable and pinned; the only path to
the condition is a hostile PoolManager (which already custodies every token, so the marginal reach is
"standing ERC-20 allowances to the vault" and "queue escrow attribution") or `poolManager` being
re-pointed by an upgrade (a root-key action). Recorded because the dossier marks the second check as
SETTLED-required and two of three contracts lack it, and because `poolManager` is *storage* behind a
proxy now, which is a sharper edge than the original immutable.

**Minimal patch proposal (needs an upgrade of both proxies; NOT applied).** A transient flag set around
`unlock` and asserted first thing in the callback — the router's exact shape:
```solidity
bytes32 private constant _UNLOCK_SLOT = keccak256("molepositions.unlock.initiator");
function _unlockOwn(bytes memory data) private returns (bytes memory r) {
    assembly ("memory-safe") { tstore(_UNLOCK_SLOT, 1) }
    r = poolManager.unlock(data);
    assembly ("memory-safe") { tstore(_UNLOCK_SLOT, 0) }
}
function unlockCallback(bytes calldata data) external returns (bytes memory) {
    if (msg.sender != address(poolManager)) revert NotPoolManager();
    uint256 own; assembly ("memory-safe") { own := tload(_UNLOCK_SLOT) }
    if (own == 0) revert UnexpectedCallback();   // new error; P-28 second check
    ...
}
```
Same on MoleQueue around the `try poolManager.unlock(...)` in `_settleResidual` (clear the flag on BOTH
the success and the catch path). MolePositions sits near the EIP-170 ceiling: `forge build --sizes` on
this tree measures **23,884 bytes runtime, 692 bytes of headroom** (its own header still says ~180,
written before the ZapLogic extraction); two `tstore`s, one `tload` and one custom error fit. Note the
slot constant has to be copied into a local before the `tstore`/`tload` (inline assembly cannot read a
`keccak256` constant directly) — the router already does it that way. Tests to flip GREEN: the two RED
check-2 tests, unchanged. See "Patch validation" at the end for the scratch-copy result.

---

## H-2 — a hostile pool currency can re-enter `timeout` + `claim` from inside a lenient `settle` and drain the NEXT epoch's escrow

**Shape.** `MoleQueue.settle(e)` writes `ep.phase = Settled` at the END, after the external calls. The
residual swap inside the unlock pays the pool with `_rawTransfer(cIn, poolManager, …)` — an ERC-20
call. If that currency runs attacker code on transfer (ERC-777 style, or any token the attacker deploys),
it re-enters the queue while epoch `e` is still stored `Frozen`:
1. `timeout(e)` — succeeds iff `block.timestamp >= frozenAt + maxEpochLife`, i.e. exactly the
   `lenient` condition the settlement is already in → `ep.phase = Refunding`;
2. `claim(e, <attacker's own order>)` — Refunding branch pays the attacker's FULL input **in kind** from
   the queue's pooled balance, which at that instant holds this epoch's crossed escrow PLUS every later
   epoch's escrow; marks the order withdrawn;
3. control returns; the outer `settle` finishes and stamps `Settled`, `out0`, `out1` over it.

**Measured** (`test_queue_hostileCurrencyCanFlipALenientSettleIntoARefundAndDrainTheNextEpoch`, same
harness: evil token 1:1 vs `other`, attacker sells 100 evil in epoch 0, bob buys 40 other-side, mallory
parks 100 evil in epoch 1, settlement past `maxEpochLife`):
- attacker: 100e18 evil in → **100e18 evil back** (refund in kind, mid-settle); epoch 0 ends `Settled`
  with `out0 = 99.742e18 other` owed to the evil side — unclaimable (attacker is `withdrawn`), so
  **99.742e18 `other` is stranded in the queue forever**;
- bob: claims 40.004e18 evil, whole;
- mallory (epoch 1): after her own timeout, `claim` **reverts `TransferFailed`** — the queue's evil
  balance is 0. **She loses 100e18 evil, 100% of her escrow.**
- Net: attacker whole at zero cost; honest next-epoch depositor −100e18; ~100e18-equivalent stranded.
  Repeatable every epoch while later epochs carry escrow.

**Reachability.** Requires (a) a pool currency whose transfer re-enters — hostile token issuer, or a
legitimately hooked token; (b) the epoch to be past `maxEpochLife` (the lenient window, which is also
when `timeout` is legal for anyone); (c) the attacker to hold an order in that epoch. The live queue is
WETH/USDG (no hooks): not reachable. Any future queue on a long-tail token is exposed to its own issuer,
and the damage crosses epochs, so this is a step beyond the accepted "a hostile token bricks its own
pool": it is a zero-cost grief that strands value and short-pays later depositors of that pool.

**Not the same as the H-1 class** — no PoolManager impersonation; the payload is ours. The missing
property is checks-effects-interactions / re-entrancy on `settle` vs `timeout`/`claim`.

**What HOLDS around it** (same file): rogue `settle()`, rogue `sync(other)`, rogue `take()` from inside
the residual triple all revert `CurrencyNotSettled` and are re-thrown, never refunded; re-entering
`settle` itself hits `AlreadyUnlocked` and is re-thrown; re-entering `unlockCallback` hits
`NotPoolManager`; the outer settlement's outputs are identical to an inert control in every one of those.

**Minimal patch proposal (needs a MoleQueue upgrade; NOT applied).** Either of:
1. **P-45's discriminator on the payout surface** — refuse `claim`, `cancel`, `timeout` (and `place`)
   while the PoolManager is unlocked, since the queue never legitimately calls them from inside an
   unlock:
   ```solidity
   error Reentrant();
   modifier notMidUnlock() { if (TransientStateLibrary.isUnlocked(poolManager)) revert Reentrant(); _; }
   ```
   on `claim`, `cancel`, `timeout`, `place`. One `exttload` each; no new storage.
2. Or a transient `settling` flag set for the whole of `settle` and checked by `timeout`, `claim`,
   `cancel` and `place` (`modifier notSettling`); `settle` itself carries it too, so the nested-settle
   probe fails on our own error instead of the singleton's.
Option 1 is broader (it also closes any future re-entry via a hooked token into the payout paths) and is
the P-45 shape the dossier already calls for; its cost is that `place`/`cancel` stop working from inside
ANY party's unlock, which a composing integrator might legitimately do. Option 2 is the minimal diff and
changes nothing for anyone who is not mid-settlement — it is the one validated in the scratch copy (see
"Patch validation"). Test to flip GREEN: the RED H-2 test, unchanged. Also add the same re-entrant-
currency probe to `InvariantQueue`'s handler world (not done here; see "not covered").

---

## What HOLDS (PASSES), by suite — and the mutation that proves each guard is real

Every row below was RUN, not reasoned about: the mutation is applied to a scratch copy of `src/`, the
named suite(s) are executed, the listed tests go RED, the copy is restored. 25 mutations in all:
**23 kills, 2 honest survivors** (both recorded below with the reason — neither is a guard). The live
worktree `src/` was never modified.

| # | Mutation (in a scratch copy of src/) | Suite | Tests that went RED |
|---|---|---|---|
| M1 | MolePositions.unlockCallback: delete `msg.sender != poolManager` check | unlockAuth | check1 direct / foreign / clone (3) |
| M2 | MoleQueue.unlockCallback: same | unlockAuth | check1 direct / foreign / clone (3) |
| M3 | MoleRouter.unlockCallback: same | unlockAuth | check1 direct / foreign / clone (3) |
| M4 | MoleRouter.unlockCallback: delete `if (_lockValue() == 0) revert UnexpectedCallback()` | unlockAuth | `test_check2_router_refusesACallbackItDidNotInitiate` |
| M5 | MoleRouter._settle: delete `poolManager.sync(currency)` | settleTriple | router control + 2 router re-entry tests |
| M6 | MoleQueue._swapExactIn: delete `poolManager.sync(cIn)` | settleTriple | queue control + 2 queue re-entry tests |
| M7 | ZapLogic._settle: delete `pm.sync(c)` | settleTriple | zap control + 2 zap probes |
| M8 | MoleQueue._settleResidual: blanket catch once lenient (`if (!lenient) _rethrow(err)`) | settleTriple | `test_queue_rogueSettleInsideTheResidualTripleIsRethrownNotRefunded` |
| M9 | MolePositions.unlockCallback: INJECT `poolManager.setOperator(keeper, true)` | noOperator | all three flow tests (setUp opens a position) |
| M10 | MoleQueue.unlockCallback: INJECT `poolManager.approve(poolManager, currency0.toId(), 1)` | noOperator | `test_queue_noGrantAfterEveryFlow` |
| M11 | MoleRouter.unlockCallback: INJECT `poolManager.setOperator(payer, true)` | noOperator | `test_router_noGrantAfterAV4Swap` |
| M12 | MoleRouter._swap: delete `if (plan.recipient == address(this)) revert ZeroRecipient()` | router | both self-recipient tests |
| M13 | MoleRouter._sweep: delete the `nowBal > startBal[i]` sweep body | router | over-receive+short-fill, native-out over-receive, v4→v3 over-pay, the fuzz |
| M14 | MoleQueue.cancel: delete the `_phase(e) != Open` check | queue | both post-freeze tests |
| M15 | MoleQueue.place: delete the `_phase(e) != Open` check | queue | both post-freeze tests |
| M16 | MoleHook.beforeAddLiquidity: delete `onlyPoolManager` | hookCallbacks | all four all-ten-callbacks tests |
| M17 | MoleHook.beforeDonate: `return IHooks.beforeDonate.selector` instead of revert | hookCallbacks | all four all-ten-callbacks tests |
| M18 | MolePositions rebalance: do not write `p.liquidity = newLiquidity` (stored ≠ on-chain) | tickBoundary + rounding | rebalance-onto-edge fuzz; both grinds (INV-4) |
| M19 | MolePositions._takePerformanceFee: `return (0, 0)` always | tickBoundary + noOperator | fee-exactness fuzz (non-vacuity); vault flow + keeper-vs-claims premise |
| M19b | MolePositions._takePerformanceFee: emit `(cut0, cut0)` instead of `(cut0, cut1)` | tickBoundary | fee-exactness fuzz (event == treasury claims) |
| M20 | MoleQueue.claim: `mulDivRoundingUp` on the 0-side share | queue | the 100-order dust grind |
| M21 | MolePositions.withdraw: burn `liquidityToRemove - 1` | tickBoundary + rounding | open/withdraw fuzz (liquidity left on chain); rebalance fuzz; both grinds (INV-4) |
| M22 | MolePositions rebalance: `_collectTo(key, net, address(this))` (the shared-pot shape) | rounding + tickBoundary | both grinds (custody); rebalance-onto-edge fuzz (conservation) |
| M18x | MolePositions rebalance: swap `newLower`/`newUpper` in the two `getSqrtPriceAtTick` calls | tickBoundary | **SURVIVOR (3/3 pass)** — `LiquidityAmounts.getLiquidityForAmounts` sorts its bounds itself; this is not a guard. The earlier draft of this file claimed it as a kill; it was wrong and is corrected in the file header |
| M19x | MolePositions._cutOf: round UP (`+ 9_999`) | tickBoundary + AttackPerformanceFee | **SURVIVOR in tickBoundary (3/3 pass)** — that file pins conservation and event truthfulness, which hold under either rounding; **KILLED by `AttackPerformanceFee.testFuzz_theCutAlwaysRoundsDownAndNeverExceedsTheFees`**, which is where rounding direction is pinned. Header corrected |

Per suite:

- **unlockCallback authentication** (`AttackHardening_unlockAuth`, 7 tests, 5 green + 2 RED by design):
  direct caller, foreign unlock forwarding our selector on the REAL manager, hostile look-alike,
  byte-identical second PoolManager — all refused, state untouched; our entrypoints unreachable from
  inside a foreign unlock (`AlreadyUnlocked`/`NotOwner`); router's sentinel holds. Killed by M1–M4.
- **sync→transfer→settle indivisibility** (`AttackHardening_settleTriple`, 18 tests, 17 green + 1 RED by
  design): on MoleRouter._settle, MoleQueue._swapExactIn and ZapLogic._settle a re-entering ERC-20 that
  steals the credit, re-syncs the other currency or takes tokens makes the whole tx revert
  `CurrencyNotSettled` (the zap: `ZeroLiquidity` one frame earlier, same outcome) with every user balance
  intact; re-entering our entrypoints/callbacks is refused and leaves the outer result byte-identical to a
  control; the queue re-throws rather than refunds. Killed by M5–M8.
- **setOperator / ERC-6909 approvals never granted** (`AttackHardening_noOperator`, 4 tests): after every
  flow of every contract no address is an operator for any of ours, no per-id allowance exists, none of
  vault/queue/router/hook holds a claim; the keeper cannot move the treasury's claims. Killed by
  injection M9–M11 (and M19 proves the treasury-claim premise is not vacuous).
- **rounding toward the pool under a ≥100-op grind** (`AttackHardening_rounding`, 3 tests): 120 mixed
  dust ops leave the grinder no richer, the victim's and the background LP's exits IDENTICAL to a no-grind
  control (no-swap world), bounds + full-exit liveness in the swap world; custody 0 and INV-4 after every
  op. Negative control: the same grind on `VulnerableMolePositions` forms a pot. Killed by M18, M21, M22.
- **router zero-residual, composed** (`AttackHardening_router`, 6 tests incl. a 512-run fuzz): every wei
  attributed (treasury = floor(amt·bps/1e4) of the INPUT, recipient = tracked output, payer = all
  residual), router holds nothing; self-recipient refused on both paths. Killed by M12–M13.
- **queue donation / post-freeze immunity + dust grind** (`AttackHardening_queue`, 6 tests): direct
  ERC-20 gift, ERC-6909 gift and a pool `donate()` change no payout and are not distributed; nothing
  enters or leaves a frozen epoch (before AND after `freeze()` is pressed, at the cutoff second exactly);
  a next-epoch whale changes nothing; 100 indivisible orders vs one whale all claim, ≤1 wei dust per
  order retained. Killed by M14, M15, M20.
- **direct calls to every MoleHook callback** (`AttackHardening_hookCallbacks`, 5 tests): all TEN
  callbacks from an EOA, the vault, the pool creator and a PoolManager impostor revert `NotPoolManager`
  with oracle state, lp fee and allowlist byte-identical; the five unmined callbacks are unreachable
  through the real PoolManager (donate + remove + vault exit all succeed untouched). Killed by M16–M17.
- **on-boundary tick fuzz** (`AttackHardening_tickBoundary`, 3 fuzz tests, 512 runs total): pools opened
  at exactly k·spacing, k ∈ [-800, 800]: open pulls exactly one leg on the edge (zero of the other),
  withdraw returns it minus ≤1 wei, INV-4 holds; rebalance ONTO an edge conserves amounts exactly (owner
  gain == PoolManager loss per leg) along both edge chains, the cross-over is refused `ZeroLiquidity`
  rather than minted empty; performance fee across the edge splits EXACTLY (owner(on) + treasury ==
  owner(off), cut == event, cut > 0). Killed by M18, M19, M19b, M21, M22; survivors M18x/M19x recorded.

## Verification run (this worktree, `forge test --no-match-path 'test/fork/*'`)

`560 passed, 3 failed, 1 skipped` across 50 suites — the 3 failures are exactly the three RED-by-design
tests in the table at the top (H-1 ×2, H-2 ×1). The eight new suites alone: 52 tests, 49 green, 3 RED.
Nothing under `test/invariant/` was touched; the deep profile was not re-run (no contract changed).

## Patch validation (scratch copy of `src/` only — the worktree `src/` is untouched)

Both patch proposals were applied to a scratch copy of the tree and the suites re-run, so "flips GREEN"
is a result rather than an expectation. The edit was exactly: H-1 sentinel on MolePositions (a private
`_unlockOwn` wrapping the four `poolManager.unlock(...)` call sites, `_UNLOCK_SLOT` tstore/tload, new
`error UnexpectedCallback()`); H-1 sentinel on MoleQueue around the `try poolManager.unlock(...)` in
`_settleResidual` (cleared on both the success and the catch path); H-2 option 2 on MoleQueue — a
transient `_SETTLING_SLOT` set for the whole of `settle`, with `modifier notSettling` on `settle`,
`timeout`, `claim`, `cancel`, `place` and a new `error Reentrant()`.

| Check | Result |
|---|---|
| `forge build --sizes` | MolePositions **23,707 bytes runtime (869 headroom)** — smaller than before the patch (23,884), because the four inlined unlock sites collapse into one private function; MoleQueue **17,926** (+487). Both inside EIP-170 |
| The three RED tests | `test_check2_vault_refusesACallbackItDidNotInitiate` GREEN, `test_check2_queue_refusesACallbackItDidNotInitiate` GREEN, `test_queue_hostileCurrencyCanFlipALenientSettleIntoARefundAndDrainTheNextEpoch` GREEN |
| The eight hardening suites | 51 / 52 green. The one non-green is `test_queue_reenteringSettleIsRefused_andTheOuterSettlementIsUnchanged`, which pins the nested-settle refusal REASON as the singleton's `AlreadyUnlocked`; under the patch the queue's own `Reentrant()` fires first (selector `0xed3ba6a6`). Same property (the nested settle is refused, the outer settlement is unchanged), different — and earlier — refuser; that one `assertEq(selector)` is updated alongside the upgrade, not before it |
| Every other suite (`--no-match-path 'test/{fork,invariant}/*'`) | **507 passed / 1 failed / 1 skipped** across 43 suites — the 1 is the same reason-pin above; no other test anywhere changes outcome |

Not done: the deep invariant profile against the patched copy (the brief keeps that suite untouched and
the patch is not being applied); a fork run. Both belong to the upgrade PR, if the owner decides to open
one. **Nothing here is deployed or staged; no script that broadcasts was written.**

## Not covered in this pass (honest scope)
- H-2's probe is not in the invariant handler world (`InvariantQueue`); the deep suite stays untouched
  per the brief.
- MolePositions._settleFrom under a re-entering token is covered by the existing
  `AttackPoolAndTokens`/`AttackCustody` tests, not re-asserted here.
- The native-ETH branches of `_settleFrom`/ZapLogic under re-entry (native has no transfer hook to
  re-enter from; the sync(NATIVE)-uniformity rule of Part 2 §4 is *not* followed by `_settleFrom` —
  native is settled without a preceding `sync` — which is correct under current core semantics but is a
  documented deviation, not tested here).
- No mutation target exists for the "exactness" assertions that pin v4-core arithmetic (open/withdraw
  at the edge, the settle-triple failing closed): those pin core behaviour plus our ordering; the
  order-dependent half is what M5–M7 kill.
- Live-chain (fork) verification of the P-28 findings was not run (public RPC prunes state; see
  HANDOFF §6.1).
- P-45 (the NAV-read guard with an unlock-initiator discriminator) has no guarded surface under
  per-user positions — none of the four contracts exposes a share price or NAV view — so no test was
  written for it; its discriminator shape is what H-2's option-1 patch would reuse.
- The mutation runs and the patch validation were executed on scratch copies of the tree, with
  `forge test --match-path` (sparse compilation); the worktree's own `out/` was never rebuilt from a
  mutated source, so a stale-artifact false kill is not possible.
