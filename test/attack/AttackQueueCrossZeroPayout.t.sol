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
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @title The OTHER half of the F-01 zero-cross guard, and why it is the half that matters
///
/// `settle` computes the cross in two mirrored branches, and the F-01 fix guarded only one of them:
///
///   branch A  (side 1 fully absorbed):  crossed1 = crossed0 == 0 ? 0 : totalIn1;      <- was GUARDED
///   branch B  (side 0 fully absorbed):  crossed1 = mulDiv(crossed0, priceX96, Q96);   <- was NOT
///
/// In branch B `crossed0 == totalIn0`, so `residual0` is zero by construction. When that mulDiv floors
/// to zero, the whole of side 0's escrow crossed for NOTHING and was booked no refund either - the
/// exact outcome branch A's own comment says must never happen ("hand that entire escrow to the
/// currency0 side in exchange for NOTHING, and book it no refund either, leaving it unreachable by
/// every exit for ever"), reached from the other side.
///
/// WHICH BRANCH CAN FIRE IS DECIDED BY THE POOL'S PRICE ORIENTATION, and only ever one of the two:
///   * `priceX96 < Q96` (currency1 the dearer raw unit - the LIVE RH WETH/USDG pool, tick -200461):
///     `want0 = mulDiv(totalIn1, Q96, priceX96) >= totalIn1 >= 1`, so branch A's guard can NEVER fire,
///     and branch B's silent zero IS reachable. On live params that is every currency0 escrow up to
///     507,545,927 wei.
///   * `priceX96 > Q96`: the mirror, which is the case branch A's guard already covered.
///
/// This file pins the reachable half on a `priceX96 < Q96` pool, i.e. the live orientation.
contract AttackQueueCrossZeroPayout is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;

    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;
    uint256 internal constant DUST_FLOOR = 34; // ceil(10_000 / 300)

    /// @dev Negative, so `priceX96 < Q96` - the LIVE orientation (RH WETH/USDG sits at -200461).
    int24 internal constant TICK = -20_040;

    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant FUNDING = 100_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
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

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack-queue-crosszero", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
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

    function _warmOracleOn(PoolKey memory k) internal {
        _advance(90);
        _swapOn(k, true, 1e16);
        _advance(90);
        _swapOn(k, false, 1e15);
        _advance(90);
        _swapOn(k, true, 1e16);
        _advance(TWAP_WINDOW + 120);
    }

    function _fund(address who) internal {
        t0.transfer(who, FUNDING);
        t1.transfer(who, FUNDING);
        vm.startPrank(who);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    function _place(address who, bool zeroForOne, uint128 amount) internal returns (uint256 idx) {
        vm.prank(who);
        idx = queue.place(zeroForOne, amount);
    }

    function _claimOnce(address who, uint64 e, uint256 idx) internal returns (uint256) {
        vm.prank(who);
        return queue.claim(e, idx);
    }

    function _twapPriceX96() internal view returns (uint256 priceX96, int24 tick) {
        tick = hook.consult(poolKey.toId(), TWAP_WINDOW);
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
    }

    function _freezeAndSettleStrict(uint64 e) internal {
        _advance(EPOCH_DURATION);
        queue.freeze();
        _advance(FREEZE_DURATION);
        (, uint64 frozenAt,,,,,,) = queue.epochs(e);
        assertLt(_clock, uint256(frozenAt) + MAX_EPOCH_LIFE, "premise: this must be the STRICT window");
        vm.prank(stranger);
        queue.settle(e);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        address a = _hookAddr(1);
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
            hooks: IHooks(address(hook))
        });
        manager.initialize(poolKey, TickMath.getSqrtPriceAtTick(TICK));
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 0, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );
        _warmOracleOn(poolKey);

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

        _fund(alice);
        _fund(carol);
        _fund(stranger);
    }

    /* ================================================================================
       1. Why the guard that WAS written could never have fired here.
       ============================================================================= */

    /// @notice The branch-A `crossed0 == 0` test is DEAD CODE whenever `priceX96 < Q96`, which is the
    ///         live pool's orientation. `want0` is monotone in `totalIn1` and already at least 1 when
    ///         `totalIn1` is 1, so `crossed0` can never be zero while side 1 holds anything at all.
    ///         This is a property of the arithmetic, so it holds under any edit to `settle` - it is
    ///         the PREMISE that makes the tests below the ones that matter.
    function test_theBranchAZeroCrossGuardIsUnreachableAtThisPriceOrientation() public view {
        (uint256 priceX96,) = _twapPriceX96();
        assertLt(priceX96, FixedPoint96.Q96, "premise: currency1 must be the dearer raw unit, as on RH");
        assertGt(
            FullMath.mulDiv(uint256(1), FixedPoint96.Q96, priceX96),
            0,
            "want0 can never floor to zero here, so `crossed0 == 0` is unreachable"
        );
    }

    /* ================================================================================
       2. The branch that IS reachable no longer eats the escrow.
       ============================================================================= */

    /// @notice REGRESSION. A currency0 order small enough to be worth less than ONE raw unit of
    ///         currency1 used to cross IN FULL for zero output with no refund booked: `out0 == 0` AND
    ///         `refund0 == 0` on a SETTLED epoch, `claim` paying the owner nothing while burning the
    ///         one-shot flag, and the escrow already handed to the currency1 side inside `out1`. It
    ///         now stays a residual and comes back in kind, which is what the mirrored branch already
    ///         did.
    ///
    ///         MUTATION: delete `if (crossed1 == 0) crossed0 = 0;` from the else-branch of the
    ///         `crossed1` assignment in `settle` -> this test goes RED at `refund0` (0 != side0), and
    ///         `test_conservation_aSubUnitCurrencyZeroEscrowIsNotCrossedForNothing` in
    ///         AttackQueueCrossingMath.t.sol goes RED with it. VERIFIED.
    function test_aSubUnitCurrency0EscrowComesBackInKindInsteadOfCrossingForNothing() public {
        (uint256 priceX96,) = _twapPriceX96();

        // The largest currency0 amount whose fair value is still LESS than one raw unit of currency1.
        uint128 side0 = uint128(FullMath.mulDiv(uint256(1), FixedPoint96.Q96, priceX96));
        assertGt(side0, 0, "premise: the orientation must leave room for a sub-unit order");
        assertEq(
            FullMath.mulDiv(uint256(side0), priceX96, FixedPoint96.Q96),
            0,
            "premise: this much currency0 is worth less than one raw unit of currency1"
        );

        // Side 1 large enough to survive the dust floor, so the residual really reaches the pool and
        // the epoch really settles. The defect was on side 0; this side is here to make it settle.
        uint128 side1 = uint128(DUST_FLOOR);
        uint256 want0 = FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96);
        assertLt(uint256(side0), want0, "premise: side 0 is the smaller side, so the once-unguarded branch runs");

        uint256 aliceT0Before = t0.balanceOf(alice);
        uint256 aliceT1Before = t1.balanceOf(alice);

        uint256 iA = _place(alice, true, side0);
        uint256 iC = _place(carol, false, side1);

        _freezeAndSettleStrict(0);

        (MoleQueue.Phase phase,, uint128 in0, uint128 in1, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1)
        = queue.epochs(0);

        assertEq(uint8(phase), uint8(MoleQueue.Phase.Settled), "the epoch settled, it was not refused");
        assertEq(in0, side0, "side 0 escrow recorded");
        assertEq(in1, side1, "side 1 escrow recorded");

        // Nothing crossed, so nothing crossed: no currency1 owed, and the escrow booked back in kind.
        assertEq(out0, 0, "a sub-unit escrow cannot be credited with a cross it cannot buy");
        assertEq(refund0, side0, "and it must therefore come back in the token it arrived in");
        assertEq(refund1, 0, "side 1 kept nothing back");

        // The owner's exit pays the escrow back, in kind, in full.
        assertEq(_claimOnce(alice, 0, iA), 0, "there is no currency1 leg, and there should not be");
        assertEq(t0.balanceOf(alice), aliceT0Before, "alice is whole in currency0");
        assertEq(t1.balanceOf(alice), aliceT1Before, "and took nothing she did not earn");

        // And the currency1 seller is paid only what its own residual swap produced.
        assertEq(_claimOnce(carol, 0, iC), out1, "the currency1 seller takes its own fill and nothing of alice's");
    }

    /* ================================================================================
       3. Stated as the invariant, so a future edit that breaks it is named for it.
       ============================================================================= */

    /// @notice INVARIANT. A settled epoch must never leave a side that escrowed something owed nothing
    ///         in the other currency AND booked nothing back in its own. That state has no exit:
    ///         `claim` pays zero and marks the order withdrawn, `timeout` is closed to a settled
    ///         epoch, and there is no sweep. The header's "three ways money leaves, and there is
    ///         deliberately no fourth" is exactly this claim.
    ///
    ///         MUTATION: delete `if (crossed1 == 0) crossed0 = 0;` -> RED. VERIFIED.
    function test_aSettledEpochNeverOwesASideNothingAndRefundsItNothing() public {
        (uint256 priceX96,) = _twapPriceX96();
        uint128 side0 = uint128(FullMath.mulDiv(uint256(1), FixedPoint96.Q96, priceX96));
        uint128 side1 = uint128(DUST_FLOOR);

        _place(alice, true, side0);
        _place(carol, false, side1);
        _freezeAndSettleStrict(0);

        (,, uint128 in0, uint128 in1, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = queue.epochs(0);

        assertGt(in0, 0, "premise: side 0 escrowed something");
        assertFalse(out0 == 0 && refund0 == 0, "side 0 escrowed, settled, and is owed nothing in either currency");
        assertGt(in1, 0, "premise: side 1 escrowed something");
        assertFalse(out1 == 0 && refund1 == 0, "side 1 escrowed, settled, and is owed nothing in either currency");
    }

    /// @notice CONSERVATION, restated for this shape: what the queue holds after settlement is exactly
    ///         what it has booked itself to pay. This held BEFORE the fix too - the escrow was not
    ///         stranded, it was paid to the wrong party - which is precisely why no existing
    ///         conservation test could ever have seen the defect. Kept so the record says so.
    function test_conservationHoldsEitherWayWhichIsWhyItCouldNotCatchThis() public {
        (uint256 priceX96,) = _twapPriceX96();
        uint128 side0 = uint128(FullMath.mulDiv(uint256(1), FixedPoint96.Q96, priceX96));

        _place(alice, true, side0);
        _place(carol, false, uint128(DUST_FLOOR));
        _freezeAndSettleStrict(0);

        (,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = queue.epochs(0);
        assertEq(t0.balanceOf(address(queue)), uint256(out1) + refund0, "currency0 held == currency0 owed");
        assertEq(t1.balanceOf(address(queue)), uint256(out0) + refund1, "currency1 held == currency1 owed");
    }
}
