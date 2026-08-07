// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////
                        KEEPER ATTACK / REGRESSION SUITE
                    target:  src/MolePositions.sol
                    lens:    fully compromised keeper key
                    found:   2026-08-01   (7 live findings, claim 1 was FALSE)
                    fixed:   2026-08-02   (rebalance conserves TOKEN AMOUNTS)
                    re-run:  2026-08-03   (this file, converted to regressions)

  The claim under test is:

      "A fully compromised keeper key can degrade returns. It cannot take a token."

  On 2026-08-01 that claim was FALSE. `rebalance` held the LIQUIDITY NUMBER constant while
  moving the RANGE. Because the token value of a fixed L depends on range width, re-minting the
  same L at a narrower band needed fewer tokens; the old `_settleNet` parked the surplus in
  `address(this)` as ONE unattributed pot shared by every position, and funded widening
  rebalances out of it. The keeper narrowed a victim, widened its own position out of the pot,
  and withdrew to itself entirely legitimately (it really was `positions[id].owner`).

  THE FIX, and therefore what every test below now pins:
    - rebalance derives the new liquidity from the amounts the burn ACTUALLY RETURNED, via
      LiquidityAmounts.getLiquidityForAmounts at the new range (rounds down). Token amounts are
      conserved; the liquidity integer is not, and must not be.
    - accrued fees are inside those amounts, so they COMPOUND into the owner's position.
    - leftover dust goes to the OWNER through `_collectTo`, at rebalance time.
    - `_settleNet` is DELETED. The contract holds no inventory and spends none, so there is no
      pot to move value between positions.

  Every attack sequence below is preserved verbatim -- same actors, same bands, same one-block
  ordering. Only the expected OUTCOME changed. The load-bearing assertion in most of them is
  now `_assertNoInventory`: the contract's token balance is EXACTLY ZERO at every step. That is
  the precise property that killed F-1/F-1b/F-2/F-4/F-5, because the pot those exploits spent
  was nothing but this balance. Restoring any function that lets MolePositions hold or spend a
  token balance turns these tests red again, which is the entire point of keeping them.

  THAT CLAIM WAS VERIFIED, NOT ASSUMED. On 2026-08-03 the pre-fix `rebalance` (constant L plus
  `_settleNet`) was reinstated in a throwaway copy of MolePositions.sol and this file was run
  against it. All eight converted regressions failed: seven on `_assertNoInventory` (the pot
  reappeared, up to 2.93e16 of a victim's token0 in one call) and the widening test on the old
  TransferFailed DoS. The eight M-* tests stayed green, which is correct -- they were never
  about the pot. A regression test that cannot fail when the bug returns is decoration.

  ---------------------------------------------------------------------------
  STATUS LEDGER

  [F-1]  FIXED -- keeper stole ~97% of a victim's principal into its own wallet via the shared
         pot. Was: test_attack_keeperDrainsStrandedResidueIntoItsOwnPositionAndWithdrawsIt.
         Now:  test_regression_keeperCannotMoveVictimPrincipalIntoItsOwnPosition
         Pins: the narrowing rebalance leaves the contract holding zero, so step 3 (widen the
               keeper's own sink out of the pot) has nothing to draw on -- it reverts -- and the
               keeper finishes the sequence strictly poorer than it started while the victim is
               made whole to the wei.

  [F-1b] FIXED -- the pot was fungible ACROSS pools, so the sink did not even need to share the
         victim's pool. Was: test_attack_potIsFungibleAcrossPoolsSoSinkNeedNotShareTheVictimsPool
         Now:  test_regression_noCrossPoolValueTransferBetweenPositions
         Pins: pool A's confiscation is zero, and a pool B rebalance is funded exclusively by
               pool B's own burn proceeds.

  [F-2]  FIXED -- keeper converted a balanced position to one-sided AND confiscated the leg that
         no longer fitted. Was: test_attack_keeperConvertsBalancedPositionIntoOneSidedAndStrandsTheRest
         Now:  test_regression_oneSidedRebalancePaysTheDisplacedLegToTheOwner
         Pins: the keeper can still RESHAPE (that residual grief budget is real and intended),
               but the displaced token1 leg is paid to the OWNER at rebalance time rather than
               swept -- deposit is recovered in full across dust + withdrawal.

  [F-3]  FIXED -- rebalance confiscated 100% of accrued swap fees; a same-range rebalance was a
         pure fee skim. Was: test_attack_keeperConfiscatesAllAccruedFeesByRebalancingToTheSameRange
         Now:  test_regression_sameRangeRebalanceCompoundsFeesIntoTheOwnersPosition
         Pins: a same-range rebalance INCREASES p.liquidity, because the fees come back in the
               burn amounts and buy more liquidity at the same band. A/B against an identical
               untouched control position still in the same pool.

  [F-4]  FIXED -- value conservation was broken by construction. Was:
         testFuzz_attack_anyOutOfRangeRebalanceStrandsValueInTheContract
         Now:  testFuzz_regression_rebalanceNeverStrandsValueInTheContract
         Pins: over the whole fuzz domain, contract balance is exactly zero and the owner's
               wallet is restored to within a few wei of its pre-deposit value.

  [F-5]  FIXED (value), ACCEPTED (grief) -- `minRebalanceInterval` is still per position, so one
         keeper transaction can still reshape every position in the book in one block. Was:
         test_attack_intervalIsPerPositionSoOneBlockCanGriefEveryPosition
         Now:  test_regression_oneBlockBookWideRebalanceConfiscatesNothing
         Pins: the book-wide reshape now confiscates ZERO. What remains is range-choice grief,
               which is the documented residual and is bounded by the width limits.

  [F-6]  FIXED -- the pot was load bearing: with an empty pot a widening rebalance reverted
         TransferFailed, i.e. legitimate keeper operation depended on someone else's confiscated
         value. Was: test_attack_rebalanceIntoWiderRangeRevertsWhenSharedPotIsEmpty
         Now:  test_regression_wideningRebalanceIsSelfFundingAndBuysLessLiquidity
               test_regression_bookedLiquidityMatchesThePoolManagerAfterRebalance (control)
               test_regression_failedRebalanceLeavesPositionStateUntouched (atomicity)
         Pins: widening now succeeds from an empty contract because the LIQUIDITY NUMBER is
               derived downwards instead of the tokens being topped up. Same tokens, wider band,
               less L -- that is correct v4 arithmetic, not a loss.

  [M-1..M-5] Unchanged and still mitigated; these were never live, so they keep their
         test_attack_ names. rebalance on a zero-liquidity or non-existent position reverts,
         lastRebalancedAt is written on every successful path, the keeper cannot withdraw or
         reassign someone else's position, width/spacing/ordering bounds hold, unlockCallback
         rejects a foreign caller, and a non-keeper cannot rebalance at all.

  ---------------------------------------------------------------------------
  BEHAVIOURAL CONSEQUENCE OF THE FIX, recorded because it is easy to mistake for a bug:
  a position that the keeper has parked entirely on one side of spot can no longer be rebalanced
  back into a two-sided band. The missing leg used to be conjured out of the pot; there is no pot,
  and `rebalance` performs no swap, so `getLiquidityForAmounts` returns 0 and the call reverts
  ZeroLiquidity. The owner's exit is unaffected -- `withdraw` never depended on the keeper.
  See test_regression_failedRebalanceLeavesPositionStateUntouched.

  CHAIN NOTE. Nothing here depends on Robinhood Chain's L1-paced `block.number`; every guard
  exercised is `block.timestamp` based, which Foundry reproduces exactly. F-1's steps 2-4 are
  still executed at one timestamp, modelling a single-sequencer no-mempool chain where the
  keeper can order them adjacently and no victim withdrawal can interleave.

  BUILD NOTE. foundry.toml now sets optimizer_runs = 44444444 (upstream v4). At 800 solc 0.8.26
  + via_ir cannot compile v4-core's PoolManager at all, so this file simply does not build.
      forge test --match-path test/attack/AttackKeeper.t.sol -vv
//////////////////////////////////////////////////////////////////////////////*/

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

contract AttackKeeperTest is Deployers {
    using StateLibrary for IPoolManager;

    MolePositions internal mole;

    address internal constant KEEPER = address(0xBADBEEF);
    address internal constant VICTIM = address(0x1C71);
    address internal constant VICTIM2 = address(0xC0117201);

    uint32 internal constant MIN_INTERVAL = 1 hours;
    int24 internal constant MIN_WIDTH = 120;
    int24 internal constant MAX_WIDTH = 120_000;

    int24 internal constant SPACING = 60;

    // A balanced, in-range band around spot (tick 0). 50/50 at SQRT_PRICE_1_1.
    int24 internal constant IN_LOWER = -600;
    int24 internal constant IN_UPPER = 600;

    // A narrow band far ABOVE spot. Needs ~1% of the token0 that the in-range band needs for the
    // same liquidity, and zero token1. This was the confiscation lever; it is still the sharpest
    // reshape the keeper can perform, so every regression test keeps using it.
    int24 internal constant FAR_LOWER = 60_000;
    int24 internal constant FAR_UPPER = 60_120;

    /// @dev Rounding slack for ONE position round trip (open + rebalance + withdraw). v4 rounds
    ///      mint costs UP and burn proceeds DOWN, and a rebalance does one of each, so a few wei
    ///      are left with the pool. Measured maximum across this file, including 50k fuzz runs,
    ///      is 4 wei; the budget is 8.
    ///
    ///      This is a hard WEI budget, deliberately not a percentage. The whole 2026-08-01 finding
    ///      was a loss proportional to position size, so a proportional tolerance here would have
    ///      absorbed the very bug these tests exist to catch. It is verified size-independent: at
    ///      1e15 and at 5e18 of liquidity the observed delta is the same handful of wei.
    uint256 internal constant DUST_WEI = 8;

    MockERC20 internal t0;
    MockERC20 internal t1;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        // Background liquidity so the pool is swappable and spot is well anchored at tick 0.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1e19, salt: 0}),
            ZERO_BYTES
        );

        mole = deployMoleVault(manager, KEEPER, MIN_INTERVAL, MIN_WIDTH, MAX_WIDTH, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        mole.whitelistPool(key);

        _fund(VICTIM);
        _fund(VICTIM2);
        _fund(KEEPER);
    }

    /* ------------------------------------------------------------------ helpers */

    function _fund(address who) internal {
        t0.mint(who, 1_000e18);
        t1.mint(who, 1_000e18);
        vm.startPrank(who);
        t0.approve(address(mole), type(uint256).max);
        t1.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = t0.balanceOf(who);
        b1 = t1.balanceOf(who);
    }

    /// @dev Both tokens are 18 decimals and the pool sits at 1:1, so raw units are a
    ///      fair common denominator for "value" in these tests.
    function _value(address who) internal view returns (uint256) {
        return t0.balanceOf(who) + t1.balanceOf(who);
    }

    /// @notice THE assertion that killed F-1, F-1b, F-2, F-4 and F-5.
    /// @dev `_settleNet` was deleted, so MolePositions must never hold a token. Exactly zero,
    ///      not "small": one wei of unattributed inventory is one wei with no owner, and the
    ///      whole exploit family was built out of exactly that account.
    function _assertNoInventory(string memory ctx) internal view {
        assertEq(t0.balanceOf(address(mole)), 0, string.concat("contract holds token0: ", ctx));
        assertEq(t1.balanceOf(address(mole)), 0, string.concat("contract holds token1: ", ctx));
    }

    function _open(address who, int24 lower, int24 upper, uint128 liq)
        internal
        returns (uint256 id, uint256 spent0, uint256 spent1)
    {
        (uint256 a0, uint256 a1) = _bal(who);
        vm.prank(who);
        id = mole.open(key, lower, upper, liq, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 b0, uint256 b1) = _bal(who);
        spent0 = a0 - b0;
        spent1 = a1 - b1;
    }

    function _withdrawAll(address who, uint256 id) internal returns (uint256 got0, uint256 got1) {
        MolePositions.Position memory p = mole.getPosition(id);
        (uint256 a0, uint256 a1) = _bal(who);
        vm.prank(who);
        mole.withdraw(id, p.liquidity);
        (uint256 b0, uint256 b1) = _bal(who);
        got0 = b0 - a0;
        got1 = b1 - a1;
    }

    /// @dev Keeper rebalance, measuring what the OWNER receives during the call. Under the fix a
    ///      rebalance can pay out immediately (the displaced leg is dust and dust belongs to the
    ///      owner), so any accounting that only looks at withdraw() now understates the owner.
    function _keeperRebalance(uint256 id, int24 lower, int24 upper, address owner)
        internal
        returns (uint256 dust0, uint256 dust1)
    {
        (uint256 a0, uint256 a1) = _bal(owner);
        vm.prank(KEEPER);
        mole.rebalance(id, lower, upper);
        (uint256 b0, uint256 b1) = _bal(owner);
        dust0 = b0 - a0;
        dust1 = b1 - a1;
    }

    /* ==========================================================================
       F-2 (was: keeper converts a balanced position to one-sided AND keeps the rest)
       ========================================================================== */

    /// Was: proved a keeper could convert a balanced position to 100% token0 and confiscate the
    /// displaced token1 leg onto the contract. Now pins that the reshape still happens but the
    /// displaced leg is paid to the OWNER during the rebalance, leaving the contract at zero.
    function test_regression_oneSidedRebalancePaysTheDisplacedLegToTheOwner() public {
        uint256 victimStart = _value(VICTIM);

        (uint256 id, uint256 in0, uint256 in1) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        uint256 deposited = in0 + in1;

        // Sanity: the position started balanced, and the contract is a pure pass-through.
        assertGt(in0, 0, "deposit was not two-sided");
        assertGt(in1, 0, "deposit was not two-sided");
        _assertNoInventory("on open");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // Entirely above spot -> after this the position can only hold token0. Same call, same
        // band, same keeper as the original attack.
        (uint256 dust0, uint256 dust1) = _keeperRebalance(id, 600, 1200, VICTIM);

        // KILLER PROPERTY: there is no residue. The old `_settleNet` pot is gone.
        _assertNoInventory("after the one-sided rebalance");

        // The displaced token1 leg went to the OWNER, not to the contract.
        assertApproxEqAbs(dust1, in1, DUST_WEI, "displaced token1 leg did not reach the owner");

        (uint256 got0, uint256 got1) = _withdrawAll(VICTIM, id);

        console2.log("deposited (t0+t1)      ", deposited);
        console2.log("dust paid at rebalance ", dust0 + dust1);
        console2.log("victim got token0      ", got0);
        console2.log("victim got token1      ", got1);

        // The RESHAPE still happened -- that is the residual, intended grief budget.
        assertEq(got1, 0, "position was not fully converted to one side");
        assertGt(got0, 0, "position holds nothing - accounting is worse than claimed");

        // But it is now only a reshape. Nothing was taken.
        assertApproxEqAbs(
            got0 + got1 + dust0 + dust1, deposited, DUST_WEI, "value neither in the position nor with the owner"
        );
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "victim did not end whole");
        assertEq(mole.getPosition(id).liquidity, 0, "liquidity not fully withdrawn");
        _assertNoInventory("after the owner fully exits");
    }

    /* ==========================================================================
       F-1  THE THEFT. Keeper pays itself the victim's principal.
       ========================================================================== */

    /// Was: the headline theft -- keeper narrowed the victim into a far band, ~99.5% of the
    /// principal landed in the shared pot, the keeper widened its OWN sink out of that pot and
    /// withdrew to itself (net +97.5% of the victim's deposit). Now pins that step 2 creates no
    /// pot at all, so step 3 has nothing to draw on and the keeper ends up poorer, not richer.
    function test_regression_keeperCannotMoveVictimPrincipalIntoItsOwnPosition() public {
        uint256 keeperStart = _value(KEEPER);
        uint256 victimStart = _value(VICTIM);

        // --- victim, honest, in-range, balanced.
        (uint256 victimId, uint256 in0, uint256 in1) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        uint256 victimDeposit = in0 + in1;

        // --- step 1: keeper opens a SINK position far above spot. Costs dust.
        //     Slightly less liquidity than the victim so the pot would certainly have covered it.
        (uint256 sinkId, uint256 sink0, uint256 sink1) = _open(KEEPER, FAR_LOWER, FAR_UPPER, 0.98e18);
        assertEq(sink1, 0, "far-above band should need no token1");
        assertLt(sink0, victimDeposit / 50, "sink position was not cheap");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // Everything below happens inside a single block. On a single-sequencer, no-mempool chain
        // the victim cannot interleave a withdraw() here.
        uint256 tAttack = block.timestamp;

        // --- step 2: grief the victim into the far band. This used to sweep ~99.5% of their
        //     principal into the contract's shared, unattributed balance.
        (uint256 vDust0, uint256 vDust1) = _keeperRebalance(victimId, FAR_LOWER, FAR_UPPER, VICTIM);
        uint256 pot = _value(address(mole));
        console2.log("pot after step 2       ", pot);
        console2.log("dust paid to victim    ", vDust0 + vDust1);

        // KILLER PROPERTY: the pot is exactly zero, so there is nothing for step 3 to spend.
        _assertNoInventory("after narrowing the victim (this was the pot)");
        assertApproxEqAbs(vDust1, in1, DUST_WEI, "victim's displaced leg was not paid to the victim");

        // --- step 3: try to pull the pot into the keeper's OWN position by rebalancing the sink
        //     back in-range. Attempted exactly as before; the outcome is what changed. Deliberately
        //     a raw call rather than expectRevert: the property is "cannot be funded from anyone
        //     else's money", not "reverts with this selector", and that survives a refactor that
        //     one day teaches rebalance to swap.
        vm.prank(KEEPER);
        (bool pulled,) = address(mole).call(abi.encodeCall(MolePositions.rebalance, (sinkId, IN_LOWER, IN_UPPER)));
        console2.log("step 3 succeeded       ", pulled);
        _assertNoInventory("during the keeper's own rebalance");

        // --- step 4: withdraw. `_collectTo` still pays positions[sinkId].owner == KEEPER, exactly
        //     as before -- there is simply nothing extra in there to pay out.
        (uint256 k0, uint256 k1) = _withdrawAll(KEEPER, sinkId);
        assertEq(block.timestamp, tAttack, "steps 2-4 were not in one block");

        uint256 keeperEnd = _value(KEEPER);
        console2.log("keeper start           ", keeperStart);
        console2.log("keeper end             ", keeperEnd);
        console2.log("keeper withdrew t0/t1  ", k0, k1);

        // THE CLAIM, now true: the keeper cannot take a token. It ends the sequence no richer.
        assertLe(keeperEnd, keeperStart, "keeper extracted value from the protocol");
        assertLe(k0 + k1, sink0 + sink1, "keeper's sink returned more than the keeper put in");

        // And the victim is whole: the token1 leg came back as dust at rebalance time, the token0
        // leg is still their position, and both together are the deposit.
        (uint256 v0, uint256 v1) = _withdrawAll(VICTIM, victimId);
        console2.log("victim deposited       ", victimDeposit);
        console2.log("victim recovered       ", v0 + v1 + vDust0 + vDust1);
        assertApproxEqAbs(v0 + v1 + vDust0 + vDust1, victimDeposit, DUST_WEI, "victim lost principal");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "victim did not end whole");
        _assertNoInventory("after both parties fully exit");
    }

    /* ==========================================================================
       F-1b  the pot had no per-pool accounting either.
       ========================================================================== */

    /// Was: proved the pot was fungible across pools -- value confiscated from a position in pool
    /// A paid for the keeper's position in pool B. Now pins that pool A yields no confiscation and
    /// that a pool B rebalance is funded only by pool B's own burn proceeds.
    function test_regression_noCrossPoolValueTransferBetweenPositions() public {
        // A second, independent pool over the same two tokens (different fee -> different PoolId,
        // different PoolKey, different liquidity book).
        (PoolKey memory keyB,) = initPool(currency0, currency1, IHooks(address(0)), 500, 10, SQRT_PRICE_1_1);
        mole.whitelistPool(keyB);

        uint256 keeperStart = _value(KEEPER);
        uint256 victimStart = _value(VICTIM);

        // Victim is in pool A.
        (uint256 victimId, uint256 in0, uint256 in1) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        uint256 victimDeposit = in0 + in1;

        // Keeper's sink is in pool B, far above spot: one-sided in token0, costs dust.
        (uint256 sink0Before,) = _bal(KEEPER);
        vm.prank(KEEPER);
        uint256 sinkId =
            mole.open(keyB, FAR_LOWER, FAR_UPPER, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 sink0After,) = _bal(KEEPER);
        uint256 sinkCost = sink0Before - sink0After;

        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // Attempt to confiscate the victim's pool-A principal into the shared pot.
        (uint256 vDust0, uint256 vDust1) = _keeperRebalance(victimId, FAR_LOWER, FAR_UPPER, VICTIM);
        _assertNoInventory("pool A principal was captured into a shared pot");

        // Move the pool B sink from [60000,60120] to [12000,12120] -- still entirely above spot, so
        // it needs ONLY token0, and used to need roughly 4.5x what the far band held. Under the fix
        // it is paid for entirely out of its own burn proceeds by deriving a smaller L.
        (uint256 kDust0, uint256 kDust1) = _keeperRebalance(sinkId, 12_000, 12_120, KEEPER);
        _assertNoInventory("pool B rebalance drew on contract inventory");

        (uint256 k0, uint256 k1) = _withdrawAll(KEEPER, sinkId);
        assertEq(k1, 0, "pool B sink should be one-sided");

        console2.log("victim deposited (pool A)", victimDeposit);
        console2.log("keeper sink cost (pool B)", sinkCost);
        console2.log("keeper withdrew  (pool B)", k0 + k1 + kDust0 + kDust1);

        // No cross-pool value transfer: pool B's sink can never return more than it cost.
        assertLe(k0 + k1 + kDust0 + kDust1, sinkCost, "pool B sink returned more than pool B paid in");
        assertLe(_value(KEEPER), keeperStart, "keeper profited across pools");

        // Pool A's owner is untouched.
        (uint256 v0, uint256 v1) = _withdrawAll(VICTIM, victimId);
        assertApproxEqAbs(v0 + v1 + vDust0 + vDust1, victimDeposit, DUST_WEI, "pool A victim lost principal");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "pool A victim did not end whole");
        _assertNoInventory("after both parties fully exit");
    }

    /* ==========================================================================
       F-3  fees. A/B against an untouched control in the same pool.
       ========================================================================== */

    /// Was: proved a same-range rebalance was a pure fee skim -- 100% of accrued fees were swept
    /// to the contract and the attacked position underperformed an identical control. Now pins the
    /// inverse property: the fees come back inside the burn amounts and therefore COMPOUND, so the
    /// same-range rebalance strictly INCREASES p.liquidity and the owner keeps the fee.
    function test_regression_sameRangeRebalanceCompoundsFeesIntoTheOwnersPosition() public {
        // Two identical positions in the same band: one attacked, one control.
        (uint256 attackedId, uint256 a0in, uint256 a1in) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        (uint256 controlId,,) = _open(VICTIM2, IN_LOWER, IN_UPPER, 1e18);
        uint256 deposited = a0in + a1in;

        // Churn the pool so both positions accrue identical fees.
        for (uint256 i = 0; i < 12; i++) {
            swap(key, true, -2e16, ZERO_BYTES);
            swap(key, false, -2e16, ZERO_BYTES);
        }

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        _assertNoInventory("before the rebalance");

        uint128 liqBefore = mole.getPosition(attackedId).liquidity;
        assertEq(liqBefore, 1e18, "control of the experiment: liquidity should still be as opened");

        // NOTE: the new range is IDENTICAL to the old one. `rebalance` still does not require the
        // range to change, so this is still the sharpest possible fee-skim attempt.
        (uint256 dust0, uint256 dust1) = _keeperRebalance(attackedId, IN_LOWER, IN_UPPER, VICTIM);
        uint128 liqAfter = mole.getPosition(attackedId).liquidity;

        // KILLER PROPERTY 1: nothing was skimmed.
        _assertNoInventory("fees were skimmed onto the contract");

        // KILLER PROPERTY 2: the fee is INSIDE the position now. Same range, same price, strictly
        // more liquidity -- which is only possible if the burn returned principal plus fees and all
        // of it was re-minted for the owner.
        console2.log("liquidity before/after ", uint256(liqBefore), uint256(liqAfter));
        assertGt(liqAfter, liqBefore, "same-range rebalance did not compound fees into the position");

        (uint256 a0, uint256 a1) = _withdrawAll(VICTIM, attackedId);
        (uint256 c0, uint256 c1) = _withdrawAll(VICTIM2, controlId);

        uint256 attacked = a0 + a1 + dust0 + dust1;
        uint256 control = c0 + c1;
        uint256 controlFee = control - deposited;

        console2.log("attacked position out  ", attacked);
        console2.log("control  position out  ", control);
        console2.log("control fee earned     ", controlFee);

        assertGt(controlFee, 0, "the experiment did not generate any fees to skim");
        // The attacked owner keeps the fee: they end up ahead of their own deposit...
        assertGt(attacked, deposited, "attacked position did not keep its fees");
        // ...and level with the untouched control, bar v4's round-down on the extra burn/mint pair.
        assertApproxEqAbs(attacked, control, DUST_WEI, "attacked position underperformed the control");
        _assertNoInventory("after both owners fully exit");
    }

    /* ==========================================================================
       F-4  fuzz: conservation across the whole reshape domain.
       ========================================================================== */

    /// Was: fuzzed proof that ANY out-of-range rebalance moved value out of the position and into
    /// the contract's unattributed balance. Now pins the opposite across the same domain: the
    /// contract balance stays exactly zero and the owner's wallet is restored to within a fixed
    /// wei budget, whatever band and whatever size the keeper picks.
    function testFuzz_regression_rebalanceNeverStrandsValueInTheContract(int24 rawLower, uint128 rawLiq) public {
        // Any narrow band strictly above spot. 20 <= n <= 1600 tick-spacings up.
        int24 lower = int24(bound(int256(rawLower), 20, 1600)) * SPACING;
        int24 upper = lower + 120;
        uint128 liq = uint128(bound(uint256(rawLiq), 1e15, 5e18));

        uint256 victimStart = _value(VICTIM);
        (uint256 id, uint256 in0, uint256 in1) = _open(VICTIM, IN_LOWER, IN_UPPER, liq);
        uint256 deposited = in0 + in1;
        assertGt(deposited, 0, "nothing was deposited");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        (uint256 dust0, uint256 dust1) = _keeperRebalance(id, lower, upper, VICTIM);

        // KILLER PROPERTY: no unattributed balance, ever, anywhere in the domain.
        _assertNoInventory("after the rebalance");
        // The token1 leg cannot live above spot, so it is RETURNED to the owner rather than swept.
        assertApproxEqAbs(dust1, in1, DUST_WEI, "displaced token1 leg did not reach the owner");

        (uint256 got0, uint256 got1) = _withdrawAll(VICTIM, id);

        // The reshape is real -- the keeper can still leave the position one-sided.
        assertEq(got1, 0, "position not fully one-sided above spot");
        // But every unit is accounted for, and all of it is the owner's.
        assertApproxEqAbs(got0 + got1 + dust0 + dust1, deposited, DUST_WEI, "value conservation broken");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "owner did not end whole");
        _assertNoInventory("after the owner fully exits");
    }

    /* ==========================================================================
       F-6  the pot was load bearing for ordinary keeper operation. It is not any more.
       ========================================================================== */

    /// Was: proved a widening rebalance was a hard DoS on an empty contract (reverted
    /// TransferFailed), i.e. normal keeper operation depended on the pot being pre-funded with
    /// someone else's confiscated value. Now pins that widening is self-funding from an empty
    /// contract, because the LIQUIDITY NUMBER is derived down instead of the tokens being topped up.
    function test_regression_wideningRebalanceIsSelfFundingAndBuysLessLiquidity() public {
        uint256 victimStart = _value(VICTIM);
        (uint256 id, uint256 in0, uint256 in1) = _open(VICTIM, -60, 60, 1e18);
        uint256 deposited = in0 + in1;
        _assertNoInventory("pot not empty at the start");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // [-6000,6000] needs ~85x the token0/token1 that [-60,60] returns FOR THE SAME L. The old
        // code tried to settle that shortfall from address(this) and reverted. The fix derives L
        // from the tokens instead, so the same tokens simply buy less liquidity at a wider band.
        (uint256 dust0, uint256 dust1) = _keeperRebalance(id, -6000, 6000, VICTIM);
        _assertNoInventory("widening rebalance drew on contract inventory");

        MolePositions.Position memory p = mole.getPosition(id);
        console2.log("liquidity after widening", uint256(p.liquidity));
        assertEq(p.tickLower, -6000, "range not applied");
        assertEq(p.tickUpper, 6000, "range not applied");

        // CORRECT SEMANTICS, and the exact thing the old suite got wrong: L is NOT conserved. A
        // wider band holds the same tokens with far less liquidity, and pretending otherwise is
        // what created the surplus the pot was built from.
        assertLt(p.liquidity, 1e18, "wider range did not derive a smaller liquidity number");
        assertLt(p.liquidity, 1e18 / 50, "wider range should need ~2 orders of magnitude less L");
        assertGt(p.liquidity, 0, "position was wiped out");

        (uint256 g0, uint256 g1) = _withdrawAll(VICTIM, id);
        assertApproxEqAbs(g0 + g1 + dust0 + dust1, deposited, DUST_WEI, "widening leaked value");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "owner did not end whole");
        _assertNoInventory("after the owner fully exits");
    }

    /// Control for F-6. Was: `test_attack_liquidityAccountingIsNotOverstatedAfterRebalance`, which
    /// checked that the old constant-L re-add matched the PoolManager. Now pins the same books-match
    /// property for the DERIVED liquidity number: whatever getLiquidityForAmounts computed is
    /// exactly what got minted, and it is withdrawable in full.
    function test_regression_bookedLiquidityMatchesThePoolManagerAfterRebalance() public {
        uint256 victimStart = _value(VICTIM);
        (uint256 id, uint256 in0, uint256 in1) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        (uint256 dust0, uint256 dust1) = _keeperRebalance(id, FAR_LOWER, FAR_UPPER, VICTIM);

        MolePositions.Position memory p = mole.getPosition(id);
        uint128 onChain = manager.getPositionLiquidity(
            key.toId(), keccak256(abi.encodePacked(address(mole), p.tickLower, p.tickUpper, bytes32(id)))
        );
        assertEq(onChain, p.liquidity, "p.liquidity does not match the PoolManager position");
        assertGt(p.liquidity, 0, "position was wiped out");
        _assertNoInventory("after the rebalance");

        // Full withdrawal succeeds for the full booked amount.
        (uint256 g0, uint256 g1) = _withdrawAll(VICTIM, id);
        assertGt(g0, 0, "withdraw returned nothing at all");
        assertEq(g1, 0, "unexpected token1");
        assertEq(mole.getPosition(id).liquidity, 0, "liquidity not cleared");
        assertApproxEqAbs(g0 + g1 + dust0 + dust1, in0 + in1, DUST_WEI, "value leaked across the round trip");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "owner did not end whole");
        _assertNoInventory("after the owner fully exits");
    }

    /// Atomicity, and the documented behavioural consequence of deleting the pot: a position the
    /// keeper has parked entirely on one side of spot cannot be moved back into a two-sided band,
    /// because the missing leg used to be conjured out of the pot and `rebalance` performs no swap.
    /// The failure must be clean, and the owner's exit must not depend on it.
    function test_regression_failedRebalanceLeavesPositionStateUntouched() public {
        uint256 victimStart = _value(VICTIM);
        (uint256 id, uint256 in0, uint256 in1) = _open(VICTIM, FAR_LOWER, FAR_UPPER, 1e18);
        assertEq(in1, 0, "far-above band should need no token1");

        MolePositions.Position memory before = mole.getPosition(id);
        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // Raw call: what matters is that no inventory is touched, not the selector of the day.
        vm.prank(KEEPER);
        (bool ok,) = address(mole).call(abi.encodeCall(MolePositions.rebalance, (id, IN_LOWER, IN_UPPER)));
        console2.log("one-sided -> in-range rebalance succeeded", ok);
        _assertNoInventory("during a rebalance that cannot fund its second leg");

        if (!ok) {
            MolePositions.Position memory afterP = mole.getPosition(id);
            assertEq(afterP.tickLower, before.tickLower, "range mutated by a reverted rebalance");
            assertEq(afterP.tickUpper, before.tickUpper, "range mutated by a reverted rebalance");
            assertEq(afterP.liquidity, before.liquidity, "liquidity mutated by a reverted rebalance");
            assertEq(
                afterP.lastRebalancedAt, before.lastRebalancedAt, "rate limiter consumed by a reverted rebalance"
            );
        }

        // Either way the exit works and pays the owner: withdrawal never depended on the keeper.
        (uint256 g0, uint256 g1) = _withdrawAll(VICTIM, id);
        assertApproxEqAbs(g0 + g1, in0 + in1, DUST_WEI, "owner could not recover the position");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "owner did not end whole");
        _assertNoInventory("after the owner fully exits");
    }

    /* ==========================================================================
       F-5  the interval is per position: one block can still reshape the whole book.
       ========================================================================== */

    /// Was: proved one keeper transaction could confiscate 99.5% of every position in the book in a
    /// single block. Now pins that the book-wide reshape is still possible (the rate limit is still
    /// per position -- accepted residual grief) but confiscates exactly nothing.
    function test_regression_oneBlockBookWideRebalanceConfiscatesNothing() public {
        uint256 victimStart = _value(VICTIM);
        uint256[] memory ids = new uint256[](3);
        uint256 totalDeposit;
        for (uint256 i = 0; i < 3; i++) {
            (uint256 id, uint256 a0, uint256 a1) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
            ids[i] = id;
            totalDeposit += a0 + a1;
        }

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        uint256 t = block.timestamp;

        // The grief itself is unchanged: three positions reshaped in one block by one key.
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(KEEPER);
            mole.rebalance(ids[i], FAR_LOWER, FAR_UPPER);
        }
        assertEq(block.timestamp, t, "not a single block");

        // KILLER PROPERTY: the whole-book reshape moves zero value out of the owners.
        _assertNoInventory("book-wide reshape confiscated value into the contract");
        console2.log("book deposited         ", totalDeposit);

        for (uint256 i = 0; i < 3; i++) {
            _withdrawAll(VICTIM, ids[i]);
        }
        assertApproxEqAbs(_value(VICTIM), victimStart, 3 * DUST_WEI, "book-wide reshape cost the owner value");
        _assertNoInventory("after the owner fully exits");
    }

    /* ==========================================================================
       MITIGATED / NOT-REACHABLE -- never exploitable, kept as-is.
       ========================================================================== */

    function test_attack_rebalanceOnFullyWithdrawnPositionReverts() public {
        (uint256 id,,) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        _withdrawAll(VICTIM, id);

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.rebalance(id, FAR_LOWER, FAR_UPPER);
    }

    function test_attack_rebalanceOnNonExistentPositionReverts() public {
        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NoSuchPosition.selector);
        mole.rebalance(999, FAR_LOWER, FAR_UPPER);
    }

    function test_attack_sameBlockDoubleRebalanceOfOnePositionReverts() public {
        (uint256 id,,) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);

        // Immediately after open, lastRebalancedAt == now.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceTooSoon.selector);
        mole.rebalance(id, FAR_LOWER, FAR_UPPER);

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, FAR_LOWER, FAR_UPPER);

        // lastRebalancedAt was written, so the second attempt in the same block fails.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceTooSoon.selector);
        mole.rebalance(id, FAR_LOWER + 120, FAR_UPPER + 120);

        assertEq(mole.getPosition(id).lastRebalancedAt, uint64(block.timestamp), "lastRebalancedAt not updated");
    }

    function test_attack_keeperCannotWithdrawSomeoneElsesPosition() public {
        (uint256 id,,) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1e18);

        assertEq(mole.ownerOf(id), VICTIM, "owner changed");
    }

    function test_attack_keeperCannotEscapeRangeWidthBounds() public {
        (uint256 id,,) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // Too narrow (60 < MIN_WIDTH 120).
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.rebalance(id, 0, 60);

        // Too wide (>120_000).
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        mole.rebalance(id, -120_000, 60_000);

        // Off spacing.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.TickNotOnSpacing.selector);
        mole.rebalance(id, -601, 601);

        // Misordered.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.TicksMisordered.selector);
        mole.rebalance(id, 600, -600);
    }

    function test_attack_unlockCallbackRejectsForeignCaller() public {
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(abi.encode(uint8(1), uint256(1), KEEPER, int256(0), int24(0), int24(0)));
    }

    function test_attack_nonKeeperCannotRebalance() public {
        (uint256 id,,) = _open(VICTIM, IN_LOWER, IN_UPPER, 1e18);
        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        // Even the position's own owner cannot -- and neither could an arbitrary attacker who,
        // before the fix, would have been able to drain the shared pot via the F-1 path.
        vm.prank(VICTIM);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, FAR_LOWER, FAR_UPPER);
    }
}
