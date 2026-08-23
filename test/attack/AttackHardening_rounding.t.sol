// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Position as V4Position} from "v4-core/libraries/Position.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {ZapLogic} from "../../src/libraries/ZapLogic.sol";
import {VulnerableMolePositions} from "../invariant/mutants/VulnerableMolePositions.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  MolePositions under a GRIND — N >= 100 dust operations of every kind mixed together (open
           at dust size, one-wei partial withdraw, dust zap, narrow-then-widen rebalance), with a
           victim position and third-party liquidity alongside (dossier Part 2 §8 Bunni, §14 rounding
           rule, P-73 "rounding never favours the user over a >=100-cycle loop").
  Lens:    Bunni's $8.4M was a one-wei-class rounding residue on a SUBTRACTED quantity, amplified by
           repetition. AttackFinal_precision already grinds open/withdraw (N-2) and same-range rebalance
           (N-3) in isolation. This file mixes every dust op in one loop, adds the zap, narrows and
           widens, and asks three things at every step and at the end:
             (a) the grinder never ends richer than they started, in either token;
             (b) the VICTIM's exit is IDENTICAL to a control world where the grind never happened;
             (c) the pool's third-party LP can still exit with IDENTICAL proceeds — so whatever rounding
                 leaks, it leaks INTO the pool and never out of it;
           and that the vault custodies nothing and stored liquidity equals on-chain liquidity after
           every single operation.

  RESULT: HOLDS, 120 mixed ops without swaps and 120 with swaps. Negative control: the SAME grind on
  test/invariant/mutants/VulnerableMolePositions.sol forms a shared pot inside the contract (the 08-01
  shape), so the custody assertion this file makes on every step is one that fails on a contract known
  to be broken — it is not green by construction. Direct mutations of the LIVE contract, each run and
  each RED on both grinds (see HARDENING-FINDINGS.md): rebalance paying its residual to the vault itself
  (the shared-pot shape) -> custody RED; rebalance not writing `p.liquidity = newLiquidity` -> INV-4 RED;
  withdraw burning one unit less than it records -> INV-4 RED.
//////////////////////////////////////////////////////////////////////////////*/
contract AttackHardeningRounding is HardeningBase {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant N = 120;

    uint256[] internal attackerIds;
    uint256 internal bigId;

    function setUp() public {
        _buildWorld(0);
    }

    /* ------------------------------------------------------------------ helpers */

    function _tick() internal view returns (int24 tick) {
        (, tick,,) = StateLibrary.getSlot0(manager, hookId);
    }

    /// @dev The spacing-aligned tick NEAREST to spot — so a range centred on it is as symmetric as the
    ///      grid allows, and a narrow/widen pair re-mints most of both legs rather than ejecting one.
    function _centre() internal view returns (int24) {
        int24 t = _tick();
        int24 f = (t / SPACING) * SPACING;
        if (t < 0 && f != t) f -= SPACING; // floor
        return (t - f) * 2 >= SPACING ? f + SPACING : f;
    }

    function _assertCustodyAndInv4(uint256 id, string memory when) internal view {
        _assertHoldsNothing(address(vault), when);
        assertEq(vault.getPosition(id).liquidity, _onChainLiquidity(id), string.concat("INV-4 broke: ", when));
    }

    function _zapDust(int24 lo, int24 hi, uint256 amountIn) internal view returns (ZapLogic.ZapParams memory) {
        return ZapLogic.ZapParams({
            key: hookKey,
            tickLower: lo,
            tickUpper: hi,
            zeroForOne: true,
            amountIn: amountIn,
            swapAmount: amountIn * 3 / 10,
            minLiquidity: 1,
            amountOutMin: 0
        });
    }

    /// @dev ONE grind cycle, indexed by `i`. Every branch asserts custody + INV-4 on the id it touched.
    ///      `withZap` adds the one-token deposit (whose internal swap moves spot by a hair, so the strict
    ///      A/B world leaves it out and the bounded world puts it in).
    function _cycle(uint256 i, bool withZap) internal {
        int24 c = _centre();
        int24 lo = c - SPACING;
        uint256 k = i % (withZap ? 6 : 5);
        if (k == 0) {
            uint256 id = _open(mallory, lo, lo + 2 * SPACING, uint128(1 + (i % 13)));
            attackerIds.push(id);
            _assertCustodyAndInv4(id, "after dust open (straddle)");
        } else if (k == 1) {
            uint256 id = _open(mallory, lo + SPACING, lo + 3 * SPACING, uint128(7 + (i % 5)));
            attackerIds.push(id);
            _assertCustodyAndInv4(id, "after dust open (one-sided)");
        } else if (k == 2) {
            // One wei of liquidity off the newest attacker position that still has more than one.
            for (uint256 j = attackerIds.length; j > 0; --j) {
                uint256 id = attackerIds[j - 1];
                if (vault.getPosition(id).liquidity > 1) {
                    vm.prank(mallory);
                    vault.withdraw(id, 1);
                    _assertCustodyAndInv4(id, "after one-wei withdraw");
                    break;
                }
            }
        } else if (k == 3) {
            vm.prank(KEEPER);
            vault.rebalance(bigId, c - SPACING, c + SPACING); // narrow, centred on spot
            _assertCustodyAndInv4(bigId, "after narrowing rebalance");
        } else if (k == 4) {
            vm.prank(KEEPER);
            vault.rebalance(bigId, c - 2 * SPACING, c + 2 * SPACING); // widen back
            _assertCustodyAndInv4(bigId, "after widening rebalance");
        } else {
            vm.prank(mallory);
            uint256 id = vault.zapOpen(_zapDust(c - 2 * SPACING, c + 2 * SPACING, 1_000 + i), block.timestamp);
            attackerIds.push(id);
            _assertCustodyAndInv4(id, "after dust zap");
        }
    }

    function _exitAll(address who) internal {
        uint256[] memory ids = vault.positionsOf(who);
        for (uint256 i; i < ids.length; ++i) {
            if (vault.getPosition(ids[i]).liquidity == 0) continue;
            vm.prank(who);
            vault.withdrawAll(ids[i]);
        }
    }

    /// @dev Remove the third-party background liquidity entirely and report what came back.
    function _pullBackground() internal returns (uint256 got0, uint256 got1) {
        (uint256 a0, uint256 a1) = _bal(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            hookKey, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -200_000e18, salt: 0}), ZERO_BYTES
        );
        (uint256 b0, uint256 b1) = _bal(address(this));
        got0 = b0 - a0;
        got1 = b1 - a1;
    }

    /* ================================================================ 1. no swaps: strict A/B */

    /// @notice 120 mixed dust ops (no swaps at all, so the pool price is untouched and the comparison
    ///         can be exact). The grinder ends no richer; the victim's exit and the background LP's exit
    ///         are IDENTICAL to a world where the grind never ran.
    function test_grind_120MixedDustOpsLeakOnlyIntoThePool_victimAndBackgroundUnchanged() public {
        uint256 victim = _open(bob, -600, 600, 50e18);
        (uint256 m0, uint256 m1) = _bal(mallory); // BEFORE the grinder's own seed position
        bigId = _open(mallory, _centre() - 2 * SPACING, _centre() + 2 * SPACING, 1e18);

        // CONTROL: victim and background exit with no grind at all.
        uint256 snap = vm.snapshotState();
        (uint256 cv0, uint256 cv1) = _bal(bob);
        vm.prank(bob);
        vault.withdrawAll(victim);
        (uint256 cv0b, uint256 cv1b) = _bal(bob);
        (uint256 cb0, uint256 cb1) = _pullBackground();
        vm.revertToState(snap);

        for (uint256 i; i < N; ++i) {
            _cycle(i, false);
        }
        _exitAll(mallory);
        (uint256 m0b, uint256 m1b) = _bal(mallory);

        assertLe(m0b, m0, "the grinder ended richer in currency0");
        assertLe(m1b, m1, "the grinder ended richer in currency1");
        _assertHoldsNothing(address(vault), "after the grind");

        (uint256 v0, uint256 v1) = _bal(bob);
        vm.prank(bob);
        vault.withdrawAll(victim);
        (uint256 v0b, uint256 v1b) = _bal(bob);
        assertEq(v0b - v0, cv0b - cv0, "the victim's currency0 exit differs from the control");
        assertEq(v1b - v1, cv1b - cv1, "the victim's currency1 exit differs from the control");

        (uint256 g0, uint256 g1) = _pullBackground();
        assertEq(g0, cb0, "the background LP's currency0 exit differs from the control");
        assertEq(g1, cb1, "the background LP's currency1 exit differs from the control");
        _assertHoldsNothing(address(vault), "after every exit");
    }

    /* ================================================================ 2. with swaps: bounds + liveness */

    /// @notice The same ops PLUS the dust zap, with a trade every ten cycles so fees are live. Nobody can
    ///         extract more than their principal plus the TOTAL fees paid (a generous bound that a leak
    ///         would still breach), every participant can still exit in full, custody stays zero
    ///         throughout.
    function test_grind_120MixedDustOpsWithSwaps_boundsHoldAndEveryoneCanExit() public {
        (uint256 b0, uint256 b1) = _bal(bob);
        uint256 victim = _open(bob, -600, 600, 50e18);
        (uint256 m0, uint256 m1) = _bal(mallory);
        bigId = _open(mallory, _centre() - 2 * SPACING, _centre() + 2 * SPACING, 1e18);

        // GROSS swap input per token: every fee in the system is a fraction of it, so it bounds what any
        // LP can have earned.
        uint256 paidIn0;
        uint256 paidIn1;
        for (uint256 i; i < N; ++i) {
            _cycle(i, true);
            if (i % 10 == 9) {
                _advance(61);
                bool zeroForOne = i % 20 == 9;
                _swap(hookKey, zeroForOne, 20e18);
                if (zeroForOne) paidIn0 += 20e18;
                else paidIn1 += 20e18;
            }
        }

        _exitAll(mallory);
        (uint256 m0b, uint256 m1b) = _bal(mallory);
        assertLe(m0b, m0 + paidIn0, "the grinder extracted more than principal + all fees paid (c0)");
        assertLe(m1b, m1 + paidIn1, "the grinder extracted more than principal + all fees paid (c1)");

        vm.prank(bob);
        vault.withdrawAll(victim);
        (uint256 b0b, uint256 b1b) = _bal(bob);
        assertLe(b0b, b0 + paidIn0, "the victim extracted more than principal + all fees paid (c0)");
        assertLe(b1b, b1 + paidIn1, "the victim extracted more than principal + all fees paid (c1)");

        _pullBackground(); // must not revert: the pool is solvent for its last LP
        _assertHoldsNothing(address(vault), "after every exit (swap world)");
    }

    /* ================================================================ 3. negative control */

    /// @notice The grind's custody check is worth something only if it fails on a broken vault. It does:
    ///         on the 2026-08-01 mutant a narrowing rebalance parks the surplus in the contract and a
    ///         shared pot forms — exactly what `_assertCustodyAndInv4` asserts against on every step.
    function test_negativeControl_theGrindFormsAPotOnTheVulnerableContract() public {
        // A hookless world for the mutant (it is pinned to address(0) here, as the invariant suite does).
        (Currency c0, Currency c1) = deployMintAndApprove2Currencies();
        PoolKey memory k = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200_000e18, salt: 0}), ZERO_BYTES
        );
        VulnerableMolePositions mutant = new VulnerableMolePositions(manager, KEEPER, 0, MIN_W, MAX_W, address(0));
        mutant.whitelistPool(k);
        MockLike(Currency.unwrap(c0)).mint(mallory, FUNDING);
        MockLike(Currency.unwrap(c1)).mint(mallory, FUNDING);
        vm.startPrank(mallory);
        MockLike(Currency.unwrap(c0)).approve(address(mutant), type(uint256).max);
        MockLike(Currency.unwrap(c1)).approve(address(mutant), type(uint256).max);
        uint256 id = mutant.open(k, -240, 240, 1e15, type(uint256).max, type(uint256).max, block.timestamp);
        vm.stopPrank();

        uint256 pot;
        for (uint256 i; i < N; ++i) {
            vm.prank(KEEPER);
            if (i % 2 == 0) mutant.rebalance(id, -120, 120); // narrow: same L re-minted, surplus parked
            else mutant.rebalance(id, -240, 240); // widen: paid from the pot
            pot = MockLike(Currency.unwrap(c0)).balanceOf(address(mutant)) + MockLike(Currency.unwrap(c1)).balanceOf(address(mutant));
            if (pot > 0) break;
        }
        assertGt(pot, 0, "the negative control formed no pot: this file's custody check could not detect the 08-01 class");
    }
}

interface MockLike {
    function mint(address, uint256) external;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}
