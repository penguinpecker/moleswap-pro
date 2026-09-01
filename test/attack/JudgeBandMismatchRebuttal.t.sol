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
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// JUDGE REBUTTAL HARNESS for "the 600-tick band admits what the 300 bps bound rejects".
///
/// Two claims in that report are tested here rather than argued:
///   (1) "the whole settlement reverts ... the crossed portion that needed no pool at all, and any
///       healthy other leg, included" and "it runs to the deadline and converts the batch into a full
///       in-kind refund, so the crossed portion ... simply never happens";
///   (2) that a fully-crossed batch inside the same drift band is somehow affected.
///
/// Both are false. The deadline path settles the CROSS at the TWAP and refunds only the unmatched
/// residual in kind, which is exactly what the Q-3 note promises; and a batch with no residual never
/// reaches the residual bound at all, so the 600-tick band is the live guard on that path.
///
/// `maxEpochLife` is 120 here purely so the deadline arrives while the drift is still open; every other
/// number is the live Robinhood 4663 configuration. The branch under test (settle:654/677/686-688) has
/// no dependence on the size of `maxEpochLife`.
contract JudgeBandMismatchRebuttal is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH_DURATION = 300;
    uint32 internal constant FREEZE_DURATION = 60;
    uint32 internal constant SHORT_EPOCH_LIFE = 120;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;

    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant FUNDING = 500_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
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
        uint160 high = uint160(uint256(keccak256("judge-band-rebuttal"))) & ~HookPermissions.ALL_HOOK_MASK;
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
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );

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
            SHORT_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );

        t0.transfer(alice, FUNDING);
        t1.transfer(bob, FUNDING);
        vm.prank(alice);
        t0.approve(address(queue), type(uint256).max);
        vm.prank(bob);
        t1.approve(address(queue), type(uint256).max);
    }

    /// CLAIM 1 — "the crossed portion simply never happens". It happens.
    function test_theDeadlinePathSettlesTheCrossAndRefundsOnlyTheResidual() public {
        vm.prank(alice);
        queue.place(true, 10e18); // sells currency0
        vm.prank(bob);
        queue.place(false, 4e18); // buys currency0 — this is the crossed portion

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(1);
        _swap(true, 4_564e18); // the same ~435-tick adverse move the report drives
        _advance(FREEZE_DURATION);

        int24 anchor = hook.consult(poolKey.toId(), TWAP_WINDOW);
        (, int24 spot,,) = StateLibrary.getSlot0(manager, poolKey.toId());
        int24 drift = spot > anchor ? spot - anchor : anchor - spot;
        emit log_named_int("drift, ticks", drift);
        assertLe(drift, MAX_TWAP_DEVIATION_TICKS, "the spot band admits it, as the report says");

        // Strict window: the report's revert. Reproduced, not disputed.
        vm.expectRevert(MoleQueue.ResidualSwapTooFarFromTwap.selector);
        vm.prank(stranger);
        queue.settle(0);

        // Deadline: lenient. Also the 60s window `timeout` cannot pre-empt (F-06 fix).
        _advance(60); // frozenAt + 121: lenient (>= +120), and timeout (>= +180) cannot pre-empt
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        uint256 aT0 = t0.balanceOf(alice);
        uint256 aT1 = t1.balanceOf(alice);
        uint256 bT0 = t0.balanceOf(bob);

        vm.prank(stranger);
        queue.settle(0);

        (MoleQueue.Phase phase,, uint128 in0, uint128 in1, uint128 out0, uint128 out1, uint128 r0, uint128 r1) =
            queue.epochs(0);
        assertEq(uint8(phase), uint8(MoleQueue.Phase.Settled), "the epoch SETTLES at the deadline");
        emit log_named_uint("out0 (currency1 owed to the currency0 sellers)", out0);
        emit log_named_uint("out1 (currency0 owed to the currency1 sellers)", out1);
        emit log_named_uint("refund0 (residual back in kind)", r0);

        // THE CROSS HAPPENED: both sides are owed the other token at the TWAP.
        assertGt(out0, 0, "currency0 sellers are owed currency1 - the cross was NOT skipped");
        assertEq(in1, 4e18, "bob's whole side was absorbed");
        assertEq(r1, 0, "no residual on the fully-absorbed side");
        assertGt(r0, 0, "only the UNMATCHED remainder comes back in kind");
        assertEq(uint256(out0) + 0, uint256(in1), "the currency0 sellers receive bob's entire escrow");
        assertEq(uint256(out1) + uint256(r0), uint256(in0), "cross + refund conserves alice's escrow");

        vm.prank(alice);
        queue.claim(0, 0);
        vm.prank(bob);
        queue.claim(0, 1);

        assertEq(t1.balanceOf(alice) - aT1, out0, "alice was FILLED on the crossed part, at the TWAP");
        assertEq(t0.balanceOf(alice) - aT0, r0, "and only the unmatched remainder came back in kind");
        assertEq(t0.balanceOf(bob) - bT0, out1, "bob was filled in full");
    }

    /// CLAIM 2 — a batch with NO residual never reaches the residual bound, so the 600-tick band is a
    /// live, load-bearing guard on that path rather than one that "cannot fire".
    function test_aFullyCrossedBatchSettlesInsideTheSameDriftBand() public {
        vm.prank(alice);
        queue.place(true, 4e18);
        vm.prank(bob);
        queue.place(false, 4e18);

        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(1);
        _swap(true, 4_564e18);
        _advance(FREEZE_DURATION);

        (, int24 spot,,) = StateLibrary.getSlot0(manager, poolKey.toId());
        int24 anchor = hook.consult(poolKey.toId(), TWAP_WINDOW);
        emit log_named_int("drift, ticks", spot > anchor ? spot - anchor : anchor - spot);

        vm.prank(stranger);
        queue.settle(0); // STRICT window, same drift, settles

        (MoleQueue.Phase phase,,,,,, uint128 r0, uint128 r1) = queue.epochs(0);
        assertEq(uint8(phase), uint8(MoleQueue.Phase.Settled), "no residual, no bound, strict settlement");
        assertEq(r0, 0);
        assertEq(r1, 0);
    }

    /// CLAIM 3 — the report's own named remedy (AUDIT F-01 "Option E": cross-check the two bands at
    /// initialize, capping the tick band at ~270) makes the harm it complains about REAL. The spot band
    /// is checked at settle:576, BEFORE `lenient` is computed at settle:654, so tightening it gates the
    /// deadline rescue as well: at the same 435-tick drift the epoch can no longer settle at all, and
    /// `timeout` returns EVERYTHING in kind — the crossed portion included. That is the F-01 outcome.
    function test_theProposedCrossCheckWouldDestroyTheDeadlineRescue() public {
        MoleQueue tight = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            poolKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            SHORT_EPOCH_LIFE,
            TWAP_WINDOW,
            int24(270), // what Option E's arithmetic caps the band at, given 300 bps and a 30 bps pool fee
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
        vm.prank(alice);
        t0.approve(address(tight), type(uint256).max);
        vm.prank(bob);
        t1.approve(address(tight), type(uint256).max);

        vm.prank(alice);
        tight.place(true, 10e18);
        vm.prank(bob);
        tight.place(false, 4e18);

        _advance(EPOCH_DURATION);
        tight.freeze();
        _advance(1);
        _swap(true, 4_564e18);
        _advance(FREEZE_DURATION);
        _advance(60);

        // The deadline is reached and the rescue is unreachable: the tightened band refuses first.
        vm.expectRevert(MoleQueue.TwapTooFarFromSpot.selector);
        vm.prank(stranger);
        tight.settle(0);

        // ... so the only resolution left is the one that throws the cross away.
        _advance(60);
        tight.timeout(0);
        (MoleQueue.Phase phase,,,, uint128 out0, uint128 out1,,) = tight.epochs(0);
        assertEq(uint8(phase), uint8(MoleQueue.Phase.Refunding), "everything in kind");
        assertEq(out0, 0, "the cross never happened - the exact outcome the report calls the harm");
        assertEq(out1, 0);
    }
}
