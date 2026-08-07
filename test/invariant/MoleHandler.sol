// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint128} from "v4-core/libraries/FixedPoint128.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

import {MolePositions} from "../../src/MolePositions.sol";

/// @title MoleHandler
/// @notice Bounded-action handler that drives MolePositions the way real actors and a real keeper
///         would, and maintains the ghost accounting the invariants are checked against.
///
/// DESIGN NOTE — WHY THE VIOLATION CHECKS LIVE HERE AND ARE COUNTERS, NOT ASSERTS.
/// Two of the six properties (INV-3 no-free-money, INV-5 keeper cannot destroy value) are only
/// meaningful when measured INSIDE a single transaction, because the pool price is constant across
/// one call and therefore the before/after token amounts are directly comparable. Across calls the
/// price moves and a per-currency comparison stops being a statement about custody at all.
///
/// They are recorded as ghost counters rather than asserted in place because `fail_on_revert = false`
/// in foundry.toml: an assertion that reverts inside a handler call is swallowed by the invariant
/// runner AND rolled back, so the failure would silently vanish. Recording without reverting keeps
/// the evidence, and the `invariant_*` functions assert the counters are zero. The magnitudes are
/// kept too, so a failure reports how much value moved rather than just that some did.
contract MoleHandler is CommonBase, StdCheats, StdUtils {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------ wiring */

    MolePositions public immutable mole;
    IPoolManager public immutable manager;
    PoolSwapTest public immutable swapRouter;
    MockERC20 public immutable t0;
    MockERC20 public immutable t1;
    address public immutable keeper;

    PoolKey internal key;
    PoolId internal poolId;

    /* --------------------------------------------------------------- constants */

    int24 public constant SPACING = 60;
    int24 public constant MIN_W = 120;
    int24 public constant MAX_W = 60_000;
    uint32 public constant INTERVAL = 1 hours;

    /// @dev RHChain.SECONDS_PER_BLOCK_NUMBER_TICK. On Robinhood Chain `block.number` is the ETHEREUM L1
    ///      height, so it ticks once per ~12 seconds of wall clock and a sequencer cannot forge it.
    uint256 internal constant SECS_PER_L1_BLOCK = 12;

    int24 internal constant MIN_USABLE_TICK = -887_220; // MIN_TICK rounded up to spacing 60
    int24 internal constant MAX_USABLE_TICK = 887_220;

    /// @dev Keep the swap price inside the band the background LP covers, so the pool always has
    ///      depth and swaps do not degenerate into "no liquidity, nothing happens".
    int24 internal constant SWAP_BAND = 55_000;

    uint256 public constant MAX_POSITIONS = 16;

    /// @dev Per-operation rounding tolerance, in wei. The formulas involved (SqrtPriceMath vs
    ///      LiquidityAmounts) disagree by O(1) wei, never proportionally, so an ABSOLUTE bound is
    ///      the correct shape. 1e3 wei is 1e-15 of a token: economically zero, and fifteen orders
    ///      of magnitude below the 23e18 the 2026-08-01 exploit moved.
    uint256 public constant DUST = 1_000;

    /* ------------------------------------------------------------------ actors */

    address[] public actors;

    /* ------------------------------------------------------- ghost: positions */

    uint256[] public ids;

    /// @notice Owner as recorded by the handler at open(). INV-6 compares storage against this.
    mapping(uint256 => address) public ghostOwner;

    /// @notice The liquidity the owner of `id` is OWED at the position's current range.
    ///
    ///         Deliberately NOT a mirror of `p.liquidity`. It is recomputed independently at every
    ///         rebalance from the tokens the old range was worth (principal + accrued fees) re-quoted
    ///         at the new range. Under the pre-fix contract — which held the liquidity NUMBER constant
    ///         across a range change — a narrowing rebalance leaves p.liquidity far BELOW this value,
    ///         which is precisely the victim's loss, and INV-2 fails on it.
    mapping(uint256 => uint256) public ghostClaimL;

    /// @notice Every (id, lower, upper) this contract has ever minted into. INV-4 walks it to prove
    ///         no liquidity was left stranded at a range a position has since left.
    struct RangeRec {
        uint256 id;
        int24 lower;
        int24 upper;
    }

    RangeRec[] public rangeHistory;

    /* ---------------------------------------------------------- ghost: actors */

    mapping(address => uint256) public ghostDep0;
    mapping(address => uint256) public ghostDep1;
    mapping(address => uint256) public ghostOut0;
    mapping(address => uint256) public ghostOut1;

    uint256 public ghostTotalDep0;
    uint256 public ghostTotalDep1;
    uint256 public ghostTotalOut0;
    uint256 public ghostTotalOut1;

    /* ------------------------------------------------------ ghost: violations */

    /// INV-3: value handed to an actor beyond (principal removed + fees actually accrued), summed.
    uint256 public overpay0;
    uint256 public overpay1;
    /// INV-3, other direction: position value credited to an actor beyond what the actor paid in.
    uint256 public underpay0;
    uint256 public underpay1;
    /// INV-3: an owner paid strictly less than the position they received is worth, at one instant.
    uint256 public freeMoneyEvents;
    /// Split by call site, so a failure names the path rather than just the fact.
    uint256 public freeMoneyOnOpen;
    uint256 public freeMoneyOnWithdraw;
    uint256 public maxUnderpay0;
    uint256 public maxUnderpay1;
    uint256 public maxOverpay0;
    uint256 public maxOverpay1;
    /// INV-5: rebalances that reduced the position's instantaneous token value.
    uint256 public rebalanceValueViolations;
    uint256 public worstRebalanceLoss0;
    uint256 public worstRebalanceLoss1;
    uint256 public worstRebalanceLossId;
    /// Diagnostic: withdrawals that paid the owner LESS than the principal they burned.
    uint256 public shortPayEvents;
    uint256 public shortPay0;
    uint256 public shortPay1;
    /// Diagnostic: opens that charged the depositor MORE than the position they received is worth.
    uint256 public overchargeEvents;
    uint256 public overcharge0;
    uint256 public overcharge1;

    /* ----------------------------------------------------- ghost: diagnostics */

    // Captured at the worst INV-3 withdrawal violation so a failure reports the arithmetic, not
    // just the fact. Diagnostics only: nothing here is asserted on.
    uint256 public dbgId;
    uint256 public dbgAmt;
    uint256 public dbgLiqBefore;
    uint256 public dbgExp0;
    uint256 public dbgExp1;
    uint256 public dbgF0;
    uint256 public dbgF1;
    uint256 public dbgR0;
    uint256 public dbgR1;
    int256 public dbgLower;
    int256 public dbgUpper;
    int256 public dbgTick;
    uint256 public dbgLast0;
    uint256 public dbgG0;
    uint256 public dbgFeeGrowthWentBackwards;

    /* -------------------------------------------------------- ghost: coverage */

    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public reverts;
    uint256 public totalCalls;

    uint256 public swapsThatMovedPrice;
    uint256 public rebalancesThatNarrowed;
    uint256 public rebalancesThatWidened;
    uint256 public rebalancesOutOfRange;
    uint256 public opensOutOfRange;
    uint256 public fullExits;
    uint256 public feeAccruingWithdrawals;

    modifier countCall(bytes32 name) {
        calls[name]++;
        totalCalls++;
        _;
    }

    /* ------------------------------------------------------------- construction */

    constructor(
        MolePositions _mole,
        IPoolManager _manager,
        PoolSwapTest _swapRouter,
        PoolKey memory _key,
        address _keeper,
        address[] memory _actors
    ) {
        mole = _mole;
        manager = _manager;
        swapRouter = _swapRouter;
        key = _key;
        poolId = _key.toId();
        keeper = _keeper;
        t0 = MockERC20(Currency.unwrap(_key.currency0));
        t1 = MockERC20(Currency.unwrap(_key.currency1));
        for (uint256 i; i < _actors.length; ++i) {
            actors.push(_actors[i]);
        }
        // The handler is the swapper; it needs its own approval to the router.
        t0.approve(address(_swapRouter), type(uint256).max);
        t1.approve(address(_swapRouter), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function rangeHistoryCount() external view returns (uint256) {
        return rangeHistory.length;
    }

    /* =========================================================== ACTION: open */

    /// @notice A user opens a position. Budgets, not raw liquidity, are fuzzed: the caller picks how
    ///         many tokens they are willing to spend and the liquidity is quoted from that, which is
    ///         how a real front end behaves and keeps the call affordable instead of reverting.
    function open(uint256 actorSeed, uint256 offsetSeed, uint256 widthSeed, uint256 amt0Seed, uint256 amt1Seed)
        public
        countCall("open")
    {
        if (ids.length >= MAX_POSITIONS) return;

        address actor = actors[actorSeed % actors.length];
        (int24 lower, int24 upper) = _pickRange(offsetSeed, widthSeed);

        (uint160 sqrtP, int24 tick) = _slot0();

        uint256 bal0 = t0.balanceOf(actor);
        uint256 bal1 = t1.balanceOf(actor);
        if (bal0 < 1e15 || bal1 < 1e15) return;

        uint256 amt0 = bound(amt0Seed, 1e12, bal0 / 8 > 100e18 ? 100e18 : bal0 / 8);
        uint256 amt1 = bound(amt1Seed, 1e12, bal1 / 8 > 100e18 ? 100e18 : bal1 / 8);

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amt0, amt1
        );
        if (liq == 0) return;

        uint256 b0 = t0.balanceOf(actor);
        uint256 b1 = t1.balanceOf(actor);

        vm.prank(actor);
        try mole.open(key, lower, upper, liq, amt0 + DUST, amt1 + DUST, block.timestamp) returns (uint256 id) {
            uint256 d0 = b0 - t0.balanceOf(actor);
            uint256 d1 = b1 - t1.balanceOf(actor);

            ids.push(id);
            ghostOwner[id] = actor;
            ghostClaimL[id] = liq;
            rangeHistory.push(RangeRec({id: id, lower: lower, upper: upper}));

            ghostDep0[actor] += d0;
            ghostDep1[actor] += d1;
            ghostTotalDep0 += d0;
            ghostTotalDep1 += d1;

            if (tick < lower || tick >= upper) opensOutOfRange++;

            // INV-3, mint side. At this instant the position is worth (v0, v1). The actor paid
            // (d0, d1). Paying LESS than the position is worth is value minted from nowhere — which
            // is what the shared pot did when it funded a widening mint out of someone else's tokens.
            (uint256 v0, uint256 v1) = amountsFor(lower, upper, liq);

            // The mirror of the same statement: the depositor must not be charged MORE than the
            // position is worth either. Together these two make open() an exact exchange at the
            // instantaneous price, which is the only shape under which "this contract never holds
            // an inventory" can be true.
            if (d0 > v0 + DUST) {
                overchargeEvents++;
                overcharge0 += d0 - v0;
            }
            if (d1 > v1 + DUST) {
                overchargeEvents++;
                overcharge1 += d1 - v1;
            }

            if (v0 > d0 + DUST || v1 > d1 + DUST) {
                freeMoneyEvents++;
                freeMoneyOnOpen++;
                if (v0 > d0) {
                    underpay0 += v0 - d0;
                    if (v0 - d0 > maxUnderpay0) maxUnderpay0 = v0 - d0;
                }
                if (v1 > d1) {
                    underpay1 += v1 - d1;
                    if (v1 - d1 > maxUnderpay1) maxUnderpay1 = v1 - d1;
                }
            }
        } catch {
            reverts["open"]++;
        }
    }

    /* ======================================================= ACTION: withdraw */

    function withdrawPartial(uint256 posSeed, uint256 bpsSeed) public countCall("withdrawPartial") {
        uint256 id = _pickLivePosition(posSeed);
        if (id == 0) return;
        uint128 live = mole.getPosition(id).liquidity;
        uint128 amt = uint128((uint256(live) * bound(bpsSeed, 1, 9_000)) / 10_000);
        if (amt == 0) amt = 1;
        _withdraw(id, amt, "withdrawPartial");
    }

    function withdrawFull(uint256 posSeed) public countCall("withdrawFull") {
        uint256 id = _pickLivePosition(posSeed);
        if (id == 0) return;
        _withdraw(id, mole.getPosition(id).liquidity, "withdrawFull");
    }

    /// @notice The convenience exit, `withdrawAll(id)`, driven through the same ghost accounting as every
    ///         other withdrawal.
    /// @dev It is a separate entry point on the contract and it had unit coverage but no deep coverage:
    ///      the handler only ever called `withdraw(id, liquidity)`, so millions of fuzz calls never touched
    ///      the one-argument exit users are most likely to actually call. It reads the liquidity itself
    ///      rather than taking it as an argument, so it is not the same code path even though it ends in
    ///      the same place.
    function withdrawAllViaConvenienceEntry(uint256 posSeed) public countCall("withdrawAll") {
        uint256 id = _pickLivePosition(posSeed);
        if (id == 0) return;
        _withdrawVia(id, mole.getPosition(id).liquidity, "withdrawAll", true);
    }

    function _withdraw(uint256 id, uint128 amt, bytes32 label) internal {
        _withdrawVia(id, amt, label, false);
    }

    /// @dev One body, two entry points. `viaConvenienceEntry` picks `withdrawAll(id)` over
    ///      `withdraw(id, amt)`; everything downstream — the independent entitlement quote, the ghost
    ///      claim retirement, the free-money and short-pay checks — is identical, which is the point.
    ///      Duplicating this accounting for the second entry point would have meant two versions of the
    ///      checks that INV-3 and the short-pay invariant depend on, and only one of them maintained.
    function _withdrawVia(uint256 id, uint128 amt, bytes32 label, bool viaConvenienceEntry) internal {
        MolePositions.Position memory p = mole.getPosition(id);
        address owner = p.owner;

        // What this burn is entitled to, computed independently of the contract: the principal for
        // `amt` at the current price, plus every fee the WHOLE position has accrued (v4 realises all
        // of them on any liquidity change).
        (uint256 exp0, uint256 exp1) = amountsFor(p.tickLower, p.tickUpper, amt);
        (uint256 grossFee0, uint256 grossFee1) = feesOwed(id, p.tickLower, p.tickUpper, p.liquidity);
        (uint256 wc0, uint256 wc1) = _expectedCut(grossFee0, grossFee1);
        // What the OWNER is entitled to: principal in full, fees net of the published cut. Principal is
        // never reduced here — that is the whole claim the fee has to satisfy.
        uint256 f0 = grossFee0 > wc0 ? grossFee0 - wc0 : 0;
        uint256 f1 = grossFee1 > wc1 ? grossFee1 - wc1 : 0;

        uint256 b0 = t0.balanceOf(owner);
        uint256 b1 = t1.balanceOf(owner);
        uint256 claimBefore = ghostClaimL[id];
        uint128 liqBefore = p.liquidity;

        vm.prank(owner);
        if (viaConvenienceEntry) {
            try mole.withdrawAll(id) {}
            catch {
                reverts[label]++;
                return;
            }
        } else {
            try mole.withdraw(id, amt) {}
            catch {
                reverts[label]++;
                return;
            }
        }
        {
            uint256 r0 = t0.balanceOf(owner) - b0;
            uint256 r1 = t1.balanceOf(owner) - b1;

            ghostOut0[owner] += r0;
            ghostOut1[owner] += r1;
            ghostTotalOut0 += r0;
            ghostTotalOut1 += r1;

            // A withdrawal of x% of the position retires x% of the claim. Keeping it proportional is
            // what makes a shortfall survive partial exits instead of being rounded away.
            ghostClaimL[id] = amt >= liqBefore ? 0 : claimBefore - (claimBefore * amt) / liqBefore;

            if (f0 > 0 || f1 > 0) feeAccruingWithdrawals++;
            if (amt >= liqBefore) fullExits++;

            // INV-3, burn side: never more than principal + fees actually accrued.
            if (r0 > exp0 + f0 + DUST) {
                freeMoneyEvents++;
                freeMoneyOnWithdraw++;
                overpay0 += r0 - (exp0 + f0);
                if (r0 - (exp0 + f0) > maxOverpay0) {
                    maxOverpay0 = r0 - (exp0 + f0);
                    _capture(id, amt, liqBefore, p.tickLower, p.tickUpper, exp0, exp1, f0, f1, r0, r1);
                }
            }
            if (r1 > exp1 + f1 + DUST) {
                freeMoneyEvents++;
                freeMoneyOnWithdraw++;
                overpay1 += r1 - (exp1 + f1);
                if (r1 - (exp1 + f1) > maxOverpay1) {
                    maxOverpay1 = r1 - (exp1 + f1);
                    _capture(id, amt, liqBefore, p.tickLower, p.tickUpper, exp0, exp1, f0, f1, r0, r1);
                }
            }
            // Diagnostic mirror: never LESS than the principal burned.
            if (r0 + DUST < exp0) {
                shortPayEvents++;
                shortPay0 += exp0 - r0;
            }
            if (r1 + DUST < exp1) {
                shortPayEvents++;
                shortPay1 += exp1 - r1;
            }
        }
    }

    /* ======================================================= ACTION: rebalance */

    /// @notice The keeper reshapes a position to a random LEGAL range. Time is warped past the rate
    ///         limit first, because the interesting question is not whether the rate limit works
    ///         (the attack suite pins that) but whether an unlimited number of legal rebalances can
    ///         bleed a position.
    /// @dev Moves BOTH clocks at Robinhood Chain's real pacing. The handler used to call `vm.warp` alone
    ///      and never touch `block.number`, which meant the deep run — millions of calls — advanced only
    ///      the clock the sequencer writes and never the one it cannot. Every L1-denominated bound (the
    ///      dwell, the per-L1-block rebalance budget) was therefore unreachable by construction: not
    ///      because the bounds hold, but because the fuzzer had no way to reach them.
    /// @dev The ghost's own estimate of what the protocol will skim. Derived from `feesOwed`, which the
    ///      handler computes independently from feeGrowthInside — so this applies the PUBLISHED rate to an
    ///      INDEPENDENTLY measured fee figure. A contract that took its cut from principal instead would
    ///      produce a far larger shortfall than this predicts, and the invariants below would fire.
    function _expectedCut(uint256 fee0, uint256 fee1) internal view returns (uint256 c0, uint256 c1) {
        // try/catch, because this same handler also drives VulnerableMolePositions — the 2026-08-01
        // snapshot, which predates the fee and has no such function. A plain call reverts there and takes
        // the mutation proof down with it, which is exactly what happened when this was written without
        // the guard. A build with no fee has no cut.
        try mole.performanceFeeBps() returns (uint16 bps) {
            if (bps == 0) return (0, 0);
            c0 = (fee0 * bps) / 10_000;
            c1 = (fee1 * bps) / 10_000;
        } catch {
            return (0, 0);
        }
    }

    function _advanceRH(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs / SECS_PER_L1_BLOCK);
    }

    function rebalance(uint256 posSeed, uint256 offsetSeed, uint256 widthSeed, uint256 timeSeed)
        public
        countCall("rebalance")
    {
        uint256 id = _pickLivePosition(posSeed);
        if (id == 0) return;

        _advanceRH(bound(timeSeed, INTERVAL, INTERVAL + 3 days));

        MolePositions.Position memory p = mole.getPosition(id);
        (int24 nl, int24 nu) = _pickRange(offsetSeed, widthSeed);

        // Instantaneous value BEFORE: principal at the current price plus every accrued fee. The
        // price cannot move inside modifyLiquidity, so the same measurement after the call is a
        // like-for-like token comparison and NOT a price-sensitive one.
        (uint256 pre0, uint256 pre1) = amountsFor(p.tickLower, p.tickUpper, p.liquidity);
        uint256 preFee0;
        uint256 preFee1;
        {
            (uint256 f0, uint256 f1) = feesOwed(id, p.tickLower, p.tickUpper, p.liquidity);
            preFee0 = f0;
            preFee1 = f1;
            pre0 += f0;
            pre1 += f1;
        }

        uint256 ob0 = t0.balanceOf(p.owner);
        uint256 ob1 = t1.balanceOf(p.owner);

        // The ghost's OWN entitlement re-quote, from the same tokens at the new range.
        (uint160 sqrtP,) = _slot0();
        // The re-mint is funded by principal plus fees MINUS the protocol's cut, so the ghost's claim has
        // to net the cut off too or it would over-state the entitlement on every charging vault.
        (uint256 rc0, uint256 rc1) = _expectedCut(preFee0, preFee1);
        uint256 expectedL = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(nl),
            TickMath.getSqrtPriceAtTick(nu),
            pre0 > rc0 ? pre0 - rc0 : 0,
            pre1 > rc1 ? pre1 - rc1 : 0
        );

        vm.prank(keeper);
        try mole.rebalance(id, nl, nu) {
            MolePositions.Position memory q = mole.getPosition(id);

            // Dust routed to the owner is recovered value, not lost value.
            uint256 dust0 = t0.balanceOf(p.owner) - ob0;
            uint256 dust1 = t1.balanceOf(p.owner) - ob1;
            ghostOut0[p.owner] += dust0;
            ghostOut1[p.owner] += dust1;
            ghostTotalOut0 += dust0;
            ghostTotalOut1 += dust1;

            (uint256 post0, uint256 post1) = amountsFor(q.tickLower, q.tickUpper, q.liquidity);
            post0 += dust0;
            post1 += dust1;
            // The protocol's cut left the position by design and is not value the keeper destroyed. It is
            // added back before the INV-5 comparison so that a CHARGING vault is not reported as bleeding
            // its users — while any loss BEYOND the published rate still shows up, which is the point.
            post0 += rc0;
            post1 += rc1;

            // INV-5.
            if (post0 + DUST < pre0) {
                rebalanceValueViolations++;
                uint256 loss = pre0 - post0;
                if (loss > worstRebalanceLoss0) {
                    worstRebalanceLoss0 = loss;
                    worstRebalanceLossId = id;
                }
            }
            if (post1 + DUST < pre1) {
                rebalanceValueViolations++;
                uint256 loss = pre1 - post1;
                if (loss > worstRebalanceLoss1) {
                    worstRebalanceLoss1 = loss;
                    worstRebalanceLossId = id;
                }
            }

            ghostClaimL[id] = expectedL;

            if (q.tickLower != p.tickLower || q.tickUpper != p.tickUpper) {
                rangeHistory.push(RangeRec({id: id, lower: q.tickLower, upper: q.tickUpper}));
            }
            int24 oldW = p.tickUpper - p.tickLower;
            int24 newW = q.tickUpper - q.tickLower;
            if (newW < oldW) rebalancesThatNarrowed++;
            if (newW > oldW) rebalancesThatWidened++;
            (, int24 tickNow) = _slot0();
            if (tickNow < q.tickLower || tickNow >= q.tickUpper) rebalancesOutOfRange++;
        } catch {
            reverts["rebalance"]++;
        }
    }

    /* ============================================================ ACTION: swap */

    /// @notice Moves the pool price so fees accrue and positions go in and out of range.
    function swap(uint256 amtSeed, uint256 dirSeed, uint256 timeSeed) public countCall("swap") {
        _advanceRH(bound(timeSeed, 1, 6 hours));

        bool zeroForOne = dirSeed % 2 == 0;
        uint256 amountIn = bound(amtSeed, 1e15, 400e18);

        MockERC20 tin = zeroForOne ? t0 : t1;
        if (tin.balanceOf(address(this)) < amountIn) return;

        (uint160 before,) = _slot0();

        try swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.getSqrtPriceAtTick(-SWAP_BAND)
                    : TickMath.getSqrtPriceAtTick(SWAP_BAND)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            (uint160 aft,) = _slot0();
            if (aft != before) swapsThatMovedPrice++;
        } catch {
            reverts["swap"]++;
        }
    }

    /* -------------------------------------------------------------- internals */

    function _slot0() internal view returns (uint160 sqrtPriceX96, int24 tick) {
        (sqrtPriceX96, tick,,) = StateLibrary.getSlot0(manager, poolId);
    }

    /// @dev Tokens recoverable by burning `liq` over [lower, upper] at the CURRENT price.
    function amountsFor(int24 lower, int24 upper, uint256 liq) public view returns (uint256, uint256) {
        if (liq == 0) return (0, 0);
        (uint160 sqrtP,) = _slot0();
        return LiquidityAmounts.getAmountsForLiquidity(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), uint128(liq)
        );
    }

    /// @dev Fees the PoolManager owes this position right now, computed the way Pool.modifyLiquidity
    ///      computes them (feeGrowthInside delta x liquidity / Q128), so it is an independent
    ///      reproduction rather than a reading of the contract under test.
    function feesOwed(uint256 id, int24 lower, int24 upper, uint128 liq)
        public
        view
        returns (uint256 f0, uint256 f1)
    {
        if (liq == 0) return (0, 0);
        (, uint256 last0, uint256 last1) =
            StateLibrary.getPositionInfo(manager, poolId, address(mole), lower, upper, bytes32(id));
        (uint256 g0, uint256 g1) = StateLibrary.getFeeGrowthInside(manager, poolId, lower, upper);
        // The subtraction MUST wrap, exactly as Position.update does it ("overflow in the
        // subtraction of fee growth is expected"). feeGrowthInside is itself routinely a wrapped
        // value — a straddling range whose two ticks were initialised at different times has
        // `global - outsideLower - outsideUpper` below zero — and both the stored `last` and the
        // current reading carry that wrap, so only the unchecked difference is meaningful.
        //
        // Guarding this with `if (g0 >= last0)` instead silently reports zero fees on every wrapped
        // position. That is not a conservative simplification: it makes the INV-3 upper bound too
        // tight and manufactures a violation out of an ordinary fee payout.
        unchecked {
            f0 = FullMath.mulDiv(g0 - last0, liq, FixedPoint128.Q128);
            f1 = FullMath.mulDiv(g1 - last1, liq, FixedPoint128.Q128);
        }
    }

    function _capture(
        uint256 id,
        uint128 amt,
        uint128 liqBefore,
        int24 lower,
        int24 upper,
        uint256 exp0,
        uint256 exp1,
        uint256 f0,
        uint256 f1,
        uint256 r0,
        uint256 r1
    ) internal {
        dbgId = id;
        dbgAmt = amt;
        dbgLiqBefore = liqBefore;
        dbgLower = lower;
        dbgUpper = upper;
        dbgExp0 = exp0;
        dbgExp1 = exp1;
        dbgF0 = f0;
        dbgF1 = f1;
        dbgR0 = r0;
        dbgR1 = r1;
        (, int24 tk) = _slot0();
        dbgTick = tk;
    }

    function poolLiquidityOf(uint256 id, int24 lower, int24 upper) public view returns (uint128) {
        (uint128 liq,,) = StateLibrary.getPositionInfo(manager, poolId, address(mole), lower, upper, bytes32(id));
        return liq;
    }

    function _pickLivePosition(uint256 seed) internal view returns (uint256) {
        uint256 n = ids.length;
        if (n == 0) return 0;
        uint256 start = seed % n;
        for (uint256 i; i < n; ++i) {
            uint256 id = ids[(start + i) % n];
            if (mole.getPosition(id).liquidity > 0) return id;
        }
        return 0;
    }

    /// @dev A random LEGAL range: aligned to spacing, width inside [MIN_W, MAX_W], centred within one
    ///      width of the current tick so the fuzzer produces in-range, above-range and below-range
    ///      positions rather than only straddling ones.
    function _pickRange(uint256 offsetSeed, uint256 widthSeed) internal view returns (int24 lower, int24 upper) {
        (, int24 tick) = _slot0();

        int24 width = int24(int256(bound(widthSeed, 2, 1_000))) * SPACING; // [120, 60000]
        int256 centre = int256(bound(offsetSeed, 0, uint256(int256(width)) * 2)) - int256(width);

        int256 raw = int256(tick) + centre - int256(width) / 2;
        int256 aligned = (raw / int256(SPACING)) * int256(SPACING);

        if (aligned < int256(MIN_USABLE_TICK)) aligned = int256(MIN_USABLE_TICK);
        if (aligned + int256(width) > int256(MAX_USABLE_TICK)) aligned = int256(MAX_USABLE_TICK) - int256(width);

        lower = int24(aligned);
        upper = int24(aligned + int256(width));
    }
}
