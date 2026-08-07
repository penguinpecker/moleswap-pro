// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN, MoleDeployer} from "../helpers/ProxyDeploy.sol";

/// @notice VALUE-PATH ATTACKS on MoleHook: the afterSwapReturnDelta protocol fee, pool admission, and
///         what is left of the fee-manipulation surface now that the LP fee is an immutable constant.
///
/// Everything here is measured against real balances through the real PoolManager. No event is trusted.
///
/// SECTION E CHANGED SHAPE, AND WHY. It used to attack a volatility-scaled dynamic fee: build volatility,
/// then crush the accumulator with same-block dust before taking a toxic trade. That fee was REMOVED from
/// the source rather than repaired — the party that collects it is the party that can manufacture the
/// signal it is derived from, which no decay function fixes. So every one of those tests lost its subject.
/// None of them were faked green and none of the attack machinery was thrown away: the volatility burst,
/// the 300-swap same-block dust loop, the with/without-crush fill comparison and the idle/busy clocks are
/// all still fired at the shipped hook. What changed is the ASSERTION — each now proves the number they
/// were built to move is immovable, and each carries a non-vacuity anchor (a moved tick, an advanced ring
/// index, a fee level that demonstrably binds on fills) so "nothing moved" cannot be satisfied by a pool
/// where nothing happened.
contract AttackMoleHookValue is Test, Deployers {
    MoleDeployer internal _moleDeployer = new MoleDeployer();
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    address internal treasury = makeAddr("attack_treasury");
    address internal outsider = makeAddr("attack_outsider");
    address internal creator; // = address(this)

    /// @dev The pool fee the shipped hook is normally deployed with.
    uint24 internal constant LP_FEE = 3000;
    /// @dev A second, much larger legal fee (5%, under MAX_FEE_CEILING). Used to prove the fee level
    ///      genuinely binds on fills, so an "unchanged fee => unchanged fill" claim is falsifiable.
    uint24 internal constant ALT_LP_FEE = 50_000;
    uint24 internal constant HOOK_FEE = 10_000; // 1% == MAX_HOOK_FEE

    /// @dev explicit accumulating clock; block.timestamp is cached inside a call frame.
    uint256 internal _clock;
    /// @dev explicit accumulating HEIGHT, for the same reason and it is not optional. `block.number` is
    ///      also cached inside a call frame: with two `_advance` calls in one test frame the compiler
    ///      reuses the first read, so `vm.roll(block.number + 1)` on the second call rolls from a stale
    ///      height. Measured: after advancing to block 337 the next `_advance(1)` rolled the chain
    ///      BACKWARDS to 32. The block-lagged fee quote that used to make this load-bearing is gone, but
    ///      the L1 dwell stamp in `beforeAddLiquidity` still reads block.number, so the trap is live.
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        // Time passing implies blocks passing. Foundry's vm.warp does NOT advance block.number, so a
        // harness that only warps models a chain where the clock moves but no block is ever produced —
        // which silently freezes anything keyed on block.number. On Robinhood Chain block.number is the
        // ETHEREUM L1 height (~12s per tick), so one tick per advance is the conservative mapping.
        _height += 1 + secs / 12;
        vm.warp(_clock);
        vm.roll(_height);
    }

    function setUp() public {
        _clock = block.timestamp;
        _height = block.number;
        creator = address(this);
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
    }

    /* ------------------------------------------------------------------ helpers */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("attack_value", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    struct Cfg {
        uint256 seed;
        address poolCreator;
        uint24 lpFee;
        uint32 obsInterval;
        bool restricted;
        uint24 hookFee;
        address recipient;
    }

    function _deploy(Cfg memory c) internal returns (MoleHook h) {
        address a = _hookAddr(c.seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, c.poolCreator, c.lpFee, c.obsInterval, c.restricted, c.hookFee, c.recipient, address(this)),
            a
        );
        h = MoleHook(a);
    }

    /// @dev The ordinary hook: open liquidity, 60s observation interval, `lpFee` fixed forever.
    function _hook(uint256 seed, uint24 lpFee, uint24 hookFee) internal returns (MoleHook) {
        return _deploy(
            Cfg({
                seed: seed,
                poolCreator: creator,
                lpFee: lpFee,
                obsInterval: 60,
                restricted: false,
                hookFee: hookFee,
                recipient: treasury
            })
        );
    }

    function _openPool(MoleHook h, int24 spacing, int256 liq) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: liq, salt: 0}),
            ZERO_BYTES
        );
    }

    function _bal(Currency c, address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(c)).balanceOf(who);
    }

    function _tick(PoolKey memory k) internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    /// @dev The price anchor for "the attack machinery really ran". Deliberately NOT the tick: dust swaps
    ///      and symmetric round trips move the price without ever crossing a tick boundary, so a tick
    ///      comparison reports "nothing happened" for a loop that spent real tokens and would have
    ///      collapsed the deleted volatility accumulator. sqrtPriceX96 is the sensitive one.
    function _sqrt(PoolKey memory k) internal view returns (uint160 p) {
        (p,,,) = StateLibrary.getSlot0(manager, k.toId());
    }

    struct Flow {
        int256 me0;
        int256 me1;
        int256 tre0;
        int256 tre1;
        int256 pm0;
        int256 pm1;
        int256 hook0;
        int256 hook1;
    }

    function _snap(address hookAddr) internal view returns (Flow memory s) {
        s.me0 = int256(_bal(currency0, address(this)));
        s.me1 = int256(_bal(currency1, address(this)));
        s.tre0 = int256(_bal(currency0, treasury));
        s.tre1 = int256(_bal(currency1, treasury));
        s.pm0 = int256(_bal(currency0, address(manager)));
        s.pm1 = int256(_bal(currency1, address(manager)));
        s.hook0 = int256(_bal(currency0, hookAddr));
        s.hook1 = int256(_bal(currency1, hookAddr));
    }

    /// @dev Runs one swap and returns every balance movement that matters, signed.
    function _swapMeasured(PoolKey memory k, bool zeroForOne, int256 amountSpecified)
        internal
        returns (Flow memory f)
    {
        f = _snap(address(k.hooks));
        _rawSwap(k, zeroForOne, amountSpecified);
        Flow memory a = _snap(address(k.hooks));
        f.me0 = a.me0 - f.me0;
        f.me1 = a.me1 - f.me1;
        f.tre0 = a.tre0 - f.tre0;
        f.tre1 = a.tre1 - f.tre1;
        f.pm0 = a.pm0 - f.pm0;
        f.pm1 = a.pm1 - f.pm1;
        f.hook0 = a.hook0 - f.hook0;
        f.hook1 = a.hook1 - f.hook1;
    }

    /* =====================================================================================
                                   A.  ADMISSION
       ===================================================================================== */

    /// @notice Can anyone bind a pool to this hook without being poolCreator? Try every shape.
    function test_admission_outsiderCannotCreateAnyPool() public {
        MoleHook h = _hook(101, LP_FEE, 0);

        // plain dynamic-fee pool from an outsider
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(h))
        });
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(h),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(MoleHook.NotPoolCreator.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);

        // every other tickSpacing an outsider might try
        int24[5] memory spacings = [int24(1), int24(10), int24(200), int24(1000), int24(32767)];
        for (uint256 i = 0; i < spacings.length; i++) {
            k.tickSpacing = spacings[i];
            vm.prank(outsider);
            vm.expectRevert(
                abi.encodeWithSelector(
                    CustomRevert.WrappedError.selector,
                    address(h),
                    IHooks.beforeInitialize.selector,
                    abi.encodeWithSelector(MoleHook.NotPoolCreator.selector),
                    abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                )
            );
            manager.initialize(k, SQRT_PRICE_1_1);
        }

        // ...and the creator can, so the refusals above are about WHO called, not about the key.
        manager.initialize(
            PoolKey({
                currency0: currency0,
                currency1: currency1,
                fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
                tickSpacing: 60,
                hooks: IHooks(address(h))
            }),
            SQRT_PRICE_1_1
        );
    }

    /// @notice Static-fee bypass: DYNAMIC_FEE_FLAG is an exact equality, so no bit-fiddling gets through.
    function test_admission_staticAndMaskedFeesAreRejected() public {
        MoleHook h = _hook(102, LP_FEE, 0);
        // Two DIFFERENT layers refuse these, and conflating them would leave our own guard untested.
        // v4 itself rejects any fee whose low bits exceed MAX_LP_FEE once a flag is masked in, so those
        // never reach beforeInitialize; the plain static fees do reach it and are refused by us.
        uint24[2] memory rejectedByV4 = [
            LPFeeLibrary.DYNAMIC_FEE_FLAG | uint24(3000),
            LPFeeLibrary.DYNAMIC_FEE_FLAG | LPFeeLibrary.OVERRIDE_FEE_FLAG
        ];
        for (uint256 i = 0; i < rejectedByV4.length; i++) {
            PoolKey memory kv = PoolKey({
                currency0: currency0,
                currency1: currency1,
                fee: rejectedByV4[i],
                tickSpacing: int24(int256(60 + i)),
                hooks: IHooks(address(h))
            });
            vm.expectRevert(abi.encodeWithSelector(LPFeeLibrary.LPFeeTooLarge.selector, rejectedByV4[i]));
            manager.initialize(kv, SQRT_PRICE_1_1);
        }

        uint24[2] memory rejectedByUs = [uint24(3000), uint24(0)];
        for (uint256 i = 0; i < rejectedByUs.length; i++) {
            PoolKey memory k = PoolKey({
                currency0: currency0,
                currency1: currency1,
                fee: rejectedByUs[i],
                tickSpacing: int24(int256(70 + i)),
                hooks: IHooks(address(h))
            });
            // The creator himself cannot get a static-fee pool through, and it must be OUR guard that
            // refuses it. This check survived the dynamic fee it was written for: `beforeSwap` still
            // returns its fee with OVERRIDE_FEE_FLAG, and that override is SILENTLY IGNORED on a pool
            // whose key fee is static — so a static-fee pool would charge whatever v4 stored, not the
            // number this hook was constructed with, with no revert anywhere.
            vm.expectRevert(
                abi.encodeWithSelector(
                    CustomRevert.WrappedError.selector,
                    address(h),
                    IHooks.beforeInitialize.selector,
                    abi.encodeWithSelector(MoleHook.FeeMustBeDynamic.selector),
                    abi.encodeWithSelector(Hooks.HookCallFailed.selector)
                )
            );
            manager.initialize(k, SQRT_PRICE_1_1);
        }
    }

    /// @notice The constructor's bounds, and the ORDER they are checked in. Every one of these deploys at
    ///         an ordinary CREATE address, i.e. an address that is NOT mined to 0x38C4 — so a
    ///         `BadFeeBounds` here is proof the fee checks run BEFORE the address check. If that order
    ///         were reversed, every misconfiguration on this list would report as `BadHookAddress` and a
    ///         deployer debugging a mis-mined salt would never learn their fee was illegal.
    function test_admission_constructorBoundsAreCheckedBeforeTheAddress() public {
        MoleHook ref = _hook(104, LP_FEE, HOOK_FEE);
        uint24 ceiling = ref.MAX_FEE_CEILING();
        uint24 hookCeiling = ref.MAX_HOOK_FEE();
        assertEq(ceiling, 100_000, "MAX_FEE_CEILING moved; the bounds below are stated against 10%");
        assertEq(hookCeiling, 10_000, "MAX_HOOK_FEE moved; the bounds below are stated against 1%");

        // A zero LP fee lets arbitrage reprice the pool for free.
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, creator, 0, 60, false, 0, treasury);

        // One pip over the ceiling.
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, creator, ceiling + 1, 60, false, 0, treasury);

        // Hook fee over its own, much lower cap.
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, creator, LP_FEE, 60, false, hookCeiling + 1, treasury);

        // A live hook fee with nowhere to send it.
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, creator, LP_FEE, 60, false, HOOK_FEE, address(0));

        // A zero observation interval writes a ring entry per swap and collapses the readable window.
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, creator, LP_FEE, 0, false, 0, treasury);

        // The control: identical, legal configuration at the same kind of unmined address now reports the
        // ADDRESS failure. Without this the five reverts above could be the address check firing early.
        vm.expectRevert(MoleHook.BadHookAddress.selector);
        _moleDeployer.hookAnywhere(manager, creator, LP_FEE, 60, false, HOOK_FEE, treasury);

        // The legal edges are legal: exactly at both ceilings, and a zero hook fee with no recipient.
        assertEq(_hook(105, ceiling, hookCeiling).lpFeePips(), ceiling, "the ceiling itself was rejected");
        MoleHook noFee = _deploy(
            Cfg({
                seed: 106,
                poolCreator: creator,
                lpFee: 1,
                obsInterval: 1,
                restricted: false,
                hookFee: 0,
                recipient: address(0)
            })
        );
        assertEq(noFee.lpFeePips(), 1, "a 1-pip fee with no hook fee and no recipient was rejected");
    }

    /// @notice setLiquidityAllowed: only creator, and it can never reach funds/exits.
    function test_admission_setLiquidityAllowedIsInert() public {
        MoleHook h = _deploy(
            Cfg({
                seed: 103,
                poolCreator: creator,
                lpFee: LP_FEE,
                obsInterval: 60,
                restricted: true,
                hookFee: 0,
                recipient: treasury
            })
        );
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);

        vm.prank(outsider);
        vm.expectRevert(MoleHook.NotPoolCreator.selector);
        h.setLiquidityAllowed(outsider, true);

        h.setLiquidityAllowed(address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );

        // revoke: adds die, exits still work (no remove bit).
        h.setLiquidityAllowed(address(modifyLiquidityRouter), false);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(h),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1e18, salt: 0}),
            ZERO_BYTES
        );
        uint256 before = _bal(currency0, address(this));
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -5_000e18, salt: 0}),
            ZERO_BYTES
        );
        assertGt(_bal(currency0, address(this)), before, "revocation trapped an exit");

        // The one privileged function on this contract cannot touch the fee either — see section E.
        assertEq(h.currentFee(k.toId()), LP_FEE, "the allowlist admin moved the fee");
    }

    /* =====================================================================================
                            B.  HOOK FEE — EXACT INPUT, BOTH DIRECTIONS
       ===================================================================================== */

    /// @notice Baseline: on exact-INPUT the fee is taken from the output currency, at exactly hookFeePips,
    ///         paid by the swapper (not the LPs), and the hook holds nothing.
    function test_hookFee_exactInput_bothDirections_isHonest() public {
        MoleHook h = _hook(201, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 5_000e18);

        // zeroForOne = true  -> output is currency1
        Flow memory f = _swapMeasured(k, true, -10e18);
        uint256 gross1 = uint256(f.me1 + f.tre1);
        uint256 expect1 = gross1 * HOOK_FEE / 1e6;
        assertEq(uint256(f.tre1), expect1, "z4o=true: take != hookFeePips of gross output");
        assertEq(f.tre0, 0, "z4o=true: fee taken in the INPUT currency");
        assertEq(f.hook0, 0, "hook holds currency0");
        assertEq(f.hook1, 0, "hook holds currency1");
        // conservation: everything the manager lost, someone got
        assertEq(f.pm0 + f.me0 + f.tre0, 0, "currency0 not conserved");
        assertEq(f.pm1 + f.me1 + f.tre1, 0, "currency1 not conserved");

        // zeroForOne = false -> output is currency0
        Flow memory g = _swapMeasured(k, false, -10e18);
        uint256 gross0 = uint256(g.me0 + g.tre0);
        uint256 expect0 = gross0 * HOOK_FEE / 1e6;
        assertEq(uint256(g.tre0), expect0, "z4o=false: take != hookFeePips of gross output");
        assertEq(g.tre1, 0, "z4o=false: fee taken in the INPUT currency");
        assertEq(g.pm0 + g.me0 + g.tre0, 0, "currency0 not conserved");
        assertEq(g.pm1 + g.me1 + g.tre1, 0, "currency1 not conserved");
    }

    /* =====================================================================================
             C.  HOOK FEE — EXACT OUTPUT:  THE 100% BYPASS IS CLOSED (REGRESSION)
       ===================================================================================== */

    /// @notice REGRESSION (was test_ATTACK_exactOutputPaysZeroHookFee). The attack, unchanged: quote the
    ///         identical trade as exact-OUTPUT so the unspecified leg is the INPUT (a debit) rather than a
    ///         credit. The hook used to charge only a positive unspecified delta, so this route paid zero.
    ///         It now charges the MAGNITUDE of that leg, so the evasion route pays the same fee — measured
    ///         in treasury tokens, on the input currency, at exactly hookFeePips of the gross input.
    function test_regression_exactOutputPaysTheHookFee() public {
        MoleHook h = _hook(202, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 5_000e18);

        // 1) Honest swapper: exact input of 10e18 currency0. Fee lands on the output leg (currency1).
        Flow memory honest = _swapMeasured(k, true, -10e18);
        uint256 paidByHonest = uint256(honest.tre1);
        assertGt(paidByHonest, 0, "sanity: exact-input path must pay a hook fee");

        // 2) Evader: same direction, expressed as exact OUTPUT of the very amount the honest swapper
        //    actually received. Economically the identical trade — and now priced the same.
        uint256 wanted = uint256(honest.me1);
        Flow memory evader = _swapMeasured(k, true, int256(wanted));
        assertEq(uint256(evader.me1), wanted, "evader did not receive the requested output");
        assertEq(evader.tre1, 0, "exact-output fee landed on the specified (output) leg");
        uint256 grossIn = uint256(-evader.me0 - evader.tre0);
        assertGt(grossIn, 0, "evader paid no input at all");
        assertEq(uint256(evader.tre0), grossIn * HOOK_FEE / 1e6, "exact-output fee != hookFeePips of gross input");
        assertGt(uint256(evader.tre0), 0, "EXACT-OUTPUT BYPASS ALIVE: evader paid nothing");
        // Same realised trade, so the two routes must cost within a hair of each other. If exact-output
        // were still materially cheaper the bypass would merely have shrunk, not closed.
        assertApproxEqRel(uint256(evader.tre0), paidByHonest, 0.02e18, "exact-output is still materially cheaper");
        assertEq(evader.pm0 + evader.me0 + evader.tre0, 0, "currency0 not conserved on the charged exact-output");
        assertEq(evader.pm1 + evader.me1 + evader.tre1, 0, "currency1 not conserved on the charged exact-output");
        assertEq(evader.hook0, 0, "hook retained currency0");
        assertEq(evader.hook1, 0, "hook retained currency1");

        // 3) And in the other direction too: fee rides on currency1, the input leg of a !zeroForOne swap.
        Flow memory honest2 = _swapMeasured(k, false, -10e18);
        assertGt(uint256(honest2.tre0), 0, "sanity: reverse exact-input must pay a hook fee");
        Flow memory evader2 = _swapMeasured(k, false, int256(uint256(honest2.me0)));
        assertEq(evader2.tre0, 0, "reverse exact-output fee landed on the specified leg");
        uint256 grossIn2 = uint256(-evader2.me1 - evader2.tre1);
        assertEq(uint256(evader2.tre1), grossIn2 * HOOK_FEE / 1e6, "reverse exact-output fee mis-sized");
        assertGt(uint256(evader2.tre1), 0, "REVERSE EXACT-OUTPUT BYPASS ALIVE: evader paid nothing");

        console2.log("hook fee paid, exact-input :", paidByHonest);
        console2.log("hook fee paid, exact-output:", uint256(evader.tre0));
    }

    /// @notice REGRESSION (was test_ATTACK_exactOutputBypassAtEverySize). The evasion route is charged at
    ///         EVERY size and in both directions, at exactly hookFeePips of the gross input — no size band
    ///         is left free.
    function test_regression_exactOutputChargedAtEverySize() public {
        MoleHook h = _hook(203, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 200_000e18);

        uint256[5] memory sizes = [uint256(1e12), 1e15, 1e18, 50e18, 500e18];
        uint256 totalCollected;
        for (uint256 i = 0; i < sizes.length; i++) {
            Flow memory ex = _swapMeasured(k, true, int256(sizes[i]));
            assertEq(ex.tre1, 0, "fee taken on the specified (output) leg");
            uint256 grossIn = uint256(-ex.me0 - ex.tre0);
            assertEq(uint256(ex.tre0), grossIn * HOOK_FEE / 1e6, "exact-output fee != hookFeePips of gross input");
            assertGt(uint256(ex.tre0), 0, "exact-output at this size still pays nothing");
            assertEq(uint256(ex.me1), sizes[i], "swapper did not receive the exact output requested");
            assertEq(ex.pm0 + ex.me0 + ex.tre0, 0, "currency0 not conserved");
            assertEq(ex.pm1 + ex.me1 + ex.tre1, 0, "currency1 not conserved");
            totalCollected += uint256(ex.tre0);
        }
        console2.log("total hook fee COLLECTED across 5 exact-output swaps:", totalCollected);
        assertGt(totalCollected, 0, "the exact-output route paid the protocol nothing overall");
    }

    /// @notice REGRESSION (was test_ATTACK_exactOutputBotPaysNothingOverManySwaps). A bot that only ever
    ///         quotes exact-output now pays on every single swap, in both directions, and the treasury
    ///         grows in both currencies.
    function test_regression_exactOutputBotPaysOnEverySwap() public {
        MoleHook h = _hook(204, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 200_000e18);

        uint256 t0 = _bal(currency0, treasury);
        uint256 t1 = _bal(currency1, treasury);
        for (uint256 i = 0; i < 20; i++) {
            _advance(61);
            bool z = i % 2 == 0;
            Flow memory f = _swapMeasured(k, z, int256(uint256(1e18)));
            // On an exact-output swap the unspecified leg is the INPUT: currency0 when zeroForOne.
            int256 feeLeg = z ? f.tre0 : f.tre1;
            int256 otherLeg = z ? f.tre1 : f.tre0;
            int256 payLeg = z ? f.me0 : f.me1;
            assertEq(otherLeg, 0, "fee landed on the specified leg");
            uint256 grossIn = uint256(-payLeg - feeLeg);
            assertEq(uint256(feeLeg), grossIn * HOOK_FEE / 1e6, "per-swap exact-output fee mis-sized");
            assertGt(feeLeg, 0, "a swap in the bot's loop escaped the fee");
        }
        assertGt(_bal(currency0, treasury), t0, "bot paid no currency0 fee across 10 exact-output swaps");
        assertGt(_bal(currency1, treasury), t1, "bot paid no currency1 fee across 10 exact-output swaps");
    }

    /* =====================================================================================
                       D.  CAN THE HOOK EVER OVER-TAKE / WRONG-CURRENCY / STRAND?
       ===================================================================================== */

    /// @notice Fuzz the whole value surface: direction x exact-in/out x size. Invariants:
    ///         - the fee only ever rides the UNSPECIFIED leg, never the leg the swapper specified
    ///         - it is exactly hookFeePips of that leg's magnitude, in both signs (so exact-output pays)
    ///         - the hook contract never retains a balance
    ///         - tokens are conserved (no stranded delta, no silent mint)
    function testFuzz_hookFeeInvariants(bool zeroForOne, bool exactIn, uint96 raw) public {
        MoleHook h = _hook(205, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 500_000e18);

        uint256 amt = uint256(raw) % 1_000e18;
        vm.assume(amt > 1000);
        int256 spec = exactIn ? -int256(amt) : int256(amt);

        Flow memory f = _swapMeasured(k, zeroForOne, spec);

        assertEq(f.hook0, 0, "hook retained currency0");
        assertEq(f.hook1, 0, "hook retained currency1");
        assertEq(f.pm0 + f.me0 + f.tre0, 0, "currency0 not conserved");
        assertEq(f.pm1 + f.me1 + f.tre1, 0, "currency1 not conserved");

        if (exactIn) {
            // Exact-input: the unspecified leg is the swapper's CREDIT, so the fee is skimmed off the
            // OUTPUT and may never touch the currency they are paying. Stated as an exact equality, the
            // mirror of the exact-output branch below.
            //
            // The previous form of this branch was an upper bound sitting behind `if (f.treN > 0)`, which
            // a hook that charged NOTHING on exact input satisfied vacuously — the guard skipped both
            // arms and the fuzzer reported green. Under-charging is a real failure mode here (it is the
            // exact shape of the exact-output bypass this file exists to pin), so the amount is now
            // pinned to the formula and required to be non-zero.
            int256 feeLeg = zeroForOne ? f.tre1 : f.tre0;
            int256 otherLeg = zeroForOne ? f.tre0 : f.tre1;
            int256 payLeg = zeroForOne ? f.me0 : f.me1;
            int256 recvLeg = zeroForOne ? f.me1 : f.me0;
            assertEq(otherLeg, 0, "exact-input fee taken on the specified leg the swapper was PAYING");
            assertEq(uint256(-payLeg), amt, "exact-input swapper did not pay the amount specified");
            assertGt(recvLeg, 0, "exact-input swapper received nothing");
            uint256 grossOut = uint256(recvLeg + feeLeg);
            assertEq(uint256(feeLeg), grossOut * HOOK_FEE / 1e6, "exact-input fee != hookFeePips of gross output");
            assertGt(feeLeg, 0, "exact-input swap escaped the hook fee entirely");
        } else {
            // The closed bypass, stated as a fuzz invariant: EVERY exact-output swap, at any size, in
            // either direction, is charged exactly hookFeePips of the gross input it consumed — and the
            // specified (output) leg is never touched, so the swapper still gets the amount they asked for.
            int256 feeLeg = zeroForOne ? f.tre0 : f.tre1;
            int256 otherLeg = zeroForOne ? f.tre1 : f.tre0;
            int256 payLeg = zeroForOne ? f.me0 : f.me1;
            int256 recvLeg = zeroForOne ? f.me1 : f.me0;
            assertEq(otherLeg, 0, "exact-output fee taken on the specified leg");
            assertEq(uint256(recvLeg), amt, "exact-output swapper did not receive the amount specified");
            assertGe(feeLeg, 0, "exact-output fee is negative");
            uint256 grossIn = uint256(-payLeg - feeLeg);
            assertEq(uint256(feeLeg), grossIn * HOOK_FEE / 1e6, "exact-output fee != hookFeePips of gross input");
        }

        // Whatever the swap did, the LP fee it was quoted is the constructed constant.
        assertEq(h.currentFee(k.toId()), LP_FEE, "a swap moved the immutable LP fee");
    }

    /// @notice Dust: below 1/hookFeePips of output the fee floors to zero. Free swaps, but only at sizes
    ///         where gas dwarfs the fee — recorded, not claimed as an exploit.
    function test_dustSwapsPayNoHookFee() public {
        MoleHook h = _hook(206, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 500_000e18);
        Flow memory f = _swapMeasured(k, true, -int256(uint256(60)));
        assertEq(f.tre1, 0, "dust unexpectedly paid");
        console2.log("dust swap output:", uint256(f.me1));
    }

    /// @notice Huge swap: no overflow in the pips math, no stranded delta.
    function test_hugeSwapDoesNotOverflowOrStrand() public {
        MoleHook h = _hook(207, LP_FEE, HOOK_FEE);
        PoolKey memory k = _openPool(h, 60, 500_000e18);
        Flow memory f = _swapMeasured(k, true, -100_000e18);
        assertGt(uint256(f.tre1), 0, "huge swap paid nothing");
        assertEq(f.pm1 + f.me1 + f.tre1, 0, "currency1 not conserved on a huge swap");
    }

    /// @notice Who actually funds the hook fee — the swapper or the LPs? A/B the identical swap through
    ///         two identical pools that differ only in hookFeePips. If the pool pays out the same gross
    ///         in both, the swapper is footing it (correct). If the pool pays out more, LPs are.
    function test_hookFeeIsFundedByTheSwapperNotTheLPs() public {
        PoolKey memory free = _openPool(_hook(208, LP_FEE, 0), 60, 500_000e18);
        PoolKey memory taxed = _openPool(_hook(209, LP_FEE, HOOK_FEE), 60, 500_000e18);

        Flow memory a = _swapMeasured(free, true, -10e18);
        Flow memory b = _swapMeasured(taxed, true, -10e18);

        // The pool paid out the same gross in both cases...
        assertEq(-a.pm1, -b.pm1, "the pool's payout changed - LPs are funding the hook fee");
        // ...so the entire hook fee came out of the swapper's receipt.
        assertEq(a.me1 - b.me1, b.tre1, "swapper's shortfall != treasury's gain");
        assertEq(a.me0, b.me0, "input leg differed");
    }

    /// @notice Full lifecycle solvency: many swaps with the hook fee on, then every LP exits. If the
    ///         afterSwapReturnDelta take ever stranded or double-counted anything, the PoolManager would
    ///         end up holding either a shortfall (insolvent) or a surplus (someone's money is trapped).
    function test_lifecycleLeavesThePoolManagerFlat() public {
        MoleHook h = _hook(210, LP_FEE, HOOK_FEE);

        // BASELINE BEFORE THE POOL EXISTS. Taking it after `_openPool` made the bound meaningless: the
        // deposit itself is ~9.5e22 per currency, so `assertLe(residual, pm0Start + 10)` was satisfied by
        // twenty-two orders of magnitude and would have passed even if the hook stranded EVERY LP token.
        // Measured against the empty manager, the bound is what it claims to be.
        uint256 pm0Start = _bal(currency0, address(manager));
        uint256 pm1Start = _bal(currency1, address(manager));

        PoolKey memory k = _openPool(h, 60, 100_000e18);
        uint256 pm0Deposited = _bal(currency0, address(manager)) - pm0Start;
        uint256 pm1Deposited = _bal(currency1, address(manager)) - pm1Start;
        assertGt(pm0Deposited, 0, "sanity: no currency0 was ever deposited, so there is nothing to strand");
        assertGt(pm1Deposited, 0, "sanity: no currency1 was ever deposited, so there is nothing to strand");

        for (uint256 i = 0; i < 10; i++) {
            _advance(61);
            bool z = i % 2 == 0;
            if (i % 3 == 0) {
                _swapMeasured(k, z, int256(uint256(3e18))); // exact output
            } else {
                _swapMeasured(k, z, -int256(uint256(3e18))); // exact input
            }
        }

        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -100_000e18, salt: 0}),
            ZERO_BYTES
        );

        // Whatever was in the manager before this pool existed is all that is left: no shortfall, no
        // trapped surplus attributable to the hook fee. `pm*Start` is the pre-pool balance, so the slack
        // here is ten WEI against a six-figure-token deposit — a single stranded token fails this.
        uint256 residual0 = _bal(currency0, address(manager)) - pm0Start;
        uint256 residual1 = _bal(currency1, address(manager)) - pm1Start;
        console2.log("residual left in the manager, currency0/currency1:", residual0, residual1);
        console2.log("deposited at open, currency0/currency1:", pm0Deposited, pm1Deposited);
        assertLe(residual0, 10, "currency0 stranded in the manager");
        assertLe(residual1, 10, "currency1 stranded in the manager");
        assertEq(_bal(currency0, address(h)), 0, "hook holds currency0 at end of life");
        assertEq(_bal(currency1, address(h)), 0, "hook holds currency1 at end of life");

        // ...and the lifecycle was not a no-op: the hook fee really was taken on this pool, in both
        // currencies, so "the manager is flat" is a statement about a path that actually moved money.
        assertGt(_bal(currency0, treasury), 0, "no currency0 hook fee was ever collected");
        assertGt(_bal(currency1, treasury), 0, "no currency1 hook fee was ever collected");
    }

    /* =====================================================================================
       E.  THE LP FEE HAS NO MANIPULATION SURFACE LEFT (WAS: THE DYNAMIC-FEE DUST CRUSH)

           These four tests used to attack a volatility-scaled fee. That fee is gone from the source —
           removed, not repaired, because whoever collects it can manufacture the signal it reads. The
           attacks are kept and still fired; what they now prove is that there is nothing on the other
           end of them. Every one carries an anchor showing the attack machinery really ran, so a green
           result cannot come from a pool where nothing happened.
       ===================================================================================== */

    /// @dev How many dust swaps the attack gets to fire inside one block. The original exploit collapsed a
    ///      50,000-pip surcharge to base in 102, so 300 is comfortably more rope than it ever needed.
    uint256 internal constant DUST_SWAPS = 300;

    /// @notice The shape of the fix, stated directly: the quoted fee is a function of NOTHING. Not of the
    ///         pool, not of its state, not of time, not of who is asking. It is the constructor argument
    ///         and there is no setter for it anywhere on the contract — which is precisely why the
    ///         wash-trade-then-collect attack that killed the dynamic fee has no target: an attacker who
    ///         can move every input the hook can see still moves no fee.
    function test_feeIsAFunctionOfNoState() public {
        MoleHook h = _hook(300, LP_FEE, 0);

        // Before ANY pool exists — the quote does not even require an initialised pool, because it
        // reads no per-pool state at all.
        assertEq(h.currentFee(PoolId.wrap(bytes32(0))), LP_FEE, "the zero pool id quoted something else");
        assertEq(
            h.currentFee(PoolId.wrap(keccak256("a pool that was never initialised"))),
            LP_FEE,
            "an unknown pool id quoted something else"
        );
        assertEq(h.lpFeePips(), LP_FEE, "lpFeePips is not the constructed value");

        PoolKey memory k = _openPool(h, 60, 5_000e18);
        PoolId id = k.toId();
        assertEq(h.currentFee(id), LP_FEE, "a live pool quotes something other than lpFeePips");

        // A second deployment with a different legal fee quotes ITS number for the SAME pool id, so the
        // constant is per-deployment rather than a global that would be equal by construction.
        MoleHook h2 = _hook(307, ALT_LP_FEE, 0);
        assertEq(h2.currentFee(id), ALT_LP_FEE, "two hooks with different fees quoted the same number");

        // No caller has a lever. The fee-quoting entrypoint is unreachable except from the PoolManager...
        vm.prank(outsider);
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        h.beforeSwap(
            outsider, k, SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}), ""
        );
        // ...and the sole privileged function on the contract touches an allowlist and nothing else.
        h.setLiquidityAllowed(outsider, true);
        assertTrue(h.liquidityAllowed(outsider), "sanity: the only admin call did nothing at all");
        assertEq(h.currentFee(id), LP_FEE, "the pool creator moved the fee through the allowlist setter");

        // And a swapper who moves the price hard in a single call still gets quoted the same number.
        int24 before = _tick(k);
        _rawSwap(k, true, -2_000e18);
        assertTrue(_tick(k) != before, "sanity: the 2,000e18 swap moved no price");
        assertEq(h.currentFee(id), LP_FEE, "a large swap repriced the fee");
    }

    /// @notice REGRESSION (was test_ATTACK_volEwmaCanBeCrushedInOneBlock). CHANGED SHAPE: the fee this
    ///         attacked no longer exists, so instead of proving the crush is defended it proves the crush
    ///         has no target. The machinery is untouched and still armed — build real volatility with real
    ///         swaps across real time, then fire 300 dust swaps inside a single block, exactly as the
    ///         original exploit ran them. Both halves of what the dynamic fee needed are checked: the fee
    ///         does not move DURING the block (the crush), and it does not move after an hour of quiet
    ///         either (the idle-quote defect, where an unswapped pool used to quote its last surcharge
    ///         forever). Three anchors keep "nothing moved" from being a statement about nothing: the
    ///         burst must move the TICK, the dust loop must move sqrtPriceX96 and must spend exactly the
    ///         tokens it was told to, and the ring index must advance.
    function test_regression_dustCrushHasNoTargetLeft() public {
        MoleHook h = _hook(301, LP_FEE, 0);
        PoolKey memory k = _openPool(h, 60, 5_000e18);
        PoolId id = k.toId();
        assertEq(h.currentFee(id), LP_FEE, "the pool did not open at lpFeePips");

        // Build up real volatility with real swaps across real time.
        int24 tickAtOpen = _tick(k);
        for (uint256 i = 0; i < 5; i++) {
            _advance(61);
            _swapMeasured(k, i % 2 == 0, -400e18);
            assertEq(h.currentFee(id), LP_FEE, "a swap in the volatility burst moved the fee");
        }
        int24 tickAfterBurst = _tick(k);
        assertTrue(tickAfterBurst != tickAtOpen, "sanity: five 400e18 swaps moved no price, so nothing was built");
        (uint16 idxAfterBurst,,,,,) = h.poolStates(id);
        assertGt(uint256(idxAfterBurst), 0, "sanity: the burst wrote no observation, so the oracle path never ran");
        uint24 loud = h.currentFee(id);
        assertEq(loud, LP_FEE, "MANUFACTURE SURFACE BACK: a volatility burst raised the quoted fee");

        // No time advance at all: dust swaps inside the same block, exactly as the exploit ran them.
        uint160 sqrtBeforeDust = _sqrt(k);
        uint256 spentBeforeDust = _bal(currency0, address(this));
        uint256 gasStart = gasleft();
        for (uint256 i = 0; i < DUST_SWAPS; i++) {
            _rawSwap(k, true, -int256(uint256(1000)));
        }
        console2.log("gas burned by the whole dust loop:", gasStart - gasleft());
        uint24 afterDust = h.currentFee(id);
        console2.log("fee after volatility burst :", loud);
        console2.log("dust swaps fired           :", DUST_SWAPS);
        console2.log("fee after the dust loop    :", afterDust);
        assertEq(afterDust, LP_FEE, "DUST-CRUSH ALIVE: the quoted fee moved inside a single block");
        // The loop really ran: it spent exactly 300 x 1000 wei of currency0 and moved the pool's price.
        // (Not the TICK — 300 dust swaps never cross one. That is what made the crush cheap enough to be
        // an exploit in the first place, and it is why the anchor is sqrtPriceX96.)
        assertEq(
            spentBeforeDust - _bal(currency0, address(this)),
            DUST_SWAPS * 1000,
            "sanity: the dust loop did not spend what it should have, so it did not run as written"
        );
        assertTrue(_sqrt(k) != sqrtBeforeDust, "sanity: 300 dust swaps moved no price at all");

        // The block ends. Nothing was staged, because nothing can be.
        _advance(1);
        assertEq(h.currentFee(id), LP_FEE, "the fee moved once the dust block was over");

        // A full hour of quiet — the old volWindow — followed by another swap. The old engine decayed
        // here (and, when left idle, failed to). Neither direction exists any more.
        _advance(1 hours + 61);
        assertEq(h.currentFee(id), LP_FEE, "an idle hour moved the fee with no swap at all");
        _rawSwap(k, true, -int256(uint256(1000)));
        assertEq(h.currentFee(id), LP_FEE, "the first swap after a quiet hour was quoted a different fee");
        (uint16 idxAtEnd,,,,,) = h.poolStates(id);
        assertGt(uint256(idxAtEnd), uint256(idxAfterBurst), "sanity: the quiet hour wrote no observation");
    }

    /// @notice REGRESSION (was test_ATTACK_volCrushIncreasesSwapperOutput). The money question, unchanged:
    ///         does the dust loop buy the attacker a better fill on the following big trade? It cannot,
    ///         and now for a structural reason rather than a tuned one — the loop's only former lever was
    ///         the accumulator, and there is no accumulator. What is left is the loop's own price impact,
    ///         which is a pure cost. Two arms at two very different LEGAL fee levels (0.3% and 5%), so the
    ///         result cannot be an artifact of one fee; the arms also prove the fee level BINDS on fills,
    ///         which is what makes "the fee did not change, so the fill did not improve" falsifiable.
    function test_regression_volCrushDoesNotImproveTheFill() public {
        (uint256 withoutCrush, uint24 feeWithout) = _bigTradeOutput(302, LP_FEE, false);
        (uint256 withCrush, uint24 feeWith) = _bigTradeOutput(303, LP_FEE, true);
        console2.log("lpFee=3000 output without crush:", withoutCrush);
        console2.log("lpFee=3000 output with crush   :", withCrush);
        assertGt(withoutCrush, 0, "sanity: the honest arm's big trade received nothing");
        assertEq(feeWithout, LP_FEE, "the honest arm was quoted something other than lpFeePips");
        assertEq(feeWith, LP_FEE, "the dust loop changed the fee the big trade was quoted");
        // STRICT, and measured: the loop's own price impact is a pure cost with nothing on the other side
        // of the ledger any more. `assertLe` would also pass on a hook where the loop were free, which is
        // a weaker claim than the one this test is making.
        assertLt(withCrush, withoutCrush, "crushing was free, or still improved, the swapper's fill");
        console2.log("tokens the dust loop COST the attacker:", withoutCrush - withCrush);

        // ARM 2 — same attack against a hook constructed at 5%. (The old second arm varied
        // `volSensitivity`, which no longer exists; fee LEVEL is the axis that survives.)
        (uint256 hiWithout, uint24 hiFeeWithout) = _bigTradeOutput(305, ALT_LP_FEE, false);
        (uint256 hiWith, uint24 hiFeeWith) = _bigTradeOutput(306, ALT_LP_FEE, true);
        assertEq(hiFeeWithout, ALT_LP_FEE, "the 5% hook did not quote 5%");
        assertEq(hiFeeWith, ALT_LP_FEE, "the dust loop moved the 5% hook's fee");
        assertLt(hiWith, hiWithout, "crushing was free, or still improved, the fill at the 5% fee");

        // THE FALSIFIER. A fee this test claims is immovable must at least be a fee that MATTERS: the 5%
        // pool must return strictly less on the identical trade than the 0.3% pool. If these two were
        // equal, every fee equality above would be worthless.
        console2.log("lpFee=50000 output without crush:", hiWithout);
        console2.log("lpFee=50000 output with crush   :", hiWith);
        uint256 feeLevelEffect = withoutCrush - hiWithout;
        assertGt(feeLevelEffect, 0, "the fee level did not bind on the fill; the equalities prove nothing");

        // ...and SENSITIVITY, so "the fee did not move" is a claim this harness could have caught being
        // false. `feeLevelEffect` is what 47,000 pips of fee is worth on this trade; the crush moved the
        // fill by less than a thousandth of that, i.e. by less than ~47 pips' worth of fee even before
        // accounting for the loop's own price impact — which is the whole of what it moved.
        assertLt(
            withoutCrush - withCrush,
            feeLevelEffect / 1000,
            "the dust loop moved the fill by a fee-sized amount; the surcharge lever is back"
        );
    }

    /// @notice REGRESSION (was test_ATTACK_volCrushWorksAtTheHarnessSensitivity). CHANGED SHAPE: its only
    ///         distinguishing axis was `volSensitivity`, which is deleted, so re-running the same dust loop
    ///         would have duplicated the test above. It is re-aimed at the OTHER two defects that died with
    ///         the dynamic fee, both of which were about the CLOCK rather than about dust:
    ///           (1) decay compounded per WRITE, not per second, so a pool busier than the observation
    ///               interval decayed its surcharge faster — the fee under-applied exactly when flow was
    ///               heaviest; and
    ///           (2) an idle pool quoted its last surcharge forever, because nothing ages the number
    ///               without a swap.
    ///         So: hammer the pool far faster than the observation interval, then leave it untouched for
    ///         over a year. Neither the busy clock nor the idle clock can reach the fee, because the fee
    ///         is not a function of either.
    function test_regression_neitherBusyFlowNorIdleTimeMovesTheFee() public {
        MoleHook h = _hook(304, LP_FEE, 0);
        PoolKey memory k = _openPool(h, 60, 50_000e18);
        PoolId id = k.toId();

        // (1) BUSY: 40 swaps at 5-second spacing against a 60-second observation interval, i.e. twelve
        //     swaps per ring write — the regime where the per-write decay used to run twelve times fast.
        int24 tickAtOpen = _tick(k);
        int24 tickAfterFirst;
        for (uint256 i = 0; i < 40; i++) {
            _advance(5);
            _rawSwap(k, i % 2 == 0, -50e18);
            if (i == 0) tickAfterFirst = _tick(k);
            assertEq(h.currentFee(id), LP_FEE, "a busy-flow swap moved the fee");
        }
        (uint16 idxBusy,, uint32 lastObsBusy,,,) = h.poolStates(id);
        assertGt(uint256(idxBusy), 0, "sanity: 40 swaps wrote no observation, so the write path never ran");
        assertLt(uint256(idxBusy), 40, "sanity: the ring wrote once per swap, so this was not the busy regime");
        // Anchored on the FIRST swap, not on the end of the loop: the flow alternates direction, so the
        // pool ends back near where it started and an end-to-end comparison would report "no movement"
        // for forty swaps that each moved the price hard.
        assertTrue(tickAfterFirst != tickAtOpen, "sanity: a 50e18 swap moved no price");

        // (2) IDLE: nothing at all for a week, then for more than a year. The old engine's quote was
        //     frozen at whatever the last swap left behind; there is nothing left to freeze.
        _advance(7 days);
        assertEq(h.currentFee(id), LP_FEE, "an idle week moved the fee");
        _advance(400 days);
        assertEq(h.currentFee(id), LP_FEE, "an idle year moved the fee");
        (,, uint32 lastObsIdle,,,) = h.poolStates(id);
        assertEq(
            uint256(lastObsIdle), uint256(lastObsBusy), "sanity: an untouched pool wrote an observation by itself"
        );

        // The first swap back is quoted the same number as the first swap ever was.
        _rawSwap(k, true, -50e18);
        assertEq(h.currentFee(id), LP_FEE, "the first swap after a year of silence was quoted a different fee");
    }

    /// @dev Runs the volatility burst, optionally the same-block dust loop, then one big trade. Returns
    ///      the tokens the big trade actually received and the fee that was quoted for it. (It used to
    ///      also return the live volatility accumulator, so a caller could tell a fee that did not move
    ///      from a fee that could not move because it was against a clamp. There is no accumulator and no
    ///      clamp now — the falsifier is the second fee level in the caller, not a third return value.)
    function _bigTradeOutput(uint256 seed, uint24 lpFee, bool crush) internal returns (uint256, uint24) {
        MoleHook h = _hook(seed, lpFee, 0);
        PoolKey memory k = _openPool(h, 60, 5_000e18);
        for (uint256 i = 0; i < 5; i++) {
            _advance(61);
            _swapMeasured(k, i % 2 == 0, -400e18);
        }
        if (crush) {
            for (uint256 n = 0; n < DUST_SWAPS; n++) {
                _swapMeasured(k, true, -int256(uint256(1000)));
            }
        }
        uint24 quoted = h.currentFee(k.toId());
        Flow memory f = _swapMeasured(k, true, -200e18);
        return (uint256(f.me1), quoted);
    }

    /* =====================================================================================
        F.  THE take() IS ON THE CRITICAL SWAP PATH — AND NOW FAILS SOFT (REGRESSION)
       ===================================================================================== */

    /// @notice REGRESSION (was test_ATTACK_blocklistedFeeRecipientBricksEverySwap). The attack setup is
    ///         unchanged and still armed: a blocklist stablecoin (USDC/USDT shaped — the exact asset class
    ///         this product targets) refuses transfers to `feeRecipient`, which is immutable with no
    ///         setter anywhere on the hook. `afterSwap` used to call `poolManager.take` unconditionally
    ///         and untried, so the swap side of the pool bricked forever the moment the recipient landed
    ///         on the list. The take is now wrapped in try/catch: the fee is FORGONE, the swap settles,
    ///         and nothing is stranded in the hook.
    BlocklistToken internal bad;
    ReenterToken internal evil;
    PoolKey internal weirdKey;

    function test_regression_blocklistedFeeRecipientCannotBrickSwaps() public {
        _buildBlocklistPool();
        // zeroForOne == true pays currency0 and RECEIVES currency1, so to make the blocklist token the
        // output leg (the leg an exact-input swap is charged on) we swap toward it.
        bool towardBad = Currency.unwrap(weirdKey.currency1) == address(bad);
        address hookAddr = address(weirdKey.hooks);
        address other = towardBad ? Currency.unwrap(weirdKey.currency0) : Currency.unwrap(weirdKey.currency1);

        // Healthy first: a swap whose OUTPUT is the blocklist token pays a fee and settles.
        _rawSwap(weirdKey, towardBad, -10e18);
        uint256 treasuryHealthy = bad.balanceOf(treasury);
        assertGt(treasuryHealthy, 0, "sanity: fee never reached treasury");

        // The recipient gets blocklisted. Nothing about the pool or the hook changed.
        bad.setBlocked(treasury, true);

        // Every swap that pays out the blocklist token STILL SETTLES. The fee is simply forgone.
        int256[3] memory sizes = [-int256(10e18), -int256(1e18), -int256(1000e18)];
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 mineBefore = bad.balanceOf(address(this));
            _rawSwap(weirdKey, towardBad, sizes[i]);
            assertGt(bad.balanceOf(address(this)), mineBefore, "SWAP BRICKED: a blocked recipient stopped the swap");
            assertEq(bad.balanceOf(treasury), treasuryHealthy, "a blocked transfer somehow credited the treasury");
            assertEq(bad.balanceOf(hookAddr), 0, "hook retained the forgone fee");
            assertEq(MockERC20(other).balanceOf(hookAddr), 0, "hook retained the other currency");
        }

        // There is still no lever to disable the fee: hookFeePips and feeRecipient remain immutable, which
        // is precisely why the failure has to be contained inside afterSwap rather than administered away.
        assertEq(MoleHook(hookAddr).hookFeePips(), HOOK_FEE, "hook fee not immutable");
        assertEq(MoleHook(hookAddr).feeRecipient(), treasury, "recipient not immutable");
        // The LP fee is untouched by any of it, in either state of the blocklist.
        assertEq(MoleHook(hookAddr).currentFee(weirdKey.toId()), LP_FEE, "a forgone hook fee moved the LP fee");

        // The catch is not a permanent kill switch either: lift the block and revenue resumes.
        bad.setBlocked(treasury, false);
        _rawSwap(weirdKey, towardBad, -10e18);
        assertGt(bad.balanceOf(treasury), treasuryHealthy, "fees never resumed after the block was lifted");

        // The advertised safety property still holds: exits are untouched.
        uint256 before = bad.balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            weirdKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -5_000e18, salt: 0}),
            ZERO_BYTES
        );
        assertGt(bad.balanceOf(address(this)), before, "exit blocked too");
    }

    function _buildBlocklistPool() internal {
        (Currency ca, Currency cb) = _deployBlocklistPair();
        weirdKey = PoolKey({
            currency0: ca,
            currency1: cb,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(_hook(401, LP_FEE, HOOK_FEE)))
        });
        manager.initialize(weirdKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            weirdKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    /// @notice A reentrant ERC-20 fired from inside `take()` cannot extract value: any delta it opens
    ///         must still be closed before the unlock ends. Recorded as a NEGATIVE result.
    function test_reentrantTokenDuringTakeCannotExtract() public {
        _buildReenterPool();
        bool towardEvil = Currency.unwrap(weirdKey.currency1) == address(evil);
        evil.arm(manager, towardEvil ? weirdKey.currency1 : weirdKey.currency0, outsider);

        uint256 outsiderBefore = evil.balanceOf(outsider);
        // The reentrant take() opens a delta the swap router never settles -> the whole swap reverts, and
        // it must revert for THAT reason. Pinned to the selector rather than left as a bare
        // `vm.expectRevert()`: an unqualified expectation is satisfied by any revert at all, including one
        // from the token's own reentrancy failing before it ever reached the manager, which would make
        // this a test of the mock instead of a test of v4's delta accounting.
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        _rawSwap(weirdKey, towardEvil, -10e18);
        assertEq(evil.balanceOf(outsider), outsiderBefore, "reentrancy extracted tokens");

        // Disarmed, the same swap succeeds, so the pool itself was fine.
        evil.disarm();
        _rawSwap(weirdKey, towardEvil, -10e18);
        assertGt(evil.balanceOf(treasury), 0, "sanity: honest swap pays the hook fee");
        // ...and a reentrant token cannot reach the fee quote either, since there is no state to reach.
        assertEq(MoleHook(address(weirdKey.hooks)).currentFee(weirdKey.toId()), LP_FEE, "reentrancy moved the fee");
    }

    function _buildReenterPool() internal {
        (Currency ca, Currency cb) = _deployReenterPair();
        weirdKey = PoolKey({
            currency0: ca,
            currency1: cb,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(_hook(402, LP_FEE, HOOK_FEE)))
        });
        manager.initialize(weirdKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            weirdKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    /* =====================================================================================
                     G.  THE LIQUIDITY ALLOWLIST GATES THE ROUTER, NOT THE USER
       ===================================================================================== */

    /// @notice ATTACK. `beforeAddLiquidity`'s `sender` is whoever called `PoolManager.modifyLiquidity`,
    ///         i.e. the ROUTER. Allowlisting any permissionless router — which is exactly what the
    ///         project's own integration test does — hands the add-side JIT defence to the whole world,
    ///         and collapses every provider's dwell stamp into one shared slot.
    function test_ATTACK_restrictedLiquidityIsBypassedThroughAnAllowlistedRouter() public {
        MoleHook h = _deploy(
            Cfg({
                seed: 501,
                poolCreator: creator,
                lpFee: LP_FEE,
                obsInterval: 60,
                restricted: true,
                hookFee: 0,
                recipient: treasury
            })
        );
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);

        // The operator allowlists a permissionless router so its own vault can provide.
        h.setLiquidityAllowed(address(modifyLiquidityRouter), true);
        assertFalse(h.liquidityAllowed(outsider), "outsider must not be allowlisted");

        // The outsider is not on the list and adds anyway, through the same router.
        MockERC20(Currency.unwrap(currency0)).mint(outsider, 1_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(outsider, 1_000e18);
        vm.startPrank(outsider);
        MockERC20(Currency.unwrap(currency0)).approve(address(modifyLiquidityRouter), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: bytes32(0)}),
            ZERO_BYTES
        );
        vm.stopPrank();

        // The per-(pool, provider, salt) L1-block stamp this section used to inspect has been REMOVED.
        // Its own finding is why: the stamp was keyed on the CALLER, so every provider routing through one
        // router shared a single slot and it could never distinguish them. Nothing on-chain ever read it,
        // the JIT guard it was written for cannot exist (the hook is handed the vault's address, never the
        // depositor's), and it cost a cold SSTORE on every add. The bypass this test exists to prove is
        // asserted above, on balances, and is unaffected.
    }

    /* =====================================================================================
                          H.  PROOF THAT THE EXACT-OUTPUT FIX IS AVAILABLE
       ===================================================================================== */

    /// @notice The bypass was fixable WITHOUT re-mining the address. TwoSidedFeeHook carries the identical
    ///         0x38C4 bitmap and differs from MoleHook.afterSwap only in charging the unspecified leg in
    ///         both signs. The open question was whether `take()` can still resolve when the hook's delta
    ///         is added to the swapper's DEBIT rather than skimmed from their credit. It can. Kept as the
    ///         independent reference the shipped hook is now pinned against (see the equivalence test).
    function test_FIX_twoSidedFeeChargesExactOutputAndStillResolves() public {
        address a = _hookAddr(901);
        deployCodeTo(
            "AttackMoleHook_value.t.sol:TwoSidedFeeHook",
            abi.encode(manager, HOOK_FEE, treasury),
            a
        );
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(a)
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 500_000e18, salt: 0}),
            ZERO_BYTES
        );

        // Exact OUTPUT, the swap MoleHook used to let through for free.
        Flow memory f = _swapMeasured(k, true, int256(uint256(10e18)));
        uint256 grossIn = uint256(-f.me0 - f.tre0);
        assertGt(uint256(f.tre0), 0, "fixed hook still charged nothing on exact output");
        assertEq(uint256(f.tre0), grossIn * HOOK_FEE / 1e6, "fixed hook mis-sized the exact-output fee");
        assertEq(uint256(f.me1), 10e18, "swapper did not get the exact output requested");
        assertEq(f.pm0 + f.me0 + f.tre0, 0, "currency0 not conserved under the fix");
        assertEq(f.pm1 + f.me1 + f.tre1, 0, "currency1 not conserved under the fix");
        assertEq(_bal(currency0, a), 0, "fixed hook retained currency0");
        assertEq(_bal(currency1, a), 0, "fixed hook retained currency1");

        // Exact INPUT still behaves exactly as MoleHook does today.
        Flow memory g = _swapMeasured(k, true, -10e18);
        uint256 grossOut = uint256(g.me1 + g.tre1);
        assertEq(uint256(g.tre1), grossOut * HOOK_FEE / 1e6, "fixed hook broke the exact-input path");
    }

    /// @notice REGRESSION / equivalence. The reference hook above was written independently of MoleHook to
    ///         show the exact-output charge was implementable. Run the identical exact-output swap through
    ///         two identical pools that differ ONLY in which hook they carry: the shipped MoleHook must now
    ///         move exactly the same tokens as the reference, to the wei. This pins the fix to a second
    ///         implementation rather than to a number I derived from the code under test.
    ///
    ///         The reference hardcodes a 3000-pip LP fee, which is why the shipped side is deployed at
    ///         LP_FEE — with the dynamic fee gone, the two hooks now agree on the LP fee by construction
    ///         for every swap, not merely on the first one.
    function test_regression_shippedHookMatchesTheTwoSidedReference() public {
        address ref = _hookAddr(903);
        deployCodeTo("AttackMoleHook_value.t.sol:TwoSidedFeeHook", abi.encode(manager, HOOK_FEE, treasury), ref);
        PoolKey memory rk = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(ref)
        });
        manager.initialize(rk, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            rk,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 500_000e18, salt: 0}),
            ZERO_BYTES
        );

        // Same pair, same price, same liquidity, same 3000 LP fee — only the hook differs.
        PoolKey memory mk = _openPool(_hook(904, LP_FEE, HOOK_FEE), 60, 500_000e18);

        Flow memory r = _swapMeasured(rk, true, int256(uint256(10e18)));
        Flow memory m = _swapMeasured(mk, true, int256(uint256(10e18)));

        assertGt(uint256(r.tre0), 0, "reference charged nothing, so this proves nothing");
        assertEq(m.tre0, r.tre0, "shipped hook charges a different exact-output fee than the reference");
        assertEq(m.tre1, r.tre1, "shipped hook charges on a different currency than the reference");
        assertEq(m.me0, r.me0, "shipped hook debits the swapper differently than the reference");
        assertEq(m.me1, r.me1, "shipped hook credits the swapper differently than the reference");

        // Repeat after the pools have been used: the shipped hook has no state that could make it drift
        // away from a stateless reference on a later swap. This is the equivalence the removed dynamic
        // fee would have broken on swap two.
        Flow memory r2 = _swapMeasured(rk, true, int256(uint256(10e18)));
        Flow memory m2 = _swapMeasured(mk, true, int256(uint256(10e18)));
        assertEq(m2.tre0, r2.tre0, "shipped hook drifted from the reference on the second swap");
        assertEq(m2.me0, r2.me0, "shipped hook debited differently on the second swap");
    }

    /* ------------------------------------------------------------------ token helpers */

    function _rawSwap(PoolKey memory k, bool zeroForOne, int256 spec) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: spec,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _deployBlocklistPair() internal returns (Currency, Currency) {
        bad = new BlocklistToken();
        MockERC20 good = new MockERC20("GOOD", "GOOD", 18);
        bad.mint(address(this), 1_000_000e18);
        good.mint(address(this), 1_000_000e18);
        _approveAll(address(bad));
        _approveAll(address(good));
        return address(bad) < address(good)
            ? (Currency.wrap(address(bad)), Currency.wrap(address(good)))
            : (Currency.wrap(address(good)), Currency.wrap(address(bad)));
    }

    function _deployReenterPair() internal returns (Currency, Currency) {
        evil = new ReenterToken();
        MockERC20 good = new MockERC20("GOOD2", "GOOD2", 18);
        evil.mint(address(this), 1_000_000e18);
        good.mint(address(this), 1_000_000e18);
        _approveAll(address(evil));
        _approveAll(address(good));
        return address(evil) < address(good)
            ? (Currency.wrap(address(evil)), Currency.wrap(address(good)))
            : (Currency.wrap(address(good)), Currency.wrap(address(evil)));
    }

    function _approveAll(address token) internal {
        MockERC20(token).approve(address(swapRouter), type(uint256).max);
        MockERC20(token).approve(address(modifyLiquidityRouter), type(uint256).max);
        MockERC20(token).approve(address(manager), type(uint256).max);
    }
}

/// @dev A stablecoin-shaped ERC-20 with a transfer blocklist. USDC and USDT both behave this way.
contract BlocklistToken is MockERC20 {
    mapping(address => bool) public blocked;

    constructor() MockERC20("BAD", "BAD", 18) {}

    function setBlocked(address who, bool v) external {
        blocked[who] = v;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        require(!blocked[to], "BLOCKED");
        return super.transfer(to, amt);
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        require(!blocked[to] && !blocked[from], "BLOCKED");
        return super.transferFrom(from, to, amt);
    }
}

/// @dev An ERC-20 that reenters the PoolManager from inside the hook's `take()`.
contract ReenterToken is MockERC20 {
    IPoolManager internal pm;
    Currency internal self;
    address internal beneficiary;
    bool internal armed;

    constructor() MockERC20("EVIL", "EVIL", 18) {}

    function arm(IPoolManager _pm, Currency _self, address _beneficiary) external {
        pm = _pm;
        self = _self;
        beneficiary = _beneficiary;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        bool ok = super.transfer(to, amt);
        if (armed) {
            armed = false; // one shot
            // The manager is unlocked (we are inside the swap). Try to walk out with free tokens.
            pm.take(self, beneficiary, 1e18);
        }
        return ok;
    }
}


/// @dev PROOF OF FIX for the exact-output bypass. Identical permission bitmap (0x38C4) — no re-mining,
///      which matters because the address is a one-way door. The only change vs MoleHook.afterSwap is
///      that the fee is charged on the unspecified leg in BOTH signs: when the swapper is receiving it is
///      skimmed off their credit, when the swapper is paying (exact-output) it is added to their debit.
///      `take()` still resolves immediately in both cases, which is the part that had to be proven.
contract TwoSidedFeeHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    IPoolManager public immutable poolManager;
    uint24 public immutable hookFeePips;
    address public immutable feeRecipient;

    constructor(IPoolManager pm, uint24 fee, address recipient) {
        poolManager = pm;
        hookFeePips = fee;
        feeRecipient = recipient;
    }

    function beforeInitialize(address, PoolKey calldata, uint160) external pure override returns (bytes4) {
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24) external override returns (bytes4) {
        poolManager.updateDynamicLPFee(key, 3000);
        return IHooks.afterInitialize.selector;
    }

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    function beforeSwap(address, PoolKey calldata, SwapParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            uint24(3000) | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        returns (bytes4, int128)
    {
        if (hookFeePips == 0) return (IHooks.afterSwap.selector, 0);
        bool unspecifiedIsOne = (params.amountSpecified < 0 == params.zeroForOne);
        int128 d = unspecifiedIsOne ? delta.amount1() : delta.amount0();
        uint256 gross = uint256(uint128(d < 0 ? -d : d));
        uint256 amount = (gross * hookFeePips) / LPFeeLibrary.MAX_LP_FEE;
        if (amount == 0) return (IHooks.afterSwap.selector, 0);
        poolManager.take(unspecifiedIsOne ? key.currency1 : key.currency0, feeRecipient, amount);
        return (IHooks.afterSwap.selector, int128(uint128(amount)));
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert("unmined");
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("unmined");
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure override returns (bytes4, BalanceDelta) {
        revert("unmined");
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("unmined");
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert("unmined");
    }
}
