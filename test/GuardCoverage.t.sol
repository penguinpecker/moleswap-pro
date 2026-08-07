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
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {DeployConfig} from "../src/config/DeployConfig.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN, MoleDeployer} from "./helpers/ProxyDeploy.sol";

/// @dev An ERC-20 that returns `false` instead of reverting. Silent-failure tokens are the reason
///      MolePositions checks the return value at all, and the long-tail assets this vault is meant to list
///      are exactly where they turn up.
contract FalseReturningToken is MockERC20 {
    bool public lie;

    constructor() MockERC20("Liar", "LIE", 18) {}

    function setLie(bool v) external {
        lie = v;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        if (lie) return false;
        return super.transfer(to, amt);
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        if (lie) return false;
        return super.transferFrom(from, to, amt);
    }
}

/// @notice Coverage for guards a mutation audit found NO test could detect.
///
/// Each one below could be deleted from the source with the entire suite (289 tests at the time) still
/// green — a mutation audit deleted them one at a time and nothing went red. That is not
/// the same as a bug — most are correct — but an undetected guard is a guard that can be removed by a
/// future refactor without anything noticing, and several of these are the difference between "an attacker
/// cannot" and "an attacker can". The `onlyPoolManager` modifiers in particular: without them, any address
/// could call `afterInitialize` on a live pool and reset its oracle for free.
contract GuardCoverageTest is Test, Deployers {
    MoleDeployer internal _moleDeployer = new MoleDeployer();
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MoleHook internal hook;
    PoolKey internal hookKey;
    address internal KEEPER = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal outsider = makeAddr("outsider");
    address internal treasury = makeAddr("treasury");

    int24 internal constant SPACING = 60;
    uint24 internal constant LP_FEE = 3000;

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("guardcov", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        address a = _hookAddr(1);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, uint32(60), false, uint24(0), treasury, address(this)),
            a
        );
        hook = MoleHook(a);
        hookKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(a)
        });
        manager.initialize(hookKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    /* ------------------------------------------------- onlyPoolManager on every callback */

    /// @notice Every hook callback must refuse a direct caller. `afterInitialize` is the dangerous one:
    ///         unguarded it rewrites the pool's whole oracle state — index, timestamps, cumulative — and
    ///         re-seeds observation slot 0, i.e. a free, repeatable oracle reset on a live pool by anyone.
    ///         `afterSwap` unguarded lets anyone drive `_write` for an arbitrary PoolId, planting
    ///         initialized observations that `consult`'s backward scan would later treat as real.
    function test_everyHookCallbackRefusesADirectCaller() public {
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(-600, 600, 1e18, bytes32(0));
        SwapParams memory sp = SwapParams(true, -1e18, MIN_PRICE_LIMIT);

        vm.startPrank(outsider);

        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeInitialize(outsider, hookKey, SQRT_PRICE_1_1);

        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterInitialize(outsider, hookKey, SQRT_PRICE_1_1, 0);

        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(outsider, hookKey, mp, "");

        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeSwap(outsider, hookKey, sp, "");

        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterSwap(outsider, hookKey, sp, BalanceDelta.wrap(0), "");

        vm.stopPrank();
    }

    /// @notice The oracle state a direct `afterInitialize` would have reset is provably untouched.
    ///         Asserted separately so the test above cannot pass merely because *something* reverted.
    function test_aRefusedDirectCallLeavesTheOracleUntouched() public {
        vm.warp(block.timestamp + 120);
        swapRouter.swap(
            hookKey,
            SwapParams(true, -1e18, MIN_PRICE_LIMIT),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        PoolId id = hookKey.toId();
        (uint16 idxBefore, uint32 lastTsBefore,,, int56 cumBefore, bool initBefore) = hook.poolStates(id);
        assertTrue(initBefore, "premise: pool not initialized");

        vm.prank(outsider);
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterInitialize(outsider, hookKey, SQRT_PRICE_1_1, 0);

        (uint16 idxAfter, uint32 lastTsAfter,,, int56 cumAfter,) = hook.poolStates(id);
        assertEq(idxAfter, idxBefore, "the ring index was reset by a direct call");
        assertEq(lastTsAfter, lastTsBefore, "the oracle clock was reset by a direct call");
        assertEq(cumAfter, cumBefore, "the cumulative was reset by a direct call");
    }

    /* ------------------------------------- MolePositions constructor: the pinned-hook proof */

    /// @notice "A mis-pin cannot deploy" is a claim in MolePositions' NatSpec that had NO test at all —
    ///         neither `WithdrawalWouldBeBlockable` nor `DepositWouldBeTaxable` appeared anywhere in the
    ///         suite, so the constructor block proving a pinned hook cannot block exits or tax deposits
    ///         could have been deleted silently.
    function test_constructorRefusesToPinAHookThatCouldBlockExitsOrTaxDeposits() public {
        // A hook address carrying a REMOVE-liquidity bit: withdrawals could be blocked by it.
        address blocksExits = address(uint160(0x4242 << 20) | HookPermissions.WITHDRAWAL_PATH_MASK);
        assertFalse(HookPermissions.withdrawalIsUnblockable(blocksExits), "premise: bit not set");
        vm.expectRevert(MolePositions.WithdrawalWouldBeBlockable.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, blocksExits, 0, 0, 0, 0, 10_000, 0, 0, address(0));

        // A hook address carrying the add-liquidity return-delta bit: it could tax a deposit (F-1).
        address taxesDeposits = address(uint160(0x4242 << 20) | HookPermissions.DEPOSIT_TAX_MASK);
        assertFalse(HookPermissions.depositIsUntaxable(taxesDeposits), "premise: bit not set");
        vm.expectRevert(MolePositions.DepositWouldBeTaxable.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, taxesDeposits, 0, 0, 0, 0, 10_000, 0, 0, address(0));

        // A clean pin deploys, so the guard is a filter and not a blanket refusal.
        address clean = address(uint160(0x4242 << 20) | HookPermissions.REQUIRED_FLAGS);
        MolePositions ok = deployMoleVault(manager, KEEPER, 0, 120, 60_000, clean, 0, 0, 0, 0, 10_000, 0, 0, address(0));
        assertEq(ok.moleHook(), clean, "a clean pin was refused");
    }

    /* ---------------------------------------------------- MolePositions: the small guards */

    function test_openRefusesZeroLiquidity() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, 120, 60_000, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        m.whitelistPool(key);
        // Without this a position id would be minted and PositionOpened emitted with nothing behind it.
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.open(key, -600, 600, 0, type(uint256).max, type(uint256).max, block.timestamp + 1);
        assertEq(m.positionCount(), 0, "a zero-liquidity position was created");
    }

    /// @notice A token that returns `false` instead of reverting must fail the deposit, not silently
    ///         succeed. The NatSpec calls this "a fund-loss bug rather than a style issue" for exactly the
    ///         long-tail assets this vault is meant to list — and nothing tested it.
    function test_aTokenThatReturnsFalseInsteadOfRevertingCannotSilentlySucceed() public {
        FalseReturningToken liar = new FalseReturningToken();
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        (Currency c0, Currency c1) = address(liar) < address(other)
            ? (Currency.wrap(address(liar)), Currency.wrap(address(other)))
            : (Currency.wrap(address(other)), Currency.wrap(address(liar)));

        PoolKey memory k =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(k, SQRT_PRICE_1_1);

        MolePositions m = deployMoleVault(manager, KEEPER, 0, 120, 60_000, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);

        liar.mint(alice, 1_000e18);
        other.mint(alice, 1_000e18);
        vm.startPrank(alice);
        liar.approve(address(m), type(uint256).max);
        other.approve(address(m), type(uint256).max);
        vm.stopPrank();

        // Honest mode first, so the failure below is attributable to the lie and not to the setup.
        vm.prank(alice);
        m.open(k, -600, 600, 1e15, type(uint256).max, type(uint256).max, block.timestamp + 1);
        assertEq(m.positionCount(), 1, "premise failed: the honest open did not work");

        // Now the token starts returning false without reverting.
        liar.setLie(true);
        vm.prank(alice);
        vm.expectRevert(MolePositions.TransferFailed.selector);
        m.open(k, -600, 600, 1e15, type(uint256).max, type(uint256).max, block.timestamp + 1);
        assertEq(m.positionCount(), 1, "a position was minted against a transfer that silently failed");
    }

    /* ----------------------------------------------------- afterInitialize seeds the oracle */

    /// @notice A pool of ours must never exist in an unconfigured state. `afterInitialize` seeds slot 0,
    ///         the clock, the tick and the fee ATOMICALLY with pool creation — an unseeded oracle reads as
    ///         zero elapsed time, which is the divide-by-zero cold start, and an unset dynamic fee would
    ///         make the whole fee path dead code with no revert anywhere.
    /// @dev Asserted at the pool created in setUp, i.e. through the PoolManager rather than by calling the
    ///      hook, so this is what a real initialize actually leaves behind.
    function test_aNewPoolIsFullyConfiguredTheInstantItExists() public view {
        PoolId id = hookKey.toId();
        (uint16 index, uint32 lastTs, uint32 lastObsTs, int24 lastTick, int56 cum, bool init) = hook.poolStates(id);

        assertTrue(init, "the pool was never marked initialized");
        assertEq(index, 0, "the ring did not start at slot 0");
        assertEq(uint256(lastTs), block.timestamp, "the oracle clock was not seeded");
        assertEq(uint256(lastObsTs), block.timestamp, "the observation clock was not seeded");
        assertEq(cum, int56(0), "the cumulative did not start at zero");
        assertEq(lastTick, 0, "the seeded tick is not the pool's opening tick");

        // Slot 0 must actually hold a readable observation, or consult's backward scan finds nothing.
        (uint32 obsTs, int56 obsCum, bool obsInit) = hook.observations(id, 0);
        assertTrue(obsInit, "observation slot 0 was never written");
        assertEq(uint256(obsTs), block.timestamp, "slot 0 carries the wrong timestamp");
        assertEq(obsCum, int56(0), "slot 0 carries a non-zero opening cumulative");

        // And the dynamic fee is live ON THE POOL. Read from the PoolManager's own slot0, not from the
        // hook's `currentFee` getter — that getter ignores the PoolId it is handed and just returns the
        // immutable, so it would report the right number even if the pool had never been primed at all.
        (,,, uint24 lpFee) = StateLibrary.getSlot0(manager, id);
        assertEq(uint256(lpFee), uint256(LP_FEE), "the pool's LP fee was never primed on the PoolManager");
    }

    /// @notice Seeding is a FULL reset, not a partial one. Every field of PoolState is written, so a pool
    ///         can never come up carrying half of some previous state.
    /// @dev THE HONEST CAVEAT: this state is not reachable through the PoolManager. `initialize` reverts on
    ///      an already-initialised pool, and on a genuinely fresh PoolId the storage is already zero, so
    ///      `s.index = 0` is a no-op that no ordinary test can kill — a mutation audit deleting that line
    ///      leaves every other test green, and this one is written knowing that. It is still worth pinning:
    ///      a PARTIAL reset (ring index kept while the cumulative is zeroed) is a corrupt oracle rather than
    ///      a fresh one, so this asserts the semantics the line exists for by driving the callback as the
    ///      PoolManager itself against a pool whose ring has already advanced. If v4 ever gains a re-init
    ///      path, or the seeding block is refactored, this is what notices.
    function test_seedingIsAFullResetRatherThanAPartialOne() public {
        PoolId id = hookKey.toId();

        // Advance the ring so there IS previous state to inherit. TWO swaps, not one: the pool opens at
        // tick 0 and the cumulative grows by `elapsed * lastTick`, so until the tick has actually MOVED
        // the accumulator stays at zero and this test would be asserting a reset of nothing.
        //
        // The clock is an explicit accumulator. `vm.warp(block.timestamp + d)` DOES NOT ACCUMULATE when
        // called twice in one call frame — solc caches `block.timestamp`, so the second call warps to the
        // same instant as the first, elapsed is zero and nothing accrues. That trap is why this file's
        // sibling attack suites all carry a `_clock`; it cost this test one debugging round.
        uint256 clock = block.timestamp;
        for (uint256 i; i < 2; ++i) {
            clock += 120;
            vm.warp(clock);
            swapRouter.swap(
                hookKey,
                SwapParams(true, -1e18, MIN_PRICE_LIMIT),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
        }
        (uint16 movedIndex,,,, int56 movedCum,) = hook.poolStates(id);
        assertGt(movedIndex, 0, "premise: the ring never advanced, so there is nothing to reset");
        assertTrue(movedCum != 0, "premise: the cumulative never accumulated");

        vm.prank(address(manager));
        hook.afterInitialize(address(this), hookKey, SQRT_PRICE_1_1, 0);

        (uint16 index, uint32 lastTs,,, int56 cum, bool init) = hook.poolStates(id);
        assertEq(index, 0, "the ring index survived a reseed -- the reset is PARTIAL, not full");
        assertEq(cum, int56(0), "the cumulative survived a reseed");
        assertEq(uint256(lastTs), block.timestamp, "the clock was not reseeded");
        assertTrue(init, "the pool came out of a reseed uninitialized");
    }

    /* ------------------------------------------ MolePositions constructor: the rest of it */

    /// @notice The remaining constructor requires. Each one turns a nonsensical immutable into a failed
    ///         deploy rather than a live contract, and every one of them could be deleted with the suite
    ///         still green. The `_maxTwapDeviationTicks > 0` case is the one that matters most: a TWAP
    ///         bound with no oracle behind it reads as protection that is not there.
    function test_constructorRefusesNonsensicalImmutables() public {
        // Range bounds: a zero minimum admits any width, and a max below the min admits nothing.
        vm.expectRevert(MolePositions.BadRangeBounds.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 0, 60_000, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));

        vm.expectRevert(MolePositions.BadRangeBounds.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 600, 120, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));

        // An ejection cap above 100% is not a cap.
        vm.expectRevert(MolePositions.BadEjectionCap.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, address(0), 0, 0, 0, 0, 10_001, 0, 0, address(0));

        // A negative recenter cap would compare as "further than any move", i.e. refuse everything.
        vm.expectRevert(MolePositions.BadRecenterCap.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, address(0), 0, 0, 0, 0, 10_000, -1, 0, address(0));

        vm.expectRevert(MolePositions.BadTwapDeviation.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, address(0), -1, 1800, 0, 0, 10_000, 0, 0, address(0));

        // A TWAP band with no oracle to read: refused whether the hook is missing or the window is zero.
        vm.expectRevert(MolePositions.TwapBoundNeedsAnOracle.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, address(0), 600, 1800, 0, 0, 10_000, 0, 0, address(0));

        vm.expectRevert(MolePositions.TwapBoundNeedsAnOracle.selector);
        _moleDeployer.vault(manager, KEEPER, 0, 120, 60_000, address(hook), 600, 0, 0, 0, 10_000, 0, 0, address(0));

        // ...and the same bound WITH both an oracle and a window deploys, so these are filters and not a
        // blanket refusal of the TWAP feature.
        MolePositions ok =
            deployMoleVault(manager, KEEPER, 0, 120, 60_000, address(hook), 600, 1800, 0, 0, 10_000, 600, 0, address(0));
        assertEq(ok.maxTwapDeviationTicks(), 600, "a fully specified TWAP bound was refused");
    }

    /* --------------------------------------------------------------- consult() fails closed */

    /// @notice `consult` must revert rather than answer, on all three of its refusal paths. A TWAP view
    ///         that returns a confident wrong number is worse than one that reverts: MolePositions uses it
    ///         as the anchor for `maxTwapDeviationTicks`, so a garbage mean silently relocates the band a
    ///         keeper is checked against.
    function test_consultRefusesRatherThanAnsweringWhenItCannot() public {
        PoolId liveId = hookKey.toId();

        // A pool this hook has never seen. Without the guard, the zeroed PoolState reads as a real one.
        PoolKey memory strangerKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
        vm.expectRevert(MoleHook.PoolNotInitialized.selector);
        hook.consult(strangerKey.toId(), 600);

        // A zero window is a division by zero one line later.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(liveId, 0);

        // A window reaching back before the chain began wraps unchecked arithmetic into a huge target,
        // which the backward scan would satisfy with the NEWEST observation and call a mean.
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(liveId, uint32(block.timestamp) + 1);
    }

    /* ------------------------------------------------- the oracle's only external signal */

    /// @notice `ObservationWritten` is the sole way an off-chain consumer knows the ring advanced, and no
    ///         test asserted it — it could have been deleted, or emitted with the wrong index, silently.
    ///         The index matters specifically: it is what a consumer would use to read the slot back, so
    ///         an off-by-one here misreports which observation was written without any on-chain symptom.
    function test_theRingAdvanceIsAnnouncedWithTheSlotItActuallyWrote() public {
        PoolId id = hookKey.toId();
        (uint16 idxBefore,,,,,) = hook.poolStates(id);

        // Past the 60s observation interval, so this swap must advance the ring rather than only
        // accumulating into it.
        vm.warp(block.timestamp + 120);

        vm.expectEmit(true, false, false, false, address(hook));
        emit MoleHook.ObservationWritten(id, 0, 0); // index/cumulative checked below, not by the matcher
        swapRouter.swap(
            hookKey,
            SwapParams(true, -1e18, MIN_PRICE_LIMIT),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );

        (uint16 idxAfter,,,, int56 cumAfter,) = hook.poolStates(id);
        assertEq(idxAfter, idxBefore + 1, "the ring did not advance by exactly one slot");

        // The announced slot is the slot that actually holds the new observation.
        (uint32 obsTs, int56 obsCum, bool obsInit) = hook.observations(id, idxAfter);
        assertTrue(obsInit, "the announced slot was never initialised");
        assertEq(obsCum, cumAfter, "the announced slot does not hold the cumulative the state reports");
        assertEq(uint256(obsTs), block.timestamp, "the announced slot carries the wrong timestamp");
    }

    /* --------------------------------------------------------------- DeployConfig rules */

    function _valid() internal pure returns (DeployConfig.Params memory p) {
        p = DeployConfig.Params({
            lpFeePips: 3000,
            obsInterval: 60,
            hookFeePips: 0,
            feeRecipient: address(0),
            restrictedLiquidity: false,
            minRebalanceInterval: 1 days,
            minRangeWidth: 120,
            maxRangeWidth: 60_000,
            maxTwapDeviationTicks: 600,
            twapWindow: 1800,
            minDwellL1Blocks: 300,
            maxRebalancesPerL1Block: 10,
            maxEjectionBps: 10_000,
            maxRecenterTicks: 600, performanceFeeBps: 0});
    }

    function validate(DeployConfig.Params memory p) external pure {
        DeployConfig.validate(p);
    }

    /// @dev `reason` is the EXACT require string the rule under test emits, not free-form prose. A bare
    ///      "something reverted" check is worth very little here: `validate` has sixteen rules over one
    ///      struct, so a config built to break rule A usually breaks rule B too, and the assertion then
    ///      passes while rule A is dead. Mutation testing caught exactly that three times in this file —
    ///      the hook-fee ceiling, the observation interval and the range-width ordering could each be
    ///      deleted with this test still green, because a neighbouring rule was doing the rejecting.
    function _expectRejected(DeployConfig.Params memory p, string memory reason) internal {
        try this.validate(p) {
            revert(string.concat("DeployConfig accepted a config it must refuse: ", reason));
        } catch Error(string memory got) {
            assertEq(got, reason, "rejected, but by a different rule than the one under test");
        } catch {
            revert(string.concat("expected a require string, got a bare revert: ", reason));
        }
    }

    /// @notice Every rule in the shared deployment library, exercised. A mutation audit found 12 of its 13
    ///         rules could be deleted with the whole suite still green — the library that decides every
    ///         immutable on this system was effectively untested.
    function test_deployConfigEnforcesEveryRule() public {
        // The valid baseline must pass, or every rejection below proves nothing.
        this.validate(_valid());

        DeployConfig.Params memory p;

        // --- fee shape
        p = _valid(); p.lpFeePips = 0;
        _expectRejected(p, "cfg: zero fee lets arbitrage reprice the pool for free");

        p = _valid(); p.lpFeePips = 100_001;
        _expectRejected(p, "cfg: lp fee above the hard ceiling");

        // The recipient must be set, or the NEXT rule does the rejecting and this one goes untested.
        p = _valid(); p.hookFeePips = 10_001; p.feeRecipient = treasury;
        _expectRejected(p, "cfg: hook fee above 1%");

        p = _valid(); p.hookFeePips = 5_000; p.feeRecipient = address(0);
        _expectRejected(p, "cfg: hook fee with no recipient");

        // --- oracle shape. The TWAP band must be off, or the ring-coverage rule rejects first:
        // `twapWindow <= obsInterval * 255` is `1800 <= 0` once the interval is zero.
        p = _valid(); p.obsInterval = 0; p.maxTwapDeviationTicks = 0;
        _expectRejected(p, "cfg: zero observation interval exhausts the ring for the price of dust");

        // --- keeper shape
        p = _valid(); p.minRangeWidth = 0;
        _expectRejected(p, "cfg: zero minimum range width");

        // Both width-derived caps must be pulled under the new max, or they reject first.
        p = _valid(); p.maxRangeWidth = 60; p.maxRecenterTicks = 60; p.maxTwapDeviationTicks = 60;
        _expectRejected(p, "cfg: max range width below min");

        p = _valid(); p.maxTwapDeviationTicks = -1;
        _expectRejected(p, "cfg: negative twap deviation");

        p = _valid(); p.maxEjectionBps = 10_001;
        _expectRejected(p, "cfg: ejection cap above 100%");

        p = _valid(); p.maxRecenterTicks = -1;
        _expectRejected(p, "cfg: negative recenter cap");

        p = _valid(); p.maxRecenterTicks = 60_001;
        _expectRejected(p, "cfg: recenter cap wider than the max range width");

        p = _valid(); p.maxTwapDeviationTicks = 60_001;
        _expectRejected(p, "cfg: twap band wider than the max range width");

        p = _valid(); p.minRebalanceInterval = 59 minutes;
        _expectRejected(p, "cfg: cadence below the backtested floor");

        p = _valid(); p.twapWindow = 60;
        _expectRejected(p, "cfg: twap window too short for the ring");

        p = _valid(); p.twapWindow = 60 * 256;
        _expectRejected(p, "cfg: twap window exceeds what the ring can cover (255 gaps)");

        // The trade this system must never ship unpaired: vault-only liquidity makes the oracle cheap to
        // walk, so it requires the price-independent bound that survives a walked oracle.
        p = _valid(); p.restrictedLiquidity = true; p.maxRecenterTicks = 0;
        _expectRejected(p, "cfg: restrictedLiquidity without a recenter cap - the oracle becomes walkable and unbounded");

        // ...and the same config WITH the recenter cap is fine, so the rule is a pairing and not a ban.
        p = _valid(); p.restrictedLiquidity = true;
        this.validate(p);
    }
}
