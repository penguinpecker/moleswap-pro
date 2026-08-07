// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////

                                  F I N D I N G S

  Lens: does `p.liquidity` ever disagree with reality, and can rounding be farmed?

  ORIGINAL VERDICT (2026-08-01, against the pre-fix contract). `p.liquidity` never disagreed with
  the PoolManager in *units*. It disagreed catastrophically with *value*: `rebalance()` conserved
  the liquidity NUMBER across a range change instead of conserving the token amounts, and dumped
  the entire value difference into (or out of) MolePositions' own ERC20 balance via `_settleNet`.
  That balance was one unattributed pot shared by every position, which is what turned a
  "degraded returns" keeper into a thief.

  CURRENT VERDICT (2026-08-03, re-run against the fixed contract). F-1 through F-5 are DEAD, and
  every one of them died to the same two lines of the fix:

      * `rebalance()` derives the new liquidity from the amounts the burn actually returned, via
        LiquidityAmounts.getLiquidityForAmounts at the new range (rounds down). Token AMOUNTS are
        conserved; the liquidity NUMBER is free to move.
      * `_settleNet` is gone. Nothing in the contract takes to `address(this)` and nothing pays
        from it, so the shared pot cannot exist. Leftover dust goes to the OWNER via `_collectTo`.

  The tests below were the exploits. They are now regressions, and each one asserts the SPECIFIC
  property that killed its exploit rather than a revert string, because the property survives a
  refactor and a revert string does not. The attack setup in each is unchanged: every one of them
  still performs the original hostile sequence, keeper and all, and would fail again the moment
  the old behaviour returned.

  THE LOAD-BEARING INVARIANT, asserted by `_assertNoInventory` in every rebalance test:

      MolePositions' own token balance is EXACTLY ZERO at every observable point.

  That single number is what `_settleNet` used to accumulate. F-1 (confiscation), F-2 (keeper
  theft), F-3 (fee sweep) and F-5 (permanently stranded funds) are all statements about it being
  non-zero. Pin it at zero and all four are structurally impossible, not merely unexploited.

  ------------------------------------------------------------------------------------------------
  F-1  FIXED  — a narrowing rebalance no longer confiscates principal.
       WAS: `rebalance` burned `liq` at the old range and re-minted the SAME `liq` at the new one.
       Same liquidity over a narrower range is worth far less, and the difference — the user's
       principal — was `take()`n to `address(this)` where no function could pay it back out.
       MEASURED THEN: [-6000,6000] -> [-60,60] on a 100e18 position took 25.617e18 of each token
       from Alice, 98.84% of her principal.
       NOW: the same call re-mints the token amounts, so the same tokens buy ~86x MORE liquidity at
       the narrow range; the contract balance stays at exactly 0 and Alice exits with everything
       she paid in, minus single-wei rounding.
       regression: test_regression_narrowingRebalanceLeavesPrincipalWithTheOwner
       fuzzed:     testFuzz_regression_narrowingRebalanceConfiscatesNothing,
                   testFuzz_regression_partialThenRebalanceThenExitPreservesValue

  F-2  FIXED  — a compromised keeper cannot take a token. The security claim now holds.
       WAS: the confiscated balance was spendable, because `_settleNet` funded a *negative* net
       rebalance out of `address(this)`. The keeper (1) stripped victims wide->narrow to fill the
       contract, (2) opened its OWN razor-thin position for pennies, (3) rebalanced it narrow->wide
       out of the victims' principal, (4) withdrew to itself through the ordinary owner-only path.
       MEASURED THEN: 0.2965e18 in, 25.361e18 out. An 85x return funded entirely by two victims.
       NOW: the identical four-step sequence runs to completion and the pot is 0 at every step, so
       step 3 has nothing to spend. The keeper's widening rebalance simply buys LESS liquidity with
       its own tokens, and it exits with less than it deposited. The victims keep their principal.
       regression: test_regression_compromisedKeeperCannotDrainVictimPrincipal

  F-3  FIXED  — a rebalance no longer confiscates accrued fees; it compounds them.
       WAS: `modifyLiquidity`'s callerDelta = principalDelta + feesAccrued, so on the burn leg the
       fees rode into `net` and were taken to `address(this)`. Rebalancing to the identical tick
       range was a pure fee-theft primitive, and `minRebalanceInterval` being per-position made it
       a standing tax on 100% of every position's fee income.
       MEASURED THEN: the rebalanced LP exited with exactly 0.2e18 less than a byte-identical
       control LP, and 0.2e18 was exactly what landed in the contract.
       NOW: those fees are part of `have0/have1`, so they are re-minted into the OWNER's position.
       A same-range rebalance therefore strictly INCREASES p.liquidity, and the rebalanced LP exits
       level with the control instead of behind it.
       regression: test_regression_sameRangeRebalanceCompoundsFeesIntoTheOwnerPosition

  F-4  FIXED  — rebalance is no longer one-directional.
       WAS: with a zero contract balance a value-increasing (narrow -> wide) rebalance had to be
       paid out of `address(this)`, which held nothing, so it reverted TransferFailed. Widening was
       a permanent DoS until someone had first been robbed via F-1.
       NOW: widening re-mints the amounts it just burned, which at a wider range is simply less
       liquidity. It is self-funding by construction on a contract that holds nothing, which is the
       only state this contract is ever in.
       regression: test_regression_wideningRebalanceIsSelfFundedOnACleanContract

  F-5  FIXED  — nothing can be stranded, because nothing is ever collected.
       WAS: funds confiscated by F-1/F-3 were unreachable by everyone. No sweep, no rescue, no
       collect. They could only ever be spent subsidising some other position's rebalance.
       NOW: there is no residue to strand. Every wei the burn leg returns is either re-minted into
       the owner's position or paid to the owner as dust in the same transaction.
       regression: test_regression_rebalanceStrandsNothingInTheContract

  ------------------------------------------------------------------------------------------------
  CORRECTED SEMANTICS (tests that encoded the OLD, wrong model and are now rewritten):

  S-1  A position's liquidity NUMBER is NOT conserved across a rebalance, and must not be. The token
       value of a fixed L is a function of range width, so conserving L is exactly what moved value
       between positions. Narrowing buys more L, widening buys less. Any test that opens with L,
       rebalances, then withdraws the literal L is asserting the bug. `test_attack_storedLiquidity
       AlwaysMatchesPoolManager` did that; it now reads the stored liquidity back and pins the real
       invariant — stored liquidity equals PoolManager liquidity at the CURRENT range, always.

  ------------------------------------------------------------------------------------------------
  Things I attacked and could NOT break, before or after the fix (unchanged, still passing):

  M-1  MITIGATED — withdraw() decrementing `p.liquidity` before the unlock is safe.
       I made a pool currency a malicious ERC20 that re-enters `withdraw()` from inside
       `poolManager.take()`. The re-entrant call reverts with IPoolManager.AlreadyUnlocked because
       every MolePositions entry point must open a fresh unlock. The optimistic decrement is
       therefore unobservable to any reentrant reader.
       test: test_attack_reentrantTokenCannotDoubleWithdrawDuringTake

  M-2  MITIGATED — positions with IDENTICAL tick ranges in the same pool are independent.
       salt = bytes32(id) keeps them in separate PoolManager position slots; a full withdraw by one
       user does not move the other user's `p.liquidity` or payout by a single wei.
       test: test_attack_identicalRangeNeighborCannotDrainVictim

  M-3  MITIGATED — no free money from rounding on open -> partial withdraw -> withdraw rest.
       Fuzzed over (liquidity 1e6..1e22, tick range, partial fraction). The user never receives more
       than they paid in either token, and never loses more than 4 wei per token.
       tests: testFuzz_attack_openPartialWithdrawIsNeverProfitable,
              testFuzz_attack_dustLiquidityIsNeverProfitable

  M-4  MITIGATED — uint128 liquidity cannot be wrapped through the int256 cast.
       `int256(uint256(liquidity))` is widening and cannot wrap; PoolManager's
       `liquidityDelta.toInt128()` catches everything >= 2**127 with SafeCastOverflow, and
       maxLiquidityPerTick catches the rest.
       test: test_attack_hugeLiquidityCannotWrapTheInt128Cast

  M-5  MITIGATED — fee farming by repeated 1-wei withdrawals does not pay.
       A partial withdraw does collect 100% of accrued fees (correct for a per-user position, since
       the fees are the position's own). Splitting the exit into many 1-wei withdrawals earns
       strictly less than a single exit because every burn leg rounds principal down.
       test: test_attack_oneWeiWithdrawLoopCannotFarmFees

  M-6  MITIGATED — no dust is left in MolePositions after a clean open/withdraw cycle.
       Rounding dust stays inside the PoolManager and accrues to the pool (i.e. the other LPs),
       which is the correct owner. MEASURED: exactly 1 wei per token per open/withdraw cycle
       (5 wei over 5 cycles), and the MolePositions balance is 0 at every step.
       test: test_attack_noDustStrandedInContractOnCleanCycle

  M-8  MITIGATED — no caller-supplied payout target. Non-owner and keeper withdrawals revert
       NotOwner; there is no recipient parameter to abuse. Claims 1, 2 and 4 hold.
       test: test_attack_nonOwnerAndKeeperCannotWithdraw

  ------------------------------------------------------------------------------------------------
  CHAIN NOTE. None of these attacks depended on `block.number` semantics, on a mempool, or on
  transaction ordering, so the Robinhood Chain L1-paced `block.number` / no-mempool environment
  neither enabled nor blocked any of them. `vm.warp` is used only to clear the per-position
  `minRebalanceInterval`, which is what the keeper tests need to run two rebalances of the same id.

  ------------------------------------------------------------------------------------------------
  HOW TO RUN. Plain `forge test`; foundry.toml now carries optimizer_runs = 44444444, which is what
  v4-core needs to compile at all (at 800 solc 0.8.26 + via_ir dies with a Yul "1 too deep in the
  stack" inside Pool.swap, and every Deployers-importing test silently fails to build).

      forge test --match-path 'test/attack/AttackAccounting.t.sol'

//////////////////////////////////////////////////////////////////////////////*/

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Position as V4Position} from "v4-core/libraries/Position.sol";
import {SafeCast} from "v4-core/libraries/SafeCast.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                          malicious currency for M-1
//////////////////////////////////////////////////////////////////////////////*/

/// @notice An ERC20 that hijacks control on every transfer/transferFrom and tries to re-enter
///         MolePositions while the PoolManager is unlocked. It swallows the inner revert so the
///         outer flow still completes and the test can inspect exactly why the re-entry failed.
contract ReentrantToken {
    string public name = "REENTRANT";
    string public symbol = "RE";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target; // MolePositions
    bytes public payload;
    bool public armed;

    bool public fired;
    bool public innerSuccess;
    bytes public innerReturn;

    function arm(address _target, bytes memory _payload) external {
        target = _target;
        payload = _payload;
        armed = true;
        fired = false;
        innerSuccess = false;
        innerReturn = "";
    }

    function disarm() external {
        armed = false;
    }

    function _maybeReenter() internal {
        if (!armed || fired) return;
        fired = true;
        (bool ok, bytes memory ret) = target.call(payload);
        innerSuccess = ok;
        innerReturn = ret;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        _maybeReenter();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        _maybeReenter();
        return true;
    }
}

/// @notice A position OWNER that is a contract, so the hostile token can bounce the re-entrant call
///         back through the only address `onlyPositionOwner` will accept. Without this the re-entry
///         dies on NotOwner and never reaches the interesting code.
contract EvilOwner {
    MolePositions public immutable mole;
    uint256 public id;

    bool public fired;
    bool public innerSuccess;
    bytes public innerReturn;

    constructor(MolePositions _mole) {
        mole = _mole;
    }

    function openPosition(PoolKey memory k, int24 lo, int24 hi, uint128 liq) external {
        id = mole.open(k, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function withdrawOutside(uint128 amount) external {
        mole.withdraw(id, amount);
    }

    /// @dev Called by the hostile token from inside poolManager.take(), i.e. while the PoolManager
    ///      is unlocked and while `p.liquidity` has already been optimistically decremented.
    function poke() external {
        if (fired) return;
        fired = true;
        (bool ok, bytes memory ret) =
            address(mole).call(abi.encodeWithSelector(MolePositions.withdraw.selector, id, uint128(1)));
        innerSuccess = ok;
        innerReturn = ret;
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                    the attacks
//////////////////////////////////////////////////////////////////////////////*/

contract AttackAccounting is Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    MolePositions internal mole;

    address internal constant KEEPER = address(0xdeadbeef01);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    uint32 internal constant MIN_REBAL_INTERVAL = 1 hours;
    int24 internal constant MIN_WIDTH = 60;
    int24 internal constant MAX_WIDTH = 20_000;

    int24 internal constant SPACING = 60;
    uint24 internal constant FEE = 3000;

    /// @dev Total wei a user may lose to v4's round-against-the-LP behaviour across one full
    ///      open -> (partial withdraw) -> rebalance -> withdraw cycle, per token. Every leg rounds
    ///      the LP down by at most a wei, and a rebalance is two legs. This is deliberately a hard
    ///      absolute bound and NOT a percentage: the pre-fix bug lost 98.8% of a deposit, so any
    ///      tolerance expressed as a fraction of principal would have let it through.
    uint256 internal constant DUST_TOLERANCE = 8;

    PoolId internal poolId;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        (key, poolId) = initPool(currency0, currency1, IHooks(address(0)), FEE, SPACING, SQRT_PRICE_1_1);

        // Deep background liquidity so our positions are never the whole book and swaps can execute.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );

        mole = deployMoleVault(manager, KEEPER, MIN_REBAL_INTERVAL, MIN_WIDTH, MAX_WIDTH, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        mole.whitelistPool(key);

        _fund(ALICE);
        _fund(BOB);
        _fund(KEEPER);
    }

    /* ------------------------------------------------------------------ helpers */

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 1e30);
        MockERC20(Currency.unwrap(currency1)).mint(who, 1e30);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(mole), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    function _moleBal() internal view returns (uint256, uint256) {
        return _bal(address(mole));
    }

    /// @dev THE property that killed F-1, F-2, F-3 and F-5 in one stroke: MolePositions has no
    ///      inventory. `_settleNet` was the only code that could give it one, by taking a rebalance
    ///      surplus to `address(this)` and paying a rebalance deficit out of it — one unattributed
    ///      pot shared by every position, which is precisely the bridge the keeper walked across.
    ///      If either of these numbers is ever non-zero the pot is back and all four exploits are
    ///      live again, whatever the revert strings say.
    function _assertNoInventory(string memory where) internal view {
        (uint256 m0, uint256 m1) = _moleBal();
        assertEq(m0, 0, string.concat("contract holds token0 inventory @ ", where));
        assertEq(m1, 0, string.concat("contract holds token1 inventory @ ", where));
    }

    function _open(address who, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = mole.open(key, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function _withdraw(address who, uint256 id, uint128 liq) internal {
        vm.prank(who);
        mole.withdraw(id, liq);
    }

    /// @dev Exit whatever the position actually holds. Post-fix, the liquidity NUMBER moves across a
    ///      rebalance (that is the fix), so "withdraw the amount I opened with" is not a valid exit
    ///      and asserting it closes the position is asserting the bug. See S-1.
    function _withdrawAll(address who, uint256 id) internal returns (uint128 exited) {
        exited = mole.getPosition(id).liquidity;
        vm.prank(who);
        mole.withdraw(id, exited);
    }

    function _rebalance(uint256 id, int24 lo, int24 hi) internal {
        vm.prank(KEEPER);
        mole.rebalance(id, lo, hi);
    }

    function _onChainLiquidity(uint256 id, int24 lo, int24 hi) internal view returns (uint128) {
        bytes32 posKey = V4Position.calculatePositionKey(address(mole), lo, hi, bytes32(id));
        return manager.getPositionLiquidity(poolId, posKey);
    }

    /// @dev Round-trip swaps that leave the price where it started but pay LP fees on the way.
    function _churnFees(uint256 amount, uint256 rounds) internal {
        for (uint256 i; i < rounds; ++i) {
            swap(key, true, -int256(amount), ZERO_BYTES);
            swap(key, false, -int256(amount), ZERO_BYTES);
        }
    }

    /* ==========================================================================================
                       F-1  a narrowing rebalance keeps the principal with the owner
       ========================================================================================== */

    /// REGRESSION (was test_attack_keeperRebalanceConfiscatesPrincipalIntoContract). It used to prove
    /// that a wide->narrow rebalance took 98.8% of Alice's principal into address(this); it now pins
    /// that the contract's balance stays exactly 0 and the narrowing BUYS liquidity for her instead.
    function test_regression_narrowingRebalanceLeavesPrincipalWithTheOwner() public {
        uint128 liq = 100e18;

        (uint256 a0Before, uint256 a1Before) = _bal(ALICE);
        uint256 id = _open(ALICE, -6000, 6000, liq);
        (uint256 a0AfterOpen, uint256 a1AfterOpen) = _bal(ALICE);

        uint256 paid0 = a0Before - a0AfterOpen;
        uint256 paid1 = a1Before - a1AfterOpen;
        assertGt(paid0, 0, "alice must have paid token0");
        assertGt(paid1, 0, "alice must have paid token1");

        _assertNoInventory("before rebalance");

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        _rebalance(id, -60, 60); // the exact wide -> narrow move that used to strip her

        // Token amounts are conserved, so the liquidity NUMBER must move: the same tokens over a
        // 100x narrower range buy far more L. A test that finds L unchanged here has found the bug.
        uint128 newLiq = mole.getPosition(id).liquidity;
        assertGt(newLiq, liq, "narrowing must BUY liquidity for the owner, not surrender it");

        // ...and the surplus that used to fund the keeper is not anywhere, because it was never a
        // surplus: it is inside her own position.
        _assertNoInventory("after narrowing rebalance");

        _withdraw(ALICE, id, newLiq);
        (uint256 a0End, uint256 a1End) = _bal(ALICE);

        uint256 got0 = a0End - a0AfterOpen;
        uint256 got1 = a1End - a1AfterOpen;

        // She recovers everything she paid in, to the wei. (Pre-fix: got0 < paid0 / 50.)
        assertLe(got0, paid0, "FREE MONEY in token0");
        assertLe(got1, paid1, "FREE MONEY in token1");
        assertGe(got0 + DUST_TOLERANCE, paid0, "alice lost more than rounding dust in token0");
        assertGe(got1 + DUST_TOLERANCE, paid1, "alice lost more than rounding dust in token1");

        assertEq(mole.getPosition(id).liquidity, 0, "position fully closed");
        _assertNoInventory("after exit");
    }

    /* ==========================================================================================
                  F-2  a compromised keeper takes nothing — the headline claim now holds
       ========================================================================================== */

    /// REGRESSION (was test_attack_compromisedKeeperDrainsVictimPrincipalToItself). It used to prove
    /// the full four-step theft chain paying the keeper 85x its own stake out of two victims; the
    /// identical chain now runs to completion with the shared pot at 0 at every step, so step 3 has
    /// nothing to spend and the keeper exits poorer than it arrived.
    ///
    /// The claim under test is verbatim:
    ///   "a fully compromised keeper key can degrade returns. It cannot take a token."
    function test_regression_compromisedKeeperCannotDrainVictimPrincipal() public {
        uint128 victimLiq = 100e18;
        uint128 keeperLiq = 99e18;

        // --- victims ---------------------------------------------------------------------------
        (uint256 alice0, uint256 alice1) = _bal(ALICE);
        uint256 aliceId = _open(ALICE, -6000, 6000, victimLiq);
        (uint256 aliceOpen0, uint256 aliceOpen1) = _bal(ALICE);
        uint256 alicePaid0 = alice0 - aliceOpen0;
        uint256 alicePaid1 = alice1 - aliceOpen1;

        uint256 bobId = _open(BOB, -6000, 6000, victimLiq);

        // --- keeper's own position, opened for pennies at a razor-thin range ---------------------
        (uint256 k0Start, uint256 k1Start) = _bal(KEEPER);
        uint256 keeperId = _open(KEEPER, -60, 60, keeperLiq);
        (uint256 k0AfterOpen, uint256 k1AfterOpen) = _bal(KEEPER);
        uint256 keeperCost0 = k0Start - k0AfterOpen;
        uint256 keeperCost1 = k1Start - k1AfterOpen;
        assertGt(keeperCost0 + keeperCost1, 0, "keeper must really have funded its own position");

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);

        // Step 1: strip the victims wide -> narrow. This is where their principal used to land in
        //         the contract. There is now nothing to land: it stays in their own positions.
        _rebalance(aliceId, -60, 60);
        _rebalance(bobId, -60, 60);
        _assertNoInventory("after stripping both victims");

        // Step 2: pump the keeper's own position narrow -> wide. This is the leg that used to be
        //         paid for out of the pot. It still executes — but it is funded exclusively by the
        //         keeper's OWN burned tokens, so widening simply buys it LESS liquidity.
        uint128 keeperLiqBefore = mole.getPosition(keeperId).liquidity;
        _rebalance(keeperId, -6000, 6000);
        uint128 keeperLiqAfter = mole.getPosition(keeperId).liquidity;
        assertLt(keeperLiqAfter, keeperLiqBefore, "widening must COST liquidity, not be subsidised");
        _assertNoInventory("after the keeper pumps its own position");

        // Step 3: the keeper withdraws everything it has through the ordinary owner-only path.
        _withdrawAll(KEEPER, keeperId);
        (uint256 k0End, uint256 k1End) = _bal(KEEPER);

        // THE CLAIM: no token was taken. The keeper cannot end up ahead, in either token, ever.
        assertLe(k0End, k0Start, "KEEPER PROFIT in token0 -- the theft path is back");
        assertLe(k1End, k1Start, "KEEPER PROFIT in token1 -- the theft path is back");
        // ...and its loss is rounding dust, i.e. it got its own money back and nothing else.
        assertGe(k0End + DUST_TOLERANCE, k0Start, "keeper lost more than dust to its own rebalance");
        assertGe(k1End + DUST_TOLERANCE, k1Start, "keeper lost more than dust to its own rebalance");

        // And the victims are whole: they exit with the principal they deposited.
        _withdrawAll(ALICE, aliceId);
        (uint256 aliceEnd0, uint256 aliceEnd1) = _bal(ALICE);
        uint256 aliceGot0 = aliceEnd0 - aliceOpen0;
        uint256 aliceGot1 = aliceEnd1 - aliceOpen1;
        assertLe(aliceGot0, alicePaid0, "FREE MONEY for the victim in token0");
        assertLe(aliceGot1, alicePaid1, "FREE MONEY for the victim in token1");
        assertGe(aliceGot0 + DUST_TOLERANCE, alicePaid0, "victim lost token0 to the keeper");
        assertGe(aliceGot1 + DUST_TOLERANCE, alicePaid1, "victim lost token1 to the keeper");

        _withdrawAll(BOB, bobId);
        _assertNoInventory("after every position is closed");
    }

    /* ==========================================================================================
                              F-3  a rebalance compounds fees, it does not eat them
       ========================================================================================== */

    /// REGRESSION (was test_attack_rebalanceToIdenticalRangeStealsAllAccruedFees). It used to prove
    /// that a no-op same-range rebalance swept 100% of accrued fees into address(this); it now pins
    /// that those fees are re-minted into the owner's own position, so a same-range rebalance
    /// strictly INCREASES p.liquidity and the rebalanced LP exits level with an untouched control.
    function test_regression_sameRangeRebalanceCompoundsFeesIntoTheOwnerPosition() public {
        uint128 liq = 500e18;
        uint256 id = _open(ALICE, -600, 600, liq);

        // Control: a byte-identical position that will NOT be rebalanced.
        uint256 controlId = _open(BOB, -600, 600, liq);

        (uint256 a0, uint256 a1) = _bal(ALICE);
        (uint256 b0, uint256 b1) = _bal(BOB);

        _churnFees(50e18, 8);
        _assertNoInventory("after fee churn");

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        // Same range in, same range out: the pure fee-theft primitive, unchanged.
        _rebalance(id, -600, 600);

        // The fees came back on the burn leg and went straight back in on the mint leg. Nothing was
        // swept, so there is nothing in the contract to sweep it to.
        _assertNoInventory("after the same-range rebalance");

        MolePositions.Position memory p = mole.getPosition(id);
        assertEq(p.tickLower, int24(-600), "range unchanged");
        assertEq(p.tickUpper, int24(600), "range unchanged");
        assertGt(p.liquidity, liq, "accrued fees must COMPOUND into the owner position");

        // Alice and Bob exit identical positions. Neither is taxed.
        _withdrawAll(ALICE, id);
        (uint256 a0b, uint256 a1b) = _bal(ALICE);

        _withdrawAll(BOB, controlId);
        (uint256 b0b, uint256 b1b) = _bal(BOB);

        uint256 aliceOut = (a0b - a0) + (a1b - a1);
        uint256 bobOut = (b0b - b0) + (b1b - b1);

        // Pre-fix this was `assertLt(aliceOut, bobOut)` and the gap was exactly what the contract
        // had swept. The rebalanced LP must now come out level with the control.
        assertGe(aliceOut + DUST_TOLERANCE, bobOut, "rebalanced LP was taxed relative to the control");
        _assertNoInventory("after both exits");

        emit log_named_uint("alice out (rebalanced)", aliceOut);
        emit log_named_uint("bob   out (control)   ", bobOut);
    }

    /* ==========================================================================================
                     F-4  widening is self-funding on a contract that holds nothing
       ========================================================================================== */

    /// REGRESSION (was test_attack_rebalanceWideningRevertsOnCleanContract). It used to prove that a
    /// narrow->wide rebalance was a permanent DoS until someone had been robbed to fill the pot; it
    /// now pins that widening succeeds against a zero balance and pays for itself by minting LESS
    /// liquidity from the same tokens, leaving the contract balance still exactly 0.
    function test_regression_wideningRebalanceIsSelfFundedOnACleanContract() public {
        uint128 liq = 100e18;

        (uint256 a0Before, uint256 a1Before) = _bal(ALICE);
        uint256 id = _open(ALICE, -60, 60, liq);
        (uint256 a0AfterOpen, uint256 a1AfterOpen) = _bal(ALICE);
        uint256 paid0 = a0Before - a0AfterOpen;
        uint256 paid1 = a1Before - a1AfterOpen;

        // The precondition of the old finding: the contract has no inventory to pay a deficit from.
        // That is now the contract's permanent state rather than a temporary embarrassment.
        _assertNoInventory("before widening");

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        _rebalance(id, -6000, 6000);

        uint128 newLiq = mole.getPosition(id).liquidity;
        assertGt(newLiq, 0, "widening must leave a live position");
        assertLt(newLiq, liq, "widening the range must cost liquidity -- the tokens are unchanged");
        _assertNoInventory("after widening");

        // No value was created out of the empty balance either: she still has what she paid in.
        _withdrawAll(ALICE, id);
        (uint256 a0End, uint256 a1End) = _bal(ALICE);
        assertLe(a0End - a0AfterOpen, paid0, "FREE MONEY: widening minted token0 out of nowhere");
        assertLe(a1End - a1AfterOpen, paid1, "FREE MONEY: widening minted token1 out of nowhere");
        assertGe(a0End - a0AfterOpen + DUST_TOLERANCE, paid0, "widening lost the owner token0");
        assertGe(a1End - a1AfterOpen + DUST_TOLERANCE, paid1, "widening lost the owner token1");
        _assertNoInventory("after exit");
    }

    /* ==========================================================================================
                            F-5  nothing can be stranded, because nothing is collected
       ========================================================================================== */

    /// REGRESSION (was test_attack_confiscatedFundsAreUnrecoverableByOwner). It used to prove that
    /// principal captured by a narrowing rebalance was unreachable by anyone including its owner —
    /// no sweep, no rescue; it now pins that there is no residue at all, before or after the owner
    /// closes the position, so there is nothing left for a future rescue function to be needed for.
    function test_regression_rebalanceStrandsNothingInTheContract() public {
        uint128 liq = 100e18;

        (uint256 a0Before, uint256 a1Before) = _bal(ALICE);
        uint256 id = _open(ALICE, -6000, 6000, liq);
        (uint256 a0AfterOpen, uint256 a1AfterOpen) = _bal(ALICE);
        uint256 paid0 = a0Before - a0AfterOpen;
        uint256 paid1 = a1Before - a1AfterOpen;

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        _rebalance(id, -60, 60);
        _assertNoInventory("immediately after the rebalance");

        // Alice exits completely. The position dies with nothing behind it.
        uint128 exited = _withdrawAll(ALICE, id);
        assertGt(exited, 0, "there must have been a live position to close");
        assertEq(mole.getPosition(id).liquidity, 0, "position fully closed");
        _assertNoInventory("after the owner has fully exited");

        // And she left with her principal rather than a rounding-error fraction of it.
        (uint256 a0End, uint256 a1End) = _bal(ALICE);
        assertGe(a0End - a0AfterOpen + DUST_TOLERANCE, paid0, "token0 principal was stranded");
        assertGe(a1End - a1AfterOpen + DUST_TOLERANCE, paid1, "token1 principal was stranded");

        // The surface still has no sweep and needs none: a closed position pays out nothing more.
        vm.prank(ALICE);
        vm.expectRevert(MolePositions.InsufficientLiquidity.selector);
        mole.withdraw(id, 1);
    }

    /* ==========================================================================================
                  M-1  reentrancy against the pre-unlock `p.liquidity` decrement
       ========================================================================================== */

    /// @notice `withdraw()` writes `p.liquidity -= liquidityToRemove` BEFORE it opens the unlock.
    ///         If anything could observe or re-enter during the unlock, that optimistic write would
    ///         be a double-withdraw primitive. I made a pool currency hostile and re-entered from
    ///         inside `poolManager.take()`. It cannot work: MolePositions has no internal entry
    ///         point that reuses an open unlock, so the re-entrant call dies on AlreadyUnlocked.
    function test_attack_reentrantTokenCannotDoubleWithdrawDuringTake() public {
        // Build a second pool where currency0/currency1 include the hostile token.
        ReentrantToken evil = new ReentrantToken();
        MockERC20 good = new MockERC20("GOOD", "GOOD", 18);

        (Currency c0, Currency c1) = address(evil) < address(good)
            ? (Currency.wrap(address(evil)), Currency.wrap(address(good)))
            : (Currency.wrap(address(good)), Currency.wrap(address(evil)));

        PoolKey memory k = PoolKey({currency0: c0, currency1: c1, fee: FEE, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(k, SQRT_PRICE_1_1);
        mole.whitelistPool(k);

        evil.mint(address(this), 1e30);
        good.mint(address(this), 1e30);
        evil.mint(ALICE, 1e30);
        good.mint(ALICE, 1e30);

        evil.approve(address(modifyLiquidityRouter), type(uint256).max);
        good.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1_000e18, salt: 0}),
            ZERO_BYTES
        );

        // The position owner is a CONTRACT, so the hostile token can bounce the re-entrant call back
        // through the only msg.sender that `onlyPositionOwner` accepts.
        EvilOwner evilOwner = new EvilOwner(mole);
        evil.mint(address(evilOwner), 1e30);
        good.mint(address(evilOwner), 1e30);
        vm.startPrank(address(evilOwner));
        evil.approve(address(mole), type(uint256).max);
        good.approve(address(mole), type(uint256).max);
        vm.stopPrank();

        uint128 liq = 10e18;
        evilOwner.openPosition(k, -600, 600, liq);
        uint256 id = evilOwner.id();

        // --- probe 1: re-enter directly from the token. Blocked before it can do anything, because
        //     the owner check is on msg.sender and the token is not the owner.
        evil.arm(address(mole), abi.encodeWithSelector(MolePositions.withdraw.selector, id, uint128(1)));
        evilOwner.withdrawOutside(1e18);
        assertTrue(evil.fired(), "probe 1 must actually have run");
        assertFalse(evil.innerSuccess(), "probe 1 must not succeed");
        assertEq(
            bytes32(bytes4(evil.innerReturn())),
            bytes32(MolePositions.NotOwner.selector),
            "a foreign reentrant caller is stopped by the owner check"
        );

        // --- probe 2: the real attack. Bounce through the OWNER while `p.liquidity` has already
        //     been optimistically decremented and the PoolManager is still unlocked. If MolePositions
        //     had any path that reused an open unlock, this is where a double-withdraw would land.
        evil.arm(address(evilOwner), abi.encodeWithSelector(EvilOwner.poke.selector));

        uint128 second = 4e18;
        evilOwner.withdrawOutside(second);

        assertTrue(evil.fired(), "the reentrancy attempt must actually have run");
        assertTrue(evilOwner.fired(), "the owner-mediated re-entry must actually have run");
        assertFalse(evilOwner.innerSuccess(), "MITIGATED: the reentrant withdraw did not succeed");

        bytes memory ret = evilOwner.innerReturn();
        assertEq(ret.length, 4, "expected a bare 4-byte custom error");
        assertEq(
            bytes32(bytes4(ret)),
            bytes32(IPoolManager.AlreadyUnlocked.selector),
            "MITIGATED: reentrancy is stopped by the PoolManager unlock, not by luck"
        );

        // And the optimistic decrement matched reality exactly: no extra liquidity was removed.
        uint128 expected = liq - 1e18 - second;
        assertEq(mole.getPosition(id).liquidity, expected, "stored liquidity correct");
        bytes32 posKey = V4Position.calculatePositionKey(address(mole), -600, 600, bytes32(id));
        assertEq(manager.getPositionLiquidity(k.toId(), posKey), expected, "on-chain liquidity matches");
    }

    /* ==========================================================================================
                             M-2  two positions, identical tick range
       ========================================================================================== */

    function test_attack_identicalRangeNeighborCannotDrainVictim() public {
        uint128 liq = 100e18;

        (uint256 a0, uint256 a1) = _bal(ALICE);
        uint256 aliceId = _open(ALICE, -600, 600, liq);
        (uint256 a0Open, uint256 a1Open) = _bal(ALICE);
        uint256 alicePaid0 = a0 - a0Open;
        uint256 alicePaid1 = a1 - a1Open;

        uint256 bobId = _open(BOB, -600, 600, liq); // byte-identical range, same pool

        assertTrue(aliceId != bobId, "distinct ids");

        // Bob exits everything, twice over if he can.
        _withdraw(BOB, bobId, liq);
        vm.prank(BOB);
        vm.expectRevert(MolePositions.InsufficientLiquidity.selector);
        mole.withdraw(bobId, 1);

        // Alice is untouched, on-chain and in storage.
        assertEq(mole.getPosition(aliceId).liquidity, liq, "victim storage untouched");
        assertEq(_onChainLiquidity(aliceId, -600, 600), liq, "victim pool position untouched");

        _withdraw(ALICE, aliceId, liq);
        (uint256 a0End, uint256 a1End) = _bal(ALICE);

        assertApproxEqAbs(a0End - a0Open, alicePaid0, 2, "victim got her token0 back");
        assertApproxEqAbs(a1End - a1Open, alicePaid1, 2, "victim got her token1 back");
    }

    /* ==========================================================================================
                    M-3  fuzz: open -> partial withdraw -> withdraw rest, no free money
       ========================================================================================== */

    /// @notice The no-free-money / no-silent-theft envelope for the honest path (no rebalance).
    ///         Price never moves here, so a correct implementation returns exactly what went in,
    ///         minus at most a couple of wei of burn-side rounding per withdraw leg.
    function testFuzz_attack_openPartialWithdrawIsNeverProfitable(
        uint128 liqRaw,
        int24 loRaw,
        int24 widthRaw,
        uint16 fracBps
    ) public {
        uint128 liq = uint128(bound(uint256(liqRaw), 1e6, 1e22));
        int24 lo = int24(bound(int256(loRaw), -6000, 5000) / SPACING * SPACING);
        int24 width = int24(bound(int256(widthRaw), int256(MIN_WIDTH), 12_000) / SPACING * SPACING);
        if (width < MIN_WIDTH) width = MIN_WIDTH;
        int24 hi = lo + width;
        uint256 frac = bound(uint256(fracBps), 1, 9999);

        uint128 part = uint128((uint256(liq) * frac) / 10_000);
        if (part == 0) part = 1;
        if (part >= liq) part = liq - 1;

        (uint256 b0, uint256 b1) = _bal(ALICE);
        uint256 id = _open(ALICE, lo, hi, liq);
        (uint256 o0, uint256 o1) = _bal(ALICE);
        uint256 paid0 = b0 - o0;
        uint256 paid1 = b1 - o1;

        _withdraw(ALICE, id, part);
        _withdraw(ALICE, id, liq - part);

        (uint256 e0, uint256 e1) = _bal(ALICE);
        uint256 got0 = e0 - o0;
        uint256 got1 = e1 - o1;

        // No free money: an LP with no fees and no price movement can never come out ahead.
        assertLe(got0, paid0, "FREE MONEY in token0");
        assertLe(got1, paid1, "FREE MONEY in token1");

        // No silent theft: the loss is bounded dust (1 wei mint round-up + 1 wei per burn leg).
        assertGe(got0 + 4, paid0, "token0 loss exceeded the rounding-dust bound");
        assertGe(got1 + 4, paid1, "token1 loss exceeded the rounding-dust bound");

        // Position is fully closed and the contract kept nothing.
        assertEq(mole.getPosition(id).liquidity, 0, "position not fully closed");
        _assertNoInventory("after the honest open/withdraw path");
    }

    /// @notice Same envelope at the extreme low end, where rounding has the most leverage.
    function testFuzz_attack_dustLiquidityIsNeverProfitable(uint8 liqRaw, int24 loRaw, int24 widthRaw) public {
        uint128 liq = uint128(bound(uint256(liqRaw), 1, 255));
        int24 lo = int24(bound(int256(loRaw), -6000, 5000) / SPACING * SPACING);
        int24 width = int24(bound(int256(widthRaw), int256(MIN_WIDTH), 12_000) / SPACING * SPACING);
        if (width < MIN_WIDTH) width = MIN_WIDTH;
        int24 hi = lo + width;

        (uint256 b0, uint256 b1) = _bal(ALICE);
        uint256 id = _open(ALICE, lo, hi, liq);
        (uint256 o0, uint256 o1) = _bal(ALICE);

        _withdraw(ALICE, id, liq);
        (uint256 e0, uint256 e1) = _bal(ALICE);

        assertLe(e0, b0, "FREE MONEY: dust position minted token0 out of nothing");
        assertLe(e1, b1, "FREE MONEY: dust position minted token1 out of nothing");
        assertLe(e0 - o0, b0 - o0, "burn returned more token0 than the mint charged");
        assertLe(e1 - o1, b1 - o1, "burn returned more token1 than the mint charged");
    }

    /* ==========================================================================================
                                M-4  uint128 -> int256 -> int128 casts
       ========================================================================================== */

    function test_attack_hugeLiquidityCannotWrapTheInt128Cast() public {
        // 2**128-1 : the widening int256(uint256(x)) cast cannot wrap, so PoolManager's
        // liquidityDelta.toInt128() is the thing that has to catch it. It does.
        vm.prank(ALICE);
        vm.expectRevert(SafeCast.SafeCastOverflow.selector);
        mole.open(key, -60, 60, type(uint128).max, type(uint256).max, type(uint256).max, block.timestamp);

        // Exactly 2**127 is the first value whose int128 reinterpretation is negative. If the cast
        // wrapped, this would be a *removal* dressed up as an open.
        vm.prank(ALICE);
        vm.expectRevert(SafeCast.SafeCastOverflow.selector);
        mole.open(key, -60, 60, uint128(1) << 127, type(uint256).max, type(uint256).max, block.timestamp);

        // 2**127-1 casts cleanly and is then rejected by the per-tick liquidity cap, not silently
        // truncated.
        vm.prank(ALICE);
        vm.expectRevert();
        mole.open(key, -60, 60, uint128((uint128(1) << 127) - 1), type(uint256).max, type(uint256).max, block.timestamp);

        // Nothing was opened.
        assertEq(mole.positionCount(), 0, "no position should have been created");
    }

    /* ==========================================================================================
                       M-5  fee accrual on partial withdraw / 1-wei farming
       ========================================================================================== */

    /// @notice A partial withdraw collects 100% of the position's accrued fees, not a pro-rata
    ///         slice. For a per-user position that is the correct behaviour — the fees are the
    ///         position's own. The attack is whether slicing the exit into many tiny withdrawals
    ///         extracts more than one clean exit. It extracts strictly less.
    function test_attack_oneWeiWithdrawLoopCannotFarmFees() public {
        uint128 liq = 500e18;
        uint256 farmerId = _open(ALICE, -600, 600, liq);
        uint256 controlId = _open(BOB, -600, 600, liq);

        _churnFees(50e18, 6);

        (uint256 a0, uint256 a1) = _bal(ALICE);
        // 64 one-wei withdrawals, each of which re-collects the whole fee balance.
        for (uint256 i; i < 64; ++i) {
            _withdraw(ALICE, farmerId, 1);
        }
        _withdraw(ALICE, farmerId, liq - 64);
        (uint256 a0b, uint256 a1b) = _bal(ALICE);

        (uint256 b0, uint256 b1) = _bal(BOB);
        _withdraw(BOB, controlId, liq);
        (uint256 b0b, uint256 b1b) = _bal(BOB);

        uint256 farmed = (a0b - a0) + (a1b - a1);
        uint256 control = (b0b - b0) + (b1b - b1);

        assertLe(farmed, control, "FEE FARMING: slicing the exit paid more than one clean exit");
        // And the shortfall is pure rounding dust, not a structural leak in either direction.
        assertGe(farmed + 400, control, "slicing lost more than dust");
    }

    /* ==========================================================================================
                                 M-6  dust ownership after a clean cycle
       ========================================================================================== */

    function test_attack_noDustStrandedInContractOnCleanCycle() public {
        uint128 liq = 1e18;

        uint256 pm0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(address(manager));
        uint256 pm1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(address(manager));

        for (uint256 i; i < 5; ++i) {
            uint256 id = _open(ALICE, -600, 600, liq);
            _withdraw(ALICE, id, liq);
            _assertNoInventory("mid open/withdraw cycle");
        }

        uint256 dust0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(manager)) - pm0Before;
        uint256 dust1 = MockERC20(Currency.unwrap(currency1)).balanceOf(address(manager)) - pm1Before;

        // Dust lives in the PoolManager and is owned by the pool (i.e. the remaining LPs), which is
        // the correct owner. Bound it so a regression that starts leaking real value trips here.
        assertLe(dust0, 10, "unexpected token0 dust retained by the PoolManager");
        assertLe(dust1, 10, "unexpected token1 dust retained by the PoolManager");

        emit log_named_uint("dust0 left in PoolManager over 5 cycles", dust0);
        emit log_named_uint("dust1 left in PoolManager over 5 cycles", dust1);
    }

    /* ==========================================================================================
                       M-7 / S-1  stored liquidity vs PoolManager liquidity, always
       ========================================================================================== */

    /// @notice REWRITTEN FOR CORRECTED SEMANTICS (S-1). The original asserted that a position still
    ///         held its ORIGINAL liquidity number after a rebalance and withdrew that literal number
    ///         to close it. That is the pre-fix model, and asserting it is asserting the bug: holding
    ///         L constant across a range change is exactly what moved value between positions.
    ///         What is actually invariant — and what this now pins — is that `p.liquidity` equals the
    ///         PoolManager's liquidity for the position's CURRENT range at every point, that the old
    ///         range is emptied, and that a narrowing rebalance moves the number UP.
    function test_attack_storedLiquidityAlwaysMatchesPoolManager() public {
        uint128 liq = 100e18;
        uint256 id = _open(ALICE, -600, 600, liq);
        assertEq(mole.getPosition(id).liquidity, _onChainLiquidity(id, -600, 600), "after open");

        _withdraw(ALICE, id, 40e18);
        assertEq(mole.getPosition(id).liquidity, _onChainLiquidity(id, -600, 600), "after partial withdraw");
        assertEq(mole.getPosition(id).liquidity, 60e18, "partial withdraw arithmetic");

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        _rebalance(id, -180, 180);

        uint128 rebalanced = mole.getPosition(id).liquidity;
        assertEq(_onChainLiquidity(id, -600, 600), 0, "old range emptied");
        assertEq(rebalanced, _onChainLiquidity(id, -180, 180), "after rebalance");
        // S-1: the NUMBER moves because the AMOUNTS are what is conserved. [-600,600] -> [-180,180]
        // is a narrowing, so the same tokens must buy strictly more liquidity.
        assertGt(rebalanced, 60e18, "narrowing must raise the liquidity number");

        _withdraw(ALICE, id, rebalanced);
        assertEq(mole.getPosition(id).liquidity, 0, "after full withdraw");
        assertEq(_onChainLiquidity(id, -180, 180), 0, "pool position emptied");
        _assertNoInventory("after the full lifecycle");
    }

    /* ==========================================================================================
                              M-8  no caller-supplied payout target
       ========================================================================================== */

    function test_attack_nonOwnerAndKeeperCannotWithdraw() public {
        uint256 id = _open(ALICE, -600, 600, 10e18);

        vm.prank(BOB);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1);

        // The keeper's only lever really is rebalance(): everything else is owner-gated.
        vm.prank(BOB);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, -60, 60);

        // Owner is immutable — nothing on the surface rewrites it.
        assertEq(mole.ownerOf(id), ALICE, "owner must be fixed forever");
    }

    /* ==========================================================================================
                     F-1 (fuzzed): the fix is systematic, not a lucky parameter choice
       ========================================================================================== */

    /// REGRESSION (was testFuzz_attack_rebalanceNarrowingAlwaysConfiscates). It used to prove that
    /// EVERY narrowing rebalance moved value out of the owner and into address(this), with
    /// `confiscated == paid - recovered` holding as an identity; it now pins the opposite identity
    /// over the same parameter space — the contract balance is exactly 0 and the owner recovers
    /// everything she paid, so a narrowing rebalance moves the liquidity number and nothing else.
    function testFuzz_regression_narrowingRebalanceConfiscatesNothing(
        uint128 liqRaw,
        uint16 oldHalfStepsRaw,
        uint16 newHalfStepsRaw
    ) public {
        uint128 liq = uint128(bound(uint256(liqRaw), 1e15, 1e21));
        // Half-widths in whole tick spacings, so every draw is a valid, on-spacing, strictly
        // narrowing move. No vm.assume and no silent early return: every run runs the attack.
        int24 oldHalf = int24(int256(bound(uint256(oldHalfStepsRaw), 10, 100))) * SPACING; // 600..6000
        int24 newHalf = int24(int256(bound(uint256(newHalfStepsRaw), 1, 5))) * SPACING; //   60..300
        assertLt(newHalf, oldHalf, "the fuzz corpus must always be a narrowing");

        (uint256 b0, uint256 b1) = _bal(ALICE);
        uint256 id = _open(ALICE, -oldHalf, oldHalf, liq);
        (uint256 o0, uint256 o1) = _bal(ALICE);
        uint256 paid0 = b0 - o0;
        uint256 paid1 = b1 - o1;

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        _rebalance(id, -newHalf, newHalf);

        // Amounts conserved => the number goes up when the range gets narrower.
        uint128 newLiq = mole.getPosition(id).liquidity;
        assertGt(newLiq, liq, "narrowing must buy MORE liquidity with the same tokens");
        _assertNoInventory("after a narrowing rebalance");

        _withdraw(ALICE, id, newLiq);
        (uint256 e0, uint256 e1) = _bal(ALICE);
        uint256 got0 = e0 - o0;
        uint256 got1 = e1 - o1;

        assertEq(mole.getPosition(id).liquidity, 0, "closed");
        assertLe(got0, paid0, "FREE MONEY in token0");
        assertLe(got1, paid1, "FREE MONEY in token1");
        assertGe(got0 + DUST_TOLERANCE, paid0, "CONFISCATION: token0 did not come back to the owner");
        assertGe(got1 + DUST_TOLERANCE, paid1, "CONFISCATION: token1 did not come back to the owner");
        _assertNoInventory("after exit");
    }

    /// REGRESSION (was testFuzz_attack_partialThenRebalanceThenExitLosesValue). It used to prove
    /// that the brief's exact sequence — open, partial exit, keeper narrows the remainder, exit —
    /// left `paid == recovered + confiscated` with a non-zero confiscated term; it now pins
    /// `confiscated == 0` and `recovered == paid` over the same sequence and parameter space.
    function testFuzz_regression_partialThenRebalanceThenExitPreservesValue(
        uint128 liqRaw,
        uint16 fracBps,
        uint16 newHalfStepsRaw
    ) public {
        uint128 liq = uint128(bound(uint256(liqRaw), 1e15, 1e21));
        uint256 frac = bound(uint256(fracBps), 500, 9500);
        int24 newHalf = int24(int256(bound(uint256(newHalfStepsRaw), 1, 5))) * SPACING; // 60..300

        uint128 part = uint128((uint256(liq) * frac) / 10_000);
        if (part == 0) part = 1;
        if (part >= liq) part = liq - 1;

        (uint256 b0, uint256 b1) = _bal(ALICE);
        uint256 id = _open(ALICE, -6000, 6000, liq);
        (uint256 o0, uint256 o1) = _bal(ALICE);
        uint256 paid0 = b0 - o0;
        uint256 paid1 = b1 - o1;

        _withdraw(ALICE, id, part); // partial exit at the ORIGINAL range

        vm.warp(block.timestamp + MIN_REBAL_INTERVAL);
        _rebalance(id, -newHalf, newHalf); // keeper narrows what is left
        _assertNoInventory("after the keeper narrows the remainder");

        uint128 exited = _withdrawAll(ALICE, id); // exit whatever the position now holds
        assertGt(exited, 0, "the rebalanced remainder must still be a live position");

        (uint256 e0, uint256 e1) = _bal(ALICE);
        uint256 got0 = e0 - o0;
        uint256 got1 = e1 - o1;

        assertEq(mole.getPosition(id).liquidity, 0, "position fully closed");
        assertLe(got0, paid0, "FREE MONEY: user out-earned their deposit with no fees (token0)");
        assertLe(got1, paid1, "FREE MONEY: user out-earned their deposit with no fees (token1)");
        assertGe(got0 + DUST_TOLERANCE, paid0, "the rebalanced remainder lost token0");
        assertGe(got1 + DUST_TOLERANCE, paid1, "the rebalanced remainder lost token1");
        _assertNoInventory("after the whole sequence");
    }
}
