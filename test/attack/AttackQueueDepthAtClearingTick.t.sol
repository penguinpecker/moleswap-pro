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

/// @notice THE DEPTH GUARD WAS A ONE-TICK, ONE-WEI, PERMISSIONLESS KILL SWITCH — AND IT WAS ALSO TOO WEAK.
///
/// `_requireTheMarketCanBackThisPrice` asked "does this pool have depth" by reading `pool.liquidity`,
/// which is the liquidity active at the CURRENT tick and at no other tick. Two things follow from that,
/// and they point in opposite directions, which is why one change fixes both.
///
///   DENIAL. Depth read at spot is depth read at a number ANY passer-by can move. The live RH 4663 queue
///   pool has exactly two initialized ticks — -201060 and -200460 — one position spanning them, and spot
///   resting at -200461, one tick under the top. A one-for-zero swap of about 1,140 raw units crosses
///   -200460, v4 subtracts that position's `liquidityNet`, and `pool.liquidity` becomes exactly ZERO.
///   Every later `settle` reverted `InsufficientPoolDepth`. No drift guard sees it: one tick of spot drift
///   against a band of six hundred. Park the tick and walk away and every frozen epoch runs out its clock
///   and resolves through `timeout` — repeatable, indefinite, by anyone, for a fraction of a cent, and
///   available to a participant who has seen where the cross would land and wants out after the cutoff
///   took cancellation away. No principal moves; the loss is the product.
///
///   AND WEAKNESS, from the same read. The guard exists so a batch cannot clear against a band with
///   nothing in it. Depth at spot does not answer that question: an attacker who has walked the TWAP into
///   a liquidity desert can step spot back onto a live band anywhere inside `maxTwapDeviationTicks` and
///   the old read is satisfied by liquidity that stands six hundred ticks from the price the batch is
///   about to cross a whole epoch's escrow at.
///
/// So the depth is measured AT THE CLEARING TICK, by replaying v4's own crossing arithmetic over the
/// initialized ticks between spot and the anchor. Moving spot moves the start of that walk and the ticks
/// it crosses by exactly compensating amounts, so the answer depends on the BOOK and the ANCHOR only —
/// neither of which a settler can move inside one transaction. Same dial, same revert, no new state.
contract AttackQueueDepthAtClearingTick is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    uint32 internal constant EPOCH = 600;
    uint32 internal constant FREEZE = 120;
    uint32 internal constant LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant TWAP_BAND = 600; // the live RH 4663 value
    uint16 internal constant RESIDUAL_BPS = 200;

    uint256 internal constant T0 = 1_750_000_000;

    // ---- the live RH 4663 queue pool, tick for tick. Read on 2026-08-24 with `extsload` against
    // PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, pool
    // 0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029: bitmap word -14 has exactly two
    // bits set, slot0.tick is -200461, and `ticks[-200460].liquidityNet` is the exact negation of
    // `pool.liquidity`. One position IS the whole book, and its top edge is ONE TICK away.
    int24 internal constant LIVE_LOWER = -201060;
    int24 internal constant LIVE_UPPER = -200460;
    int24 internal constant LIVE_SPOT = -200461;
    uint128 internal constant LIVE_BOOK = 5_899_269_704_378;

    // ---- a two-band book with a desert between them: the shape the depth guard was BUILT for.
    int24 internal constant BAND_A_LOWER = -1200;
    int24 internal constant BAND_A_UPPER = 600;
    int24 internal constant BAND_B_LOWER = 1500;
    int24 internal constant BAND_B_UPPER = 6000;
    int256 internal constant BAND_LIQ = 200_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal whale = makeAddr("whale");
    address internal griefer = makeAddr("griefer");

    MoleHook internal hookLive;
    MoleHook internal hookBands;
    MoleQueue internal queueLive;
    MoleQueue internal queueBands;
    PoolKey internal kLive;
    PoolKey internal kBands;

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
            uint160(uint256(keccak256(abi.encode("attack-depth-at-clearing-tick", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deployHook(uint256 seed) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        h = MoleHook(a);
    }

    function _poolKey(MoleHook h) internal view returns (PoolKey memory k) {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(h))
        });
    }

    function _mint(PoolKey memory k, int24 lower, int24 upper, int256 liq) internal {
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liq, salt: 0}), ZERO_BYTES
        );
    }

    function _newQueue(PoolKey memory k, MoleHook h) internal returns (MoleQueue q) {
        q = deployMoleQueue(
            manager, IMoleOracle(address(h)), k, EPOCH, FREEZE, LIFE, TWAP_WINDOW, TWAP_BAND, RESIDUAL_BPS,
            TEST_UPGRADE_ADMIN
        );
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, 2_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(who, 2_000_000e18);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(queueLive), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(queueLive), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(queueBands), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(queueBands), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(swapRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(swapRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Push a pool to (and no further than) `toTick` by pinning the swap's own price limit there.
    function _walkTo(PoolKey memory k, address who, int24 toTick, uint256 size) internal {
        (, int24 nowTick,,) = StateLibrary.getSlot0(manager, k.toId());
        bool zeroForOne = toTick < nowTick;
        vm.prank(who);
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(size),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(toTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _spotTick(PoolKey memory k) internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    function _spotLiquidity(PoolKey memory k) internal view returns (uint128) {
        return StateLibrary.getLiquidity(manager, k.toId());
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    function _absTick(int24 a) internal pure returns (int24) {
        return a < 0 ? -a : a;
    }

    /// @dev Two orders that cross EXACTLY at `anchor`, so the residual is zero (or one raw unit of dust)
    ///      and NOTHING in this settlement touches the pool. That is deliberate: it keeps every one of
    ///      these tests about the depth guard rather than about what a residual swap happens to execute at.
    function _placeCrossingPair(MoleQueue q, uint128 amount0, int24 anchor) internal {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(anchor);
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
        uint128 amount1 = uint128(FullMath.mulDiv(amount0, priceX96, FixedPoint96.Q96));
        assertGt(amount1, 0, "premise: the mirrored order rounded away to nothing");
        vm.prank(alice);
        q.place(true, amount0);
        vm.prank(bob);
        q.place(false, amount1);
    }

    /// @dev Roll `q` into a fresh Open epoch. Needed by every test that has to move the market BEFORE the
    ///      orders exist: the walk plus the wait for the TWAP outlasts an epoch, so epoch 0 is past its
    ///      duration by the time there is an anchor to size orders against.
    function _rollToFreshEpoch(MoleQueue q) internal returns (uint64 e) {
        q.freeze();
        e = q.currentEpoch();
    }

    function _reachSettlementWindow(MoleQueue q) internal {
        _advance(EPOCH);
        q.freeze();
        _advance(FREEZE);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        // ---- pool 1: the live book, tick for tick.
        hookLive = _deployHook(1);
        kLive = _poolKey(hookLive);
        manager.initialize(kLive, TickMath.getSqrtPriceAtTick(LIVE_SPOT));
        _mint(kLive, LIVE_LOWER, LIVE_UPPER, int256(uint256(LIVE_BOOK)));

        // ---- pool 2: two deep bands with an empty desert between them. Ticks 600..1500 carry nothing,
        // which is what makes the price walkable across them for free and is the region the walks park in.
        hookBands = _deployHook(2);
        kBands = _poolKey(hookBands);
        manager.initialize(kBands, SQRT_PRICE_1_1);
        _mint(kBands, BAND_A_LOWER, BAND_A_UPPER, BAND_LIQ);
        _mint(kBands, BAND_B_LOWER, BAND_B_UPPER, BAND_LIQ);

        // Let the seeding observations age past the TWAP window so `consult` can answer at all.
        _advance(uint256(TWAP_WINDOW) * 2);

        queueLive = _newQueue(kLive, hookLive);
        queueBands = _newQueue(kBands, hookBands);

        _fund(alice);
        _fund(bob);
        _fund(whale);
        _fund(griefer);
    }

    /* ================================================================================
       THE DENIAL
       ============================================================================= */

    /// @notice ONE TICK OF SPOT, PAID FOR BY ANYONE, USED TO END SETTLEMENT ON THE LIVE POOL FOR EVER.
    ///
    ///         The book here is the live one: one position, `[-201060, -200460)`, and spot at -200461 —
    ///         the last tick inside it. The griefer crosses the top edge, v4 takes the position out of
    ///         range, `pool.liquidity` reads ZERO, and the old guard refused every settlement from then on
    ///         while the clearing tick ONE TICK BELOW still had the entire book standing under it.
    ///
    ///         Nothing else in the contract could see it. The griefer's own swap wrote a ring observation
    ///         at `now`, so both anchors still read the fossil tick and the drift is ONE against a band of
    ///         six hundred. The assertions below pin every one of those premises before the settlement, so
    ///         a future change that makes this test pass for some other reason cannot do so quietly.
    function test_liveBook_oneTickOfSpotNoLongerDeniesSettlementForever() public {
        _placeCrossingPair(queueLive, 1e15, LIVE_SPOT);
        _reachSettlementWindow(queueLive);

        assertEq(_spotTick(kLive), LIVE_SPOT, "premise: the pool did not start one tick under its book's top");
        assertEq(_spotLiquidity(kLive), LIVE_BOOK, "premise: the whole book is not in range to begin with");

        // The entire attack. `amountSpecified` is a ceiling, not a spend: the price limit stops the swap
        // the moment it crosses the edge, and what it actually cost is asserted below.
        uint256 spentBefore = _bal(currency1, griefer);
        _walkTo(kLive, griefer, LIVE_UPPER, 1e12);
        uint256 spent = spentBefore - _bal(currency1, griefer);

        assertEq(_spotTick(kLive), LIVE_UPPER, "premise: the griefer did not cross the book's top edge");
        assertEq(_spotLiquidity(kLive), 0, "premise: crossing the top edge was supposed to empty pool.liquidity");
        assertLt(spent, 100_000, "premise: the cross was supposed to be a rounding error, not a trade");

        // And the price did not move in any sense the rest of the contract can see.
        int24 anchor = hookLive.consult(kLive.toId(), TWAP_WINDOW);
        int24 shortAnchor = hookLive.consult(kLive.toId(), queueLive.effectiveShortTwapWindow());
        assertEq(anchor, LIVE_SPOT, "premise: the anchor moved, so this would not be a pure depth test");
        assertLe(_absTick(shortAnchor - anchor), TWAP_BAND, "premise: the anchor drift guard would have fired anyway");
        assertLe(_absTick(_spotTick(kLive) - anchor), TWAP_BAND, "premise: the spot band would have fired anyway");
        assertEq(_absTick(_spotTick(kLive) - anchor), 1, "premise: the drift the band is asked about is not one tick");

        // THE POINT. Depth measured where the batch actually clears is depth the griefer did not move.
        queueLive.settle(0);
        assertEq(uint8(queueLive.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "one tick of spot still denies settlement");

        // Both depositors are paid, at the anchor, out of each other — the pool was never needed.
        uint256 aliceBefore = _bal(currency1, alice);
        vm.prank(alice);
        queueLive.claim(0, 0);
        assertGt(_bal(currency1, alice) - aliceBefore, 0, "the crossed side was paid nothing");
    }

    /// @notice THE MIRROR, AND THE OTHER HALF OF THE WALK. Spot parked in a desert BELOW the anchor is the
    ///         same denial reached from the other direction, and it exercises the upward branch of the
    ///         crossing replay — the one that ADDS `liquidityNet` — which the test above never reaches.
    function test_spotParkedInADesertBelowTheAnchorDoesNotDenySettlement() public {
        // Put the market — and then the TWAP — inside band B.
        _walkTo(kBands, whale, 1980, 500_000e18);
        _advance(uint256(TWAP_WINDOW) * 2);
        assertEq(_spotTick(kBands), 1980, "premise: the walk did not land inside band B");

        uint64 e = _rollToFreshEpoch(queueBands);
        int24 anchor = hookBands.consult(kBands.toId(), TWAP_WINDOW);
        assertEq(anchor, 1980, "premise: the TWAP has not settled onto the walked tick");
        _placeCrossingPair(queueBands, 1_000e18, anchor);
        _reachSettlementWindow(queueBands);

        // The griefer steps spot DOWN out of band B and parks it in the empty stretch below.
        _walkTo(kBands, griefer, 1440, 500_000e18);
        assertEq(_spotTick(kBands), 1440, "premise: the griefer did not park spot in the desert");
        assertEq(_spotLiquidity(kBands), 0, "premise: the desert is supposed to have nothing in range");
        assertEq(hookBands.consult(kBands.toId(), TWAP_WINDOW), anchor, "premise: the park moved the anchor");
        assertLe(_absTick(_spotTick(kBands) - anchor), TWAP_BAND, "premise: the spot band would have fired anyway");

        queueBands.settle(e);
        assertEq(uint8(queueBands.phaseOf(e)), uint8(MoleQueue.Phase.Settled), "a parked spot still denies settlement");
    }

    /* ================================================================================
       AND THE GUARD IS STRICTLY STRONGER, NOT MERELY LOOSER
       ============================================================================= */

    /// @notice THE ATTACK THE DEPTH GUARD EXISTS FOR, WITH THE STEP THAT USED TO WALK STRAIGHT PAST IT.
    ///
    ///         Walk the TWAP into a liquidity desert and the batch clears at a price nothing has ever
    ///         stood behind — that is the original finding, and depth-at-spot caught it only because the
    ///         attacker left spot in the desert too. They never had to. Stepping spot back onto band B,
    ///         five hundred ticks away and comfortably inside the six-hundred-tick band, satisfied the old
    ///         read with liquidity that stands nowhere near the clearing price.
    ///
    ///         Measured at the clearing tick, the step buys nothing: the replay crosses band B's lower
    ///         edge back down on its way to the anchor and arrives at the same zero the desert has.
    function test_steppingSpotOntoALiveBandDoesNotBuyDepthAtTheClearingTick() public {
        _walkTo(kBands, whale, 1020, 500_000e18);
        _advance(uint256(TWAP_WINDOW) * 2);
        assertEq(_spotTick(kBands), 1020, "premise: the walk did not land in the desert");
        assertEq(_spotLiquidity(kBands), 0, "premise: the desert is supposed to have nothing in range");

        uint64 e = _rollToFreshEpoch(queueBands);
        int24 anchor = hookBands.consult(kBands.toId(), TWAP_WINDOW);
        assertEq(anchor, 1020, "premise: the TWAP has not followed the walk into the desert");
        _placeCrossingPair(queueBands, 1_000e18, anchor);
        _reachSettlementWindow(queueBands);

        // The step that used to be enough: spot back onto real liquidity, inside the band, anchor untouched.
        _walkTo(kBands, griefer, BAND_B_LOWER, 500_000e18);
        assertEq(_spotTick(kBands), BAND_B_LOWER, "premise: the step did not land on band B");
        assertEq(uint256(_spotLiquidity(kBands)), uint256(BAND_LIQ), "premise: spot is not standing on real depth");
        assertEq(hookBands.consult(kBands.toId(), TWAP_WINDOW), anchor, "premise: the step moved the anchor");
        assertLe(_absTick(_spotTick(kBands) - anchor), TWAP_BAND, "premise: the spot band would have refused anyway");

        uint256 qBal0 = _bal(currency0, address(queueBands));
        uint256 qBal1 = _bal(currency1, address(queueBands));

        vm.expectRevert(MoleQueue.InsufficientPoolDepth.selector);
        queueBands.settle(e);

        // Refusing wrote nothing and cost nobody anything, and the escape hatch still works.
        assertEq(uint8(queueBands.phaseOf(e)), uint8(MoleQueue.Phase.Frozen), "a refused settlement resolved the epoch");
        assertEq(_bal(currency0, address(queueBands)), qBal0, "escrow moved on a refused settlement");
        assertEq(_bal(currency1, address(queueBands)), qBal1, "escrow moved on a refused settlement");

        _advance(LIFE);
        queueBands.timeout(e);
        uint256 aliceBefore = _bal(currency0, alice);
        vm.prank(alice);
        queueBands.claim(e, 0);
        assertEq(_bal(currency0, alice) - aliceBefore, 1_000e18, "alice did not get her escrow back in kind");
    }
}
