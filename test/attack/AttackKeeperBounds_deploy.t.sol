// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HookMiner} from "v4-periphery/../test/shared/HookMiner.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {DeployConfig} from "../../src/config/DeployConfig.sol";
import {RHChain} from "../../src/config/RHChain.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @dev Stand-in for the canonical Arachnid deterministic deployer. `forge script` turns
///      `new X{salt: s}` into a call to 0x4e59b448..., so the hook address is derived from a factory
///      address that is NOT the caller. Reproducing that here keeps the mined address independent of who
///      signs, which is exactly the property the real deployment has.
contract Create2Factory {
    function deploy(bytes32 salt, bytes memory initcode) external returns (address a) {
        assembly ("memory-safe") {
            a := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        require(a != address(0), "create2 failed");
    }
}

/// @notice ATTACK ANGLE: THE DEPLOY SCRIPT AND THE CONFIGURATION IT PRODUCES.
///
/// script/Deploy.s.sol is the only thing that decides what the keeper bounds actually are on chain, and
/// every one of them is immutable afterwards. So the question is not "does the guard work"
/// (KeeperBounds.t.sol answers that) but "does the guard the script deploys work, and does the script
/// stop an operator deploying one that does not".
///
/// This file rebuilds the shipped deployment locally — real Uniswap v4 PoolManager, real HookMiner, hook
/// deployed through a CREATE2 factory at a mined address, MolePositions pinned to it — and then runs the
/// deployment end to end with the script's own default parameters:
///
///     lpFee 3000 pips FIXED (the volatility-scaled fee was REMOVED, not repaired — the party that
///     collects such a fee is the party that can manufacture the signal behind it, see MoleHook's
///     header), obsInterval 60, restrictedLiquidity FALSE (default changed from true: the allowlist
///     never was a JIT defence, and a sole-LP pool has zero-liquidity regions that make the oracle
///     walkable), hookFee 0, feeRecipient == deployer, minRebalanceInterval 1 day,
///     range width [120, 60000], maxTwapDev 600, twapWindow 1800, minDwellL1Blocks 300,
///     maxRebalancesPerL1Block 10, maxEjectionBps 7500 (residual cap ON as of 2026-08-23; it shipped at
///     10000 = off and that is what F-07 mechanism C exploited), maxRecenterTicks 600,
///     keeper == deployer.
///
/// WHAT HELD (tests D1, D3, D4, D8): the defaults are usable. A user can open and fully withdraw, the
/// keeper can genuinely rebalance once the cadence and dwell have elapsed, the oracle answers a 1800s
/// window exactly 1800s after pool creation with zero swaps, and 1800s sits 8.5x inside the ring's real
/// capacity.
///
/// WHAT BROKE, AND WHERE IT STANDS NOW:
///   D5  REGRESSION (fixed). The script's ring-capacity ceiling was off by one observation interval —
///       a full ring spans 255 gaps, not 256 — so it accepted a window the ring can never cover on a
///       busy pool. DeployConfig now refuses it; the test proves the refusal AND that the true maximum
///       is still deployable, and keeps the live demonstration of what the accepted-boundary deployment
///       used to do to a busy pool.
///   D6  RESHAPED. The finding was "the default keeper key also owns the JIT defence". Two things
///       changed under it: the shipped default is no longer restricted, and the hook's own docs now
///       concede the allowlist never was a JIT defence. What remains true — and is pinned — is that
///       keeper, poolCreator and feeRecipient are ONE key under the defaults, and that the measured
///       JIT diversion now requires NO privileged key at all.
///   D7  REGRESSION (fixed). The script used to narrow-cast env values and range-check only two; an
///       out-of-range value silently deployed with a bound switched OFF. It now range-checks every
///       value at full width before narrowing and demands an explicit acknowledgement for a disabled
///       user-protecting bound.
///
/// TIME: `vm.warp(block.timestamp + d)` and `vm.roll(block.number + n)` do not accumulate inside a call
/// frame. Every loop below uses the explicit `_clock` / `_height` counters and advances both, at the
/// L1 pacing Robinhood Chain actually has (block.number is the ETHEREUM height, ~12s per tick).
contract AttackKeeperBoundsDeploy is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------- script defaults, verbatim */

    /// @dev One fixed LP fee. The six volatility-fee parameters that used to sit here (min/base/max fee,
    ///      sensitivity, window, direction flag) died with the feature they configured.
    uint24 internal constant D_LP_FEE = 3000;
    uint32 internal constant D_OBS_INTERVAL = 60;
    /// @dev Mirrors MOLE_RESTRICTED_LIQUIDITY's default, which the script changed true -> false: the
    ///      allowlist is handed the VAULT's address and never the depositor's, so it never stopped JIT,
    ///      and a sole-LP pool has zero-liquidity regions that make spot (and the oracle) walkable for
    ///      almost nothing. Third-party depth is a security asset here. D2 covers both modes.
    bool internal constant D_RESTRICTED = false;
    uint24 internal constant D_HOOK_FEE = 0;

    uint32 internal constant D_MIN_REBALANCE_INTERVAL = 1 days;
    int24 internal constant D_MIN_W = 120;
    int24 internal constant D_MAX_W = 60_000;
    int24 internal constant D_MAX_TWAP_DEV = 600;
    uint32 internal constant D_TWAP_WINDOW = 1800;
    /// @dev Mirrors MOLE_MIN_DWELL_L1_BLOCKS in script/Deploy.s.sol (raised there 5 -> 300, ~1h of
    ///      ETHEREUM time): the cadence check runs on block.timestamp, a clock the SEQUENCER WRITES, so
    ///      under timestamp manipulation the cadence is satisfiable instantly and this L1-paced dwell is
    ///      the only bound left standing. If this constant and the script ever disagree, these tests stop
    ///      describing the shipped deployment — which is the whole point of them.
    uint64 internal constant D_DWELL = 300;
    uint16 internal constant D_BUDGET = 10;
    /// @dev MOLE_MAX_EJECTION_BPS. READ from DeployConfig rather than restated, which is the rule the rest
    ///      of this file already follows — and the reason it is read now is that the literal here was
    ///      10_000 (OFF) and stayed 10_000 while the shipped default changed. The 2026-08-23 audit named
    ///      the disabled residual cap as the thing that let one legal keeper step eject a whole leg
    ///      (F-07 mechanism C); the default is now 7_500 and this constant follows it by construction.
    uint16 internal constant D_EJECT = DeployConfig.DEFAULT_MAX_EJECTION_BPS;
    /// @dev MOLE_MAX_RECENTER_TICKS default: the price-independent bound on how far one rebalance may
    ///      move a position's midpoint.
    int24 internal constant D_RECENTER = 600;

    int24 internal constant SPACING = 60;

    /// @dev A realistic chain clock; several guards behave differently at timestamp 1.
    uint256 internal constant T0 = 1_750_000_000;
    uint256 internal constant H0 = 21_000_000;

    /* ---------------------------------------------------------------- the actors */

    /// @dev The address that broadcasts the script. Under the shipped defaults it is simultaneously
    ///      poolCreator, keeper and feeRecipient — that identity is the subject of D6.
    address internal DEPLOYER = makeAddr("deployer");
    address internal alice = makeAddr("alice");
    address internal jit = makeAddr("jitBot");

    Create2Factory internal factory;
    MoleHook internal hook;
    MolePositions internal positions;
    PoolKey internal pk;
    PoolId internal pid;

    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        // block.number on RH is the ETHEREUM height: one tick per ~12 real seconds, never per L2 block.
        _height += 1 + secs / 12;
        vm.warp(_clock);
        vm.roll(_height);
    }

    /* ---------------------------------------------------------------- the deploy */

    /// @dev Calls the REAL rules the deploy script uses. This used to be a hand-written copy of three
    ///      of the script's requires, and it drifted twice — once still allowing a TWAP window the
    ///      ring cannot cover after the script was fixed. There is now one implementation and no mirror.
    function _passesScriptRequires(uint32 minRebalanceInterval, uint32 twapWindow_, uint32 obsInterval)
        internal
        view
        returns (bool)
    {
        DeployConfig.Params memory p = DeployConfig.Params({
            lpFeePips: D_LP_FEE,
            obsInterval: obsInterval,
            hookFeePips: D_HOOK_FEE,
            feeRecipient: address(0),
            minRebalanceInterval: minRebalanceInterval,
            minRangeWidth: 120,
            maxRangeWidth: 60_000,
            maxTwapDeviationTicks: 600,
            twapWindow: twapWindow_,
            minDwellL1Blocks: D_DWELL,
            maxRebalancesPerL1Block: 10,
            maxEjectionBps: D_EJECT, maxRecenterTicks: 600, restrictedLiquidity: false, performanceFeeBps: 0});
        try this.validateConfig(p) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev External so the try/catch above can reach the library's reverts.
    function validateConfig(DeployConfig.Params memory p) external pure {
        DeployConfig.validate(p);
    }

    /// @dev Step 1 of the script: mine a salt against the CREATE2 factory, deploy, and re-assert the
    ///      three bitmap properties the script checks after deployment. The constructor is the new
    ///      7-argument shape — the volatility-fee parameters are gone, `lpFeePips` is fixed for life —
    ///      and `feeRecipient` mirrors MOLE_FEE_RECIPIENT's default of the deployer.
    function _mineAndDeployHook(address deployer_, uint32 obsInterval, bool restricted)
        internal
        returns (MoleHook h)
    {
        bytes memory creation = vm.getCode("ERC1967Proxy.sol:ERC1967Proxy");
        bytes memory args = hookProxyArgs(manager, deployer_, D_LP_FEE, obsInterval, restricted, D_HOOK_FEE, deployer_, address(this));
        (address mined, bytes32 salt) =
            HookMiner.find(address(factory), HookPermissions.REQUIRED_FLAGS, creation, args);
        address got = factory.deploy(salt, abi.encodePacked(creation, args));
        require(got == mined, "Deploy: mined address mismatch");
        require(HookPermissions.isValid(got), "Deploy: hook bitmap is not 0x38C4");
        require(HookPermissions.withdrawalIsUnblockable(got), "Deploy: exits would be blockable");
        require(HookPermissions.depositIsUntaxable(got), "Deploy: deposits would be taxable");
        h = MoleHook(got);
    }

    /// @dev Steps 2 and 3 of the script for an arbitrary keeper policy, including the allowlisting the
    ///      script performs when the hook is in restricted mode (a no-op under the shipped default).
    function _deployVault(
        address keeper_,
        uint32 minRebalanceInterval,
        int24 maxTwapDev,
        uint32 twapWindow_,
        uint64 dwell,
        uint16 budget
    ) internal returns (MolePositions m) {
        m = deployMoleVault(
            manager, keeper_, minRebalanceInterval, D_MIN_W, D_MAX_W, address(hook), maxTwapDev,
            twapWindow_, dwell, budget, D_EJECT, D_RECENTER
        , 0, address(0));
        if (hook.restrictedLiquidity()) {
            vm.prank(DEPLOYER);
            hook.setLiquidityAllowed(address(m), true);
        }
    }

    function setUp() public {
        vm.warp(T0);
        vm.roll(H0);
        _clock = T0;
        _height = H0;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        factory = new Create2Factory();

        // The script's own preconditions, on the script's own defaults.
        require(
            _passesScriptRequires(D_MIN_REBALANCE_INTERVAL, D_TWAP_WINDOW, D_OBS_INTERVAL),
            "shipped defaults do not pass the script's own requires"
        );

        hook = _mineAndDeployHook(DEPLOYER, D_OBS_INTERVAL, D_RESTRICTED);
        // MOLE_KEEPER defaults to the deployer. That default is deliberately preserved here.
        positions =
            _deployVault(DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET);

        // NEXT step 1: the pool. Dynamic fee, created by the poolCreator.
        pk = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        pid = pk.toId();
        vm.prank(DEPLOYER);
        manager.initialize(pk, SQRT_PRICE_1_1);

        // NEXT step 2: whitelist it on the custody core (permissionless).
        positions.whitelistPool(pk);

        // NEXT step 2b, which a real deployment cannot skip either: WAIT. `open`/`zapOpen` now gate spot
        // against the oracle (the Arrakis-class fix), and `consult` fails closed until the pool is older
        // than D_TWAP_WINDOW — so the shipped deployment has a 30-minute cold start during which it takes
        // no deposits. That is a real, deliberate property of the defaults this file exists to describe,
        // and it belongs in the world-building step rather than hidden in each test.
        _advance(D_TWAP_WINDOW + 1);

        _fund(alice);
        _fund(jit);
        _approve(alice, address(positions));
    }

    /* ------------------------------------------------------------------- helpers */

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 5_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 5_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _open(MolePositions m, address who, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = m.open(pk, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _bal(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency0)).balanceOf(who)
            + MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, pid);
    }

    /// @dev Push the pool back to exactly SQRT_PRICE_1_1 with a limit-bounded swap, so two runs that
    ///      carried different liquidity can be compared on a like-for-like price. Without this, "tokens
    ///      out" is contaminated by the composition change of a position measured at a different price.
    function _restoreToParity() internal {
        (uint160 sp,,,) = StateLibrary.getSlot0(manager, pid);
        if (sp == SQRT_PRICE_1_1) return;
        bool zeroForOne = sp > SQRT_PRICE_1_1;
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(1_000_000e18),
                sqrtPriceLimitX96: SQRT_PRICE_1_1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev A range of exactly 600 ticks, on spacing, centred as close to `anchor` as spacing allows.
    function _centred(int24 anchor) internal pure returns (int24 lo, int24 hi) {
        lo = ((anchor - 300) / SPACING) * SPACING;
        hi = lo + 600;
    }

    /// @dev A LEGAL keeper step from the +/-30,000 range these tests open: SAME WIDTH, translated toward
    ///      the anchor by at most `D_RECENTER` ticks and rounded onto spacing.
    ///
    ///      `_centred` stopped being a legal step on 2026-08-23, and the reason is worth stating because it
    ///      is a real behaviour change rather than a test repair. The recenter bound now measures EDGE
    ///      movement instead of the midpoint: a midpoint is an average and an average hides a reshape, so
    ///      `_centred` — which narrows a 60,000-tick position to 600 in ONE call — moves each edge 29,700
    ///      ticks while the old `moved` read exactly zero. That is F-07 mechanisms B and C in a single
    ///      line: same midpoint, legal width, every price bound satisfied, and the stored liquidity
    ///      multiplied by two orders of magnitude. Narrowing is still available to the keeper; it now costs
    ///      more than one rebalance, which is the point.
    ///
    ///      Never returns a no-op, so an assertion that the range moved is still able to fail.
    function _step(int24 anchor) internal pure returns (int24 lo, int24 hi) {
        int24 delta = anchor > D_RECENTER ? D_RECENTER : (anchor < -D_RECENTER ? -D_RECENTER : anchor);
        delta = (delta / SPACING) * SPACING;
        if (delta == 0) delta = anchor < 0 ? -SPACING : SPACING;
        lo = -30_000 + delta;
        hi = 30_000 + delta;
    }

    /* ================================================================== D1 =========
       Can a user open and fully withdraw against the configuration the script actually produces?
       This is the whole deployment: mined hook, pinned vault, dynamic-fee pool, fixed 3000-pip LP fee.
       ============================================================================== */

    function test_D1_shippedDefaultsAreUsableEndToEnd() public {
        uint256 before0 = MockERC20(Currency.unwrap(currency0)).balanceOf(alice);
        uint256 before1 = MockERC20(Currency.unwrap(currency1)).balanceOf(alice);

        uint256 id = _open(positions, alice, -30_000, 30_000, 20_000e18);

        assertGt(before0 - MockERC20(Currency.unwrap(currency0)).balanceOf(alice), 0, "no currency0 was pulled");
        assertGt(before1 - MockERC20(Currency.unwrap(currency1)).balanceOf(alice), 0, "no currency1 was pulled");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(positions)), 0, "vault retained token0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(positions)), 0, "vault retained token1");
        assertEq(StateLibrary.getLiquidity(manager, pid), 20_000e18, "pool did not receive the liquidity");

        // Some volume, so the exit is not tested on a virgin pool.
        for (uint256 i = 0; i < 6; i++) {
            _advance(61);
            _swap(i % 2 == 0, 50e18);
        }

        vm.prank(alice);
        positions.withdrawAll(id);

        assertEq(positions.getPosition(id).liquidity, 0, "withdrawAll left liquidity behind");
        assertEq(StateLibrary.getLiquidity(manager, pid), 0, "pool still holds the position");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(positions)), 0, "vault retained token0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(positions)), 0, "vault retained token1");

        uint256 out = _bal(alice);
        console2.log("D1 alice in  (token0+token1):", before0 + before1);
        console2.log("D1 alice out (token0+token1):", out);
        // She round-tripped through a fee-earning pool at a price that came back; she must not be down
        // more than the residual price drift of the six swaps.
        assertGt(out, ((before0 + before1) * 999) / 1000, "user lost material value across open/withdraw");
    }

    /* ================================================================== D2 =========
       RESHAPED (was test_D2_restrictedLiquidityAdmitsTheVaultAndNothingElse). The script's default
       flipped true -> false: an allowlist that is handed the VAULT's address can never tell a depositor
       from a JIT bot riding through the vault, and a sole-LP pool has zero-liquidity regions that make
       the oracle walkable — so third-party depth is now admitted BY DEFAULT, on purpose.

       Both halves still need proving, so this test does both deployments: (a) the shipped default is
       genuinely open — the same stranger-add that used to be refused now lands; and (b) restricted mode
       is still a supported env-override deployment, and there the allowlist still admits the vault and
       nothing else. The attack machinery (stranger straight at the manager, rogue vault pinned to the
       same hook) is kept intact and pointed at the restricted deployment, where it still has a target.
       ============================================================================== */

    function test_D2_shippedDefaultIsOpenAndTheAllowlistStillGatesARestrictedDeployment() public {
        /* ---- (a) THE SHIPPED DEFAULT: unrestricted. */
        assertFalse(hook.restrictedLiquidity(), "shipped default should no longer be restricted");

        // The vault provides...
        _open(positions, alice, -30_000, 30_000, 20_000e18);

        // ...and a stranger, straight at the PoolManager through the standard test router, is ADMITTED.
        // Under the old default this exact call was the refused attack; today it is the design working.
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: bytes32(uint256(7))}),
            ZERO_BYTES
        );
        assertEq(
            StateLibrary.getLiquidity(manager, pid),
            20_000e18 + 1e18,
            "third-party depth was not admitted under the shipped default"
        );

        /* ---- (b) THE ENV-OVERRIDE: MOLE_RESTRICTED_LIQUIDITY=true is still a deployable policy,
                and there the gate must actually gate. Rebuild that deployment end to end. */
        MoleHook rhook = _mineAndDeployHook(DEPLOYER, D_OBS_INTERVAL, true);
        MolePositions rvault = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MIN_W, D_MAX_W, address(rhook), D_MAX_TWAP_DEV,
            D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_RECENTER
        , 0, address(0));
        // Script step 3: without this the restricted deployment is inert.
        vm.prank(DEPLOYER);
        rhook.setLiquidityAllowed(address(rvault), true);

        PoolKey memory rpk = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(rhook))
        });
        vm.prank(DEPLOYER);
        manager.initialize(rpk, SQRT_PRICE_1_1);
        rvault.whitelistPool(rpk);
        // Same cold start as the shipped pool above: a brand-new pool takes no deposits.
        _advance(D_TWAP_WINDOW + 1);
        _approve(alice, address(rvault));

        // The allowlisted vault provides.
        vm.prank(alice);
        rvault.open(rpk, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        // A stranger, straight at the PoolManager: refused BY THE HOOK, pinned so an unrelated router
        // failure cannot masquerade as the allowlist doing its job.
        vm.expectRevert(abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(rhook),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            ));
        modifyLiquidityRouter.modifyLiquidity(
            rpk,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: bytes32(uint256(7))}),
            ZERO_BYTES
        );

        // A stranger's OWN MolePositions, pinned to the same hook. whitelistPool is permissionless, so
        // admission succeeds — and the add still fails, because the hook allowlist is the real gate.
        MolePositions rogue = deployMoleVault(
            manager, address(this), D_MIN_REBALANCE_INTERVAL, D_MIN_W, D_MAX_W, address(rhook), D_MAX_TWAP_DEV,
            D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_RECENTER
        , 0, address(0));
        rogue.whitelistPool(rpk);
        _approve(alice, address(rogue));
        vm.prank(alice);
        // Pinned to the exact wrapped hook error. A bare `expectRevert()` passed here for years and proved
        // nothing: `open` has a dozen ways to revert — a bad range, a missing approval, a deadline, an
        // uninitialised pool — and every one of them would have satisfied it while the allowlist did no
        // work at all. The claim being made is specifically "the HOOK refused the add", so that is the
        // error the test must demand.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(rhook),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        rogue.open(rpk, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        // The gate's key is the poolCreator's, and nobody else's...
        vm.expectRevert(MoleHook.NotPoolCreator.selector);
        rhook.setLiquidityAllowed(address(rogue), true);

        // ...and the gate is genuinely the allowlist: flipping it lets the same call through.
        vm.prank(DEPLOYER);
        rhook.setLiquidityAllowed(address(rogue), true);
        vm.prank(alice);
        rogue.open(rpk, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    /* ================================================================== D3 =========
       Can the keeper rebalance AT ALL under the shipped defaults — 1 day cadence, 300 L1 blocks of
       dwell, a 1800s TWAP window on a 60s observation interval, a 600-tick deviation bound and a
       600-tick recenter cap?
       ============================================================================== */

    function test_D3_keeperCanRebalanceUnderTheShippedDefaults() public {
        uint256 id = _open(positions, alice, -30_000, 30_000, 20_000e18);

        // Just short of the cadence: refused on the cadence, not on anything else.
        _advance(1 days - 60);
        (int24 lo0, int24 hi0) = _step(0);
        vm.prank(DEPLOYER); // keeper == deployer, per MOLE_KEEPER's default
        vm.expectRevert(MolePositions.RebalanceTooSoon.selector);
        positions.rebalance(id, lo0, hi0);

        // Past it. The oracle has been idle the whole time, which is the realistic cold case.
        _advance(120);
        int24 twap = hook.consult(pid, D_TWAP_WINDOW);
        (int24 lo, int24 hi) = _step(twap);
        assertEq(int256(lo) % SPACING, 0, "lo off spacing");
        assertEq(int256(hi) % SPACING, 0, "hi off spacing");

        vm.prank(DEPLOYER);
        positions.rebalance(id, lo, hi);
        assertEq(positions.getPosition(id).tickLower, lo, "rebalance did not apply under the shipped defaults");
        assertEq(positions.rebalancesUsedInL1Block(block.number), 1, "budget accounting did not move");

        console2.log("D3 twap over 1800s:", int256(twap));
        console2.log("D3 new range lo:", int256(lo));
        console2.log("D3 new range hi:", int256(hi));

        // And the exit still works after the keeper has moved the range.
        vm.prank(alice);
        positions.withdrawAll(id);
        assertEq(positions.getPosition(id).liquidity, 0, "exit blocked after a rebalance");
    }

    /* ================================================================== D4 =========
       How long does the oracle take to warm up in the deployed configuration?
       ============================================================================== */

    function test_D4_oracleWarmsUpInExactlyTheWindowWithNoSwapsAtAll() public {
        // MEASURED ON A POOL CREATED HERE. setUp now ages the shipped pool past the window before anyone
        // deposits — it has to, because `open` gates spot against the oracle and a cold oracle refuses the
        // deposit — and this test is about the interval from pool CREATION, so it needs a pool of its own.
        PoolKey memory fresh = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        vm.prank(DEPLOYER);
        manager.initialize(fresh, SQRT_PRICE_1_1);
        PoolId freshId = fresh.toId();

        // One second short of the window: fails closed.
        _advance(D_TWAP_WINDOW - 1);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(freshId, D_TWAP_WINDOW);

        // Exactly the window after pool creation, with zero swaps ever: answerable.
        _advance(1);
        int24 t = hook.consult(freshId, D_TWAP_WINDOW);
        assertEq(int256(t), 0, "an idle pool should average to its initial tick");
        console2.log("D4 seconds from pool creation to a usable 1800s TWAP:", D_TWAP_WINDOW);
    }

    /* ================================================================== D5 =========
       FINDING, NOW A REGRESSION. `require(twapWindow <= obsInterval * 256)` was off by one observation
       interval: a full ring of 256 observations spans 255 GAPS, not 256. Once the seed observation
       written at afterInitialize has been overwritten — after 255 further writes, about four hours at
       the shipped 60s interval — the oldest readable observation is 255 * interval behind the newest.

       The script used to accept 256 * interval. Such a deployment passed every check, worked while the
       pool was young, and then became permanently unable to rebalance ANY position — but only on pools
       busy enough to write at the interval cadence, i.e. exactly the pools the product exists for. The
       ceiling now lives in DeployConfig and is 255 * interval; this test proves both the refusal and
       that the true maximum stayed deployable, and keeps the live demonstration of the outage.
       ============================================================================== */

    function test_regression_D5_scriptCeilingNowMatchesTheRingsRealCapacity() public {
        uint32 accepted = D_OBS_INTERVAL * 256; // 15360 — what the script used to allow
        uint32 real = D_OBS_INTERVAL * 255; // 15300 — what the ring can actually cover

        // REGRESSION: the script's ceiling now matches the ring's real capacity. The 256-gap config it
        // used to wave through is refused, and the 255-gap config — the true maximum — is still allowed,
        // so the fix tightened the guard without making the legitimate maximum undeployable.
        assertFalse(
            _passesScriptRequires(D_MIN_REBALANCE_INTERVAL, accepted, D_OBS_INTERVAL),
            "the script still accepts a window the ring can never cover"
        );
        assertTrue(
            _passesScriptRequires(D_MIN_REBALANCE_INTERVAL, real, D_OBS_INTERVAL),
            "the fix over-tightened: the ring's true maximum window is no longer deployable"
        );

        MolePositions vaultAtCeiling =
            _deployVault(DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MAX_TWAP_DEV, accepted, D_DWELL, D_BUDGET);
        MolePositions vaultBelow =
            _deployVault(DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MAX_TWAP_DEV, real, D_DWELL, D_BUDGET);
        vaultAtCeiling.whitelistPool(pk);
        vaultBelow.whitelistPool(pk);
        _approve(alice, address(vaultAtCeiling));
        _approve(alice, address(vaultBelow));

        // Both vaults gate deposits on a window LONGER than the one setUp aged the pool past, so age it
        // the rest of the way: a cold oracle refuses a deposit exactly as it refuses a rebalance.
        _advance(uint256(accepted) + 1);

        uint256 idCeiling = _open(vaultAtCeiling, alice, -30_000, 30_000, 20_000e18);
        uint256 idBelow = _open(vaultBelow, alice, -30_000, 30_000, 20_000e18);

        // Age past the 1-day cadence, idle. While the seed observation is still in the ring both windows
        // are answerable — this is the "it worked on day one" phase.
        _advance(1 days + 60);
        hook.consult(pid, accepted);
        hook.consult(pid, real);

        // Now ordinary volume at the shipped interval's cadence: one swap per 60s. Every swap writes,
        // so 300 writes roll the ring completely and the seed observation is gone.
        for (uint256 i = 0; i < 300; i++) {
            _advance(60);
            _swap(i % 2 == 0, 20e18);
        }

        (uint16 idx,,,,,) = hook.poolStates(pid);
        (uint32 oldestTs,,) = hook.observations(pid, uint16((uint256(idx) + 1) % 256));
        console2.log("D5 oldest observation age (s):", block.timestamp - oldestTs);
        console2.log("D5 window the script accepted :", accepted);
        console2.log("D5 window the ring can cover  :", real);

        // The ring covers 255 gaps, so the accepted ceiling is exactly one interval too long.
        hook.consult(pid, real);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(pid, accepted);

        // Consequence: the vault deployed at the once-accepted ceiling can no longer rebalance
        // ANYTHING, permanently, while the identically configured vault one interval below is fine.
        int24 twap = hook.consult(pid, real);
        (int24 lo, int24 hi) = _step(twap);

        vm.prank(DEPLOYER);
        vaultBelow.rebalance(idBelow, lo, hi);
        assertEq(vaultBelow.getPosition(idBelow).tickLower, lo, "control vault could not rebalance");

        vm.prank(DEPLOYER);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        vaultAtCeiling.rebalance(idCeiling, lo, hi);

        // More volume at the same cadence never restores coverage.
        for (uint256 i = 0; i < 60; i++) {
            _advance(60);
            _swap(i % 2 == 0, 20e18);
        }
        vm.prank(DEPLOYER);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        vaultAtCeiling.rebalance(idCeiling, lo, hi);

        // THE PRECISE SHAPE OF THE OUTAGE, stated so it is not overclaimed. Coverage is
        // (255 * interval) + (time since the last write), so the window becomes answerable again the
        // moment the pool has been QUIET for one full observation interval. The vault at the accepted
        // ceiling can therefore only ever rebalance a pool that is not currently trading — the failure
        // is correlated with activity, which is precisely when a rebalance matters.
        _advance(D_OBS_INTERVAL + 1); // one interval of silence, no swap
        hook.consult(pid, accepted);
        vm.prank(DEPLOYER);
        vaultAtCeiling.rebalance(idCeiling, lo, hi);
        assertEq(vaultAtCeiling.getPosition(idCeiling).tickLower, lo, "idle-window rebalance did not apply");

        // Controls on the other side of the script's range, so the defect is pinned to the CEILING and
        // not to the harness: the shipped 1800s window and the script's own lower bound
        // (twapWindow >= 2 * obsInterval) are both comfortably coverable at the very same cadence.
        hook.consult(pid, D_TWAP_WINDOW);
        hook.consult(pid, D_OBS_INTERVAL * 2);

        // Exits are untouched — the failure is a keeper outage, not a custody failure.
        vm.prank(alice);
        vaultAtCeiling.withdrawAll(idCeiling);
        assertEq(vaultAtCeiling.getPosition(idCeiling).liquidity, 0, "exit blocked by the bricked oracle window");
    }

    /* ================================================================== D6 =========
       FINDING, RESHAPED (was test_D6_defaultKeeperKeyAlsoOwnsTheJitDefence). Two facts changed under
       the original: the shipped default is no longer restricted, and MoleHook's own documentation now
       concedes the allowlist NEVER was a JIT defence — it is handed the vault's address, never the
       depositor's, so a JIT bot could always ride through the vault itself.

       What remains true, and is pinned here:
         (a) keeper, poolCreator and feeRecipient are still ONE key under the defaults. The trust-domain
             merge is real; it just no longer stands between a JIT bot and the pool.
         (b) The yield diversion this test used to demonstrate behind a keeper-key allowlist flip now
             requires NO privileged key at all. The attack machinery is kept and the measured harm is
             the same; what changed is who can do it: everyone. That is the documented price of
             unblockable exits plus third-party depth, and keeping the NUMBER attached means the trade
             stays priced rather than merely asserted.
       ============================================================================== */

    function test_D6_trustDomainsShareOneKeyAndJitDiversionNeedsNoKeyUnderTheDefaults() public {
        // The identity, first. Nothing in the script warns about it; it prints keeper and moves on.
        assertEq(positions.keeper(), DEPLOYER, "keeper is not the deployer under the defaults");
        assertEq(hook.poolCreator(), DEPLOYER, "poolCreator is not the deployer under the defaults");
        assertEq(hook.feeRecipient(), DEPLOYER, "feeRecipient is not the deployer under the defaults");
        assertEq(positions.keeper(), hook.poolCreator(), "the two trust domains are the same key");

        // The vault's user provides through the vault.
        uint256 aliceStart = _bal(alice);
        uint256 aliceId = _open(positions, alice, -30_000, 30_000, 20_000e18);
        _approve(jit, address(modifyLiquidityRouter));

        ModifyLiquidityParams memory add = ModifyLiquidityParams({
            tickLower: -600,
            tickUpper: 600,
            liquidityDelta: int256(2_000_000e18),
            salt: bytes32(uint256(0x71751))
        });

        uint256 snap = vm.snapshotState();

        /* ---- CONTROL: no JIT bot. The vault's user is the only LP.
               Yield is measured against her pre-deposit balance at a RESTORED parity price, so it is
               fee income and not a composition artefact. */
        for (uint256 i = 0; i < 20; i++) {
            _advance(61);
            _swap(i % 2 == 0, 100e18);
        }
        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 controlYield = int256(_bal(alice)) - int256(aliceStart);

        vm.revertToState(snap);

        /* ---- ATTACK: the bot walks straight in. Under the old restricted default this add REVERTED
               until the KEEPER key flipped the allowlist; the shipped default has no gate to flip.
               Note what is absent below: no prank of DEPLOYER, no privileged call of any kind. */
        uint256 jitBefore = _bal(jit);
        vm.prank(jit);
        modifyLiquidityRouter.modifyLiquidity(pk, add, ZERO_BYTES);

        // The identical two-way volume, now with the JIT liquidity in front of the vault's position.
        for (uint256 i = 0; i < 20; i++) {
            _advance(61);
            _swap(i % 2 == 0, 100e18);
        }

        add.liquidityDelta = -int256(2_000_000e18);
        vm.prank(jit);
        modifyLiquidityRouter.modifyLiquidity(pk, add, ZERO_BYTES);
        uint256 jitGain = _bal(jit) - jitBefore;

        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 attackedYield = int256(_bal(alice)) - int256(aliceStart);

        console2.log("D6 vault user's fee yield, no JIT bot    :", controlYield);
        console2.log("D6 vault user's fee yield, bot in front  :", attackedYield);
        console2.log("D6 fees captured by the unprivileged bot :", jitGain);
        console2.log(
            "D6 percent of the user's fee income removed:",
            100 - (uint256(attackedYield > 0 ? attackedYield : int256(0)) * 100) / uint256(controlYield)
        );

        assertGt(jitGain, 0, "the JIT add captured nothing");
        assertGt(controlYield, int256(0), "premise failed: the control run earned no fees");
        assertLt(attackedYield, controlYield / 10, "the JIT add did not materially divert the user's yield");

        // Exits still work — this is a yield diversion, not a custody break.
        assertEq(positions.getPosition(aliceId).liquidity, 0, "exit blocked");
    }

    /* ================================================================== D7 =========
       FINDING, NOW A REGRESSION. The script narrow-casts every environment value; narrowing is silent,
       and for these bounds a truncation most often lands on 0, which means DISABLED. An operator who
       wrote a deliberately huge number to mean "no limit" — or who fat-fingered one — used to deploy
       the bound switched OFF, immutably, while the script printed a successful deployment.
       ============================================================================== */

    /// @notice REGRESSION (was test_D7_outOfRangeEnvValuesSilentlyDeployTheBoundsDisabled). The truncation
    ///         hazard is real and unchanged — Solidity narrowing is silent, and for these bounds it most
    ///         often lands on 0, which means DISABLED. What changed is that the deploy path now refuses
    ///         such a value instead of shipping an unguarded vault.
    function test_regression_D7_outOfRangeEnvValuesCannotSilentlyDisableABound() public {
        // The truncation itself still happens — that is Solidity, not something a fix can remove.
        assertEq(uint256(uint16(uint256(65_536))), 0, "budget did not truncate to zero");
        assertEq(uint256(uint64(uint256(2 ** 64))), 0, "dwell did not truncate to zero");
        assertEq(int256(int24(int256(uint256(16_777_216)))), 0, "twap deviation did not truncate to zero");

        // ...which is exactly why the script range-checks at FULL uint256 width before narrowing, and why
        // a config with a user-protecting bound at zero is refused by the shared rules rather than
        // silently deployed. Both halves are asserted against the real library, not a copy of it.
        DeployConfig.Params memory p = _defaultParams();
        p.maxTwapDeviationTicks = 0; // what a truncated env value would produce
        assertFalse(
            DeployConfig.allUserBoundsEnabled(p),
            "a disabled TWAP bound is no longer reported as an unguarded configuration"
        );
        p.maxTwapDeviationTicks = 600;
        assertTrue(DeployConfig.allUserBoundsEnabled(p), "a fully guarded config was reported as unguarded");
    }

    /// @notice Disabling the price-independent recenter bound must NOT pass as a guarded deployment.
    /// @dev This was a real gap: maxRecenterTicks reached the constructor but was never added to
    ///      DeployConfig, so `allUserBoundsEnabled` returned true with it at zero — and a deployment could
    ///      silently ship without the ONE bound that survives a dishonest oracle, re-opening the path where
    ///      a compromised keeper plus one ordinary address took 100% of a position's principal.
    function test_regression_disablingTheRecenterBoundIsReportedAsUnguarded() public pure {
        DeployConfig.Params memory p = _defaultParams();
        assertTrue(DeployConfig.allUserBoundsEnabled(p), "the shipped defaults are not fully guarded");

        p.maxRecenterTicks = 0;
        assertFalse(
            DeployConfig.allUserBoundsEnabled(p),
            "a deployment with the recenter bound disabled was reported as fully guarded"
        );

        // Each of the other user-protecting bounds is in the same list, so none of them can be dropped
        // silently either.
        p = _defaultParams();
        p.minDwellL1Blocks = 0;
        assertFalse(DeployConfig.allUserBoundsEnabled(p), "a disabled dwell was reported as guarded");
        p = _defaultParams();
        p.maxRebalancesPerL1Block = 0;
        assertFalse(DeployConfig.allUserBoundsEnabled(p), "a disabled budget was reported as guarded");
        p = _defaultParams();
        p.maxTwapDeviationTicks = 0;
        assertFalse(DeployConfig.allUserBoundsEnabled(p), "a disabled TWAP bound was reported as guarded");
    }

    /// @dev The shipped defaults, as DeployConfig.Params.
    function _defaultParams() internal pure returns (DeployConfig.Params memory) {
        return DeployConfig.Params({
            lpFeePips: D_LP_FEE,
            obsInterval: D_OBS_INTERVAL,
            hookFeePips: D_HOOK_FEE,
            feeRecipient: address(0),
            minRebalanceInterval: D_MIN_REBALANCE_INTERVAL,
            minRangeWidth: D_MIN_W,
            maxRangeWidth: D_MAX_W,
            maxTwapDeviationTicks: D_MAX_TWAP_DEV,
            twapWindow: D_TWAP_WINDOW,
            minDwellL1Blocks: D_DWELL,
            maxRebalancesPerL1Block: D_BUDGET,
            maxEjectionBps: D_EJECT, maxRecenterTicks: 600, restrictedLiquidity: false, performanceFeeBps: 0});
    }

    /* ================================================================== D9 =========
       Under an HONEST clock the shipped dwell can never be the binding constraint:
       `minRebalanceInterval` is 1 day and `lastRebalancedAt` is stamped at open(), so a position's
       first rebalance is already ~7,200 ETHEREUM blocks after `openedAtL1Block`, and the shipped dwell
       is 300. That is not dead code — the two guards deliberately run on DIFFERENT clocks.
       ============================================================================== */

    /// @notice The shipped dwell does not bind while the timestamp cadence is honest — and that is the point,
    ///         not a defect. The two guards measure DIFFERENT CLOCKS on purpose: the cadence runs on
    ///         `block.timestamp`, which the sequencer writes, and the dwell runs on `block.number`, which on
    ///         this chain is the Ethereum height and cannot be advanced by producing L2 blocks. So under
    ///         normal operation the cadence is strictly tighter and the dwell is silent; under a
    ///         timestamp-manipulation attack the cadence collapses and the dwell is the ONLY bound left
    ///         standing. An earlier version of this test called that "dead code". It is a backstop, and the
    ///         reason MOLE_MIN_DWELL_L1_BLOCKS was raised from 5 (~60s) to 300 (~1h) is precisely so the
    ///         backstop is worth something when it is the last one.
    function test_D9_shippedDwellIsSilentUnderAnHonestClockAndIsTheBackstopWhenItIsNot() public {
        uint256 dwellSeconds = uint256(D_DWELL) * RHChain.SECONDS_PER_BLOCK_NUMBER_TICK;
        uint256 dwellNeededToBind = uint256(D_MIN_REBALANCE_INTERVAL) / RHChain.SECONDS_PER_BLOCK_NUMBER_TICK;
        console2.log("D9 shipped dwell, in seconds of L1 progress:", dwellSeconds);
        console2.log("D9 dwell needed before it can ever bind    :", dwellNeededToBind);
        assertLt(dwellSeconds, uint256(D_MIN_REBALANCE_INTERVAL), "premise failed");

        MolePositions noDwell =
            _deployVault(DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MAX_TWAP_DEV, D_TWAP_WINDOW, 0, D_BUDGET);
        MolePositions realDwell = _deployVault(
            DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MAX_TWAP_DEV, D_TWAP_WINDOW, uint64(dwellNeededToBind + 100),
            D_BUDGET
        );
        noDwell.whitelistPool(pk);
        realDwell.whitelistPool(pk);
        _approve(alice, address(noDwell));
        _approve(alice, address(realDwell));

        uint256 idShipped = _open(positions, alice, -30_000, 30_000, 2_000e18); // dwell 300
        uint256 idNone = _open(noDwell, alice, -30_000, 30_000, 2_000e18); // dwell 0
        uint256 idReal = _open(realDwell, alice, -30_000, 30_000, 2_000e18); // dwell 7300

        // The first instant the cadence allows a rebalance.
        _advance(1 days);
        int24 twap = hook.consult(pid, D_TWAP_WINDOW);
        (int24 lo, int24 hi) = _step(twap);

        // Shipped dwell of 300 and no dwell at all are indistinguishable: both go through.
        vm.prank(DEPLOYER);
        positions.rebalance(idShipped, lo, hi);
        vm.prank(DEPLOYER);
        noDwell.rebalance(idNone, lo, hi);
        assertEq(positions.getPosition(idShipped).tickLower, lo, "shipped dwell blocked nothing, as expected");
        assertEq(noDwell.getPosition(idNone).tickLower, lo, "zero dwell blocked something");

        // Only a dwell larger than the cadence expressed in L1 blocks changes any outcome at all.
        vm.prank(DEPLOYER);
        vm.expectRevert(MolePositions.DwellNotElapsed.selector);
        realDwell.rebalance(idReal, lo, hi);
    }

    /* ================================================================== D8 =========
       The defaults themselves, measured against the ring's real capacity rather than the script's.
       ============================================================================== */

    function test_D8_shippedWindowSitsWellInsideTheRingsRealCapacity() public pure {
        uint32 realCeiling = D_OBS_INTERVAL * 255;
        assertLe(D_TWAP_WINDOW, realCeiling, "shipped window exceeds the ring's real capacity");
        // 1800 vs 15300: 8.5x of headroom, so the D5 defect was a trap for a future operator rather than
        // a live problem in the default deployment.
        assertGe(realCeiling / D_TWAP_WINDOW, 8, "headroom is smaller than reported");
    }
}
