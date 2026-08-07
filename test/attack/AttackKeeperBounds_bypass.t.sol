// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice A keeper that is a CONTRACT, so it can open and reshape inside ONE transaction. This is the
///         exact pattern the dwell guard exists to forbid, and the only way to actually attempt it.
contract ReshapingKeeper {
    function openThenReshape(MolePositions m, PoolKey memory k, int24 lo, int24 hi, uint128 liq)
        external
        returns (uint256 id)
    {
        id = m.open(k, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
        m.rebalance(id, lo + 60, hi + 60);
    }

    function approve(address token, address spender) external {
        MockERC20(token).approve(spender, type(uint256).max);
    }
}

/// @title AttackKeeperBounds_bypass
/// @notice ANGLE: attack the four new keeper bounds THEMSELVES — try to exceed them.
///
/// Everything here is a real attempt to get MORE than the bound allows: reshape before the dwell,
/// reshape more often than the L1 budget, park a range outside the TWAP band, overflow the midpoint
/// arithmetic. Tests whose name starts with `test_holds_` are attacks that FAILED — the bound survived —
/// and they are kept because a bound is only as good as the attacks it has actually turned away.
///
/// TIMING DISCIPLINE. `block.timestamp` and `block.number` are cached inside a call frame, so
/// `vm.warp(block.timestamp + d)` does not accumulate in a loop and `vm.roll(block.number + n)` has been
/// measured rolling the chain BACKWARDS. Every clock move here goes through the accumulating `_clock` /
/// `_height` pair, and `_advanceRH` moves them TOGETHER at Robinhood Chain's real pacing (12 seconds of
/// wall clock per `block.number` tick, because on this chain `block.number` is the Ethereum L1 height).
contract AttackKeeperBoundsBypassTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("bypass.keeper");
    address internal alice = makeAddr("bypass.alice");
    address internal treasury = makeAddr("bypass.treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;

    /// @dev The exact keeper policy script/Deploy.s.sol ships. These MUST track the script's defaults —
    ///      they were stale (1 hours / 5) after the deploy defaults were tightened, which quietly turned
    ///      this whole file into a test of a laxer policy than the one that actually ships.
    ///      They now READ the script's own constants rather than restating them, so there is no copy
    ///      left to drift: changing a deploy default changes these, and any test that depended on the old
    ///      value fails loudly instead of silently testing a policy nobody ships.
    uint32 internal constant SHIPPED_MIN_REBALANCE_INTERVAL = DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL;
    uint64 internal constant SHIPPED_MIN_DWELL_L1 = DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS;
    uint16 internal constant SHIPPED_MAX_REBAL_PER_L1 = DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK;
    int24 internal constant SHIPPED_MAX_TWAP_DEV = DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS;
    uint32 internal constant SHIPPED_TWAP_WINDOW = DeployConfig.DEFAULT_TWAP_WINDOW;

    /// @dev RHChain.SECONDS_PER_BLOCK_NUMBER_TICK. `block.number` ticks once per Ethereum block.
    uint256 internal constant SECS_PER_L1_BLOCK = 12;

    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 secs, uint256 blocks) internal {
        _clock += secs;
        _height += blocks;
        vm.warp(_clock);
        vm.roll(_height);
    }

    /// @dev Honest Robinhood Chain pacing: wall clock and L1 height move together at 12s per tick.
    function _advanceRH(uint256 secs) internal {
        _advance(secs, secs / SECS_PER_L1_BLOCK);
    }

    /// @dev A sequencer writing L2 timestamps forward while Ethereum stands still. `block.timestamp` is
    ///      the clock MolePositions' own header calls "a clock the sequencer writes"; `block.number` is
    ///      the one it calls unfakeable. This helper moves only the fakeable one.
    function _advanceSequencerClockOnly(uint256 secs) internal {
        _advance(secs, 0);
    }

    function setUp() public {
        _clock = block.timestamp;
        _height = block.number;
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        _fund(alice);
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 1_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _open(MolePositions m, PoolKey memory k, address who, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = m.open(k, -600, 600, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    /* =================================================================== BOUND 1: DWELL */

    /// @notice ATTACK — open and reshape inside ONE transaction, the literal thing the dwell guard names.
    /// @dev Result: REFUSED. The guard holds against the pattern it was written for.
    function test_holds_openAndReshapeInOneTransactionIsRefused() public {
        ReshapingKeeper rk = new ReshapingKeeper();
        MolePositions m = deployMoleVault(manager, address(rk), 0, MIN_W, MAX_W, address(0), 0, 0, 5, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _fund(address(rk));
        rk.approve(Currency.unwrap(currency0), address(m));
        rk.approve(Currency.unwrap(currency1), address(m));

        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        rk.openThenReshape(m, key, -600, 600, 1e18);
    }

    /// @notice ATTACK — inherit an aged dwell stamp by recycling a drained position's id.
    /// @dev Result: REFUSED. Ids are 1-based and strictly increasing, a drained position is a permanent
    ///      tombstone that reverts ZeroLiquidity, and a re-open mints a NEW id with a fresh stamp.
    function test_holds_aDrainedPositionIdCannotBeRecycledToInheritItsDwellStamp() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 5, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));

        uint256 old = _open(m, key, alice, 1e18);
        uint64 oldStamp = m.getPosition(old).openedAtL1Block;
        _advanceRH(600); // 50 L1 blocks: the old position is long past its dwell

        vm.prank(alice);
        m.withdrawAll(old);

        // The drained id is not a usable shell: it still reverts, and on liquidity, not on dwell.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.rebalance(old, -540, 660);

        // A re-open is a NEW id carrying a NEW stamp, so the aged stamp cannot be inherited.
        uint256 fresh = _open(m, key, alice, 1e18);
        assertGt(fresh, old, "position ids must be strictly increasing");
        assertEq(m.getPosition(fresh).openedAtL1Block, uint64(block.number), "fresh position did not restamp");
        assertGt(uint256(m.getPosition(fresh).openedAtL1Block), uint256(oldStamp), "stamp was inherited");

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        m.rebalance(fresh, -540, 660);
    }

    /// @notice ATTACK — BREAK. The dwell stamp is never re-armed, so the L1-paced guard covers exactly
    ///         ONE rebalance in a position's entire life. After that first reshape, `block.number` may
    ///         stand completely still and the keeper can keep reshaping the SAME position: the only clock
    ///         left in the per-position path is `block.timestamp`, which this contract's own header calls
    ///         "a clock the sequencer writes".
    /// @dev The residual backstop is the GLOBAL budget, not the dwell — and that is a whole-book budget,
    ///      so spending it on one position is exactly what an attacker wants. Here the shipped config
    ///      (1h cadence, 5-block dwell, 10 rebalances per L1 block) yields TEN reshapes of one position
    ///      inside a single L1 block — twelve seconds of Ethereum — against an intended one per hour.
    function test_BREAK_dwellNeverRearmsSoZeroL1ProgressIsNeededAfterTheFirstRebalance() public {
        MolePositions m = deployMoleVault(
            manager,
            KEEPER,
            SHIPPED_MIN_REBALANCE_INTERVAL,
            MIN_W,
            MAX_W,
            address(0),
            0,
            0,
            SHIPPED_MIN_DWELL_L1,
            SHIPPED_MAX_REBAL_PER_L1
        , 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);
        uint64 stampAtOpen = m.getPosition(id).openedAtL1Block;

        // Honest pacing until the first rebalance is legitimately due.
        _advanceRH(SHIPPED_MIN_REBALANCE_INTERVAL);
        uint256 l1BlockUnderAttack = block.number;

        vm.prank(KEEPER);
        m.rebalance(id, -540, 660);

        // From here Ethereum STOPS. Only the sequencer-written clock moves.
        uint256 reshapes = 1;
        for (uint256 i = 0; i < 32; i++) {
            _advanceSequencerClockOnly(SHIPPED_MIN_REBALANCE_INTERVAL);
            int24 lo = i % 2 == 0 ? int24(-600) : int24(-540);
            int24 hi = i % 2 == 0 ? int24(600) : int24(660);
            vm.prank(KEEPER);
            try m.rebalance(id, lo, hi) {
                reshapes++;
            } catch (bytes memory err) {
                // The thing that finally stops the attack must be named, so this cannot pass by accident.
                assertEq(
                    bytes4(err),
                    MolePositions.RebalanceBudgetExhausted.selector,
                    "expected the GLOBAL budget to be the only backstop left"
                );
                break;
            }
        }

        assertEq(block.number, l1BlockUnderAttack, "the attack must consume no L1 progress at all");
        assertEq(reshapes, uint256(SHIPPED_MAX_REBAL_PER_L1), "budget, not dwell, is what bounded the attack");
        assertEq(m.getPosition(id).openedAtL1Block, stampAtOpen, "the dwell stamp is never re-armed");
        assertEq(uint256(m.minDwellL1Blocks()), uint256(SHIPPED_MIN_DWELL_L1), "dwell is immutable, as claimed");

        // Restated as the number that matters: the configured cadence is one reshape per hour per
        // position; the attack achieved ten inside twelve seconds of Ethereum.
        console2.log("reshapes of ONE position inside ONE L1 block:", reshapes);
        console2.log("configured cadence, seconds:", SHIPPED_MIN_REBALANCE_INTERVAL);

        // PHASE 2. The budget is `zero means disabled`, and it is the ONLY L1-paced control still standing
        // once the dwell has been spent. Turn it off — a supported configuration — and the same attack is
        // unbounded: fifty reshapes of one position with `block.number` frozen for the whole run.
        MolePositions n = deployMoleVault(
            manager, KEEPER, SHIPPED_MIN_REBALANCE_INTERVAL, MIN_W, MAX_W, address(0), 0, 0, SHIPPED_MIN_DWELL_L1, 0
        , 10_000, 0, 0, address(0));
        n.whitelistPool(key);
        _approve(alice, address(n));
        uint256 id2 = _open(n, key, alice, 1e18);
        _advanceRH(SHIPPED_MIN_REBALANCE_INTERVAL);
        uint256 frozenAt = block.number;
        vm.prank(KEEPER);
        n.rebalance(id2, -540, 660);

        uint256 unbounded = 1;
        for (uint256 i = 0; i < 49; i++) {
            _advanceSequencerClockOnly(SHIPPED_MIN_REBALANCE_INTERVAL);
            vm.prank(KEEPER);
            n.rebalance(id2, i % 2 == 0 ? int24(-600) : int24(-540), i % 2 == 0 ? int24(600) : int24(660));
            unbounded++;
        }
        assertEq(block.number, frozenAt, "phase 2 must consume no L1 progress either");
        assertEq(unbounded, 50, "the dwell should not have stopped any of these");
        console2.log("reshapes with the budget disabled, zero L1 progress:", unbounded);
    }

    /// @notice ATTACK — BREAK. Under HONEST chain pacing the dwell guard is unreachable at the shipped
    ///         configuration: `lastRebalancedAt` is seeded at open(), `minRebalanceInterval` ships at
    ///         1 day, and the interval is checked FIRST. One day is 7,200 L1 blocks; the dwell is 300.
    ///         So `DwellNotElapsed` cannot be produced, and a build with the dwell set to zero behaves
    ///         identically at every instant. Tightening the deploy defaults from 1h/5 to 1d/300 widened
    ///         the margin — 300 of 7,200 rather than 5 of 300 — but did not change the conclusion.
    /// @dev This is a mutation control run in the opposite direction from KeeperBounds.t.sol's: that suite
    ///      proves the guard bites, but only with `minRebalanceInterval == 0` — a configuration
    ///      script/Deploy.s.sol explicitly refuses ("cadence below the backtested floor").
    function test_BREAK_dwellGuardIsUnreachableUnderTheShippedDeployDefaults() public {
        MolePositions withDwell = deployMoleVault(
            manager, KEEPER, SHIPPED_MIN_REBALANCE_INTERVAL, MIN_W, MAX_W, address(0), 0, 0, SHIPPED_MIN_DWELL_L1, 0
        , 10_000, 0, 0, address(0));
        MolePositions noDwell = deployMoleVault(
            manager, KEEPER, SHIPPED_MIN_REBALANCE_INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0
        , 10_000, 0, 0, address(0));
        withDwell.whitelistPool(key);
        noDwell.whitelistPool(key);
        _approve(alice, address(withDwell));
        _approve(alice, address(noDwell));

        uint256 idA = _open(withDwell, key, alice, 1e18);
        uint256 idB = _open(noDwell, key, alice, 1e18);

        // Sweep the entire life of the guard, including every instant where the dwell is genuinely
        // unelapsed (block.number < open + SHIPPED_MIN_DWELL_L1). At every one of them the two builds
        // must agree, and the error must be RebalanceTooSoon — never DwellNotElapsed.
        //
        // The bound is DERIVED from the dwell rather than hard-coded. It used to read `sec <= 120`, which
        // covered a 5-block dwell exactly and would have silently stopped covering the window at all once
        // the shipped dwell became 300 blocks: the sweep would have passed without ever reaching the
        // instants it exists to check.
        uint256 sweepSeconds = (uint256(SHIPPED_MIN_DWELL_L1) + 2) * SECS_PER_L1_BLOCK;
        uint256 elapsed;
        uint256 checked;
        for (uint256 sec = 1; sec <= sweepSeconds; sec += 6) {
            _advanceRH(6);
            elapsed += 6;
            bytes4 errA = _rebalanceError(withDwell, idA);
            bytes4 errB = _rebalanceError(noDwell, idB);
            assertEq(errA, MolePositions.RebalanceTooSoon.selector, "dwell fired where the interval should have");
            assertEq(errA, errB, "the dwell build diverged from the no-dwell build");
            checked++;
        }
        assertGt(checked, 0, "sweep did not run");

        // Walk the rest of the interval and confirm both builds unlock at the same instant. Derived from
        // what the sweep actually consumed, so it lands exactly 6s short however the sweep is configured.
        assertLt(elapsed + 6, SHIPPED_MIN_REBALANCE_INTERVAL, "premise: the sweep outran the interval");
        _advanceRH(SHIPPED_MIN_REBALANCE_INTERVAL - elapsed - 6);
        assertEq(_rebalanceError(withDwell, idA), MolePositions.RebalanceTooSoon.selector, "unlocked early");
        _advanceRH(6);
        assertEq(_rebalanceError(withDwell, idA), bytes4(0), "with-dwell build did not unlock");
        assertEq(_rebalanceError(noDwell, idB), bytes4(0), "no-dwell build did not unlock");

        // The arithmetic behind it, so the result is not an artefact of this particular sweep: the dwell
        // can only ever bind if it outlasts the interval, i.e. minDwellL1Blocks > interval / 12.
        assertLt(
            uint256(SHIPPED_MIN_DWELL_L1),
            uint256(SHIPPED_MIN_REBALANCE_INTERVAL) / SECS_PER_L1_BLOCK,
            "premise failed: the shipped dwell does outlast the shipped interval"
        );
        console2.log("dwell, L1 blocks:", SHIPPED_MIN_DWELL_L1);
        console2.log("interval expressed in L1 blocks:", uint256(SHIPPED_MIN_REBALANCE_INTERVAL) / SECS_PER_L1_BLOCK);
    }

    /// @dev Calls rebalance as the keeper in a sub-frame and returns the revert selector, or 0 on success.
    ///      State changes from a successful call are rolled back by the caller's own snapshot so the sweep
    ///      does not disturb what it is measuring.
    function _rebalanceError(MolePositions m, uint256 id) internal returns (bytes4 sel) {
        uint256 snap = vm.snapshotState();
        vm.prank(KEEPER);
        try m.rebalance(id, -540, 660) {
            sel = bytes4(0);
        } catch (bytes memory err) {
            sel = bytes4(err);
        }
        vm.revertToState(snap);
    }

    /* ================================================================== BOUND 2: BUDGET */

    /// @notice ATTACK — spend the budget, then let the L2 chain run (timestamps, blocks, a whole day of
    ///         wall clock) without Ethereum advancing, and try again.
    /// @dev Result: REFUSED. The counter is keyed on `block.number`, so L2 progress buys nothing. This is
    ///      the one place where keying on the L1 height genuinely pays for itself.
    function test_holds_budgetIsNotResetByL2ProgressOnlyByL1Progress() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 2, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 a = _open(m, key, alice, 1e18);
        uint256 b = _open(m, key, alice, 1e18);
        uint256 c = _open(m, key, alice, 1e18);

        vm.prank(KEEPER);
        m.rebalance(a, -540, 660);
        vm.prank(KEEPER);
        m.rebalance(b, -540, 660);

        // A full day of sequencer-written time, no Ethereum progress.
        _advanceSequencerClockOnly(1 days);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceBudgetExhausted.selector);
        m.rebalance(c, -540, 660);

        // One L1 block is what actually buys more.
        _advance(1, 1);
        vm.prank(KEEPER);
        m.rebalance(c, -540, 660);
        assertEq(m.getPosition(c).tickLower, -540, "budget did not reset on real L1 progress");
    }

    /// @notice ATTACK — split the spend across separate TRANSACTIONS rather than one, in the same L1
    ///         block, in case the counter is somehow per-call rather than persisted.
    /// @dev Result: REFUSED. It is storage, so it accumulates across transactions exactly as intended.
    function test_holds_budgetCannotBeSplitAcrossSeparateTransactionsInOneL1Block() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 3, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256[4] memory ids;
        for (uint256 i = 0; i < 4; i++) ids[i] = _open(m, key, alice, 1e18);

        for (uint256 i = 0; i < 3; i++) {
            vm.prank(KEEPER); // a distinct top-level call each time
            m.rebalance(ids[i], -540, 660);
            assertEq(m.rebalancesUsedInL1Block(block.number), uint16(i + 1), "counter did not persist");
        }
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceBudgetExhausted.selector);
        m.rebalance(ids[3], -540, 660);
    }

    /// @notice ATTACK — probe the book for free: fire rebalances that revert LATE (after the counter is
    ///         written) and see whether the counter keeps the spend.
    /// @dev Result: REFUSED, but note the direction — a reverted attempt costs the keeper nothing, so the
    ///      budget throttles successful reshapes only. That is the correct behaviour for a rate limit.
    function test_holds_aRevertedRebalanceDoesNotConsumeTheBudget() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 2, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 a = _open(m, key, alice, 1e18);
        uint256 b = _open(m, key, alice, 1e18);

        // Off-spacing: reverts strictly AFTER the counter write in rebalance().
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        m.rebalance(a, -541, 660);
        assertEq(m.rebalancesUsedInL1Block(block.number), 0, "a reverted attempt kept a budget slot");

        vm.prank(KEEPER);
        m.rebalance(a, -540, 660);
        vm.prank(KEEPER);
        m.rebalance(b, -540, 660);
        assertEq(m.rebalancesUsedInL1Block(block.number), 2, "budget accounting drifted");
    }

    /* ==================================================================== BOUND 3: TWAP */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("keeperbounds.bypass", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev A pool on a real MoleHook, deliberately left IDLE. With no swaps the oracle's tick cumulative
    ///      stays at zero and `consult` returns exactly 0 once the pool is older than the window — which
    ///      makes every midpoint assertion below exact rather than approximate.
    ///
    ///      The hook is built with the fixed `lpFeePips` constructor (7 args). Only the ORACLE half of it
    ///      matters to this suite — every bound under test reads `consult`, none reads a fee — so the fee
    ///      going constant changes nothing measured here, and `restrictedLiquidity` stays off because the
    ///      seed liquidity below is added through the plain router rather than through a vault.
    function _idleHookWorld(uint256 seed, int24 spacing) internal returns (MoleHook h, PoolKey memory k) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), uint24(3000), uint32(60), false, uint24(0), treasury, address(this)),
            a
        );
        h = MoleHook(a);
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(a)
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    /// @notice ATTACK — place a legal-width range whose MIDPOINT sits inside the band while the range
    ///         itself is somewhere else entirely.
    /// @dev Result: IMPOSSIBLE BY CONSTRUCTION, and this pins why. A range always contains its own
    ///      midpoint, and the midpoint is what is bounded, so any accepted range necessarily overlaps
    ///      [twap - dev, twap + dev]. The residual is that a MINIMUM-width range can sit with its near
    ///      edge at the band edge — measured below — which is the configured grief budget, not a bypass.
    function test_holds_midpointBoundForcesEveryAcceptedRangeToOverlapTheBand() public {
        (MoleHook h, PoolKey memory k) = _idleHookWorld(1, SPACING);
        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(h), SHIPPED_MAX_TWAP_DEV, 300, 0, 0
        , 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        uint256 id = _open(m, k, alice, 1e18);

        _advanceRH(1200); // idle, but far older than the 300s window
        assertEq(h.consult(k.toId(), 300), int24(0), "premise failed: idle pool TWAP is not exactly 0");

        // The widest legal range, shoved as far off-centre as the bound allows, still straddles the TWAP.
        vm.prank(KEEPER);
        m.rebalance(id, 600 - MAX_W / 2, 600 + MAX_W / 2);
        MolePositions.Position memory p = m.getPosition(id);
        assertLt(p.tickLower, int24(0), "widest accepted range did not straddle the TWAP");
        assertGt(p.tickUpper, int24(0), "widest accepted range did not straddle the TWAP");

        // Exactly ON the boundary: midpoint 600 ticks from the TWAP is accepted (the check is `>`).
        vm.prank(KEEPER);
        m.rebalance(id, 540, 660);
        assertEq(m.getPosition(id).tickLower, int24(540), "boundary range was refused");

        // One spacing further out is refused. Nothing else can refuse it: both ticks are on spacing and
        // the width is unchanged, so this isolates the TWAP bound.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
        m.rebalance(id, 600, 720);

        // And the measured worst case for a MINIMUM-width range: near edge 540 ticks off the TWAP, far
        // edge 660. That is ~6.8% of price, once per interval, and it is the documented residual.
        console2.log("worst-case near edge of an accepted min-width range, ticks from TWAP:", int256(540));
    }

    /// @notice ATTACK — exploit the truncation in `(newTickLower + newTickUpper) / 2`, which rounds TOWARD
    ///         ZERO and therefore rounds the midpoint the "wrong" way on one side of the origin.
    /// @dev Result: REAL BUT IMMATERIAL, and now measured rather than assumed. On a tickSpacing-1 pool the
    ///      sums can be odd, and the band is inflated by exactly half a tick — symmetrically, on both the
    ///      positive and the negative side, because truncation toward zero moves the computed midpoint
    ///      toward the origin in both directions. Half a tick against a 600-tick bound is 0.08%.
    function test_holds_midpointTruncationInflatesTheBandByAtMostHalfATick() public {
        (MoleHook h, PoolKey memory k) = _idleHookWorld(2, 1);
        MolePositions m = deployMoleVault(manager, KEEPER, 0, 1, MAX_W, address(h), SHIPPED_MAX_TWAP_DEV, 300, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        // One position per side: a rebalance that lands entirely on one side of spot leaves the position
        // holding a single token, and it can then only be moved to ranges on that same side. See
        // test_BREAK_oneLegalRebalanceStrandsAPositionOnOneSideOfTheMarket.
        vm.startPrank(alice);
        uint256 idPos = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        uint256 idNeg = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        vm.stopPrank();

        _advanceRH(1200);
        assertEq(h.consult(k.toId(), 300), int24(0), "premise failed: idle pool TWAP is not exactly 0");

        // POSITIVE side. 599 + 602 = 1201, whose true centre is 600.5 — outside the band — but which
        // truncates to 600 and is therefore accepted.
        assertEq(int256(599 + 602) / 2, int256(600), "premise failed: truncation did not round down");
        vm.prank(KEEPER);
        m.rebalance(idPos, 599, 602);
        assertEq(m.getPosition(idPos).tickLower, int24(599), "positive-side half-tick range was refused");

        // NEGATIVE side. -602 + -599 = -1201, true centre -600.5, truncates TOWARD ZERO to -600.
        assertEq(int256(-602 + -599) / 2, int256(-600), "premise failed: truncation did not round toward zero");
        vm.prank(KEEPER);
        m.rebalance(idNeg, -602, -599);
        assertEq(m.getPosition(idNeg).tickUpper, int24(-599), "negative-side half-tick range was refused");

        // A full extra tick is NOT available on either side: the leak is bounded at one half tick.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
        m.rebalance(idPos, 600, 602); // centre 601
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
        m.rebalance(idNeg, -602, -600); // centre -601
    }

    /// @notice ATTACK — overflow `newTickLower + newTickUpper` (int24) by pushing both ticks to the
    ///         extremes of the tick space, and by making the width bound wide enough not to stop it first.
    /// @dev Result: NOT REACHABLE. `_validateRange` runs first and clamps both ticks into
    ///      [MIN_TICK, MAX_TICK], so the sum lives in +/-1,774,544 against an int24 range of +/-8,388,608 —
    ///      a 4.7x margin. The proof is that the calls below reach the DEVIATION comparison and revert with
    ///      the bound's own error rather than with an arithmetic panic.
    function test_holds_midpointAdditionCannotOverflowInt24AtTheTickExtremes() public {
        (MoleHook h, PoolKey memory k) = _idleHookWorld(3, 1);
        // maxRangeWidth is the whole tick space, so the width bound cannot be what refuses these.
        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, 1, TickMath.MAX_TICK - TickMath.MIN_TICK, address(h), SHIPPED_MAX_TWAP_DEV, 300, 0, 0
        , 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        vm.prank(alice);
        uint256 id = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        _advanceRH(1200);

        // Maximum possible positive sum: 2 * MAX_TICK - 120 = 1,774,424.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
        m.rebalance(id, TickMath.MAX_TICK - 120, TickMath.MAX_TICK);

        // Maximum possible negative sum: -1,774,424.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
        m.rebalance(id, TickMath.MIN_TICK, TickMath.MIN_TICK + 120);

        // Sanity on the margin itself, stated in numbers rather than trusted.
        assertLt(
            int256(TickMath.MAX_TICK) * 2, int256(type(int24).max), "int24 headroom claim is wrong"
        );
        assertGt(
            int256(TickMath.MIN_TICK) * 2, int256(type(int24).min), "int24 headroom claim is wrong"
        );
    }

    /// @notice ATTACK, fuzzed — hunt for ANY accepted range whose midpoint escapes the band.
    /// @dev Result: none found. The property asserted is the one the guard actually promises.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_holds_noAcceptedRangeEverEscapesTheBand(int256 rawLo, int256 rawHi) public {
        (MoleHook h, PoolKey memory k) = _idleHookWorld(4, SPACING);
        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(h), SHIPPED_MAX_TWAP_DEV, 300, 0, 0
        , 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        uint256 id = _open(m, k, alice, 1e18);
        _advanceRH(1200);
        assertEq(h.consult(k.toId(), 300), int24(0), "premise failed: idle pool TWAP is not exactly 0");

        int24 lo = int24((bound(rawLo, -50_000, 50_000) / int256(SPACING)) * int256(SPACING));
        int24 hi = int24((bound(rawHi, -50_000, 50_000) / int256(SPACING)) * int256(SPACING));
        if (hi <= lo) return;

        vm.prank(KEEPER);
        try m.rebalance(id, lo, hi) {
            int24 mid = (lo + hi) / 2;
            int24 dev = mid >= 0 ? mid : -mid; // twap is exactly 0
            assertLe(int256(dev), int256(SHIPPED_MAX_TWAP_DEV), "accepted a midpoint outside the band");
            assertTrue(lo <= mid && mid <= hi, "accepted range does not contain its own midpoint");
        } catch {
            // refused, which is the guard doing its job
        }
    }

    /// @notice ATTACK — a legal, in-band rebalance while SPOT has walked away from the TWAP. The bound is
    ///         anchored to the time-average, so the keeper can legally park a position where spot is not.
    /// @dev Result: the reshape IS allowed and the position goes single-sided — but the ejected leg is
    ///      paid to the OWNER, not retained, so this degrades and does not take. Measured here so the
    ///      residual is a number instead of a belief.
    function test_holds_inBandRebalanceAwayFromSpotStillPaysTheOwnerNotTheContract() public {
        (MoleHook h, PoolKey memory k) = _idleHookWorld(5, SPACING);
        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(h), SHIPPED_MAX_TWAP_DEV, 300, 0, 0
        , 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        uint256 id = _open(m, k, alice, 1e18);
        _advanceRH(1200);

        uint256 a0 = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 a1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        // Entirely above spot (tick 0), midpoint on the band edge.
        vm.prank(KEEPER);
        m.rebalance(id, 540, 660);

        assertGt(MockERC20(Currency.unwrap(currency1)).balanceOf(alice), a1, "ejected leg did not reach the owner");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(m)), 0, "contract retained currency0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "contract retained currency1");
        console2.log("currency0 returned to owner:", MockERC20(Currency.unwrap(currency0)).balanceOf(alice) - a0);
        console2.log("currency1 returned to owner:", MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - a1);
    }

    /// @notice ATTACK — BREAK. ONE rebalance that every one of the four bounds accepts (in band, legal
    ///         width, on spacing, past the dwell, inside the budget) forces roughly HALF the position's
    ///         principal out of the pool and into the owner's wallet, and leaves the position holding a
    ///         single token. From there `rebalance` can never put it back: re-centring needs both legs, the
    ///         burn returns only one, `getLiquidityForAmounts` returns 0 and the call reverts ZeroLiquidity.
    ///
    ///         The consequence is that the degradation is IRREVERSIBLE BY THE OPERATOR. Rotating to an
    ///         honest keeper does not fix it — and the keeper address is immutable, so there is no rotation
    ///         anyway. The position can only be shuffled along one side of the market until spot walks into
    ///         it; the owner's only remedy is to exit and re-open.
    /// @dev The custody claim itself survives: the ejected leg is paid to `positions[id].owner`, this
    ///      contract retains nothing, and withdrawAll still empties the position. What fails is the
    ///      characterisation of the leftover as "dust" — it is measured below at ~50% of principal.
    function test_BREAK_oneLegalRebalanceStrandsAPositionOnOneSideOfTheMarket() public {
        (MoleHook h, PoolKey memory k) = _idleHookWorld(6, SPACING);
        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(h), SHIPPED_MAX_TWAP_DEV, 300, 0, 0
        , 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        uint256 wallet0 = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 wallet1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        uint256 id = _open(m, k, alice, 1e18);
        uint256 cost0 = wallet0 - MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 cost1 = wallet1 - MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        _advanceRH(1200);
        assertEq(h.consult(k.toId(), 300), int24(0), "premise failed: idle pool TWAP is not exactly 0");

        uint256 before1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        // Legal on every axis: width 120 (>= MIN_W), both ticks on spacing, midpoint 600 = exactly the
        // configured band edge, no dwell, no budget. Nothing in the contract refuses it.
        vm.prank(KEEPER);
        m.rebalance(id, 540, 660);
        uint256 ejected1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - before1;
        assertGt(ejected1, 0, "premise failed: the position did not go single-sided");

        // The position is now 100% currency0, and NO range containing spot can be funded from one leg.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.rebalance(id, -600, 600); // the original, perfectly centred range
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.rebalance(id, -60, 60); // any range straddling spot
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.rebalance(id, -660, -540); // the mirror image on the other side

        // Only same-side ranges remain reachable, so the honest move is to shuffle it down to the edge.
        vm.prank(KEEPER);
        m.rebalance(id, 60, 180);
        assertEq(m.getPosition(id).tickLower, int24(60), "same-side move should still work");

        // Size the damage: withdraw what is left and compare it with what was ejected. At tick 0 the two
        // currencies are 1:1, so these are directly comparable.
        vm.prank(alice);
        m.withdrawAll(id);
        assertEq(m.getPosition(id).liquidity, 0, "exit is still unblockable, as claimed");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(m)), 0, "contract retained currency0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "contract retained currency1");

        // 100% of the currency1 leg leaves the pool, and at a symmetric range around spot that leg is
        // half the position. "Dust" is not what this is.
        assertGe(ejected1 * 100 / cost1, 99, "the whole currency1 leg should have been ejected");
        console2.log("currency0 paid in at open :", cost0);
        console2.log("currency1 paid in at open :", cost1);
        console2.log("currency1 force-ejected by ONE legal rebalance:", ejected1);
        console2.log("ejected, % of the currency1 leg:", ejected1 * 100 / cost1);
        console2.log("ejected, % of total principal:", ejected1 * 100 / (cost0 + cost1));
    }

    /* ============================================================= BOUND 4: withdrawAll */

    /// @notice ATTACK — reach withdrawAll from the keeper key, since `withdraw` was widened to `public`
    ///         this session and a widened visibility is where exits usually leak.
    /// @dev Result: REFUSED. The owner check is on the inner `withdraw`, so the helper inherits it.
    function test_holds_withdrawAllIsNotReachableFromTheKeeperOrAnyoneElse() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(id);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdraw(id, 1);

        // An id that does not exist is not a hole either: owner is address(0), so nobody matches it.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(id + 999);
    }
}
