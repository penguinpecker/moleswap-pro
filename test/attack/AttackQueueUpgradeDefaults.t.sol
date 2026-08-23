// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice WHAT THE LIVE ROBINHOOD QUEUE ACTUALLY GETS THE INSTANT THE NEW IMPLEMENTATION LANDS.
///
/// `minSettleLiquidity`, `shortTwapWindow`, `maxOracleStaleness` and `maxClearingJumpTicks` are APPENDED
/// storage. A UUPS upgrade does not re-run `initialize`, so on the live proxy
/// 0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd (RH 4663) all four read ZERO from the first block the new
/// code is live, and they keep reading zero until somebody calls `setSettlementGuards`. Whatever those
/// four zeros mean is therefore not a default in any ordinary sense — it is the configuration of a
/// contract holding real escrow, chosen by omission.
///
/// The contract answers that by DERIVING each guard from the schedule the proxy was already initialized
/// with rather than by disabling it. This file is the tripwire on that derivation, and it runs on the
/// EXACT LIVE SCHEDULE (read from the proxy on 2026-08-24: epochDuration 300, freezeDuration 60,
/// maxEpochLife 3600, twapWindow 1800, maxTwapDeviationTicks 600, maxResidualSlippageBps 300) so the
/// numbers asserted below are the numbers the live queue will hold, not a test world's.
///
/// A FRESHLY DEPLOYED QUEUE IS BYTE-FOR-BYTE THE POST-UPGRADE STATE for these four slots — `initialize`
/// writes none of them — which is what makes this testable at all without forking.
///
/// THE ONE THAT BITES, and it is recorded here rather than discovered later: the derived staleness bound
/// is `twapWindow + 4 * maxEpochLife` = 16,200 s (4.5 h), and the live WETH/USDG pool's newest
/// observation on 2026-08-24 was ~3.9 DAYS old. So the live queue is NOT settleable on the derived
/// default: it refuses `OracleTooStale` until either the pool trades again or the admin widens the bound.
/// That is the guard working — a batch must not clear against a fossil price — but it is a KNOWN halt,
/// not a surprise, and the last test here pins both the halt and the exact call that lifts it.
contract AttackQueueUpgradeDefaults is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    /* ------------------------------------------------ THE LIVE RH 4663 SCHEDULE, verbatim */

    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant FREEZE_DURATION = 60;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;

    /// @dev The four derived values, restated independently of the contract's arithmetic so that changing
    ///      a derivation formula has to change a number here too.
    uint32 internal constant DERIVED_SHORT_WINDOW = 60; // min(60, twapWindow)
    uint256 internal constant DERIVED_STALENESS = 16_200; // twapWindow + 4 * maxEpochLife
    int256 internal constant DERIVED_JUMP = 4_800; // maxTwapDeviationTicks * 8
    uint128 internal constant DERIVED_MIN_LIQUIDITY = 1; // "some liquidity in range"

    uint256 internal constant T0 = 1_750_000_000;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

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
            uint160(uint256(keccak256(abi.encode("attack-queue-upgrade-defaults", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
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

    /// @dev Swaps spaced beyond the observation interval so the ring genuinely advances, then a quiet
    ///      stretch of `quiet` seconds. The sizes are tiny against the liquidity, so the warm-up cannot
    ///      walk the tick off zero and the two anchors stay in perfect agreement.
    function _warmThenIdle(uint256 quiet) internal {
        _advance(90);
        _swap(true, 1e16);
        _advance(90);
        _swap(false, 1e16);
        _advance(90);
        _swap(true, 1e16);
        _advance(quiet);
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(who, 1_000_000e18);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(queue), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev A batch that crosses EXACTLY, so settlement never touches the pool and any refusal below can
    ///      only have come from one of the four guards under test.
    function _placeAPerfectlyCrossingBatch() internal {
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(bob);
        queue.place(false, 100e18);
    }

    function _reachSettlementWindow() internal {
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);
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
    }

    /// @dev Warm the oracle ring, idle for `quiet` seconds, and only THEN deploy the queue. The order
    ///      matters: `epochStartedAt` is stamped at deployment, so a queue created before the idle would
    ///      have its first epoch already past its own cutoff and `place` would refuse `WrongPhase` before
    ///      any guard under test got a chance to speak.
    function _bootQueue(uint256 quiet) internal {
        _warmThenIdle(quiet);
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
        _fund(alice);
        _fund(bob);
    }

    /* ================================================================================
       1. WHAT THE FOUR ZEROS RESOLVE TO.
       ============================================================================= */

    /// @notice THE POST-UPGRADE STATE, ASSERTED AS STORAGE AND THEN AS BEHAVIOUR. The four appended slots
    ///         are untouched by `initialize` — which is exactly what an upgraded proxy sees — and each one
    ///         resolves to a value derived from the schedule the proxy already holds.
    ///
    ///         MUTATION: change any `effective*` derivation (e.g. `4 * maxEpochLife` -> `2 *`) -> the
    ///         matching assertion here goes RED, and it goes red naming the live number that changed.
    function test_theFourAppendedSlotsAreZeroAndEachDerivesTheLiveNumber() public {
        _bootQueue(0);

        // The storage half: this is the upgrade's actual starting state, not an approximation of it.
        assertEq(queue.minSettleLiquidity(), 0, "premise: an upgraded proxy has NOT written this slot");
        assertEq(queue.shortTwapWindow(), 0, "premise: an upgraded proxy has NOT written this slot");
        assertEq(queue.maxOracleStaleness(), 0, "premise: an upgraded proxy has NOT written this slot");
        assertEq(queue.maxClearingJumpTicks(), 0, "premise: an upgraded proxy has NOT written this slot");
        assertEq(queue.clearingTickSet(), false, "premise: no epoch has cleared, so the jump guard is inert");

        // The behaviour half, against the live schedule.
        assertEq(queue.effectiveShortTwapWindow(), DERIVED_SHORT_WINDOW, "the derived short window moved");
        assertEq(queue.effectiveMaxOracleStaleness(), DERIVED_STALENESS, "the derived staleness bound moved");
        assertEq(queue.effectiveMaxClearingJumpTicks(), DERIVED_JUMP, "the derived clearing-jump bound moved");
        assertEq(queue.effectiveMinSettleLiquidity(), DERIVED_MIN_LIQUIDITY, "the derived depth floor moved");
    }

    /// @notice NO DERIVED DEFAULT MAY MEAN "IMPOSSIBLE". With all four slots at zero and a pool that has
    ///         simply been trading, a batch settles — so the upgrade does not brick a queue whose pool is
    ///         alive, and an operator who sets nothing at all still has a working contract.
    ///
    ///         MUTATION: make any zero-case derive an unsatisfiable value (e.g. `effectiveMinSettleLiquidity`
    ///         return `type(uint128).max`, or `effectiveMaxOracleStaleness` return 0) -> RED.
    function test_anUpgradeThatSetsNothingAtAllStillSettlesALiveBatch() public {
        // Quiet only long enough for `consult` to answer the 1800 s window, i.e. an ordinary pool.
        _bootQueue(TWAP_WINDOW + 120);
        _placeAPerfectlyCrossingBatch();
        _reachSettlementWindow();

        // Still well inside the derived staleness bound, which is the whole point of the derivation.
        assertLt(
            _oracleAge(), queue.effectiveMaxOracleStaleness(), "premise: this pool is fresh by the derived bound"
        );

        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "the all-zero upgrade state could not settle");
    }

    /* ================================================================================
       2. THE ONE THAT HALTS THE LIVE QUEUE, AND THE EXACT CALL THAT LIFTS IT.
       ============================================================================= */

    /// @notice THE KNOWN HALT, REPRODUCED. On 2026-08-24 the live pool's newest observation was ~3.9 days
    ///         old — far past the derived 4.5-hour bound — so the first batch placed after the upgrade
    ///         cannot settle until the pool trades again OR the admin widens the bound. Both arms are
    ///         pinned here, because "the operator must call this afterwards" is only true if the call
    ///         actually works, and every other test of this dial only ever TIGHTENS it.
    ///
    ///         Nobody loses anything in the halted state: the epoch times out and every deposit comes back
    ///         in kind. But it must be a documented state, so it is documented by a test.
    ///
    ///         MUTATION: make `effectiveMaxOracleStaleness` ignore the stored value (always derive) -> the
    ///         second arm can never settle -> RED. Delete the staleness check in `_requireAnchorIsFresh`
    ///         -> the first arm settles -> RED.
    function test_theStalenessDefaultHaltsAFossilPoolAndTheAdminDialLiftsIt() public {
        // Longer than the derived bound and long enough that the freeze/settle clock cannot catch up.
        _bootQueue(DERIVED_STALENESS + 3_600);
        _placeAPerfectlyCrossingBatch();
        _reachSettlementWindow();

        assertGt(_oracleAge(), queue.effectiveMaxOracleStaleness(), "premise: this pool must read as a fossil");

        vm.expectRevert(MoleQueue.OracleTooStale.selector);
        queue.settle(0);

        // THE OPERATOR'S CALL. Widening past the derived default is the remediation, and it is admin-only.
        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(0, 30 days, 0, 0);
        assertEq(queue.effectiveMaxOracleStaleness(), 30 days, "a widened bound was not honoured");

        // Same epoch, same block, same anchor: only the bound changed.
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "the widened bound did not unblock settlement");
    }

    /// @notice ZERO IN THE SETTER MEANS "GO BACK TO DERIVED", NEVER "TURN THIS OFF". An operator who sets
    ///         one dial and leaves the rest zero must not silently disarm the other three, and an operator
    ///         who writes zeros back must get the derived guard rather than no guard.
    ///
    ///         MUTATION: make any `effective*` return the raw stored value -> the derived assertion after
    ///         the reset goes RED (a raw zero staleness would also brick every settlement, which is the
    ///         other half of why zero cannot mean the literal value).
    function test_writingZerosBackRestoresTheDerivedGuardsRatherThanDisablingThem() public {
        _bootQueue(0);

        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(120, 900, 100, 5_000);
        assertEq(queue.effectiveShortTwapWindow(), 120, "the explicit short window did not take");
        assertEq(queue.effectiveMaxOracleStaleness(), 900, "the explicit staleness did not take");
        assertEq(queue.effectiveMaxClearingJumpTicks(), 100, "the explicit jump bound did not take");
        assertEq(queue.effectiveMinSettleLiquidity(), 5_000, "the explicit depth floor did not take");

        vm.prank(TEST_UPGRADE_ADMIN);
        queue.setSettlementGuards(0, 0, 0, 0);
        assertEq(queue.effectiveShortTwapWindow(), DERIVED_SHORT_WINDOW, "zero disabled the short window");
        assertEq(queue.effectiveMaxOracleStaleness(), DERIVED_STALENESS, "zero disabled the staleness bound");
        assertEq(queue.effectiveMaxClearingJumpTicks(), DERIVED_JUMP, "zero disabled the clearing-jump bound");
        assertEq(queue.effectiveMinSettleLiquidity(), DERIVED_MIN_LIQUIDITY, "zero disabled the depth floor");
    }

    /* ------------------------------------------------------------------ internals */

    /// @dev Seconds since the oracle's newest RING WRITE for this pool — the same number
    ///      `_requireAnchorIsFresh` measures against the staleness bound.
    function _oracleAge() internal view returns (uint256) {
        (,, uint32 lastObsTs,,,) = hook.poolStates(qKey.toId());
        return block.timestamp - uint256(lastObsTs);
    }
}
