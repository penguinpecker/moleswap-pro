// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {IHooks as IHooksT} from "v4-core/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN, MoleDeployer} from "./helpers/ProxyDeploy.sol";

/// @notice Proves MoleHook actually works against the real PoolManager, callback by callback.
///
/// The question these tests answer is not "does it compile" but "does v4 actually call this, and does the
/// thing it does have the effect we claim". So the fee test measures a SWAP OUTPUT rather than trusting an
/// event, the oracle test reads a TWAP back after real swaps across real time, and the exit test proves the
/// remove path cannot reach the hook by making every remove-side function revert unconditionally and then
/// removing liquidity anyway.
///
/// SHAPE CHANGE, 2026-08: the volatility-scaled dynamic fee was REMOVED from the hook rather than repaired
/// (the fee collector could manufacture the volatility signal it was priced from — see `lpFeePips` in the
/// source). The fee is now a single immutable constant, re-asserted with OVERRIDE_FEE_FLAG on every swap.
/// The tests that exercised the removed machinery were not deleted wholesale: every one that was an ATTACK
/// on the fee keeps its attack machinery and now proves the attack surface NO LONGER EXISTS — big moves,
/// alternating churn, pacing across observation intervals, trend-and-retrace states, and long idle periods
/// all leave the fee exactly where it started, because there is no state left for them to move.
contract MoleHookTest is Test, Deployers {
    MoleDeployer internal _moleDeployer = new MoleDeployer();
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    MoleHook internal hook;
    PoolKey internal hookKey;
    PoolId internal hookId;

    address internal treasury = makeAddr("treasury");
    address internal outsider = makeAddr("outsider");

    int24 internal constant SPACING = 60;
    /// @dev The pool's one and only fee. There is no min/base/max any more — the constant IS the fee.
    uint24 internal constant LP_FEE = 3000; // 0.30%

    /// @dev Explicit test clock. `vm.warp(block.timestamp + d)` inside a LOOP does not accumulate:
    ///      block.timestamp cannot change within a call frame, so solc (especially under via_ir) reads it
    ///      once and every iteration warps to the same value. Time silently stops and the oracle looks
    ///      broken. Always advance a local counter instead.
    uint256 internal _clock;
    /// @dev Explicit block height. Same reason as _clock: block.number cannot change inside a call
    ///      frame either, so solc may cache it and `vm.roll(block.number + n)` in a loop would stall.
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        vm.warp(_clock);
        // Time passing implies blocks passing. Foundry's vm.warp does NOT advance block.number, so a
        // harness that only warps models a chain where the clock moves but no block is ever produced —
        // which silently freezes anything keyed on block.number. On Robinhood Chain block.number is the
        // ETHEREUM L1 height (~12s per tick), so one tick per advance is the conservative mapping.
        _height += 1 + secs / 12;
        vm.roll(_height);
    }

    /// @dev Mine an address carrying exactly the 0x38C4 permission bits (and nothing else).
    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("molehook", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev Deploy at a mined address. The constructor is the post-removal 7-arg shape: one fixed LP fee,
    ///      the observation interval, the liquidity gate, and the optional protocol fee. Nothing about the
    ///      fee is per-pool or mutable, so there is nothing else to configure.
    function _deployHook(uint256 seed, uint24 lpFee, uint32 obsInterval, bool restricted, uint24 hookFee)
        internal
        returns (MoleHook h)
    {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), lpFee, obsInterval, restricted, hookFee, treasury, address(this)),
            a
        );
        h = MoleHook(a);
    }

    function setUp() public {
        _clock = block.timestamp;
        _height = block.number;
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        hook = _deployHook(1, LP_FEE, 60, false, 0);

        // A DYNAMIC-fee pool bound to our hook. Fee must be the dynamic flag or beforeInitialize rejects it.
        hookKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(hookKey, SQRT_PRICE_1_1);
        hookId = hookKey.toId();

        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    /* ------------------------------------------------------- the address IS the permissions */

    function test_hookAddressCarriesExactlyTheMinedBits() public view {
        assertTrue(HookPermissions.isValid(address(hook)), "hook address does not carry 0x38C4");
        assertEq(uint160(address(hook)) & HookPermissions.ALL_HOOK_MASK, 0x38C4, "bitmap drifted");
        // The load-bearing omission, checkable from the address alone.
        assertEq(uint160(address(hook)) & HookPermissions.WITHDRAWAL_PATH_MASK, 0, "a remove bit is set");
        assertTrue(HookPermissions.withdrawalIsUnblockable(address(hook)), "withdrawal reachable");
        assertTrue(HookPermissions.depositIsUntaxable(address(hook)), "deposit-tax bit set");
    }

    function test_constructorRejectsAnUnminedAddress() public {
        // Deployed at a plain address, the constructor's self-check must fail — and must fail with its OWN
        // error, so a different revert (bad bounds, a bad arg) cannot be mistaken for the address guard.
        vm.expectRevert(MoleHook.BadHookAddress.selector);
        _moleDeployer.hookAnywhere(manager, address(this), LP_FEE, 60, false, 0, treasury);
    }

    /// @notice Every unusable configuration must be refused AT DEPLOY, each with its own named error.
    /// @dev These use a plain `new` rather than deployCodeTo on a mined address: forge-std's deployCodeTo
    ///      swallows the constructor's revert data and re-reverts with its own string, which would force a
    ///      selector-less expectRevert and prove only that *something* failed. The bounds are validated
    ///      before the address check precisely so this can be pinned — and each `new` below landing on
    ///      BadFeeBounds rather than BadHookAddress is itself the proof of that ordering.
    function test_constructorRejectsBadFeeBounds() public {
        // zero LP fee — arbitrage would reprice the pool for free
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, address(this), 0, 60, false, 0, treasury);

        // LP fee above the hard 10% ceiling
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, address(this), 100_001, 60, false, 0, treasury);

        // a zero observation interval exhausts the ring for the price of dust
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, address(this), LP_FEE, 0, false, 0, treasury);

        // a non-zero hook fee with no recipient
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, address(this), LP_FEE, 60, false, 5_000, address(0));

        // Exactly at the LP-fee ceiling is allowed, so the guard is a bound and not a blanket refusal —
        // and this deploy must land at a mined address, hence deployCodeTo rather than `new`.
        address a = _hookAddr(82);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), uint24(100_000), uint32(60), false, uint24(0), treasury, address(this)),
            a
        );
        assertEq(MoleHook(a).lpFeePips(), 100_000, "the LP-fee ceiling value itself was refused");
    }

    /* ----------------------------------------------------------------- beforeInitialize */

    function test_beforeInitialize_rejectsAStaticFeePool() public {
        // This is the silent-no-op trap: on a static-fee pool both updateDynamicLPFee and the beforeSwap
        // override no-op SILENTLY, so the constant fee would never actually be charged.
        PoolKey memory staticKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooksT.beforeInitialize.selector,
                abi.encodeWithSelector(MoleHook.FeeMustBeDynamic.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(staticKey, SQRT_PRICE_1_1);
    }

    function test_beforeInitialize_rejectsANonCreator() public {
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 30,
            hooks: IHooks(address(hook))
        });
        vm.prank(outsider);
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooksT.beforeInitialize.selector,
                abi.encodeWithSelector(MoleHook.NotPoolCreator.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);

        // ...and the creator can, so the check is not vacuous.
        manager.initialize(k, SQRT_PRICE_1_1);
    }

    /* ------------------------------------------------------------------ afterInitialize */

    function test_afterInitialize_seedsOracleAndSetsTheOpeningFee() public view {
        (,,, uint24 lpFee) = StateLibrary.getSlot0(manager, hookId);
        assertEq(lpFee, LP_FEE, "opening fee was not written at creation");

        (, uint32 lastTs, uint32 lastObsTs,,, bool init) = hook.poolStates(hookId);
        assertTrue(init, "pool state not initialized");
        assertEq(lastTs, uint32(block.timestamp), "oracle not seeded at creation");
        assertEq(lastObsTs, uint32(block.timestamp), "observation clock not seeded at creation");

        (uint32 obsTs,, bool obsInit) = hook.observations(hookId, 0);
        assertTrue(obsInit, "first observation missing");
        assertEq(obsTs, uint32(block.timestamp), "first observation timestamp wrong");
    }

    /* ------------------------------------------------------------------------ beforeSwap */

    /// @notice The fee override must actually change what the swapper pays — proven by measuring output,
    ///         not by trusting the event we emit.
    function test_beforeSwap_feeOverrideActuallyAppliesToTheSwap() public {
        // Two hooks with different constant fees, one cheap and one expensive.
        MoleHook cheap = _deployHook(11, 500, 60, false, 0); // 0.05%
        MoleHook dear = _deployHook(12, 50_000, 60, false, 0); // 5%

        uint256 outCheap = _swapOutputThroughFreshPool(cheap, 30);
        uint256 outDear = _swapOutputThroughFreshPool(dear, 30);

        assertGt(outCheap, outDear, "a 0.05% pool did not return more than a 5% pool - fee override is not applied");
        // Sanity on magnitude: ~5% worse, not a rounding artifact.
        assertGt(outCheap - outDear, outCheap / 50, "fee difference is implausibly small");
    }

    function _swapOutputThroughFreshPool(MoleHook h, int24 spacing) internal returns (uint256 out) {
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        uint256 before = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this));
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -1e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        out = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this)) - before;
    }

    /* ------------------------------------------------------------------------- afterSwap */

    function test_afterSwap_writesObservationsAndConsultReturnsATwap() public {
        // Swap across real elapsed time so the cumulative actually advances.
        for (uint256 i = 0; i < 6; i++) {
            _advance(120);
            _swap(true, 1e18);
        }
        (uint16 index,,,,,) = hook.poolStates(hookId);
        assertGt(index, 0, "no observation was ever written");

        int24 mean = hook.consult(hookId, 300);
        // Price moved down (zeroForOne), so the mean tick must be below the starting tick of 0.
        assertLt(mean, 0, "TWAP did not track the price move");
        assertGt(mean, -887272, "TWAP out of tick range");
    }

    function test_consultRevertsWhenTheWindowIsNotCovered() public {
        // Asking for a window older than any observation must revert with the GUARD, not with an
        // arithmetic panic. The first version of this test used a bare expectRevert() and passed on an
        // underflow panic instead — green for the wrong reason, which is the exact thing this repo's
        // weakened-assertion audits exist to catch. Pin the selector so only the guard can satisfy it.
        _advance(600);
        _swap(true, 1e15); // give the ring a real, recent observation to walk back from

        // A window longer than the chain's own age hits the explicit fail-closed rollover guard.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(hookId, 365 days);

        // A window that fits the clock but reaches past the OLDEST observation must fail closed too —
        // this exercises the backward-scan-found-nothing path rather than the rollover guard, and pins
        // that consult never answers a shorter window than it was asked for.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(hookId, uint32(_clock));
    }

    function test_observationWritesAreTimeGated() public {
        // Several swaps inside one interval must not each burn an SSTORE.
        (uint16 i0,,,,,) = hook.poolStates(hookId);
        for (uint256 i = 0; i < 5; i++) {
            _swap(true, 1e15);
        }
        (uint16 i1,,,,,) = hook.poolStates(hookId);
        assertEq(i1, i0, "observations were written without the interval elapsing");

        _advance(61);
        _swap(true, 1e15);
        (uint16 i2,,,,,) = hook.poolStates(hookId);
        assertEq(i2, i0 + 1, "observation not written after the interval elapsed");
    }

    /* --------------------------------------- the fee is IMMOVABLE: the old attacks, inverted */

    // The four tests below KEEP the machinery of the attacks that killed the dynamic fee and assert the
    // opposite conclusion: nothing moves the fee, because the state it was derived from no longer exists.
    // They are the negative control for any future attempt to reintroduce fee-from-pool-state — if one of
    // these ever fails, manipulable fee state has come back.

    /// @notice CONVERTED from `test_volatilityRaisesTheQuotedFee`. The volatility surcharge was the value
    ///         the wash-trade attack manufactured (surcharge to ceiling in one block at base fee, then
    ///         collected from third-party flow: attacker +114.9e18, swappers -170.0e18). The same big
    ///         paced moves now must move NOTHING: the quoted fee is a constant with no accumulator behind
    ///         it, so the manufacture step has no product.
    function test_bigPacedMovesCannotMoveTheFee() public {
        assertEq(hook.currentFee(hookId), LP_FEE, "a fresh pool must quote the constant");

        for (uint256 i = 0; i < 5; i++) {
            _advance(61); // across observation intervals, exactly as the vol accumulator was fed
            _swap(true, 200e18); // big moves = what used to read as high realized vol
            assertEq(hook.currentFee(hookId), LP_FEE, "a big move changed the fee - manipulable fee state is back");
        }
    }

    /// @notice CONVERTED from `test_feeIsAlwaysWithinItsImmutableBounds`. Bounds are no longer the claim —
    ///         EQUALITY is. Alternating heavy churn (the wash-trade shape: back-and-forth flow that nets
    ///         to nothing but used to read as volatility) must leave the fee bit-identical every step, in
    ///         the hook's own view and in the PoolManager's stored slot0 alike.
    function test_feeIsExactlyTheConstantUnderAlternatingChurn() public {
        for (uint256 i = 0; i < 12; i++) {
            _advance(61);
            _swap(i % 2 == 0, 300e18);
            assertEq(hook.currentFee(hookId), LP_FEE, "churn moved the quoted fee");
            (,,, uint24 storedFee) = StateLibrary.getSlot0(manager, hookId);
            assertEq(storedFee, LP_FEE, "churn moved the stored fee");
        }
    }

    /// @notice CONVERTED from `test_volatilityDecaysInProportionToElapsedTime`. The decay it pinned is
    ///         gone (it compounded per WRITE, not per second), and so is the defect it coexisted with: an
    ///         idle pool quoting its last surcharge forever. Both die the same way — after heavy flow and
    ///         then arbitrary idle time there is no surcharge to decay and none to go stale, so the quote
    ///         at every horizon is the constant.
    function test_idlePoolQuotesTheConstantNotAStaleSurcharge() public {
        _advance(61);
        _swap(true, 200e18); // what used to build a real accumulator
        assertEq(hook.currentFee(hookId), LP_FEE, "heavy flow left a surcharge behind");

        _advance(1800); // half the old decay window
        assertEq(hook.currentFee(hookId), LP_FEE, "a half-window of idling changed the quote");

        _advance(3600); // past the old full window
        assertEq(hook.currentFee(hookId), LP_FEE, "a full window of idling changed the quote");

        _advance(30 days); // no swap in between: the old bug quoted the last surcharge here forever
        assertEq(hook.currentFee(hookId), LP_FEE, "an idle month changed the quote");

        // And the pool still trades at that fee after the idle month — the quote is not merely a view.
        _swap(true, 1e15);
        assertEq(hook.currentFee(hookId), LP_FEE, "trading after idling moved the fee");
    }

    /// @notice CONVERTED from `test_fallingRegimeReferenceTracksTheLatestObservationNotThePoolBirth`. The
    ///         directional falling-fee regime is deleted, so there is no "corrective" direction and no
    ///         reference tick to track or to leave stale. The machinery — a trend above the birth tick,
    ///         then a partial retrace so spot sits BETWEEN the two references the old regime could have
    ///         used — is kept, because that is exactly the state where the old code had to pick a side.
    ///         Now neither side gets a discount: the quote in that state is the constant.
    function test_trendAndRetraceStateEarnsNoDirectionalDiscount() public {
        MoleHook h = _deployHook(61, LP_FEE, 60, false, 0);
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1); // born at tick 0
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );

        // 1. Push spot well ABOVE the birth tick and let an observation land.
        _advance(61);
        _swapOn(k, false, 300e18);
        (, int24 highTick,,) = StateLibrary.getSlot0(manager, k.toId());
        assertGt(highTick, 0, "premise failed: the trend did not move above the birth tick");

        // 2. In the SAME interval push spot part-way back down, so spot sits BETWEEN the birth tick and
        //    the trend high — the state where the two old candidate references disagreed.
        _swapOn(k, true, 150e18);
        (, int24 spot,,) = StateLibrary.getSlot0(manager, k.toId());
        assertGt(spot, 0, "premise failed: spot fell below the birth tick, the references would agree");
        assertLt(spot, highTick, "premise failed: spot is not between birth and the trend high");

        // 3. No direction is discounted, before or after trading either way.
        _advance(61);
        assertEq(h.currentFee(k.toId()), LP_FEE, "the ambiguous state produced a discount - a directional regime is back");
        _swapOn(k, false, 1e18); // toward the old "corrective vs latest observation" side
        assertEq(h.currentFee(k.toId()), LP_FEE, "trading up moved the fee");
        _swapOn(k, true, 1e18); // toward the old "corrective vs birth" side
        assertEq(h.currentFee(k.toId()), LP_FEE, "trading down moved the fee");
    }

    /// @notice CONVERTED from `testFuzz_fallingRegimeSplittingNeverBeatsTradingStraight`. The discount the
    ///         old regime could hand a patient splitter is gone, but the economic bound is worth keeping
    ///         as the machine that would catch its return: pacing an order across observation intervals
    ///         must never beat trading it straight, for any slice count. With a constant fee the only
    ///         effect of splitting is rounding in the pool's favor, so outSplit <= outSingle exactly.
    function testFuzz_splittingAcrossIntervalsNeverBuysADiscount(uint8 slicesRaw) public {
        uint256 slices = 2 + (uint256(slicesRaw) % 7); // 2..8
        MoleHook h = _deployHook(62, LP_FEE, 60, false, 0);
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        uint256 TRADE = 400e18;

        uint256 snap = vm.snapshotState();
        _advance(61);
        uint256 outSingle = _buyOn(k, TRADE);
        vm.revertToState(snap);

        uint256 outSplit;
        for (uint256 i = 0; i < slices; i++) {
            _advance(61);
            outSplit += _buyOn(k, TRADE / slices);
            assertEq(h.currentFee(k.toId()), LP_FEE, "pacing across intervals moved the fee");
        }
        assertLe(outSplit, outSingle, "splitting across intervals bought a discount from the LPs");
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

    function _buyOn(PoolKey memory k, uint256 amount) internal returns (uint256 out) {
        uint256 b = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this));
        _swapOn(k, true, amount);
        out = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this)) - b;
    }

    /// @notice consult() must survive a quiet pool at a large |tick| — which is the NORMAL case for the
    ///         pair this product ships on first.
    /// @dev An 18-decimal token against a 6-decimal one sits around tick -196,000; WETH/USDG is exactly
    ///      that shape. The interpolation multiplies a cumulative by an elapsed span, and that intermediate
    ///      overflows int56 long before either operand does, so a few idle days at that tick made consult()
    ///      revert with an opaque arithmetic Panic for EVERY window — including windows the ring covered
    ///      perfectly well. Since the keeper's TWAP bound calls consult(), that took rebalancing offline
    ///      entirely. The product is now computed in int256 and narrowed after the division.
    function test_consultSurvivesAQuietPoolAtTheTickWhereAn18x6PairLives() public {
        MoleHook h = _deployHook(71, LP_FEE, 60, false, 0);
        int24 deepTick = -196_020; // on 60-spacing, where an 18-dec/6-dec pair sits
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, TickMath.getSqrtPriceAtTick(deepTick));
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({
                tickLower: deepTick - 6_000,
                tickUpper: deepTick + 6_000,
                liquidityDelta: 5_000e18,
                salt: 0
            }),
            ZERO_BYTES
        );

        // Seed a couple of observations, then let the pool go quiet for days — the ordinary state of a
        // pool nobody is trading, and the state that used to break it.
        _advance(61);
        _swapOn(k, true, 1e15);
        _advance(61);
        _swapOn(k, true, 1e15);
        _advance(5 days);
        _swapOn(k, true, 1e15);

        (, int24 nowTick,,) = StateLibrary.getSlot0(manager, k.toId());
        assertLt(nowTick, -190_000, "premise failed: the pool is not at a deep tick");

        // Every window the ring can answer must return a sane mean, not panic.
        uint32[4] memory windows = [uint32(120), uint32(600), uint32(3600), uint32(4 days)];
        for (uint256 i = 0; i < windows.length; i++) {
            int24 mean = h.consult(k.toId(), windows[i]);
            assertLt(mean, -100_000, "TWAP is not tracking a deep-tick pool");
            assertGt(mean, TickMath.MIN_TICK, "TWAP escaped the tick range");
        }
    }

    /// @notice The 1% hook-fee ceiling must actually be enforced. A mutation audit deleted it and the whole
    ///         suite stayed green: `test_constructorRejectsBadFeeBounds` walked the other guards and skipped
    ///         this one, so the only thing standing between a deployment and a 1,677% swap tax
    ///         (type(uint24).max pips) was an unexercised line.
    function test_constructorRejectsAHookFeeAboveTheOnePercentCeiling() public {
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, address(this), LP_FEE, 60, false, 10_001, treasury);

        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        _moleDeployer.hookAnywhere(manager, address(this), LP_FEE, 60, false, type(uint24).max, treasury);

        // Exactly at the ceiling is allowed, so the guard is a bound and not a blanket refusal — and this
        // deploy must land at a mined address, hence deployCodeTo rather than `new`.
        address a = _hookAddr(81);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, uint32(60), false, uint24(10_000), treasury, address(this)),
            a
        );
        assertEq(MoleHook(a).hookFeePips(), 10_000, "the ceiling value itself was refused");
    }

    /* ------------------------------------------------------------- beforeAddLiquidity */

    function test_restrictedLiquidityBlocksOutsidersAndAllowsTheVault() public {
        MoleHook gated = _deployHook(31, LP_FEE, 60, true, 0);
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 20,
            hooks: IHooks(address(gated))
        });
        manager.initialize(k, SQRT_PRICE_1_1);

        // The router is not allowlisted -> the add must revert. This is the third-party-LP gate.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(gated),
                IHooksT.beforeAddLiquidity.selector,
                abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}), ZERO_BYTES
        );

        gated.setLiquidityAllowed(address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}), ZERO_BYTES
        );
        // The per-add L1-block stamp this used to assert was REMOVED: nothing on-chain read it, the JIT
        // guard it existed for cannot exist (the hook sees the vault, not the depositor), and it cost a
        // cold SSTORE on every add. What matters is the gate itself, asserted immediately above.
    }

    function test_onlyPoolCreatorCanAllowLiquidity() public {
        vm.prank(outsider);
        vm.expectRevert(MoleHook.NotPoolCreator.selector);
        hook.setLiquidityAllowed(outsider, true);
    }

    /* ---------------------------------------------- THE LOAD-BEARING CLAIM: exits are unblockable */

    /// @notice Every remove-side function on this hook reverts unconditionally. Liquidity removal still
    ///         works — because with those bits unmined the PoolManager never calls them. This is the
    ///         product's core safety claim, proven rather than asserted.
    function test_removingLiquidityNeverReachesTheHook() public {
        // Direct calls prove the functions really do revert...
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeRemoveLiquidity(address(this), hookKey, ModifyLiquidityParams(-600, 600, -1, bytes32(0)), "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterRemoveLiquidity(
            address(this), hookKey, ModifyLiquidityParams(-600, 600, -1, bytes32(0)),
            BalanceDelta.wrap(0), BalanceDelta.wrap(0), ""
        );

        // ...yet a real removal through the PoolManager succeeds anyway.
        uint256 b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -1_000e18, salt: 0}),
            ZERO_BYTES
        );
        assertGt(
            MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)),
            b0,
            "withdrawal did not pay out - the exit path is not unblockable"
        );
    }

    /* ------------------------------------------------------------- afterSwapReturnDelta */

    function test_hookFeeIsTakenFromTheUnspecifiedLegAndPaidToTreasury() public {
        MoleHook paid = _deployHook(41, LP_FEE, 60, false, 5_000); // 0.5%
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 40,
            hooks: IHooks(address(paid))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}), ZERO_BYTES
        );

        uint256 tBefore = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        swapRouter.swap(
            k, SwapParams({zeroForOne: true, amountSpecified: -10e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), ZERO_BYTES
        );
        uint256 taken = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury) - tBefore;
        assertGt(taken, 0, "hook fee bit is mined but no fee was captured");
    }

    function test_zeroHookFeeTakesNothing() public {
        uint256 tBefore = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        _swap(true, 5e18);
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(treasury), tBefore, "fee taken when rate is zero");
    }

    /* ------------------------------------------------------- integration with MolePositions */

    /// @notice The end-to-end proof: MolePositions pinned to the REAL hook admits the hook's pool through
    ///         the fail-closed F-1 allowlist, and a user can open and fully withdraw through it.
    function test_integration_molePositionsPinnedToTheRealHook() public {
        MoleHook gated = _deployHook(51, LP_FEE, 60, true, 0);
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(gated))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        gated.setLiquidityAllowed(address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}), ZERO_BYTES
        );

        MolePositions mole = deployMoleVault(manager, makeAddr("keeper"), 1 hours, 120, 60_000, address(gated), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        gated.setLiquidityAllowed(address(mole), true);

        // The F-1 allowlist must ACCEPT our own hook's pool...
        mole.whitelistPool(k);
        assertTrue(mole.isWhitelisted(k.toId()), "pinned hook's pool was rejected");

        // ...and still reject a hookless one, so the gate is not just "anything goes".
        PoolKey memory hookless = PoolKey({
            currency0: currency0, currency1: currency1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))
        });
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(hookless);

        // Full custody round trip through a pool that carries a live hook.
        MockERC20(Currency.unwrap(currency0)).approve(address(mole), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(mole), type(uint256).max);
        uint256 id = mole.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        assertEq(mole.ownerOf(id), address(this), "owner not recorded");

        uint256 b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        mole.withdraw(id, mole.getPosition(id).liquidity);
        assertGt(MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)), b0, "withdraw paid nothing");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(mole)), 0, "mole retained currency0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(mole)), 0, "mole retained currency1");
    }

    /* ------------------------------------------- consult() answers THE WINDOW IT WAS ASKED FOR */

    // THE DEFECT THESE PIN (found and fixed 2026-08-23). `consult` silently ignored `secondsAgo` whenever
    // the window's left edge post-dated the newest ring entry: the backward scan matched that entry on its
    // first step, substituted `now`/`cumNow` for the missing right-hand end of the bracket, and the
    // requested window then cancelled out of the algebra completely. EVERY window returned one number —
    // the mean tick since the last ring WRITE — contaminated by ticks strictly outside the window asked
    // for.
    //
    // Measured live on Arc 5042 (hook 0xfFDC…78c4, pool 0x180a…1796) on 2026-08-23, newest write 2,676
    // seconds old: consult at 60s, 300s, 600s, 900s, 1800s and 2670s all returned tick 338426. 2700s — the
    // first window long enough to reach past that write — returned 338427, and 3600s returned 338495. An
    // hour later, with the gap at 6,744s, consult(60), consult(1800) and consult(4000) had all collapsed
    // onto 338434 together. The vault's TWAP bound was asking for thirty minutes and being handed however
    // long it had been since a swap happened to land on the interval.
    //
    // The repair is NOT "refuse whenever the ring is cold". It is: only ever answer from a cumulative the
    // contract RECORDED. A window lying wholly after the last swap is answered exactly (the tick did not
    // move inside it); a window straddling ring history is bracketed; a window reaching past the oldest
    // entry is refused. The tests below pin all three, and the safety of the first one — which rests
    // entirely on `lastTimestamp` advancing on every swap while the ring advances only every interval —
    // gets two adversarial tests of its own.

    /// @notice THE HONEST QUIET CASE. A pool nobody has traded has not moved, so the arithmetic mean over
    ///         any window inside that quiet stretch is EXACTLY the last tick — not an approximation of it,
    ///         and not spot standing in for a number we could not compute. Every window must return that,
    ///         and the windows must agree with each other because the tick really was constant, which is a
    ///         different fact from the defect's "they agree because `secondsAgo` was ignored".
    function test_aQuietPoolAnswersEveryWindowWithItsUnmovedTick() public {
        for (uint256 i = 0; i < 4; i++) {
            _advance(61);
            _swap(true, 1e15);
        }
        (,, uint32 lastObsTs, int24 lastTick,,) = hook.poolStates(hookId);
        assertEq(lastObsTs, uint32(_clock), "premise: the last swap did not write an observation");

        // Stop swapping. Nothing but a swap can advance the ring, so the gap grows on its own — the
        // ordinary state of a pool nobody is trading, and the exact state the live Arc pool was in.
        _advance(3000);

        assertEq(hook.consult(hookId, 60), lastTick, "a one-minute window on an untraded pool is its tick");
        assertEq(hook.consult(hookId, 1800), lastTick, "the consumers' 30-minute window is that same tick");
        assertEq(hook.consult(hookId, 2999), lastTick, "a window just short of the gap is that same tick");
        // The exact-hit boundary: the left edge lands on the stored observation itself.
        assertEq(hook.consult(hookId, 3000), lastTick, "the exact-hit boundary was not answered exactly");
        // And one second further back is bracketed across two real observations, which is a different
        // code path and must still answer.
        assertGt(hook.consult(hookId, 3001), TickMath.MIN_TICK, "the first bracketed window did not answer");
    }

    /// @notice AN ATTACKER'S OWN SWAP CLOSES THE QUIET-TAIL PATH. This is the property the whole design
    ///         rests on: `_write` advances `lastTimestamp` on EVERY swap while the ring advances only
    ///         every `minObservationInterval`, so the instant the tick is moved, `target >= lastTimestamp`
    ///         stops holding and the read is forced back onto real bracketing across prior history.
    function test_anAttackerSwapDefeatsTheQuietTailPath() public {
        // A long, quiet, honest history at the birth tick, with the ring written across it.
        for (uint256 i = 0; i < 6; i++) {
            _advance(400);
            _swap(true, 1e15);
        }
        _advance(2000); // quiet: the tail path is open and answering
        (,,, int24 calmTick,,) = hook.poolStates(hookId);
        assertEq(hook.consult(hookId, 1800), calmTick, "premise: the quiet pool was not on the tail path");

        // The attack: move the tick hard, then read immediately — the best case for the attacker.
        _swapOn(hookKey, false, 3_000e18);
        (, int24 movedTick,,) = StateLibrary.getSlot0(manager, hookId);
        assertGt(movedTick - calmTick, 2_000, "premise: the attack did not move the tick far enough");

        int24 twap = hook.consult(hookId, 1800);
        assertTrue(twap != movedTick, "consult returned the manipulated tick outright");
        // And it is not merely different — it is still anchored on the calm history. The move happened in
        // the read's own block, so it is worth zero seconds of a 1800-second window.
        assertEq(twap, calmTick, "the manipulated tick leaked into the mean at all");

        // The attacker's own transaction is what shut the door: `lastTimestamp` is now `now`, so the
        // window can no longer lie wholly after the last swap.
        (, uint32 lastTs,,,,) = hook.poolStates(hookId);
        assertEq(lastTs, uint32(_clock), "premise: the attack did not advance lastTimestamp");
    }

    /// @notice THE SUB-INTERVAL POISON, which is the case the tail condition must be written against. A
    ///         swap inside a write gap moves the tick without leaving a ring entry, so between the newest
    ///         entry and `lastTimestamp` the tick path is genuinely unknown. Answering that band with
    ///         `lastTick` would report a manipulation that lasted seconds as though it had held for the
    ///         whole window — which is exactly what widening the tail condition from `lastTimestamp` to
    ///         `lastObsTimestamp` would do. The realistic consumer window must be unmovable, and the band
    ///         itself must refuse rather than answer.
    function test_aSubIntervalPoisonCannotBeReadBackAsTheTwap() public {
        // Enough honest history that a 1800s window is genuinely bracketed by the ring.
        for (uint256 i = 0; i < 8; i++) {
            _advance(400);
            _swap(true, 1e15);
        }
        (,, uint32 writeTs, int24 calmTick,,) = hook.poolStates(hookId);
        assertEq(writeTs, uint32(_clock), "premise: the last swap did not write");

        // The poison, 30 seconds into the gap — too soon for the ring to record it.
        _advance(30);
        _swapOn(hookKey, false, 3_000e18);
        (, int24 poisonTick,,) = StateLibrary.getSlot0(manager, hookId);
        assertGt(poisonTick - calmTick, 2_000, "premise: the poison did not move the tick");
        (,, uint32 stillWriteTs, int24 lastTick,,) = hook.poolStates(hookId);
        assertEq(stillWriteTs, writeTs, "premise: the poison wrote an observation and is therefore visible");
        assertEq(lastTick, poisonTick, "premise: lastTick did not take the poison");

        // (a) THE CONSUMER WINDOW. 1800s is what MolePositions and MoleQueue actually pass. Ten seconds
        //     later the poison is worth 10 seconds of 1800, and the answer must show that — it must stay
        //     on the calm history rather than snapping to the moved tick.
        _advance(10);
        int24 twap = hook.consult(hookId, 1800);
        assertTrue(twap != poisonTick, "the 30-minute TWAP returned the manipulated tick");
        int24 leak = twap > calmTick ? twap - calmTick : calmTick - twap;
        assertLt(leak, 600, "the sub-interval poison moved the TWAP by the whole deviation budget");

        // (a2) THE INCLUSIVE BOUNDARY. A window measured from `lastTimestamp` itself lies wholly after the
        //     last swap, so it is answered from the recorded cumulative and IS the poisoned tick — which is
        //     honest: over those ten seconds the tick really was that. It is answered rather than refused,
        //     and that inclusivity is the `>=` in the tail condition. Note what makes it harmless: nobody
        //     asks this oracle for a ten-second TWAP, and the window the consumers DO pass is pinned above.
        (, uint32 lastSwapTs,,,,) = hook.poolStates(hookId);
        assertEq(hook.consult(hookId, uint32(_clock) - lastSwapTs), poisonTick, "the tail boundary is not inclusive");

        // (b) THE BAND ITSELF. A window whose left edge lands between the newest ring entry and the last
        //     swap has exact endpoints but an unrecorded tick path between them. It must REFUSE. Widening
        //     the tail condition to `lastObsTimestamp` would answer it with `lastTick` — the poison, at
        //     full strength, for a window it occupied only half of.
        uint32 shortWindow = uint32(_clock) - (writeTs + 20); // left edge 20s into the write gap
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(hookId, shortWindow);
    }

    /// @notice The positive control: over a warm ring where the price genuinely moved, two different
    ///         windows must return two genuinely different means. If `secondsAgo` ever stops reaching the
    ///         arithmetic again, these two collapse onto one value and this test says so.
    function test_differentWindowsOverTheSameHistoryGiveDifferentMeans() public {
        // Eight paced moves, all one way, each landing its own observation.
        for (uint256 i = 0; i < 8; i++) {
            _advance(61);
            _swap(true, 200e18);
        }

        // Both windows land BETWEEN observations on purpose, so each one is answered by interpolating
        // inside a real write gap. A window that lands exactly on an observation reads a stored cumulative
        // and would leave the interpolation arithmetic — where the original 11x-understatement defect
        // lived — completely unexercised.
        int24 shortMean = hook.consult(hookId, 100);
        int24 longMean = hook.consult(hookId, 400);

        assertLt(longMean, 0, "premise: the price did not move");
        assertLt(shortMean, longMean, "the short window did not track the move more closely than the long one");
        assertGt(longMean - shortMean, 100, "the two windows collapsed onto one number");
    }

    /// @notice A YOUNG POOL IS CORRECT IN BOTH DIRECTIONS. Inside its own life it answers its birth tick,
    ///         because a pool that has never traded has never moved. Older than its own life it REFUSES:
    ///         there is no recorded point to anchor the left edge on, and inventing history is the one
    ///         thing this function must never do.
    function test_aYoungPoolAnswersInsideItsLifeAndRefusesOlderThanItself() public {
        MoleHook h = _deployHook(91, LP_FEE, 60, false, 0);
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 15,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1); // born at tick 0
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );

        _advance(300); // born, then left alone: the ring holds exactly its seed
        assertEq(h.consult(k.toId(), 120), int24(0), "a window inside an untraded pool's life is its birth tick");
        assertEq(h.consult(k.toId(), 300), int24(0), "the exact-hit boundary at the seed was not answered");

        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(k.toId(), 400); // older than the pool itself: nothing to anchor on

        // A swap gives the ring a second entry, and the bracketed path takes over.
        _swapOn(k, true, 1e15);
        int24 mean = h.consult(k.toId(), 120);
        assertLt(mean, TickMath.MAX_TICK, "a warmed ring stopped answering a window it covers");
        assertGt(mean, TickMath.MIN_TICK, "a warmed ring stopped answering a window it covers");
    }

    /// @notice THE POISONING CASE THE OLD CODE ACTUALLY LOST, measured. An excursion held entirely inside
    ///         one write gap is invisible to the ring, and the old code smeared it across every window
    ///         alike — so a spike that had been over for forty minutes still moved a 30-minute "TWAP" by
    ///         more than the vault's ENTIRE deviation budget (600 ticks). The window it poisoned did not
    ///         even contain it.
    ///
    /// @dev The test computes, from the hook's own public state, the exact number the old code returned,
    ///      asserts it is that far from the truth, and then asserts the current code returns the truth
    ///      EXACTLY — the excursion contributes zero, because it ended before the window began.
    function test_anExcursionInsideOneWriteGapCannotPoisonALongWindow() public {
        // A 10-minute write interval — a legitimate configuration (the ring's ceiling is 255 gaps, so this
        // is a ~42h oracle) and the one that makes the arithmetic legible.
        MoleHook h = _deployHook(92, LP_FEE, 600, false, 0);
        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 10,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        PoolId id = k.toId();

        // 1. A write lands. This is the newest thing the ring will ever know about.
        _advance(601);
        _swapOn(k, true, 1e15);
        (,, uint32 pinnedObsTs,,,) = h.poolStates(id);
        assertEq(pinnedObsTs, uint32(_clock), "premise: the ring did not write");

        // 2. The excursion, opened and closed INSIDE the gap so no observation can record it.
        _advance(1);
        _swapOn(k, false, 4_000e18);
        (, int24 spikeTick,,) = StateLibrary.getSlot0(manager, id);
        assertGt(spikeTick, 3_000, "premise: the excursion was too small to matter");
        _advance(589);
        _swapOn(k, true, 4_000e18);
        (,, uint32 stillPinned,,,) = h.poolStates(id);
        assertEq(stillPinned, pinnedObsTs, "premise: the excursion wrote an observation and became visible");

        // 3. The pool goes quiet, long enough that the whole 30-minute window sits AFTER the excursion
        //    ended. The honest 30-minute mean is therefore the settled tick, with no spike in it at all.
        _advance(2_500);
        (,, uint32 obsTs, int24 settledTick, int56 cum, bool init) = h.poolStates(id);
        assertTrue(init, "premise: pool state vanished");
        (, int56 obsCum,) = h.observations(id, 0); // index unchanged: obs[0] is still the newest

        // What the old code returned for EVERY window, recomputed here from public state: the mean tick
        // since the last write, spike and all.
        uint32 gap = uint32(_clock) - obsTs;
        int24 poisoned = int24((cum - obsCum) / int56(int256(uint256(gap))));
        int24 contamination = poisoned > settledTick ? poisoned - settledTick : settledTick - poisoned;
        assertGt(
            contamination,
            600,
            "premise: the excursion did not move the stale answer past the vault's whole deviation budget"
        );

        // What this code returns: the truth, exactly. The window began 1,290 seconds after the excursion
        // ended, so the excursion is worth exactly nothing in it.
        assertEq(h.consult(id, 1800), settledTick, "the excursion leaked into a window it does not touch");

        // And a window long enough to actually CONTAIN the excursion prices it as a fraction of itself,
        // rather than refusing or swallowing it whole.
        int24 honest = h.consult(id, gap + 100);
        assertTrue(honest != settledTick, "a window containing the excursion ignored it");
        assertLt(honest, poisoned, "the containing window did not dilute the excursion");
    }

    /// @notice `consult` IS NOT A SPOT ORACLE, and the zero-length window is where that gets said out loud.
    ///         A caller that wants the instantaneous tick must read slot0 and own that choice visibly.
    function test_consultRefusesAZeroLengthWindow() public {
        _advance(61);
        _swap(true, 1e15);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(hookId, 0);
    }

    /* --------------------------------------------------- rotating the two un-rotatable roles */

    /// @notice `poolCreator` and `feeRecipient` had no setter, so rotating either — after a leak, or as a
    ///         planned handover — meant shipping a new implementation through `upgradeAdmin`. An incident
    ///         on the LOWEST-privilege key forced the use of the HIGHEST-privilege one. These setters grant
    ///         no new power (the upgrade key could already rewrite both) and turn a code deployment into an
    ///         event.
    function test_upgradeAdminCanRotatePoolCreatorAndTheRotationIsReal() public {
        address newCreator = makeAddr("newPoolCreator");
        assertEq(hook.poolCreator(), address(this), "premise: this test does not hold the creator role");

        vm.expectEmit(true, true, false, false, address(hook));
        emit MoleHook.PoolCreatorSet(address(this), newCreator);
        hook.setPoolCreator(newCreator); // this contract is the upgrade admin on the test hooks
        assertEq(hook.poolCreator(), newCreator, "rotation did not take");

        // The role MOVED rather than being shared: the old holder loses the power...
        vm.expectRevert(MoleHook.NotPoolCreator.selector);
        hook.setLiquidityAllowed(outsider, true);
        // ...and the new one has it.
        vm.prank(newCreator);
        hook.setLiquidityAllowed(outsider, true);
        assertTrue(hook.liquidityAllowed(outsider), "the rotated creator could not use the role");
    }

    function test_onlyUpgradeAdminMayRotateEitherRole() public {
        vm.startPrank(outsider);
        vm.expectRevert(MoleHook.NotUpgradeAdmin.selector);
        hook.setPoolCreator(outsider);
        vm.expectRevert(MoleHook.NotUpgradeAdmin.selector);
        hook.setFeeRecipient(outsider);
        vm.stopPrank();

        // Not even the pool creator — the role being rotated cannot rotate itself.
        MoleHook h = _deployHook(93, LP_FEE, 60, false, 0);
        h.setPoolCreator(makeAddr("creator93"));
        vm.prank(makeAddr("creator93"));
        vm.expectRevert(MoleHook.NotUpgradeAdmin.selector);
        h.setPoolCreator(outsider);
    }

    /// @notice Zero is refused for `poolCreator`. Renouncing the UPGRADE key removes a power; renouncing
    ///         this one freezes a power that pools still depend on — on a restricted-liquidity hook the LP
    ///         allowlist could never be edited again. That is a brick, not a renunciation.
    function test_poolCreatorCannotBeRenouncedToZero() public {
        vm.expectRevert(MoleHook.PoolCreatorRequired.selector);
        hook.setPoolCreator(address(0));
        assertEq(hook.poolCreator(), address(this), "the refused rotation still moved the role");
    }

    /// @notice The fee recipient may be cleared only when there is no fee to strand. With a live
    ///         `hookFeePips`, `take` to address(0) does not revert — it burns the fee silently — so the
    ///         setter restates the initializer's invariant, and with the same error.
    function test_feeRecipientCannotBeClearedWhileAFeeIsLive() public {
        MoleHook paid = _deployHook(94, LP_FEE, 60, false, 5_000); // 0.5%
        vm.expectRevert(MoleHook.BadFeeBounds.selector);
        paid.setFeeRecipient(address(0));
        assertEq(paid.feeRecipient(), treasury, "the refused rotation still cleared the recipient");

        // A live rotation works, and the fee follows it to the new address rather than the old one.
        address newTreasury = makeAddr("newTreasury");
        vm.expectEmit(true, true, false, false, address(paid));
        emit MoleHook.FeeRecipientSet(treasury, newTreasury);
        paid.setFeeRecipient(newTreasury);

        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 25,
            hooks: IHooks(address(paid))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        uint256 oldBefore = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        _swapOn(k, true, 10e18);
        assertGt(MockERC20(Currency.unwrap(currency1)).balanceOf(newTreasury), 0, "the rotated recipient was not paid");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(treasury), oldBefore, "the old recipient was still paid");

        // With no fee live, clearing IS allowed — the invariant is "a live fee must have somewhere to go",
        // not "this address may never be zero".
        hook.setFeeRecipient(address(0));
        assertEq(hook.feeRecipient(), address(0), "clearing was refused on a hook that charges nothing");
    }

    /* ------------------------------------------------------------------------- helpers */

    function _swap(bool zeroForOne, int256 amount) internal {
        swapRouter.swap(
            hookKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -amount,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }
}
