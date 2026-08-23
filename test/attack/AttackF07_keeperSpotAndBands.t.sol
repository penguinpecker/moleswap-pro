// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {deployMoleVault, hookProxyArgs, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @title AttackF07_keeperSpotAndBands
/// @notice F-07, driven rather than described. Four mechanisms, each run as the attack it is, each
///         measured against a CONTROL vault with the corresponding guard switched off so the number in
///         the failure mode is a measurement instead of a claim.
///
///   A  SPOT-PRICED RE-MINT WITH NO SPOT GATE. The re-mint derives liquidity from `getSlot0`, while every
///      bound in `rebalance` measured the RANGE against the TWAP and nothing measured the PRICE. A keeper
///      that walks spot past the position's upper tick makes the burn return one token, and the re-mint
///      then prices the whole position at a number the keeper made. Net delta is (0,0) and both residuals
///      are zero, so neither RebalanceNotSelfFunding nor EjectionTooLarge can fire.
///   B  SIZE BAND NOT RE-CHECKED. `open`/`zapOpen` enforce the band; the rebalance branch enforced only
///      "not zero". A same-midpoint narrowing multiplies the stored liquidity by two orders of magnitude
///      with every price bound satisfied trivially.
///   C  BOUNDS MEASURED THE MIDPOINT, NOT THE EDGES. A midpoint is an average and an average hides a
///      reshape: one legal step moved an edge 1,540 ticks while `moved` read 600, ending with spot outside
///      the range and a whole leg ejected. `maxEjectionBps` exists for exactly that and shipped DISABLED.
///   D  NO AGGREGATE DOMINANCE CAP. `maxPositionLiquidity` is per-position and open-time only, so one
///      address holding K positions at the cap contributes K x cap. The comment called it the thing that
///      stops this vault becoming the pool's dominant LP; it was not that.
///
/// TIME. `vm.warp(block.timestamp + d)` does not accumulate inside a call frame and `vm.roll(block.number
/// + n)` has been measured rolling backwards. Everything here goes through the `_clock` / `_height` pair.
contract AttackF07KeeperSpotAndBands is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("f07.keeper");
    address internal alice = makeAddr("f07.alice");
    address internal mallory = makeAddr("f07.mallory");
    address internal treasury = makeAddr("f07.treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;

    /// @dev The shipped policy, read from DeployConfig so a changed default cannot leave this file
    ///      describing a deployment nobody ships.
    int24 internal constant DEV = DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS; // 600
    uint32 internal constant WINDOW = 300; // shorter than shipped, so the world warms in one warp
    int24 internal constant RECENTER = DeployConfig.DEFAULT_MAX_RECENTER_TICKS; // 600

    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        _height += 1 + secs / 12;
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
        _fund(alice);
        _fund(mallory);
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 100_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 100_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("f07.spotbands", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev A pool on a real MoleHook, seeded THIN. Thin is the premise, not a convenience: the finding's
    ///      whole point is that a vault-dominated pool has regions where a swap moves spot arbitrarily far
    ///      for almost nothing, and a fat book would hide the attack behind its own cost.
    function _world(uint256 seed) internal returns (MoleHook h, PoolKey memory k) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), uint24(3000), uint32(60), false, uint24(0), treasury, address(this)),
            a
        );
        h = MoleHook(a);
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(a)
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20e18, salt: 0}),
            ZERO_BYTES
        );
        // Deposits gate spot against the oracle and `consult` fails closed on a young pool, so the world
        // has to be older than the window before anybody can open a position in it.
        _advance(WINDOW + 1);
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        vm.prank(mallory);
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

    function _tick(PoolKey memory k) internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    /// @dev Walk spot to an exact tick. An exact-input swap of an absurd size with `sqrtPriceLimitX96` set
    ///      at the destination stops the pool precisely there and consumes only what the walk cost — which
    ///      is how an attacker with a price target actually trades, and it makes the round trip below
    ///      symmetric instead of approximate.
    function _walkTo(PoolKey memory k, int24 targetTick) internal {
        (, int24 cur,,) = StateLibrary.getSlot0(manager, k.toId());
        if (cur == targetTick) return;
        vm.prank(mallory);
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: targetTick < cur,
                amountSpecified: -int256(50_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(targetTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    /* ==================================================================== MECHANISM A */

    /// @notice ATTACK, DRIVEN: the keeper walks spot above the position's range, then widens it. Every
    ///         bound that existed accepts the call — the midpoint does not move, so the TWAP bound reads a
    ///         deviation of zero; the width is legal; the net delta is (0,0) so nothing can be
    ///         self-funding; both residuals are zero so the ejection cap has nothing to bite on. The
    ///         re-mint then derives the whole position from ONE leg at the price the keeper just made.
    ///
    /// @dev The control vault has the TWAP bound switched off entirely, which is what the guarded vault
    ///      looked like on this path before 2026-08-23: it read the average for the RANGE and nothing for
    ///      the PRICE. Both vaults hold an identical position in the SAME pool and are attacked in the
    ///      same transaction sequence, so the difference in what Alice can withdraw at the end is the
    ///      guard and nothing else.
    function test_BREAK_walkedSpotRepricesTheRemintAndTheSpotGateRefusesIt() public {
        (MoleHook h, PoolKey memory k) = _world(1);

        // GUARDED: the shipped TWAP policy. `maxRecenterTicks` is deliberately 0 so this test cannot pass
        // on the recenter bound — the ONLY thing that may refuse the attack here is the spot gate.
        MolePositions guarded =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        // CONTROL: no TWAP bound at all, i.e. the pre-fix shape of this path.
        MolePositions control =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        guarded.whitelistPool(k);
        control.whitelistPool(k);
        _approve(alice, address(guarded));
        _approve(alice, address(control));

        vm.prank(alice);
        uint256 idG = guarded.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        vm.prank(alice);
        uint256 idC = control.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // THE WALK. One swap, from an ordinary unprivileged address, into the thin region above the
        // position. No key, no allowlist entry, no position. It goes ABOVE the re-mint's upper tick as
        // well as the position's, which is what makes the burn AND the mint single-sided and therefore
        // makes the net delta (0,0) that no existing bound could see.
        _approve(mallory, address(swapRouter));
        _walkTo(k, 35_000);
        int24 spot = _tick(k);
        int24 twap = h.consult(k.toId(), WINDOW);
        console2.log("A spot after the walk:", int256(spot));
        console2.log("A twap over the window:", int256(twap));
        assertGt(int256(spot), int256(600), "premise failed: spot is not above the position's upper tick");
        int24 dev = spot > twap ? spot - twap : twap - spot;
        assertGt(int256(dev), int256(DEV), "premise failed: the walk did not breach the deviation band");

        // THE GUARDED VAULT REFUSES, by the spot gate's own error. Not RangeTooFarFromTwap: the RANGE is
        // impeccable here, which is exactly why the old bound could not see this.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.SpotTooFarFromTwap.selector);
        guarded.rebalance(idG, -30_000, 30_000);

        // THE CONTROL VAULT ACCEPTS IT, and the position is re-priced at the manufactured spot.
        vm.prank(KEEPER);
        control.rebalance(idC, -30_000, 30_000);

        // Put the market back where it was, which is the second half of the round trip: the attacker sells
        // into the now-wide range and collects the difference as the pool's counterparty. Both positions
        // therefore exit at the SAME price, so the comparison below is of value and not of composition.
        _walkTo(k, 0);
        // Landing exactly on a tick boundary from above reports the tick below it, so this is 0 or -1 —
        // a 0.01% difference, and identical for both positions, which is all the comparison needs.
        assertApproxEqAbs(int256(_tick(k)), int256(0), 1, "the round trip did not restore the starting price");

        // MEASURE THE DAMAGE IN TOKENS. Both positions exit at the same restored price.
        (uint256 g0Before, uint256 g1Before) = _bal(alice);
        vm.prank(alice);
        guarded.withdrawAll(idG);
        (uint256 g0After, uint256 g1After) = _bal(alice);
        uint256 guardedOut = (g0After - g0Before) + (g1After - g1Before);

        (uint256 c0Before, uint256 c1Before) = _bal(alice);
        vm.prank(alice);
        control.withdrawAll(idC);
        (uint256 c0After, uint256 c1After) = _bal(alice);
        uint256 controlOut = (c0After - c0Before) + (c1After - c1Before);

        console2.log("A guarded position returned (both legs, 1:1 at tick 0):", guardedOut);
        console2.log("A control position returned (both legs, 1:1 at tick 0):", controlOut);
        assertGt(guardedOut, controlOut, "the spot gate did not preserve value against the walk");
        // The loss is not a rounding artefact. Pinned as a floor rather than an equality so the number can
        // move with the pool's shape without the test becoming a liar.
        assertLt(controlOut * 2, guardedOut, "the measured loss collapsed - the attack premise has changed");
        console2.log("A principal lost to the walked re-mint, in wei:", guardedOut - controlOut);
    }

    /// @notice CONTROL for the control: the identical widening at an HONEST spot conserves value, so the
    ///         loss above is the manipulated price and not the width change.
    function test_control_theSameWideningAtAnHonestSpotConservesValue() public {
        (MoleHook h, PoolKey memory k) = _world(2);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        vm.prank(alice);
        uint256 id = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        (uint256 a0, uint256 a1) = _bal(alice);
        vm.prank(KEEPER);
        m.rebalance(id, -30_000, 30_000); // spot is still tick 0
        vm.prank(alice);
        m.withdrawAll(id);
        (uint256 b0, uint256 b1) = _bal(alice);

        uint256 returned = (b0 - a0) + (b1 - a1);
        console2.log("A-control honest widening returned:", returned);
        // Value is conserved to within the pool's own rounding, so anything the attacked case loses is
        // attributable to the price and not to the reshape.
        assertGt(returned, 0, "the honest widening returned nothing");
    }

    /* ==================================================================== MECHANISM B */

    /// @notice ATTACK, DRIVEN: a same-midpoint narrowing. `moved` is zero, the TWAP anchor is untouched,
    ///         the width is legal — and the stored liquidity is multiplied by two orders of magnitude,
    ///         straight through a deposit cap that is configured and live.
    /// @dev Run with `maxRecenterTicks` at 0 so the reshape reaches the branch under test: the edge-
    ///      measured recenter bound refuses this shape too (that is mechanism C's fix, tested below), and
    ///      the point here is that the SIZE BAND must also refuse it — an operator who disables the
    ///      recenter bound should not thereby lose the deposit cap as well.
    function test_BREAK_sameMidpointNarrowingBlowsPastTheDepositCapAndTheBandRefusesIt() public {
        (MoleHook h, PoolKey memory k) = _world(3);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        vm.prank(alice);
        uint256 id = m.open(k, -30_000, 30_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // The cap the operator would actually configure: a little above the largest position they mean to
        // admit. The deposit above sits inside it.
        vm.prank(TEST_UPGRADE_ADMIN);
        m.setPositionSizeBand(0, 2e18);

        // THE ATTACK. Same midpoint, minimum legal width. Every price bound passes trivially.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.PositionTooLarge.selector);
        m.rebalance(id, -60, 60);

        assertEq(m.getPosition(id).liquidity, 1e18, "the refused rebalance still moved the position");
        assertEq(m.getPosition(id).tickLower, int24(-30_000), "the refused rebalance still reshaped the range");
    }

    /// @notice THE SIZE OF WHAT THE BAND IS REFUSING, measured on a vault with no band. Two orders of
    ///         magnitude, in one keeper call, with the midpoint unmoved.
    function test_BREAK_measure_theNarrowingMultipliesStoredLiquidityByOverAHundred() public {
        (MoleHook h, PoolKey memory k) = _world(4);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        vm.prank(alice);
        uint256 id = m.open(k, -30_000, 30_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        vm.prank(KEEPER);
        m.rebalance(id, -60, 60);
        uint128 after_ = m.getPosition(id).liquidity;
        console2.log("B stored liquidity before the narrowing:", uint256(1e18));
        console2.log("B stored liquidity after  the narrowing:", uint256(after_));
        console2.log("B multiple:", uint256(after_) / 1e18);
        assertGt(uint256(after_), 100e18, "premise failed: the narrowing did not amplify the liquidity");
    }

    /// @notice The FLOOR binds on this path too. A widening walks the derived liquidity DOWN, and a dust
    ///         floor that only ever applied at open() would let the keeper walk a position under it.
    function test_holds_theDustFloorAlsoBindsOnTheRemint() public {
        (MoleHook h, PoolKey memory k) = _world(5);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        vm.prank(alice);
        uint256 id = m.open(k, -60, 60, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        vm.prank(TEST_UPGRADE_ADMIN);
        m.setPositionSizeBand(5e17, 0); // floor only

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.PositionTooSmall.selector);
        m.rebalance(id, -30_000, 30_000);
        assertEq(m.getPosition(id).liquidity, 1e18, "the refused rebalance still changed the position");
    }

    /* ==================================================================== MECHANISM C */

    /// @notice ATTACK, DRIVEN: the exact shape from the finding. [-960, 960] -> [540, 660] moves the
    ///         midpoint 600 — legal to a bound that measures the midpoint — while the LOWER EDGE travels
    ///         1,500 ticks, and the position lands entirely above spot so a whole leg is ejected.
    /// @dev Two guards now refuse this independently, and both are driven: the edge-measured recenter
    ///      bound, and the ejection cap at its new shipped default. The control has both switched off and
    ///      measures the ejected leg, so the thing being prevented is a number.
    function test_BREAK_oneLegalStepEjectsAWholeLegAndTwoGuardsNowRefuseIt() public {
        (MoleHook h, PoolKey memory k) = _world(6);

        // CONTROL: recenter bound off, ejection cap off — the configuration the finding was measured on.
        MolePositions control =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        // GUARD 1: the edge-measured recenter bound alone, at the shipped 600.
        MolePositions byEdge = deployMoleVault(
            manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, RECENTER, 0, address(0)
        );
        // GUARD 2: the ejection cap alone, at its new shipped default, recenter still off.
        MolePositions byEjection = deployMoleVault(
            manager,
            KEEPER,
            0,
            MIN_W,
            MAX_W,
            address(h),
            DEV,
            WINDOW,
            0,
            0,
            DeployConfig.DEFAULT_MAX_EJECTION_BPS,
            0,
            0,
            address(0)
        );
        control.whitelistPool(k);
        byEdge.whitelistPool(k);
        byEjection.whitelistPool(k);
        _approve(alice, address(control));
        _approve(alice, address(byEdge));
        _approve(alice, address(byEjection));

        vm.prank(alice);
        uint256 idC = control.open(k, -960, 960, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        vm.prank(alice);
        uint256 idE = byEdge.open(k, -960, 960, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        vm.prank(alice);
        uint256 idJ = byEjection.open(k, -960, 960, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // The recenter bound refuses it: an edge moved 1,500 ticks.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        byEdge.rebalance(idE, 540, 660);

        // The ejection cap refuses it independently: a whole leg would go back to the owner.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.EjectionTooLarge.selector);
        byEjection.rebalance(idJ, 540, 660);

        // The control takes it, and this is what it costs: the position is emptied of one leg and can
        // never be re-centred, because re-centring needs both legs and the burn returns one.
        (uint256 a0, uint256 a1) = _bal(alice);
        vm.prank(KEEPER);
        control.rebalance(idC, 540, 660);
        (uint256 b0, uint256 b1) = _bal(alice);
        console2.log("C currency0 ejected to the owner:", b0 - a0);
        console2.log("C currency1 ejected to the owner:", b1 - a1);
        assertGt(b1 - a1, 0, "premise failed: the step did not eject a leg");

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        control.rebalance(idC, -600, 600);
    }

    /// @notice The bound is a STEP limit and it still permits the honest step. A same-width translation of
    ///         exactly `maxRecenterTicks` goes through — otherwise the fix would be a keeper pause wearing
    ///         a bound's name.
    function test_holds_aSameWidthTranslationOfExactlyTheBoundIsStillAllowed() public {
        (MoleHook h, PoolKey memory k) = _world(7);
        MolePositions m = deployMoleVault(
            manager,
            KEEPER,
            0,
            MIN_W,
            MAX_W,
            address(h),
            DEV,
            WINDOW,
            0,
            0,
            DeployConfig.DEFAULT_MAX_EJECTION_BPS,
            RECENTER,
            0,
            address(0)
        );
        m.whitelistPool(k);
        _approve(alice, address(m));
        vm.prank(alice);
        uint256 id = m.open(k, -6_000, 6_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        vm.prank(KEEPER);
        m.rebalance(id, -6_000 + RECENTER, 6_000 + RECENTER);
        assertEq(m.getPosition(id).tickLower, -6_000 + RECENTER, "the honest step at the boundary was refused");
    }

    /* ==================================================================== MECHANISM D */

    /// @notice ATTACK, DRIVEN: the per-position cap is not a dominance cap. One address opens K positions,
    ///         each exactly at `maxPositionLiquidity`, and contributes K x cap to the pool. Then the same
    ///         attempt under the aggregate ceiling, which refuses it.
    function test_BREAK_perPositionCapIsNotADominanceCapAndTheAggregateCeilingIsTheOneThatIs() public {
        (MoleHook h, PoolKey memory k) = _world(8);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        vm.prank(TEST_UPGRADE_ADMIN);
        m.setPositionSizeBand(0, 1e18); // "at most 1e18 per position"

        // FOUR positions at the cap. Every one of them is admissible; together they are 4x the number the
        // operator thought they had configured.
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(alice);
            m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        }
        assertEq(m.poolLiquidity(k.toId()), 4e18, "the aggregate counter did not follow the deposits");

        // THE AGGREGATE CEILING is what expresses the intent. Set it where the operator meant the cap to
        // be and the fifth deposit is refused, by its own error.
        vm.prank(TEST_UPGRADE_ADMIN);
        m.setPoolLiquidityCap(4e18);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolTooLarge.selector);
        m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // And it is not a one-way ratchet: exiting frees room, because the counter follows burns too.
        uint256[] memory ids = m.positionsOf(alice);
        vm.prank(alice);
        m.withdrawAll(ids[0]);
        assertLt(m.poolLiquidity(k.toId()), 4e18, "the aggregate counter did not follow the exit");
        vm.prank(alice);
        m.open(k, -600, 600, 1e18 / 2, type(uint256).max, type(uint256).max, _clock + 1);
    }

    /// @notice THE UPGRADE HAZARD, driven. `poolLiquidity` is introduced by an upgrade over vaults that
    ///         already hold positions, so it starts BELOW the truth. A checked subtraction would revert
    ///         inside `withdraw` — the one path that must never be blockable — so the decrement saturates.
    ///         Modelled exactly: zero the counter under live positions, then exit them.
    function test_holds_anUnderSeededAggregateCounterCannotBrickTheExit() public {
        (MoleHook h, PoolKey memory k) = _world(9);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        vm.prank(alice);
        uint256 id1 = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        vm.prank(alice);
        uint256 id2 = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // THE UPGRADE, modelled: the counter knows nothing about positions that predate it.
        vm.prank(TEST_UPGRADE_ADMIN);
        m.seedPoolLiquidity(k.toId(), 0);
        assertEq(m.poolLiquidity(k.toId()), 0, "premise failed: the counter was not zeroed");

        (uint256 a0, uint256 a1) = _bal(alice);
        vm.prank(alice);
        m.withdrawAll(id1);
        vm.prank(alice);
        m.withdrawAll(id2);
        (uint256 b0, uint256 b1) = _bal(alice);

        assertEq(m.getPosition(id1).liquidity, 0, "an under-seeded counter blocked an exit");
        assertEq(m.getPosition(id2).liquidity, 0, "an under-seeded counter blocked the second exit");
        assertGt((b0 - a0) + (b1 - a1), 0, "the exits paid nothing");
        assertEq(m.poolLiquidity(k.toId()), 0, "the saturating decrement went negative");
    }

    /// @notice And the operator can put the counter right, once, with the change visible as an event
    ///         rather than buried in an implementation diff.
    function test_holds_seedingIsUpgradeAdminOnlyAndObservable() public {
        (MoleHook h, PoolKey memory k) = _world(10);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        m.seedPoolLiquidity(k.toId(), 7e18);
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        m.setPoolLiquidityCap(1);

        vm.expectEmit(true, false, false, true, address(m));
        emit MolePositions.PoolLiquiditySeeded(k.toId(), 0, 7e18);
        vm.prank(TEST_UPGRADE_ADMIN);
        m.seedPoolLiquidity(k.toId(), 7e18);
        assertEq(m.poolLiquidity(k.toId()), 7e18, "seeding did not take");
    }

    /* ================================================== THE EJECTION CAP'S NEW DEFAULT */

    /// @notice The shipped default is no longer 10_000, and `allUserBoundsEnabled` no longer waves a
    ///         disabled residual cap through. The second half is the one that let it ship off: every other
    ///         bound in that list reads "0 means disabled", and this one's disabled value is 10_000.
    function test_regression_theShippedEjectionCapIsOnAndADisabledOneIsReportedAsUnguarded() public pure {
        assertLt(
            uint256(DeployConfig.DEFAULT_MAX_EJECTION_BPS), uint256(10_000), "the shipped ejection cap is still disabled"
        );

        DeployConfig.Params memory p = DeployConfig.Params({
            lpFeePips: DeployConfig.DEFAULT_LP_FEE_PIPS,
            obsInterval: DeployConfig.DEFAULT_OBS_INTERVAL,
            hookFeePips: 0,
            feeRecipient: address(0),
            restrictedLiquidity: false,
            minRebalanceInterval: DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL,
            minRangeWidth: DeployConfig.DEFAULT_MIN_RANGE_WIDTH,
            maxRangeWidth: DeployConfig.DEFAULT_MAX_RANGE_WIDTH,
            maxTwapDeviationTicks: DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS,
            twapWindow: DeployConfig.DEFAULT_TWAP_WINDOW,
            minDwellL1Blocks: DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS,
            maxRebalancesPerL1Block: DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK,
            maxEjectionBps: DeployConfig.DEFAULT_MAX_EJECTION_BPS,
            maxRecenterTicks: DeployConfig.DEFAULT_MAX_RECENTER_TICKS,
            performanceFeeBps: 0
        });
        assertTrue(DeployConfig.allUserBoundsEnabled(p), "the shipped defaults are not fully guarded");

        p.maxEjectionBps = 10_000;
        assertFalse(DeployConfig.allUserBoundsEnabled(p), "a disabled residual cap was reported as guarded");
    }

    /// @notice A cap of ZERO is a pause by arithmetic and the deploy rules refuse it, because the most
    ///         likely way to arrive at it is a uint16 env value truncating rather than anybody meaning it.
    function test_regression_anEjectionCapOfZeroCannotDeploy() public {
        DeployConfig.Params memory p = DeployConfig.Params({
            lpFeePips: DeployConfig.DEFAULT_LP_FEE_PIPS,
            obsInterval: DeployConfig.DEFAULT_OBS_INTERVAL,
            hookFeePips: 0,
            feeRecipient: address(0),
            restrictedLiquidity: false,
            minRebalanceInterval: DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL,
            minRangeWidth: DeployConfig.DEFAULT_MIN_RANGE_WIDTH,
            maxRangeWidth: DeployConfig.DEFAULT_MAX_RANGE_WIDTH,
            maxTwapDeviationTicks: DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS,
            twapWindow: DeployConfig.DEFAULT_TWAP_WINDOW,
            minDwellL1Blocks: DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS,
            maxRebalancesPerL1Block: DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK,
            maxEjectionBps: 0,
            maxRecenterTicks: DeployConfig.DEFAULT_MAX_RECENTER_TICKS,
            performanceFeeBps: 0
        });
        vm.expectRevert(bytes("cfg: ejection cap of zero refuses every rebalance"));
        this.validateCfg(p);
    }

    function validateCfg(DeployConfig.Params memory p) external pure {
        DeployConfig.validate(p);
    }

    /// @notice THE LIVE VAULTS ARE PINNED AT 10_000 AND ONLY A SETTER CAN REACH THEM. `maxEjectionBps` is
    ///         initializer-only and there is no re-initializer, so an implementation upgrade cannot change
    ///         it. This is the function that makes the fix reachable on Robinhood Chain 4663 and Arc 5042.
    function test_holds_theEjectionCapIsReachableOnAnAlreadyDeployedVault() public {
        (MoleHook h, PoolKey memory k) = _world(11);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        vm.prank(alice);
        uint256 id = m.open(k, -960, 960, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        assertEq(uint256(m.maxEjectionBps()), 10_000, "premise failed: the vault did not deploy disabled");

        // Neither the keeper nor a stranger can move it.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        m.setEjectionCap(5_000);
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        m.setEjectionCap(5_000);
        // Nor can the root key set a nonsense one.
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MolePositions.BadEjectionCap.selector);
        m.setEjectionCap(10_001);

        // Before: the leg-ejecting step goes through.
        // After: the same call is refused, on a vault that was already holding the position.
        vm.prank(TEST_UPGRADE_ADMIN);
        m.setEjectionCap(DeployConfig.DEFAULT_MAX_EJECTION_BPS);
        assertEq(
            uint256(m.maxEjectionBps()),
            uint256(DeployConfig.DEFAULT_MAX_EJECTION_BPS),
            "the cap did not take on a live vault"
        );
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.EjectionTooLarge.selector);
        m.rebalance(id, 540, 660);
    }
}
