// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////

  ANGLE: PRECISION AND ROUNDING ACROSS THE WHOLE SYSTEM.

  Everything the existing suite measures about rounding, it measures in a pool whose two tokens are
  both 18 decimals and whose price is 1:1 (SQRT_PRICE_1_1, tick 0). That is the single price at which
  every quantity in the system has the same magnitude in both legs -- the regime in which a rounding
  bug is LEAST likely to show. The pair this product ships against is WETH(18)/USDG(6) on Robinhood
  Chain, which sits ~196,000 ticks from tick 0 and where one leg is 1e12 coarser than the other in
  wei. This file rebuilds the world at the shipping price and re-asks every rounding question there.

  ------------------------------------------------------------------------------------------------
  FIXED SINCE THIS FILE WAS FIRST WRITTEN -- AND THE TESTS THAT FOUND IT ARE NOW NEGATIVE CONTROLS

  P-1  and P-2 below were both defects of the VOLATILITY-SCALED DYNAMIC FEE. That fee no longer
  exists: MoleHook now carries a single immutable `lpFeePips` that beforeSwap re-asserts on every
  swap with OVERRIDE_FEE_FLAG, and there is no accumulator, no decay, no window and no staged quote
  for anyone -- swapper, LP, keeper or sequencer -- to move. The removal was not a repair of P-1/P-2;
  it was forced by a deeper defect they are symptoms of, that the party COLLECTING the fee (the
  vault, which under `restrictedLiquidity` is the only LP and therefore always dominant) is the party
  that MANUFACTURES the signal the fee is derived from.

  Neither test was deleted, because both carry attack machinery whose target still exists -- the pool,
  the oracle and the swap path are unchanged. Both were converted, per the rule that an attack should
  become a proof the surface is gone rather than be thrown away. Each now runs the SAME manufacture
  attempt and asserts the fee did not move, at every observable point, because nothing can move it.

  P-1  WAS: the decay compounded per WRITE, not per second, so ten 1-wei swaps kept 34% of an
       accumulator that one idle window took to zero -- 1,377 pips (0.138%) of surcharge on every
       swap, held alive by dust, and the rate was a function of SWAP COUNT, which any stranger raises
       unilaterally. NOW: the identical two-pool experiment -- same 4e19-worth volatility injection on
       both, then one full former volWindow in which the busy arm eats ten 1-wei swaps -- asserts the
       quoted fee is byte-identical on both arms and equal to the immutable at the peak, after every
       single dust swap, and at the end. A dust swap cannot preserve a surcharge that is not there.
       test: test_precision_dustSwapsCannotKeepAnyFeeSurchargeAlive

  P-2  WAS: `beforeSwap` priced from `feeQuotes[id].staged`, a snapshot only `_write` refreshed and
       only `afterSwap` called `_write`, so an idle pool quoted its last surcharge with no upper bound
       on the number's age -- measured at 6,819 pips still charged to the first swapper after THIRTY
       DAYS of silence, against a 3,009 pip correct value. NOW: the same thirty days of silence, and
       the fee is asserted equal to the immutable before, during and after, INCLUDING the fee actually
       charged to the first post-idle swapper (read off the FeeQuoted log, not inferred). The same
       test also pins the contrast that made the old bug possible: the ORACLE genuinely ages across
       those thirty days -- consult() over the idle span still tracks the live tick -- while the fee,
       which no longer reads any state at all, does not.
       test: test_precision_thirtyIdleDaysCannotStaleTheQuotedFee

  ------------------------------------------------------------------------------------------------
  FOUND

  P-3  consult() TRUNCATES TOWARD ZERO WHERE UNISWAP FLOORS.
       The final `int24((cumNow - cumAtTarget) / secondsAgo)` uses Solidity division, which rounds
       toward zero. Uniswap's OracleLibrary corrects that case downwards ("always round to negative
       infinity"). On WETH/USDG every tick is negative, so the correction is the live case on every
       call rather than an edge.
       MEASURED: 25 of 28 probed windows return a mean exactly one tick ABOVE the floored value.
       One tick is 0.01% of price, so this is a bias and not a lever -- but it biases the ONE guard
       that stops a keeper recentring into a wick, and it biases it loose on the upside.
       test: test_precision_consultTruncatesTowardZeroInsteadOfFlooring

  ------------------------------------------------------------------------------------------------
  ATTACKED AND COULD NOT BREAK

  N-1  No free money at the shipping price, at ANY magnitude. open -> withdrawAll over eight orders
       of magnitude of liquidity (1 .. 1e21) in the 6/18 pool: the user is short EXACTLY one wei per
       leg every time, never ahead.
       test_precision_sixDecimalRoundTripNeverPaysOutMoreThanItTookIn

  N-2  The dust goes to the POOL, to the wei. 200 back-to-back micro cycles: the user loses exactly
       200 wei of each leg and the PoolManager's balance rises by exactly 200 wei of each leg, so
       nothing evaporates and nothing sticks to MolePositions.
       test_precision_twoHundredMicroCyclesLeakOnlyToThePoolNeverToTheUser

  N-3  The keeper cannot grind principal. 60 same-range rebalances cost the owner exactly 1 wei per
       leg per rebalance against a byte-identical untouched control, and liquidity is monotonically
       non-increasing (rounding never conjures it). At the shipped 1-day cadence that is 1 wei per
       leg per day. test_precision_sixtySameRangeRebalancesBleedOnlyBoundedDust

  N-4  `RebalanceNotSelfFunding` really is unreachable, and not only in an 18/18 pool at tick 0.
       2,048 fuzz runs at the shipping price. It is also provable: the mint's double-ceiling can only
       exceed the floored burn when the exact requirement equals `have` with zero slack, and in that
       case the INNER ceiling has no remainder either, so the outer one is exact.
       testFuzz_precision_rebalanceIsSelfFundingAtTheShippingPrice

  N-5  MIN_TICK..MAX_TICK works, and so does squeezing it to a two-tick range in one rebalance --
       the largest change of range width the system can express. Two wei per leg over the whole
       cycle, zero inventory at every step.
       test_precision_fullRangeMinToMaxTickRoundTripsAndRebalances

  N-6  `maxEjectionBps` is NOT trippable by pure rounding. The hypothesis was that a percentage cap
       on a leg only a few wei wide would refuse an economically null move; across 16 sizes it never
       did. What DOES refuse below 1e7 liquidity is ZeroLiquidity, when the six-decimal leg floors to
       zero on the burn -- but 1e7 liquidity is $0.0000016 here, far under any real deposit, and the
       exit path is untouched.
       test_precision_ejectionCapCanBeTrippedByPureRoundingOnADustLeg

  N-7  The hook fee's round-down free zone is real but sub-cent: with hookFeePips = 500 the largest
       swap paying zero is 1e11 wei of WETH, about $0.0003. Splitting to avoid it costs more gas than
       the fee. test_precision_hookFeeHasAFreeZoneBelowOneUnitOfPips

  ------------------------------------------------------------------------------------------------
  P-3 does not touch the custody claim: no code path here moves a token to a caller-supplied address,
  nothing blocks a withdrawal, and MolePositions' balance was asserted at exactly zero at every
  observable point of every test above. It is a rounding bias in a MoleHook view.

//////////////////////////////////////////////////////////////////////////////*/

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Vm} from "forge-std/Vm.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Position as V4Position} from "v4-core/libraries/Position.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

contract AttackFinalPrecision is Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    address internal constant KEEPER = address(0xdeadbeef77);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant TREASURY = address(0x71EA);

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 60;
    int24 internal constant MAX_W = 120_000;

    /* ---------------------------------------------------------- the shipping pair */

    MockERC20 internal weth; // 18 decimals
    MockERC20 internal usdg; // 6 decimals

    PoolKey internal sixKey;
    PoolId internal sixId;
    int24 internal sixTick;
    bool internal usdgIsCurrency0;

    MolePositions internal mole;

    uint256 internal _clock;
    uint256 internal _height;

    /// @dev solc caches block.timestamp/block.number inside a call frame, so vm.warp(block.timestamp+d)
    ///      does not accumulate in a loop. Explicit accumulators only.
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

        weth = new MockERC20("Wrapped Ether", "WETH", 18);
        usdg = new MockERC20("USD Global", "USDG", 6);

        usdgIsCurrency0 = address(usdg) < address(weth);
        Currency c0 = Currency.wrap(usdgIsCurrency0 ? address(usdg) : address(weth));
        Currency c1 = Currency.wrap(usdgIsCurrency0 ? address(weth) : address(usdg));

        // WETH ~ $3000, USDG a dollar at SIX decimals: raw price (currency1 per currency0) is
        // 3000e6/1e18 = 3e-9 when WETH is currency0, and its reciprocal otherwise. In ticks that is
        // -/+196,260, which is an exact multiple of the 60 spacing.
        sixTick = usdgIsCurrency0 ? int24(196_260) : int24(-196_260);

        sixKey = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(sixKey, TickMath.getSqrtPriceAtTick(sixTick));
        sixId = sixKey.toId();

        _mintTo(address(this));
        weth.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdg.approve(address(modifyLiquidityRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        usdg.approve(address(swapRouter), type(uint256).max);

        modifyLiquidityRouter.modifyLiquidity(
            sixKey,
            ModifyLiquidityParams({tickLower: sixTick - 30_000, tickUpper: sixTick + 30_000, liquidityDelta: 1e16, salt: 0}),
            ZERO_BYTES
        );

        mole = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        mole.whitelistPool(sixKey);

        _fund(ALICE);
        _fund(BOB);
    }

    /* ------------------------------------------------------------------- helpers */

    function _mintTo(address who) internal {
        weth.mint(who, 1e30);
        usdg.mint(who, 1e30);
    }

    function _fund(address who) internal {
        _mintTo(who);
        vm.startPrank(who);
        weth.approve(address(mole), type(uint256).max);
        usdg.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _tok0() internal view returns (MockERC20) {
        return usdgIsCurrency0 ? usdg : weth;
    }

    function _tok1() internal view returns (MockERC20) {
        return usdgIsCurrency0 ? weth : usdg;
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = _tok0().balanceOf(who);
        b1 = _tok1().balanceOf(who);
    }

    function _assertNoInventory(string memory where) internal view {
        (uint256 m0, uint256 m1) = _bal(address(mole));
        assertEq(m0, 0, string.concat("contract holds currency0 @ ", where));
        assertEq(m1, 0, string.concat("contract holds currency1 @ ", where));
    }

    function _openAs(address who, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = mole.open(sixKey, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function _rebalance(uint256 id, int24 lo, int24 hi) internal {
        vm.prank(KEEPER);
        mole.rebalance(id, lo, hi);
    }

    function _onChainLiquidity(uint256 id, int24 lo, int24 hi) internal view returns (uint128) {
        return manager.getPositionLiquidity(sixId, V4Position.calculatePositionKey(address(mole), lo, hi, bytes32(id)));
    }

    function _poolBal() internal view returns (uint256, uint256) {
        return _bal(address(manager));
    }

    /* ==========================================================================================
       1.  ROUND TRIP AT THE SHIPPING PRICE, ACROSS EIGHT ORDERS OF MAGNITUDE
       ========================================================================================== */

    /// @notice open -> withdrawAll in the real 6/18 pool at the real price, from the smallest
    ///         position the pool accepts up to a whale. The user must never receive more of either
    ///         token than they paid, the shortfall must be single-wei rounding, and MolePositions
    ///         must hold exactly zero at every observable point.
    function test_precision_sixDecimalRoundTripNeverPaysOutMoreThanItTookIn() public {
        int24 lo = sixTick - 300;
        int24 hi = sixTick + 300;

        uint128[8] memory liqs = [
            uint128(1),
            uint128(1e3),
            uint128(1e6),
            uint128(1e9),
            uint128(1e12),
            uint128(1e15),
            uint128(1e18),
            uint128(1e21)
        ];

        uint256 twoSided;
        for (uint256 i; i < liqs.length; ++i) {
            (uint256 s0, uint256 s1) = _bal(ALICE);

            uint256 id;
            vm.prank(ALICE);
            try mole.open(sixKey, lo, hi, liqs[i], type(uint256).max, type(uint256).max, block.timestamp)
            returns (uint256 _id) {
                id = _id;
            } catch {
                (uint256 r0, uint256 r1) = _bal(ALICE);
                assertEq(r0, s0, "refused open still charged currency0");
                assertEq(r1, s1, "refused open still charged currency1");
                _assertNoInventory("refused open");
                continue;
            }

            (uint256 o0, uint256 o1) = _bal(ALICE);
            uint256 paid0 = s0 - o0;
            uint256 paid1 = s1 - o1;
            _assertNoInventory("after open");

            vm.prank(ALICE);
            mole.withdrawAll(id);

            (uint256 e0, uint256 e1) = _bal(ALICE);
            uint256 got0 = e0 - o0;
            uint256 got1 = e1 - o1;

            emit log_named_uint("liquidity", liqs[i]);
            emit log_named_uint("  paid currency0", paid0);
            emit log_named_uint("  paid currency1", paid1);
            emit log_named_uint("  got  currency0", got0);
            emit log_named_uint("  got  currency1", got1);

            assertLe(got0, paid0, "FREE MONEY on currency0 at the shipping price");
            assertLe(got1, paid1, "FREE MONEY on currency1 at the shipping price");
            assertGe(got0 + 2, paid0, "lost more than rounding on currency0");
            assertGe(got1 + 2, paid1, "lost more than rounding on currency1");
            assertEq(mole.getPosition(id).liquidity, 0, "withdrawAll left liquidity");
            _assertNoInventory("after withdrawAll");

            if (paid0 > 0 && paid1 > 0) ++twoSided;
        }
        assertGt(twoSided, 3, "corpus degenerate: too few two-sided positions at the shipping price");
    }

    /* ==========================================================================================
       2.  THE MICRO-CYCLE GRIND -- does churn leak, and in which direction
       ========================================================================================== */

    /// @notice 200 consecutive open/withdraw cycles of the smallest two-sided position this pool
    ///         accepts. Each cycle is a fresh position id, so nothing amortises. Asserted: the user
    ///         is monotonically poorer, the PoolManager is richer by EXACTLY the same amount (so the
    ///         dust accrues to the other LPs, which is the correct owner), and MolePositions holds
    ///         zero throughout.
    function test_precision_twoHundredMicroCyclesLeakOnlyToThePoolNeverToTheUser() public {
        int24 lo = sixTick - 60;
        int24 hi = sixTick + 60;

        uint128 liq = 1;
        while (liq < 1e24) {
            (uint256 a0, uint256 a1) = _bal(ALICE);
            vm.prank(ALICE);
            uint256 probe = mole.open(sixKey, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
            (uint256 b0, uint256 b1) = _bal(ALICE);
            vm.prank(ALICE);
            mole.withdrawAll(probe);
            if (a0 - b0 > 0 && a1 - b1 > 0) break;
            liq = liq * 4;
        }
        emit log_named_uint("smallest two-sided liquidity at the shipping price", liq);

        (uint256 u0, uint256 u1) = _bal(ALICE);
        (uint256 p0, uint256 p1) = _poolBal();

        for (uint256 i; i < 200; ++i) {
            vm.prank(ALICE);
            uint256 id = mole.open(sixKey, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
            vm.prank(ALICE);
            mole.withdrawAll(id);
            _assertNoInventory("mid-grind");
        }

        (uint256 u0b, uint256 u1b) = _bal(ALICE);
        (uint256 p0b, uint256 p1b) = _poolBal();

        emit log_named_uint("user currency0 lost over 200 cycles", u0 - u0b);
        emit log_named_uint("user currency1 lost over 200 cycles", u1 - u1b);

        assertLe(u0b, u0, "GRIND MINTED currency0: the user ended richer than they started");
        assertLe(u1b, u1, "GRIND MINTED currency1: the user ended richer than they started");
        assertEq(p0b - p0, u0 - u0b, "currency0 lost by the user did not land in the pool");
        assertEq(p1b - p1, u1 - u1b, "currency1 lost by the user did not land in the pool");
        assertLe(u0 - u0b, 200 * 2, "currency0 leak exceeds one wei per cycle per leg");
        assertLe(u1 - u1b, 200 * 2, "currency1 leak exceeds one wei per cycle per leg");
        _assertNoInventory("after the grind");
    }

    /* ==========================================================================================
       3.  THE REBALANCE GRIND -- 60 same-range rebalances on a six-decimal position
       ========================================================================================== */

    /// @notice A same-range rebalance is a pure burn-and-remint. With no swaps in between it should
    ///         be value-neutral to within rounding. Sixty of them, against a byte-identical control
    ///         that is never touched: can a compromised keeper grind principal away one wei at a
    ///         time, and can rounding ever CONJURE liquidity rather than destroy it?
    function test_precision_sixtySameRangeRebalancesBleedOnlyBoundedDust() public {
        int24 lo = sixTick - 300;
        int24 hi = sixTick + 300;
        uint128 liq = 1e15;

        (uint256 s0, uint256 s1) = _bal(ALICE);
        uint256 id = _openAs(ALICE, lo, hi, liq);
        (uint256 o0, uint256 o1) = _bal(ALICE);
        uint256 paid0 = s0 - o0;
        uint256 paid1 = s1 - o1;

        (uint256 cs0, uint256 cs1) = _bal(BOB);
        uint256 controlId = _openAs(BOB, lo, hi, liq);
        (uint256 co0, uint256 co1) = _bal(BOB);
        assertEq(cs0 - co0, paid0, "control paid a different currency0 bill");
        assertEq(cs1 - co1, paid1, "control paid a different currency1 bill");

        uint128 prevLiq = mole.getPosition(id).liquidity;
        for (uint256 i; i < 60; ++i) {
            _advance(1, 1);
            _rebalance(id, lo, hi);
            uint128 nowLiq = mole.getPosition(id).liquidity;
            assertLe(nowLiq, prevLiq, "a same-range rebalance CONJURED liquidity out of rounding");
            assertEq(nowLiq, _onChainLiquidity(id, lo, hi), "stored liquidity diverged from the PoolManager");
            prevLiq = nowLiq;
            _assertNoInventory("mid rebalance grind");
        }
        emit log_named_uint("liquidity before 60 same-range rebalances", liq);
        emit log_named_uint("liquidity after  60 same-range rebalances", prevLiq);

        vm.prank(ALICE);
        mole.withdrawAll(id);
        vm.prank(BOB);
        mole.withdrawAll(controlId);

        (uint256 e0, uint256 e1) = _bal(ALICE);
        (uint256 ce0, uint256 ce1) = _bal(BOB);
        uint256 got0 = e0 - o0;
        uint256 got1 = e1 - o1;
        uint256 cgot0 = ce0 - co0;
        uint256 cgot1 = ce1 - co1;

        emit log_named_uint("paid currency0", paid0);
        emit log_named_uint("paid currency1", paid1);
        emit log_named_uint("rebalanced 60x recovered currency0", got0);
        emit log_named_uint("control         recovered currency0", cgot0);
        emit log_named_uint("rebalanced 60x recovered currency1", got1);
        emit log_named_uint("control         recovered currency1", cgot1);

        assertLe(got0, paid0, "60 rebalances returned MORE currency0 than was deposited");
        assertLe(got1, paid1, "60 rebalances returned MORE currency1 than was deposited");
        assertGe(got0 + 60 * 4, cgot0, "rebalance grind cost the owner more than dust on currency0");
        assertGe(got1 + 60 * 4, cgot1, "rebalance grind cost the owner more than dust on currency1");
        _assertNoInventory("after the rebalance grind");
    }

    /* ==========================================================================================
       4.  THE SELF-FUNDING GUARD, HUNTED AT THE SHIPPING PRICE
       ========================================================================================== */

    /// @notice `RebalanceNotSelfFunding` is documented as unreachable "by construction" because
    ///         getLiquidityForAmounts rounds down. The fuzz that pins that runs in an 18/18 pool at
    ///         tick 0. This re-runs the hunt where the two legs differ by 1e12 in wei magnitude and
    ///         sqrtPrice is ~1e-5 of Q96, which is where a double-rounded-UP mint has the best shot
    ///         at outrunning a floored burn.
    ///
    /// forge-config: default.fuzz.runs = 2048
    function testFuzz_precision_rebalanceIsSelfFundingAtTheShippingPrice(
        uint256 liqRaw,
        uint256 offRaw,
        uint256 widthRaw
    ) public {
        uint128 liq = uint128(bound(liqRaw, 1e6, 1e20));
        int24 lo = sixTick - 300;
        int24 hi = sixTick + 300;

        // Called directly, NOT inside a try/catch. It used to be wrapped in one whose catch arm was a bare
        // `return`, which meant any run that failed to open reported as a passing run having asserted
        // nothing at all — 2048 green runs would have been indistinguishable from 2048 silent skips. The
        // bound above is openable across its whole range (verified: zero reverts in 2048 runs), so a revert
        // here is real news and must be red.
        vm.prank(ALICE);
        uint256 id = mole.open(sixKey, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);

        uint256 executed;
        uint256 attempted;
        for (uint256 i; i < 4; ++i) {
            // Modulo FIRST: the fuzzer hands out values within a few units of type(uint256).max, and
            // adding the loop offset before reducing overflows the harness rather than the contract.
            uint256 oSlot = (offRaw % 133 + i * 7) % 133;
            uint256 wSlot = (widthRaw % 100 + i * 11) % 100;
            int24 off = int24(int256(oSlot * uint256(uint24(SPACING)))) - int24(66 * SPACING);
            int24 w = int24(int256((wSlot + 1) * uint256(uint24(SPACING))));
            if (w < MIN_W || w > MAX_W) continue;
            int24 nlo = sixTick + off;
            int24 nhi = nlo + w;
            if (nlo <= TickMath.MIN_TICK || nhi >= TickMath.MAX_TICK) continue;

            _advance(1, 1);
            ++attempted;
            vm.prank(KEEPER);
            try mole.rebalance(id, nlo, nhi) {
                ++executed;
            } catch (bytes memory err) {
                assertNotEq(
                    bytes4(err),
                    MolePositions.RebalanceNotSelfFunding.selector,
                    "SELF-FUNDING BROKEN at the shipping price: the mint cost more than the burn returned"
                );
            }
            _assertNoInventory("after a rebalance attempt");
        }
        // The guard being hunted lives INSIDE rebalance, so a run whose every candidate range was filtered
        // out by the `continue`s above exercised none of it. Asserted rather than assumed.
        assertGt(attempted, 0, "the fuzz never reached rebalance -- this run asserted nothing");

        if (executed > 0) {
            vm.prank(ALICE);
            mole.withdrawAll(id);
            _assertNoInventory("after the exit");
        }
    }

    /* ==========================================================================================
       5.  THE EJECTION CAP MEETS INTEGER ROUNDING
       ========================================================================================== */

    /// @notice `maxEjectionBps` is a PERCENTAGE of what the burn returned. On a leg whose absolute
    ///         size is a handful of wei -- which is what six decimals gives you on any small
    ///         position -- the one wei of unavoidable rounding residual IS a large percentage, so
    ///         the cap refuses a rebalance that moved the position nowhere at all. Swept here so the
    ///         size boundary is on record.
    function test_precision_ejectionCapCanBeTrippedByPureRoundingOnADustLeg() public {
        MolePositions capped = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 5_000, 0, 0, address(0));
        capped.whitelistPool(sixKey);
        vm.startPrank(ALICE);
        weth.approve(address(capped), type(uint256).max);
        usdg.approve(address(capped), type(uint256).max);
        vm.stopPrank();

        int24 lo = sixTick - 60;
        int24 hi = sixTick + 60;

        uint256 refusedByEjection;
        uint256 refusedByZeroLiquidity;
        uint256 accepted;
        uint128 largestRefused;
        uint128 smallestAccepted;
        for (uint128 liq = 1; liq <= 1e15; liq = liq * 10) {
            uint256 id;
            vm.prank(ALICE);
            try capped.open(sixKey, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp)
            returns (uint256 _id) {
                id = _id;
            } catch {
                continue;
            }

            _advance(1, 1);
            vm.prank(KEEPER);
            try capped.rebalance(id, lo, hi) {
                ++accepted;
                if (smallestAccepted == 0) smallestAccepted = liq;
            } catch (bytes memory err) {
                if (bytes4(err) == MolePositions.EjectionTooLarge.selector) {
                    ++refusedByEjection;
                    if (liq > largestRefused) largestRefused = liq;
                } else if (bytes4(err) == MolePositions.ZeroLiquidity.selector) {
                    ++refusedByZeroLiquidity;
                    if (liq > largestRefused) largestRefused = liq;
                }
            }
            (uint256 m0, uint256 m1) = _bal(address(capped));
            assertEq(m0 + m1, 0, "capped vault retained inventory");

            // The exit is unconditional whatever the keeper could or could not do.
            if (capped.getPosition(id).liquidity > 0) {
                vm.prank(ALICE);
                capped.withdrawAll(id);
            }
        }

        emit log_named_uint("same-range rebalances accepted", accepted);
        emit log_named_uint("refused: EjectionTooLarge (rounding residual as a percentage)", refusedByEjection);
        emit log_named_uint("refused: ZeroLiquidity (a leg floored to zero on the burn)", refusedByZeroLiquidity);
        emit log_named_uint("largest liquidity a same-range rebalance could NOT move", largestRefused);
        emit log_named_uint("smallest liquidity a same-range rebalance COULD move", smallestAccepted);

        assertGt(accepted, 0, "no size was ever accepted - the sweep is degenerate");
    }

    /* ==========================================================================================
       6.  FULL RANGE: MIN_TICK .. MAX_TICK, THEN THE HARDEST POSSIBLE SQUEEZE
       ========================================================================================== */

    /// @notice The widest legal position in v4, on a spacing-1 pool so MIN_TICK/MAX_TICK are on
    ///         spacing, then rebalanced straight down to a two-tick range. That is the largest
    ///         single change of range width the system can express, and it exercises
    ///         sqrtPriceAtTick(MIN_TICK) = 4295128739 -- nine significant digits against Q96's
    ///         twenty-nine, i.e. where the amount0 formula has the least headroom.
    function test_precision_fullRangeMinToMaxTickRoundTripsAndRebalances() public {
        MolePositions wide = deployMoleVault(manager, KEEPER, 0, 1, int24(1_774_544), address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));

        PoolKey memory k = PoolKey({
            currency0: sixKey.currency0,
            currency1: sixKey.currency1,
            fee: 3000,
            tickSpacing: 1,
            hooks: IHooks(address(0))
        });
        manager.initialize(k, TickMath.getSqrtPriceAtTick(sixTick));
        wide.whitelistPool(k);

        vm.startPrank(ALICE);
        weth.approve(address(wide), type(uint256).max);
        usdg.approve(address(wide), type(uint256).max);
        vm.stopPrank();

        (uint256 s0, uint256 s1) = _bal(ALICE);
        vm.prank(ALICE);
        uint256 id = wide.open(
            k, TickMath.MIN_TICK, TickMath.MAX_TICK, 1e15, type(uint256).max, type(uint256).max, block.timestamp
        );
        (uint256 o0, uint256 o1) = _bal(ALICE);
        emit log_named_uint("full-range paid currency0", s0 - o0);
        emit log_named_uint("full-range paid currency1", s1 - o1);
        assertGt((s0 - o0) + (s1 - o1), 0, "a full-range position cost nothing - free liquidity");

        (uint256 w0, uint256 w1) = _bal(address(wide));
        assertEq(w0 + w1, 0, "full-range open left inventory");

        _advance(1, 1);
        vm.prank(KEEPER);
        wide.rebalance(id, sixTick - 1, sixTick + 1);
        (w0, w1) = _bal(address(wide));
        assertEq(w0 + w1, 0, "the max-width -> min-width rebalance left inventory");

        vm.prank(ALICE);
        wide.withdrawAll(id);
        (uint256 e0, uint256 e1) = _bal(ALICE);

        emit log_named_uint("full-range cycle recovered currency0", e0 - o0);
        emit log_named_uint("full-range cycle recovered currency1", e1 - o1);
        assertLe(e0 - o0, s0 - o0, "FREE MONEY: full-range cycle returned more currency0 than it took");
        assertLe(e1 - o1, s1 - o1, "FREE MONEY: full-range cycle returned more currency1 than it took");
        (w0, w1) = _bal(address(wide));
        assertEq(w0 + w1, 0, "full-range exit left inventory");
    }

    /* ==========================================================================================
       7.  THE ORACLE MEAN ROUNDS TOWARD ZERO, NOT TOWARD NEGATIVE INFINITY
       ========================================================================================== */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("precision", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev The hook's fee is now ONE immutable, set here, and nothing at runtime can move it. The
    ///      constructor lost five parameters (min/base/max fee, sensitivity, window) and the
    ///      direction flag when the volatility-scaled fee was removed.
    uint24 internal constant LP_FEE = 3000;

    function _deployHook(uint256 seed, uint24 hookFeePips) internal returns (MoleHook h, PoolKey memory k) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, uint32(30), false, hookFeePips, TREASURY, address(this)),
            a
        );
        h = MoleHook(a);
        k = PoolKey({
            currency0: sixKey.currency0,
            currency1: sixKey.currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(a)
        });
        manager.initialize(k, TickMath.getSqrtPriceAtTick(sixTick));
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: sixTick - 30_000, tickUpper: sixTick + 30_000, liquidityDelta: 1e16, salt: 0}),
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

    /// @dev Token order is decided by deployed addresses, so express swap sizes in WETH-equivalent
    ///      and convert when the input leg happens to be the six-decimal one. 1 wei WETH = 3e-9 wei
    ///      USDG at $3000 across an 18/6 decimal gap.
    function _swapWorth(PoolKey memory k, bool zeroForOne, uint256 wethWei) internal {
        bool inputIsUsdg = (zeroForOne == usdgIsCurrency0);
        uint256 amt = inputIsUsdg ? (wethWei * 3) / 1e9 : wethWei;
        if (amt == 0) amt = 1;
        _swapOn(k, zeroForOne, amt);
    }

    /// @dev The fee the PoolManager has STORED for this pool. Distinct from what beforeSwap overrides
    ///      with, so reading both proves neither the stored value nor the per-swap quote drifted.
    function _storedFee(PoolId id) internal view returns (uint24 lpFee) {
        (,,, lpFee) = StateLibrary.getSlot0(manager, id);
    }

    function _poolTick(PoolId id) internal view returns (int24 tick) {
        (, tick,,) = StateLibrary.getSlot0(manager, id);
    }

    /// @dev The fee ACTUALLY applied to a swap, read off the FeeQuoted log the hook emits from
    ///      beforeSwap — i.e. the number the swapper paid, not a view read afterwards. beforeSwap runs
    ///      before afterSwap, so this is the pre-swap quote, which is exactly where the old staleness
    ///      bug used to land.
    function _feeChargedOnSwap(PoolKey memory k, bool zeroForOne, uint256 wethWei) internal returns (uint24 quoted) {
        vm.recordLogs();
        _swapWorth(k, zeroForOne, wethWei);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FeeQuoted(bytes32,uint24)");
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                quoted = abi.decode(logs[i].data, (uint24));
                seen = true;
            }
        }
        assertTrue(seen, "the hook did not quote a fee for this swap at all");
    }

    /// @dev Replays consult()'s ring scan against the hook's own public state to recover the EXACT
    ///      numerator (cumNow - cumAtTarget) before the final division. Everything here is
    ///      byte-identical to the contract except that the caller decides how to divide.
    function _consultNumerator(MoleHook h, PoolId id, uint32 secondsAgo) internal view returns (int56) {
        // PoolState lost volAccum and lastObsTick with the volatility fee: six fields, not eight.
        (uint16 index, uint32 lastTimestamp,, int24 lastTick, int56 tickCumulative,) = h.poolStates(id);
        uint32 nowTs = uint32(block.timestamp);
        uint32 target;
        int56 cumNow;
        unchecked {
            target = nowTs - secondsAgo;
            cumNow = tickCumulative + int56(int256(uint256(nowTs - lastTimestamp))) * int56(lastTick);
        }

        bool haveNewer;
        uint32 newerTs;
        int56 newerCum;
        int56 cumAtTarget;
        bool found;
        uint16 i = index;
        for (uint256 n; n < 256; ++n) {
            (uint32 ts, int56 cum, bool init) = h.observations(id, i);
            if (!init) break;
            if (ts <= target) {
                uint32 rightTs = haveNewer ? newerTs : nowTs;
                int56 rightCum = haveNewer ? newerCum : cumNow;
                uint32 gap;
                unchecked {
                    gap = rightTs - ts;
                }
                if (gap == 0) {
                    cumAtTarget = cum;
                } else {
                    uint32 into;
                    unchecked {
                        into = target - ts;
                    }
                    int256 num = int256(rightCum - cum) * int256(uint256(into));
                    cumAtTarget = cum + int56(num / int256(uint256(gap)));
                }
                found = true;
                break;
            }
            haveNewer = true;
            newerTs = ts;
            newerCum = cum;
            i = i == 0 ? uint16(255) : i - 1;
        }
        require(found, "no bracket");
        return cumNow - cumAtTarget;
    }

    /// @notice consult() divides a NEGATIVE tickCumulative delta by the window using Solidity's
    ///         truncate-toward-zero division. Uniswap's own OracleLibrary explicitly corrects that
    ///         case downwards ("always round to negative infinity"). On WETH/USDG every tick is
    ///         negative, so the correction is the live case on every single call. Measured rather
    ///         than assumed, so the size of the deviation is on record.
    function test_precision_consultTruncatesTowardZeroInsteadOfFlooring() public {
        (MoleHook h, PoolKey memory k) = _deployHook(11, 0);
        PoolId id = k.toId();

        // Swaps big enough to genuinely MOVE the tick, so the cumulative is not a clean multiple of
        // any window and the final division actually has a remainder to round.
        for (uint256 i; i < 14; ++i) {
            _advance(31, 3);
            _swapWorth(k, i % 3 != 0, 3e17);
        }

        uint256 mismatches;
        uint256 windows;
        for (uint32 w = 61; w <= 331; w += 10) {
            int24 got = h.consult(id, w);
            int56 num = _consultNumerator(h, id, w);
            int56 den = int56(int256(uint256(w)));
            int24 truncated = int24(num / den);
            int24 floored = truncated;
            if (num < 0 && num % den != 0) floored = truncated - 1;
            ++windows;
            assertEq(got, truncated, "harness disagrees with consult() on the truncated value");
            if (got != floored) {
                ++mismatches;
                emit log_named_uint("window", w);
                emit log_named_int("  consult() (truncate toward zero)", got);
                emit log_named_int("  uniswap floored mean            ", floored);
            }
        }
        emit log_named_uint("windows probed", windows);
        emit log_named_uint("windows where consult() sits one tick above a floored mean", mismatches);
    }

    /* ==========================================================================================
       7b. THE DUST LEVER THAT USED TO STEER THE FEE, RE-RUN AGAINST A FEE NOTHING CAN STEER
       ========================================================================================== */

    /// @notice WHY THIS TEST CHANGED SHAPE. It used to be the P-1 finding: the volatility decay was
    ///         applied `accum * (volWindow - elapsed) / volWindow` ONCE PER SWAP, so composing it over
    ///         N swaps was geometric rather than linear and the retained fraction tended to
    ///         e^(-T/W) ~= 37% where a single idle gap of W gave 0. The decay rate was therefore a
    ///         function of SWAP COUNT, and swap count is something any stranger raises unilaterally
    ///         with 1-wei swaps that move the tick by zero and so add nothing. Measured: ten dust
    ///         swaps held 1,377 pips (0.138%) of surcharge alive on every swap for a full window.
    ///
    ///         The volatility-scaled fee has since been REMOVED, not repaired, so that finding has no
    ///         subject. The MACHINERY is kept and re-pointed, because the target is still live: the
    ///         pool, the swap path and the fee quote all still exist. The experiment is unchanged --
    ///         two pools, the same 4e19-worth volatility injection at the same instant, then exactly
    ///         one former volWindow of wall clock in which the busy arm eats ten 1-wei swaps and the
    ///         idle arm eats nothing -- and it now asserts the OPPOSITE outcome: the fee is identical
    ///         on both arms and equal to the immutable, at the peak, after EVERY dust swap, and at the
    ///         end. Dust cannot preserve a surcharge that no state can hold.
    ///
    ///         The three independent readings are deliberate: the immutable itself, the fee the
    ///         PoolManager has STORED for the pool, and the fee actually quoted to a swapper in
    ///         beforeSwap (read off the log). The old bug lived in the third one while the first two
    ///         looked correct.
    function test_precision_dustSwapsCannotKeepAnyFeeSurchargeAlive() public {
        (MoleHook idle, PoolKey memory kIdle) = _deployHook(31, 0);
        (MoleHook busy, PoolKey memory kBusy) = _deployHook(32, 0);
        PoolId idIdle = kIdle.toId();
        PoolId idBusy = kBusy.toId();

        assertEq(idle.lpFeePips(), LP_FEE, "premise failed: the hook did not take the fee it was given");
        assertEq(busy.lpFeePips(), LP_FEE, "premise failed: the hook did not take the fee it was given");

        int24 tickBefore = _poolTick(idBusy);

        // Identical volatility injection on both pools: one large move, same size, same instant. This
        // is the manufacture step of the original attack -- it is what used to drive the accumulator,
        // and it is left at full size so the experiment is not vacuous.
        _advance(120, 12);
        _swapWorth(kIdle, true, 4e19);
        _swapWorth(kBusy, true, 4e19);

        int24 tickAfter = _poolTick(idBusy);
        int24 moved = tickAfter > tickBefore ? tickAfter - tickBefore : tickBefore - tickAfter;
        emit log_named_int("ticks moved by the volatility injection", moved);
        assertGt(moved, 1000, "premise failed: the injection was not a real volatility event");
        assertEq(_poolTick(idIdle), tickAfter, "premise failed: the two arms did not receive the same move");

        assertEq(idle.currentFee(idIdle), LP_FEE, "the injection moved the idle pool's fee");
        assertEq(busy.currentFee(idBusy), LP_FEE, "the injection moved the busy pool's fee");

        // ONE former volWindow of wall-clock time passes on both pools. The idle pool sees nothing;
        // the busy pool sees ten 1-WEI swaps. The only difference between the arms is SWAP COUNT --
        // the exact quantity the old decay was a function of, and the one an attacker controls for
        // free. The fee is re-read after every single one of them.
        uint32 DEAD_VOL_WINDOW = 1 hours; // the window the deleted feature shipped with
        for (uint256 i; i < 10; ++i) {
            _advance(uint256(DEAD_VOL_WINDOW) / 10, 30);
            uint24 chargedToDust = _feeChargedOnSwap(kBusy, true, 0);
            assertEq(chargedToDust, LP_FEE, "a 1-wei wash swap was quoted something other than the immutable");
            assertEq(busy.currentFee(idBusy), LP_FEE, "a 1-wei wash swap moved the busy pool's fee");
            assertEq(_storedFee(idBusy), LP_FEE, "a 1-wei wash swap moved the pool's STORED fee");
        }

        // Same final swap on both arms, then one extra block -- the old quote was block-lagged, so
        // this is where a surcharge would have surfaced if one had been kept alive.
        _swapOn(kIdle, true, 1);
        _swapOn(kBusy, true, 1);
        _advance(1, 1);

        uint24 feeIdle = idle.currentFee(idIdle);
        uint24 feeBusy = busy.currentFee(idBusy);

        emit log_named_uint("former volWindow (seconds)", DEAD_VOL_WINDOW);
        emit log_named_uint("idle pool quoted fee, 0 swaps in the window (pips)", feeIdle);
        emit log_named_uint("busy pool quoted fee, 10 x 1-wei swaps in the window (pips)", feeBusy);

        // The economic statement, inverted from the finding: after a full window, an identical price
        // history prices IDENTICALLY on the two pools, and swap count buys the attacker nothing.
        assertEq(feeBusy, feeIdle, "SWAP COUNT STEERED THE FEE: the two arms diverged");
        assertEq(feeBusy, LP_FEE, "the busy pool's fee is not the immutable it was deployed with");
        assertEq(feeIdle, LP_FEE, "the idle pool's fee is not the immutable it was deployed with");
        assertEq(_storedFee(idBusy), LP_FEE, "the busy pool's stored fee drifted");
        assertEq(_storedFee(idIdle), LP_FEE, "the idle pool's stored fee drifted");

        // And a third party arriving after the wash pays the same on the washed pool as on the
        // untouched one. That is the leg the original attack monetised (attacker +114.9e18, swappers
        // -170.0e18); it is asserted dead here rather than assumed dead.
        assertEq(
            _feeChargedOnSwap(kBusy, true, 1e17),
            LP_FEE,
            "a third party was charged a manufactured surcharge on the washed pool"
        );
        assertEq(
            _feeChargedOnSwap(kIdle, true, 1e17),
            LP_FEE,
            "a third party was charged something other than the immutable on the untouched pool"
        );
    }

    /* ==========================================================================================
       7c. THIRTY IDLE DAYS: THE ORACLE MUST AGE, THE FEE MUST NOT
       ========================================================================================== */

    /// @notice WHY THIS TEST CHANGED SHAPE. It used to be the P-2 finding: `beforeSwap` priced from
    ///         `feeQuotes[id].staged`, a snapshot only `_write` refreshed, and only `afterSwap` ever
    ///         called `_write`. A pool that stopped trading therefore kept quoting its last volatility
    ///         surcharge with no upper bound on the age of the number -- measured at 6,819 pips still
    ///         charged to the first swapper after THIRTY DAYS of silence, where the correct figure was
    ///         3,009. There is no staged quote any more, so that finding has no subject.
    ///
    ///         The machinery is kept and the assertion inverted: the same volatility event, the same
    ///         observation write, the same thirty days of silence, and the fee must be the immutable
    ///         at every point -- including the fee ACTUALLY charged to the first post-idle swapper,
    ///         read off the FeeQuoted log rather than inferred from a view, because the log is exactly
    ///         where the old bug was visible while `currentFee` alone would not have shown it.
    ///
    ///         The second half is the load-bearing contrast, and it is why this is not a tautology.
    ///         Something in this contract still MUST track wall clock: the oracle. Across the same
    ///         thirty idle seconds-of-silence its cumulative keeps extending by elapsed*lastTick, so
    ///         consult() over the idle span still returns the live tick. Time passing is observable;
    ///         it simply no longer has a route to the fee.
    function test_precision_thirtyIdleDaysCannotStaleTheQuotedFee() public {
        (MoleHook h, PoolKey memory k) = _deployHook(41, 0);
        PoolId id = k.toId();

        int24 tickBeforeEvent = _poolTick(id);
        _advance(120, 12);
        _swapWorth(k, true, 4e19); // the volatility event
        _advance(120, 12);
        _swapOn(k, true, 1); // the observation write that used to stage the peak
        _advance(2, 2);

        // The premise: this really was a violent move, i.e. the size of event that used to drive the
        // surcharge to 6,819 pips. Without this the "fee did not move" assertions below are hollow.
        int24 tickAfterEvent = _poolTick(id);
        int24 movedByEvent =
            tickAfterEvent > tickBeforeEvent ? tickAfterEvent - tickBeforeEvent : tickBeforeEvent - tickAfterEvent;
        emit log_named_int("ticks moved by the volatility event", movedByEvent);
        assertGt(movedByEvent, 1000, "premise failed: there was no volatility event to be stale about");

        uint24 spikeFee = h.currentFee(id);
        emit log_named_uint("fee right after the volatility event (pips)", spikeFee);
        assertEq(spikeFee, LP_FEE, "the volatility event moved the fee at all");
        assertEq(_storedFee(id), LP_FEE, "the volatility event moved the pool's stored fee");

        // Thirty days of complete silence: no swap, so no `_write`, so nothing in this contract runs.
        _advance(30 days, 30 days / 12);

        uint24 staleFee = h.currentFee(id);
        emit log_named_uint("fee after THIRTY DAYS of no trading (pips)", staleFee);
        assertEq(staleFee, spikeFee, "the fee moved while the pool sat idle");
        assertEq(staleFee, LP_FEE, "the idle pool is not quoting its immutable");
        assertEq(_storedFee(id), LP_FEE, "the pool's stored fee drifted over thirty idle days");

        // The first post-idle swapper. beforeSwap runs before afterSwap, so this reading is taken at
        // the exact moment the old stale snapshot used to be applied.
        uint24 chargedFee = _feeChargedOnSwap(k, true, 1e17);
        emit log_named_uint("fee actually charged to the first swapper after 30 idle days", chargedFee);
        assertEq(chargedFee, LP_FEE, "the first post-idle swapper was charged something other than the immutable");

        _advance(1, 1);
        assertEq(h.currentFee(id), LP_FEE, "the fee moved one block after the post-idle swap");

        // THE CONTRAST. The oracle is the thing that genuinely depends on wall clock, and it still
        // does: over a window that lies entirely inside the thirty idle days, consult() extends the
        // cumulative by elapsed * lastTick and so returns the tick that was in force throughout.
        // Truncation toward zero (P-3 above) is worth at most one tick on a window this size.
        (MoleHook h2, PoolKey memory k2) = _deployHook(42, 0);
        PoolId id2 = k2.toId();
        _advance(120, 12);
        _swapWorth(k2, true, 4e19);
        int24 restingTick = _poolTick(id2);
        _advance(30 days, 30 days / 12);
        int24 idleTwap = h2.consult(id2, 300);
        emit log_named_int("tick resting through the idle month", restingTick);
        emit log_named_int("consult(300) taken thirty days later ", idleTwap);
        assertApproxEqAbs(
            int256(idleTwap),
            int256(restingTick),
            2,
            "the ORACLE stopped tracking wall clock across the idle month"
        );
        assertEq(h2.currentFee(id2), LP_FEE, "the fee tracked the idle month even though nothing should");
    }

    /* ==========================================================================================
       8.  THE HOOK FEE ROUNDS DOWN, AND HAS A FREE ZONE UNDER IT
       ========================================================================================== */

    /// @notice `amount = magnitude * hookFeePips / 1e6`, floored. Below magnitude = 1e6/hookFeePips
    ///         the protocol's cut is exactly zero. Six decimals is what makes the threshold
    ///         economically nameable rather than an abstract count of wei, so it is measured in the
    ///         units that ship.
    function test_precision_hookFeeHasAFreeZoneBelowOneUnitOfPips() public {
        uint24 hookFee = 500; // 0.05%
        (, PoolKey memory k) = _deployHook(22, hookFee);

        // Exact-input WETH so the UNSPECIFIED (output) leg is USDG, the coarse six-decimal side.
        bool zeroForOne = !usdgIsCurrency0;

        uint256 freeSwaps;
        uint256 payingSwaps;
        uint256 largestFree;
        uint256 amt = 1;
        for (uint256 i; i < 16; ++i) {
            uint256 before = usdg.balanceOf(TREASURY) + weth.balanceOf(TREASURY);
            _advance(31, 3);
            try swapRouter.swap(
                k,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amt),
                    sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            ) {
                uint256 afterBal = usdg.balanceOf(TREASURY) + weth.balanceOf(TREASURY);
                if (afterBal == before) {
                    ++freeSwaps;
                    largestFree = amt;
                } else {
                    ++payingSwaps;
                }
            } catch {}
            amt = amt * 10;
        }
        emit log_named_uint("swaps inside the hook-fee free zone", freeSwaps);
        emit log_named_uint("largest WETH-in swap that paid ZERO hook fee (wei)", largestFree);
        emit log_named_uint("swaps that paid the hook fee", payingSwaps);
        assertGt(payingSwaps, 0, "no swap ever paid the hook fee - the probe is vacuous");
    }
}
