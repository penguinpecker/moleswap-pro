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
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice ATTACKING THE CROSSING ARITHMETIC OF MoleQueue.settle.
///
/// WHY THIS FILE EXISTS AT A NON-ZERO TICK, and why the rest of the queue suite could not see any of it.
/// Every other queue world is built on a pool at tick 0, where `sqrtPriceX96` is exactly 2^96 and
/// `priceX96` is exactly Q96 — so `mulDiv(x, priceX96, Q96)` is the identity, no conversion ever leaves a
/// remainder, and the defect below is arithmetically invisible. The live WETH/USDG pool trades near tick
/// −200,000. This world sits at tick −20,040, which is the smallest displacement at which the bug's
/// consequences are unambiguous, and it reproduces the shape the live queue hit on 2026-08-07.
///
/// THE DEFECT. `settle` computed `want0 = floor(totalIn1 * Q96 / priceX96)` — how much currency0 the
/// currency1 side can buy — took `crossed0 = min(totalIn0, want0)`, and then converted BACK with
/// `crossed1 = floor(crossed0 * priceX96 / Q96)`. That second floor re-floors an already-floored number.
/// Whenever side 1 is fully absorbed (`crossed0 == want0`, which includes the perfectly balanced case) it
/// gives `crossed1 == totalIn1 - 1`, so the epoch comes out with a PHANTOM one-raw-unit residual on a side
/// that by definition had no remainder at all. That crumb is then submitted to the pool as a real
/// exact-input swap, where the LP fee truncates it to zero output, where it fails the residual bound, and
/// where the failure — inside the strict window — reverts the WHOLE settlement: the large legitimate
/// residual on the other side that had already cleared its own bound, and the crossed portion that needed
/// no pool at all. Anyone could force the shape with one dust order on the light side.
///
/// THE FIX, IN TWO PARTS, and each part has its own attack below:
///   (1) the fully absorbed side crosses IN FULL. The sub-unit remainder is part of the match — it is
///       worth strictly less than one raw unit of currency0, which is the granularity the two sides can
///       trade in — not a leftover to route through a pool.
///   (2) a residual the pool cannot execute never reaches the pool. Below `10_000 / maxResidualSlippageBps`
///       raw units on either leg, one unit of rounding already costs more than the entire residual budget,
///       so the swap cannot clear its own bound: it either reverts everyone's settlement or, where the
///       fair output floors to zero and takes the bound to zero with it, is burned in silence. It goes
///       back to its owners in kind instead.
///
/// TIME. `vm.warp(block.timestamp + d)` does NOT accumulate inside one call frame — solc caches
/// block.timestamp — so everything here moves an explicit `_clock` / `_height`.
contract AttackQueueCrossingMath is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------ config */

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;

    int24 internal constant MAX_TWAP_DEVIATION_TICKS = 600;

    /// @dev THE LIVE VALUE, deliberately. `maxResidualSlippageBps` is what sets the dust floor
    ///      (`10_000 / bps` = 34 raw units here), so a test world with a different bound would pin a
    ///      different boundary than the one deployed.
    uint16 internal constant RESIDUAL_SLIPPAGE_BPS = 300;

    /// @dev The dust floor the contract derives from the bound above, restated independently.
    uint256 internal constant DUST_FLOOR = 34; // ceil(10_000 / 300)

    /// @dev Deep enough that `priceX96 != Q96` by a wide margin: Q96/priceX96 ~= 7.4, so a ONE raw unit
    ///      residual on the currency1 side has a fair currency0 output of 7 — comfortably enough for the
    ///      residual bound to have teeth and to fire on a zero fill, which is the live failure.
    int24 internal constant TICK = -20_040;

    /// @dev A realistic chain timestamp: `consult` fails closed on `secondsAgo > block.timestamp`.
    uint256 internal constant T0 = 1_750_000_000;

    uint256 internal constant FUNDING = 100_000e18;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");
    address internal stranger = makeAddr("stranger");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;

    MockERC20 internal t0;
    MockERC20 internal t1;

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
            uint160(uint256(keccak256(abi.encode("attack-queue-crossing", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
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

    /// @dev Swaps spaced beyond `OBS_INTERVAL` so the ring advances, then a quiet stretch longer than the
    ///      window so the TWAP equals the current tick and the deviation band reads ~zero drift. The sizes
    ///      are tiny relative to the liquidity, so the warm-up cannot walk the price off the opening tick.
    function _warmOracleOn(PoolKey memory k) internal {
        _advance(90);
        _swapOn(k, true, 1e16);
        _advance(90);
        _swapOn(k, false, 1e15);
        _advance(90);
        _swapOn(k, true, 1e16);
        _advance(TWAP_WINDOW + 120);
    }

    /// @dev A pool on the shared hook, opened at `tick`, deep and spanning it on both sides, with its own
    ///      warmed oracle ring and its own queue. A different tickSpacing gives a different PoolId, so two
    ///      worlds in this file cannot disturb each other's anchor.
    function _world(int24 spacing, int24 tick, int24 lower, int24 upper)
        internal
        returns (PoolKey memory k, MoleQueue q)
    {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(hook))
        });
        manager.initialize(k, TickMath.getSqrtPriceAtTick(tick));
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(200_000e18), salt: 0}),
            ZERO_BYTES
        );
        _warmOracleOn(k);
        q = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            k,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );
    }

    function _approveFor(address who, MoleQueue q) internal {
        vm.startPrank(who);
        t0.approve(address(q), type(uint256).max);
        t1.approve(address(q), type(uint256).max);
        vm.stopPrank();
    }

    function _fund(address who) internal {
        t0.transfer(who, FUNDING);
        t1.transfer(who, FUNDING);
        vm.startPrank(who);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    function _placeOn(MoleQueue q, address who, bool zeroForOne, uint128 amount) internal returns (uint256 idx) {
        vm.prank(who);
        idx = q.place(zeroForOne, amount);
    }

    function _place(address who, bool zeroForOne, uint128 amount) internal returns (uint256 idx) {
        return _placeOn(queue, who, zeroForOne, amount);
    }

    function _claimOn(MoleQueue q, address who, uint64 e, uint256 index) internal returns (uint256) {
        vm.prank(who);
        return q.claim(e, index);
    }

    function _claim(address who, uint64 e, uint256 index) internal returns (uint256) {
        return _claimOn(queue, who, e, index);
    }

    function _epochOf(MoleQueue q, uint64 e)
        internal
        view
        returns (
            MoleQueue.Phase phase,
            uint64 frozenAt,
            uint128 in0,
            uint128 in1,
            uint128 out0,
            uint128 out1,
            uint128 refund0,
            uint128 refund1
        )
    {
        (phase, frozenAt, in0, in1, out0, out1, refund0, refund1) = q.epochs(e);
    }

    function _epoch(uint64 e)
        internal
        view
        returns (
            MoleQueue.Phase phase,
            uint64 frozenAt,
            uint128 in0,
            uint128 in1,
            uint128 out0,
            uint128 out1,
            uint128 refund0,
            uint128 refund1
        )
    {
        (phase, frozenAt, in0, in1, out0, out1, refund0, refund1) = _epochOf(queue, e);
    }

    /// @dev The anchor `settle` will read, computed the same way `settle` computes it.
    function _twapPriceX96Of(PoolKey memory k) internal view returns (uint256 priceX96, int24 tick) {
        tick = hook.consult(k.toId(), TWAP_WINDOW);
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
    }

    function _twapPriceX96() internal view returns (uint256 priceX96, int24 tick) {
        return _twapPriceX96Of(poolKey);
    }

    /// @dev Drive an epoch to Settled inside the STRICT window — never the lenient path, so a settlement
    ///      here is a settlement the contract was willing to make while it still had a choice.
    function _freezeAndSettleStrictOn(MoleQueue q, uint64 e) internal {
        _advance(EPOCH_DURATION);
        q.freeze();
        _advance(FREEZE_DURATION);
        (, uint64 frozenAt,,,,,,) = _epochOf(q, e);
        assertLt(_clock, uint256(frozenAt) + MAX_EPOCH_LIFE, "premise: this must be the STRICT window");
        vm.prank(stranger);
        q.settle(e);
    }

    function _freezeAndSettleStrict(uint64 e) internal {
        _freezeAndSettleStrictOn(queue, e);
    }

    /// @dev What the queue owes for epoch `e`, per currency, read from the epoch record.
    function _owedOn(MoleQueue q, uint64 e) internal view returns (uint256 owe0, uint256 owe1) {
        (,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = _epochOf(q, e);
        owe0 = uint256(out1) + refund0; // currency0: the side-1 sellers' fill, plus side 0's in-kind leg
        owe1 = uint256(out0) + refund1; // currency1: the side-0 sellers' fill, plus side 1's in-kind leg
    }

    /// @dev CONSERVATION, BOTH WAYS: what the contract holds is exactly what it has booked itself to pay,
    ///      summed over every epoch still unclaimed, in each currency, with nothing over and nothing short.
    ///      Measured after settlement and before any claim, so it is the settlement's own arithmetic under
    ///      test and not the claim rounding.
    function _assertConservedOn(MoleQueue q, uint64 upToEpoch, string memory what) internal view {
        uint256 owe0;
        uint256 owe1;
        for (uint64 e = 0; e <= upToEpoch; e++) {
            (uint256 a, uint256 b) = _owedOn(q, e);
            owe0 += a;
            owe1 += b;
        }
        assertEq(t0.balanceOf(address(q)), owe0, string.concat(what, ": currency0 held != currency0 owed"));
        assertEq(t1.balanceOf(address(q)), owe1, string.concat(what, ": currency1 held != currency1 owed"));
    }

    function _assertConserved(uint64 e, string memory what) internal view {
        _assertConservedOn(queue, e, what);
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

        // Deep, and spanning the tick on both sides: every residual in this file must be able to fill
        // COMPLETELY and well inside the 300 bps bound, so that a settlement failing here can only be the
        // crossing arithmetic and never the pool's depth.
        (poolKey, queue) = _world(60, TICK, -60_000, 0);

        _fund(alice);
        _fund(carol);
        _fund(mallory);
        _fund(stranger);

        // The premise of the whole file: this pool is NOT at tick 0, so the two conversions are not the
        // identity and a re-floor actually loses something.
        (uint256 priceX96,) = _twapPriceX96();
        assertTrue(priceX96 != FixedPoint96.Q96, "premise: a tick-0 world cannot see any of this");
    }

    /* ================================================================================
       1.  THE PHANTOM RESIDUAL — the live 2026-08-07 revert, replayed.
       ============================================================================= */

    /// @notice ATTACK, and no attacker is needed: an ordinary currency0-heavy batch. Under the old
    ///         arithmetic the currency1 side — which is fully absorbed, and therefore by definition has
    ///         nothing left over — came out of `settle` owing a ONE RAW UNIT residual, that unit was
    ///         offered to the pool, the LP fee truncated it to zero output, the residual bound fired on
    ///         the zero fill, and the entire settlement reverted for the whole strict window. The premise
    ///         block below asserts BOTH halves of that arithmetically, against this exact epoch, so the
    ///         test is evidence about the defect and not merely a green settlement.
    ///
    ///         MUTATION: restore the old line — `crossed1 = uint128(FullMath.mulDiv(crossed0, priceX96,
    ///         FixedPoint96.Q96));` in place of the `crossed1 = crossed0 == 0 ? 0 : ep.totalIn1;` branch
    ///         -> `settle` reverts `ResidualSwapTooFarFromTwap` -> RED.
    function test_caseB_thePhantomOneUnitResidualNoLongerRevertsTheStrictSettlement() public {
        (uint256 priceX96,) = _twapPriceX96();

        uint128 side1 = 100e18;
        uint256 want0 = FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96);
        uint128 side0 = uint128(want0 + 500e18); // heavier: a real, large, perfectly swappable residual

        // PREMISE (a): this epoch has the poisoned shape. The old second floor loses exactly one raw unit
        // of the side that is fully absorbed.
        uint256 oldCrossed1 = FullMath.mulDiv(want0, priceX96, FixedPoint96.Q96);
        assertEq(uint256(side1) - oldCrossed1, 1, "premise: the old math must leave exactly a 1-unit phantom");

        // PREMISE (b): that crumb could not have survived the pool. Its fair output is 7 raw units, the
        // bound demands 6 of them, and an exact-input swap of ONE unit at a 0.30% LP fee returns zero.
        uint256 fair0 = FullMath.mulDiv(1, FixedPoint96.Q96, priceX96);
        uint256 minOut0 = FullMath.mulDiv(fair0, 10_000 - RESIDUAL_SLIPPAGE_BPS, 10_000);
        assertGt(minOut0, 0, "premise: the bound must have teeth against the phantom unit");
        assertEq((uint256(1) * (1e6 - LP_FEE)) / 1e6, 0, "premise: the LP fee truncates a 1-unit input to nothing");

        uint256 iA = _place(alice, true, side0);
        uint256 iC = _place(carol, false, side1);

        uint256 mgr1Before = t1.balanceOf(address(manager));

        // THE FIX: it settles, inside the strict window, on the first attempt.
        _freezeAndSettleStrict(0);

        (MoleQueue.Phase ph,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "the batch did not settle in the strict window");

        // The fully absorbed side crossed IN FULL: no phantom, no in-kind leg, and carol is paid exactly
        // what her escrow buys at the anchor.
        assertEq(refund1, 0, "the fully absorbed side was left owing a residual");
        assertEq(out1, uint128(want0), "the currency1 side was not paid the whole cross");

        // And not one raw unit of currency1 was handed to the pool. `out0 - side1` is the currency1 the
        // pool paid for the currency0 residual; anything beyond that would be escrow flowing the wrong way.
        assertEq(
            mgr1Before - t1.balanceOf(address(manager)),
            uint256(out0) - side1,
            "currency1 escrow was handed to the pool on a batch whose currency1 side crossed in full"
        );
        assertGt(out0, side1, "premise: the large currency0 residual really did execute");
        assertEq(refund0, 0, "the large residual was refunded instead of swapped");

        _assertConserved(0, "case B");

        // Both sides get paid, and the queue keeps nothing but claim's own rounding.
        _claim(alice, 0, iA);
        _claim(carol, 0, iC);
        assertLe(t0.balanceOf(address(queue)), 1, "currency0 stranded after every claim");
        assertLe(t1.balanceOf(address(queue)), 1, "currency1 stranded after every claim");
    }

    /// @notice THE WEAPONISED FORM. The audit's amplification: the shape is free to manufacture, so ONE
    ///         raw unit of currency1 on the light side of an otherwise one-sided currency0 batch used to
    ///         deny settlement to the whole thing for the price of gas — the single unit is enough to make
    ///         side 1 "fully absorbed", which is the branch the second floor corrupted. Mallory pays one
    ///         raw unit and an hour of her own escrow; alice's 500e18 is the hostage.
    ///
    ///         MUTATION: restore the old `crossed1` line -> mallory's single unit re-creates the phantom,
    ///         the settle reverts `ResidualSwapTooFarFromTwap`, and the batch is denied for the whole
    ///         strict window -> RED.
    function test_grief_oneDustOrderOnTheLightSideNoLongerDeniesTheWholeBatch() public {
        (uint256 priceX96,) = _twapPriceX96();
        uint256 want0 = FullMath.mulDiv(uint256(1), FixedPoint96.Q96, priceX96);

        // PREMISE: one raw unit of currency1 is enough to make side 1 the fully absorbed side, and the old
        // math would have handed that side back a residual of exactly the unit it just crossed in full.
        assertGt(want0, 0, "premise: one unit of currency1 must buy at least one unit of currency0");
        assertEq(FullMath.mulDiv(want0, priceX96, FixedPoint96.Q96), 0, "premise: the old math loses the whole unit");

        uint256 iA = _place(alice, true, 500e18);
        uint256 iM = _place(mallory, false, 1); // one raw unit, the entire cost of the attack

        _freezeAndSettleStrict(0);

        (MoleQueue.Phase ph,,,,, uint128 out1, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "one dust order denied the whole batch");
        assertEq(refund0, 0, "alice's residual was refunded rather than executed");
        assertEq(refund1, 0, "the fully absorbed side was left owing a residual");
        assertEq(uint256(out1), want0, "mallory's unit did not cross in full");

        _assertConserved(0, "dust grief");

        uint256 a1Before = t1.balanceOf(alice);
        _claim(alice, 0, iA);
        _claim(mallory, 0, iM);
        assertGt(t1.balanceOf(alice), a1Before, "alice's batch paid her nothing after the grief attempt");
    }

    /// @notice THE EXACTLY BALANCED CASE, at a non-zero tick — the one the tick-0 worlds cannot express.
    ///         When `totalIn0 == want0` exactly, nothing is left over on either side and the pool must not
    ///         be touched at all: not "a small swap", none. The old second floor manufactured a one-unit
    ///         residual out of a perfect match and sent it to the pool, which then reverted the whole
    ///         settlement.
    ///
    ///         MUTATION: restore the old `crossed1` line -> the pool is unlocked for a 1-unit swap and the
    ///         settle reverts -> RED.
    function test_balanced_aPerfectMatchAtANonZeroTickNeverTouchesThePool() public {
        (uint256 priceX96,) = _twapPriceX96();
        uint128 side1 = 100e18;
        uint128 side0 = uint128(FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96)); // exactly want0

        uint256 iA = _place(alice, true, side0);
        uint256 iC = _place(carol, false, side1);

        uint256 mgr0Before = t0.balanceOf(address(manager));
        uint256 mgr1Before = t1.balanceOf(address(manager));
        uint160 sqrtBefore = _sqrtNow();

        _freezeAndSettleStrict(0);

        uint160 sqrtAfter = _sqrtNow();
        assertEq(sqrtAfter, sqrtBefore, "the pool moved on a perfectly matched batch");
        assertEq(t0.balanceOf(address(manager)), mgr0Before, "currency0 moved in or out of the PoolManager");
        assertEq(t1.balanceOf(address(manager)), mgr1Before, "currency1 moved in or out of the PoolManager");

        (,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(out0, side1, "the two sides did not simply swap escrows");
        assertEq(out1, side0, "the two sides did not simply swap escrows");
        assertEq(uint256(refund0) + refund1, 0, "a perfect match booked an in-kind refund");
        _assertConserved(0, "balanced");

        assertEq(_claim(alice, 0, iA), side1, "alice was not paid the whole cross");
        assertEq(_claim(carol, 0, iC), side0, "carol was not paid the whole cross");
        assertEq(t0.balanceOf(address(queue)), 0, "currency0 stranded after a perfect match");
        assertEq(t1.balanceOf(address(queue)), 0, "currency1 stranded after a perfect match");
    }

    /* ================================================================================
       2.  THE DUST FLOOR — a residual the pool cannot execute never reaches the pool.
       ============================================================================= */

    /// @notice ATTACK: the case-A tail. Side 1 is heavier than side 0 can absorb by a single raw unit, so
    ///         a genuine — not phantom — one-unit residual is left on the currency1 side. Offering it to
    ///         the pool is the same shredder: the LP fee truncates the input to nothing, the bound fires on
    ///         the zero fill, and the whole settlement reverts for everybody, including the crossed part.
    ///         It comes back in kind instead, and the batch settles.
    ///
    ///         MUTATION: `_splitResidual` returns `(amountIn, 0)` unconditionally (delete the floor) ->
    ///         the one-unit residual is routed to the pool -> `settle` reverts `ResidualSwapTooFarFromTwap`
    ///         -> RED.
    function test_dust_aGenuineOneUnitRemainderComesBackInKindInsteadOfRevertingEveryone() public {
        (uint256 priceX96,) = _twapPriceX96();

        uint128 side0 = 400e18;
        uint128 crossed1 = uint128(FullMath.mulDiv(side0, priceX96, FixedPoint96.Q96));
        uint128 side1 = crossed1 + 1; // one raw unit more than side 0 can absorb

        // PREMISE: this really is case A — the lighter side is side 0 — and the remainder really is 1.
        assertLt(uint256(side0), FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96), "premise: side 0 must be lighter");

        uint256 iA = _place(alice, true, side0);
        uint256 iC = _place(carol, false, side1);

        uint256 mgr0Before = t0.balanceOf(address(manager));
        uint256 mgr1Before = t1.balanceOf(address(manager));

        _freezeAndSettleStrict(0);

        (MoleQueue.Phase ph,,,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(uint8(ph), uint8(MoleQueue.Phase.Settled), "a one-unit remainder denied the whole batch");
        assertEq(refund1, 1, "the unexecutable remainder was not booked back in kind");
        assertEq(refund0, 0, "the fully crossed side must have nothing to refund");
        assertEq(out0, crossed1, "the currency0 side was not paid the whole cross");
        assertEq(out1, side0, "the currency1 side was not paid the whole cross");

        // NOTHING went to the pool: with the only residual under the floor there is no leg left to swap,
        // so `settle` never unlocks at all.
        assertEq(t0.balanceOf(address(manager)), mgr0Before, "currency0 reached the pool");
        assertEq(t1.balanceOf(address(manager)), mgr1Before, "the dust remainder was handed to the pool anyway");
        _assertConserved(0, "case A dust");

        uint256 c1Before = t1.balanceOf(carol);
        _claim(alice, 0, iA);
        _claim(carol, 0, iC);
        assertEq(t1.balanceOf(carol), c1Before + 1, "carol did not get her unexecutable unit back");
    }

    /// @notice THE BOUNDARY, pinned on both sides. The floor is not a taste: it is `10_000 / bps`, the
    ///         point at which ONE raw unit of rounding costs the residual's entire slippage budget. One
    ///         unit below it the remainder is returned in kind; AT it the remainder is offered to the pool
    ///         like any other residual. Both arms run from the same world, so the only difference between
    ///         them is the one raw unit.
    ///
    ///         MUTATION: change the floor to `10_000 / maxResidualSlippageBps + 1` (move it by one) ->
    ///         the second arm books an in-kind refund instead of swapping -> RED.
    function test_dust_theBoundaryIsTheResidualBoundsOwnArithmetic() public {
        (uint256 priceX96,) = _twapPriceX96();
        uint128 side0 = 400e18;
        uint128 crossed1 = uint128(FullMath.mulDiv(side0, priceX96, FixedPoint96.Q96));

        // Arm A: one unit BELOW the floor -> in kind, pool untouched.
        _place(alice, true, side0);
        _place(carol, false, crossed1 + uint128(DUST_FLOOR - 1));
        uint256 mgr1Before = t1.balanceOf(address(manager));
        _freezeAndSettleStrict(0);
        (,,,,,,, uint128 refundA) = _epoch(0);
        assertEq(uint256(refundA), DUST_FLOOR - 1, "one unit below the floor was not returned in kind");
        assertEq(t1.balanceOf(address(manager)), mgr1Before, "one unit below the floor still reached the pool");
        _assertConserved(0, "boundary arm A");

        // Arm B: exactly AT the floor -> routed to the pool like any other residual. Epoch 1 is a fresh
        // batch in the same world, so nothing but the single extra raw unit differs.
        _place(alice, true, side0);
        _place(carol, false, crossed1 + uint128(DUST_FLOOR));
        mgr1Before = t1.balanceOf(address(manager));
        _freezeAndSettleStrict(1);
        (,,,,,,, uint128 refundB) = _epoch(1);
        assertEq(refundB, 0, "a residual at the floor was withheld from the pool");
        assertEq(
            t1.balanceOf(address(manager)) - mgr1Before, DUST_FLOOR, "the floor-sized residual was not sent to the pool"
        );
        _assertConserved(1, "boundary arm B");
    }

    /// @notice ATTACK: the SILENT half — no revert, just missing money. Where a residual is worth less
    ///         than one raw unit of the token it is being sold for, its fair output floors to zero, and so
    ///         does the proportional bound that is supposed to protect it: `out >= 0` passes for any fill
    ///         including none at all. The pool then consumes the input, returns nothing, and the units are
    ///         gone out of the sellers' escrow with no error anywhere. This is the mirrored-decimals case
    ///         in the audit; here it lands on the currency0 residual, because one raw unit of currency0 is
    ///         worth ~0.13 raw units of currency1 at this anchor.
    ///
    ///         MUTATION: delete the `fairOut < floorUnits` half of the floor (keep the amountIn half) ->
    ///         the five units are handed to the pool and burned, `refund0` is 0 and the queue's currency0
    ///         balance is five short of what it owes -> RED.
    function test_dust_aResidualWorthLessThanOneUnitOfTheOtherTokenIsNoLongerBurnedInThePool() public {
        (uint256 priceX96,) = _twapPriceX96();
        uint128 side1 = 100e18;
        uint128 want0 = uint128(FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96));
        uint128 side0 = want0 + 5;

        // PREMISE: five raw units of currency0 are worth zero raw units of currency1 here, so the bound
        // that guards this leg is vacuous — it would wave a total loss through.
        assertEq(FullMath.mulDiv(uint256(5), priceX96, FixedPoint96.Q96), 0, "premise: the fair output must floor to 0");

        uint256 iA = _place(alice, true, side0);
        _place(carol, false, side1);

        uint256 mgr0Before = t0.balanceOf(address(manager));
        _freezeAndSettleStrict(0);

        (,,,,,, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(refund0, 5, "the unsellable five units were not booked back in kind");
        assertEq(refund1, 0, "the fully absorbed side was left owing a residual");
        assertEq(t0.balanceOf(address(manager)), mgr0Before, "the unsellable units were handed to the pool anyway");
        _assertConserved(0, "mechanism D");

        uint256 a0Before = t0.balanceOf(alice);
        _claim(alice, 0, iA);
        assertEq(t0.balanceOf(alice), a0Before + 5, "alice's unsellable units were not returned to her");
    }

    /// @notice The OTHER half of the floor, isolated. A residual can be far above the input floor and
    ///         still be worth nothing: in a world where one raw unit of currency0 buys ~0.018 raw units of
    ///         currency1, forty units of currency0 have a fair output of ZERO. `minOut` is then zero too,
    ///         so `out >= 0` accepts a fill of nothing — the bound cannot express any tolerance at all at
    ///         that granularity, and the pool keeps the input. The input half of the floor does not catch
    ///         this case, which is why the floor tests BOTH legs; the premise below asserts exactly that
    ///         separation, so this test can only be green because of the fair-output half.
    ///
    ///         MUTATION: drop the `fairOut < floorUnits` half of the floor -> the forty units are handed
    ///         to the pool, the vacuous bound waves the zero fill through, and they are gone -> RED.
    function test_dust_aResidualAboveTheInputFloorButWorthNothingIsWithheldToo() public {
        // Deeper than the primary world on purpose: the two halves of the floor only separate where the
        // two currencies are far apart in value per raw unit.
        (PoolKey memory deep, MoleQueue q) = _world(10, -40_020, -60_000, -20_000);
        _approveFor(alice, q);
        _approveFor(carol, q);

        (uint256 priceX96,) = _twapPriceX96Of(deep);
        uint128 side1 = 100e18;
        uint128 want0 = uint128(FullMath.mulDiv(side1, FixedPoint96.Q96, priceX96));
        uint128 residual0 = uint128(DUST_FLOOR) + 6;
        uint128 side0 = want0 + residual0;

        // PREMISE: the input half lets this through, and the bound that would then have to protect it is
        // vacuous — a fill of nothing satisfies it.
        assertGe(uint256(residual0), DUST_FLOOR, "premise: the input half of the floor must NOT catch this");
        assertEq(
            FullMath.mulDiv(residual0, priceX96, FixedPoint96.Q96), 0, "premise: the fair output must floor to zero"
        );

        uint256 iA = _placeOn(q, alice, true, side0);
        _placeOn(q, carol, false, side1);

        uint256 mgr0Before = t0.balanceOf(address(manager));
        _freezeAndSettleStrictOn(q, 0);

        (,,,,,, uint128 refund0, uint128 refund1) = _epochOf(q, 0);
        assertEq(refund0, residual0, "a residual with no expressible bound was not returned in kind");
        assertEq(refund1, 0, "the fully absorbed side was left owing a residual");
        assertEq(t0.balanceOf(address(manager)), mgr0Before, "the worthless residual was handed to the pool anyway");
        _assertConservedOn(q, 0, "vacuous bound");

        uint256 a0Before = t0.balanceOf(alice);
        _claimOn(q, alice, 0, iA);
        assertEq(t0.balanceOf(alice), a0Before + residual0, "alice's units were not returned to her");
    }

    /* ================================================================================
       3.  CONSERVATION IN EVERY BRANCH — including the two degenerate ones.
       ============================================================================= */

    /// @notice `totalIn1 == 0`: nothing to cross, the whole currency0 escrow is the residual, and it goes
    ///         through the pool as one swap. The branch that computes the cross must not credit anybody
    ///         with anything on the way past.
    function test_conservation_oneSidedCurrencyZeroEpoch() public {
        uint256 iA = _place(alice, true, 300e18);
        _freezeAndSettleStrict(0);

        (,, uint128 in0, uint128 in1, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(in1, 0, "premise: there is no currency1 side");
        assertEq(out1, 0, "a side that escrowed nothing was credited with something");
        assertEq(uint256(refund0) + refund1, 0, "a swappable one-sided residual was refunded");
        assertGt(out0, 0, "the one-sided batch settled to nothing");
        assertEq(in0, 300e18, "escrow wrong");
        _assertConserved(0, "one-sided currency0");

        _claim(alice, 0, iA);
        assertLe(t1.balanceOf(address(queue)), 1, "output stranded in the queue");
    }

    /// @notice `totalIn0 == 0`: the mirror. `want0` is non-zero and `crossed0` is zero, so the whole
    ///         currency1 escrow is the residual — the branch must NOT read that as "side 1 fully absorbed"
    ///         and hand the escrow over for nothing.
    function test_conservation_oneSidedCurrencyOneEpoch() public {
        uint256 iC = _place(carol, false, 40e18);
        _freezeAndSettleStrict(0);

        (,, uint128 in0,, uint128 out0, uint128 out1, uint128 refund0, uint128 refund1) = _epoch(0);
        assertEq(in0, 0, "premise: there is no currency0 side");
        assertEq(out0, 0, "a side that escrowed nothing was credited with something");
        assertEq(uint256(refund0) + refund1, 0, "a swappable one-sided residual was refunded");
        assertGt(out1, 0, "the one-sided batch settled to nothing");
        _assertConserved(0, "one-sided currency1");

        _claim(carol, 0, iC);
        assertLe(t0.balanceOf(address(queue)), 1, "output stranded in the queue");
    }

    /// @notice THE TRAP IN THE NAIVE FIX, in the MIRRORED world. "Side 1 is fully absorbed, so cross it in
    ///         full" is right whenever there is a match to be part of — and catastrophically wrong when
    ///         there is not. Where one raw unit of currency0 costs ~7 raw units of currency1, a currency1
    ///         escrow of 1..7 units buys ZERO units of currency0: `want0` floors to nothing, so `crossed0`
    ///         is zero. Crossing `crossed1 = totalIn1` there would hand the whole escrow to the currency0
    ///         side in exchange for nothing at all, and since the epoch also books it no refund, it would
    ///         be unreachable by any exit for ever. This is checked from the only angle a victim would see
    ///         it: her money comes back.
    ///
    ///         This needs the second, mirrored world — the primary pool sits the other way up, where one
    ///         unit of currency1 buys seven of currency0 and `want0` can never floor to zero.
    ///
    ///         MUTATION: `crossed1 = ep.totalIn1;` (drop the `crossed0 == 0` guard) -> mallory's escrow is
    ///         credited to the currency0 side, she is paid nothing and refunded nothing -> RED.
    function test_conservation_aSubUnitCurrencyOneEscrowIsNotCrossedForNothing() public {
        (PoolKey memory mirror, MoleQueue q) = _world(20, -TICK, 0, 60_000);
        _approveFor(alice, q);
        _approveFor(mallory, q);

        (uint256 priceX96,) = _twapPriceX96Of(mirror);
        assertEq(
            FullMath.mulDiv(uint256(5), FixedPoint96.Q96, priceX96), 0, "premise: five units must buy nothing here"
        );

        uint256 iA = _placeOn(q, alice, true, 300e18);
        uint256 iM = _placeOn(q, mallory, false, 5);

        uint256 m1Before = t1.balanceOf(mallory);
        _freezeAndSettleStrictOn(q, 0);

        (,,,,, uint128 out1,, uint128 refund1) = _epochOf(q, 0);
        assertEq(out1, 0, "a sub-unit escrow was credited with a cross it cannot buy");
        assertEq(refund1, 5, "a sub-unit escrow was not returned in kind");
        _assertConservedOn(q, 0, "sub-unit side 1");

        _claimOn(q, alice, 0, iA);
        _claimOn(q, mallory, 0, iM);
        assertEq(t1.balanceOf(mallory), m1Before + 5, "mallory's escrow was crossed away for nothing");
    }

    /// @notice THE SAME TRAP, IN THE OTHER DIRECTION — and this branch has no guard.
    ///
    ///         `settle`'s crossing has two branches. When side 1 is fully absorbed it takes the
    ///         `crossed0 == 0 ? 0 : ep.totalIn1` branch, whose guard the test above proves. When side 0 is
    ///         fully absorbed it takes `crossed1 = floor(crossed0 * priceX96 / Q96)` — and that floor
    ///         reaches ZERO on exactly the mirrored condition: a currency0 escrow worth less than one raw
    ///         unit of currency1. In this world one raw unit of currency1 costs ~7 raw units of currency0,
    ///         so a currency0 escrow of 1..7 units buys NOTHING.
    ///
    ///         The consequence is the one the sibling guard exists to refuse, with the currencies swapped:
    ///         `crossed0 = totalIn0` is credited to the currency1 side as `out1`, `crossed1 = 0` so the
    ///         currency0 side is credited nothing, and `residual0 = totalIn0 - crossed0 = 0` so no in-kind
    ///         refund is booked either. `claim` marks the order withdrawn and pays zero.
    ///
    ///         MUTATION: adding the mirrored guard (`crossed1 == 0 -> cross nothing`) turns this GREEN;
    ///         removing it again turns it RED. It is the only test in the suite that reaches this branch.
    function test_conservation_aSubUnitCurrencyZeroEscrowIsNotCrossedForNothing() public {
        (uint256 priceX96,) = _twapPriceX96();
        assertEq(
            FullMath.mulDiv(uint256(7), priceX96, FixedPoint96.Q96), 0, "premise: seven units must buy nothing here"
        );

        uint256 iA = _place(alice, false, 300e18);
        uint256 iM = _place(mallory, true, 7);

        uint256 m0Before = t0.balanceOf(mallory);
        _freezeAndSettleStrict(0);

        (,,,, uint128 out0,, uint128 refund0,) = _epoch(0);
        emit log_named_uint("out0    (currency1 owed to the currency0 side)", out0);
        emit log_named_uint("refund0 (currency0 booked back in kind)      ", refund0);
        assertEq(out0, 0, "premise: a sub-unit escrow cannot be credited with a cross it cannot buy");
        assertEq(refund0, 7, "a sub-unit currency0 escrow was not returned in kind");
        _assertConserved(0, "sub-unit side 0");

        _claim(alice, 0, iA);
        _claim(mallory, 0, iM);
        assertEq(t0.balanceOf(mallory), m0Before + 7, "mallory's escrow was crossed away for nothing");
    }

    /* ------------------------------------------------------------------ internals */

    function _sqrtNow() internal view returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96,,,) = StateLibrary.getSlot0(manager, poolKey.toId());
    }
}
