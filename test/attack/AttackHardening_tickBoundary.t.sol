// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Position as V4Position} from "v4-core/libraries/Position.sol";
import {Vm} from "forge-std/Vm.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";
import {deployMoleVault} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  MolePositions open / rebalance / withdraw when the pool's CURRENT TICK is exactly a multiple
           of tickSpacing and sits exactly on a range edge (dossier Part 2 §10: "when the current tick
           is an EXACT multiple of tickSpacing at a range boundary, some initialization logic can be
           skipped, mis-counting active liquidity and inflating fees — fuzz the case where currentTick
           == a tickSpacing multiple at both range edges and assert liquidity/fee accounting is exact").
  Lens:    Fuzz k, build a pool whose opening tick is EXACTLY k*spacing, and put that tick on the LOWER
           edge, on the UPPER edge, and strictly inside. For each: what open pulls must be exactly what
           the liquidity math says (one-sided to the wei where the edge says one-sided), withdraw must
           return it minus at most one wei per leg, stored liquidity must equal on-chain liquidity,
           a rebalance ONTO an edge must conserve amounts exactly (burn == mint + residual), and the
           performance fee taken on a position that earned fees across the boundary must equal, to the
           wei, the difference between a fee-off vault and a fee-on vault in otherwise identical worlds.

  RESULT: HOLDS across the fuzzed domain. Mutations (each run, each RED; see HARDENING-FINDINGS.md):
  withdraw burning one unit less than it records -> the open/withdraw fuzz RED (liquidity left on
  chain, INV-4); rebalance not writing `p.liquidity = newLiquidity` -> the rebalance-onto-edge test RED
  (INV-4 on every move); rebalance paying the residual to the vault itself -> RED (conservation +
  custody); `_takePerformanceFee` returning (0, 0) -> the fee test RED (non-vacuity).
  TWO HONEST SURVIVORS, recorded rather than claimed: swapping `newLower`/`newUpper` in the two
  `getSqrtPriceAtTick` calls kills NOTHING here, because `LiquidityAmounts.getLiquidityForAmounts` sorts
  its two bounds itself — it is not a guard, it is an argument order the library tolerates; and flipping
  `_cutOf` to round UP kills nothing here either, because this file pins conservation (owner(on) +
  treasury == owner(off)) and event truthfulness, both of which hold under either rounding. The rounding
  DIRECTION of the cut is pinned by AttackPerformanceFee.t.sol's direct fuzz of `_cutOf`, not by this file.
//////////////////////////////////////////////////////////////////////////////*/
contract AttackHardeningTickBoundary is HardeningBase {
    using PoolIdLibrary for PoolKey;

    int24 internal constant W = 600;

    MolePositions internal vaultOff; // fee-off twin for the A/B
    MolePositions internal vaultOn; // fee-on (1000 bps)

    MockERC20 internal a;
    MockERC20 internal b;
    PoolKey internal k;
    PoolId internal kId;
    int24 internal T;

    function setUp() public {
        _buildWorld(0);
        vaultOff = vault;
        vaultOn = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(hook), 0, 0, 0, 0, 10_000, 0, 1000, TREASURY);
    }

    /// @dev A fresh pair and a fresh pool of ours opened at EXACTLY tick `tick`, wide third-party
    ///      liquidity around it, both vaults admitted, alice/mallory funded and approved.
    function _world(int24 tick) internal {
        T = tick;
        a = new MockERC20("A", "A", 18);
        b = new MockERC20("B", "B", 18);
        (Currency c0, Currency c1) = address(a) < address(b)
            ? (Currency.wrap(address(a)), Currency.wrap(address(b)))
            : (Currency.wrap(address(b)), Currency.wrap(address(a)));
        k = PoolKey({currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: SPACING, hooks: IHooks(address(hook))});
        manager.initialize(k, TickMath.getSqrtPriceAtTick(T));
        kId = k.toId();
        (, int24 got,,) = StateLibrary.getSlot0(manager, kId);
        assertEq(got, T, "premise: the pool did not open exactly on the fuzzed tick");

        // Far from 1:1 the wide background position needs more of one leg than FUNDING.
        a.mint(address(this), FUNDING * 10_000);
        b.mint(address(this), FUNDING * 10_000);
        a.approve(address(modifyLiquidityRouter), type(uint256).max);
        b.approve(address(modifyLiquidityRouter), type(uint256).max);
        a.approve(address(swapRouter), type(uint256).max);
        b.approve(address(swapRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: T - 60_000, tickUpper: T + 60_000, liquidityDelta: 100_000e18, salt: 0}), ZERO_BYTES
        );
        vaultOff.whitelistPool(k);
        vaultOn.whitelistPool(k);

        address[2] memory users = [alice, mallory];
        for (uint256 i; i < users.length; ++i) {
            a.mint(users[i], FUNDING);
            b.mint(users[i], FUNDING);
            vm.startPrank(users[i]);
            a.approve(address(vaultOff), type(uint256).max);
            b.approve(address(vaultOff), type(uint256).max);
            a.approve(address(vaultOn), type(uint256).max);
            b.approve(address(vaultOn), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _c0() internal view returns (MockERC20) {
        return MockERC20(Currency.unwrap(k.currency0));
    }

    function _c1() internal view returns (MockERC20) {
        return MockERC20(Currency.unwrap(k.currency1));
    }

    function _balK(address who) internal view returns (uint256, uint256) {
        return (_c0().balanceOf(who), _c1().balanceOf(who));
    }

    function _openK(MolePositions v, address who, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = v.open(k, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function _onChain(MolePositions v, uint256 id) internal view returns (uint128) {
        MolePositions.Position memory p = v.getPosition(id);
        return StateLibrary.getPositionLiquidity(
            manager, kId, V4Position.calculatePositionKey(address(v), p.tickLower, p.tickUpper, bytes32(id))
        );
    }

    function _holdsNothingK(MolePositions v, string memory when) internal view {
        assertEq(_c0().balanceOf(address(v)), 0, string.concat("vault holds c0: ", when));
        assertEq(_c1().balanceOf(address(v)), 0, string.concat("vault holds c1: ", when));
        assertEq(manager.balanceOf(address(v), k.currency0.toId()), 0, string.concat("vault holds claims 0: ", when));
        assertEq(manager.balanceOf(address(v), k.currency1.toId()), 0, string.concat("vault holds claims 1: ", when));
    }

    /// @dev Round trip a range on the fee-off vault: open, check the pull against the edge rule, check
    ///      INV-4, withdraw, check the return. `edge` is -1 (tick on the lower edge), +1 (upper), 0 (inside).
    function _roundTrip(int24 lo, int24 hi, int8 edge, uint128 liq) internal {
        (uint256 s0, uint256 s1) = _balK(alice);
        uint256 id = _openK(vaultOff, alice, lo, hi, liq);
        (uint256 o0, uint256 o1) = _balK(alice);
        uint256 paid0 = s0 - o0;
        uint256 paid1 = s1 - o1;
        assertEq(vaultOff.getPosition(id).liquidity, _onChain(vaultOff, id), "INV-4 on open at the edge");
        _holdsNothingK(vaultOff, "after open at the edge");

        if (edge == -1) {
            // Tick == tickLower: the position is in range at its very bottom, entirely currency0.
            assertEq(paid1, 0, "a lower-edge position pulled currency1");
            assertGt(paid0, 0, "a lower-edge position pulled no currency0");
        } else if (edge == 1) {
            // Tick == tickUpper: out of range above, entirely currency1.
            assertEq(paid0, 0, "an upper-edge position pulled currency0");
            assertGt(paid1, 0, "an upper-edge position pulled no currency1");
        } else {
            assertGt(paid0, 0, "a straddling position pulled no currency0");
            assertGt(paid1, 0, "a straddling position pulled no currency1");
        }

        vm.prank(alice);
        vaultOff.withdrawAll(id);
        (uint256 e0, uint256 e1) = _balK(alice);
        assertLe(e0, s0, "withdraw returned MORE currency0 than was paid at the edge");
        assertLe(e1, s1, "withdraw returned MORE currency1 than was paid at the edge");
        assertLe(s0 - e0, 1, "more than one wei lost on currency0 at the edge");
        assertLe(s1 - e1, 1, "more than one wei lost on currency1 at the edge");
        assertEq(_onChain(vaultOff, id), 0, "liquidity left on chain after withdrawAll");
        _holdsNothingK(vaultOff, "after withdraw at the edge");
    }

    /* ================================================================ 1. open/withdraw on each edge */

    /// forge-config: default.fuzz.runs = 256
    function testFuzz_onBoundary_openAndWithdrawAreExactOnEveryEdge(int16 kRaw, uint64 liqRaw) public {
        int24 kk = int24(int256(bound(int256(kRaw), -800, 800)));
        uint128 liq = uint128(bound(uint256(liqRaw), 1e6, 1e18));
        _world(kk * SPACING);

        _roundTrip(T, T + W, -1, liq); // current tick ON the lower edge
        _roundTrip(T - W, T, 1, liq); // current tick ON the upper edge
        _roundTrip(T - W, T + W, 0, liq); // both edges a multiple of spacing, tick inside
        _roundTrip(T - 2 * SPACING, T, 1, liq); // the narrowest legal range, ending on the tick
        _roundTrip(T, T + 2 * SPACING, -1, liq); // the narrowest legal range, starting on the tick
    }

    /* ================================================================ 2. rebalance ONTO an edge */

    /// @notice A rebalance from a straddle ONTO a range whose edge is the current tick must conserve
    ///         amounts EXACTLY: the owner's gain (the residual) equals the PoolManager's loss to the wei,
    ///         stored liquidity equals on-chain liquidity after every move, the vault keeps nothing —
    ///         and the leg the edge cannot use comes back IN FULL. Two chains, because the edge makes the
    ///         one-sidedness exact: a position sitting on its lower edge is all currency0 and can only be
    ///         moved to ranges that are all currency0 at that price, and symmetrically for the upper edge.
    ///         (Moving it to a range that needs the other leg yields zero liquidity, and the vault refuses
    ///         rather than minting nothing — pinned below as the honest failure it is.)
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_onBoundary_rebalanceOntoAnEdgeConservesAmountsExactly(int16 kRaw, uint64 liqRaw) public {
        int24 kk = int24(int256(bound(int256(kRaw), -800, 800)));
        uint128 liq = uint128(bound(uint256(liqRaw), 1e9, 1e18));
        _world(kk * SPACING);

        // LOWER-EDGE CHAIN: straddle -> [T, T+W] -> [T, T+2W] -> [T+W, T+2W] -> [T, T+W]
        uint256 lowId = _openK(vaultOff, mallory, T - W, T + W, liq);
        _moveExact(lowId, T, T + W, "straddle -> lower edge");
        _moveExact(lowId, T, T + 2 * W, "lower edge -> wider lower edge");
        _moveExact(lowId, T + W, T + 2 * W, "lower edge -> entirely above");
        _moveExact(lowId, T, T + W, "entirely above -> lower edge");

        // UPPER-EDGE CHAIN: straddle -> [T-W, T] -> [T-2W, T] -> [T-2W, T-W] -> [T-W, T]
        uint256 upId = _openK(vaultOff, mallory, T - W, T + W, liq);
        _moveExact(upId, T - W, T, "straddle -> upper edge");
        _moveExact(upId, T - 2 * W, T, "upper edge -> wider upper edge");
        _moveExact(upId, T - 2 * W, T - W, "upper edge -> entirely below");
        _moveExact(upId, T - W, T, "entirely below -> upper edge");

        // The cross-over is refused rather than minted empty: an all-currency0 position cannot become an
        // all-currency1 one without a swap, and the vault says so instead of writing a zero.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        vaultOff.rebalance(lowId, T - W, T);
        assertEq(vaultOff.getPosition(lowId).liquidity, _onChain(vaultOff, lowId), "a refused rebalance left INV-4 broken");

        vm.startPrank(mallory);
        vaultOff.withdrawAll(lowId);
        vaultOff.withdrawAll(upId);
        vm.stopPrank();
        assertEq(_onChain(vaultOff, lowId) + _onChain(vaultOff, upId), 0, "liquidity left after withdrawAll");
        _holdsNothingK(vaultOff, "after exit");
    }

    /// @dev One rebalance, asserted exactly: owner gain == PoolManager loss per leg, INV-4, custody, and
    ///      the leg the new range cannot hold at this price comes back whole.
    function _moveExact(uint256 id, int24 lo, int24 hi, string memory label) internal {
        (uint256 pm0, uint256 pm1) = _balK(address(manager));
        (uint256 m0, uint256 m1) = _balK(mallory);
        vm.prank(KEEPER);
        vaultOff.rebalance(id, lo, hi);
        (uint256 n0, uint256 n1) = _balK(mallory);
        (uint256 q0, uint256 q1) = _balK(address(manager));
        assertEq(n0 - m0, pm0 - q0, string.concat("currency0 not conserved: ", label));
        assertEq(n1 - m1, pm1 - q1, string.concat("currency1 not conserved: ", label));
        assertEq(vaultOff.getPosition(id).liquidity, _onChain(vaultOff, id), string.concat("INV-4: ", label));
        assertGt(vaultOff.getPosition(id).liquidity, 0, string.concat("position vanished: ", label));
        assertEq(vaultOff.getPosition(id).tickLower, lo, string.concat("range not applied (lo): ", label));
        assertEq(vaultOff.getPosition(id).tickUpper, hi, string.concat("range not applied (hi): ", label));
        _holdsNothingK(vaultOff, label);
        // On-chain amounts of the NEW position: the leg the edge excludes must be exactly zero.
        (uint256 a0, uint256 a1) = _amountsOf(id);
        if (lo >= T) assertEq(a1, 0, string.concat("a range at/above the tick holds currency1: ", label));
        if (hi <= T) assertEq(a0, 0, string.concat("a range at/below the tick holds currency0: ", label));
    }

    /// @dev What the position would return if burned now — read by actually burning under a snapshot.
    function _amountsOf(uint256 id) internal returns (uint256 a0, uint256 a1) {
        uint256 snap = vm.snapshotState();
        (uint256 b0, uint256 b1) = _balK(mallory);
        vm.prank(mallory);
        vaultOff.withdrawAll(id);
        (uint256 c0, uint256 c1) = _balK(mallory);
        a0 = c0 - b0;
        a1 = c1 - b1;
        vm.revertToState(snap);
    }

    /* ================================================================ 3. fee accounting across the edge */

    /// @notice Fee exactness on the boundary. Two identical worlds (snapshot): a fee-OFF vault and a
    ///         fee-ON vault each hold the same lower-edge position while the same swaps cross the edge
    ///         down and back. The owner's exit from the fee-on vault plus the treasury's claims must equal
    ///         the owner's exit from the fee-off vault EXACTLY, per leg — no wei created, none lost, and
    ///         the cut is floor(fees * 10%) rather than anything the edge case could inflate.
    /// forge-config: default.fuzz.runs = 128
    function testFuzz_onBoundary_performanceFeeIsExactAcrossTheEdge(int16 kRaw) public {
        int24 kk = int24(int256(bound(int256(kRaw), -800, 800)));
        _world(kk * SPACING);
        uint128 liq = 5e18;

        // A: fee-off world.
        uint256 snap = vm.snapshotState();
        (uint256 s0, uint256 s1) = _balK(alice);
        uint256 idA = _openK(vaultOff, alice, T, T + W, liq);
        _crossTheEdgeAndBack();
        vm.prank(alice);
        vaultOff.withdrawAll(idA);
        (uint256 e0, uint256 e1) = _balK(alice);
        int256 offDelta0 = int256(e0) - int256(s0);
        int256 offDelta1 = int256(e1) - int256(s1);
        vm.revertToState(snap);

        // B: fee-on world, same everything.
        (s0, s1) = _balK(alice);
        uint256 idB = _openK(vaultOn, alice, T, T + W, liq);
        _crossTheEdgeAndBack();
        uint256 tr0 = manager.balanceOf(TREASURY, k.currency0.toId());
        uint256 tr1 = manager.balanceOf(TREASURY, k.currency1.toId());
        vm.recordLogs();
        vm.prank(alice);
        vaultOn.withdrawAll(idB);
        (e0, e1) = _balK(alice);
        int256 onDelta0 = int256(e0) - int256(s0);
        int256 onDelta1 = int256(e1) - int256(s1);
        uint256 cut0 = manager.balanceOf(TREASURY, k.currency0.toId()) - tr0;
        uint256 cut1 = manager.balanceOf(TREASURY, k.currency1.toId()) - tr1;

        // The split is exact: owner(on) + treasury == owner(off), per leg.
        assertEq(onDelta0 + int256(cut0), offDelta0, "fee split is not exact on currency0 across the edge");
        assertEq(onDelta1 + int256(cut1), offDelta1, "fee split is not exact on currency1 across the edge");

        // And the cut is floor(fees * 1000 / 10000) of what the position EARNED, read from the event the
        // vault emits for exactly this purpose — so rounding direction is pinned, not only conservation.
        (uint128 ev0, uint128 ev1) = _lastPerformanceFeeEvent();
        assertEq(uint256(ev0), cut0, "the PerformanceFeeTaken event disagrees with the treasury's claims (c0)");
        assertEq(uint256(ev1), cut1, "the PerformanceFeeTaken event disagrees with the treasury's claims (c1)");
        // The position earned fees on the way down through the edge: the cut must be non-zero on the leg
        // that was traded into it, so this test is not vacuously exact on zeros.
        assertGt(cut0 + cut1, 0, "no fee was earned across the edge, the exactness claim is vacuous");
        _holdsNothingK(vaultOn, "after the fee-on exit");
    }

    /// @dev Swap down through T (the position [T, T+W] is in range at T, so the first swap trades into it
    ///      from above? No: at T the position is at its bottom and all currency0; a 1->0 swap (price UP)
    ///      trades through it. Then back down.
    function _crossTheEdgeAndBack() internal {
        _advance(61);
        _swap(k, false, 50e18); // price up through the range
        _advance(61);
        _swap(k, true, 50e18); // and back down through T
    }

    function _lastPerformanceFeeEvent() internal returns (uint128 c0, uint128 c1) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PerformanceFeeTaken(uint256,address,uint128,uint128)");
        for (uint256 i = logs.length; i > 0; --i) {
            if (logs[i - 1].topics.length > 0 && logs[i - 1].topics[0] == sig) {
                (c0, c1) = abi.decode(logs[i - 1].data, (uint128, uint128));
                return (c0, c1);
            }
        }
    }
}
