// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN, MoleDeployer} from "./helpers/ProxyDeploy.sol";

/// @notice The keeper's bounds — the four things that were documented, or assumed, but not enforced.
///
/// Until now `rebalance` was limited only by how OFTEN it could run and how WIDE a range it could pick.
/// Nothing bounded WHERE it put the position, nothing stopped it touching the whole book in one
/// transaction, and the L1-paced dwell guard the contract header describes at length did not exist in code
/// — the field was stamped at open() and read by nothing.
///
/// Every test here deploys a keeper that is honest about its permissions and then asks it to do the thing
/// the bound is supposed to forbid.
contract KeeperBoundsTest is Test, Deployers {
    MoleDeployer internal _moleDeployer = new MoleDeployer();
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal treasury = makeAddr("treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;

    uint256 internal _clock;
    uint256 internal _height;

    /// @dev Warps AND rolls. Both `block.timestamp` and `block.number` are cached inside a call frame, so
    ///      `vm.warp(block.timestamp + d)` / `vm.roll(block.number + n)` do not accumulate in a loop.
    function _advance(uint256 secs, uint256 blocks) internal {
        _clock += secs;
        _height += blocks;
        vm.warp(_clock);
        vm.roll(_height);
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

    /* ------------------------------------------------------------------ dwell guard */

    /// @notice A position must age, in L1 blocks, before the keeper may reshape it. This closes
    ///         open-then-immediately-reshape within one transaction or one L1 block.
    function test_dwellGuardBlocksAnImmediateRebalanceAndThenReleases() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 10, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        // Same L1 block: refused, by its own named error.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        m.rebalance(id, -540, 660);

        // Still one block short: the boundary itself is pinned, not just the direction.
        _advance(1, 9);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        m.rebalance(id, -540, 660);

        // Exactly at the dwell: allowed.
        _advance(1, 1);
        vm.prank(KEEPER);
        m.rebalance(id, -540, 660);
        assertEq(m.getPosition(id).tickLower, -540, "rebalance did not apply after the dwell elapsed");
    }

    /// @notice The guard must be OFF when configured off, or every existing deployment silently changes.
    function test_dwellGuardIsInertWhenZero() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);
        vm.prank(KEEPER);
        m.rebalance(id, -540, 660); // same block, no dwell configured
        assertEq(m.getPosition(id).tickLower, -540, "zero dwell should not block anything");
    }

    /// @notice THE REASON THE DWELL IS MEASURED IN BLOCKS. The cadence check runs on `block.timestamp`,
    ///         a clock the sequencer writes; the dwell runs on `block.number`, which on this chain is the
    ///         ETHEREUM height and cannot be advanced by producing L2 blocks. Here the sequencer fakes a
    ///         full day of time while real L1 progress is zero: the cadence is satisfied instantly and the
    ///         dwell is the only thing still refusing. Without it, timestamp manipulation alone would buy
    ///         an unlimited rebalance rate.
    function test_dwellIsTheOnlyBoundLeftWhenTheSequencerFakesTheClock() public {
        MolePositions m =
            deployMoleVault(manager, KEEPER, 1 days, MIN_W, MAX_W, address(0), 0, 0, 300, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        // A control vault identical except that the dwell is disabled. Both positions are opened NOW, so
        // both cadence clocks start together and the only difference later is the dwell.
        MolePositions cadenceOnly =
            deployMoleVault(manager, KEEPER, 1 days, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        cadenceOnly.whitelistPool(key);
        _approve(alice, address(cadenceOnly));
        uint256 idCadenceOnly = _open(cadenceOnly, key, alice, 1e18);

        // The sequencer advances ONLY the clock it controls. No L1 block is produced.
        _advance(2 days, 0);

        // The cadence is now satisfied — prove it on the control, so this test cannot pass because the
        // cadence happened to refuse rather than because the dwell did.
        vm.prank(KEEPER);
        cadenceOnly.rebalance(idCadenceOnly, -540, 660); // succeeds: faked time is enough on its own

        // ...but with the dwell configured, the same faked time buys nothing.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        m.rebalance(id, -540, 660);

        // Real L1 progress — which the sequencer cannot manufacture — is what finally releases it.
        _advance(0, 300);
        vm.prank(KEEPER);
        m.rebalance(id, -540, 660);
        assertEq(m.getPosition(id).tickLower, -540, "real L1 progress did not release the dwell");
    }

    /* --------------------------------------------------------------- global budget */

    /// @notice The per-position interval bounds nothing in aggregate. This bounds the book.
    function test_globalBudgetCapsRebalancesPerL1BlockAndResetsAfterIt() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 2, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));

        uint256 a = _open(m, key, alice, 1e18);
        uint256 b = _open(m, key, alice, 1e18);
        uint256 c = _open(m, key, alice, 1e18);

        vm.startPrank(KEEPER);
        m.rebalance(a, -540, 660);
        m.rebalance(b, -540, 660);
        assertEq(m.rebalancesUsedInL1Block(block.number), 2, "budget accounting is wrong");

        // The third in the same L1 block is refused — this is the whole-book bound.
        vm.expectRevert(MolePositions.RebalanceBudgetExhausted.selector);
        m.rebalance(c, -540, 660);
        vm.stopPrank();

        // A new L1 block restores the allowance, so the cap throttles rather than bricks.
        _advance(1, 1);
        vm.prank(KEEPER);
        m.rebalance(c, -540, 660);
        assertEq(m.getPosition(c).tickLower, -540, "budget did not reset on the next L1 block");
    }

    function test_globalBudgetIsInertWhenZero() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 a = _open(m, key, alice, 1e18);
        uint256 b = _open(m, key, alice, 1e18);
        uint256 c = _open(m, key, alice, 1e18);
        vm.startPrank(KEEPER);
        m.rebalance(a, -540, 660);
        m.rebalance(b, -540, 660);
        m.rebalance(c, -540, 660); // no cap configured
        vm.stopPrank();
        assertEq(m.getPosition(c).tickLower, -540, "zero budget should not cap anything");
    }

    /* -------------------------------------------------------- relative recenter bound */

    /// @notice A rebalance may only move a position so far from where it already is — and this bound reads
    ///         NO PRICE, which is the entire point.
    /// @dev The TWAP bound anchors on the oracle, and an oracle is only as honest as the pool beneath it.
    ///      An adversarial round demonstrated the anchor itself being walked for free on a thin pool
    ///      (`restrictedLiquidity` means the vault is the only LP, so there are regions of zero liquidity
    ///      where a swap moves spot arbitrarily far for almost nothing), after which the deviation bound
    ///      was satisfied at an absurd tick and a compromised keeper took 100% of a position's principal —
    ///      the exact outcome this contract's security claim denies. A relative bound cannot be moved by
    ///      manipulating anything, because it compares the new range only to the old one.
    /// @dev THE BOUND MEASURES EDGES, NOT THE MIDPOINT, since 2026-08-23. A midpoint is an average, and an
    ///      average hides a reshape: [-600, 600] -> [300, 900] moves the LOWER edge 900 ticks while the old
    ///      `moved` read exactly 600 and passed. F-07 mechanism C is that observation taken to its
    ///      conclusion — [-1000, 1000] -> [540, 660] moves an edge 1,540 ticks with `moved` reading 600 —
    ///      and it ends with spot outside the new range and a whole leg ejected. So the accepted case below
    ///      is a TRANSLATION at constant width, which is what "moved 600 ticks" was always supposed to mean.
    function test_recenterBoundLimitsHowFarOneRebalanceMayMoveAPosition() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 600, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18); // [-600, 600]

        // 600 ticks of movement is allowed, on both edges at once...
        vm.prank(KEEPER);
        m.rebalance(id, 0, 1200);
        assertEq(m.getPosition(id).tickLower, 0, "a rebalance inside the recenter bound was refused");

        // ...601 is not. The boundary itself is pinned, not merely the direction.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        m.rebalance(id, 660, 1860); // both edges 660 away

        // A RESHAPE THAT BARELY MOVES THE MIDPOINT IS STILL MOVEMENT, and this is F-07 mechanism C at the
        // widths it was measured on: [-960, 960] -> [540, 660] moves the midpoint exactly 600, which the
        // old bound accepted because the midpoint was the only thing it measured — while the LOWER EDGE
        // travels 1,500 ticks and the position lands entirely on one side of spot, where the burn returns
        // a single token and a whole leg is ejected.
        vm.prank(alice);
        uint256 wide = m.open(key, -960, 960, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        m.rebalance(wide, 540, 660);

        // And a far jump — the shape of the C9/C12 attack — is refused however legal its width.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        m.rebalance(id, -199_980, -199_860);
    }

    function test_recenterBoundIsInertWhenZero() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);
        vm.prank(KEEPER);
        m.rebalance(id, 6_000, 6_600); // a long way, but the bound is off
        assertEq(m.getPosition(id).tickLower, 6_000, "zero recenter cap should not block anything");
    }

    /* ------------------------------------------------------------------ TWAP bound */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("keeperbounds", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _hookWorld(uint256 seed) internal returns (MoleHook h, PoolKey memory k) {
        address a = _hookAddr(seed);
        // The hook now carries a single immutable lpFeePips (the volatility-scaled fee was removed, not
        // repaired — see MoleHook's header). These tests only need its oracle, so the fee is just a
        // constant here; restrictedLiquidity stays off so the test router can seed the pool.
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
            tickSpacing: SPACING,
            hooks: IHooks(a)
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    function _swapOn(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @notice The keeper may not park a position far from the time-averaged price. This is the guard
    ///         against recentering into a wick — the one thing width and rate limits cannot express.
    function test_keeperCannotRebalanceFarFromTheTwap() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(1);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, 300, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        // The pool has to be older than the window before it takes a deposit: `open` now gates spot
        // against the oracle and `consult` fails closed on a pool younger than its window.
        _advance(301, 25);
        uint256 id = _open(m, k, alice, 1e18);

        // Warm the oracle so a 300s window is genuinely covered.
        for (uint256 i = 0; i < 6; i++) {
            _advance(61, 6);
            _swapOn(k, true, 1e15);
        }
        int24 twap = h.consult(k.toId(), 300);

        // A range centred on the TWAP is accepted...
        int24 lo = ((twap - 300) / SPACING) * SPACING;
        int24 hi = lo + 600;
        vm.prank(KEEPER);
        m.rebalance(id, lo, hi);
        assertEq(m.getPosition(id).tickLower, lo, "an honest, TWAP-centred rebalance was refused");

        // ...and one parked far away is not, however legal its width and spacing. Both ticks are on
        // spacing and the width is inside [MIN_W, MAX_W], so the ONLY thing that can refuse this is the
        // TWAP bound — otherwise the test would pass on an unrelated guard.
        assertEq(int256(20_040) % SPACING, 0, "test range is off spacing, a different guard would fire");
        assertEq(int256(20_640) % SPACING, 0, "test range is off spacing, a different guard would fire");
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
        m.rebalance(id, 20_040, 20_640);
    }

    /// @notice The bound must FAIL CLOSED when the oracle cannot answer. A keeper that can rebalance
    ///         blind whenever the window is uncovered is not bounded at all — and as of 2026-08-23 the
    ///         same is true of a DEPOSIT, which is the half this test gained.
    function test_twapBoundFailsClosedWhenTheOracleCannotCoverTheWindow() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(2);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, 3600, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        // THE DEPOSIT SIDE. The pool is far younger than the 1h window, so `consult` reverts — and `open`
        // now consults, because it mints against slot0 and had no anchor for it. The cold-start cost is
        // real and is the intended trade: a deposit refused strands nobody, a deposit priced blind does.
        _advance(61, 6);
        vm.prank(alice);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        // Age the pool so a position can exist at all, then take the oracle away again.
        _advance(3601, 300);
        uint256 id = _open(m, k, alice, 1e18);
        vm.mockCallRevert(
            address(h),
            abi.encodeWithSelector(MoleHook.consult.selector),
            abi.encodeWithSelector(MoleHook.InsufficientObservations.selector)
        );

        // THE KEEPER SIDE, unchanged: no oracle, no rebalance.
        vm.prank(KEEPER);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        m.rebalance(id, -540, 660);

        // THE EXIT IS NEVER GATED ON THE ORACLE, and that is deliberate rather than incidental — a gate on
        // the exit is a censorship lever for whoever can move spot. Pinned here, next to the two paths
        // that ARE gated, so the asymmetry is visible in one place.
        vm.prank(alice);
        m.withdrawAll(id);
        assertEq(m.getPosition(id).liquidity, 0, "a dead oracle blocked an exit");
    }

    /// @notice A TWAP bound with no oracle behind it is protection in name only, so it cannot deploy.
    function test_constructorRefusesATwapBoundWithNoOracle() public {
        vm.expectRevert(MolePositions.TwapBoundNeedsAnOracle.selector);
        _moleDeployer.vault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 600, 300, 0, 0, 10_000, 0, 0, address(0));

        // ...and a bound with an oracle but a zero window is equally hollow.
        (MoleHook h,) = _hookWorld(3);
        vm.expectRevert(MolePositions.TwapBoundNeedsAnOracle.selector);
        _moleDeployer.vault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, 0, 0, 0, 10_000, 0, 0, address(0));
    }

    /* -------------------------------------------------------------- ejection bound */

    /// @notice A rebalance that would hand most of a leg back to the owner is refused when the deployment
    ///         asks for that bound.
    /// @dev An adversarial pass measured a fully bound-compliant rebalance returning 99% of one leg — half
    ///      the position's principal — leaving the position one-sided and no longer earning on that side.
    ///      Nothing is stolen (it goes to the owner, the contract keeps nothing), which is why this is
    ///      opt-in rather than always-on, but the code used to call that residual "dust" and it is not.
    function test_ejectionBoundRefusesARebalanceThatWouldStrandMostOfALeg() public {
        MolePositions capped =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 5_000, 0, 0, address(0));
        capped.whitelistPool(key);
        _approve(alice, address(capped));
        uint256 id = _open(capped, key, alice, 1e18);

        // Spot is tick 0; a range entirely above it can only be minted from currency0, so the whole
        // currency1 leg would be ejected to the owner.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.EjectionTooLarge.selector);
        capped.rebalance(id, 600, 1200);

        // A recentre that keeps the position two-sided is unaffected.
        vm.prank(KEEPER);
        capped.rebalance(id, -540, 660);
        assertEq(capped.getPosition(id).tickLower, -540, "an in-ratio rebalance was wrongly refused");
    }

    /// @notice At 10_000 bps the bound is disabled, and the same move is allowed — with the residual now
    ///         reported rather than silently described as dust.
    function test_ejectionIsAllowedButReportedWhenTheBoundIsDisabled() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        uint256 before1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        vm.recordLogs();
        vm.prank(KEEPER);
        m.rebalance(id, 600, 1200);

        uint256 ejected = MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - before1;
        assertGt(ejected, 0, "premise failed: nothing was ejected, the test proves nothing");

        // The event must report the same number the owner actually received, so monitoring can see a
        // one-sided outcome instead of having to infer it.
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("RebalanceResidualPaid(uint256,address,uint256,uint256)");
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                (, uint256 a1) = abi.decode(logs[i].data, (uint256, uint256));
                assertEq(a1, ejected, "the reported residual does not match what the owner received");
                found = true;
            }
        }
        assertTrue(found, "no RebalanceResidualPaid event was emitted");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "contract retained the residual");
    }

    /// @notice The ejection cap COMPOUNDS across rebalances, and that is pinned here so nobody discovers
    ///         it in production.
    /// @dev An audit measured five legal rebalances stranding 88.6% of a leg under a 5_000 bps cap
    ///      documented as "at most half of either leg". The cap is a per-step limit whose denominator is
    ///      what each burn returned, so halves compound. Nothing is stolen — every wei goes to the owner —
    ///      but the bound does not mean what a casual reading suggests, so this test states the real
    ///      behaviour rather than leaving the NatSpec to carry it alone.
    function test_ejectionCapIsAPerStepLimitAndCompoundsAcrossRebalances() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 5_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        uint256 startBal = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);
        (,,,, uint128 startLiq,,) = _pos(m, id);
        assertGt(startLiq, 0, "premise failed: no position");

        // Each step shifts the range up by 120 ticks — measured at ~46% of that burn's currency1 leg, so
        // every individual step passes the 50% cap. The sequence is what compounds.
        int24[5] memory los = [int24(-420), int24(-300), int24(-180), int24(-60), int24(60)];
        uint256 steps;
        for (uint256 i = 0; i < los.length; i++) {
            vm.prank(KEEPER);
            try m.rebalance(id, los[i], los[i] + 1200) {
                steps++;
            } catch {
                break;
            }
        }
        assertGt(steps, 1, "premise failed: the sequence never got going");

        // The point: no single step was allowed to take half, yet the total taken is far more than half
        // of the leg the position started with. The cap did not lie about any step; it simply never
        // claimed anything about the sequence.
        uint256 startLeg1 = 29_553_010_879_137_170; // the currency1 leg this open() produces
        assertGt(
            MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - startBal,
            startLeg1 / 2,
            "compounding did not exceed a single step's cap - re-measure before trusting this bound"
        );

        uint256 ejected = MockERC20(Currency.unwrap(currency1)).balanceOf(alice) - startBal;
        assertGt(ejected, 0, "nothing compounded - re-measure before trusting the cap");

        // The custody invariant is untouched throughout: it all went to the owner, none of it stayed here.
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "contract retained a residual");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(m)), 0, "contract retained a residual");
    }

    function _pos(MolePositions m, uint256 id)
        internal
        view
        returns (address, PoolId, int24, int24, uint128, uint64, uint64)
    {
        MolePositions.Position memory p = m.getPosition(id);
        return (p.owner, p.poolId, p.tickLower, p.tickUpper, p.liquidity, p.openedAtL1Block, p.lastRebalancedAt);
    }

    /* -------------------------------------------------- the self-funding invariant */

    /// @notice A rebalance must never need to dip into anything: the re-mint can never cost more than the
    ///         burn returned, so `RebalanceNotSelfFunding` stays unreachable.
    /// @dev A mutation audit found that deleting that guard changed no test — the promise in its comment
    ///      ("that is a broken invariant and we refuse rather than dip into anything") was unverified in
    ///      either direction. It is unreachable by construction, because getLiquidityForAmounts rounds
    ///      DOWN, but "by construction" is exactly the kind of claim this project keeps finding to be
    ///      false. This fuzzes real rebalances across a wide range space and pins the property the guard
    ///      defends: the contract never ends a rebalance holding a balance, and the rebalance never fails
    ///      for lack of self-funding. The counter makes it non-vacuous — if the fuzzer stopped actually
    ///      rebalancing, the test fails rather than passing on an empty run.
    function testFuzz_rebalanceIsAlwaysSelfFundingAcrossTheRangeSpace(int16 loRaw, uint16 widthRaw) public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        uint256 executed;
        for (uint256 i = 0; i < 6; i++) {
            // Legal-by-construction ranges: on spacing, inside the width bounds, inside the tick range.
            int24 lo = (int24(loRaw) / SPACING) * SPACING + int24(int256(i)) * SPACING;
            int24 width = int24(int256(uint256(widthRaw) % 20_000)) + MIN_W;
            width = (width / SPACING) * SPACING;
            if (width < MIN_W || width > MAX_W) continue;
            int24 hi = lo + width;
            if (lo <= TickMath.MIN_TICK || hi >= TickMath.MAX_TICK) continue;

            vm.prank(KEEPER);
            try m.rebalance(id, lo, hi) {
                executed++;
            } catch (bytes memory err) {
                // Any refusal is acceptable EXCEPT the self-funding one, which must never be reachable.
                assertNotEq(
                    bytes4(err),
                    MolePositions.RebalanceNotSelfFunding.selector,
                    "a rebalance failed for lack of self-funding - the rounding assumption is broken"
                );
            }
            // The custody invariant, after every attempt: this contract holds nothing, ever.
            assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(m)), 0, "contract retained currency0");
            assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "contract retained currency1");
        }
        assertGt(executed, 0, "no rebalance executed - the fuzz proved nothing");
    }

    /* ------------------------------------------------------------------ withdrawAll */

    /// @notice withdrawAll must empty a position whose liquidity NUMBER changed under it.
    /// @dev This is the race the helper exists for: the 2026-08-01 fix conserves token AMOUNTS across a
    ///      rebalance, so narrowing a range means the same tokens buy MORE liquidity. A caller that read
    ///      `liquidity`, waited through a rebalance and passed the stale number back would silently
    ///      under-withdraw. Here the keeper rebalances between the read and the exit, and the position
    ///      must still end at exactly zero.
    function test_withdrawAllEmptiesAPositionEvenAfterItsLiquidityNumberChanged() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        uint128 staleReading = m.getPosition(id).liquidity;

        // The keeper narrows the range; the same tokens now buy more liquidity.
        vm.prank(KEEPER);
        m.rebalance(id, -300, 300);
        uint128 afterRebalance = m.getPosition(id).liquidity;
        assertGt(afterRebalance, staleReading, "premise failed: narrowing did not raise the liquidity number");

        uint256 before0 = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        vm.prank(alice);
        m.withdrawAll(id);

        assertEq(m.getPosition(id).liquidity, 0, "withdrawAll left liquidity behind");
        assertGt(MockERC20(Currency.unwrap(currency0)).balanceOf(alice), before0, "withdrawAll paid nothing");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(m)), 0, "contract retained currency0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "contract retained currency1");
    }

    /// @notice withdrawAll is still owner-only — it must not become a back door around the one
    ///         permission this contract actually enforces.
    function test_withdrawAllIsOwnerOnly() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        uint256 id = _open(m, key, alice, 1e18);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(id);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(id);
    }
}
