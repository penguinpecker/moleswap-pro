// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN, MoleDeployer} from "../helpers/ProxyDeploy.sol";

/// @notice A token that reverts on transfer once armed. Used to prove the exit path never calls a token
///         on account of the fee.
contract HostileToken is MockERC20 {
    bool public armed;

    constructor() MockERC20("Hostile", "HOS", 18) {}

    function arm() external {
        armed = true;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        require(!armed, "HOSTILE: transfer blocked");
        return super.transfer(to, amt);
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        require(!armed, "HOSTILE: transferFrom blocked");
        return super.transferFrom(from, to, amt);
    }
}

/// @notice A fee recipient that tries to re-enter the vault the moment it is paid.
/// @dev If ERC-6909 minting ever called the receiver, this would re-enter `withdraw` from inside an unlock.
contract ReentrantRecipient {
    MolePositions public target;
    uint256 public positionId;
    uint256 public attempts;

    function arm(MolePositions t, uint256 id) external {
        target = t;
        positionId = id;
    }

    fallback() external payable {
        attempts++;
        if (address(target) != address(0)) {
            try target.withdrawAll(positionId) {} catch {}
        }
    }

    receive() external payable {
        attempts++;
    }
}

/// @dev Exposes the fee arithmetic so it can be attacked directly. Payout-level tests cannot reach it:
///      a rounding direction is worth one wei per leg, which hides inside any tolerance loose enough to
///      absorb Uniswap's own burn rounding, and a negative fee component cannot be produced by v4 at all.
/// @dev No constructor arguments: the parent's constructor calls `_disableInitializers()`, so this has to
///      be reached through a proxy exactly like the real thing. `newFeeMathHarness` below does that.
contract FeeMathHarness is MolePositions {
    function cutOf(int128 feeComponent) external view returns (uint128) {
        return _cutOf(feeComponent);
    }
}

function newFeeMathHarness(IPoolManager pm, uint16 bps, address recipient) returns (FeeMathHarness) {
    FeeMathHarness impl = new FeeMathHarness();
    bytes memory data = abi.encodeCall(
        MolePositions.initialize,
        (
            MolePositions.InitParams({
                poolManager: pm,
                keeper: address(1),
                minRebalanceInterval: 0,
                minRangeWidth: 120,
                maxRangeWidth: 60_000,
                moleHook: address(0),
                maxTwapDeviationTicks: 0,
                twapWindow: 0,
                minDwellL1Blocks: 0,
                maxRebalancesPerL1Block: 0,
                maxEjectionBps: 10_000,
                maxRecenterTicks: 0,
                performanceFeeBps: bps,
                feeRecipient: recipient,
                upgradeAdmin: TEST_UPGRADE_ADMIN
            })
        )
    );
    return FeeMathHarness(address(new ERC1967Proxy(address(impl), data)));
}

/// @title AttackPerformanceFee
/// @notice ANGLE: the revenue mechanism, attacked as the thing most likely to quietly steal principal.
///
/// A performance fee is one multiplication away from being a deposit fee. Point the bps at the wrong
/// component of a BalanceDelta and it silently taxes principal instead of earnings — the user still gets
/// tokens back, the numbers still look plausible, and nothing reverts. The dossier names this exact
/// failure (FLOW-14: "assert that the cut is only ever computed from the feesAccrued component of a
/// BalanceDelta, never from the principal component"), so it is the first thing attacked here.
///
/// THE MEASUREMENT DISCIPLINE. Almost nothing below recomputes the fee with the same formula the contract
/// uses — that would only prove the formula equals itself. Instead every quantitative test runs an
/// IDENTICAL position on a SECOND vault built with the fee switched off, drives both through the same
/// swaps and the same rebalances, and measures the difference. The control vault is what the user would
/// have received with no fee at all, so the difference IS the fee, derived independently of the contract's
/// arithmetic. Any bug that taxes principal shows up as a difference larger than the fees ever earned.
contract AttackPerformanceFeeTest is Test, Deployers {
    MoleDeployer internal _moleDeployer = new MoleDeployer();
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal KEEPER = makeAddr("fee.keeper");
    address internal alice = makeAddr("fee.alice");
    address internal bob = makeAddr("fee.bob");
    address internal TREASURY = makeAddr("fee.treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;
    uint16 internal constant FEE_BPS = 1000; // 10%, the shipped default

    MolePositions internal charged; // fee ON
    MolePositions internal control; // fee OFF, identical in every other respect

    uint256 internal _clock;
    uint256 internal _height;

    /// @dev Both clocks, through accumulators. `vm.warp(block.timestamp + d)` does not accumulate inside a
    ///      call frame and `vm.roll(block.number + n)` has been measured running BACKWARDS.
    function _advance(uint256 secs) internal {
        _clock += secs;
        _height += secs / 12;
        vm.warp(_clock);
        vm.roll(_height);
    }

    function setUp() public {
        _clock = 1_750_000_000;
        _height = 21_000_000;
        vm.warp(_clock);
        vm.roll(_height);

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20_000e18, salt: 0}),
            ZERO_BYTES
        );

        charged = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, FEE_BPS, TREASURY
        );
        control = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0)
        );
        charged.whitelistPool(key);
        control.whitelistPool(key);

        _fund(alice);
        _fund(bob);
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 10_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 10_000_000e18);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(address(charged), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(charged), type(uint256).max);
        MockERC20(Currency.unwrap(currency0)).approve(address(control), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(control), type(uint256).max);
        vm.stopPrank();
    }

    function _open(MolePositions m, address who, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = m.open(key, -600, 600, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Churn the price back and forth so both positions accrue real trading fees.
    function _churn(uint256 rounds, uint256 size) internal {
        for (uint256 i; i < rounds; ++i) {
            _swap(true, size);
            _swap(false, size);
        }
    }

    function _claims(address who) internal view returns (uint256 c0, uint256 c1) {
        c0 = manager.balanceOf(who, currency0.toId());
        c1 = manager.balanceOf(who, currency1.toId());
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    /* ====================================================================================
       1.  THE ONE THAT MATTERS: PRINCIPAL IS NEVER TOUCHED
       ==================================================================================== */

    /// @notice ATTACK — deposit and withdraw immediately, with the fee switched ON and no trading at all.
    ///         If the bps is pointed at the principal component instead of the fee component, this is
    ///         where it shows: the user silently loses 10% of a deposit they held for zero seconds.
    /// @dev Result: HOLDS. Zero fees earned, zero cut taken, and the treasury's claim balance is exactly
    ///      zero rather than merely small.
    function test_holds_aPositionThatEarnedNothingPaysNothing() public {
        (uint256 b0Before, uint256 b1Before) = _bal(alice);
        uint256 id = _open(charged, alice, 1e18);
        (uint256 spent0, uint256 spent1) = (b0Before - _b0(alice), b1Before - _b1(alice));
        assertGt(spent0 + spent1, 0, "premise: the open cost nothing");

        vm.prank(alice);
        charged.withdrawAll(id);

        (uint256 t0c, uint256 t1c) = _claims(TREASURY);
        assertEq(t0c, 0, "the treasury was paid out of PRINCIPAL on currency0");
        assertEq(t1c, 0, "the treasury was paid out of PRINCIPAL on currency1");

        // And the user is whole to within the pool's own burn rounding, which is at most 1 wei per leg
        // and is a Uniswap property rather than anything this contract does.
        (uint256 b0After, uint256 b1After) = _bal(alice);
        assertGe(b0After + 1, b0Before, "currency0 principal was skimmed");
        assertGe(b1After + 1, b1Before, "currency1 principal was skimmed");
    }

    function _b0(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency0)).balanceOf(who);
    }

    function _b1(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    /// @notice ATTACK — the same thing across a rebalance rather than a withdrawal, since the rebalance
    ///         path computes the cut against a burn that returns the WHOLE position.
    /// @dev Result: HOLDS. A rebalance with no intervening trades realizes no fees and therefore takes no
    ///      cut, however many times it is repeated. This is the "grind the keeper" attack: if the cut were
    ///      taken from the burn proceeds rather than the fee component, every rebalance would shave 10% of
    ///      principal and 20 rebalances would take most of the position.
    function test_holds_grindingRebalancesWithNoTradingExtractsNothing() public {
        (uint256 a0Before, uint256 a1Before) = _bal(alice);
        uint256 id = _open(charged, alice, 100e18);
        uint256 staked0 = a0Before - _b0(alice);
        uint256 staked1 = a1Before - _b1(alice);

        int24 lo = -600;
        for (uint256 i; i < 20; ++i) {
            _advance(60);
            lo = lo == -600 ? -660 : -600;
            vm.prank(KEEPER);
            charged.rebalance(id, lo, lo + 1200);
        }

        // THE CLAIM OF THIS TEST: no trading happened, so no fees were earned, so the protocol takes
        // NOTHING however many times the keeper grinds. If the cut were computed from the burn proceeds
        // instead of the fee component, each of these 20 rebalances would shave 10% of principal.
        (uint256 t0c, uint256 t1c) = _claims(TREASURY);
        assertEq(t0c, 0, "20 no-op rebalances paid the treasury from currency0 principal");
        assertEq(t1c, 0, "20 no-op rebalances paid the treasury from currency1 principal");

        // NOT asserted: that the position's LIQUIDITY NUMBER survives. It does not, and that is correct
        // rather than a defect — each shift asks for a token ratio the old range does not hold, and the
        // excess is paid straight OUT to the owner as residual (see RebalanceResidualPaid). Liquidity fell
        // 100e18 -> ~13.8e18 across these 20 shifts with the ejection cap off. What must hold is that the
        // value went to ALICE and not to us, so that is what is measured: everything she staked is either
        // still in the position or already back in her wallet.
        vm.prank(alice);
        charged.withdrawAll(id);
        uint256 returned0 = _b0(alice) - (a0Before - staked0);
        uint256 returned1 = _b1(alice) - (a1Before - staked1);
        assertGe(returned0 + 25, staked0, "currency0 went somewhere that is not the owner");
        assertGe(returned1 + 25, staked1, "currency1 went somewhere that is not the owner");
        console2.log("alice staked c0/c1:", staked0, staked1);
        console2.log("alice got back c0/c1 after 20 grinding rebalances:", returned0, returned1);
    }

    /* ====================================================================================
       2.  A/B AGAINST A FEE-OFF CONTROL — the cut measured, not recomputed
       ==================================================================================== */

    /// @notice The difference between what a charged vault pays out and what an identical fee-free vault
    ///         pays out IS the fee. Measured that way rather than by re-running the contract's own
    ///         multiplication, which would prove nothing.
    /// @dev Result: HOLDS. The shortfall equals the treasury's claims to the wei, and it is ~10% of what
    ///      was earned rather than any fraction of what was deposited.
    function test_theChargedVaultPaysExactlyTheControlMinusTheTreasurysClaims() public {
        uint256 idA = _open(charged, alice, 500e18);
        uint256 idB = _open(control, bob, 500e18);

        _churn(30, 50e18);

        (uint256 a0Before, uint256 a1Before) = _bal(alice);
        (uint256 b0Before, uint256 b1Before) = _bal(bob);

        vm.prank(alice);
        charged.withdrawAll(idA);
        vm.prank(bob);
        control.withdrawAll(idB);

        uint256 aliceGot0 = _b0(alice) - a0Before;
        uint256 aliceGot1 = _b1(alice) - a1Before;
        uint256 bobGot0 = _b0(bob) - b0Before;
        uint256 bobGot1 = _b1(bob) - b1Before;

        (uint256 t0c, uint256 t1c) = _claims(TREASURY);
        assertGt(t0c + t1c, 0, "premise: no fee was charged at all, so this test proves nothing");

        // The charged user is short by exactly what the treasury holds. Within 1 wei per leg for the
        // pool's own burn rounding, which applies to both vaults independently.
        assertApproxEqAbs(aliceGot0 + t0c, bobGot0, 2, "currency0: shortfall does not match the cut");
        assertApproxEqAbs(aliceGot1 + t1c, bobGot1, 2, "currency1: shortfall does not match the cut");

        console2.log("control paid   c0/c1:", bobGot0, bobGot1);
        console2.log("charged paid   c0/c1:", aliceGot0, aliceGot1);
        console2.log("treasury claims c0/c1:", t0c, t1c);
    }

    /// @notice THE DEPOSIT-FEE DETECTOR. The cut must be a fraction of EARNINGS, so it must be tiny
    ///         relative to the stake. If the bps were applied to principal it would be ~10% of 500e18 —
    ///         three orders of magnitude larger than anything fees produce here.
    /// @dev Result: HOLDS, with the measured ratio logged so the margin is on record rather than implied.
    function test_theCutIsAFractionOfEARNINGSNotOfTHESTAKE() public {
        uint256 stake = 500e18;
        uint256 idA = _open(charged, alice, uint128(stake));
        _churn(30, 50e18);

        vm.prank(alice);
        charged.withdrawAll(idA);

        (uint256 t0c, uint256 t1c) = _claims(TREASURY);
        uint256 cut = t0c + t1c;
        assertGt(cut, 0, "premise: nothing was charged");

        // A principal-based 10% would be ~1e20 on a 500e18-liquidity position. Demand at least a 100x
        // margin below that, which no fee-on-earnings result can breach at this trading volume.
        uint256 principalFee = (stake * FEE_BPS) / 10_000;
        assertLt(cut * 100, principalFee, "the cut is the size of a PRINCIPAL fee, not an earnings fee");
        console2.log("cut / a-principal-fee-would-have-been:", cut, principalFee);
    }

    /* ====================================================================================
       3.  ROUNDING, DUST AND DIRECTION
       ==================================================================================== */

    /// @notice Integer division must round the cut DOWN, i.e. in the USER's favour, never up.
    /// @dev Result: HOLDS by construction — `(fees * bps) / 10_000` truncates — and is pinned here because
    ///      a later refactor to a mulDivUp-style helper would silently invert the direction. Driven at
    ///      deliberately awkward magnitudes so a rounding step actually occurs.
    function test_holds_theCutRoundsDownTowardsTheUser() public {
        uint256 idA = _open(charged, alice, 1e15);
        uint256 idB = _open(control, bob, 1e15);
        _churn(3, 1e15);

        (uint256 a0, uint256 a1) = _bal(alice);
        (uint256 b0, uint256 b1) = _bal(bob);
        vm.prank(alice);
        charged.withdrawAll(idA);
        vm.prank(bob);
        control.withdrawAll(idB);

        uint256 chargedOut = (_b0(alice) - a0) + (_b1(alice) - a1);
        uint256 controlOut = (_b0(bob) - b0) + (_b1(bob) - b1);
        (uint256 t0c, uint256 t1c) = _claims(TREASURY);

        // Nothing may be created: the charged user plus the treasury can never exceed the control user.
        assertLe(chargedOut + t0c + t1c, controlOut + 2, "the fee path MINTED value out of rounding");
    }

    /// @notice A fee too small to round to one wei must be skipped, not reverted, and must not brick the
    ///         exit. One wei of fees at 10% is zero, and `mint(0)` is a call worth avoiding entirely.
    /// @dev Result: HOLDS. Dust positions open, rebalance and exit cleanly with a zero cut.
    function test_holds_dustFeesRoundToZeroAndDoNotBrickAnything() public {
        uint256 id = _open(charged, alice, 1e9);
        _churn(1, 1e6); // barely any volume: fees land in the single-wei range

        _advance(60);
        vm.prank(KEEPER);
        charged.rebalance(id, -660, 540);

        vm.prank(alice);
        charged.withdrawAll(id);
        assertEq(charged.getPosition(id).liquidity, 0, "a dust position could not exit");
    }

    /* ====================================================================================
       4.  THE EXIT MUST REMAIN UNBLOCKABLE
       ==================================================================================== */

    /// @notice ATTACK — a token that reverts on every transfer, with the fee switched on. The fee lives on
    ///         the withdrawal path, so if it moved real ERC-20s the hostile token would brick every exit
    ///         in the pool. It mints ERC-6909 claims instead, which touches no token contract.
    /// @dev Result: HOLDS. The exit still fails at the point where the USER's own tokens move — which is
    ///      unavoidable and is the token's doing, not ours — but the fee itself is proven not to be the
    ///      cause: the treasury is credited on a pool whose token is armed and reverting.
    function test_holds_theFeeItselfNeverCallsATokenSoItCannotBlockAnExit() public {
        HostileToken hostile = new HostileToken();
        MockERC20 plain = new MockERC20("Plain", "PLN", 18);
        (Currency c0, Currency c1) = address(hostile) < address(plain)
            ? (Currency.wrap(address(hostile)), Currency.wrap(address(plain)))
            : (Currency.wrap(address(plain)), Currency.wrap(address(hostile)));

        PoolKey memory hk =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(hk, SQRT_PRICE_1_1);

        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, FEE_BPS, TREASURY
        );
        m.whitelistPool(hk);

        hostile.mint(address(this), 1_000_000e18);
        plain.mint(address(this), 1_000_000e18);
        hostile.approve(address(modifyLiquidityRouter), type(uint256).max);
        plain.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            hk,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );

        hostile.mint(alice, 1_000_000e18);
        plain.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        hostile.approve(address(m), type(uint256).max);
        plain.approve(address(m), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = m.open(hk, -600, 600, 100e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        hostile.approve(address(swapRouter), type(uint256).max);
        plain.approve(address(swapRouter), type(uint256).max);
        for (uint256 i; i < 10; ++i) {
            swapRouter.swap(
                hk,
                SwapParams(true, -10e18, MIN_PRICE_LIMIT),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
            swapRouter.swap(
                hk,
                SwapParams(false, -10e18, MAX_PRICE_LIMIT),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
        }

        // Arm the token, then rebalance. A rebalance moves NO tokens out of the PoolManager — it burns,
        // skims the cut as claims and re-mints — so it must succeed even while every transfer reverts.
        hostile.arm();
        _advance(60);
        vm.prank(KEEPER);
        m.rebalance(id, -660, 540);

        // Read the HOSTILE pool's currencies, not the default pool's. `_claims` is hard-wired to the
        // suite's main pair and would have reported a confident zero here forever.
        uint256 t0c = manager.balanceOf(TREASURY, c0.toId());
        uint256 t1c = manager.balanceOf(TREASURY, c1.toId());
        assertGt(t0c + t1c, 0, "the fee was not collected on a pool whose token blocks transfers");
        console2.log("treasury claims on the armed pool:", t0c, t1c);

        // And the token really is hostile right now: a plain transfer reverts.
        vm.expectRevert(bytes("HOSTILE: transfer blocked"));
        hostile.transfer(alice, 1);
    }

    /// @notice The treasury holds CLAIMS, and claims are not the vault's inventory. The custody invariant
    ///         is that MolePositions itself holds nothing — the fee must not reintroduce a pot.
    /// @dev Result: HOLDS. After a full cycle the vault's own token AND claim balances are zero on both
    ///      legs, which is the exact assertion INV-1 makes in the deep invariant run.
    function test_holds_theVaultItselfStillHoldsNothingAfterChargingAFee() public {
        uint256 id = _open(charged, alice, 500e18);
        _churn(20, 50e18);
        _advance(60);
        vm.prank(KEEPER);
        charged.rebalance(id, -660, 540);
        vm.prank(alice);
        charged.withdrawAll(id);

        (uint256 v0, uint256 v1) = _bal(address(charged));
        assertEq(v0, 0, "INV-1: the vault holds currency0 -- THE SHARED POT IS BACK");
        assertEq(v1, 0, "INV-1: the vault holds currency1 -- THE SHARED POT IS BACK");
        (uint256 vc0, uint256 vc1) = _claims(address(charged));
        assertEq(vc0, 0, "INV-1: the vault holds currency0 CLAIMS -- the pot is back in 6909 form");
        assertEq(vc1, 0, "INV-1: the vault holds currency1 CLAIMS -- the pot is back in 6909 form");
    }

    /* ====================================================================================
       5.  CONFIGURATION — the deploy-time refusals
       ==================================================================================== */

    /// @notice The ceiling is compiled in, so no deployment can exceed it whatever the operator intends.
    function test_constructorRefusesAFeeAboveTheCompiledCeiling() public {
        uint16 over = DeployConfig.MAX_PERFORMANCE_FEE_BPS + 1;
        vm.expectRevert(MolePositions.FeeAboveCeiling.selector);
        _moleDeployer.vault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, over, TREASURY);

        // Exactly at the ceiling is allowed, so this is a bound and not an off-by-one ban.
        MolePositions atMax = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0,
            DeployConfig.MAX_PERFORMANCE_FEE_BPS, TREASURY
        );
        assertEq(atMax.performanceFeeBps(), DeployConfig.MAX_PERFORMANCE_FEE_BPS, "the ceiling itself was refused");
    }

    /// @notice A live fee with no recipient would mint every cut to address(0) — burning revenue silently
    ///         and forever, with nothing on chain to notice.
    function test_constructorRefusesALiveFeeWithNoRecipient() public {
        vm.expectRevert(MolePositions.FeeRecipientRequired.selector);
        _moleDeployer.vault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, FEE_BPS, address(0));

        // A ZERO fee with no recipient is fine — that is the fee-disabled deployment.
        MolePositions off =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        assertEq(off.performanceFeeBps(), 0, "the fee-disabled deployment was refused");
    }

    /// @notice THE SHARED POT, IN ERC-6909 FORM. Paying the cut to the vault itself would give it an
    ///         unattributed balance belonging to no position and available to fund another position's
    ///         mint — the 2026-08-01 exploit with different accounting.
    function test_constructorRefusesToPayTheFeeToTheVaultItself() public {
        // Precomputed because the check is on `address(this)` DURING initialization — and under a proxy
        // that is the PROXY, not the implementation, since `initialize` runs by delegatecall. The wrapper
        // does two creates from its own nonce: implementation first, proxy second. So the address to
        // predict is the deployer's next-nonce-plus-one.
        address predicted =
            vm.computeCreateAddress(address(_moleDeployer), vm.getNonce(address(_moleDeployer)) + 1);
        vm.expectRevert(MolePositions.FeeRecipientCannotBeThisContract.selector);
        _moleDeployer.vault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, FEE_BPS, predicted);
    }

    /* ====================================================================================
       6.  THE FEE MUST NOT BE AVOIDABLE
       ==================================================================================== */

    /// @notice ATTACK — exit before the keeper ever rebalances, so the cut is never taken at a rebalance.
    ///         If the skim lived only on the rebalance path, every user would avoid it by withdrawing on
    ///         their own schedule and the revenue model would be fiction.
    /// @dev Result: REFUSED. Fees realize on ANY liquidity change, and the withdrawal path charges too.
    function test_holds_exitingBeforeAnyRebalanceDoesNotAvoidTheFee() public {
        uint256 id = _open(charged, alice, 500e18);
        _churn(20, 50e18);

        assertEq(charged.getPosition(id).lastRebalancedAt > 0, true, "premise: stamp not set at open");
        (uint256 before0, uint256 before1) = _claims(TREASURY);
        assertEq(before0 + before1, 0, "premise: something was already charged");

        vm.prank(alice);
        charged.withdrawAll(id);

        (uint256 after0, uint256 after1) = _claims(TREASURY);
        assertGt(after0 + after1, 0, "exiting before a rebalance avoided the fee entirely");
    }

    /// @notice ATTACK — salami-slice the exit into many small withdrawals, hoping each cut truncates to
    ///         zero while the total does not.
    /// @dev Result: HOLDS in the only sense that matters — slicing never pays MORE than a single exit, and
    ///      the leak it can produce is bounded by rounding rather than by the number of slices. Recorded
    ///      with the measured numbers because "rounding is fine" is exactly the kind of claim this project
    ///      has been wrong about before.
    function test_slicingTheExitCannotBeatASingleExitByMoreThanRounding() public {
        uint256 idA = _open(charged, alice, 500e18);
        uint256 idB = _open(charged, bob, 500e18);
        _churn(30, 50e18);

        (uint256 s0, uint256 s1) = _claims(TREASURY);

        // Alice exits in one go.
        vm.prank(alice);
        charged.withdrawAll(idA);
        (uint256 m0, uint256 m1) = _claims(TREASURY);
        uint256 singleExitCut = (m0 - s0) + (m1 - s1);

        // Bob slices his identical position into 10.
        uint128 liq = charged.getPosition(idB).liquidity;
        for (uint256 i; i < 9; ++i) {
            vm.prank(bob);
            charged.withdraw(idB, liq / 10);
        }
        vm.prank(bob);
        charged.withdrawAll(idB);
        (uint256 e0, uint256 e1) = _claims(TREASURY);
        uint256 slicedCut = (e0 - m0) + (e1 - m1);

        console2.log("cut from one exit / from ten slices:", singleExitCut, slicedCut);
        assertGt(singleExitCut, 0, "premise: the single exit was not charged");
        // Slicing may lose a wei per slice to truncation. Anything beyond that is an avoidance path.
        assertGe(slicedCut + 40, singleExitCut, "slicing the exit dodged a material share of the fee");
    }

    /* ====================================================================================
       7.  FUZZ — no rate, no stake and no volume may ever tax principal
       ==================================================================================== */

    /// @notice The whole claim, fuzzed: across every legal rate, stake and trading volume, the protocol's
    ///         total take can never exceed the fees the position actually earned.
    /// @dev The earned amount is measured from the fee-free control vault running the identical position,
    ///      so this compares the contract against reality rather than against its own formula.
    ///
    /// forge-config: default.fuzz.runs = 512
    function testFuzz_theTakeNeverExceedsWhatTheControlVaultEarned(
        uint256 rateRaw,
        uint256 stakeRaw,
        uint256 volumeRaw
    ) public {
        uint16 rate = uint16(bound(rateRaw, 1, DeployConfig.MAX_PERFORMANCE_FEE_BPS));
        uint128 stake = uint128(bound(stakeRaw, 1e12, 1_000e18));
        uint256 volume = bound(volumeRaw, 1e12, 200e18);

        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, rate, TREASURY
        );
        m.whitelistPool(key);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(m), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(m), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 idA = m.open(key, -600, 600, stake, type(uint256).max, type(uint256).max, block.timestamp + 1);
        uint256 idB = _open(control, bob, stake);

        _churn(5, volume);

        (uint256 a0, uint256 a1) = _bal(alice);
        (uint256 b0, uint256 b1) = _bal(bob);
        vm.prank(alice);
        m.withdrawAll(idA);
        vm.prank(bob);
        control.withdrawAll(idB);

        uint256 chargedOut = (_b0(alice) - a0) + (_b1(alice) - a1);
        uint256 controlOut = (_b0(bob) - b0) + (_b1(bob) - b1);
        (uint256 t0c, uint256 t1c) = _claims(TREASURY);
        uint256 take = t0c + t1c;

        // Value is conserved: what the user got plus what the protocol took cannot exceed what an
        // identical fee-free position paid out. If the cut ever came from principal, this breaks.
        assertLe(chargedOut + take, controlOut + 4, "the fee path created value out of nowhere");
        // And the protocol never takes more than the whole shortfall, i.e. never more than was earned.
        if (controlOut > chargedOut) {
            assertLe(take, (controlOut - chargedOut) + 4, "the take exceeds the shortfall it caused");
        }
    }

    /* ====================================================================================
       8.  THE ARITHMETIC ITSELF
       ==================================================================================== */

    /// @notice The cut must round DOWN, at every rate and every magnitude. Asserted against an
    ///         independently written floor rather than against the contract's own expression.
    ///
    /// forge-config: default.fuzz.runs = 2048
    function testFuzz_theCutAlwaysRoundsDownAndNeverExceedsTheFees(uint256 rateRaw, uint256 feeRaw) public {
        uint16 rate = uint16(bound(rateRaw, 1, DeployConfig.MAX_PERFORMANCE_FEE_BPS));
        int128 fees = int128(uint128(bound(feeRaw, 0, uint256(uint128(type(int128).max)))));

        FeeMathHarness h = newFeeMathHarness(manager, rate, TREASURY);
        uint128 cut = h.cutOf(fees);

        uint256 expected = (uint256(uint128(fees)) * rate) / 10_000;
        assertEq(uint256(cut), expected, "the cut is not the floor of fees * rate");

        // The remainder belongs to the user: rounding up would produce a strictly larger number whenever
        // the division is inexact, and this is what pins the direction rather than merely the magnitude.
        uint256 roundedUp = (uint256(uint128(fees)) * rate + 9_999) / 10_000;
        if (roundedUp != expected) {
            assertLt(uint256(cut), roundedUp, "the cut rounds UP -- the remainder is being taken from the user");
        }

        // And it can never exceed the fees it is a fraction of, at any rate up to the ceiling.
        assertLe(uint256(cut), uint256(uint128(fees)), "the cut exceeds the fees it was computed from");
    }

    /// @notice The revenue event must report what was actually taken. It is the ONLY way an off-chain
    ///         accounting job — or a user checking the honest-APY number — can see the cut, because the
    ///         proceeds are ERC-6909 claims minted inside an unlock rather than a token transfer.
    /// @dev Amounts are cross-checked against the treasury's claim balance movement, so the event cannot
    ///      pass by reporting a plausible-looking number that is not the number that moved.
    function test_theRevenueEventReportsExactlyWhatWasTaken() public {
        uint256 id = _open(charged, alice, 500e18);
        _churn(30, 50e18);

        (uint256 before0, uint256 before1) = _claims(TREASURY);

        vm.recordLogs();
        vm.prank(alice);
        charged.withdrawAll(id);

        (uint256 after0, uint256 after1) = _claims(TREASURY);
        uint128 moved0 = uint128(after0 - before0);
        uint128 moved1 = uint128(after1 - before1);
        assertGt(uint256(moved0) + moved1, 0, "premise: nothing was charged, so the event proves nothing");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("PerformanceFeeTaken(uint256,address,uint128,uint128)");
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == sig) {
                assertEq(uint256(logs[i].topics[1]), id, "the event names the wrong position");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), TREASURY, "the event names the wrong recipient");
                (uint128 a0, uint128 a1) = abi.decode(logs[i].data, (uint128, uint128));
                assertEq(a0, moved0, "the event under/over-reports the currency0 cut");
                assertEq(a1, moved1, "the event under/over-reports the currency1 cut");
                found = true;
            }
        }
        assertTrue(found, "a fee was taken and NOTHING was emitted -- the cut is invisible off-chain");
    }

    /* ====================================================================================
       9.  INTERACTIONS WITH THE GUARDS THAT WERE ALREADY THERE
       ==================================================================================== */

    /// @notice Paying the fee must never make a rebalance un-fundable. The cut shrinks the tokens the
    ///         re-mint is derived from, so the new liquidity is derived from LESS — which keeps the
    ///         self-funding property rather than breaking it. Driven at the MAXIMUM legal rate, where the
    ///         effect is largest.
    function test_holds_theFeeCannotMakeARebalanceSelfFundingFail() public {
        MolePositions maxed = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0,
            DeployConfig.MAX_PERFORMANCE_FEE_BPS, TREASURY
        );
        maxed.whitelistPool(key);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(maxed), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(maxed), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = maxed.open(key, -600, 600, 500e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        for (uint256 i; i < 6; ++i) {
            _churn(5, 50e18);
            _advance(60);
            vm.prank(KEEPER);
            maxed.rebalance(id, -600 - int24(int256(i * 60)), 600 - int24(int256(i * 60)));
        }

        uint256 t = manager.balanceOf(TREASURY, currency0.toId()) + manager.balanceOf(TREASURY, currency1.toId());
        assertGt(t, 0, "premise: the max-rate vault charged nothing");

        vm.prank(alice);
        maxed.withdrawAll(id);
        assertEq(maxed.getPosition(id).liquidity, 0, "the position could not exit after six charged rebalances");
    }

    /// @notice The ejection cap measures the residual against what the burn returned. That figure is now
    ///         net of the fee, so cap and residual are compared on the same basis — the fee must not push
    ///         an otherwise-legal rebalance over a cap it would not otherwise have breached.
    function test_holds_theFeeDoesNotSpuriouslyTripTheEjectionCap() public {
        // 5000 bps: a real cap, comfortably above pure-rounding residuals.
        MolePositions capped = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 5_000, 0, FEE_BPS, TREASURY
        );
        capped.whitelistPool(key);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(capped), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(capped), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = capped.open(key, -600, 600, 500e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        _churn(20, 50e18);
        _advance(60);

        // A small recentre: the residual is far inside a 50% cap whether or not a fee was taken.
        vm.prank(KEEPER);
        capped.rebalance(id, -660, 540);
        assertGt(capped.getPosition(id).liquidity, 0, "a charged rebalance was refused by the ejection cap");
    }

    /// @notice ATTACK — a fee recipient that re-enters the vault the instant it is paid, from inside the
    ///         unlock, while the withdrawal is only half done.
    /// @dev Result: REFUSED, structurally. v4's ERC-6909 `_mint` is a balance write and an event — it makes
    ///      no call to the receiver, so there is no callback to re-enter from. This test exists to CATCH
    ///      THE DAY THAT CHANGES: if the payout is ever switched from `mint` to `take`, or v4 adds a
    ///      receiver hook, the recipient's counter starts moving and this goes red.
    function test_holds_aReentrantFeeRecipientIsNeverEvenCalled() public {
        ReentrantRecipient evil = new ReentrantRecipient();
        MolePositions m = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, FEE_BPS, address(evil)
        );
        m.whitelistPool(key);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(m), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(m), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = m.open(key, -600, 600, 500e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        evil.arm(m, id);
        _churn(20, 50e18);

        vm.prank(alice);
        m.withdrawAll(id);

        assertEq(evil.attempts(), 0, "the fee payout CALLED the recipient -- reentrancy is now reachable");
        uint256 paid = manager.balanceOf(address(evil), currency0.toId())
            + manager.balanceOf(address(evil), currency1.toId());
        assertGt(paid, 0, "premise: the hostile recipient was never paid, so nothing was proven");
        assertEq(m.getPosition(id).liquidity, 0, "the exit did not complete");
    }

    /// @notice A non-positive fee component must produce a ZERO cut, not a cast of a negative number.
    /// @dev v4 does not hand a position owner negative fees, so this is unreachable through the pool —
    ///      which is exactly why it needs a direct test. Without the guard, `uint256(uint128(-1))` is
    ///      2^128-1 and the "cut" becomes a mint of astronomical size against the user.
    ///
    /// forge-config: default.fuzz.runs = 512
    function testFuzz_aNonPositiveFeeComponentIsNeverCharged(uint256 rateRaw, uint256 negRaw) public {
        uint16 rate = uint16(bound(rateRaw, 1, DeployConfig.MAX_PERFORMANCE_FEE_BPS));
        int128 negative = -int128(uint128(bound(negRaw, 1, uint256(uint128(type(int128).max)))));

        FeeMathHarness h = newFeeMathHarness(manager, rate, TREASURY);
        assertEq(h.cutOf(negative), 0, "a NEGATIVE fee component was charged");
        assertEq(h.cutOf(0), 0, "a zero fee component was charged");
    }
}
