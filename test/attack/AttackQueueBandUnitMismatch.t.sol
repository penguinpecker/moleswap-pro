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
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// TWO BANDS, TWO UNITS, NEVER CROSS-CHECKED — with the LIVE Robinhood 4663 numbers.
///
/// `settle` admits any epoch whose spot sits within `maxTwapDeviationTicks` (600 ticks = 6.183%) of the
/// clearing anchor. `unlockCallback` then demands the aggregated residual swap land within
/// `maxResidualSlippageBps` (300 bps = 3%) of that same anchor, and the pool's own LP fee (3000 pips =
/// 0.30%) is spent INSIDE that 3%. So every adverse drift in roughly (274, 600] ticks passes settle's
/// gate and is then GUARANTEED to breach the residual bound — the outer guard cannot fire on exactly the
/// band where the inner one always does.
///
/// Inside the strict window that reverts the WHOLE settlement, crossed portion included, for the entire
/// window. No attacker is required: a 2.8% move inside a 30-minute TWAP window is an ordinary market.
contract AttackQueueBandUnitMismatch is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    // LIVE Robinhood 4663 parameters, read from proxy 0x3dCb2494… on 2026-08-24.
    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant FREEZE_DURATION = 60;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;

    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant FUNDING = 500_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;
    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function _hookAddr() internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256("band-unit-mismatch"))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        address a = _hookAddr();
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        poolKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(a)
        });
        manager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));
        // Deep and spanning the tick on both sides: no residual in this file can ever short-fill, so a
        // settlement that fails here fails on the BOUND and never on the pool's depth.
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );

        // Warm the ring, then a quiet stretch so the anchor is the opening tick and drift reads zero.
        _advance(90);
        _swap(true, 1e16);
        _advance(90);
        _swap(false, 1e15);
        _advance(90);
        _swap(true, 1e16);
        _advance(TWAP_WINDOW + 120);

        queue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            poolKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );

        t0.transfer(alice, FUNDING);
        t1.transfer(alice, FUNDING);
        vm.startPrank(alice);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev One-sided epoch: nothing crosses, the whole escrow is the residual, so the residual bound is
    ///      the only thing under test. Freeze, then move the market adversely by `sellAmount`, then wait
    ///      out the freeze delay and settle inside the STRICT window.
    function _driveTo(uint256 sellAmount) internal returns (int24 anchor, int24 spot, int24 shortRef) {
        vm.prank(alice);
        queue.place(true, 10e18); // selling currency0

        _advance(EPOCH_DURATION);
        queue.freeze();

        _advance(1);
        _swap(true, sellAmount); // the market moves against the currency0 sellers
        _advance(FREEZE_DURATION);

        anchor = hook.consult(poolKey.toId(), TWAP_WINDOW);
        (, spot,,) = StateLibrary.getSlot0(manager, poolKey.toId());
        shortRef = hook.consult(poolKey.toId(), queue.effectiveShortTwapWindow());
    }

    function _absDiff(int24 a, int24 b) internal pure returns (int24) {
        return a > b ? a - b : b - a;
    }

    /// @notice CONTROL — a 150-tick drift. Both bands agree and the batch settles inside the strict window.
    function test_control_aSmallAdverseDriftStillSettlesInTheStrictWindow() public {
        (int24 anchor, int24 spot,) = _driveTo(1_510e18);
        emit log_named_int("anchor", anchor);
        emit log_named_int("spot", spot);
        emit log_named_int("drift (ticks)", _absDiff(spot, anchor));

        vm.prank(stranger);
        queue.settle(0);
        (MoleQueue.Phase phase,,,,,,,) = queue.epochs(0);
        assertEq(uint8(phase), uint8(MoleQueue.Phase.Settled), "control: the strict window settles");
    }

    /// @notice THE BREAK — a ~435-tick drift. Well inside `maxTwapDeviationTicks` (600), so `settle`'s own
    ///         staleness gate ADMITS the batch, and the residual bound then refuses it with certainty.
    ///         The refusal is not a one-block accident: it stands until the anchor itself has caught up,
    ///         which takes most of a TWAP window — and a griefer who keeps re-displacing spot holds it
    ///         all the way to the deadline, where the whole residual comes back unexecuted.
    function test_aDriftInsideTheSpotBandIsGuaranteedToBreachTheResidualBound() public {
        (int24 anchor, int24 spot, int24 shortRef) = _driveTo(4_564e18);

        int24 drift = _absDiff(spot, anchor);
        emit log_named_int("anchor (clearing TWAP)", anchor);
        emit log_named_int("spot", spot);
        emit log_named_int("short TWAP reference", shortRef);
        emit log_named_int("drift, ticks", drift);

        // Both of settle's own price gates are satisfied — that is the whole point.
        assertLe(drift, MAX_TWAP_DEVIATION_TICKS, "spot band ADMITS this batch");
        assertLe(_absDiff(shortRef, anchor), MAX_TWAP_DEVIATION_TICKS, "short-TWAP band ADMITS it too");

        // And the settlement is refused anyway, by the bound one frame deeper.
        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        vm.prank(stranger);
        queue.settle(0);

        // How long the refusal lasts, measured rather than asserted: step forward until it clears.
        uint256 startedAt = _clock;
        uint256 deniedFor;
        for (uint256 i = 0; i < 40; i++) {
            _advance(60);
            (bool ok,) = address(queue).call(abi.encodeWithSelector(MoleQueue.settle.selector, uint64(0)));
            if (ok) {
                deniedFor = _clock - startedAt;
                break;
            }
        }
        emit log_named_uint("settlement denied for (seconds)", deniedFor);
        emit log_named_uint("designed epoch cycle (seconds)", uint256(EPOCH_DURATION) + FREEZE_DURATION);
        assertGt(deniedFor, uint256(EPOCH_DURATION) + FREEZE_DURATION, "escrow held past a whole extra cycle");

        (MoleQueue.Phase phase,,,,,,,) = queue.epochs(0);
        assertEq(uint8(phase), uint8(MoleQueue.Phase.Settled), "it does eventually settle, once the anchor catches up");
    }

    /// @notice The arithmetic, printed. `fair1` is the residual valued at the CLEARING ANCHOR; the bound
    ///         is 97% of it; the pool at the admitted drift cannot reach that, and the LP fee is spent
    ///         inside the same 3%. The two bands are 600 ticks (6.183%) and 300 bps (3.0%) minus 30 bps.
    function test_evidence_theTwoBandsCannotBothBeSatisfied() public {
        (int24 anchor, int24 spot,) = _driveTo(4_564e18);
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(anchor);
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtA), uint256(sqrtA), FixedPoint96.Q96);
        uint256 fair1 = FullMath.mulDiv(10e18, priceX96, FixedPoint96.Q96);
        emit log_named_int("anchor", anchor);
        emit log_named_int("spot (admitted by the 600-tick band)", spot);
        emit log_named_uint("fair1 at the anchor", fair1);
        emit log_named_uint("residual bound = 97% of fair1", FullMath.mulDiv(fair1, 9700, 10000));
        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        vm.prank(stranger);
        queue.settle(0);
    }
}
