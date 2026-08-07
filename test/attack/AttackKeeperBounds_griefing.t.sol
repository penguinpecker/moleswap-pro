// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice GRIEFING: the four new keeper bounds, attacked as WEAPONS rather than as protections.
///
/// A bound that a stranger can burn, saturate or brick is not a safety limit, it is a denial-of-service
/// primitive that ships with the product. And a bound that can ever stand between a user and their own
/// tokens is worse than no bound at all, because the custody claim ("a compromised keeper can degrade
/// returns but CANNOT take a token") is only worth anything if the exit is unconditional.
///
/// So this file asks four questions, in order of how much they would cost if the answer were wrong:
///
///   1. Can anything but the keeper spend or block the GLOBAL BUDGET?
///   2. Can a user starve the budget, or make a keeper transaction burn allowance it never used?
///   3. Can the TWAP bound be driven into a state where rebalancing is permanently impossible?
///   4. Can ANY hostile state — budget gone, dwell unmet, oracle reverting, hook refusing — block an exit?
///
/// Question 3 has a real answer, and it is in `test_ringSaturation_*`.
contract AttackKeeperBoundsGriefingTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal mallory = makeAddr("mallory");
    address internal treasury = makeAddr("treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;

    /// @dev The deployed defaults, from script/Deploy.s.sol.
    uint32 internal constant OBS_INTERVAL = 60;
    uint16 internal constant RING = 256;

    uint256 internal _clock;
    uint256 internal _height;

    /// @dev Warps AND rolls, through accumulators. `vm.warp(block.timestamp + d)` does not accumulate in a
    ///      loop (solc caches the environment read inside a call frame) and `vm.roll(block.number + n)` has
    ///      been measured rolling the chain BACKWARDS. Both traps have already cost this project real time.
    function _advance(uint256 secs, uint256 blocks) internal {
        _clock += secs;
        _height += blocks;
        vm.warp(_clock);
        vm.roll(_height);
    }

    function setUp() public {
        _clock = block.timestamp;
        _height = block.number;
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        _fund(alice);
        _fund(bob);
        _fund(carol);
        _fund(mallory);
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 1_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _open(MolePositions m, PoolKey memory k, address who, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = m.open(k, -600, 600, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("griefbounds", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    /// @dev A pool carrying a real MoleHook, seeded with base liquidity.
    ///
    ///      `restricted` is chosen PER TEST, not inherited from the deployment. This comment used to claim
    ///      it mirrored the deployed default and that the default was true; both halves were wrong. The
    ///      shipped default is `DeployConfig.DEFAULT_RESTRICTED_LIQUIDITY == false`, and it was changed to
    ///      false deliberately: vault-only liquidity does not prevent JIT (the hook is handed the vault's
    ///      address, never the depositor's) and it creates zero-liquidity regions, which is precisely what
    ///      made the oracle cheap to walk in the critical finding. Tests that pass `true` here are probing
    ///      that riskier mode on purpose, so they must not be read as describing the deployment.
    function validateCfg(DeployConfig.Params memory p) external pure {
        DeployConfig.validate(p);
    }

    function _hookWorld(uint256 seed, bool restricted, uint32 obsInterval)
        internal
        returns (MoleHook h, PoolKey memory k)
    {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), uint24(3000), obsInterval, restricted, uint24(0), treasury, address(this)),
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
        if (restricted) h.setLiquidityAllowed(address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
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

    /// @dev v4-core wraps a reverting hook callback, so the raw error never reaches the caller. Expect the
    ///      wrapper explicitly rather than a bare `vm.expectRevert()`, which would pass on ANY revert and
    ///      would let a withdrawal-blocking bug hide behind a test that looks green.
    function _expectAddLiquidityRefusedByHook(address hookAddr) internal {
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                hookAddr,
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
    }

    function _bal(address who) internal view returns (uint256, uint256) {
        return (
            MockERC20(Currency.unwrap(currency0)).balanceOf(who),
            MockERC20(Currency.unwrap(currency1)).balanceOf(who)
        );
    }

    /* ===================================================================================================
                             1. CAN ANYONE BUT THE KEEPER SPEND THE GLOBAL BUDGET?
       =================================================================================================== */

    /// @notice The budget is a shared, per-L1-block allowance for the WHOLE book. If a stranger could spend
    ///         it, one attacker could keep the keeper permanently at zero for the price of gas — the bound
    ///         would be a DoS switch handed to the public.
    function test_globalBudgetCannotBeSpentByAnyoneButTheKeeper() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 1, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        _approve(mallory, address(m));
        uint256 victim = _open(m, key, alice, 1e18);
        uint256 attacker = _open(m, key, mallory, 1e18);

        // Every non-keeper caller we can construct, including the position's own owner and the PoolManager.
        address[5] memory outsiders =
            [mallory, alice, address(manager), address(this), address(0xdead)];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(MolePositions.NotKeeper.selector);
            m.rebalance(attacker, -540, 660);
        }

        // Not one wei of allowance was consumed by any of them.
        assertEq(m.rebalancesUsedInL1Block(block.number), 0, "an outsider moved the budget counter");

        // ...and the keeper's single slot for this L1 block is still there for the honest user.
        vm.prank(KEEPER);
        m.rebalance(victim, -540, 660);
        assertEq(m.getPosition(victim).tickLower, -540, "the keeper lost its own budget to an outsider");
    }

    /// @notice A keeper transaction that REVERTS must not consume allowance. Otherwise anyone who can make a
    ///         keeper call fail — trivially, by front-running it with a withdrawal of the very position being
    ///         rebalanced — could burn the whole book's budget every L1 block without touching the keeper key.
    function test_aFrontRunThatMakesTheKeeperRevertDoesNotBurnTheBudget() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 1, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        _approve(bob, address(m));
        uint256 a = _open(m, key, alice, 1e18);
        uint256 b = _open(m, key, bob, 1e18);

        // THE RACE: alice exits in front of the keeper's rebalance of her own position.
        vm.prank(alice);
        m.withdrawAll(a);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.rebalance(a, -540, 660);

        // An out-of-bounds range is the other way to force a keeper revert after the budget line.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RangeWidthOutOfBounds.selector);
        m.rebalance(b, -600, 600 + MAX_W);

        assertEq(m.rebalancesUsedInL1Block(block.number), 0, "a reverted rebalance burned budget");

        // Bob's position is still servable in the SAME L1 block: the grief cost the keeper gas, not capacity.
        vm.prank(KEEPER);
        m.rebalance(b, -540, 660);
        assertEq(m.getPosition(b).tickLower, -540, "the failed calls consumed the block's only slot");
    }

    /// @notice Position creation is permissionless and unmetered. If opening positions moved the budget
    ///         counter — or if the keeper were forced to spend allowance on them — a spammer could starve
    ///         every real user. It does not, because the keeper CHOOSES the id it spends each slot on.
    function test_positionSpamCannotStarveTheBudgetOfHonestUsers() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 2, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        _approve(mallory, address(m));

        uint256 victim = _open(m, key, alice, 1e18);

        // 40 dust positions from one attacker, in the same L1 block the keeper wants to work in.
        for (uint256 i = 0; i < 40; i++) {
            _open(m, key, mallory, 1e12);
        }
        assertEq(m.positionCount(), 41, "spam premise failed");
        assertEq(m.rebalancesUsedInL1Block(block.number), 0, "open() spent rebalance budget");

        // The keeper's allowance is untouched and it is free to spend it on the honest position first.
        vm.prank(KEEPER);
        m.rebalance(victim, -540, 660);
        assertEq(m.getPosition(victim).tickLower, -540, "spam blocked service of an honest position");
        assertEq(m.rebalancesUsedInL1Block(block.number), 1, "budget accounting drifted under spam");
    }

    /* ===================================================================================================
                        2. CAN THE TWAP BOUND BE TURNED INTO A PERMANENT OUTAGE?
       =================================================================================================== */

    /// @notice THE FINDING. `consult` answers from a 256-entry ring written at most once per
    ///         `minObservationInterval`. Once the ring has rolled, the OLDEST surviving observation is
    ///         255 intervals back, not 256 — so the longest window that is still covered at the instant a
    ///         write lands is `255 * interval`. Deploy.s.sol allows `twapWindow <= interval * 256`.
    ///
    ///         At that boundary the vault deploys, works for hours, and then goes permanently dead the
    ///         moment the ring wraps — and ANY address can force and hold that state with one dust swap per
    ///         observation interval. Both `twapWindow` and the hook address are immutable, so recovery is a
    ///         redeploy plus a position migration, not a config change.
    /// @notice REGRESSION. The ring genuinely covers only RING-1 gaps, and a window of RING*interval
    ///         does brick rebalancing once the ring rolls — that half is unchanged and still asserted
    ///         below. What changed is that script/Deploy.s.sol no longer ACCEPTS such a window: the
    ///         ceiling was off by one interval and is now `interval * (RING - 1)`. So this is a config
    ///         that can still be constructed by hand, and can no longer be shipped by the deploy path.
    function test_ringSaturationBricksRebalancingAtTheWindowDeployAllows() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(11, false, OBS_INTERVAL);

        // Exactly the window script/Deploy.s.sol accepts as its maximum: interval * 256.
        uint32 windowDeployAllows = OBS_INTERVAL * uint32(RING);
        // The deploy path now REFUSES this window — that is the fix. Asserted through the real shared
        // rules rather than a copy, so this cannot drift back.
        DeployConfig.Params memory cfg = DeployConfig.Params({
            lpFeePips: 3000, obsInterval: OBS_INTERVAL, hookFeePips: 0, feeRecipient: address(0),
            minRebalanceInterval: 1 days, minRangeWidth: 120, maxRangeWidth: 60_000,
            maxTwapDeviationTicks: 600, twapWindow: windowDeployAllows,
            minDwellL1Blocks: 300, maxRebalancesPerL1Block: 10, maxEjectionBps: 10_000, maxRecenterTicks: 600, restrictedLiquidity: false, performanceFeeBps: 0});
        try this.validateCfg(cfg) {
            revert("Deploy.s.sol still accepts a window the ring cannot cover");
        } catch Error(string memory reason) {
            // Pinned to the ceiling's OWN reason: a config rejected for some unrelated rule would mean
            // this boundary regressed while the test stayed green.
            assertEq(
                reason,
                "cfg: twap window exceeds what the ring can cover (255 gaps)",
                "validate rejected the window, but not because of the ring ceiling"
            );
        }
        // ...and one interval less, which is what the ring can actually cover.
        uint32 windowRingCovers = OBS_INTERVAL * uint32(RING - 1);
        cfg.twapWindow = windowRingCovers;
        this.validateCfg(cfg); // the boundary is exact: one interval tighter is deployable

        MolePositions mBricked =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, windowDeployAllows, 0, 0, 10_000, 0, 0, address(0));
        MolePositions mSafe =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, windowRingCovers, 0, 0, 10_000, 0, 0, address(0));
        mBricked.whitelistPool(k);
        mSafe.whitelistPool(k);
        _approve(alice, address(mBricked));
        _approve(bob, address(mSafe));
        uint256 idBricked = _open(mBricked, k, alice, 1e18);
        uint256 idSafe = _open(mSafe, k, bob, 1e18);

        // Warm up honestly first: after `window` seconds the seed observation alone covers the window, so
        // BOTH vaults are healthy. This is the state an operator would sign off on.
        for (uint256 i = 0; i < 4; i++) {
            _advance(uint256(windowDeployAllows) / 4 + 1, 5);
            _swapOn(k, i % 2 == 0, 1e12);
        }
        h.consult(k.toId(), windowDeployAllows); // does not revert: the deployment looks fine
        vm.prank(KEEPER);
        mBricked.rebalance(idBricked, -540, 660);
        assertEq(mBricked.getPosition(idBricked).tickLower, -540, "premise: vault was not healthy pre-attack");

        // THE ATTACK: one dust swap per observation interval, from an ordinary address, until the ring has
        // rolled past the seed. 260 swaps of 1e12 wei. No privilege, no capital at risk, no price impact.
        for (uint256 i = 0; i < 260; i++) {
            _advance(OBS_INTERVAL, 5);
            _swapOn(k, i % 2 == 0, 1e12);
        }

        // The ring now spans exactly 255 intervals, so the deployable window is no longer covered...
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(k.toId(), windowDeployAllows);
        // ...nor is ANY window above 255 intervals, so the whole band Deploy.s.sol opens up is dead...
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(k.toId(), windowRingCovers + 1);
        // ...while 255 intervals exactly still answers, which pins the off-by-one to the second.
        h.consult(k.toId(), windowRingCovers);

        // Consequence: the keeper cannot rebalance ANY position in this pool, and fails on the oracle, not
        // on any keeper misbehaviour.
        vm.prank(KEEPER);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        mBricked.rebalance(idBricked, -600, 600);

        // The sibling vault, deployed one interval tighter, keeps working through the identical attack.
        vm.prank(KEEPER);
        mSafe.rebalance(idSafe, -540, 660);
        assertEq(mSafe.getPosition(idSafe).tickLower, -540, "control vault also died: the bound is not the cause");

        // And the attacker can HOLD it: every further dust swap re-arms the same condition. Note what this
        // means without an attacker at all — a pool that simply TRADES at least once per observation
        // interval can never be rebalanced. The busier the pool, the more permanent the outage.
        for (uint256 i = 0; i < 5; i++) {
            _advance(OBS_INTERVAL, 5);
            _swapOn(k, i % 2 == 0, 1e12);
            vm.prank(KEEPER);
            vm.expectRevert(MoleHook.InsufficientObservations.selector);
            mBricked.rebalance(idBricked, -600, 600);
        }

        // The grief is sustained, not sticky: one quiet interval and the window is covered again. That is
        // what makes this cheap to hold (one dust swap a minute) and what makes an organically busy pool
        // the worst case rather than the safe case.
        _advance(OBS_INTERVAL + 1, 5);
        h.consult(k.toId(), windowDeployAllows);
        vm.prank(KEEPER);
        mBricked.rebalance(idBricked, -600, 600);
        assertEq(mBricked.getPosition(idBricked).tickLower, -600, "premise: recovery-on-idle is not the mechanism");

        // THE ONE THING THAT MUST SURVIVE: the outage is a returns problem, never a custody problem.
        (uint256 b0,) = _bal(alice);
        vm.prank(alice);
        mBricked.withdrawAll(idBricked);
        assertEq(mBricked.getPosition(idBricked).liquidity, 0, "exit blocked while the oracle was bricked");
        (uint256 a0,) = _bal(alice);
        assertGt(a0, b0, "bricked-oracle exit paid nothing");
    }

    /// @notice The same attack against the DEPLOYED DEFAULT (window 1800s, interval 60s) is impotent: the
    ///         ring covers 15,300s and the write gate means an attacker cannot compress it. Recorded so the
    ///         finding above reads as a boundary bug in the deploy guard, not a general oracle weakness.
    function test_ringSaturationCannotBrickTheDefaultWindow() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(12, false, OBS_INTERVAL);
        uint32 defaultWindow = 1800; // MOLE_TWAP_WINDOW default

        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, defaultWindow, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        uint256 id = _open(m, k, alice, 1e18);

        // Same 260 dust swaps at the fastest cadence the oracle will record.
        for (uint256 i = 0; i < 260; i++) {
            _advance(OBS_INTERVAL, 5);
            _swapOn(k, i % 2 == 0, 1e12);
        }

        int24 twap = h.consult(k.toId(), defaultWindow); // answers
        int24 lo = ((twap - 300) / SPACING) * SPACING;
        vm.prank(KEEPER);
        m.rebalance(id, lo, lo + 600);
        assertEq(m.getPosition(id).tickLower, lo, "default-window vault was bricked by ring saturation");
    }

    /// @notice Can an attacker push the pool somewhere the TWAP bound can never be satisfied? No: the bound
    ///         is on the NEW RANGE's midpoint against the TWAP, and a spacing-legal, width-legal range
    ///         centred on the TWAP always exists at the deployed tick spacing. A violent price move costs
    ///         the keeper the ability to chase SPOT, which is exactly what the bound is for, not the ability
    ///         to act at all.
    function test_aViolentPriceMoveCannotBrickRebalancing() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(13, false, OBS_INTERVAL);
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, 300, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        uint256 id = _open(m, k, alice, 1e18);

        for (uint256 i = 0; i < 6; i++) {
            _advance(61, 5);
            _swapOn(k, i % 2 == 0, 1e15);
        }

        // Mallory dislocates the pool hard and holds it there.
        _swapOn(k, false, 400e18);
        (, int24 spotAfter,,) = StateLibrary.getSlot0(manager, k.toId());
        assertGt(spotAfter, 1200, "premise: the dislocation was too small to matter");

        for (uint256 i = 0; i < 6; i++) {
            _advance(61, 5);
            _swapOn(k, i % 2 == 0, 1e12);
        }

        int24 twap = h.consult(k.toId(), 300);

        // Chasing spot is refused — the bound doing its job.
        int24 spotLo = (spotAfter / SPACING) * SPACING - 300;
        spotLo = (spotLo / SPACING) * SPACING;
        if (spotLo - twap > 600 + 300) {
            vm.prank(KEEPER);
            vm.expectRevert(MolePositions.RangeTooFarFromTwap.selector);
            m.rebalance(id, spotLo, spotLo + 600);
        }

        // But a TWAP-centred range is always available, so the keeper is never frozen out.
        int24 lo = ((twap - 300) / SPACING) * SPACING;
        vm.prank(KEEPER);
        m.rebalance(id, lo, lo + 600);
        assertEq(m.getPosition(id).tickLower, lo, "a TWAP-centred range was refused: the keeper IS frozen out");
    }

    /* ===================================================================================================
                       3. CAN ANY HOSTILE STATE BLOCK AN EXIT?  (the load-bearing claim)
       =================================================================================================== */

    /// @notice THE MAXIMALLY HOSTILE STATE, built with real components and then exited from.
    ///
    ///         Simultaneously true when the withdrawals below run:
    ///           - the global budget for this L1 block is exhausted;
    ///           - a fresh position has not served its dwell;
    ///           - the hook is in restricted mode and the pool creator has REVOKED the vault, so open()
    ///             and every rebalance mint now revert — deposits are dead;
    ///           - the keeper cannot act on any position by any route.
    ///         Every exit must still work, including for the position that can never be rebalanced.
    function test_exitsSurviveBudgetExhaustionDwellRevocationAndADeadKeeper() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(21, true, OBS_INTERVAL);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, 300, 5, 1, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        h.setLiquidityAllowed(address(m), true);
        _approve(alice, address(m));
        _approve(bob, address(m));
        _approve(carol, address(m));

        uint256 idA = _open(m, k, alice, 1e18);
        uint256 idB = _open(m, k, bob, 1e18);

        // Warm the oracle past the 300s window and past the 5-block dwell for A and B.
        for (uint256 i = 0; i < 6; i++) {
            _advance(61, 5);
            _swapOn(k, i % 2 == 0, 1e15);
        }

        // A fresh position that has NOT served its dwell.
        uint256 idC = _open(m, k, carol, 1e18);

        // Burn the block's only budget slot on B.
        int24 twap = h.consult(k.toId(), 300);
        int24 lo = ((twap - 300) / SPACING) * SPACING;
        vm.prank(KEEPER);
        m.rebalance(idB, lo, lo + 600);
        assertEq(m.rebalancesUsedInL1Block(block.number), 1, "premise: budget was not spent");

        // The pool creator revokes the vault: the JIT switch, applied to our own vault.
        h.setLiquidityAllowed(address(m), false);

        // ---- prove the state really is hostile, by its own named errors ----
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RebalanceBudgetExhausted.selector);
        m.rebalance(idA, lo, lo + 600);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        m.rebalance(idC, lo, lo + 600);

        _expectAddLiquidityRefusedByHook(address(h));
        vm.prank(alice);
        m.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        // Next L1 block: budget resets, dwell for C still unmet, and the keeper now dies on the mint.
        _advance(12, 1);
        _expectAddLiquidityRefusedByHook(address(h));
        vm.prank(KEEPER);
        m.rebalance(idA, lo, lo + 600);

        // ---- and now the only thing that matters: everyone gets out ----
        (uint256 a0Before, uint256 a1Before) = _bal(alice);
        uint128 half = m.getPosition(idA).liquidity / 2;
        vm.prank(alice);
        m.withdraw(idA, half); // partial exit, the public function
        vm.prank(alice);
        m.withdrawAll(idA); // and the remainder
        (uint256 a0After, uint256 a1After) = _bal(alice);
        assertEq(m.getPosition(idA).liquidity, 0, "alice could not fully exit");
        assertGt(a0After + a1After, a0Before + a1Before, "alice's exit paid nothing");

        vm.prank(bob);
        m.withdrawAll(idB);
        assertEq(m.getPosition(idB).liquidity, 0, "bob (rebalanced) could not exit");

        // Carol has NEVER been rebalanceable and never will be in this state. She still exits.
        (uint256 c0Before, uint256 c1Before) = _bal(carol);
        vm.prank(carol);
        m.withdrawAll(idC);
        (uint256 c0After, uint256 c1After) = _bal(carol);
        assertEq(m.getPosition(idC).liquidity, 0, "the dwell guard blocked a withdrawal");
        assertGt(c0After + c1After, c0Before + c1Before, "carol's exit paid nothing");

        // The custody core never holds an inventory, even on the way out of a hostile state.
        (uint256 stuck0, uint256 stuck1) = _bal(address(m));
        assertEq(stuck0, 0, "vault retained currency0 after hostile-state exits");
        assertEq(stuck1, 0, "vault retained currency1 after hostile-state exits");
    }

    /// @notice A reverting oracle must not reach the exit. The pool here is far younger than the window, so
    ///         `consult` reverts and every rebalance fails closed — the designed behaviour. Withdrawals are
    ///         on a code path that never consults anything, and this pins that.
    function test_exitsWorkWhileTheOracleItselfReverts() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(22, true, OBS_INTERVAL);
        MolePositions m =
            deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 600, 1 hours, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        h.setLiquidityAllowed(address(m), true);
        _approve(alice, address(m));
        _approve(bob, address(m));
        uint256 idA = _open(m, k, alice, 1e18);
        uint256 idB = _open(m, k, bob, 1e18);

        _advance(61, 5);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        h.consult(k.toId(), 1 hours);

        vm.prank(KEEPER);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        m.rebalance(idA, -540, 660);

        (uint256 b0,) = _bal(alice);
        uint128 third = m.getPosition(idA).liquidity / 3;
        vm.prank(alice);
        m.withdraw(idA, third);
        vm.prank(alice);
        m.withdrawAll(idA);
        (uint256 a0,) = _bal(alice);
        assertEq(m.getPosition(idA).liquidity, 0, "cold oracle blocked an exit");
        assertGt(a0, b0, "cold-oracle exit paid nothing");

        vm.prank(bob);
        m.withdrawAll(idB);
        assertEq(m.getPosition(idB).liquidity, 0, "cold oracle blocked a second exit");
    }

    /// @notice Exhausting the budget every L1 block for a long stretch must not accumulate into anything that
    ///         touches an exit. Ten consecutive saturated L1 blocks, then a withdrawal.
    function test_sustainedBudgetExhaustionNeverReachesAWithdrawal() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 1, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        _approve(mallory, address(m));
        uint256 victim = _open(m, key, alice, 1e18);
        uint256 filler = _open(m, key, mallory, 1e18);

        for (uint256 i = 0; i < 10; i++) {
            _advance(12, 1);
            vm.prank(KEEPER);
            m.rebalance(filler, -540, 660);
            vm.prank(KEEPER);
            vm.expectRevert(MolePositions.RebalanceBudgetExhausted.selector);
            m.rebalance(victim, -540, 660);
            assertEq(m.rebalancesUsedInL1Block(block.number), 1, "budget accounting drifted");
        }

        (uint256 b0,) = _bal(alice);
        vm.prank(alice);
        m.withdrawAll(victim);
        (uint256 a0,) = _bal(alice);
        assertEq(m.getPosition(victim).liquidity, 0, "sustained budget exhaustion blocked an exit");
        assertGt(a0, b0, "exit under a saturated budget paid nothing");
    }

    /* ===================================================================================================
                        4. DID withdrawAll CHANGE ANY PERMISSION? (withdraw went public)
       =================================================================================================== */

    /// @notice `withdraw` went from external to public so `withdrawAll` could call it. Public is still
    ///         externally callable, so the owner check has to carry the same weight it did before — against
    ///         the keeper, the hook, the PoolManager, the vault itself and any stranger, on BOTH entry
    ///         points, and on a position whose liquidity number was changed by a rebalance in between.
    function test_bothExitsRemainOwnerOnlyAgainstEveryPrivilegedParty() public {
        (MoleHook h, PoolKey memory k) = _hookWorld(31, false, OBS_INTERVAL);
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(h), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(k);
        _approve(alice, address(m));
        uint256 id = _open(m, k, alice, 1e18);

        // The keeper reshapes the position first: ownership must be untouched by its one power.
        vm.prank(KEEPER);
        m.rebalance(id, -300, 300);
        assertEq(m.ownerOf(id), alice, "rebalance changed the payout target");

        // Hoisted deliberately: reading it inside the pranked call would consume the prank on the view.
        uint128 whole = m.getPosition(id).liquidity;

        address[6] memory outsiders =
            [KEEPER, address(h), address(manager), address(m), mallory, address(this)];
        for (uint256 i = 0; i < outsiders.length; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(MolePositions.NotOwner.selector);
            m.withdrawAll(id);

            vm.prank(outsiders[i]);
            vm.expectRevert(MolePositions.NotOwner.selector);
            m.withdraw(id, 1);

            vm.prank(outsiders[i]);
            vm.expectRevert(MolePositions.NotOwner.selector);
            m.withdraw(id, whole);
        }

        assertEq(m.getPosition(id).liquidity, whole, "an outsider moved the position's liquidity");

        // The owner, and only the owner, can empty it.
        vm.prank(alice);
        m.withdrawAll(id);
        assertEq(m.getPosition(id).liquidity, 0, "the owner could not exit her own position");
    }

    /// @notice `withdrawAll(id)` reads `_positions[id].liquidity` as an argument BEFORE the owner modifier
    ///         runs. Confirm that argument evaluation is not a hole: a stranger cannot use a neighbouring
    ///         id, a burnt id, or an id that does not exist to reach anyone's tokens.
    function test_withdrawAllCannotBeAimedAtANeighbouringOrNonexistentId() public {
        MolePositions m = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        m.whitelistPool(key);
        _approve(alice, address(m));
        _approve(mallory, address(m));
        uint256 idA = _open(m, key, alice, 1e18);
        uint256 idM = _open(m, key, mallory, 1e18);

        (uint256 mal0Before, uint256 mal1Before) = _bal(mallory);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(idA);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(idA + 1000); // never opened

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        m.withdrawAll(0); // the id that is never valid

        // Mallory emptying her own position must not change what alice's id is worth.
        vm.prank(mallory);
        m.withdrawAll(idM);
        (uint256 mal0After, uint256 mal1After) = _bal(mallory);
        assertGt(mal0After + mal1After, mal0Before + mal1Before, "premise: mallory's own exit paid nothing");

        // A burnt id is inert, not a lever.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        m.withdrawAll(idM);

        assertGt(m.getPosition(idA).liquidity, 0, "alice's position was touched by a stranger");
        vm.prank(alice);
        m.withdrawAll(idA);
        assertEq(m.getPosition(idA).liquidity, 0, "alice could not exit after the attempts");
    }
}
