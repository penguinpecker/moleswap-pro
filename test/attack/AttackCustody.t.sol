// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  src/MolePositions.sol
  Lens:    "can anyone ever receive tokens who is not the position owner?"
  Verdict (2026-08-03, after the rebalance rewrite): the headline claim now HOLDS on
           every path this file can reach. Every attack below is re-run unchanged; the
           expectations are the ones that make the fix falsifiable.

  ---------------------------------------------------------------------------
  WHAT THIS FILE USED TO PROVE, AND WHAT IT PINS NOW

  The 2026-08-01 break was a single root cause: `rebalance()` conserved the LIQUIDITY
  NUMBER while moving the RANGE. The token value of a fixed L depends on range width,
  so re-minting the same L at a narrower range needed fewer tokens and left a surplus.
  `_settleNet` parked that surplus in `address(this)` — ONE UNATTRIBUTED POT SHARED BY
  EVERY POSITION — and funded widening rebalances out of it. A keeper narrowed a victim,
  widened its own position out of the pot, and withdrew to itself legitimately.

  The fix conserves TOKEN AMOUNTS instead: the burn's actual returns are re-quoted into
  liquidity at the new range with LiquidityAmounts.getLiquidityForAmounts (rounds down),
  fees ride inside those amounts and therefore COMPOUND into the owner's own position,
  dust goes to the OWNER via _collectTo, and `_settleNet` is gone. The contract holds no
  inventory and spends none.

  So the load-bearing invariant of this whole file is now one line, asserted after every
  single step of every attack below:

        t0.balanceOf(address(mole)) == 0  &&  t1.balanceOf(address(mole)) == 0

  That balance is EXACTLY what `_settleNet` used to accumulate. If a future change gives
  MolePositions an inventory again, the pot is back, and these tests go red at the exact
  step that used to fund the theft. The tests assert the invariant rather than a revert
  string on purpose: the invariant survives refactors, error renames and reorderings.

  R1. F1 IS DEAD — test_regression_keeperCannotDrainVictimThroughSharedPot
      The three-transaction drain (narrow the victim -> widen self -> withdraw to self)
      is executed in full. The pot never forms, the keeper ends with LESS than it staked,
      and the victim recovers her deposit to within rounding dust.
      Was: keeper +23.055e18 on a 0.2695e18 stake, victim -98.84%.

  R2. F2 IS DEAD — test_regression_sameRangeRebalanceCompoundsFeesIntoOwnerPosition
      A same-range rebalance after real swap fees no longer sweeps the fees. It INCREASES
      p.liquidity, because the fees are inside the burned amounts and get re-minted into
      the owner's own position. Liquidity growth on a same-range rebalance is the direct
      fingerprint of the fix and cannot be faked by a contract that sweeps.

  R3. F3 IS DEAD — test_regression_noValueCanEverStrandInTheContract
      There is nothing to strand. The shrink that used to create the black hole leaves the
      contract at exactly zero, and the owner's value is in her position, not in the pot.
      The access-control probes are kept: they still pin that nothing but open/withdraw/
      rebalance/whitelistPool/unlockCallback exists, so if a balance ever DID appear it
      would still be unreachable — which is why the zero must be structural.

  R4. F4 IS DEAD — test_regression_freshDeploymentRebalanceIsSelfFunding
      The first rebalance of a fresh deployment used to revert TransferFailed, because
      re-minting the same L cost a wei more than the burn returned and `_settleNet` had to
      pay from a zero balance. Rounding down at the re-quote makes the mint provably
      payable from the burn, so shrink, widen and same-range all work on a zero-balance
      contract with no anonymous donation.

  R5. F5 IS DEAD — test_regression_hookThatCanBlockWithdrawalCannotBeWhitelisted
      whitelistPool is now a FAIL-CLOSED ALLOWLIST on hook identity: a pool is admissible IFF its
      hook equals the immutable `moleHook` pin. Every test here pins moleHook == address(0), so the
      ONLY admissible pool is a hookless one, and EVERY foreign hook — a withdrawal-blocking hook,
      any remove-path bit, and even a hook carrying our own bitmap and no remove bit — reverts
      HookNotPermitted at the identity gate, one step BEFORE HookPermissions is consulted. That is
      strictly stronger than the old per-bit reject: the old check was fail-OPEN (it admitted every
      hook shape except the bits it enumerated — the deposit-path-validator-with-a-carve-out that
      cost Gamma $6.18M), this is deny-by-default. tickSpacing <= 0 still reverts (checked on the
      admissible hookless hook, after the identity gate). The genuinely-hookless positive control is
      still accepted, so the gate is an allowlist and not a blanket revert. The withdrawal-blocking
      hook is still deployed and its pool still initialised — the proof is now that this real attack
      is refused AT ADMISSION, which no position can ever get behind.

  R6. F6's IMPACT IS DEAD — test_regression_sequencerTimestampAuthorityExtractsNothing
      Unchanged attack: two back-to-back rebalances with block.number frozen, driven purely
      by vm.warp, which models exactly the authority a single sequencer has over
      block.timestamp. It still gets past the only rate limit, and it now extracts nothing.

  R7. F1 GENERALISED IS DEAD — testFuzz_regression_shrinkingRebalanceConservesOwnerValue
      Over the whole fuzz domain, every shrink leaves the contract at exactly zero, raises
      p.liquidity (narrower range, same tokens, more L), and the owner still recovers her
      deposit minus rounding only.

  ---------------------------------------------------------------------------
  RESIDUAL, NOT EXPLOITABLE, REPORTED NOT SUPPRESSED:

  * `Position.openedAtL1Block` is still written at open() and never read anywhere, and
    `error DwellNotElapsed()` is declared and never used. The contract header and
    RHChain.sol argue at length that L1-paced dwell is what makes the guard unfakeable by
    an ordering-privileged sequencer; no such guard exists in the code. R6 pins that the
    documented defence is still decorative — it just no longer protects anything that
    matters, because the value it was meant to protect can no longer be extracted at all.
    Doc-vs-code mismatch and dead code, not a custody bug.

  * whitelistPool does not require the pool to be initialised. Harmless: open() into an
    uninitialised pool reverts inside the PoolManager, so no position can be created.

  ---------------------------------------------------------------------------
  Attacks that FAILED originally and STILL fail (pinned, untouched):

  M1. unlockCallback direct call with attacker-chosen `owner` (the PAYER on the Open
      branch) -> NotPoolManager. test_attack_directUnlockCallbackWithVictimAsPayer
  M2. Malicious pool token reentering from inside `_safeTransferFrom` cannot reach
      unlockCallback, cannot nest `unlock`, cannot withdraw a foreign position.
      test_attack_maliciousTokenReentersDuringSettle
  M3. Same window used to `take()` for the attacker -> CurrencyNotSettled, whole unlock
      reverts. test_attack_maliciousTokenTakesDuringSettleWindow
  M4. Stealing the `sync -> transfer -> settle` credit -> whole unlock reverts.
      test_attack_maliciousTokenStealsSettleCredit
  M5. Third-party withdraw -> NotOwner; non-keeper rebalance -> NotKeeper.
  M6. id 0 / never-opened ids cannot reach `take(..., address(0), ...)`.
  M7. owner is immutable in practice; survives keeper rebalance + partial withdraw.
  M8. keeper cannot widen its own bounds, misorder ticks, ignore spacing, or beat the
      interval.
  M9. Fuzzed: withdraw pays the stored owner and nobody else.

  BUILD NOTE: foundry.toml now carries optimizer_runs = 44444444 (v4-core upstream). At
  800/1000, solc 0.8.26 + via_ir cannot compile v4-core's PoolManager at all, so no test
  importing Deployers compiled. Plain `forge test` works now.
//////////////////////////////////////////////////////////////////////////////*/

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {SortTokens} from "@uniswap/v4-core/test/utils/SortTokens.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/* ------------------------------------------------------------------ helpers */

/// @notice A pool token that reenters MolePositions from inside `transferFrom`,
///         i.e. exactly in the middle of `sync -> transfer -> settle`.
contract ReenteringToken is MockERC20 {
    enum Mode {
        Off,
        ProbeGuards,
        TakeForSelf,
        StealSettleCredit
    }

    Mode public mode;
    MolePositions public mole;
    IPoolManager public pm;
    Currency public self;
    address public thief;
    uint256 public victimId;

    // probe results
    bool public unlockCallbackReverted;
    bool public unlockCallbackRevertedWithNotPoolManager;
    bool public nestedUnlockReverted;
    bool public foreignWithdrawReverted;
    bool public foreignWithdrawRevertedWithNotOwner;
    bool public probeRan;

    constructor() MockERC20("REENTER", "RE", 18) {}

    function configure(MolePositions _mole, IPoolManager _pm, address _thief) external {
        mole = _mole;
        pm = _pm;
        thief = _thief;
        self = Currency.wrap(address(this));
    }

    function arm(Mode _mode, uint256 _victimId) external {
        mode = _mode;
        victimId = _victimId;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        Mode m = mode;
        if (m != Mode.Off) {
            mode = Mode.Off; // fire once
            if (m == Mode.ProbeGuards) {
                _probeGuards();
            } else if (m == Mode.TakeForSelf) {
                // Steal from the PoolManager while it is unlocked by MolePositions.
                // Deliberately small, so that the settle() that follows still nets
                // positive and we observe the accounting guard rather than an
                // incidental balance underflow.
                pm.take(self, thief, 1e6);
            } else if (m == Mode.StealSettleCredit) {
                // Front-run MolePositions' own settle() and claim the credit for the
                // tokens that are about to arrive. Do the transfer first ourselves.
                super.transferFrom(from, to, amount);
                pm.settle();
                return true;
            }
        }
        return super.transferFrom(from, to, amount);
    }

    function _probeGuards() private {
        probeRan = true;

        // 1. Reach unlockCallback directly with attacker-chosen calldata. The Open branch
        //    uses the decoded `owner` as the PAYER, so a success here drains any approver.
        bytes memory forged = abi.encode(
            MolePositions.Action.Open, victimId, thief, int256(1), int24(0), int24(0), type(uint256).max, type(uint256).max
        );
        try mole.unlockCallback(forged) {
            unlockCallbackReverted = false;
        } catch (bytes memory err) {
            unlockCallbackReverted = true;
            unlockCallbackRevertedWithNotPoolManager =
                (err.length >= 4 && bytes4(err) == MolePositions.NotPoolManager.selector);
        }

        // 2. Open a nested unlock so that OUR data reaches unlockCallback via the PoolManager.
        try pm.unlock(forged) {
            nestedUnlockReverted = false;
        } catch {
            nestedUnlockReverted = true;
        }

        // 3. Withdraw someone else's position mid-unlock.
        try mole.withdraw(victimId, 1) {
            foreignWithdrawReverted = false;
        } catch (bytes memory err) {
            foreignWithdrawReverted = true;
            foreignWithdrawRevertedWithNotOwner =
                (err.length >= 4 && bytes4(err) == MolePositions.NotOwner.selector);
        }
    }
}

/// @notice Placed (via vm.etch) at an address carrying a remove-liquidity flag.
///         Reverts on every callback the PoolManager makes to it.
contract WithdrawBlockingHook {
    error WithdrawalsAreBlocked();

    fallback() external {
        revert WithdrawalsAreBlocked();
    }
}

/* -------------------------------------------------------------------- tests */

contract AttackCustody is Deployers {
    using PoolIdLibrary for PoolKey;

    MolePositions internal mole;

    address internal KEEPER = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    MockERC20 internal t0;
    MockERC20 internal t1;

    uint32 internal constant INTERVAL = 1 hours;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;
    int24 internal constant SPACING = 60;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        // Deep background liquidity so swaps and rebalances behave like a real pool.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );

        mole = deployMoleVault(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        mole.whitelistPool(key);

        _fund(alice);
        _fund(bob);
        _fund(mallory);
        _fund(KEEPER);
    }

    function _fund(address who) internal {
        t0.transfer(who, 1_000e18);
        t1.transfer(who, 1_000e18);
        vm.startPrank(who);
        t0.approve(address(mole), type(uint256).max);
        t1.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address who) internal view returns (uint256, uint256) {
        return (t0.balanceOf(who), t1.balanceOf(who));
    }

    /// @dev THE invariant of the whole fix, in one place. `_settleNet` is what used to make this
    ///      non-zero; there is no longer any code path that credits or debits address(this).
    ///      Asserted after every step of every attack, not just at the end, so a regression is
    ///      localised to the transaction that reintroduced the pot.
    function _assertNoPot(MolePositions m, MockERC20 a, MockERC20 b, string memory whenWhat) internal view {
        assertEq(a.balanceOf(address(m)), 0, string.concat("POT REOPENED (token0): ", whenWhat));
        assertEq(b.balanceOf(address(m)), 0, string.concat("POT REOPENED (token1): ", whenWhat));
    }

    function _assertNoPot(string memory whenWhat) internal view {
        _assertNoPot(mole, t0, t1, whenWhat);
    }

    /// @dev Close a position completely. Post-fix, p.liquidity is NOT the number it was opened
    ///      with — a rebalance re-quotes it — so "withdraw everything" must read storage.
    function _withdrawAll(MolePositions m, address who, uint256 id) internal returns (uint128 removed) {
        removed = m.getPosition(id).liquidity;
        vm.prank(who);
        m.withdraw(id, removed);
        assertEq(m.getPosition(id).liquidity, 0, "position not fully closed");
    }

    /* =========================================================== R1 (was F1) */

    /// @notice WAS test_attack_keeperDrainsVictimThroughSettleNetSharedPot, which proved a
    ///         compromised keeper could narrow a victim into the shared `_settleNet` pot, widen
    ///         its own position out of that pot, and withdraw 86x its stake. NOW pins that the pot
    ///         never forms: the contract balance is exactly zero after every step of the identical
    ///         three-transaction attack, the keeper cannot end up ahead, and the victim's value
    ///         stays in the victim's position.
    function test_regression_keeperCannotDrainVictimThroughSharedPot() public {
        // --- victim opens a normal, wide position -----------------------------
        (uint256 a0Before, uint256 a1Before) = _bal(alice);
        vm.prank(alice);
        uint256 aliceId = mole.open(key, -6000, 6000, 100e18, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 a0After, uint256 a1After) = _bal(alice);
        uint256 aliceDeposited0 = a0Before - a0After;
        uint256 aliceDeposited1 = a1Before - a1After;
        assertGt(aliceDeposited0, 0, "alice must have paid in");
        assertGt(aliceDeposited1, 0, "alice must have paid in");

        // --- attacker (the keeper) opens the cheapest possible position -------
        (uint256 k0Start, uint256 k1Start) = _bal(KEEPER);
        vm.prank(KEEPER);
        uint256 keeperId = mole.open(key, -60, 60, 90e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint128 keeperLiqAtOpen = mole.getPosition(keeperId).liquidity;

        _assertNoPot("after both opens");
        vm.warp(block.timestamp + INTERVAL + 1);

        // --- step 1: squeeze the victim to minimum width. This is the move that used to
        //     dump >20e18 of each token into address(this).
        vm.prank(KEEPER);
        mole.rebalance(aliceId, -60, 60);

        _assertNoPot("after the keeper squeezed the victim to minimum width");

        // The victim's value did not leave: it bought MORE liquidity at the narrower range.
        // Same tokens, one hundredth of the width -> a much larger L. This is the fix's
        // signature and the exact opposite of the old behaviour, which held L at 100e18 and
        // shipped the difference to the contract.
        uint128 aliceLiqAfterSqueeze = mole.getPosition(aliceId).liquidity;
        assertGt(aliceLiqAfterSqueeze, 100e18, "narrowing must buy MORE liquidity, not bank a surplus");

        // --- step 2: widen the attacker's own position. There is nothing to fund it from,
        //     so it can only be funded by its own burn -> its L must SHRINK.
        vm.prank(KEEPER);
        mole.rebalance(keeperId, -6000, 6000);

        _assertNoPot("after the keeper widened its own position");
        uint128 keeperLiqAfterWiden = mole.getPosition(keeperId).liquidity;
        assertLt(keeperLiqAfterWiden, keeperLiqAtOpen, "widening must cost liquidity, not be subsidised");

        // --- step 3: the keeper withdraws everything it has to itself. Legitimate: it really
        //     is the stored owner. The question is only whether it is ahead.
        _withdrawAll(mole, KEEPER, keeperId);
        _assertNoPot("after the keeper withdrew to itself");

        (uint256 k0End, uint256 k1End) = _bal(KEEPER);

        // NO PROFIT. The keeper gets back its own stake minus v4's rounding against the LP.
        assertLe(k0End, k0Start, "REGRESSION: keeper profited in token0");
        assertLe(k1End, k1Start, "REGRESSION: keeper profited in token1");

        // --- the victim is made whole --------------------------------------------
        (uint256 av0, uint256 av1) = _bal(alice);
        _withdrawAll(mole, alice, aliceId);
        (uint256 aw0, uint256 aw1) = _bal(alice);
        uint256 aliceRecovered0 = aw0 - av0;
        uint256 aliceRecovered1 = aw1 - av1;

        _assertNoPot("after the victim withdrew");

        // Rounding-only loss. The old numbers were 25.917e18 in, 0.2995e18 out (-98.84%).
        assertGe(aliceRecovered0, _floorBps(aliceDeposited0, 9999), "victim lost more than rounding in token0");
        assertGe(aliceRecovered1, _floorBps(aliceDeposited1, 9999), "victim lost more than rounding in token1");
        // And no value was conjured either: without swaps there are no fees to earn.
        assertLe(aliceRecovered0, aliceDeposited0, "victim recovered more than deposited without fees");
        assertLe(aliceRecovered1, aliceDeposited1, "victim recovered more than deposited without fees");

        emit log_named_decimal_uint("keeper start token0      ", k0Start, 18);
        emit log_named_decimal_uint("keeper end   token0      ", k0End, 18);
        emit log_named_decimal_uint("victim deposited token0  ", aliceDeposited0, 18);
        emit log_named_decimal_uint("victim recovered token0  ", aliceRecovered0, 18);
        emit log_named_uint("keeper loss to rounding wei", k0Start - k0End);
        emit log_named_uint("victim loss to rounding wei", aliceDeposited0 - aliceRecovered0);
    }

    /* =========================================================== R2 (was F2) */

    /// @notice WAS test_attack_keeperConfiscatesAccruedFeesIntoDeadBalance, which proved a
    ///         same-range rebalance swept 100% of the owner's accrued fees into address(this).
    ///         NOW pins the property that killed it: a same-range rebalance INCREASES
    ///         p.liquidity, because the fees are inside the burned amounts and get re-minted
    ///         into the owner's own position. A contract that sweeps cannot make L grow here.
    function test_regression_sameRangeRebalanceCompoundsFeesIntoOwnerPosition() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -6000, 6000, 100e18, type(uint256).max, type(uint256).max, block.timestamp);

        // A control LP with an identical position that is never rebalanced.
        vm.prank(bob);
        uint256 controlId = mole.open(key, -6000, 6000, 100e18, type(uint256).max, type(uint256).max, block.timestamp);

        // PHASE 1: generate real fees for both positions, then return the price roughly home.
        swap(key, true, -50e18, ZERO_BYTES);
        swap(key, false, -50e18, ZERO_BYTES);
        swap(key, true, -20e18, ZERO_BYTES);
        swap(key, false, -20e18, ZERO_BYTES);

        vm.warp(block.timestamp + INTERVAL + 1);
        _assertNoPot("before the same-range rebalance");

        (uint256 aliceMid0, uint256 aliceMid1) = _bal(alice);

        // Same ticks in, same ticks out - the most benign action the keeper can take.
        vm.prank(KEEPER);
        mole.rebalance(id, -6000, 6000);

        // Nothing was confiscated: there is no place to confiscate into.
        _assertNoPot("after the same-range rebalance over accrued fees");

        MolePositions.Position memory p = mole.getPosition(id);
        assertEq(p.tickLower, -6000, "range must not move");
        assertEq(p.tickUpper, 6000, "range must not move");
        assertEq(p.owner, alice, "owner must not change");

        // THE FINGERPRINT OF THE FIX: identical range, MORE liquidity. The only source of the
        // extra L is the fee income that used to be swept.
        assertGt(p.liquidity, 100e18, "REGRESSION: same-range rebalance did not compound fees into the position");

        // Dust from the re-quote goes to the owner, never to the contract, and never negative.
        (uint256 aliceAfter0, uint256 aliceAfter1) = _bal(alice);
        assertGe(aliceAfter0, aliceMid0, "owner paid for a rebalance");
        assertGe(aliceAfter1, aliceMid1, "owner paid for a rebalance");

        // PHASE 2: identical swap flow, now against a pool where alice's position carries the
        // extra L her fees bought and bob's does not. Compounding only shows up in the fees that
        // come AFTER it, which is exactly why the control has to keep trading alongside her.
        swap(key, true, -50e18, ZERO_BYTES);
        swap(key, false, -50e18, ZERO_BYTES);
        swap(key, true, -20e18, ZERO_BYTES);
        swap(key, false, -20e18, ZERO_BYTES);

        // And it is really the owner's money: the compounded LP now exits with strictly more
        // than the byte-identical control LP that was never rebalanced.
        uint128 aliceRemoved = _withdrawAll(mole, alice, id);
        (uint256 aliceEnd0, uint256 aliceEnd1) = _bal(alice);
        uint256 aliceOut = (aliceEnd0 - aliceMid0) + (aliceEnd1 - aliceMid1);

        (uint256 bob0, uint256 bob1) = _bal(bob);
        uint128 bobRemoved = _withdrawAll(mole, bob, controlId);
        (uint256 bobEnd0, uint256 bobEnd1) = _bal(bob);
        uint256 bobOut = (bobEnd0 - bob0) + (bobEnd1 - bob1);

        _assertNoPot("after both LPs exited");
        assertGt(aliceRemoved, bobRemoved, "rebalanced LP should hold more L than the control");
        assertGt(aliceOut, bobOut, "REGRESSION: the rebalanced LP did not out-earn the un-rebalanced control");

        emit log_named_decimal_uint("liquidity after same-range rebalance", p.liquidity, 18);
        emit log_named_decimal_uint("compounded LP exit (t0+t1)          ", aliceOut, 18);
        emit log_named_decimal_uint("control    LP exit (t0+t1)          ", bobOut, 18);
    }

    /* =========================================================== R3 (was F3) */

    /// @notice WAS test_attack_strandedBalanceIsUnrecoverableByAnyone, which proved value taken to
    ///         address(this) by a shrinking rebalance could never leave, for anyone, ever. NOW
    ///         pins that no such value is ever created: the shrink leaves the contract at exactly
    ///         zero. The access-control probes are kept intact, because they are what makes any
    ///         future non-zero balance unrecoverable - which is precisely why the zero has to be
    ///         structural rather than incidental.
    function test_regression_noValueCanEverStrandInTheContract() public {
        (uint256 b0, uint256 b1) = _bal(alice);
        vm.prank(alice);
        uint256 id = mole.open(key, -6000, 6000, 100e18, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 m0, uint256 m1) = _bal(alice);
        uint256 deposited0 = b0 - m0;
        uint256 deposited1 = b1 - m1;

        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -1200, 1200); // the shrink that used to strand a surplus forever

        // Nothing stranded. This single assertion is the whole finding, inverted.
        _assertNoPot("after the shrinking rebalance that used to strand value");
        assertGt(mole.getPosition(id).liquidity, 100e18, "shrink must convert value into liquidity");

        // The owner withdraws EVERYTHING she still has, and gets her deposit back.
        _withdrawAll(mole, alice, id);
        (uint256 e0, uint256 e1) = _bal(alice);
        assertGe(e0 - m0, _floorBps(deposited0, 9999), "owner did not recover token0");
        assertGe(e1 - m1, _floorBps(deposited1, 9999), "owner did not recover token1");
        _assertNoPot("after the owner closed the position");

        // The external surface is unchanged and still cannot move a balance. Kept verbatim from
        // the original finding: these are the reasons a pot would be unrecoverable if one existed.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.PoolAlreadyWhitelisted.selector);
        mole.whitelistPool(key);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, -60, 60);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(
            abi.encode(
                MolePositions.Action.Withdraw, id, mallory, int256(0), int24(0), int24(0), uint256(0), uint256(0)
            )
        );

        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.rebalance(id, -60, 60);

        _assertNoPot("after probing the whole external surface");
    }

    /* =========================================================== R4 (was F4) */

    /// @notice WAS test_rebalanceOnFreshDeploymentRevertsTransferFailed, which proved the first
    ///         rebalance of a fresh deployment bricked with TransferFailed because `_settleNet`
    ///         had to pay a wei of rounding deficit out of a zero balance, and only an anonymous
    ///         donation could un-brick it. NOW pins that a rebalance is self-funding by
    ///         construction: the re-quote rounds down, so the mint can never cost more than the
    ///         burn returned, and same-range / shrink / widen all succeed on a zero-balance
    ///         contract that receives no donation of any kind.
    function test_regression_freshDeploymentRebalanceIsSelfFunding() public {
        MolePositions fresh = deployMoleVault(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        fresh.whitelistPool(key);

        vm.startPrank(alice);
        t0.approve(address(fresh), type(uint256).max);
        t1.approve(address(fresh), type(uint256).max);
        uint256 id = fresh.open(key, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.stopPrank();

        _assertNoPot(fresh, t0, t1, "fresh deployment after open");

        // 1. Identical range in, identical range out - the case that used to revert.
        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        fresh.rebalance(id, -600, 600);
        _assertNoPot(fresh, t0, t1, "fresh deployment after same-range rebalance");
        assertGt(fresh.getPosition(id).liquidity, 0, "position destroyed");

        // 2. Shrink. Used to be the only direction that "worked", by stealing.
        vm.warp(block.timestamp + INTERVAL + 1);
        uint128 beforeShrink = fresh.getPosition(id).liquidity;
        vm.prank(KEEPER);
        fresh.rebalance(id, -300, 300);
        _assertNoPot(fresh, t0, t1, "fresh deployment after shrink");
        assertGt(fresh.getPosition(id).liquidity, beforeShrink, "shrink must raise L");

        // 3. Widen. Used to be a permanent DoS on a clean contract, because it could only be paid
        //    for out of somebody else's confiscated principal.
        vm.warp(block.timestamp + INTERVAL + 1);
        uint128 beforeWiden = fresh.getPosition(id).liquidity;
        vm.prank(KEEPER);
        fresh.rebalance(id, -6000, 6000);
        _assertNoPot(fresh, t0, t1, "fresh deployment after widen");
        assertLt(fresh.getPosition(id).liquidity, beforeWiden, "widen must lower L");

        // The owner can still leave, and the contract still holds nothing.
        _withdrawAll(fresh, alice, id);
        _assertNoPot(fresh, t0, t1, "fresh deployment after exit");
    }

    /* =========================================================== R5 (was F5) */

    /// @notice WAS test_attack_blockingHookWhitelistedPoolLocksWithdrawalForever, which proved
    ///         anyone could whitelist a pool whose hook carried BEFORE_REMOVE_LIQUIDITY, so a
    ///         position opened there could never be withdrawn. NOW pins the fail-closed admission
    ///         ALLOWLIST: whitelistPool admits a pool IFF its hook equals `moleHook`, and every test
    ///         here pins moleHook == address(0), so ONLY a hookless pool is admissible. A real
    ///         withdrawal-blocking hook — and every other foreign hook, remove-path bits or not — is
    ///         refused at admission with HookNotPermitted BEFORE HookPermissions is even consulted,
    ///         so no foreign-hook position can ever exist. That is strictly stronger than the old
    ///         per-bit reject, which was fail-open. The blocking hook is still deployed and its pool
    ///         still initialised, as the thing being refused; the HookPermissions asserts are kept
    ///         to document WHY each refused hook was dangerous; the genuinely-hookless positive
    ///         control shows the gate is deny-by-default, not a blanket "whitelistPool always
    ///         reverts". The old off-withdrawal-path positive control is INVERTED: a benign foreign
    ///         hook is now refused too, because admission is identity, not absence-of-power.
    function test_regression_hookThatCanBlockWithdrawalCannotBeWhitelisted() public {
        address hookAddr = address(uint160(0x8888 << 144) | uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG));
        WithdrawBlockingHook impl = new WithdrawBlockingHook();
        vm.etch(hookAddr, address(impl).code);

        assertFalse(HookPermissions.withdrawalIsUnblockable(hookAddr), "hook should be flagged as blocking");
        assertFalse(HookPermissions.isValid(hookAddr), "hook should be invalid");

        (PoolKey memory badKey,) = initPool(currency0, currency1, IHooks(hookAddr), 3000, SPACING, SQRT_PRICE_1_1);

        // The whitelist is still permissionless, and that is now fine: admission is a fail-closed
        // ALLOWLIST on hook identity (hook must equal moleHook == address(0)), so mallory is
        // refused, and so is everybody else. A real withdrawal-blocking hook is a non-zero hook, so
        // it is rejected at the identity gate — it never even reaches the (unchanged) HookPermissions
        // withdrawal check. Refused-at-admission is strictly stronger than refused-at-the-bit-check.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(badKey);

        vm.prank(alice);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(badKey);

        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(badKey);

        assertFalse(mole.isWhitelisted(badKey.toId()), "blocking-hook pool must not be registered");

        // Consequence: the trap cannot be baited. alice cannot open a position that would be
        // impossible to withdraw, and her tokens never leave her wallet.
        (uint256 b0, uint256 b1) = _bal(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(badKey, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 a0, uint256 a1) = _bal(alice);
        assertEq(a0, b0, "alice paid into an un-whitelistable pool");
        assertEq(a1, b1, "alice paid into an un-whitelistable pool");
        assertEq(mole.positionCount(), 0, "a position was created in a blocking-hook pool");

        // EVERY remove-path bit that made these hooks dangerous, individually and together —
        // WITHDRAWAL_PATH_MASK is 0x0301: BEFORE_REMOVE_LIQUIDITY (0x0200) |
        // AFTER_REMOVE_LIQUIDITY (0x0100) | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (0x0001). Under the
        // old fail-open model each was rejected by a per-bit filter; now each is rejected one step
        // earlier, at the identity gate, because it is a foreign (non-zero) hook. The
        // assertFalse(...) still documents WHY the hook was dangerous; the revert proves admission
        // never even looks at the bits — a strictly stronger guarantee.
        uint160[4] memory removeBits = [
            uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG),
            uint160(Hooks.AFTER_REMOVE_LIQUIDITY_FLAG),
            uint160(Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG),
            uint160(HookPermissions.WITHDRAWAL_PATH_MASK)
        ];
        for (uint256 i = 0; i < removeBits.length; i++) {
            assertTrue(removeBits[i] != 0, "bit constant is zero - test would be vacuous");
            // Mix in the full MoleHook bitmap too: carrying our own "authentic" permissions does not
            // buy a foreign hook admission — under identity-based admission, nothing but moleHook does.
            address blocking = address(uint160(0x4242 << 144) | uint160(HookPermissions.REQUIRED_FLAGS) | removeBits[i]);
            assertFalse(HookPermissions.withdrawalIsUnblockable(blocking), "bit should block");
            vm.prank(mallory);
            vm.expectRevert(MolePositions.HookNotPermitted.selector);
            mole.whitelistPool(_keyWithHook(blocking, SPACING));
        }

        // tickSpacing is validated too, AFTER the identity gate: these use the hookless (admissible)
        // hook address(0), so they CLEAR the allowlist and reach the spacing check, where a zero or
        // negative spacing — which makes _validateRange's modulo guard meaningless, and 0 divides by
        // zero — is rejected. This is also what proves the identity gate is passed by address(0).
        vm.prank(mallory);
        vm.expectRevert(MolePositions.InvalidTickSpacing.selector);
        mole.whitelistPool(_keyWithHook(address(0), 0));

        vm.prank(mallory);
        vm.expectRevert(MolePositions.InvalidTickSpacing.selector);
        mole.whitelistPool(_keyWithHook(address(0), -60));

        // INVERTED POSITIVE CONTROL. Under the old fail-open model a foreign hook that was merely off
        // the withdrawal path (every MoleHook bit, no remove bit) was ACCEPTED — admission was
        // "absence of power over the withdrawal path". That is the same fail-open,
        // validator-with-a-carve-out shape the design abandoned. Admission is now IDENTITY, not
        // power: this hook is provably unblockable AND untaxable and is STILL refused, purely because
        // it is not `moleHook`.
        address benign = address(uint160(0x1234 << 144) | uint160(HookPermissions.REQUIRED_FLAGS));
        assertTrue(HookPermissions.withdrawalIsUnblockable(benign), "control hook is off the withdrawal path");
        assertTrue(HookPermissions.depositIsUntaxable(benign), "control hook cannot tax a deposit");
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(_keyWithHook(benign, SPACING));
        assertFalse(
            mole.isWhitelisted(_keyWithHook(benign, SPACING).toId()),
            "an off-withdrawal-path foreign hook must NOT be admitted under identity-based admission"
        );

        // GENUINELY-HOOKLESS POSITIVE CONTROL, so none of the above is vacuous and the gate is a
        // deny-by-default ALLOWLIST rather than a blanket revert: a hookless pool (hook == moleHook
        // == address(0)) on a fresh tickSpacing is admitted. setUp already admitted the hookless
        // `key`; this proves acceptance for a pool this test registers itself.
        PoolKey memory hookless = _keyWithHook(address(0), 120);
        assertFalse(mole.isWhitelisted(hookless.toId()), "hookless control must start un-whitelisted");
        vm.prank(mallory);
        mole.whitelistPool(hookless);
        assertTrue(mole.isWhitelisted(hookless.toId()), "a hookless pool must be admitted");
    }

    /* =========================================================== R6 (was F6) */

    /// @notice WAS test_attack_rateLimitIsTimestampOnlyAndL1BlockGuardIsNeverRead, which proved the
    ///         only rate limit on the drain was block.timestamp - a clock the single Robinhood
    ///         sequencer writes - while the L1-paced `openedAtL1Block` dwell guard the contract
    ///         documents at length is never read. The unread field is STILL unread (reported as a
    ///         doc-vs-code residual, not suppressed). What this now pins is that the sequencer's
    ///         unlimited authority over the clock buys it nothing: two back-to-back rebalances
    ///         with block.number frozen extract exactly zero.
    function test_regression_sequencerTimestampAuthorityExtractsNothing() public {
        uint256 l1BlockAtOpen = block.number;

        (uint256 b0, uint256 b1) = _bal(alice);
        vm.prank(alice);
        uint256 id = mole.open(key, -6000, 6000, 100e18, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 m0, uint256 m1) = _bal(alice);
        uint256 deposited0 = b0 - m0;
        uint256 deposited1 = b1 - m1;
        assertEq(mole.getPosition(id).openedAtL1Block, uint64(l1BlockAtOpen), "openedAtL1Block not stamped");

        // Advance only the sequencer-controlled clock. L1 height is frozen throughout.
        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -1200, 1200);
        assertEq(block.number, l1BlockAtOpen, "block.number moved - test would not model the chain");
        _assertNoPot("after rebalance 1 with zero L1 dwell");

        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -60, 60);
        assertEq(block.number, l1BlockAtOpen, "block.number moved - test would not model the chain");
        _assertNoPot("after rebalance 2 with zero L1 dwell");

        // The dwell field is still never read and still gates nothing. Kept as an assertion so the
        // finding stays visible rather than quietly disappearing from the suite.
        assertEq(mole.getPosition(id).openedAtL1Block, uint64(l1BlockAtOpen), "openedAtL1Block mutated");

        // Two full rebalances at maximum sequencer speed, zero L1 dwell, zero extraction: the
        // owner still gets her deposit back minus rounding.
        _withdrawAll(mole, alice, id);
        (uint256 e0, uint256 e1) = _bal(alice);
        assertGe(e0 - m0, _floorBps(deposited0, 9999), "value was extracted with no L1 time passing (token0)");
        assertGe(e1 - m1, _floorBps(deposited1, 9999), "value was extracted with no L1 time passing (token1)");
        _assertNoPot("after two unrestrained rebalances and a full exit");
    }

    /* =========================================================== R7 (was F1, fuzzed) */

    /// @notice WAS testFuzz_attack_anyShrinkingRebalanceDrainsThePosition, which proved that over
    ///         the whole domain EVERY shrink moved owner value into the contract's pot and left the
    ///         owner unable to recover her deposit. NOW pins the inverse over the same domain: the
    ///         contract balance is exactly zero afterwards, the shrink RAISES p.liquidity, and the
    ///         owner recovers her deposit minus rounding only.
    function testFuzz_regression_shrinkingRebalanceConservesOwnerValue(uint128 liq, uint16 halfWidthSteps) public {
        liq = uint128(bound(liq, 1e15, 200e18));
        // new half-width in [60, 3000], on spacing, always inside [MIN_W, MAX_W] and always
        // strictly narrower than the [-6000, 6000] the position is opened at.
        int24 half = int24(int256(uint256(bound(halfWidthSteps, 1, 50)) * 60));

        (uint256 b0, uint256 b1) = _bal(alice);
        vm.prank(alice);
        uint256 id = mole.open(key, -6000, 6000, liq, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 m0, uint256 m1) = _bal(alice);
        uint256 deposited = (b0 - m0) + (b1 - m1);
        assertGt(deposited, 0, "nothing was deposited - fuzz case is vacuous");

        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -half, half);

        // 1. No pot. Ever. For any size and any width.
        _assertNoPot("after a fuzzed shrinking rebalance");

        // 2. The value stayed in the position: a strictly narrower range must buy strictly more L.
        assertGt(mole.getPosition(id).liquidity, liq, "shrink diverted value instead of converting it to L");

        // 3. The owner can still take it all out.
        _withdrawAll(mole, alice, id);
        (uint256 e0, uint256 e1) = _bal(alice);
        uint256 recovered = (e0 - m0) + (e1 - m1);

        // No swaps happen in this test, so there are no fees: recovery is bounded above by the
        // deposit and below by the deposit minus v4's round-against-the-LP dust.
        assertLe(recovered, deposited, "owner recovered more than deposited with no fee income");
        assertGe(recovered, _floorBps(deposited, 9990), "owner value was diverted, not conserved");
        _assertNoPot("after the fuzzed owner exit");
    }

    /* ==================================================================== M1 */

    /// @notice The Open branch of unlockCallback uses the CALLDATA-supplied address as
    ///         the payer. If it were reachable, any approver could be drained. It is not.
    function test_attack_directUnlockCallbackWithVictimAsPayer() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);

        (uint256 a0, uint256 a1) = _bal(alice);

        // bob has approved mole (see _fund) and has never opened anything.
        bytes memory forged = abi.encode(
            MolePositions.Action.Open, id, bob, int256(1e18), int24(0), int24(0), type(uint256).max, type(uint256).max
        );

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(forged);

        // And the Withdraw branch cannot be pointed at a caller-chosen recipient either,
        // because it reads p.owner - but it is unreachable regardless.
        bytes memory forged2 = abi.encode(
            MolePositions.Action.Withdraw, id, mallory, -int256(10e18), int24(0), int24(0), uint256(0), uint256(0)
        );
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(forged2);

        (uint256 a0b, uint256 a1b) = _bal(alice);
        assertEq(a0, a0b, "alice balance moved");
        assertEq(a1, a1b, "alice balance moved");
        _assertNoPot("after forged unlockCallback attempts");
    }

    /* ==================================================================== M2 */

    function test_attack_maliciousTokenReentersDuringSettle() public {
        (MolePositions m, PoolKey memory k, ReenteringToken evil) = _deployEvilPool();

        vm.prank(bob);
        uint256 victimId = m.open(k, -600, 600, 5e18, type(uint256).max, type(uint256).max, block.timestamp);

        evil.arm(ReenteringToken.Mode.ProbeGuards, victimId);

        vm.prank(alice);
        m.open(k, -600, 600, 5e18, type(uint256).max, type(uint256).max, block.timestamp); // triggers the reentrancy from inside _settleFrom

        assertTrue(evil.probeRan(), "reentrancy window never opened - test is vacuous");
        assertTrue(evil.unlockCallbackReverted(), "EXPLOIT: unlockCallback was reachable by reentrancy");
        assertTrue(
            evil.unlockCallbackRevertedWithNotPoolManager(), "unlockCallback reverted for the wrong reason"
        );
        assertTrue(evil.nestedUnlockReverted(), "EXPLOIT: nested unlock succeeded");
        assertTrue(evil.foreignWithdrawReverted(), "EXPLOIT: withdrew another owner's position");
        assertTrue(evil.foreignWithdrawRevertedWithNotOwner(), "foreign withdraw reverted for the wrong reason");
    }

    /* ==================================================================== M3 */

    function test_attack_maliciousTokenTakesDuringSettleWindow() public {
        (MolePositions m, PoolKey memory k, ReenteringToken evil) = _deployEvilPool();

        uint256 thiefBefore = evil.balanceOf(mallory);
        evil.arm(ReenteringToken.Mode.TakeForSelf, 0);

        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        m.open(k, -600, 600, 5e18, type(uint256).max, type(uint256).max, block.timestamp);

        assertEq(evil.balanceOf(mallory), thiefBefore, "thief kept stolen tokens");
    }

    /* ==================================================================== M4 */

    function test_attack_maliciousTokenStealsSettleCredit() public {
        (MolePositions m, PoolKey memory k, ReenteringToken evil) = _deployEvilPool();

        evil.arm(ReenteringToken.Mode.StealSettleCredit, 0);

        uint256 aliceBefore = evil.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        m.open(k, -600, 600, 5e18, type(uint256).max, type(uint256).max, block.timestamp);

        assertEq(m.positionCount(), 0, "no position should have survived");
        assertEq(evil.balanceOf(alice), aliceBefore, "alice paid despite the revert");
        assertEq(evil.balanceOf(address(m)), 0, "MolePositions retained a balance");
    }

    /* ==================================================================== M5 */

    function test_attack_thirdPartyCannotWithdraw() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 10e18);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 10e18);
    }

    function test_attack_nonKeeperCannotRebalance() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.warp(block.timestamp + INTERVAL + 1);

        // Not even the owner of the position may rebalance it.
        vm.prank(alice);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, -60, 60);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, -60, 60);
    }

    function test_attack_keeperCannotWidenItsOwnBounds() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.warp(block.timestamp + INTERVAL + 1);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.rebalance(id, -60, 0); // width 60 < MIN_W

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.rebalance(id, -60_000, 60_000); // width 120000 > MAX_W

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.rebalance(id, -61, 600);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.TicksMisordered.selector);
        mole.rebalance(id, 600, 600);
    }

    function test_attack_keeperCannotRebalanceFasterThanInterval() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -600, 600, 10e18, type(uint256).max, type(uint256).max, block.timestamp);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceTooSoon.selector);
        mole.rebalance(id, -1200, 1200);
    }

    /* ==================================================================== M6 */

    /// @notice id 0 and never-opened ids. The dangerous shape would be reaching
    ///         `take(currency, address(0), amount)`, which burns user funds.
    function test_attack_positionZeroFromAddressZeroCaller() public {
        // Give the contract something worth burning, so a successful attack is visible.
        t0.transfer(address(mole), 5e18);

        // address(0) IS the "owner" of every unopened id, so it passes onlyPositionOwner.
        vm.prank(address(0));
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.withdraw(0, 0);

        vm.prank(address(0));
        vm.expectRevert(MolePositions.InsufficientLiquidity.selector);
        mole.withdraw(0, 1);

        vm.prank(address(0));
        vm.expectRevert(MolePositions.InsufficientLiquidity.selector);
        mole.withdraw(type(uint256).max, 1);

        // Anyone else is stopped one step earlier.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(0, 1);

        // The keeper cannot conjure a position either.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NoSuchPosition.selector);
        mole.rebalance(0, -60, 60);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NoSuchPosition.selector);
        mole.rebalance(999_999, -60, 60);

        assertEq(t0.balanceOf(address(mole)), 5e18, "balance moved via an unopened id");
    }

    /* ==================================================================== M7 */

    function test_attack_ownerIsUnchangedByKeeperAndPartialWithdraw() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -6000, 6000, 100e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(mole.ownerOf(id), alice);

        vm.warp(block.timestamp + INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -1200, 1200);
        assertEq(mole.ownerOf(id), alice, "keeper changed the owner");

        vm.prank(alice);
        mole.withdraw(id, 50e18);
        assertEq(mole.ownerOf(id), alice, "partial withdraw changed the owner");

        // And the position list is append-only per owner.
        assertEq(mole.positionsOf(alice).length, 1);
        assertEq(mole.positionsOf(mallory).length, 0);
    }

    /// @notice Fuzz the one lens that matters on the honest path: a withdraw never
    ///         pays anyone except the stored owner.
    function testFuzz_attack_withdrawOnlyEverPaysStoredOwner(uint128 liquidity, uint16 removeBps, address caller)
        public
    {
        liquidity = uint128(bound(liquidity, 1e12, 500e18));
        removeBps = uint16(bound(removeBps, 1, 10_000));
        vm.assume(caller != alice && caller != address(0) && caller != address(mole));

        vm.prank(alice);
        uint256 id = mole.open(key, -600, 600, liquidity, type(uint256).max, type(uint256).max, block.timestamp);

        uint128 toRemove = uint128((uint256(liquidity) * removeBps) / 10_000);
        vm.assume(toRemove > 0);

        // Anyone who is not the stored owner is refused, whoever they are.
        vm.prank(caller);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, toRemove);

        uint256 callerBefore0 = t0.balanceOf(caller);
        uint256 callerBefore1 = t1.balanceOf(caller);
        (uint256 o0, uint256 o1) = _bal(alice);
        vm.prank(alice);
        mole.withdraw(id, toRemove);
        (uint256 n0, uint256 n1) = _bal(alice);

        assertGe(n0 + n1, o0 + o1, "owner did not receive the proceeds");
        // The lens is "did anyone who is not the owner RECEIVE a token", so the bound is one-sided.
        // Equality would be wrong rather than stricter: at 50k fuzz runs the address space includes
        // the PoolManager itself, whose balance necessarily FALLS because it is the account the
        // proceeds are paid out of. A one-sided bound covers every address including that one, and
        // still fails on any gain by any third party, contract or EOA.
        assertLe(t0.balanceOf(caller), callerBefore0, "a non-owner RECEIVED token0");
        assertLe(t1.balanceOf(caller), callerBefore1, "a non-owner RECEIVED token1");
        assertEq(mole.ownerOf(id), alice);
        _assertNoPot("after a fuzzed owner withdraw");
    }

    /* ---------------------------------------------------------------- helper */

    /// @dev `x * bps / 10000`, used for "recovered at least this much of the deposit" bounds.
    function _floorBps(uint256 x, uint256 bps) internal pure returns (uint256) {
        return (x * bps) / 10_000;
    }

    /// @dev A PoolKey with an arbitrary hook address. whitelistPool only inspects the key, so this
    ///      does not need an initialised pool - which is the point: the guard must reject the key
    ///      before anything else can happen.
    function _keyWithHook(address hook, int24 tickSpacing) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: tickSpacing,
            hooks: IHooks(hook)
        });
    }

    function _deployEvilPool() internal returns (MolePositions m, PoolKey memory k, ReenteringToken evil) {
        evil = new ReenteringToken();
        MockERC20 other = new MockERC20("OTHER", "OTH", 18);

        (Currency c0, Currency c1) = SortTokens.sort(MockERC20(address(evil)), other);
        (k,) = initPool(c0, c1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);

        m = deployMoleVault(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        evil.configure(m, manager, mallory);

        evil.mint(address(this), 1_000e18);
        other.mint(address(this), 1_000e18);
        evil.approve(address(modifyLiquidityRouter), type(uint256).max);
        other.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100e18, salt: 0}),
            ZERO_BYTES
        );

        address[2] memory users = [alice, bob];
        for (uint256 i = 0; i < users.length; i++) {
            evil.mint(users[i], 100e18);
            other.mint(users[i], 100e18);
            vm.startPrank(users[i]);
            evil.approve(address(m), type(uint256).max);
            other.approve(address(m), type(uint256).max);
            vm.stopPrank();
        }
    }
}
