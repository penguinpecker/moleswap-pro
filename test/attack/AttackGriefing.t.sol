// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Lens: denial of service, state bloat and economic griefing by unprivileged users.
  Target: src/MolePositions.sol. Adversary model: Robinhood Chain (Orbit, chain 4663),
  no public mempool, single ordering-privileged sequencer, gas ~0.02 gwei.

  HOW TO RUN:
      cd /Users/pp/Projects/moleswap-pro && forge test --match-path 'test/attack/AttackGriefing.t.sol'

  STATUS 2026-08-03. Findings 1-5 below were the `_settleNet` family: rebalance() held the LIQUIDITY
  NUMBER constant while moving the RANGE, so a narrowing re-mint needed fewer tokens than the burn
  returned and the surplus was parked in address(this) — one unattributed pot shared by every
  position, out of which widening rebalances were funded. That is fixed: rebalance() now conserves
  TOKEN AMOUNTS, derives the new liquidity from the amounts the burn actually returned
  (LiquidityAmounts.getLiquidityForAmounts at the new range, rounding down), compounds accrued fees
  into the owner's own position, sends leftover dust to the OWNER via _collectTo, and `_settleNet` is
  gone entirely. whitelistPool() is now a FAIL-CLOSED ALLOWLIST on hook IDENTITY: it admits only the
  pool whose hook equals the immutable `moleHook`, and refuses every other hook deny-by-default.

  Every one of those five attacks is re-run verbatim below and now pins the fix instead of the bug —
  see the test_regression_* names. If a future change reintroduces the pot, these go red again.

  ---------------------------------------------------------------------------
  FIXED - kept as regression tests (the attack still runs; only the outcome changed)
  ---------------------------------------------------------------------------
  1. FIXED - rebalance() was dead on arrival: it settled the remove/re-add residual out of
     MolePositions' OWN balance, and the contract holds nothing, so even a no-op rebalance to the
     identical range reverted TransferFailed. It now needs no inventory at any position size,
     because the re-mint is sized to what the burn returned.
     -> test_regression_rebalanceNeedsNoContractInventoryEvenForANoOpRange
     -> test_regression_rebalanceConsumesZeroInventoryAtAnyPositionSize

  2. FIXED - unprivileged inventory-drain DoS. Once the operator funded the contract (the only way to
     make finding 1 go away), any user could size positions so the keeper's routine rebalances ate
     the whole buffer and every other user's rebalance reverted TransferFailed forever. There is now
     no buffer to drain: a pre-funded balance is left untouched to the wei.
     -> test_regression_attackerRebalancesCannotDrainInventoryOrBrickAnyoneElse

  3. FIXED - rebalance() irrecoverably seized user principal into address(this), where no function
     could ever send it out again. Measured then: owner kept 3.8% of a deposit. Now the surplus is
     the owner's and is taken straight to them; the contract's balance is exactly zero throughout.
     -> test_regression_keeperRebalanceCannotStrandPrincipalInTheContract

  4. FIXED - THE HEADLINE CLAIM ("a fully compromised keeper key can degrade returns; it cannot take
     a token") was FALSE. Two rebalance() calls laundered a victim's deposit into an attacker-owned
     position through the contract's own ERC20 balance, then an ordinary withdraw() paid it out:
     86.6% of the victim's deposit, one block, no allowance. The laundering hop no longer exists.
     -> test_regression_keeperCannotLaunderVictimDepositIntoAttackerWallet

  4b. FIXED (the other half of the same bug) - accrued fees used to leave the position on every
     rebalance and land in the shared pot. They now compound into the owner's own position, so a
     rebalance BACK TO THE SAME RANGE after fee-earning swaps returns MORE liquidity than it had.
     -> test_regression_rebalanceCompoundsFeesIntoTheOwnerPosition

  5. FIXED - whitelistPool() was permissionless AND unvalidated: it accepted any PoolKey, including
     one whose hook carried a remove-liquidity bit, so a pool on the contract's own whitelist could
     block withdrawals forever. It is still permissionless (deliberately) but is now a FAIL-CLOSED
     ALLOWLIST on hook IDENTITY: it admits only the pool whose hook equals the immutable `moleHook`
     (and tickSpacing > 0), and reverts HookNotPermitted for every other hook. A pool's hook is part
     of its PoolId and can never change, and the price/fee oracle is first-party MoleHook code, so a
     pool NOT carrying our hook is unservable anyway - admitting a foreign hook only ever adds attack
     surface. The original F-1 fix rejected only the remove-path bits; that is the same fail-OPEN
     shape and the same deposit-path-validator-with-a-carve-out that cost Gamma $6.18M, so admission
     is now deny-by-default. In these tests `moleHook == address(0)` (the 6th ctor arg, the pre-MoleHook
     interim pin), so the ONLY admissible pool is a hookless one and EVERY non-zero hook is refused at
     admission - which is strictly stronger than the old "blocked at the withdrawal check".
     -> test_regression_whitelistRejectsAHookThatCanBlockWithdrawal
     -> testFuzz_regression_whitelistRejectsEveryHookCarryingARemoveBit

  ---------------------------------------------------------------------------
  STILL STANDING - DESIGN-COST
  ---------------------------------------------------------------------------
  6. DESIGN-COST - No minimum deposit, so tick-bitmap pollution is free. `liquidity == 1` is
     accepted; 100 dust positions spanning ticks 0..6000 cost the attacker 100 wei of token0 in
     total and ZERO of the stable leg (a range above the price is paid for on one side only). They
     raise the gas of a swap crossing that band from 80,707 to 2,204,199 - 27.3x - for every user of
     the pool. Attacker gas: 20,067,471 total, $1.20 at 0.02 gwei / ETH $3,000. Tick pollution is
     inherent to v4 and can also be done straight through the PoolManager; what MolePositions adds is
     (a) no size floor on the path its own hook is meant to make the pool's only LP route, and (b) a
     permanent storage slot and event per dust position in its own state.
     -> test_attack_dustTicksMakeSwapsExpensiveForEveryone
     -> testFuzz_attack_noMinimumDepositIsEnforced

  7. DESIGN-COST - _ownerPositions is unbounded and positionsOf() returns it whole: 2,379 gas per
     entry on cold storage, so it exceeds a 30M eth_call budget at 12,610 entries, reachable for
     ~$152 of attacker gas. Self-inflicted only: nothing on-chain iterates it, and open()/withdraw()
     gas is flat in the array length (verified), so an attacker cannot bloat somebody else's array.
     -> test_attack_positionsOfBecomesUngasable
     -> test_attack_arrayBloatCannotBeAimedAtAnotherUser  (this half is MITIGATED)

  8. DESIGN-COST - A 25 USDG deposit is not viable. The problem is the keeper: one unlock, one burn
     and one mint PER POSITION per rebalance, with no batching anywhere in the contract. The in-test
     assertion uses its own warm-path gasleft() measurement, which is the most conservative version
     of this claim, and it still fails the 25 USDG target at a daily cadence and 10% APR.
     open/withdraw are NOT the problem: a user round trip is well under $0.10 on this chain.
     -> test_attack_gasEconomicsOfA25UsdgDeposit

  9. DESIGN-COST - A fully withdrawn position bricks rebalance() forever (ZeroLiquidity) yet stays in
     _ownerPositions and in the 1..positionCount id space forever. A keeper that batches will revert
     on it; an indexer must scan it forever. Free to create.
     -> test_attack_fullWithdrawBricksRebalanceForeverAndLeaksState

 10. DESIGN-COST - whitelistPool() reverts PoolAlreadyWhitelisted, so anyone can front-run the
     deployment script's whitelist calls and make them revert. Harmless to funds (the stored key is
     keccak-bound to its own id) but it breaks deploy automation, and on a chain with a single
     sequencer and no mempool the operator cannot even see it coming.
     -> test_attack_whitelistFrontRunRevertsTheDeployer

 14. DESIGN-COST (NEW, surfaced by the fix) - because a rebalance is now funded only by what the burn
     returned, the keeper can move a position to a range on one side of the price, after which the
     position holds a single asset and CANNOT be moved back across the price: the re-mint needs a
     token it does not hold, getLiquidityForAmounts returns 0, and rebalance reverts ZeroLiquidity.
     The owner's exit is untouched (withdraw always works) and no value is lost or moved, so this is
     bounded grief, not theft — but a keeper can strand a position out of range until its owner
     withdraws and reopens. Recorded and asserted, not papered over.
     -> test_regression_keeperCannotLaunderVictimDepositIntoAttackerWallet (step 2)

  ---------------------------------------------------------------------------
  MITIGATED / NOT-REACHABLE
  ---------------------------------------------------------------------------
 11. MITIGATED - Salt collision is impossible. salt = bytes32(id), id = ++positionCount is strictly
     monotonic, so two positions can never share a v4 position key even when they have the same
     owner, pool and ticks. Two identical positions withdraw independently and each receives its
     full amount.
     -> test_attack_saltCollisionIsImpossible

 12. MITIGATED (claims 1 and 2) - There is no path that pays a caller-supplied address and no owner
     setter; verified by exercising the whole external surface. This is what finding 4 used to route
     around, and the route is now closed.
     -> test_attack_noPayoutTargetIsCallerSupplied

 13. NOT-REACHABLE for a real pair / DESIGN-COST for an issuer-controlled token -
     TickLiquidityOverflow griefing. v4's cap at spacing 60 is 1.1505e34 liquidityGross per tick.
     Filling it at a tick 600 above the price costs 3.3444e31 wei of token0 and ZERO token1, and one
     position fences off BOTH its boundary ticks; every honest LP that wants either as a boundary
     then reverts TickLiquidityOverflow forever. Priced in a real 18-decimal asset that is 3.3e13
     tokens, and in USDG (6 decimals) 3.3e25 USDG - unreachable. But the cost is paid entirely on the
     far side of the price, so for a long-tail token the attacker issues (RHChain.sol says memecoins
     will be listed) it is free, and the issuer can fence off the whole upper half of their own pool.
     -> test_attack_saturateTickLocksHonestLpsOutOfTheRange

  ---------------------------------------------------------------------------
  BUILD NOTE (was a real defect, now fixed in foundry.toml)
  ---------------------------------------------------------------------------
  foundry.toml used to pin optimizer_runs = 800. At that setting solc 0.8.26 + via_ir CANNOT compile
  v4-core's PoolManager at all:
      Yul exception: Variable memPtr_1 is 1 too deep in the stack ... (Pool.swap)
  so no test in this repo could deploy a local v4 PoolManager and the custody core had zero
  integration coverage against the protocol it custodies for. It is now 44444444, matching v4-core
  upstream, and this file runs on the default profile with no environment overrides.

  Figures above are either forge --gas-report medians (stated as such) or in-test gasleft() deltas,
  both execution gas on a local v4 PoolManager with refunds not applied. Robinhood Chain additionally
  charges an L1 data-availability surcharge folded into the gas price, which Foundry does not model;
  every USD number here is therefore a LOWER bound.
//////////////////////////////////////////////////////////////////////////////*/

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId} from "v4-core/types/PoolId.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Pool} from "v4-core/libraries/Pool.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {RHChain} from "../../src/config/RHChain.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice A hook carrying BEFORE_REMOVE_LIQUIDITY, i.e. exactly the bit HookPermissions says must
///         never be set. It used to be whitelistable by anyone, because MolePositions.whitelistPool()
///         never looked at the hook; whitelistPool() is now a fail-closed allowlist on hook identity
///         that rejects any hook != moleHook, so this one can never be listed. `arm()` models the rug:
///         it behaves until it doesn't. Kept intact so the regression test can still prove the hook is
///         genuinely hostile before proving the admission gate is what refuses it.
contract WithdrawBlockingHook {
    bool public armed;

    function arm() external {
        armed = true;
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        returns (bytes4)
    {
        require(!armed, "MoleSwap withdrawals are disabled");
        return WithdrawBlockingHook.beforeRemoveLiquidity.selector;
    }
}

contract AttackGriefing is Deployers {
    /* ------------------------------------------------------------------ actors */

    address internal constant ATTACKER = address(0xBADBAD);
    address internal constant VICTIM = address(0x111111);
    address internal constant KEEPER = address(0xC0FFEE);
    address internal constant DEPLOYER_BOT = address(0xD0D0);

    /* ------------------------------------------- deployment params under test */

    uint32 internal constant MIN_REBALANCE_INTERVAL = 1 hours;
    int24 internal constant MIN_RANGE_WIDTH = 60;
    int24 internal constant MAX_RANGE_WIDTH = 6000;
    int24 internal constant TICK_SPACING = 60;

    /* -------------------------------------------------- RH gas cost model ---- */

    /// @dev Robinhood Chain quoted gas price, and an ETH price to turn gas into dollars.
    uint256 internal constant RH_GAS_PRICE_WEI = 0.02 gwei;
    uint256 internal constant ETH_USD = 3_000;
    /// @dev The retail deposit the product targets, in USDG's SIX decimals (RHChain.USDG_DECIMALS).
    ///      USDG is a dollar stable at six decimals, so one USDG unit == one micro-USD at the peg,
    ///      and the gas-cost figures below can be compared against it without a conversion.
    uint256 internal constant TARGET_DEPOSIT_USDG = 25 * 10 ** 6;

    MolePositions internal mole;
    PoolKey internal moleKey;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        (moleKey,) = initPool(currency0, currency1, IHooks(address(0)), 3000, TICK_SPACING, SQRT_PRICE_1_1);
        // Deep background liquidity so swaps can actually travel across the tick range.
        modifyLiquidityRouter.modifyLiquidity(
            moleKey,
            ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e21, salt: 0}),
            ZERO_BYTES
        );

        mole = deployMoleVault(manager, KEEPER, MIN_REBALANCE_INTERVAL, MIN_RANGE_WIDTH, MAX_RANGE_WIDTH, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        mole.whitelistPool(moleKey);

        _fund(ATTACKER);
        _fund(VICTIM);
    }

    /* ---------------------------------------------------------------- helpers */

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 1e30);
        MockERC20(Currency.unwrap(currency1)).mint(who, 1e30);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(mole), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    function _open(address who, PoolKey memory k, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = mole.open(k, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
    }

    function _liq(uint256 id) internal view returns (uint128) {
        return mole.getPosition(id).liquidity;
    }

    /// @dev Exit the WHOLE position. Note that after the fix the liquidity NUMBER is not conserved
    ///      across a rebalance — the token amounts are — so a test can no longer hardcode the number
    ///      it opened with. Reading it back is the correct semantics, not a workaround.
    function _withdrawAll(address who, uint256 id) internal returns (uint128 removed) {
        removed = _liq(id);
        if (removed == 0) return 0;
        vm.prank(who);
        mole.withdraw(id, removed);
    }

    /// @dev The single property the deleted `_settleNet` violated: MolePositions holds no inventory.
    ///      Every regression test in this file asserts it at every step it can.
    function _assertContractHoldsNothing(string memory where) internal view {
        assertEq(_bal(currency0, address(mole)), 0, string.concat("contract retained token0 @ ", where));
        assertEq(_bal(currency1, address(mole)), 0, string.concat("contract retained token1 @ ", where));
    }

    /// @dev Cost of `gas` units, in millionths of a dollar, at RH gas price and ETH_USD.
    function _usdMicros(uint256 gasUnits) internal pure returns (uint256) {
        return gasUnits * RH_GAS_PRICE_WEI * ETH_USD * 1e6 / 1e18;
    }

    /* ======================================================================= */
    /*  FINDING 1 - rebalance() could not execute at all  (FIXED)              */
    /* ======================================================================= */

    /// @dev WAS test_attack_rebalanceIsDeadOnArrival_evenForANoOpRange, which proved the keeper's only
    ///      function reverted TransferFailed on a freshly deployed contract because `_settleNet` paid
    ///      the residual out of address(this). NOW pins that rebalance is self-funding: it runs with a
    ///      zero contract balance and LEAVES a zero contract balance — the pot cannot re-form.
    function test_regression_rebalanceNeedsNoContractInventoryEvenForANoOpRange() public {
        uint256 id = _open(VICTIM, moleKey, -600, 600, 1e18);

        _assertContractHoldsNothing("after open");

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);

        // Identical range in, identical range out, on a contract that owns literally nothing.
        vm.prank(KEEPER);
        mole.rebalance(id, -600, 600);
        _assertContractHoldsNothing("after no-op rebalance");
        assertGt(_liq(id), 0, "no-op rebalance destroyed the position");

        // And the real thing - recentring the range.
        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -540, 660);
        _assertContractHoldsNothing("after recentring rebalance");
        assertGt(_liq(id), 0, "recentring destroyed the position");
        assertEq(mole.getPosition(id).tickLower, int24(-540), "range did not move");
        assertEq(mole.getPosition(id).tickUpper, int24(660), "range did not move");

        // The owner can still exit, in full, and the contract is still empty afterwards.
        uint128 exited = _withdrawAll(VICTIM, id);
        emit log_named_uint("liquidity opened with", 1e18);
        emit log_named_uint("liquidity after two rebalances (NOT conserved - amounts are)", exited);
        assertEq(_liq(id), 0, "owner must always be able to exit in full");
        _assertContractHoldsNothing("after withdraw");
    }

    /// @dev WAS test_attack_rebalanceInventoryRequirementScalesWithPositionSize, which measured that
    ///      one 60-tick recentring of a 1e18 position needed ~2.9e15 wei of operator inventory and
    ///      that the requirement grew linearly with TVL. NOW pins the requirement at exactly ZERO for
    ///      every size: a deliberately pre-funded balance is not touched by a single wei, and the
    ///      surplus goes to the OWNER instead.
    function test_regression_rebalanceConsumesZeroInventoryAtAnyPositionSize() public {
        // Park inventory the old code would have eaten. Nothing may consume it.
        MockERC20(Currency.unwrap(currency0)).mint(address(mole), 1e18);
        MockERC20(Currency.unwrap(currency1)).mint(address(mole), 1e18);

        uint256 small = _open(VICTIM, moleKey, -600, 600, 1e18);
        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);

        vm.prank(KEEPER);
        mole.rebalance(small, -600, 600);
        assertEq(_bal(currency0, address(mole)), 1e18, "no-op rebalance consumed contract token0");
        assertEq(_bal(currency1, address(mole)), 1e18, "no-op rebalance consumed contract token1");

        // The 60-tick recentring that used to cost ~10% of one leg out of the operator's pocket.
        uint256 big = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint256 pot0 = _bal(currency0, address(mole));
        uint256 pot1 = _bal(currency1, address(mole));
        uint256 owner0 = _bal(currency0, VICTIM);
        uint256 owner1 = _bal(currency1, VICTIM);

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(big, -540, 660);

        emit log_named_uint("wei of token0 consumed by ONE 60-tick recentring of a 1e18 position", pot0 - _bal(currency0, address(mole)));
        assertEq(_bal(currency0, address(mole)), pot0, "recentring consumed contract token0 - the pot is back");
        assertEq(_bal(currency1, address(mole)), pot1, "recentring consumed contract token1 - the pot is back");

        // Whatever the narrower/shifted range did not need was returned to the position's OWNER.
        uint256 dust0 = _bal(currency0, VICTIM) - owner0;
        uint256 dust1 = _bal(currency1, VICTIM) - owner1;
        emit log_named_uint("rebalance dust paid to the OWNER, token0", dust0);
        emit log_named_uint("rebalance dust paid to the OWNER, token1", dust1);
        assertGt(dust0 + dust1, 0, "a shifted range should return some dust, and it must go to the owner");

        // Scale check: the same operation on a 1000x position still needs zero inventory.
        uint256 huge = _open(VICTIM, moleKey, -600, 600, 1e21);
        pot0 = _bal(currency0, address(mole));
        pot1 = _bal(currency1, address(mole));
        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(huge, -540, 660);
        assertEq(_bal(currency0, address(mole)), pot0, "inventory requirement scales with TVL again");
        assertEq(_bal(currency1, address(mole)), pot1, "inventory requirement scales with TVL again");
    }

    /* ======================================================================= */
    /*  FINDING 2 - unprivileged inventory drain bricked the keeper  (FIXED)   */
    /* ======================================================================= */

    /// @dev WAS test_attack_drainRebalanceInventoryBricksEveryoneElse, which showed an attacker's four
    ///      ordinary positions could make the keeper eat a 1e15 operator buffer, after which an honest
    ///      user's rebalance reverted TransferFailed at that moment and at every later moment. NOW
    ///      pins that there is nothing to drain: the buffer survives every attacker rebalance to the
    ///      wei, and the honest position stays rebalanceable forever.
    function test_regression_attackerRebalancesCannotDrainInventoryOrBrickAnyoneElse() public {
        uint256 buffer = 1e15;
        MockERC20(Currency.unwrap(currency0)).mint(address(mole), buffer);
        MockERC20(Currency.unwrap(currency1)).mint(address(mole), buffer);

        uint256 honest = _open(VICTIM, moleKey, -600, 600, 1e17);

        uint256[] memory evil = new uint256[](4);
        for (uint256 i = 0; i < evil.length; i++) {
            evil[i] = _open(ATTACKER, moleKey, -600, 600, 1e17);
        }

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);

        uint256 landed;
        for (uint256 i = 0; i < evil.length; i++) {
            vm.prank(KEEPER);
            try mole.rebalance(evil[i], -540, 660) {
                landed++;
            } catch {}
        }
        emit log_named_uint("attacker rebalances the keeper performed", landed);
        emit log_named_uint("token0 inventory left", _bal(currency0, address(mole)));
        assertEq(landed, evil.length, "attack requires the attacker's own rebalances to run");
        assertEq(_bal(currency0, address(mole)), buffer, "attacker drained token0 inventory");
        assertEq(_bal(currency1, address(mole)), buffer, "attacker drained token1 inventory");

        // The honest user's position is rebalanceable, now...
        vm.prank(KEEPER);
        mole.rebalance(honest, -540, 660);
        assertGt(_liq(honest), 0, "honest position was destroyed");

        // ... and at any later time, still with the buffer untouched.
        vm.warp(block.timestamp + 30 days);
        vm.prank(KEEPER);
        mole.rebalance(honest, -600, 600);
        assertGt(_liq(honest), 0, "honest position was destroyed on the second rebalance");
        assertEq(_bal(currency0, address(mole)), buffer, "inventory moved at all");
        assertEq(_bal(currency1, address(mole)), buffer, "inventory moved at all");

        // And the honest user's exit is unaffected by any of it.
        _withdrawAll(VICTIM, honest);
        assertEq(_liq(honest), 0, "honest user could not exit");
    }

    /* ======================================================================= */
    /*  FINDING 3 - rebalance() seized principal into address(this)  (FIXED)   */
    /* ======================================================================= */

    /// @dev WAS test_attack_keeperRebalanceSeizesPrincipalIrrecoverably, which measured a victim
    ///      keeping 3.8% of a deposit after ONE keeper call, with 96.2% stranded in address(this)
    ///      forever because no function could send it out. NOW pins the invariant that killed it: the
    ///      contract's balance is exactly zero after the seizing rebalance, and the owner ends up with
    ///      essentially all of the principal (part paid as dust at rebalance time, the rest on exit).
    function test_regression_keeperRebalanceCannotStrandPrincipalInTheContract() public {
        uint256 v0 = _bal(currency0, VICTIM);
        uint256 v1 = _bal(currency1, VICTIM);

        uint256 id = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint256 deposit0 = v0 - _bal(currency0, VICTIM);
        uint256 deposit1 = v1 - _bal(currency1, VICTIM);

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);

        // The exact seizing move: a 60-tick range 6000 ticks below the price. Still legal under
        // _validateRange (width 60 >= MIN_RANGE_WIDTH, <= MAX_RANGE_WIDTH, on spacing), so the attack
        // is attempted in full - only the outcome changed.
        vm.prank(KEEPER);
        mole.rebalance(id, -6000, -5940);

        _assertContractHoldsNothing("after the seizing rebalance");

        _withdrawAll(VICTIM, id);

        uint256 returned0 = _bal(currency0, VICTIM) + deposit0 - v0;
        uint256 returned1 = _bal(currency1, VICTIM) + deposit1 - v1;
        emit log_named_uint("deposited token0", deposit0);
        emit log_named_uint("returned  token0", returned0);
        emit log_named_uint("deposited token1", deposit1);
        emit log_named_uint("returned  token1", returned1);

        // At the 1:1 price of this pool the two legs are directly comparable. The owner gets it all
        // back bar rounding dust; nothing is stranded and nothing is created. The bound is ABSOLUTE
        // (a few wei of v4 round-down per modifyLiquidity), not a percentage: a percentage bound
        // would silently tolerate the old 96.2% seizure reappearing at a smaller scale.
        uint256 deposited = deposit0 + deposit1;
        uint256 returned = returned0 + returned1;
        assertLe(returned, deposited, "owner received MORE than was deposited - value was created");
        assertGe(returned, deposited - 1_000, "owner lost more than rounding dust to a keeper rebalance");

        _assertContractHoldsNothing("after withdraw");

        // The position really is empty - there is nothing left anywhere for a rescue path to need.
        vm.prank(VICTIM);
        vm.expectRevert(MolePositions.InsufficientLiquidity.selector);
        mole.withdraw(id, 1);
    }

    /* ======================================================================= */
    /*  FINDING 4 - the headline claim was false  (FIXED)                      */
    /* ======================================================================= */

    /// @dev WAS test_attack_keeperLaundersVictimDepositIntoAttackerWallet, which ran
    ///      seize-victim -> refill-accomplice-from-the-pot -> withdraw-normally and netted the
    ///      attacker 86.6% of a victim's deposit in one block with no allowance. NOW pins the two
    ///      invariants that kill it: the laundering hop (a non-zero contract balance) never exists at
    ///      any step, and the victim keeps their principal. Step 2 is the load-bearing one - the
    ///      widening rebalance can only be funded by what the accomplice's OWN burn returned.
    function test_regression_keeperCannotLaunderVictimDepositIntoAttackerWallet() public {
        uint256 a0Start = _bal(currency0, ATTACKER);
        uint256 a1Start = _bal(currency1, ATTACKER);
        uint256 v0Start = _bal(currency0, VICTIM);
        uint256 v1Start = _bal(currency1, VICTIM);

        uint256 victimId = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint256 victimDeposit0 = v0Start - _bal(currency0, VICTIM);
        uint256 victimDeposit1 = v1Start - _bal(currency1, VICTIM);

        // The accomplice parks liquidity in a deliberately cheap range: same L, almost no tokens.
        uint256 thiefId = _open(ATTACKER, moleKey, -6000, -5940, 9e17);

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);

        // Step 1: seize. Used to move ~96% of the victim's deposit into address(this).
        vm.prank(KEEPER);
        mole.rebalance(victimId, -6000, -5940);
        _assertContractHoldsNothing("after step 1 (seize)");

        // Step 2: pay it into the accomplice's position. There is no pot to pay from, so this either
        // reverts (nothing to widen with) or succeeds funded purely by the accomplice's own burn.
        // Either way the contract balance stays zero - which is the whole point. Deliberately NOT an
        // expectRevert on a specific selector: the invariant is what must survive a refactor.
        vm.prank(KEEPER);
        bool step2Landed;
        try mole.rebalance(thiefId, -600, 600) {
            step2Landed = true;
        } catch (bytes memory err) {
            emit log_named_bytes("step 2 revert", err);
        }
        emit log_named_string("step 2 (refill the accomplice out of the pot) landed", step2Landed ? "yes" : "no");
        _assertContractHoldsNothing("after step 2 (refill)");

        // Step 3: ordinary owner withdrawal to the attacker's own address. Still permitted, still
        // pays the stored owner - and now there is nothing extra in there to pay out.
        _withdrawAll(ATTACKER, thiefId);

        int256 attackerNet0 = int256(_bal(currency0, ATTACKER)) - int256(a0Start);
        int256 attackerNet1 = int256(_bal(currency1, ATTACKER)) - int256(a1Start);
        emit log_named_int("attacker net token0", attackerNet0);
        emit log_named_int("attacker net token1", attackerNet1);
        emit log_named_uint("victim deposit token0", victimDeposit0);
        emit log_named_uint("victim deposit token1", victimDeposit1);

        // 1:1 pool, so the legs are comparable. The attacker cannot end up ahead of what they staked.
        assertLe(attackerNet0 + attackerNet1, 0, "attacker profited - value was created or taken");

        // The victim's position is not a husk: they get their principal back.
        _withdrawAll(VICTIM, victimId);
        int256 victimNet0 = int256(_bal(currency0, VICTIM)) - int256(v0Start);
        int256 victimNet1 = int256(_bal(currency1, VICTIM)) - int256(v1Start);
        emit log_named_int("victim net token0", victimNet0);
        emit log_named_int("victim net token1", victimNet1);

        // Absolute wei bound, not a percentage: the victim deposited 2.9553e16 of each leg and the
        // old code left them with 1.2% of it. A percentage tolerance would let a shrunken version of
        // that seizure back in unnoticed, so this pins "rounding dust and nothing else".
        assertGe(victimNet0 + victimNet1, -1_000, "victim lost more than rounding dust");
        assertLe(victimNet0 + victimNet1, 0, "victim gained - value was created from nowhere");

        _assertContractHoldsNothing("after the full laundering sequence");

        // The payout target was never caller-supplied: it was the stored owner, all along - and that
        // is now a true statement about custody rather than an irrelevant one.
        assertEq(mole.ownerOf(thiefId), ATTACKER, "payout target was the stored owner - as claimed");
        assertEq(mole.ownerOf(victimId), VICTIM, "owner changed across two keeper rebalances");
    }

    /// @dev NEW HALF OF THE SAME FIX. The old rebalance kept L constant, so everything the burn
    ///      returned above the cost of re-minting that L - INCLUDING ALL ACCRUED FEES - was swept into
    ///      the shared pot. Fees now sit inside the amounts the burn returns and are re-minted as part
    ///      of the position, so a rebalance BACK TO THE IDENTICAL RANGE after fee-earning swaps
    ///      returns strictly MORE liquidity than went in. That is the property that makes fee theft
    ///      structurally impossible, and it is stronger than any revert-string check.
    function test_regression_rebalanceCompoundsFeesIntoTheOwnerPosition() public {
        uint256 id = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint128 before = _liq(id);

        // Round-trip swaps through the position's range so it accrues fees on both legs and the
        // price ends up back where it started (so the L change is fees, not a price move).
        for (uint256 i = 0; i < 4; i++) {
            swapRouter.swap(
                moleKey,
                SwapParams({zeroForOne: true, amountSpecified: -1e19, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
            swapRouter.swap(
                moleKey,
                SwapParams({zeroForOne: false, amountSpecified: -1e19, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
        }

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);

        uint256 ownerBefore0 = _bal(currency0, VICTIM);
        uint256 ownerBefore1 = _bal(currency1, VICTIM);

        // Same range in, same range out. Under the old code this was where fees left the building.
        vm.prank(KEEPER);
        mole.rebalance(id, -600, 600);

        uint128 afterL = _liq(id);
        emit log_named_uint("liquidity before same-range rebalance", before);
        emit log_named_uint("liquidity after  same-range rebalance", afterL);
        assertGt(afterL, before, "fees did not compound into the position - they were swept somewhere");

        // Nothing was swept: not into the contract, and any leftover dust went to the owner.
        _assertContractHoldsNothing("after fee-compounding rebalance");
        assertGe(_bal(currency0, VICTIM), ownerBefore0, "owner lost token0 across a rebalance");
        assertGe(_bal(currency1, VICTIM), ownerBefore1, "owner lost token1 across a rebalance");

        // And the compounded value is really the owner's: it comes out on withdraw.
        _withdrawAll(VICTIM, id);
        _assertContractHoldsNothing("after withdraw");
    }

    /* ======================================================================= */
    /*  FINDING 5 - permissionless, unvalidated whitelist  (FIXED)             */
    /* ======================================================================= */

    /// @dev WAS test_attack_whitelistedPoolWithRemoveLiquidityHookLocksFundsForever, which whitelisted
    ///      a pool whose hook carried BEFORE_REMOVE_LIQUIDITY, opened a victim position in it, armed
    ///      the hook and left the funds locked for 3650 days. NOW proves the hook is still genuinely
    ///      hostile (positive control, straight through the PoolManager) and that MolePositions
    ///      refuses to list it at all - so no position in such a pool can ever exist. The refusal is
    ///      now the fail-closed IDENTITY gate: the hook is not moleHook (== address(0) here), so
    ///      admission reverts HookNotPermitted BEFORE it ever inspects which bits the hook carries.
    ///      That is strictly stronger than the old remove-bit check it replaced.
    function test_regression_whitelistRejectsAHookThatCanBlockWithdrawal() public {
        address hookAddr = address(uint160(0x4444 << 144 | uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG)));
        WithdrawBlockingHook impl = new WithdrawBlockingHook();
        vm.etch(hookAddr, address(impl).code);

        // The project's own library says this hook must never exist on a MoleSwap pool.
        assertFalse(HookPermissions.withdrawalIsUnblockable(hookAddr), "hook does carry a remove-liquidity bit");
        assertFalse(HookPermissions.isValid(hookAddr), "hook is not a valid MoleHook");

        (PoolKey memory evilKey,) = initPool(currency0, currency1, IHooks(hookAddr), 3000, TICK_SPACING, SQRT_PRICE_1_1);

        bytes memory blocked = abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            hookAddr,
            WithdrawBlockingHook.beforeRemoveLiquidity.selector,
            abi.encodeWithSignature("Error(string)", "MoleSwap withdrawals are disabled"),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );

        // POSITIVE CONTROL: the hook is not a straw man. Reached directly through the PoolManager it
        // really does block a removal, forever. This is exactly the lock the old test demonstrated.
        modifyLiquidityRouter.modifyLiquidity(
            evilKey,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: int256(1e18), salt: 0}),
            ZERO_BYTES
        );
        WithdrawBlockingHook(hookAddr).arm();
        vm.expectRevert(blocked);
        modifyLiquidityRouter.modifyLiquidity(
            evilKey,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: -int256(1e18), salt: 0}),
            ZERO_BYTES
        );

        // THE FIX: MolePositions will not list it, from any address, ever. The hook is not moleHook,
        // so the fail-closed identity gate refuses it deny-by-default with HookNotPermitted.
        vm.prank(ATTACKER);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(evilKey);
        assertFalse(mole.isWhitelisted(evilKey.toId()), "unvalidated pool reached the whitelist");

        // Not the deployer either - the check is on the pool's hook identity, not on who is asking.
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(evilKey);

        // Consequence, and the property users actually care about: no position can ever exist in a
        // pool whose withdrawal path can be blocked, so claim 4 holds for every pool this contract
        // will ever touch rather than only for the one pool the deploy script happened to list.
        vm.prank(VICTIM);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(evilKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // The second half of the same gate: a degenerate tickSpacing is rejected too.
        PoolKey memory zeroSpacing =
            PoolKey({currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: 0, hooks: IHooks(address(0))});
        vm.prank(ATTACKER);
        vm.expectRevert(MolePositions.InvalidTickSpacing.selector);
        mole.whitelistPool(zeroSpacing);
    }

    /// @dev The gate stated as an invariant over the whole address space rather than one mined hook:
    ///      ANY address carrying ANY of the three remove-liquidity bits is refused. Such a hook is
    ///      necessarily non-zero, so under the fail-closed identity gate (moleHook == address(0) here)
    ///      it can never equal moleHook and is refused with HookNotPermitted regardless of its other
    ///      bits. Fuzzing the other 147 bits is the point: no remove-bit hook slips through on any
    ///      address. This is strictly stronger than the old mask check - deny-by-default refuses these
    ///      AND every other foreign hook - so the assertion below is tightened, not relaxed.
    function testFuzz_regression_whitelistRejectsEveryHookCarryingARemoveBit(uint160 raw, uint8 which, uint24 fee)
        public
    {
        uint160 bit;
        uint256 pick = bound(uint256(which), 0, 2);
        if (pick == 0) bit = Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG;
        else if (pick == 1) bit = Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        else bit = Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG;

        address hook = address(raw | bit);
        assertFalse(HookPermissions.withdrawalIsUnblockable(hook), "constructed hook carries no remove bit");

        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: uint24(bound(uint256(fee), 0, 1_000_000)),
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });

        vm.prank(ATTACKER);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(k);
        assertFalse(mole.isWhitelisted(k.toId()), "blockable pool reached the whitelist");
    }

    /* ======================================================================= */
    /*  FINDING 6 - no minimum deposit -> free tick-bitmap pollution           */
    /* ======================================================================= */

    /// @notice A position costs 1 wei of each token and initialises two ticks. 100 of them across a
    ///         6000-tick band make every swap through that band 27x more expensive, for everybody.
    ///         MolePositions is the intended (and, if the hook closes the pool to third-party LPs as
    ///         its docs contemplate, the ONLY) way into these pools, and it enforces no minimum size.
    function test_attack_dustTicksMakeSwapsExpensiveForEveryone() public {
        // Identical control pool, same spacing, same background liquidity, no dust.
        (PoolKey memory cleanKey,) = initPool(currency0, currency1, IHooks(address(0)), 500, TICK_SPACING, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            cleanKey,
            ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 1e21, salt: 0}),
            ZERO_BYTES
        );

        uint256 dustPositions = 100;
        uint256 tokenCost0 = _bal(currency0, ATTACKER);
        uint256 tokenCost1 = _bal(currency1, ATTACKER);
        uint256 gasStart = gasleft();
        for (uint256 i = 0; i < dustPositions; i++) {
            _open(ATTACKER, moleKey, int24(int256(i * 60)), int24(int256(i * 60 + 60)), 1);
        }
        uint256 attackGas = gasStart - gasleft();
        tokenCost0 -= _bal(currency0, ATTACKER);
        tokenCost1 -= _bal(currency1, ATTACKER);

        uint256 g = gasleft();
        swapRouter.swap(
            cleanKey,
            SwapParams({zeroForOne: false, amountSpecified: -3e20, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        uint256 cleanGas = g - gasleft();

        g = gasleft();
        swapRouter.swap(
            moleKey,
            SwapParams({zeroForOne: false, amountSpecified: -3e20, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        uint256 pollutedGas = g - gasleft();

        emit log_named_uint("dust positions opened", dustPositions);
        emit log_named_uint("attacker token0 wei spent", tokenCost0);
        emit log_named_uint("attacker token1 wei spent", tokenCost1);
        emit log_named_uint("attacker gas", attackGas);
        emit log_named_uint("attacker cost, micro-USD at 0.02 gwei", _usdMicros(attackGas));
        emit log_named_uint("swap gas, clean pool", cleanGas);
        emit log_named_uint("swap gas, polluted pool", pollutedGas);

        assertLe(tokenCost0 + tokenCost1, 2 * dustPositions, "a dust position costs more than 2 wei");
        assertGt(pollutedGas, cleanGas * 10, "tick pollution did not raise swap cost 10x");
    }

    /// @notice There is no floor on position size at all: liquidity == 1 is a valid, permanent,
    ///         storage-consuming, tick-initialising position.
    function testFuzz_attack_noMinimumDepositIsEnforced(uint128 liq, uint8 slot) public {
        liq = uint128(bound(uint256(liq), 1, 1_000_000));
        int24 lo = int24(int256(uint256(bound(uint256(slot), 0, 200)))) * 60;
        uint256 before0 = _bal(currency0, ATTACKER);
        uint256 before1 = _bal(currency1, ATTACKER);

        uint256 id = _open(ATTACKER, moleKey, lo, lo + 60, liq);

        assertEq(_liq(id), liq, "dust position was rejected");
        assertEq(mole.ownerOf(id), ATTACKER, "owner mis-recorded");
        uint256 spent = (before0 - _bal(currency0, ATTACKER)) + (before1 - _bal(currency1, ATTACKER));
        emit log_named_uint("wei paid for a permanent storage slot + two initialised ticks", spent);
        assertLe(spent, uint256(liq) * 2 + 2, "cost model changed");
    }

    /* ======================================================================= */
    /*  FINDING 7 - unbounded _ownerPositions                                  */
    /* ======================================================================= */

    /// @notice positionsOf() returns the whole array. Measured on COLD storage (vm.cool), which is
    ///         what an eth_call from a wallet or an indexer actually pays.
    function test_attack_positionsOfBecomesUngasable() public {
        uint256 n = 400;
        for (uint256 i = 0; i < n; i++) {
            _open(ATTACKER, moleKey, -60, 60, 1);
        }

        vm.cool(address(mole));
        uint256 g = gasleft();
        uint256[] memory ids = mole.positionsOf(ATTACKER);
        uint256 used = g - gasleft();

        assertEq(ids.length, n, "array did not grow one-for-one with open()");
        uint256 perEntry = used / n;
        uint256 breakAt30M = 30_000_000 / perEntry;

        emit log_named_uint("entries", n);
        emit log_named_uint("positionsOf gas (cold)", used);
        emit log_named_uint("gas per entry", perEntry);
        emit log_named_uint("entries that exhaust a 30M eth_call budget", breakAt30M);
        emit log_named_uint("micro-USD of attacker gas to reach that", _usdMicros(breakAt30M * 200_764));

        assertGt(perEntry, 2_000, "cold read is cheaper than assumed - recheck the extrapolation");
        assertLt(breakAt30M, 20_000, "positionsOf survives past 20k entries - finding is weaker than stated");
    }

    /// @notice The mitigating half: _ownerPositions[msg.sender] is the only array anyone can push to,
    ///         nothing on-chain iterates it, and write-path gas is flat in its length. So the bloat
    ///         cannot be aimed at another user - it is self-harm plus indexer load, not a user DoS.
    function test_attack_arrayBloatCannotBeAimedAtAnotherUser() public {
        uint256 victimId = _open(VICTIM, moleKey, -600, 600, 1e18);

        for (uint256 i = 0; i < 300; i++) {
            _open(ATTACKER, moleKey, -60, 60, 1);
        }

        assertEq(mole.positionsOf(VICTIM).length, 1, "attacker pushed into the victim's array");
        assertEq(mole.positionsOf(ATTACKER).length, 300, "attacker array did not grow");

        // The victim's write paths are unaffected by 300 attacker entries and by their own history.
        vm.cool(address(mole));
        uint256 g = gasleft();
        uint256 fresh = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint256 openGas = g - gasleft();

        vm.cool(address(mole));
        vm.prank(VICTIM);
        g = gasleft();
        mole.withdraw(victimId, 1e18);
        uint256 withdrawGas = g - gasleft();

        emit log_named_uint("victim open gas with 300 attacker positions present", openGas);
        emit log_named_uint("victim withdraw gas", withdrawGas);
        assertLt(openGas, 500_000, "open() is not O(1) in the number of positions");
        assertLt(withdrawGas, 500_000, "withdraw() is not O(1) in the number of positions");
        assertEq(mole.ownerOf(fresh), VICTIM, "owner mis-recorded");
    }

    /* ======================================================================= */
    /*  FINDING 8 - retail economics                                           */
    /* ======================================================================= */

    /// @notice Real numbers for the 25 USDG question. Not an exploit - a product failure.
    /// @dev Rewritten for post-fix semantics in two places, neither of which weakens anything:
    ///      (a) the contract is no longer pre-funded before the rebalance, because rebalance is now
    ///          self-funding - so this now measures the real production gas path, not a subsidised
    ///          one; (b) the exit reads the position's CURRENT liquidity instead of the 1e18 it was
    ///          opened with, because the liquidity number is no longer conserved across a rebalance.
    function test_attack_gasEconomicsOfA25UsdgDeposit() public {
        // open into virgin ticks (the expensive, first-user case)
        uint256 g = gasleft();
        uint256 id = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint256 openColdGas = g - gasleft();

        // open into ticks another position already initialised (the common case)
        g = gasleft();
        _open(ATTACKER, moleKey, -600, 600, 1e18);
        uint256 openWarmGas = g - gasleft();

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);
        vm.prank(KEEPER);
        g = gasleft();
        mole.rebalance(id, -540, 660);
        uint256 rebalanceGas = g - gasleft();

        uint128 exit = _liq(id);
        vm.prank(VICTIM);
        g = gasleft();
        mole.withdraw(id, exit);
        uint256 withdrawGas = g - gasleft();

        emit log_named_uint("open gas (cold ticks)", openColdGas);
        emit log_named_uint("open gas (warm ticks)", openWarmGas);
        emit log_named_uint("rebalance gas", rebalanceGas);
        emit log_named_uint("withdraw gas", withdrawGas);
        emit log_named_uint("round trip micro-USD", _usdMicros(openColdGas + withdrawGas));

        // A user round trip is genuinely cheap on this chain: pennies.
        uint256 roundTripMicros = _usdMicros(openColdGas + withdrawGas);
        assertLt(roundTripMicros, 100_000, "round trip should be well under $0.10 at 0.02 gwei");

        // The cost that actually kills the product is the PER-POSITION keeper loop: one unlock, one
        // burn and one mint per position per rebalance, with no batching anywhere in this contract.
        uint256 dailyRebalanceMicrosPerYear = _usdMicros(rebalanceGas * 365);
        emit log_named_uint("keeper gas per position per year, daily cadence, micro-USD", dailyRebalanceMicrosPerYear);

        // 25 USDG earning 10% APR grosses 2.5 USDG = 2_500_000 micro-USD per year.
        uint256 grossMicrosOn25Usdg = TARGET_DEPOSIT_USDG * 10 / 100;
        emit log_named_uint("gross fee income on 25 USDG at 10% APR, micro-USD", grossMicrosOn25Usdg);

        assertGt(
            dailyRebalanceMicrosPerYear,
            grossMicrosOn25Usdg,
            "if this fails the 25 USDG target has become viable at a daily cadence - update the finding"
        );

        // Break-even deposit at 10% APR, in USDG units.
        uint256 breakEvenUsdg = dailyRebalanceMicrosPerYear * 100 / 10;
        emit log_named_uint("minimum viable deposit at 10% APR, USDG 6dp", breakEvenUsdg);
        assertGt(breakEvenUsdg, TARGET_DEPOSIT_USDG, "minimum viable deposit is above the target balance");
    }

    /* ======================================================================= */
    /*  FINDING 9 - permanently bricked, permanently enumerated positions      */
    /* ======================================================================= */

    function test_attack_fullWithdrawBricksRebalanceForeverAndLeaksState() public {
        uint256 id = _open(ATTACKER, moleKey, -600, 600, 1e18);
        vm.prank(ATTACKER);
        mole.withdraw(id, 1e18);

        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.rebalance(id, -540, 660);

        vm.warp(block.timestamp + 365 days);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.rebalance(id, -540, 660);

        // Nothing prunes it. It is enumerated, and inside 1..positionCount, forever.
        assertEq(mole.positionsOf(ATTACKER).length, 1, "dead position was pruned");
        assertEq(mole.ownerOf(id), ATTACKER, "dead position lost its owner");
        assertEq(mole.positionCount(), id, "id space does not shrink");

        // Scaled up: 200 dead positions the keeper must skip and an indexer must carry forever.
        for (uint256 i = 0; i < 200; i++) {
            uint256 dead = _open(ATTACKER, moleKey, -60, 60, 1);
            vm.prank(ATTACKER);
            mole.withdraw(dead, 1);
        }
        assertEq(mole.positionsOf(ATTACKER).length, 201, "dead positions are not accumulating");
    }

    /* ======================================================================= */
    /*  FINDING 10 - whitelist front-running                                   */
    /* ======================================================================= */

    function test_attack_whitelistFrontRunRevertsTheDeployer() public {
        (PoolKey memory fresh,) = initPool(currency0, currency1, IHooks(address(0)), 500, TICK_SPACING, SQRT_PRICE_1_1);

        vm.prank(ATTACKER);
        mole.whitelistPool(fresh);

        vm.prank(DEPLOYER_BOT);
        vm.expectRevert(MolePositions.PoolAlreadyWhitelisted.selector);
        mole.whitelistPool(fresh);

        // The saving grace: PoolId is keccak of the key, so the griefer cannot register a key that
        // differs from the one the id commits to. Only the deploy transaction is lost.
        assertEq(
            PoolId.unwrap(mole.poolKeyOf(fresh.toId()).toId()), PoolId.unwrap(fresh.toId()), "stored key was spoofed"
        );
    }

    /* ======================================================================= */
    /*  FINDING 13 - per-tick liquidity saturation                             */
    /* ======================================================================= */

    /// @notice v4 caps liquidityGross per tick. Filling a tick locks every other LP out of it.
    ///         Cost is paid entirely in the token on the far side of the price - so it is free for
    ///         whoever issues that token, and unreachable for a real stable leg. Both are reported.
    function test_attack_saturateTickLocksHonestLpsOutOfTheRange() public {
        uint128 maxLiq = Pool.tickSpacingToMaxLiquidityPerTick(TICK_SPACING);
        emit log_named_uint("v4 maxLiquidityPerTick at spacing 60", maxLiq);

        // A range entirely ABOVE the current price is paid for in token0 only.
        MockERC20(Currency.unwrap(currency0)).mint(ATTACKER, type(uint128).max);
        uint256 spent0 = _bal(currency0, ATTACKER);
        uint256 spent1 = _bal(currency1, ATTACKER);
        _open(ATTACKER, moleKey, 600, 660, maxLiq);
        spent0 -= _bal(currency0, ATTACKER);
        spent1 = spent1 - _bal(currency1, ATTACKER);

        emit log_named_uint("token0 wei to saturate one tick", spent0);
        emit log_named_uint("token1 wei to saturate one tick", spent1);
        assertEq(spent1, 0, "saturating an above-price tick should cost zero of the stable leg");
        assertGt(spent0, 0, "no cost at all would be surprising");

        // Any honest LP that wants tick 600 as a boundary is now permanently locked out.
        vm.prank(VICTIM);
        vm.expectRevert(abi.encodeWithSelector(Pool.TickLiquidityOverflow.selector, int24(600)));
        mole.open(moleKey, 600, 1200, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        vm.prank(VICTIM);
        vm.expectRevert(abi.encodeWithSelector(Pool.TickLiquidityOverflow.selector, int24(600)));
        mole.open(moleKey, 60, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // One position saturates BOTH of its boundary ticks, so it fences off two of them at once.
        vm.prank(VICTIM);
        vm.expectRevert(abi.encodeWithSelector(Pool.TickLiquidityOverflow.selector, int24(660)));
        mole.open(moleKey, 660, 1260, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // Untouched ticks still work, so the grief is per-tick and must be repeated per tick.
        uint256 ok = _open(VICTIM, moleKey, 720, 1320, 1e18);
        assertGt(_liq(ok), 0, "unrelated ticks should be unaffected");
    }

    /* ======================================================================= */
    /*  FINDING 11/12 - the defences that DID hold                             */
    /* ======================================================================= */

    /// @notice Attempted salt collision. salt = bytes32(id) and id = ++positionCount is strictly
    ///         monotonic, so two positions cannot share a v4 position key even when owner, pool and
    ///         ticks are identical. Both withdraw in full and neither can drain the other.
    function test_attack_saltCollisionIsImpossible() public {
        uint256 a = _open(ATTACKER, moleKey, -600, 600, 1e18);
        uint256 b = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint256 c = _open(ATTACKER, moleKey, -600, 600, 1e18); // same owner, same ticks, same size

        assertTrue(a != b && b != c && a != c, "ids collided");
        assertEq(mole.positionCount(), c, "positionCount is not the high-water mark");

        uint256 v0 = _bal(currency0, VICTIM);
        vm.prank(VICTIM);
        mole.withdraw(b, 1e18);
        uint256 victimGot = _bal(currency0, VICTIM) - v0;

        uint256 t0 = _bal(currency0, ATTACKER);
        vm.prank(ATTACKER);
        mole.withdraw(a, 1e18);
        uint256 attackerGot = _bal(currency0, ATTACKER) - t0;

        assertEq(victimGot, attackerGot, "identical positions paid out differently - shared accounting");
        assertGt(victimGot, 0, "nothing came back");

        // The third position is untouched by the other two withdrawals.
        assertEq(_liq(c), 1e18, "a third position lost liquidity to its twins");
        vm.prank(ATTACKER);
        mole.withdraw(c, 1e18);

        // Neither owner can over-withdraw against the other's position.
        vm.prank(ATTACKER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(b, 1);
    }

    /// @notice Claims 1 and 2, tested rather than believed: no external function takes a payout
    ///         address, and there is no way to repoint an existing position at another address.
    /// @dev Rewritten for post-fix semantics: the contract is no longer pre-funded before the
    ///      rebalance (it does not need to be), the exit reads current liquidity rather than the
    ///      1e18 it opened with, and the hand-rolled unlockCallback payload now carries the eight
    ///      fields the callback actually decodes. No assertion was relaxed.
    function test_attack_noPayoutTargetIsCallerSupplied() public {
        uint256 id = _open(VICTIM, moleKey, -600, 600, 1e18);
        assertEq(mole.ownerOf(id), VICTIM, "owner is not msg.sender");

        // Not the keeper, not another user, not the deployer can move or claim it.
        vm.prank(ATTACKER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1e18);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1e18);

        // The keeper cannot repoint the owner via rebalance - the field is simply never written.
        vm.warp(block.timestamp + MIN_REBALANCE_INTERVAL + 1);
        vm.prank(KEEPER);
        mole.rebalance(id, -540, 660);
        assertEq(mole.ownerOf(id), VICTIM, "owner changed across a rebalance");

        // unlockCallback is the only other entry point and it is gated on the PoolManager.
        vm.prank(ATTACKER);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(
            abi.encode(uint8(1), id, ATTACKER, -int256(1e18), int24(0), int24(0), uint256(0), uint256(0))
        );

        // Proceeds of a legitimate withdrawal land on the stored owner and nowhere else.
        uint256 attackerBefore = _bal(currency0, ATTACKER);
        uint256 victimBefore = _bal(currency0, VICTIM);
        _withdrawAll(VICTIM, id);
        assertEq(_bal(currency0, ATTACKER), attackerBefore, "value leaked to a non-owner");
        assertGt(_bal(currency0, VICTIM), victimBefore, "owner was not paid");
        _assertContractHoldsNothing("after withdraw");
    }

    /// @notice Chain-context sanity: this contract's dwell stamp uses block.number, which on RH is
    ///         the L1 height. A Foundry fork does NOT reproduce that, so no finding above depends on
    ///         block.number semantics. Recorded here so the omission is deliberate and visible.
    function test_attack_dwellStampIsNotUsedByAnyGuardWeCouldAttack() public {
        uint256 id = _open(VICTIM, moleKey, -600, 600, 1e18);
        uint64 stamped = mole.getPosition(id).openedAtL1Block;
        assertEq(uint256(stamped), block.number, "openedAtL1Block is not block.number");

        // Nothing reads it: rolling block.number backwards or forwards changes no behaviour.
        vm.roll(block.number + 1_000_000);
        vm.prank(VICTIM);
        mole.withdraw(id, 5e17);
        vm.roll(1);
        vm.prank(VICTIM);
        mole.withdraw(id, 5e17);
        assertEq(_liq(id), 0, "openedAtL1Block gated something after all");
        assertEq(RHChain.SECONDS_PER_BLOCK_NUMBER_TICK, 12, "L1 pacing assumption changed");
    }
}
