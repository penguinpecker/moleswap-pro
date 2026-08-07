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
