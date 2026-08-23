# Exit-path audit — findings and patch proposals (not applied)

Scope: `src/MolePositions.sol`, `src/MoleQueue.sol`, `src/MoleRouter.sol` and the libraries they call
(`ZapLogic`, `HookPermissions`, `DeployConfig`, v4-core `PoolManager`/`Hooks`), read for anything on the
withdraw / withdrawAll / claim / cancel / reclaim (timeout) paths that a pause flag, a key, an oracle, a
keeper, a whitelist, an epoch or a registry could use to block an exit. Dossier refs: C-8, P-33, P-69,
FLOW-12, T-5/T-6.

Method: call-graph read of every exit entry point; then `test/ExitPath.t.sol` (dynamic, every lever hostile)
and `test/ExitPathStatic.t.sol` (source-level) written as attacks first; every assertion mutation-verified.

## Verdict

**No pause flag, no `whenNotPaused`, no keeper / oracle / whitelist / registry / epoch dependency exists on
any exit path of the three contracts.** Nothing in this pass needs a contract change to make the exit claim
true, so nothing below is applied. The C-8 conflict resolves the way P-69 states it: zero pause modifiers on
the exit graph, now enforced by a test that reads the source, plus the address-bit proof.

What CAN still block an exit is the two things the dossier already names as the accepted price of the
hardcoded recipient and of the proxy. They are listed here because the item asked for every dependency that
can block an exit, with a minimal patch each — for the owner to decide, not for this pass to ship.

## F-EXIT-1 — a token that refuses to pay the owner strands BOTH legs of the position (known; accepted cost)

**Where.** `MolePositions.unlockCallback`, `Action.Withdraw` branch → `_collectTo` → `poolManager.take(currency,
p.owner, amount)` → `currency.transfer(owner, amount)`. A blocklisting, pausable, rebasing-below-reserves or
revert-on-transfer token makes `take` revert (`CustomRevert.WrappedError(ERC20TransferFailed)`), which reverts
the whole unlock — **including the `take` of the other, healthy currency**. Same shape for a native-currency
pool whose owner is a contract without a payable `receive` (`NativeTransferFailed`). Pinned today as an
accepted design cost by `AttackPoolAndTokens.t.sol` (`test_attack_blacklistedOwnerIsPermanentlyStranded`,
`test_attack_rebasingTokenBricksExitsForThatPool`) and HANDOFF §7 "Accepted design costs".

**Why it is listed.** It is the only remaining *mechanical* way an exit reverts that is not the root key, and
it is strictly worse than it needs to be: the healthy leg is held hostage by the hostile one, and the owner
has no second door because the vault has no recipient parameter — by design, and that design is right.

**Minimal patch (NOT applied — needs an upgrade, an owner decision, and EIP-170 headroom).** Keep the
hardcoded recipient; add a per-leg fallback that never names an address: if `take` to the stored owner
fails, `mint` the same amount as ERC-6909 claims **to the stored owner** instead. Claims are a balance credit
inside the PoolManager (no token call, cannot revert on anything the token does — the same argument that put
the performance fee on `mint`), they are transferable under ERC-6909, and they are redeemable by any
unlock-capable contract (`MoleFeeCollector`'s `burn -> take` is exactly that shape). Net effect: the healthy
leg always pays out in tokens; the hostile leg becomes a claim the owner can move to an un-blocklisted
address and redeem, instead of being locked forever with the other leg.

```solidity
// sketch, _collectTo — catch ONLY the take failure, never a broader class (learnings 17.5)
if (d0 > 0) {
    a0 = uint256(uint128(d0));
    try poolManager.take(key.currency0, to, a0) {}
    catch { poolManager.mint(to, key.currency0.toId(), a0); emit PaidAsClaims(to, key.currency0, a0); }
}
```

Costs and caveats the owner must weigh: (1) MolePositions' runtime bytecode is **23,884 bytes at HEAD — 692
bytes under the 24,576-byte EIP-170 limit** (measured 2026-08-22 from `deployedBytecode` in
`out/MolePositions.sol/MolePositions.json` after a clean build of HEAD at `optimizer_runs = 44444444`, and
cross-checked with `forge build --sizes`; MoleQueue 17,439 B, MoleRouter 14,104 B. The "~180 bytes" in the
first draft of this file was not measured, and a 24,242 B / 334 B figure quoted during verification was read
off an artifact built while a mutation — `consult()` inside `withdraw` — was still applied). A try/catch plus
an event costs a few hundred bytes, so it MAY fit: measure before and after, and if it does not, bytes move
out (another external library call, like ZapLogic), (2) a
`catch` on the exit path is a new surface — it must be shown by mutation that only the `take` selector path
reaches it and that a hostile token cannot use it to mis-account (the claims are debited from the same delta
`take` would have been, so the unlock still nets to zero), (3) `INV1_moleCustodiesNothing` is untouched — the
claims are minted to the OWNER, never to the vault, (4) it is a contract change → UUPS upgrade of the live
vault proxy, so `needs_contract_upgrade` would be true for whoever implements it; this pass did not.

## F-EXIT-2 — the upgrade key can replace `withdraw` (known; the price of the proxy)

**Where.** `MolePositions._authorizeUpgrade` / `MoleQueue._authorizeUpgrade` / `MoleRouter._authorizeUpgrade`
(`msg.sender == upgradeAdmin`). `AttackUpgradeability.t.sol` and `AttackQueueUpgradeability.t.sol` PERFORM
the replacement on purpose. As deployed, one EOA holds vault + hook + queue + router-B upgrade keys.

**Minimal patch.** No code: `transferUpgradeAdmin(address(0))` (built, tested) or a timelocked multisig, per
the 2026-08-22 register P0-2. `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey` now shows the exit
unchanged after the burn, so the burn costs the exit nothing.

## F-EXIT-3 — MoleQueue escrow is time-locked for a bounded window (by design, not a finding)

**Where.** Between an epoch's cutoff (`epochStartedAt + epochDuration`) and `+ maxEpochLife` (3600 s live):
`cancel` refuses (Frozen by clock), `claim` refuses (not Settled/Refunding), `timeout` refuses
(`NotTimedOut`). This is B8 — the freeze window that stops a late cancel reshaping settlement — and it is
BOUNDED: the timeout anchor is the *scheduled* cutoff on both the never-frozen and late-frozen paths (the
S-2 fix), so no party can extend it. `test_queueExit_neverFrozenEpoch_…` and
`…lateFrozenEpoch_…` pin the bound to the second. No patch; the number is a policy choice.

## Things that were checked and found NOT to be exit dependencies (for the record)

- `whenNotPaused` / `Pausable` / `_pause` / `paused()`: absent from every file under `src/`
  (`test_static_noPauseMachineryAnywhereInSrc`).
- `withdraw` header: only `onlyPositionOwner(id)`; `withdrawAll`, `unlockCallback`, `_modify`,
  `_takePerformanceFee`, `_cutOf`, `_collectTo`: no modifier at all; `cancel`/`claim`/`timeout`/`_phase`/
  `_push`/`_rawTransfer`: no modifier at all.
- Exit bodies use ONLY a per-function ALLOWLIST of identifiers (`withdrawAll`, `withdraw`, the callback's
  exit region with the ZapOpen/Open branch bodies cut out and their conditions pinned, `_modify`,
  `_takePerformanceFee`, `_cutOf`, `_collectTo`, the `onlyPositionOwner` modifier; `cancel`, `claim`,
  `timeout`, `_phase`, `_push`, `_rawTransfer`) and revert ONLY at the pinned places with the pinned errors —
  so none can reach the keeper, keeperRevoked, keeperExpiry, upgradeAdmin, moleHook, consult, twap*,
  isWhitelisted, the clock, the size/width bands, slot0, a `require`/`assert`/`assembly`, or a flag or helper
  under ANY name; the queue's exits reach no oracle, PoolManager, upgradeAdmin or settlement machinery. (The
  first version of the test used a word DENYLIST here, and a root-key flag under a novel name survived it.)
- `withdraw(uint256,uint128)` / `withdrawAll(uint256)`: no `address` in either ABI; and the WHOLE external /
  public surface of both custody contracts is pinned by signature (18 vault functions, 12 queue functions, no
  `receive`/`fallback`), so no entry point can be added under any name or parameter type — the only pinned
  ones taking an address are `setFeeRecipient`, `transferUpgradeAdmin`, `positionsOf` (vault) and
  `initialize`, `transferUpgradeAdmin` (queue). (The first version keyed on the literal word `address` in
  the parameter list, and a recipient smuggled through a struct survived it.)
- The state an exit reads is assigned once, in `initialize`, and nowhere else: vault `poolManager` and
  `performanceFeeBps`; queue `key`, `epochDuration`, `maxEpochLife`.
- Position owner is written once (`owner: msg.sender` at `open` and `zapOpen`) and never reassigned.
- `isWhitelisted` / `_pools` are written exactly once each, only to `true` / the admitted key, never deleted,
  and re-admission of a pool id is refused — so the key an exit burns against cannot be swapped.
- The performance-fee leg of an exit is a `mint` (credit), not a `take`, so a hostile or reverting fee
  recipient cannot block it (`test_exit_survivesEveryHostileLeverAndTheBurnedRootKey` pays a recipient that
  refuses every call).
- The hook is never called on removal: proven with the hook's code replaced by revert-everything and by
  nothing at all, plus a negative control showing the same dead code at an address WITH the remove bit
  does block removal.
- `MoleRouter` custodies nothing between transactions — tokens, ERC-6909 claims or ether — after a swap,
  after a revert, after a refused stray send, and after its root key is burned.


## Mutation record — test/ExitPathStatic.t.sol + test/ExitPath.t.sol (2026-08-22, fix round)

Every assertion in the two test files was mutation-verified: the runner applies ONE textual mutation to a file
under `src/`, runs `forge test --match-path "test/{ExitPath.t.sol,ExitPathStatic.t.sol[,extra]}"`, restores
the file from its pre-mutation bytes, and checks it is byte-identical to `git show HEAD:<file>`; the campaign
refuses to start while a forge process has this worktree as its working directory, refuses to start if any
`src/` file already differs from HEAD, and its last step is a `git status`/cmp-vs-HEAD over `src/`
(pre-campaign and post-campaign both recorded `identical_to_head: true`, `git status src` empty). Rules learned
the hard way in round 1 and now built into the runner: never run it concurrently with a manual forge
invocation in the same worktree (the shared build cache produced one false "survivor", M7, in round 1); restore
happens in `finally` AND on SIGTERM/SIGINT, but a SIGKILL bypasses both — which is exactly how round 1's M5
line was left in `src/MolePositions.sol` — so the post-campaign cmp-vs-HEAD is the step that proves the
worktree is clean, not the restore.

**Round 1 (first draft of ExitPathStatic, word denylist + `address`-keyword surface check): three mutations
SURVIVED** — X1 (a root-key `halted` flag read at the top of `withdraw`), X14 (the same gate behind a private
helper) and X15 (a recipient smuggled through a struct parameter). The rewrite replaced the denylist with a
per-function identifier ALLOWLIST plus a pinned revert sequence for every exit body, and the keyword check with
a full external/public signature pin for both contracts. Under the rewrite every one of the 58 mutations below
is RED (0 survivors, 0 compile errors); the three round-1 survivors are rows 1–3.

| # | mutation | what | verdict | tests turned red | src restored |
|---|---|---|---|---|---|
| 1 | `X1_halted_flag_novel_name` | root-key `halted` flag + `setHalted` + `if (halted) revert` at the top of withdraw (SURVIVED round 1) | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound`, `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 2 | `X14_private_gate_helper` | same gate behind a private `_requireOpen()` called from withdraw (SURVIVED round 1) | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 3 | `X15_recipient_in_struct` | `withdrawTo(Exit calldata)` with the recipient inside a struct (SURVIVED round 1) | **RED** | `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 4 | `Z1_feeRecipient_gate_in_withdraw` | `if (feeRecipient == address(1)) revert NotOwner()` in withdraw — a gate from names the contract already has | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 5 | `Z2_require_in_cutOf` | `require(performanceFeeBps != 1)` inside _cutOf | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 6 | `Z3_assembly_revert_in_collectTo` | inline-assembly `revert(0,0)` inside _collectTo | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 7 | `Z4_bytes_exit_on_vault` | new `exit(bytes calldata blob) external` on the vault (recipient smuggled through bytes) | **RED** | `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 8 | `Z5_withdrawFor_public` | new `withdrawFor(uint256 id) public` on the vault | **RED** | `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 9 | `Z6_queue_flag_in_claim` | queue `frozenAll` flag read in claim, reverting with an error claim already uses | **RED** | `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 10 | `Z7_queue_private_gate_in_timeout` | queue `_requireLive()` private gate called from timeout | **RED** | `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 11 | `Z8_queue_reclaim_bytes_payee` | new `reclaim(uint64, bytes calldata who) external` on the queue | **RED** | `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 12 | `Z9_keeper_compare_in_withdraw_branch` | `if (owner == keeper) revert NotOwner()` inside the callback's Withdraw branch | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 13 | `Z10_drop_insufficient_check` | the `InsufficientLiquidity` revert REMOVED from withdraw (the revert pin is two-sided) | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 14 | `Z11_open_condition_gate` | `|| keeperExpiry == 1` added to the Open-branch condition the exit evaluates on the way past | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 15 | `Z12_vault_fallback` | `fallback() external {}` added to the vault | **RED** | `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 16 | `Z13_modifier_gate` | `|| halted` added inside the onlyPositionOwner modifier | **RED** | `test_static_vaultExitGraphCarriesNoModifierButTheOwnerCheck` | True |
| 17 | `Z14_queue_poolManager_in_push` | `poolManager.sync(c)` inside the queue's _push | **RED** | `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 18 | `Z15_queue_key_rewritten_in_admin_fn` | queue `key` rewritten (currencies swapped) inside transferUpgradeAdmin | **RED** | `test_queueExit_cancelNeedsNoSettlerNoOracleNoAdmin`, `test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound`, `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind`, `test_queueExit_settledEpoch_claimNeedsNoOracleNoSettlerNoAdmin`, `test_static_exitStateIsWrittenOnlyAtInitialization` | True |
| 19 | `Z16_vault_poolManager_repointed_in_setter` | vault `poolManager` repointed inside setFeeRecipient | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_exitStateIsWrittenOnlyAtInitialization` | True |
| 20 | `Z17_queue_lock_bound_stretched_in_freeze` | queue `maxEpochLife` doubled inside freeze | **RED** | `test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound`, `test_static_exitStateIsWrittenOnlyAtInitialization` | True |
| 21 | `M1_whenNotPaused_on_withdraw` | `whenNotPaused` modifier on withdraw | **RED** | `test_static_noPauseMachineryAnywhereInSrc`, `test_static_vaultExitGraphCarriesNoModifierButTheOwnerCheck` | True |
| 22 | `M2a_withdrawTo_with_address` | `withdrawTo(uint256,uint128,address to) external` | **RED** | `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 23 | `M2b_rename_withdraw_param` | withdraw's second parameter renamed | **RED** | `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 24 | `M3_keeperExpiry_in_withdraw` | keeperExpiry check in withdraw | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 25 | `D2_keeperRevoked_in_withdraw` | keeperRevoked[id] check in withdraw | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 26 | `M4_whitelist_in_withdraw` | isWhitelisted check in withdraw | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 27 | `M5_consult_in_withdraw` | oracle consult() in withdraw | **RED** | `test_exit_isIndifferentToTheWhitelist`, `test_exit_needsNoKeeperCodeNoAdminCodeNoHookCodeAndNoClock`, `test_exit_survivesAnOracleThatCannotAnswer`, `test_exit_survivesTheHookCodeBeingReplacedByRevertEverything`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 28 | `D4_upgradeAdmin_in_withdraw` | upgradeAdmin == 0 check in withdraw | **RED** | `test_exit_needsNoKeeperCodeNoAdminCodeNoHookCodeAndNoClock`, `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 29 | `D5_sizeBand_in_withdraw` | size-band check in withdraw | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 30 | `D6_validateRange_in_withdraw_branch` | _validateRange in the Withdraw branch | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 31 | `M6_owner_reassigned` | position owner reassigned in setKeeperRevoked | **RED** | `test_static_positionOwnerIsWrittenOnceFromMsgSenderAndNeverReassigned` | True |
| 32 | `M7_delist_function` | delist() writing isWhitelisted=false + delete _pools | **RED** | `test_static_whitelistAndPoolKeysAreWriteOnceAndNeverDeleted`, `test_static_withdrawAbiHasNoRecipientAndNoExternalFunctionCanNameOne` | True |
| 33 | `M8_fee_take_instead_of_mint` | fee leg take() instead of mint() | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 34 | `M13_drop_init_unblockable_check` | initializer's withdrawalIsUnblockable check dropped | **RED** | `test_constructorRefusesToPinAHookThatCouldBlockExitsOrTaxDeposits`, `test_static_hookBitmapClearsTheRemovePathAndTheVaultProvesItAtInit` | True |
| 35 | `M14_drop_owner_check_on_withdraw` | onlyPositionOwner dropped from withdraw | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitGraphCarriesNoModifierButTheOwnerCheck`, `test_withdrawAllIsOwnerOnly` | True |
| 36 | `M15_collectTo_decoded_owner` | Withdraw branch pays the decoded `owner` instead of p.owner | **RED** | `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 37 | `D14_collectTo_pays_vault` | _collectTo takes to address(this) | **RED** | `test_exit_isIndifferentToTheWhitelist`, `test_exit_needsNoKeeperCodeNoAdminCodeNoHookCodeAndNoClock`, `test_exit_survivesAStaleOracleAndAMovedMarket`, `test_exit_survivesAnOracleThatCannotAnswer`, `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_exit_survivesTheHookCodeBeingReplacedByRevertEverything`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 38 | `M9_consult_in_claim` | oracle consult() in claim | **RED** | `test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound`, `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind`, `test_queueExit_settledEpoch_claimNeedsNoOracleNoSettlerNoAdmin`, `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 39 | `M10_timeout_needs_admin` | timeout requires upgradeAdmin | **RED** | `test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound`, `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind`, `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 40 | `M11_claim_pays_msgsender` | claim pays msg.sender | **RED** | `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 41 | `D10_consult_in_cancel` | oracle consult() in cancel | **RED** | `test_queueExit_cancelNeedsNoSettlerNoOracleNoAdmin`, `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 42 | `D11_timeout_bound_plus_one` | never-frozen timeout bound +1 s | **RED** | `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind` | True |
| 43 | `D11b_frozen_timeout_bound_plus_one` | frozen timeout bound +1 s | **RED** | `test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound` | True |
| 44 | `D12_freeze_stamps_press` | freeze stamps block.timestamp instead of the scheduled cutoff | **RED** | `test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound` | True |
| 45 | `M12_whenNotPaused_in_router` | `whenNotPaused` modifier declared in MoleRouter | **RED** | `test_static_noPauseMachineryAnywhereInSrc` | True |
| 46 | `D13_router_accepts_stray_ether` | router receive() accepts stray ether | **RED** | `test_router_custodiesNothingBetweenTransactions_tokensClaimsAndEther` | True |
| 47 | `M16_vault_extra_base` | abstract base `Gate` added to MolePositions | **RED** | `test_static_exitContractsInheritOnlyTheKnownBases` | True |
| 48 | `M17_queue_payout_to_address` | `payout(uint64,uint256,address to) external` on the queue | **RED** | `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 49 | `D15_unblockable_always_true` | HookPermissions.withdrawalIsUnblockable returns true | **RED** | `test_control_aDeadHookWithTheRemoveBitBlocksRemoval_oursDoesNot`, `test_isValidAcceptsOnlyExactBitmap` | True |
| 50 | `Y1_collect_swapped_currencies` | _collectTo takes with the currencies swapped | **RED** | `test_exit_survivesAStaleOracleAndAMovedMarket`, `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_exit_survivesTheHookCodeBeingReplacedByRevertEverything` | True |
| 51 | `Y2_withdraw_no_liquidity_decrement` | withdraw never decrements p.liquidity | **RED** | `test_exit_isIndifferentToTheWhitelist`, `test_exit_needsNoKeeperCodeNoAdminCodeNoHookCodeAndNoClock`, `test_exit_survivesAStaleOracleAndAMovedMarket`, `test_exit_survivesAnOracleThatCannotAnswer`, `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_exit_survivesTheHookCodeBeingReplacedByRevertEverything` | True |
| 52 | `Y3_ownerCheck_or_keeper` | owner check widened to the keeper | **RED** | `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_static_vaultExitGraphCarriesNoModifierButTheOwnerCheck` | True |
| 53 | `Y4_queue_cancel_ignores_phase` | cancel ignores the cutoff phase | **RED** | `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind`, `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 54 | `Y5_queue_timeout_phase_settled` | timeout lands the epoch in Settled | **RED** | `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind`, `test_static_queueExitGraphCarriesNoModifierAndReadsNoOracleNoPoolNoAdmin` | True |
| 55 | `Y6b_whenNotPaused_inside_library` | `whenNotPausedProbe()` inside library ZapLogic | **RED** | `test_static_noPauseMachineryAnywhereInSrc` | True |
| 56 | `Y9_queue_claim_not_marked_withdrawn` | claim does not set o.withdrawn | **RED** | `test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind` | True |
| 57 | `Y11_withdraw_pays_keeper` | Withdraw branch pays `keeper` | **RED** | `test_exit_isIndifferentToTheWhitelist`, `test_exit_needsNoKeeperCodeNoAdminCodeNoHookCodeAndNoClock`, `test_exit_survivesAStaleOracleAndAMovedMarket`, `test_exit_survivesAnOracleThatCannotAnswer`, `test_exit_survivesEveryHostileLeverAndTheBurnedRootKey`, `test_exit_survivesTheHookCodeBeingReplacedByRevertEverything`, `test_static_vaultExitBodiesReadNoKeeperOracleAdminWhitelistClockOrBound` | True |
| 58 | `Y12_whitelist_readmission_allowed` | whitelistPool re-admission allowed | **RED** | `test_exit_isIndifferentToTheWhitelist`, `test_static_whitelistAndPoolKeysAreWriteOnceAndNeverDeleted` | True |

**58/58 RED; survivors: []; errors: []**

Not covered by this campaign (stated so nobody reads it as more than it is): an arithmetic trap built only
from identifiers a body already allows (e.g. a division whose divisor can be made zero from allowed names);
a change inside v4-core itself (PoolManager / Hooks dispatch) — only the negative-control test touches that;
a base-contract change in OpenZeppelin's Initializable/UUPSUpgradeable (the inheritance list is pinned, the
bases' bodies are not read); and token-level exit blockers, which are F-EXIT-1 above.
