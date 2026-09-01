// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @title THE BAND BETWEEN THE TWO DIALS — the quiet-pool collapse survives the freshness fix
///
/// `MoleHook.consultEvidence` reports TWO things and `MoleQueue._requireAnchorIsFresh` reads only one:
///
///     (uint32 quietSpan,) = oracle.consultEvidence(id, twapWindow);
///     if (uint256(quietSpan) > effectiveMaxOracleStaleness()) revert OracleTooStale();
///
/// `extrapolated` — the flag whose own NatSpec says "a caller whose premise is 'the anchor is a TWAP,
/// never spot' is being told here that the premise does not hold for this answer" — is DISCARDED.
///
/// The collapse condition and the guard that is supposed to catch it are keyed to two DIFFERENT numbers:
///
///   * the collapse begins at silence >= `twapWindow` (1,800 s live). At that point `consult` takes its
///     quiet-tail path for EVERY window, so the long TWAP, the short TWAP and `slot0.tick` are one int24
///     and both drift subtractions are `x - x`.
///   * the only guard that survives the collapse does not bind until silence > `maxOracleStaleness`
///     (3,600 s live; the DERIVED default is `twapWindow + 4 * maxEpochLife` = 16,200 s = 4.5 hours).
///
/// Nothing in `initialize` or `setSettlementGuards` relates the two, so on the live dials there is a
/// 1,800-second band — and on the derived default a 4-hour band — in which `settle` runs with no
/// effective price guard at all and crosses an uncancellable batch at a fossil.
contract AttackQueueExtrapolatedBand is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* --------------------------------------- THE LIVE RH 4663 SCHEDULE, read from the proxy */

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant FREEZE_DURATION = 60;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;

    uint32 internal constant LIVE_STALENESS = 3600;
    uint32 internal constant LIVE_SHORT_WINDOW = 60;
    int24 internal constant LIVE_JUMP = 1200;
    uint128 internal constant LIVE_MIN_LIQUIDITY = 1;

    /// @dev INSIDE THE BAND: longer than `twapWindow` (so the anchor is pure extrapolation and both drift
    ///      guards are dead) and shorter than `maxOracleStaleness` (so the one surviving guard is silent).
    uint256 internal constant SILENCE_INSIDE_THE_BAND = 2000;

    uint256 internal constant T0 = 1_750_000_000;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    MoleHook internal hook;
    MoleQueue internal queue;
    PoolKey internal qKey;

    uint256 internal _clock;
    uint256 internal _height;

    /* ------------------------------------------------------------------ harness */

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-extrapolated-band", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            qKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev A history longer than the window and evenly covered — an ordinary pool, so the refusal (or the
    ///      absence of one) below can only come from the freshness measurement.
    function _warmAcrossTheWholeWindow() internal {
        for (uint256 i = 0; i < 13; i++) {
            _advance(200);
            _swap(i % 2 == 0, 1e16);
        }
        // Warming outran epoch 0's 300 s duration, so close it and open a fresh one to place into.
        queue.freeze();
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(who, 1_000_000e18);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(queue), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(queue), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev A batch that crosses EXACTLY, so settlement never touches the pool and nothing but a guard can
    ///      refuse it.
    function _placeAPerfectlyCrossingBatch() internal {
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(bob);
        queue.place(false, 100e18);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        address a = _hookAddr(1);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        qKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(qKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            qKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );

        queue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            qKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(LIVE_SHORT_WINDOW, LIVE_STALENESS, LIVE_JUMP, LIVE_MIN_LIQUIDITY);

        _fund(alice);
        _fund(bob);
        _fund(mallory);
    }

    /* ================================================================================
       THE PREMISE: THE BAND EXISTS AND IS WIDE.
       ============================================================================= */

    /// @notice The collapse starts at `twapWindow` and the guard starts at `maxOracleStaleness`, and on
    ///         the live dials those are 1,800 seconds apart. Measured, not argued.
    function test_premise_theCollapseBeginsLongBeforeTheGuardBinds() public {
        _warmAcrossTheWholeWindow();
        _advance(SILENCE_INSIDE_THE_BAND);
        PoolId id = qKey.toId();

        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(id, TWAP_WINDOW);

        // The oracle says, in its own words, that the window contained no trade at all.
        assertTrue(extrapolated, "premise: the anchor must be pure extrapolation at this silence");
        assertGe(uint256(quietSpan), uint256(TWAP_WINDOW), "premise: the silence must cover the whole window");

        // And the guard that is supposed to catch that is comfortably silent.
        assertLe(
            uint256(quietSpan),
            queue.effectiveMaxOracleStaleness(),
            "premise: the staleness dial must NOT bind inside the band"
        );

        // Both drift subtractions are x - x.
        int24 long_ = hook.consult(id, TWAP_WINDOW);
        int24 short_ = hook.consult(id, LIVE_SHORT_WINDOW);
        (, int24 spot,,) = StateLibrary.getSlot0(manager, id);
        assertEq(long_, short_, "the short-vs-long drift guard is not identically zero");
        assertEq(long_, spot, "the spot-vs-long drift guard is not identically zero");
    }

    /// @notice The DERIVED default is far worse than the live dials: a queue that never calls
    ///         `setSettlementGuards` tolerates `twapWindow + 4 * maxEpochLife` of pure extrapolation.
    function test_premise_theDerivedDefaultOpensAFourHourBand() public {
        MoleQueue fresh = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            qKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
        assertEq(fresh.effectiveMaxOracleStaleness(), 16_200, "derived default changed");
        assertGt(
            fresh.effectiveMaxOracleStaleness(),
            uint256(TWAP_WINDOW),
            "the derived default must exceed the window for the band to exist"
        );
        // 16,200 - 1,800 = 14,400 seconds = four hours of fossil that every guard waves through.
        assertEq(fresh.effectiveMaxOracleStaleness() - uint256(TWAP_WINDOW), 14_400, "band width changed");
    }

    /* ================================================================================
       THE ATTACK: A BATCH NOBODY MAY CANCEL, CROSSED AT A PRICE NOBODY QUOTED.
       ============================================================================= */

    /// @notice AN UNCANCELLABLE BATCH SETTLES AT A 2,000-SECOND-OLD FOSSIL WITH EVERY GUARD GREEN.
    ///
    ///         The pool trades normally, then goes quiet for 2,000 seconds — 33 minutes, on a chain whose
    ///         live WETH/USDG pool has been silent for 4.4 DAYS. A batch is placed, the cutoff passes (so
    ///         nobody can cancel any more), and `settle` runs: the anchor is `lastTick` from before the
    ///         silence, both drift guards compute zero by construction, the depth floor is satisfied by
    ///         liquidity that has nothing to do with the price, the jump guard has never been armed, and
    ///         `quietSpan` (2,000) is under `maxOracleStaleness` (3,600).
    ///
    ///         MUTATION (both directions verified): in `_requireAnchorIsFresh`, read the second return of
    ///         `consultEvidence` and refuse it —
    ///             (uint32 quietSpan, bool extrapolated) = oracle.consultEvidence(id, twapWindow);
    ///             if (extrapolated) revert OracleTooStale();
    ///         — and this test goes RED at `settle` (which is the fix working). Restoring the discarded
    ///         flag turns it GREEN again.
    function test_anUncancellableBatchCrossesAtAFossilInsideTheBand() public {
        _warmAcrossTheWholeWindow();
        PoolId id = qKey.toId();

        // The tick the pool last quoted, stamped by the last real swap BEFORE anyone placed an order.
        (, uint32 lastSwapTs,, int24 fossil,,) = hook.poolStates(id);

        uint64 e = queue.currentEpoch();
        _placeAPerfectlyCrossingBatch();

        // Silence, then the cutoff: from here nobody may cancel, by design.
        _advance(SILENCE_INSIDE_THE_BAND);
        assertEq(uint8(queue.phaseOf(e)), uint8(MoleQueue.Phase.Frozen), "the cutoff did not close the epoch");

        vm.prank(mallory);
        queue.freeze();
        _advance(FREEZE_DURATION);

        // The oracle itself says the anchor is extrapolated — no trade inside the window at all.
        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(id, TWAP_WINDOW);
        assertTrue(extrapolated, "premise: the anchor must be pure extrapolation");
        assertLe(uint256(quietSpan), uint256(LIVE_STALENESS), "premise: the staleness dial must not bind");
        assertGe(
            block.timestamp - uint256(lastSwapTs),
            uint256(TWAP_WINDOW),
            "premise: the anchor must predate the whole window"
        );
        assertEq(hook.consult(id, TWAP_WINDOW), fossil, "the anchor is not the fossil tick");

        // Nothing refuses. The batch crosses at a price the pool has not quoted since before the silence.
        vm.prank(mallory);
        queue.settle(e);

        assertEq(uint8(queue.phaseOf(e)), uint8(MoleQueue.Phase.Settled), "the batch did not settle");
        assertEq(queue.lastClearingTick(), fossil, "the batch cleared at something other than the fossil");
        assertTrue(queue.clearingTickSet(), "the fossil was not even recorded as the clearing anchor");

        // And both sides really were paid at it: alice sold currency0 and is owed currency1.
        (,,,, uint128 out0, uint128 out1,,) = queue.epochs(e);
        assertGt(uint256(out0), 0, "the currency0 side was not crossed");
        assertGt(uint256(out1), 0, "the currency1 side was not crossed");
    }

    /// @notice THE SAME SILENCE, ONE SECOND PAST THE DIAL, IS REFUSED. This is the control: the ONLY
    ///         thing standing between "crossed at a fossil" and "refused" is a dial that has no
    ///         relationship to the window the collapse is keyed to.
    function test_control_oneSecondPastTheDialTheSameFossilIsRefused() public {
        _warmAcrossTheWholeWindow();

        uint64 e = queue.currentEpoch();
        _placeAPerfectlyCrossingBatch();

        _advance(uint256(LIVE_STALENESS) + 1);
        vm.prank(mallory);
        queue.freeze();
        _advance(FREEZE_DURATION);

        (uint32 quietSpan, bool extrapolated) = hook.consultEvidence(qKey.toId(), TWAP_WINDOW);
        assertTrue(extrapolated, "premise: still the tail path");
        assertGt(uint256(quietSpan), uint256(LIVE_STALENESS), "premise: now past the dial");

        vm.prank(mallory);
        vm.expectRevert(MoleQueue.OracleTooStale.selector);
        queue.settle(e);
    }
}
