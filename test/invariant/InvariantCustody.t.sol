// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////
      H A N D L E R - B A S E D   C U S T O D Y   &   S O L V E N C Y   S U I T E

  Target: src/MolePositions.sol against a real Uniswap v4 PoolManager.

  WHY THIS FILE EXISTS. On 2026-08-01 the contract's headline claim — "a compromised
  keeper can degrade returns but cannot take a token" — was false. `rebalance()` held
  the LIQUIDITY NUMBER constant while moving the RANGE. Because the token value of a
  fixed L depends on range width, re-minting the same L at a narrower range needed
  fewer tokens and left a surplus, and the now-deleted `_settleNet` parked that surplus
  in `address(this)`: ONE UNATTRIBUTED POT SHARED BY EVERY POSITION. A keeper narrowed
  a victim, widened its own position out of the pot, and withdrew to itself entirely
  legitimately, because it really was the stored owner.

  The hand-written attack tests pin that specific three-transaction sequence. They cannot
  pin the CLASS. This file does: a fuzzer drives a handler of bounded, realistic actions
  (four users and one keeper, opening, partially and fully withdrawing, rebalancing to
  random legal ranges, and swapping so the price moves, fees accrue, and ranges fall in
  and out of range), and six properties are checked after every single call.

  THE SIX PROPERTIES

    INV-1  MolePositions' token balance is EXACTLY ZERO for both currencies, always.
           This is the pot itself. `_settleNet` is what used to make it non-zero. Zero
           is asserted structurally rather than as "small", because any non-zero balance
           is an unattributed claim on user funds regardless of size. ERC-6909 claim
           balances are checked too — a pot made of claim tokens is still a pot.

    INV-2  Per position, the tokens recoverable by burning `p.liquidity` at the current
           price are >= what the ghost accounting says the owner is owed. The ghost is
           NOT a mirror of storage: at every rebalance it independently re-quotes the
           entitlement from the tokens the old range was worth. Under the pre-fix
           contract a narrowing rebalance leaves p.liquidity below that, which is exactly
           the victim's loss. Plus aggregate backing: everything Mole's positions can
           claim is actually sitting in the PoolManager.

    INV-3  No free money. Measured INSIDE each transaction, where the price is constant
           and token amounts are therefore comparable: an opener must pay at least what
           the position they receive is worth, and a withdrawer must receive at most the
           principal they burned plus the fees the pool actually accrued to them.

    INV-4  `p.liquidity` equals the ACTUAL liquidity of that position inside the
           PoolManager, read back with StateLibrary.getPositionInfo at salt bytes32(id)
           and owner address(mole). Drift here is the class of bug the exploit needed:
           minting more L than the burn paid for is only possible if something else funds
           it. The check extends to every range a position has LEFT — those must read
           zero, or value is stranded outside the owner's reach.

    INV-5  A keeper rebalance never reduces a position's instantaneous recoverable value
           by more than rounding. Snapshotted before and after inside the handler, at one
           price, counting dust routed to the owner as recovered. This is the machine
           check on "can degrade returns, cannot take a token": picking a bad range is a
           FUTURE cost and is allowed; losing tokens at the instant of the move is not.

    INV-6  Every position owner is non-zero and never changes once set.

  CAN THIS SUITE FAIL? A green handler-based suite is worthless if nobody checked that it
  is capable of going red. `MoleInvariantMutationProof` at the bottom of this file points
  the SAME handler and the SAME six checks at `VulnerableMolePositions` — the 2026-08-01
  contract, rebuilt with only the two vulnerable lines restored — drives the historical
  attack through it, and requires INV-1, INV-2 and INV-5 to fail. They do, by ~1e20 wei.

  ON TOLERANCES. The only slack anywhere is `DUST = 1000 wei`, and it is absolute rather
  than proportional on purpose: the disagreement between SqrtPriceMath (used inside v4)
  and LiquidityAmounts (used here to compute expectations independently) is O(1) wei and
  does not scale with position size. 1000 wei is 1e-15 of a token — fifteen orders of
  magnitude below what the historical exploit extracted. No invariant here can be
  satisfied by a "small" theft.
//////////////////////////////////////////////////////////////////////////////*/

import {console2 as console} from "forge-std/console2.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {MoleHandler} from "./MoleHandler.sol";
import {VulnerableMolePositions} from "./mutants/VulnerableMolePositions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                     B A S E

  World construction plus the six checks, written once. They live as `check*` rather than
  `invariant_*` so that the mutation proof can inherit and deliberately fail them without
  Foundry also running them as its own invariants.
//////////////////////////////////////////////////////////////////////////////*/

abstract contract MoleCustodyBase is Deployers {
    using PoolIdLibrary for PoolKey;

    MolePositions internal mole;
    MoleHandler internal handler;

    MockERC20 internal t0;
    MockERC20 internal t1;
    PoolId internal poolId;

    address internal constant KEEPER = address(uint160(uint256(keccak256("mole.keeper"))));
    address internal constant ALICE = address(uint160(uint256(keccak256("mole.alice"))));
    address internal constant BOB = address(uint160(uint256(keccak256("mole.bob"))));
    address internal constant CAROL = address(uint160(uint256(keccak256("mole.carol"))));
    address internal constant MALLORY = address(uint160(uint256(keccak256("mole.mallory"))));
    /// @dev Deliberately NOT in `allActors`: the treasury is paid in ERC-6909 claims and never opens a
    ///      position, so it must never appear as a depositor in the ghost ledger.
    address internal constant FEE_TREASURY = address(uint160(uint256(keccak256("mole.treasury"))));

    uint32 internal constant INTERVAL = 1 hours;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;
    int24 internal constant SPACING = 60;

    uint256 internal constant DUST = 1_000;

    address[] internal allActors;

    /// @param vulnerable deploy the 2026-08-01 contract instead of the current one.
    function _buildWorld(bool vulnerable) internal {
        _buildWorld(vulnerable, false);
    }

    /// @param vulnerable deploy the 2026-08-01 contract instead of the current one.
    /// @param bounded    switch the keeper bounds ON, at the values script/Deploy.s.sol ships.
    ///
    /// @dev The deep run was built ONLY in the unbounded shape: every keeper bound passed as zero, i.e.
    ///      disabled. That is a defensible default for hunting custody bugs — a tight bound refuses the
    ///      keeper, and a refused keeper exercises nothing — but it meant the millions of calls behind
    ///      "deep invariants green" had never once run the configuration that actually deploys. The two
    ///      shapes answer different questions and both are worth asking, so both are now built: the
    ///      unbounded one for maximum path coverage, the bounded one for the shipped policy.
    ///
    ///      maxTwapDeviationTicks stays 0 here and cannot be otherwise: this world's pool is HOOKLESS, and
    ///      MolePositions' constructor refuses a TWAP bound with no oracle to read it from ("twap bound
    ///      needs an oracle") rather than letting it read as protection that is not there.
    function _buildWorld(bool vulnerable, bool bounded) internal {
        _buildWorld(vulnerable, bounded, 0);
    }

    /// @param feeBps charge a performance fee on realized fees. 0 disables it.
    /// @dev A third shape, because the first two both run a vault that earns nothing. The custody
    ///      invariants must hold on a CHARGING vault too — and the failure mode a fee introduces is
    ///      precisely a custody one: a cut mis-computed from the principal component of a delta is
    ///      indistinguishable from theft, and would show up here as a solvency or short-pay breach.
    function _buildWorld(bool vulnerable, bool bounded, uint16 feeBps) internal {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        // Hookless pool: address(0) carries no permission bits at all, so
        // HookPermissions.withdrawalIsUnblockable(address(0)) is true and whitelistPool accepts it.
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        poolId = key.toId();

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        // Deep third-party background liquidity, wider than the band the handler is allowed to swap
        // the price into. Without it the fuzzer's swaps would exhaust the book and every subsequent
        // action would revert on an empty pool instead of exercising the contract.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20_000e18, salt: 0}),
            ZERO_BYTES
        );

        if (vulnerable) {
            // ABI-identical to MolePositions, so the same handler and the same checks apply.
            mole = MolePositions(
                address(new VulnerableMolePositions(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0)))
            );
        } else if (feeBps != 0) {
            mole = deployMoleVault(
                manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, feeBps, FEE_TREASURY
            );
        } else if (bounded) {
            mole = deployMoleVault(
                manager,
                KEEPER,
                DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL,
                MIN_W,
                MAX_W,
                address(0),
                0, // maxTwapDeviationTicks: hookless pool, see above
                0, // twapWindow: likewise
                DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS,
                DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK,
                DeployConfig.DEFAULT_MAX_EJECTION_BPS,
                DeployConfig.DEFAULT_MAX_RECENTER_TICKS
            , 0, address(0));
        } else {
            mole = deployMoleVault(manager, KEEPER, INTERVAL, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        }
        mole.whitelistPool(key);

        // The keeper is deliberately ALSO a user. The 2026-08-01 attacker was exactly that: a keeper
        // that owned a position of its own and withdrew to itself legitimately. Excluding it from the
        // actor set would exclude the attack.
        allActors = [ALICE, BOB, CAROL, MALLORY, KEEPER];

        handler = new MoleHandler(mole, manager, swapRouter, key, KEEPER, allActors);

        for (uint256 i; i < allActors.length; ++i) {
            _fund(allActors[i], 1_000_000e18);
        }
        // The handler is the swapper and needs its own inventory.
        t0.transfer(address(handler), 100_000_000e18);
        t1.transfer(address(handler), 100_000_000e18);
    }

    /// @dev The action set every custody world drives, in one place so a new world cannot silently run a
    ///      narrower one. `withdrawAllViaConvenienceEntry` was missing from this list entirely: the
    ///      contract's one-argument exit had unit coverage but was never once called by the deep fuzz.
    function _targetHandlerActions() internal {
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = MoleHandler.open.selector;
        selectors[1] = MoleHandler.withdrawPartial.selector;
        selectors[2] = MoleHandler.withdrawFull.selector;
        selectors[3] = MoleHandler.withdrawAllViaConvenienceEntry.selector;
        selectors[4] = MoleHandler.rebalance.selector;
        selectors[5] = MoleHandler.swap.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _fund(address who, uint256 amount) internal {
        t0.transfer(who, amount);
        t1.transfer(who, amount);
        vm.startPrank(who);
        t0.approve(address(mole), type(uint256).max);
        t1.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    /* ====================================================================== INV-1 */

    /// @notice The single most important line in this file. `_settleNet` is what used to make this
    ///         non-zero, and a non-zero balance is by definition an unattributed claim: it belongs to
    ///         no position, and the contract has no function that can attribute it to one. If this
    ///         ever fails, the shared pot is back and the 2026-08-01 attack is live again.
    function checkINV1() public view {
        assertEq(t0.balanceOf(address(mole)), 0, "INV-1: MolePositions holds currency0 -- THE SHARED POT IS BACK");
        assertEq(t1.balanceOf(address(mole)), 0, "INV-1: MolePositions holds currency1 -- THE SHARED POT IS BACK");

        // A pot denominated in ERC-6909 claim tokens is still a pot: same unattributed surplus, same
        // ability to fund another position's mint, just held inside the PoolManager instead.
        assertEq(
            manager.balanceOf(address(mole), uint256(uint160(Currency.unwrap(currency0)))),
            0,
            "INV-1: MolePositions holds currency0 ERC-6909 claims"
        );
        assertEq(
            manager.balanceOf(address(mole), uint256(uint160(Currency.unwrap(currency1)))),
            0,
            "INV-1: MolePositions holds currency1 ERC-6909 claims"
        );
    }

    /* ====================================================================== INV-2 */

    /// @notice Per-position solvency against an independently maintained entitlement, plus aggregate
    ///         backing: the PoolManager must actually hold everything every Mole position can claim.
    function checkINV2() public view {
        uint256 n = handler.idCount();
        uint256 backing0;
        uint256 backing1;

        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            MolePositions.Position memory p = mole.getPosition(id);

            (uint256 have0, uint256 have1) = handler.amountsFor(p.tickLower, p.tickUpper, p.liquidity);
            (uint256 owed0, uint256 owed1) = handler.amountsFor(p.tickLower, p.tickUpper, handler.ghostClaimL(id));

            assertGe(have0 + DUST, owed0, _msg("INV-2: position under-collateralised in currency0, id=", id));
            assertGe(have1 + DUST, owed1, _msg("INV-2: position under-collateralised in currency1, id=", id));

            (uint256 f0, uint256 f1) = handler.feesOwed(id, p.tickLower, p.tickUpper, p.liquidity);
            backing0 += have0 + f0;
            backing1 += have1 + f1;
        }

        assertLe(
            backing0, t0.balanceOf(address(manager)), "INV-2: PoolManager cannot honour every Mole claim (currency0)"
        );
        assertLe(
            backing1, t1.balanceOf(address(manager)), "INV-2: PoolManager cannot honour every Mole claim (currency1)"
        );
    }

    /* ====================================================================== INV-3 */

    /// @notice No actor ends with more than it put in plus fees actually earned. Each individual
    ///         judgement is made inside the transaction that moved the money, where the price is
    ///         fixed and the comparison is therefore about custody rather than about the market.
    function checkINV3() public view {
        if (handler.maxOverpay0() > 0 || handler.maxOverpay1() > 0) {
            console.log("!! INV-3 withdrawal overpay -- components");
            console.log("   id / amt / liqBefore  ", handler.dbgId(), handler.dbgAmt(), handler.dbgLiqBefore());
            console.log("   tickLower", handler.dbgLower());
            console.log("   tickUpper", handler.dbgUpper());
            console.log("   tickNow  ", handler.dbgTick());
            console.log("   expected principal    ", handler.dbgExp0(), handler.dbgExp1());
            console.log("   fees computed by ghost", handler.dbgF0(), handler.dbgF1());
            console.log("   actually received     ", handler.dbgR0(), handler.dbgR1());
        }

        // Magnitudes first: the assert message carries the number of wei that moved, which is the
        // difference between "rounding" and "a theft".
        assertEq(handler.maxOverpay0(), 0, "INV-3: a withdrawal paid out more currency0 than principal + fees, by wei");
        assertEq(handler.maxOverpay1(), 0, "INV-3: a withdrawal paid out more currency1 than principal + fees, by wei");
        assertEq(handler.maxUnderpay0(), 0, "INV-3: an open under-paid for the currency0 it received, by wei");
        assertEq(handler.maxUnderpay1(), 0, "INV-3: an open under-paid for the currency1 it received, by wei");
        assertEq(handler.overpay0(), 0, "INV-3: withdrawals paid out more currency0 than principal + accrued fees");
        assertEq(handler.overpay1(), 0, "INV-3: withdrawals paid out more currency1 than principal + accrued fees");
        assertEq(handler.underpay0(), 0, "INV-3: an open minted currency0 value the opener did not pay for");
        assertEq(handler.underpay1(), 0, "INV-3: an open minted currency1 value the opener did not pay for");
        assertEq(handler.freeMoneyOnOpen(), 0, "INV-3: open handed out value that was not paid for");
        assertEq(handler.freeMoneyOnWithdraw(), 0, "INV-3: withdraw handed out value that was not earned");
        assertEq(
            handler.freeMoneyEvents(),
            0,
            "INV-3: an actor received value it did not pay for (see overpay/underpay magnitudes)"
        );

        // Structural corollary: value cannot appear for someone who never contributed. This is the
        // shape the exploit took at the very end — the attacker's own balance grew — so it is worth
        // pinning independently of the per-transaction bookkeeping above.
        for (uint256 i; i < allActors.length; ++i) {
            address a = allActors[i];
            if (handler.ghostDep0(a) == 0 && handler.ghostDep1(a) == 0) {
                assertEq(handler.ghostOut0(a), 0, "INV-3: actor received currency0 without ever depositing");
                assertEq(handler.ghostOut1(a), 0, "INV-3: actor received currency1 without ever depositing");
            }
        }
    }

    /* ====================================================================== INV-4 */

    /// @notice `p.liquidity` must equal the real liquidity the PoolManager records for
    ///         (owner = address(mole), tickLower, tickUpper, salt = bytes32(id)). The exploit needed
    ///         a mint the burn had not paid for; pinning the stored number to the pool's number, with
    ///         INV-1 pinning the fundable surplus to zero, closes that door from both sides.
    function checkINV4() public view {
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            MolePositions.Position memory p = mole.getPosition(id);
            assertEq(
                uint256(p.liquidity),
                uint256(handler.poolLiquidityOf(id, p.tickLower, p.tickUpper)),
                _msg("INV-4: p.liquidity drifted from PoolManager liquidity, id=", id)
            );
        }

        // Every range a position has LEFT must be empty. Liquidity abandoned at an old range is value
        // the owner can no longer reach through any function on this contract.
        uint256 m = handler.rangeHistoryCount();
        for (uint256 i; i < m; ++i) {
            (uint256 id, int24 lower, int24 upper) = handler.rangeHistory(i);
            MolePositions.Position memory p = mole.getPosition(id);
            if (lower == p.tickLower && upper == p.tickUpper) continue;
            assertEq(
                uint256(handler.poolLiquidityOf(id, lower, upper)),
                0,
                _msg("INV-4: liquidity stranded at a range the position has left, id=", id)
            );
        }
    }

    /* ====================================================================== INV-5 */

    /// @notice The keeper's residual power, measured. It may pick a range that earns less in future.
    ///         It may not make the position worth fewer tokens at the instant it moves it.
    function checkINV5() public view {
        assertEq(
            handler.rebalanceValueViolations(),
            0,
            "INV-5: a keeper rebalance reduced a position's recoverable value beyond rounding"
        );
        assertLe(handler.worstRebalanceLoss0(), DUST, "INV-5: worst-case currency0 loss across a rebalance");
        assertLe(handler.worstRebalanceLoss1(), DUST, "INV-5: worst-case currency1 loss across a rebalance");
    }

    /* ====================================================================== INV-6 */

    function checkINV6() public view {
        uint256 n = handler.idCount();
        for (uint256 i; i < n; ++i) {
            uint256 id = handler.ids(i);
            address owner = mole.ownerOf(id);
            assertTrue(owner != address(0), _msg("INV-6: owner is zero, id=", id));
            assertEq(owner, handler.ghostOwner(id), _msg("INV-6: owner changed after open, id=", id));
        }
    }

    /* ============================================================ extra: bookkeeping */

    /// @notice Not one of the six, but the cheapest possible cross-check that the two halves of the
    ///         withdrawal path agree: a burn must never pay the owner LESS than the principal it
    ///         destroyed. A contract that silently kept a slice would still satisfy INV-1 if it
    ///         forwarded that slice somewhere, so this is checked separately.
    function checkNoShortPay() public view {
        assertEq(handler.shortPayEvents(), 0, "withdraw paid the owner less than the principal burned");
        assertEq(handler.shortPay0(), 0, "withdraw short-paid the owner in currency0, by wei");
        assertEq(handler.shortPay1(), 0, "withdraw short-paid the owner in currency1, by wei");
        assertEq(handler.overchargeEvents(), 0, "open charged more than the position it created is worth");
        assertEq(handler.overcharge0(), 0, "open overcharged in currency0, by wei");
        assertEq(handler.overcharge1(), 0, "open overcharged in currency1, by wei");
    }

    /* -------------------------------------------------------------------- helpers */

    /// @dev The 2026-08-01 sequence, as handler actions: a victim opens wide, the keeper opens a
    ///      cheap narrow position of its own, the keeper NARROWS the victim (which is what created
    ///      the surplus), then WIDENS itself (which is what spent it), then withdraws to itself.
    ///      Seeds are chosen so `_pickRange` lands on the extremes: widthSeed 1000 -> 60000 ticks,
    ///      widthSeed 2 -> 120 ticks, offsetSeed == width -> centred on the current tick.
    function _runHistoricalAttackSequence() internal {
        handler.open(0, 60_000, 1_000, 100e18, 100e18); // ALICE, widest range, id 1
        handler.open(4, 120, 2, 1e15, 1e15); // KEEPER, narrowest range, id 2

        handler.swap(50e18, 0, 60); // move the price, accrue some fees
        handler.swap(30e18, 1, 60);

        handler.rebalance(0, 120, 2, INTERVAL); // NARROW the victim  -> surplus
        handler.rebalance(1, 60_000, 1_000, INTERVAL); // WIDEN the attacker -> spends it

        handler.withdrawFull(1); // attacker exits to itself
    }

    /// @dev Value a (currency0, currency1) basket in currency1 at the pool's CURRENT price.
    function _valueInCurrency1(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        (uint160 sqrtP,,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), poolId);
        // amount0 * (sqrtP / 2**96)**2, done in two steps so nothing overflows.
        uint256 half = FullMath.mulDiv(amount0, sqrtP, FixedPoint96.Q96);
        return FullMath.mulDiv(half, sqrtP, FixedPoint96.Q96) + amount1;
    }

    function _msg(string memory s, uint256 id) internal pure returns (string memory) {
        return string.concat(s, vm.toString(id));
    }

    function _reverts(bytes4 sel) internal returns (bool) {
        (bool ok,) = address(this).call(abi.encodeWithSelector(sel));
        return !ok;
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                       T H E   I N V A R I A N T   S U I T E
//////////////////////////////////////////////////////////////////////////////*/

contract InvariantCustody is MoleCustodyBase {
    function setUp() public {
        _buildWorld(false);

        targetContract(address(handler));

        _targetHandlerActions();

        // Nothing but the handler drives state.
        excludeSender(address(mole));
        excludeSender(address(manager));
    }

    function invariant_INV1_moleCustodiesNothing() public view {
        checkINV1();
    }

    function invariant_INV2_everyPositionIsSolvent() public view {
        checkINV2();
    }

    function invariant_INV3_noFreeMoney() public view {
        checkINV3();
    }

    function invariant_INV4_storedLiquidityMatchesPoolManager() public view {
        checkINV4();
    }

    function invariant_INV5_keeperCannotDestroyValue() public view {
        checkINV5();
    }

    function invariant_INV6_ownerIsNonZeroAndImmutable() public view {
        checkINV6();
    }

    function invariant_withdrawNeverShortPaysTheOwner() public view {
        checkNoShortPay();
    }

    /* ------------------------------------------------------------ deterministic A/B */

    /// @notice The same scripted sequence the mutation proof runs, against the CURRENT contract.
    ///         Deterministic counterpart to the fuzzing above and the direct answer to "is the
    ///         2026-08-01 attack dead": the identical seven actions execute in full, every check
    ///         holds, and the keeper ends up level rather than up 86x. Nothing is skipped or
    ///         expected to revert -- the attack is attempted, it simply no longer pays.
    function test_regression_historicalAttackSequenceExtractsNothing() public {
        _runHistoricalAttackSequence();

        checkINV1();
        checkINV2();
        checkINV3();
        checkINV4();
        checkINV5();
        checkINV6();
        checkNoShortPay();

        // The attacker put tokens in and took tokens out. The bottom line is whether it is AHEAD.
        //
        // The comparison has to be made in value terms at ONE price, not leg by leg: the pool is a
        // converter, so an LP that deposits (x, y) and exits (x', y') will routinely hold more of one
        // token and less of the other purely because the price moved. Valuing both baskets at the
        // FINAL price is the honest test, and it is a real bound rather than a convention:
        // impermanent loss is non-negative, so an LP position is worth no more at any price than the
        // tokens that funded it, valued at that same price. Fees are the only legitimate excess.
        uint256 in0 = handler.ghostDep0(KEEPER);
        uint256 in1 = handler.ghostDep1(KEEPER);
        uint256 out0 = handler.ghostOut0(KEEPER);
        uint256 out1 = handler.ghostOut1(KEEPER);
        assertGt(in0 + in1, 0, "attack sequence did not actually run: keeper never deposited");
        assertGt(out0 + out1, 0, "attack sequence did not actually run: keeper never withdrew");

        uint256 stakeValue = _valueInCurrency1(in0, in1);
        uint256 exitValue = _valueInCurrency1(out0, out1);
        console.log("regression: keeper in  c0 / c1", in0, in1);
        console.log("regression: keeper out c0 / c1", out0, out1);
        console.log("regression: keeper stake / exit value, in currency1", stakeValue, exitValue);

        // The pot drain was measured at ~86x the attacker's stake, and reproduces at ~260x through
        // this exact sequence on the vulnerable build (see MoleInvariantMutationProof). The keeper's
        // position is a ~1e-5 share of pool liquidity across two swaps totalling 80e18, so its
        // legitimate fee income is on the order of 1e12 -- a fraction of a percent. 2% is a ceiling
        // that fee income fits comfortably under and that no version of the drain fits under at all.
        assertLe(
            exitValue,
            stakeValue + stakeValue / 50,
            "keeper exited with more value than it staked -- the pot drain is live again"
        );
    }

    /* ------------------------------------------------------------ anti-vacuity */

    /// @notice Proves each handler action actually reaches MolePositions and changes its state.
    ///         A handler-based suite is worthless if its actions silently no-op or revert, and the
    ///         fuzzer will happily report thousands of green calls in that case. This is checked as
    ///         an ordinary deterministic test rather than inside `afterInvariant`, because anything
    ///         asserted there also runs on the shrunk replay of a failure and overwrites the real
    ///         failure message.
    ///
    ///         The per-run call summary logged by afterInvariant is the other half of the evidence:
    ///         it shows how often the fuzzer chose each action and how many of those reverted.
    function test_coverage_everyHandlerActionReachesTheContract() public {
        // --- open -----------------------------------------------------------
        handler.open(0, 60_000, 1_000, 100e18, 100e18); // ALICE, widest legal range
        assertEq(handler.reverts(bytes32("open")), 0, "coverage: open reverted");
        assertEq(handler.idCount(), 1, "coverage: open did not create a position");
        uint256 id1 = handler.ids(0);
        assertGt(mole.getPosition(id1).liquidity, 0, "coverage: open minted no liquidity");
        assertGt(handler.ghostDep0(ALICE) + handler.ghostDep1(ALICE), 0, "coverage: open pulled no tokens");
        assertEq(mole.ownerOf(id1), ALICE, "coverage: open recorded the wrong owner");

        handler.open(1, 6_000, 100, 50e18, 50e18); // BOB, 6000-tick range
        assertEq(handler.idCount(), 2, "coverage: second open did not create a position");

        // --- swap moves the price ------------------------------------------
        (, int24 tickBefore,,) = StateLibrary.getSlot0(manager, poolId);
        handler.swap(50e18, 0, 3_600);
        (, int24 tickAfter,,) = StateLibrary.getSlot0(manager, poolId);
        assertEq(handler.reverts(bytes32("swap")), 0, "coverage: swap reverted");
        assertTrue(tickAfter != tickBefore, "coverage: swap did not move the pool price");
        assertGt(handler.swapsThatMovedPrice(), 0, "coverage: swap not recorded as price-moving");

        // --- rebalance ------------------------------------------------------
        MolePositions.Position memory pre = mole.getPosition(id1);
        handler.rebalance(0, 1_200, 20, INTERVAL); // keeper moves it to a 1200-tick range
        MolePositions.Position memory post = mole.getPosition(id1);
        assertEq(handler.reverts(bytes32("rebalance")), 0, "coverage: rebalance reverted");
        assertTrue(
            post.tickLower != pre.tickLower || post.tickUpper != pre.tickUpper,
            "coverage: rebalance did not move the range"
        );
        assertGt(handler.rangeHistoryCount(), 2, "coverage: rebalance recorded no new range");
        // The liquidity NUMBER is expected to CHANGE here: narrowing the range means the same tokens
        // buy more liquidity. That is the fix working, not a defect.
        assertTrue(post.liquidity != pre.liquidity, "coverage: rebalance re-quoted nothing");

        // --- partial withdraw ----------------------------------------------
        uint128 liqBefore = mole.getPosition(id1).liquidity;
        handler.withdrawPartial(0, 5_000);
        assertEq(handler.reverts(bytes32("withdrawPartial")), 0, "coverage: partial withdraw reverted");
        assertLt(mole.getPosition(id1).liquidity, liqBefore, "coverage: partial withdraw removed nothing");
        assertGt(mole.getPosition(id1).liquidity, 0, "coverage: partial withdraw closed the position");

        // --- full withdraw --------------------------------------------------
        handler.withdrawFull(0);
        assertEq(handler.reverts(bytes32("withdrawFull")), 0, "coverage: full withdraw reverted");
        assertEq(mole.getPosition(id1).liquidity, 0, "coverage: full withdraw left liquidity behind");
        assertGt(handler.fullExits(), 0, "coverage: full exit not recorded");

        // Every action ran, and the world is still sound.
        checkINV1();
        checkINV2();
        checkINV3();
        checkINV4();
        checkINV5();
        checkINV6();
        checkNoShortPay();
    }

    /* ------------------------------------------------------------------ call summary */

    function afterInvariant() public view {
        console.log("");
        console.log("=== MolePositions invariant run: call summary ===");
        console.log("  total handler calls        ", handler.totalCalls());
        console.log("  open           called/rev  ", handler.calls(bytes32("open")), handler.reverts(bytes32("open")));
        console.log(
            "  withdrawPartial called/rev ",
            handler.calls(bytes32("withdrawPartial")),
            handler.reverts(bytes32("withdrawPartial"))
        );
        console.log(
            "  withdrawFull   called/rev  ",
            handler.calls(bytes32("withdrawFull")),
            handler.reverts(bytes32("withdrawFull"))
        );
        console.log(
            "  rebalance      called/rev  ", handler.calls(bytes32("rebalance")), handler.reverts(bytes32("rebalance"))
        );
        console.log("  swap           called/rev  ", handler.calls(bytes32("swap")), handler.reverts(bytes32("swap")));
        console.log("  --- state reached ---");
        console.log("  positions opened           ", handler.idCount());
        console.log("  ranges ever minted         ", handler.rangeHistoryCount());
        console.log("  opens landing out of range ", handler.opensOutOfRange());
        console.log("  swaps that moved the price ", handler.swapsThatMovedPrice());
        console.log("  rebalances narrowing       ", handler.rebalancesThatNarrowed());
        console.log("  rebalances widening        ", handler.rebalancesThatWidened());
        console.log("  rebalances out of range    ", handler.rebalancesOutOfRange());
        console.log("  withdrawals w/ accrued fees", handler.feeAccruingWithdrawals());
        console.log("  full exits                 ", handler.fullExits());
        console.log("  total deposited c0 / c1    ", handler.ghostTotalDep0(), handler.ghostTotalDep1());
        console.log("  total paid out  c0 / c1    ", handler.ghostTotalOut0(), handler.ghostTotalOut1());

        // NO ASSERTIONS HERE, deliberately. `afterInvariant` also runs on the SHRUNK replay after a
        // failure, and on a cached failure replayed from cache/invariant/failures. An assertion in
        // this function therefore fires on a two-call replay and REPLACES the real failure message
        // with its own -- which is exactly how a genuine finding gets lost. Anti-vacuity is checked
        // instead by test_coverage_everyHandlerActionReachesTheContract, which cannot mask anything.
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                        M U T A T I O N   P R O O F

  The negative control. Everything is identical to the suite above except that the core
  under test is `VulnerableMolePositions` — the 2026-08-01 contract with only the two
  vulnerable lines restored. If the six checks are worth anything, they must go red here.

  This is what stops the suite above from being a green rubber stamp: it demonstrates that
  the checks fail on the real historical defect, at a magnitude that cannot be confused
  with rounding, using the same handler and the same tolerances.
//////////////////////////////////////////////////////////////////////////////*/

contract MoleInvariantMutationProof is MoleCustodyBase {
    function setUp() public {
        _buildWorld(true);
    }

    function test_mutation_theSuiteDetectsThe20260801Break() public {
        // Sanity: on the vulnerable contract too, everything is clean before the attack runs.
        checkINV1();
        checkINV5();

        _runHistoricalAttackSequence();

        uint256 pot0 = t0.balanceOf(address(mole));
        uint256 pot1 = t1.balanceOf(address(mole));
        console.log("mutation proof: unattributed pot held by the contract, c0 / c1", pot0, pot1);
        console.log("mutation proof: worst rebalance value loss, c0 / c1", handler.worstRebalanceLoss0(), handler.worstRebalanceLoss1());

        // INV-1 -- the pot itself.
        assertTrue(_reverts(this.checkINV1.selector), "INV-1 FAILED TO DETECT the shared pot");
        assertGt(pot0 + pot1, 1e15, "the pot that formed was dust, so INV-1's detection proves little");

        // INV-5 -- the victim's position lost token value at the instant the keeper moved it.
        assertTrue(_reverts(this.checkINV5.selector), "INV-5 FAILED TO DETECT the value destroyed by rebalance");
        assertGt(handler.rebalanceValueViolations(), 0, "no rebalance value violation was even recorded");
        assertGt(
            handler.worstRebalanceLoss0() + handler.worstRebalanceLoss1(),
            1e15,
            "the value loss detected was dust, so INV-5's detection proves little"
        );

        // INV-2 -- the victim's stored liquidity no longer covers what it is owed.
        assertTrue(_reverts(this.checkINV2.selector), "INV-2 FAILED TO DETECT the under-collateralised position");

        // Which checks fire, and which do not, is worth recording rather than glossing. INV-4 and
        // INV-6 are EXPECTED to stay green here: the vulnerable contract keeps p.liquidity honest
        // against the PoolManager and never touches ownership -- the theft ran entirely through a
        // legitimately-owned position. That is precisely why no single one of these six would have
        // been enough on its own, and why INV-1 (the pot) is the load-bearing one.
        console.log("mutation proof: INV-1 fired?", _reverts(this.checkINV1.selector));
        console.log("mutation proof: INV-2 fired?", _reverts(this.checkINV2.selector));
        console.log("mutation proof: INV-3 fired?", _reverts(this.checkINV3.selector));
        console.log("mutation proof: INV-4 fired?", _reverts(this.checkINV4.selector));
        console.log("mutation proof: INV-5 fired?", _reverts(this.checkINV5.selector));
        console.log("mutation proof: INV-6 fired?", _reverts(this.checkINV6.selector));
    }

    /// @notice The keeper's own balance is the bottom line. On the vulnerable contract the attack
    ///         must actually pay, otherwise this file is proving the detectors fire on a non-event.
    function test_mutation_theAttackActuallyPaysOnTheVulnerableContract() public {
        _runHistoricalAttackSequence();

        uint256 in0 = handler.ghostDep0(KEEPER);
        uint256 in1 = handler.ghostDep1(KEEPER);
        uint256 out0 = handler.ghostOut0(KEEPER);
        uint256 out1 = handler.ghostOut1(KEEPER);
        console.log("mutation proof: keeper in  c0 / c1", in0, in1);
        console.log("mutation proof: keeper out c0 / c1", out0, out1);

        assertGt(out0 + out1, (in0 + in1) * 5, "the historical attack did not profit on the vulnerable contract");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        T H E   S A M E   I N V A R I A N T S ,   B O U N D S   S W I T C H E D   O N
//////////////////////////////////////////////////////////////////////////////*/

/// @notice Every custody invariant again, against the configuration script/Deploy.s.sol actually ships:
///         a 1-day cadence, a 300-L1-block dwell, a 10-per-L1-block rebalance budget and a 600-tick
///         recenter cap.
///
/// WHY THIS EXISTS. The suite above passes every bound as zero — DISABLED. That is the right shape for
/// hunting custody bugs, because a bound that refuses the keeper is a bound that stops the fuzzer
/// exercising the code underneath it. But it also meant that "the deep invariants are green" was a
/// statement about a contract nobody deploys. The bounds are not decoration: `maxRecenterTicks` is the
/// fix for a demonstrated total-loss path, and it had never been switched on in a deep run.
///
/// These are the SAME seven checks, not a weaker set. A bound must not be able to break custody — if
/// switching one on could strand value, that is a worse bug than the one it was added to fix.
contract InvariantCustodyShippedBounds is MoleCustodyBase {
    function setUp() public {
        _buildWorld(false, true);

        targetContract(address(handler));
        _targetHandlerActions();

        excludeSender(address(mole));
        excludeSender(address(manager));
    }

    function invariant_bounded_INV1_moleCustodiesNothing() public view {
        checkINV1();
    }

    function invariant_bounded_INV2_everyPositionIsSolvent() public view {
        checkINV2();
    }

    function invariant_bounded_INV3_noFreeMoney() public view {
        checkINV3();
    }

    function invariant_bounded_INV4_storedLiquidityMatchesPoolManager() public view {
        checkINV4();
    }

    function invariant_bounded_INV5_keeperCannotDestroyValue() public view {
        checkINV5();
    }

    function invariant_bounded_INV6_ownerIsNonZeroAndImmutable() public view {
        checkINV6();
    }

    function invariant_bounded_withdrawNeverShortPaysTheOwner() public view {
        checkNoShortPay();
    }

    /// @dev No `afterInvariant` non-vacuity assertion — see the note in InvariantCustodyCharging for why
    ///      a cumulative check there is incompatible with the shrinker. This world passed a full 5,000-run
    ///      deep campaign with one in place, but that was luck rather than design: a single run that opens
    ///      nothing turns it into a guaranteed red with a meaningless one-call counterexample. The
    ///      deterministic test below is where this world proves it is not vacuous.

    /// @notice The bounds in this world are ON and they BITE. Deterministic, because "the fuzzer probably
    ///         hit them" is not evidence: a bound that is configured but unreachable protects nobody, and
    ///         this project has already shipped one (the dwell, dominated by the cadence for a whole
    ///         release). Each of the three reachable bounds is driven to its edge and one tick past it.
    function test_bounded_everyEnabledBoundIsReachableAndRefuses() public {
        handler.open(0, 60_000, 1_000, 100e18, 100e18);
        assertEq(handler.idCount(), 1, "premise: the position was not opened");
        uint256 id = handler.ids(0);
        MolePositions.Position memory p = mole.getPosition(id);

        uint256 clock = block.timestamp;
        uint256 height = block.number;

        // --- CADENCE. Immediately after open the keeper is refused, whatever range it asks for.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceTooSoon.selector);
        mole.rebalance(id, p.tickLower + 60, p.tickUpper + 60);

        // --- RECENTER CAP. Past the cadence and the dwell, a move inside the cap is accepted and a move
        //     one tick-spacing beyond it is refused. This is the guard that closed the total-loss path
        //     where a keeper walked a victim's position to a manipulated oracle, so it is the one that
        //     most needs to be shown reaching an actual revert rather than merely being set.
        clock += DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL + 1;
        height += (DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL + 1) / 12;
        vm.warp(clock);
        vm.roll(height);

        int24 cap = DeployConfig.DEFAULT_MAX_RECENTER_TICKS;
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        mole.rebalance(id, p.tickLower + cap + 60, p.tickUpper + cap + 60);

        // ...and the same rebalance INSIDE the cap goes through, so the refusal above is the cap talking
        // and not some unrelated precondition.
        vm.prank(KEEPER);
        mole.rebalance(id, p.tickLower + cap, p.tickUpper + cap);
        MolePositions.Position memory q = mole.getPosition(id);
        assertEq(q.tickLower, p.tickLower + cap, "the in-cap rebalance did not move the range");

        // --- WHAT THE DWELL DOES NOT DO, reproduced here rather than assumed away. The dwell is measured
        //     from `openedAtL1Block` and is never re-armed, so once a position is old enough it is
        //     satisfied forever. Move ONLY the sequencer-written clock — no Ethereum progress at all — and
        //     the next rebalance is allowed. AttackKeeperBounds_bypass records this as a BREAK; it is
        //     asserted again here because the bounded world is the configuration that ships, and a
        //     weakness that lives only in another file's notes is a weakness nobody re-checks.
        clock += DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL + 1;
        vm.warp(clock); // note: no vm.roll — the L1 height does not move
        uint256 frozenHeight = block.number;

        vm.prank(KEEPER);
        mole.rebalance(id, q.tickLower + cap, q.tickUpper + cap);
        assertEq(block.number, frozenHeight, "premise: the L1 height moved after all");
        assertEq(
            mole.getPosition(id).tickLower,
            q.tickLower + cap,
            "the dwell is expected NOT to re-arm -- if this now reverts, the bypass finding is fixed and "
            "this assertion should become the stricter one"
        );

        // --- AND WHAT STILL HOLDS ANYWAY. That is survivable precisely because the recenter cap is
        //     per-rebalance and price-independent: a sequencer with a free clock and no L1 progress still
        //     cannot move this position more than `cap` ticks in any single step, and the owner can exit
        //     between any two of them through a withdrawal path the hook cannot reach.
        MolePositions.Position memory r = mole.getPosition(id);
        clock += DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL + 1;
        vm.warp(clock);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        mole.rebalance(id, r.tickLower + cap + 60, r.tickUpper + cap + 60);

        // INV-1 and INV-4 only, deliberately. Both read the chain — the contract's own token balance, and
        // stored liquidity against the PoolManager's — so they are true regardless of who called what.
        // INV-2, INV-3 and the short-pay check compare against the handler's ghost ledger, and the
        // rebalances above went STRAIGHT to the contract so that specific reverts could be asserted, which
        // the handler swallows. Running them here would fail on a stale ghost and report a bookkeeping
        // artefact as a custody break. The fuzz run covers them properly, through the handler.
        checkINV1();
        checkINV4();
    }
}


/*//////////////////////////////////////////////////////////////////////////////
         T H E   S A M E   I N V A R I A N T S ,   C H A R G I N G   A   F E E
//////////////////////////////////////////////////////////////////////////////*/

/// @notice Every custody invariant again, against a vault charging the shipped 10% performance fee.
///
/// WHY THIS EXISTS. The other two worlds run a vault that takes nothing, so millions of calls have never
/// once exercised the code path that moves value OUT of a position to somebody who is not its owner. That
/// is the single most dangerous thing this contract does, and it is new. A cut computed from the principal
/// component of a delta rather than the fee component is not a rounding bug — it is a deposit tax that
/// looks exactly like normal operation from the outside, and the deep run is where a slow leak surfaces.
///
/// The ghost ledger nets the published rate off an INDEPENDENTLY measured fee figure (see
/// `MoleHandler._expectedCut`), so a vault taking more than it advertises — or taking it from the wrong
/// component — breaks INV-2, INV-3 or the short-pay check rather than being quietly absorbed.
contract InvariantCustodyCharging is MoleCustodyBase {
    function setUp() public {
        _buildWorld(false, false, 1000); // 10%, the shipped default

        targetContract(address(handler));
        _targetHandlerActions();

        excludeSender(address(mole));
        excludeSender(address(manager));
    }

    function invariant_charging_INV1_moleCustodiesNothing() public view {
        checkINV1();
    }

    function invariant_charging_INV2_everyPositionIsSolvent() public view {
        checkINV2();
    }

    function invariant_charging_INV3_noFreeMoney() public view {
        checkINV3();
    }

    function invariant_charging_INV4_storedLiquidityMatchesPoolManager() public view {
        checkINV4();
    }

    function invariant_charging_INV5_keeperCannotDestroyValue() public view {
        checkINV5();
    }

    function invariant_charging_INV6_ownerIsNonZeroAndImmutable() public view {
        checkINV6();
    }

    function invariant_charging_withdrawNeverShortPaysTheOwner() public view {
        checkNoShortPay();
    }

    /// @dev NO `afterInvariant` HERE, and the reason is worth recording because it is not obvious.
    ///      A cumulative "this run actually did something" assertion in `afterInvariant` is fundamentally
    ///      at odds with Foundry's shrinker: the moment ANY run fails it, Foundry minimises the failing
    ///      sequence, arrives at a single call, and reports that a one-call run opened no positions —
    ///      which is true, tautological, and tells you nothing. Both halves of the original assertion hit
    ///      this: a short run of opens and swaps realizes no fees (nothing to take a cut of until a
    ///      withdrawal or rebalance), and a run whose calls all get filtered opens no positions.
    ///      Non-vacuity belongs in a deterministic test, where it can be stated exactly and cannot be
    ///      shrunk into nonsense — which is what the test below is. Foundry's own per-action call table
    ///      covers "did the fuzzer reach every path" far better than an assertion can.

    /// @notice This world's vault genuinely charges, and charges the shipped rate to the wei.
    function test_charging_theFeePathIsLiveInThisWorld() public {
        assertEq(mole.performanceFeeBps(), 1000, "this world is not actually charging");
        assertEq(mole.feeRecipient(), FEE_TREASURY, "the cut is not going where this world thinks");

        handler.open(0, 60_000, 1_000, 100e18, 100e18);
        for (uint256 i; i < 8; ++i) {
            handler.swap(50e18, i % 2, 600);
        }
        handler.withdrawFull(0);

        uint256 t0 = manager.balanceOf(FEE_TREASURY, uint256(uint160(Currency.unwrap(currency0))));
        uint256 t1 = manager.balanceOf(FEE_TREASURY, uint256(uint160(Currency.unwrap(currency1))));
        assertGt(t0 + t1, 0, "a full open/trade/exit cycle collected nothing");

        // And the vault kept none of it, which is the custody claim the fee must not break.
        checkINV1();
    }
}
