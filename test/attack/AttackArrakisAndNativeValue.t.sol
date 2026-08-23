// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {ZapLogic} from "../../src/libraries/ZapLogic.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {deployMoleVault, hookProxyArgs, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice A depositor that RE-ENTERS on its native refund, which is the only reentrancy point `open` has.
///         It withdraws the position it is in the middle of opening.
contract ReentrantNativeDepositor {
    MolePositions internal immutable vault;
    bool public armed;
    bool public reentered;

    constructor(MolePositions v) {
        vault = v;
    }

    function openAndReenter(PoolKey memory k, int24 lo, int24 hi, uint128 liq, uint256 value)
        external
        payable
        returns (uint256 id)
    {
        armed = true;
        id = vault.open{value: value}(k, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        reentered = true;
        // The position id is not known yet — `open` has not returned — but the vault pushed it onto the
        // owner's list before the unlock, which is exactly the window this tests.
        uint256[] memory ids = vault.positionsOf(address(this));
        vault.withdrawAll(ids[ids.length - 1]);
    }
}

/// @title AttackArrakisAndNativeValue
/// @notice TWO FINDINGS THAT SHARE A SHAPE: a documented precondition that did not exist.
///
/// THE ARRAKIS CLASS. On 2026-08-23 the Arrakis V1 G-UNI vault was drained because `mint()` and `burn()`
/// valued the position off instantaneous `slot0` with no TWAP or deviation guard, while the vault's TWAP
/// check guarded only the manager's `rebalance()`. MolePositions had the identical asymmetry: `rebalance`
/// consulted the oracle, and `open` / `zapOpen` — both of which derive liquidity from `getSlot0` — consulted
/// nothing. This file drives a deposit at a walked spot and measures what the depositor gets back, then
/// shows the gate refusing the same deposit.
///
/// AND THE EXIT, WHICH IS DELIBERATELY NOT GATED. A price gate on `withdraw` would hand whoever can move
/// spot a lever that reverts every withdrawal in the vault. The exit stays unconditional; a user who wants
/// price protection on the way out passes their OWN floor to `withdrawWithMinimums`, which nobody else can
/// trip. Both halves are pinned here, next to each other, because the asymmetry is the design.
///
/// F-10. `_refundNative` swept the contract's WHOLE ETH balance to `msg.sender`, justified by "this
/// contract holds no ETH between transactions by construction" — true for voluntary sends and not
/// enforceable against forced ETH. Meanwhile `_settleFrom`'s native branch documented a `msg.value` check
/// that `open` and `zapOpen` did not contain.
contract AttackArrakisAndNativeValue is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("arrakis.keeper");
    address internal alice = makeAddr("arrakis.alice");
    address internal mallory = makeAddr("arrakis.mallory");
    address internal treasury = makeAddr("arrakis.treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;
    int24 internal constant DEV = DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS;
    uint32 internal constant WINDOW = 300;

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

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("arrakis", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

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
        _advance(WINDOW + 1);
    }

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

    /* ============================================================= THE DEPOSIT GATE */

    /// @notice ATTACK, DRIVEN: a deposit sandwiched by an ordinary address. Spot is walked above the
    ///         depositor's whole range, so the mint bills them for the range's WORST-CASE single-token
    ///         composition — the most that range can ever be asked to pay — and the price is then put
    ///         back. The depositor named `amount0Max` / `amount1Max`, which is a real bound, but a
    ///         frontend computes those FROM SPOT, so the manipulated number is inherited by the check that
    ///         was supposed to catch it. That is exactly the Arrakis shape.
    /// @dev The control vault has the TWAP bound at zero, which is what BOTH deposit paths looked like
    ///      before 2026-08-23. Both vaults are on the same pool, attacked in one sequence, and the
    ///      difference is measured in tokens.
    function test_BREAK_aWalkedSpotRepricesADepositAndTheGateRefusesIt() public {
        (MoleHook h, PoolKey memory k) = _world(1);
        MolePositions guarded =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        MolePositions control =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        guarded.whitelistPool(k);
        control.whitelistPool(k);
        _approve(alice, address(guarded));
        _approve(alice, address(control));
        _approve(mallory, address(swapRouter));

        // THE SANDWICH, front half. One unprivileged swap into the thin region above.
        _walkTo(k, 35_000);
        int24 spot;
        (, spot,,) = StateLibrary.getSlot0(manager, k.toId());
        int24 twap = h.consult(k.toId(), WINDOW);
        assertGt(int256(spot > twap ? spot - twap : twap - spot), int256(DEV), "premise: the walk was too small");

        // THE GUARDED VAULT REFUSES THE DEPOSIT. Nothing is pulled, so a refused deposit costs the user
        // gas and nothing else.
        (uint256 g0, uint256 g1) = _bal(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.SpotTooFarFromTwap.selector);
        guarded.open(k, -30_000, 30_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        (uint256 g0b, uint256 g1b) = _bal(alice);
        assertEq(g0, g0b, "a refused deposit still pulled currency0");
        assertEq(g1, g1b, "a refused deposit still pulled currency1");

        // THE CONTROL VAULT TAKES IT, at the manufactured price.
        (uint256 c0, uint256 c1) = _bal(alice);
        vm.prank(alice);
        uint256 id = control.open(k, -30_000, 30_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        (uint256 c0b, uint256 c1b) = _bal(alice);
        uint256 paid = (c0 - c0b) + (c1 - c1b);

        // THE SANDWICH, back half.
        _walkTo(k, 0);

        vm.prank(alice);
        control.withdrawAll(id);
        (uint256 c0c, uint256 c1c) = _bal(alice);
        uint256 returned = (c0c - c0b) + (c1c - c1b);

        console2.log("deposit paid at the walked spot :", paid);
        console2.log("value returned at the true price:", returned);
        console2.log("lost to the sandwich            :", paid - returned);
        assertLt(returned * 2, paid, "premise failed: the sandwich did not cost the depositor anything material");
    }

    /// @notice The zap is gated too, and it is the MORE exposed of the two deposit paths: it reads spot
    ///         twice — once in the swap it performs, once when ZapLogic derives liquidity from `getSlot0`.
    function test_holds_zapOpenIsGatedOnTheSameAnchor() public {
        (MoleHook h, PoolKey memory k) = _world(2);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        _approve(mallory, address(swapRouter));

        ZapLogic.ZapParams memory z = ZapLogic.ZapParams({
            key: k,
            tickLower: -600,
            tickUpper: 600,
            zeroForOne: true,
            amountIn: 1e18,
            swapAmount: 5e17,
            minLiquidity: 1,
            amountOutMin: 0
        });

        // Honest spot: the zap works, so the refusal below is the gate and not a broken call.
        vm.prank(alice);
        uint256 id = m.zapOpen(z, _clock + 1);
        assertGt(m.getPosition(id).liquidity, 0, "premise failed: the zap does not work at an honest spot");

        _walkTo(k, 35_000);
        vm.prank(alice);
        vm.expectRevert(MolePositions.SpotTooFarFromTwap.selector);
        m.zapOpen(z, _clock + 1);
    }

    /// @notice THE COLD START, stated as a test rather than as a footnote. `consult` fails closed, so a
    ///         pool younger than the window takes NO deposits at all. That is the price of the gate and it
    ///         is paid deliberately: a refused deposit strands nobody, and a deposit priced against an
    ///         oracle that cannot answer is a deposit priced against nothing.
    function test_holds_aPoolYoungerThanTheWindowRefusesDepositsAndThenAcceptsThem() public {
        address a = _hookAddr(3);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), uint24(3000), uint32(60), false, uint24(0), treasury, address(this)),
            a
        );
        PoolKey memory k = PoolKey({
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

        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, a, DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));

        vm.prank(alice);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        _advance(WINDOW + 1);
        vm.prank(alice);
        uint256 id = m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        assertGt(m.getPosition(id).liquidity, 0, "the deposit was still refused after the oracle warmed up");
    }

    /* =================================================================== THE EXIT */

    /// @notice THE EXIT IS NEVER GATED ON SPOT, and this is the test that would fail if somebody "fixed"
    ///         the asymmetry by making it symmetric. Spot is walked far outside the band — the exact state
    ///         that refuses both deposit paths — and every exit still works.
    ///
    ///         The reason is not laziness. A gate here is a censorship lever: whoever can move spot on a
    ///         thin pool could revert every withdrawal in the vault for as long as they cared to hold it,
    ///         trading a bounded loss the user chose for an unbounded one they did not.
    function test_holds_theExitIsUnconditionalWhileBothDepositPathsAreRefused() public {
        (MoleHook h, PoolKey memory k) = _world(4);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        _approve(mallory, address(swapRouter));

        vm.prank(alice);
        uint256 idFull = m.open(k, -6_000, 6_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);
        vm.prank(alice);
        uint256 idPart = m.open(k, -6_000, 6_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        _walkTo(k, 35_000);

        // Deposits are refused in this state...
        vm.prank(alice);
        vm.expectRevert(MolePositions.SpotTooFarFromTwap.selector);
        m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // ...and every shape of exit is not. NOTE the hoisted reads: `vm.prank` arms the NEXT call, and
        // an argument that is itself an external call would eat it.
        uint128 partLiq = m.getPosition(idPart).liquidity;
        uint128 fullLiq = m.getPosition(idFull).liquidity;
        (uint256 a0, uint256 a1) = _bal(alice);
        vm.prank(alice);
        m.withdraw(idPart, partLiq / 3);
        vm.prank(alice);
        m.withdrawAll(idPart);
        vm.prank(alice);
        m.withdrawWithMinimums(idFull, fullLiq, 0, 0);
        (uint256 b0, uint256 b1) = _bal(alice);

        assertEq(m.getPosition(idPart).liquidity, 0, "a walked spot blocked a partial-then-full exit");
        assertEq(m.getPosition(idFull).liquidity, 0, "a walked spot blocked a bounded exit");
        assertGt((b0 - a0) + (b1 - a1), 0, "the exits paid nothing");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(m)), 0, "the vault retained currency0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(m)), 0, "the vault retained currency1");
    }

    /// @notice The exit's slippage bound is CALLER-SUPPLIED, which is the whole difference between it and
    ///         a protocol gate: the only person who can make this revert is the person calling it, and the
    ///         unconditional exit is one call away at all times.
    function test_holds_theExitFloorIsTheCallersOwnAndNeverAnyoneElses() public {
        (MoleHook h, PoolKey memory k) = _world(5);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), DEV, WINDOW, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        _approve(mallory, address(swapRouter));

        vm.prank(alice);
        uint256 id = m.open(k, -6_000, 6_000, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        // Spot walked above the range: the position is now entirely currency1, so an exit expecting any
        // currency0 at all is one the owner would rather not make.
        _walkTo(k, 35_000);
        uint128 liq = m.getPosition(id).liquidity;

        vm.prank(alice);
        vm.expectRevert(MolePositions.WithdrawBelowMinimum.selector);
        m.withdrawWithMinimums(id, liq, 1, 0);

        assertEq(m.getPosition(id).liquidity, liq, "the refused exit still burned liquidity");

        // The unconditional exit is always available, in the same state, in the next call.
        (uint256 a0, uint256 a1) = _bal(alice);
        vm.prank(alice);
        m.withdrawAll(id);
        (uint256 b0, uint256 b1) = _bal(alice);
        assertEq(m.getPosition(id).liquidity, 0, "the unconditional exit was blocked");
        assertGt((b0 - a0) + (b1 - a1), 0, "the unconditional exit paid nothing");
    }

    /* ================================================================ F-10: NATIVE */

    function _hooklessWorld() internal returns (MolePositions m, PoolKey memory k) {
        // No hook and no TWAP bound: the native accounting under test has nothing to do with the oracle,
        // and mixing the two would make a failure ambiguous.
        m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        (k,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20e18, salt: 0}),
            ZERO_BYTES
        );
        m.whitelistPool(k);
    }

    /// @dev A native-currency0 pool, seeded. Native always sorts first, so it can only ever be currency0.
    function _nativeWorld() internal returns (MolePositions m, PoolKey memory k) {
        m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        k = PoolKey({
            currency0: CurrencyLibrary.ADDRESS_ZERO,
            currency1: currency0,
            fee: 3000,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        m.whitelistPool(k);

        MockERC20(Currency.unwrap(currency0)).mint(address(this), 1_000e18);
        MockERC20(Currency.unwrap(currency0)).approve(address(modifyLiquidityRouter), type(uint256).max);
        vm.deal(address(this), 100 ether);
        modifyLiquidityRouter.modifyLiquidity{value: 20 ether}(
            k, ModifyLiquidityParams({tickLower: -6_000, tickUpper: 6_000, liquidityDelta: 10e18, salt: 0}), ZERO_BYTES
        );
    }

    /// @notice ATTACK, DRIVEN: force ETH into the vault, then walk in and collect it by opening any
    ///         position at all. `_refundNative` used to send `address(this).balance` — the WHOLE balance,
    ///         not this caller's change — to `msg.sender`, resting on "this contract holds no ETH between
    ///         transactions by construction". That is true of voluntary sends and unenforceable against a
    ///         SELFDESTRUCT beneficiary or a block fee recipient, which is what `vm.deal` models here.
    function test_BREAK_forceFedEthIsNotSweptToTheNextDepositor() public {
        (MolePositions m, PoolKey memory k) = _hooklessWorld();
        _approve(mallory, address(m));

        vm.deal(address(m), 3 ether);
        uint256 malloryEthBefore = mallory.balance;

        vm.prank(mallory);
        m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        assertEq(mallory.balance, malloryEthBefore, "the depositor was paid ETH that was never theirs");
        assertEq(address(m).balance, 3 ether, "the stray ETH was swept out of the vault");
    }

    /// @notice Value attached to a pool with no native leg is a mistake, and it is refused rather than
    ///         silently absorbed. MoleRouter has always refused the same way; the vault did not.
    function test_holds_strayValueOnAnErc20PoolIsRefused() public {
        (MolePositions m, PoolKey memory k) = _hooklessWorld();
        _approve(alice, address(m));
        vm.deal(alice, 1 ether);

        vm.prank(alice);
        vm.expectRevert(MolePositions.UnexpectedNativeValue.selector);
        m.open{value: 1 wei}(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, _clock + 1);

        ZapLogic.ZapParams memory z = ZapLogic.ZapParams({
            key: k,
            tickLower: -600,
            tickUpper: 600,
            zeroForOne: true,
            amountIn: 1e18,
            swapAmount: 5e17,
            minLiquidity: 1,
            amountOutMin: 0
        });
        vm.prank(alice);
        vm.expectRevert(MolePositions.UnexpectedNativeValue.selector);
        m.zapOpen{value: 1 wei}(z, _clock + 1);
    }

    /// @notice ATTACK, DRIVEN, and the sharper half of F-10: on a native-currency0 pool, submit
    ///         `msg.value = 0` and let the deposit settle out of whatever stray ETH is lying in the vault.
    ///         `_settleFrom`'s native branch documented that `open`/`zapOpen` had "checked msg.value was
    ///         sufficient before the unlock". Neither contained a msg.value comparison of any kind, and
    ///         what stopped the over-settle was the accident of the balance usually being zero.
    function test_BREAK_aNativeDepositCannotBeFundedFromSomebodyElsesEth() public {
        (MolePositions m, PoolKey memory k) = _nativeWorld();
        MockERC20(Currency.unwrap(currency0)).mint(mallory, 1_000e18);
        _approve(mallory, address(m));

        vm.deal(address(m), 5 ether);
        assertEq(mallory.balance, 0, "premise failed: the attacker starts with no ETH of their own");

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NativeValueOverspent.selector);
        m.open(k, -600, 600, 1e16, type(uint256).max, type(uint256).max, _clock + 1);

        assertEq(address(m).balance, 5 ether, "the stray ETH was spent on somebody's position");
        assertEq(m.positionsOf(mallory).length, 0, "a position was funded from ETH the opener never sent");
    }

    /// @notice The honest native deposit still works, and it refunds THIS CALLER'S change rather than the
    ///         balance — proven by leaving stray ETH in the vault and watching it stay there.
    function test_holds_anHonestNativeDepositRefundsOnlyItsOwnChange() public {
        (MolePositions m, PoolKey memory k) = _nativeWorld();
        MockERC20(Currency.unwrap(currency0)).mint(alice, 1_000e18);
        _approve(alice, address(m));
        vm.deal(alice, 10 ether);
        vm.deal(address(m), 2 ether); // somebody else's, or nobody's

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        uint256 id = m.open{value: 5 ether}(
            k, -600, 600, 1e16, type(uint256).max, type(uint256).max, _clock + 1
        );
        uint256 spent = ethBefore - alice.balance;

        assertGt(m.getPosition(id).liquidity, 0, "no native position was created");
        assertGt(spent, 0, "the deposit cost nothing, so nothing was settled");
        assertLt(spent, 5 ether, "the overpayment was not refunded");
        assertEq(address(m).balance, 2 ether, "the caller's refund took the stray ETH with it");
    }

    /// @notice EVENT ORDERING, driven with a real reentrancy. `_refundNative` hands control to
    ///         `msg.sender` and used to do so BEFORE `PositionOpened` was emitted, so a contract depositor
    ///         could re-enter, withdraw the position it was still opening, and have PositionOpened emitted
    ///         afterwards describing liquidity that no longer existed. The indexer and the DefiLlama TVL
    ///         adapter read exactly these events.
    function test_holds_positionOpenedIsEmittedBeforeTheRefundHandsOverControl() public {
        (MolePositions m, PoolKey memory k) = _nativeWorld();
        ReentrantNativeDepositor dep = new ReentrantNativeDepositor(m);
        MockERC20(Currency.unwrap(currency0)).mint(address(dep), 1_000e18);
        vm.prank(address(dep));
        MockERC20(Currency.unwrap(currency0)).approve(address(m), type(uint256).max);
        vm.deal(address(dep), 5 ether);

        vm.recordLogs();
        dep.openAndReenter(k, -600, 600, 1e16, 2 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertTrue(dep.reentered(), "premise failed: the depositor never re-entered on its refund");

        uint256 openedAt = type(uint256).max;
        uint256 withdrawnAt = type(uint256).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(m)) continue;
            if (logs[i].topics[0] == MolePositions.PositionOpened.selector && openedAt == type(uint256).max) {
                openedAt = i;
            }
            if (logs[i].topics[0] == MolePositions.PositionWithdrawn.selector && withdrawnAt == type(uint256).max) {
                withdrawnAt = i;
            }
        }
        assertLt(openedAt, type(uint256).max, "PositionOpened was never emitted");
        assertLt(withdrawnAt, type(uint256).max, "the reentrant withdrawal emitted nothing");
        assertLt(openedAt, withdrawnAt, "PositionOpened was emitted AFTER the reentrant withdrawal");
    }
}
