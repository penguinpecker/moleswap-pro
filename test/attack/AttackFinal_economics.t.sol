// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @title AttackFinal_economics
/// @notice ECONOMIC / INCENTIVE ANGLE. Nobody here breaks an access-control rule, forges a signature, or
///         holds a privileged key. Every actor is a stranger using the shipped, permissionless entry
///         points exactly as documented. The question is only whether one of them can end a sequence with
///         more tokens than they started, at another participant's expense.
///
/// The deployment under test is `script/Deploy.s.sol` with ONE environment override, stated out loud
/// because E-0 and E-1 are about that switch:
///   hook   : lpFee 3000 (FIXED), obsInterval 60, hookFee 0,
///            restrictedLiquidity TRUE  <-- MOLE_RESTRICTED_LIQUIDITY=true; the script's own default is
///            now false, and E-1 below is the measurement that changed it
///   vault  : minRebalanceInterval 1 day, width 120..60_000, twapDev 600, twapWindow 1800,
///            dwell 300 L1 blocks, budget 10/L1 block, ejection cap disabled
///   step 3 : `hook.setLiquidityAllowed(address(positions), true)` (the script does this iff restricted)
///
/// WHAT CHANGED IN THIS FILE, AND WHY. The volatility-scaled dynamic fee was REMOVED from MoleHook rather
/// than repaired — E-2 below is the measurement that removed it, and its finding is now a property of the
/// source: the fee is a single immutable `lpFeePips`. E-2 and E-3 therefore no longer have a defect to
/// demonstrate. Neither is deleted, because the attack MACHINERY is exactly what proves the surface is
/// gone: both keep their sequences verbatim and now assert that the fee does not move, because nothing can
/// move it. Details in each test's own doc.
contract AttackFinalEconomicsTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------- shipped defaults */

    /// @dev The whole fee policy, now. There is no min, no max, no sensitivity, no direction flag and no
    ///      window, because there is no curve — `lpFeePips` is immutable and `currentFee()` returns it.
    uint24 internal constant D_LP_FEE = 3000;
    uint32 internal constant D_OBS_INTERVAL = 60;
    bool internal constant D_RESTRICTED = true;
    uint24 internal constant D_HOOK_FEE = 0;

    /// @dev Just a duration. It used to be `volWindow`, the period over which the surcharge decayed; E-3
    ///      keeps the same span so the old and new runs are comparable, but nothing in the hook reads it.
    uint32 internal constant LONG_SPAN = 1 hours;

    uint32 internal constant D_MIN_REBALANCE_INTERVAL = 1 days;
    int24 internal constant D_MIN_W = 120;
    int24 internal constant D_MAX_W = 60_000;
    int24 internal constant D_MAX_TWAP_DEV = 600;
    uint32 internal constant D_TWAP_WINDOW = 1800;
    uint64 internal constant D_DWELL = 300;
    uint16 internal constant D_BUDGET = 10;
    uint16 internal constant D_EJECT = 10_000;

    int24 internal constant SPACING = 60;

    /* ----------------------------------------------------------------- the actors */

    address internal DEPLOYER = makeAddr("deployer"); // poolCreator + keeper + feeRecipient
    address internal alice = makeAddr("alice"); // honest depositor
    address internal jit = makeAddr("jitBot"); // stranger, no key, no allowlist entry
    address internal victimSwapper = makeAddr("victimSwapper");

    MoleHook internal hook;
    MolePositions internal positions;
    PoolKey internal pk;
    PoolId internal pid;

    /// @dev Explicit accumulating clocks. `vm.warp(block.timestamp + d)` and `vm.roll(block.number + n)`
    ///      do NOT accumulate inside a loop — solc caches both within a call frame.
    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        // block.number on RH is the ETHEREUM height (~12s/tick), never one per L2 block.
        _height += 1 + secs / 12;
        vm.warp(_clock);
        vm.roll(_height);
    }

    /// @dev Advance blocks only, without moving the observation clock materially.
    function _advanceBlocksOnly(uint256 blocks) internal {
        _height += blocks;
        vm.roll(_height);
    }

    /* ------------------------------------------------------------------ deployment */

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("mole-econ", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deployHook(uint256 seed) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, DEPLOYER, D_LP_FEE, D_OBS_INTERVAL, D_RESTRICTED, D_HOOK_FEE, DEPLOYER, address(this)),
            a
        );
        h = MoleHook(a);
        require(HookPermissions.isValid(a), "hook bitmap is not 0x38C4");
    }

    function setUp() public {
        vm.warp(1_750_000_000);
        vm.roll(21_000_000);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        hook = _deployHook(1);
        positions = deployMoleVault(
            manager, DEPLOYER, D_MIN_REBALANCE_INTERVAL, D_MIN_W, D_MAX_W, address(hook),
            D_MAX_TWAP_DEV, D_TWAP_WINDOW, D_DWELL, D_BUDGET, D_EJECT
        , 0, 0, address(0));

        // Deploy script step 3, verbatim.
        vm.prank(DEPLOYER);
        hook.setLiquidityAllowed(address(positions), true);

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
        positions.whitelistPool(pk);

        _fund(alice);
        _fund(jit);
        _fund(victimSwapper);
        _approve(alice, address(positions));
        _approve(jit, address(positions));
        _approve(jit, address(swapRouter));
        _approve(victimSwapper, address(swapRouter));
    }

    /* --------------------------------------------------------------------- helpers */

    function _fund(address who) internal {
        MockERC20(Currency.unwrap(currency0)).mint(who, 50_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(who, 50_000_000e18);
    }

    function _approve(address who, address spender) internal {
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _open(address who, int24 lo, int24 hi, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = positions.open(pk, lo, hi, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    /// @dev Exact-input swap by `who`.
    function _swapAs(address who, bool zeroForOne, uint256 amount) internal {
        vm.prank(who);
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

    function _bal0(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency0)).balanceOf(who);
    }

    function _bal1(address who) internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency1)).balanceOf(who);
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(manager, pid);
    }

    /// @dev The fee the POOL MANAGER has stored for this pool, as opposed to the one the hook returns per
    ///      swap with the override flag. Kept separate on purpose: E-3 shows that even if this number were
    ///      nudged, the swapper's bill would not follow it.
    function _storedLpFee() internal view returns (uint24 f) {
        (,,, f) = StateLibrary.getSlot0(manager, pid);
    }

    /// @dev Push the pool back to exactly parity so two runs that carried different liquidity are
    ///      compared at the same price and "tokens out" is fee income, not a composition artefact.
    function _restoreToParity() internal {
        (uint160 sp,,,) = StateLibrary.getSlot0(manager, pid);
        if (sp == SQRT_PRICE_1_1) return;
        bool zeroForOne = sp > SQRT_PRICE_1_1;
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(20_000_000e18),
                sqrtPriceLimitX96: SQRT_PRICE_1_1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Every fee the hook quoted in the recorded window, reduced to (lowest, highest, how many).
    ///      One helper rather than two, because the interesting claim is now a RANGE: if lo == hi == the
    ///      immutable, then no leg of a sequence — not the first, not the thirtieth — was billed anything
    ///      else, and no actor moved the number in between.
    function _feeQuotesFromLogs() internal returns (uint24 lo, uint24 hi, uint256 count) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FeeQuoted(bytes32,uint24)");
        lo = type(uint24).max;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                uint24 f = abi.decode(logs[i].data, (uint24));
                if (f < lo) lo = f;
                if (f > hi) hi = f;
                count++;
            }
        }
        require(count > 0, "no FeeQuoted event");
    }

    /// @dev Assert that every swap in the recorded window was billed exactly the immutable fee.
    function _assertEveryQuoteWasTheConstant(uint256 minCount, string memory what) internal {
        (uint24 lo, uint24 hi, uint256 count) = _feeQuotesFromLogs();
        assertGe(count, minCount, string.concat(what, ": fewer swaps were quoted than the sequence ran"));
        assertEq(lo, D_LP_FEE, string.concat(what, ": some swap was billed below the immutable fee"));
        assertEq(hi, D_LP_FEE, string.concat(what, ": some swap was billed above the immutable fee"));
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /* ===============================================================================================
       E-0.  PREMISE. The shipped JIT defence is up, and it genuinely stops a direct third-party LP.
       =============================================================================================== */

    function test_E0_premise_theJitDefenceIsUpAndStopsADirectAdd() public {
        assertTrue(hook.restrictedLiquidity(), "shipped default is not restricted");
        assertTrue(hook.liquidityAllowed(address(positions)), "script step 3 did not allowlist the vault");
        assertFalse(hook.liquidityAllowed(jit), "the bot must not be allowlisted");
        assertFalse(hook.liquidityAllowed(address(modifyLiquidityRouter)), "the router must not be allowlisted");

        _approve(jit, address(modifyLiquidityRouter));
        vm.prank(jit);
        // Pinned to the hook's OWN error, wrapped by v4. A bare expectRevert here would also be satisfied
        // by the router failing for an unrelated reason, which would leave the allowlist untested.
        vm.expectRevert(abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeAddLiquidity.selector,
                abi.encodeWithSelector(MoleHook.LiquidityNotAllowed.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            ));
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: int256(1e18), salt: bytes32(0)}),
            ZERO_BYTES
        );
    }

    /* ===============================================================================================
       E-1.  THE JIT DEFENCE IS VOID: THE ALLOWLISTED PROVIDER IS ITSELF PERMISSIONLESS.

       MoleHook used to call `restrictedLiquidity` "the real JIT defence" and say it was the ONLY
       structural answer available, because the three remove-liquidity bits are deliberately unmined and so
       no penalty can ever be charged at exit. The deploy script then allowlists exactly one address:
       MolePositions.

       MolePositions.open() is permissionless, has no minimum size, no dwell requirement and no lockup,
       and withdraw()/withdrawAll() are — by the custody claim's own design — unconditional and
       unpausable. So `sender` in beforeAddLiquidity is the vault for EVERY user, and any stranger can
       add and remove liquidity in the same block simply by routing through it.

       The dwell field the hook stamps is `keccak256(vault, salt)`, and the vault never reads it.

       STILL LIVE. The source now says so in its own comment and the deploy default flipped to false, but
       the behaviour is unchanged and this measurement is what it rests on, so it stays exactly as it was.
       =============================================================================================== */

    function test_E1_jitThroughThePermissionlessVaultDivertsAnHonestDepositorsFees() public {
        // The honest depositor: a wide, ordinary ALM range.
        uint256 aliceStart = _bal(alice);
        uint256 aliceId = _open(alice, -30_000, 30_000, 20_000e18);

        uint256 snap = vm.snapshotState();

        /* ---- CONTROL. Twenty two-way swaps, no JIT. Alice is the only LP. */
        for (uint256 i = 0; i < 20; i++) {
            _advance(61);
            _swapAs(victimSwapper, i % 2 == 0, 100e18);
        }
        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 controlYield = int256(_bal(alice)) - int256(aliceStart);

        vm.revertToState(snap);

        /* ---- ATTACK. Identical flow. The bot opens through the vault immediately before each swap and
               withdraws immediately after, in the SAME block. No key, no allowlist entry, no waiting. */
        uint256 jitStart = _bal(jit);
        for (uint256 i = 0; i < 20; i++) {
            _advance(61);
            uint256 jid = _open(jit, -600, 600, 2_000_000e18);
            _swapAs(victimSwapper, i % 2 == 0, 100e18);
            vm.prank(jit);
            positions.withdrawAll(jid); // same block as the add: nothing gates the exit
        }
        int256 jitGain = int256(_bal(jit)) - int256(jitStart);

        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 attackedYield = int256(_bal(alice)) - int256(aliceStart);

        console2.log("E1 alice fee yield, no JIT      :", controlYield);
        console2.log("E1 alice fee yield, JIT present :", attackedYield);
        console2.log("E1 tokens taken by the JIT bot  :", jitGain);

        assertGt(controlYield, int256(0), "premise failed: the control run earned no fees");
        assertGt(jitGain, int256(0), "the JIT bot did not profit");
        assertLt(attackedYield, controlYield / 4, "the JIT did not materially divert the honest fee income");

        // The bot never held a permission and the defence was up the whole time.
        assertTrue(hook.restrictedLiquidity(), "restriction was switched off during the run");
        assertFalse(hook.liquidityAllowed(jit), "the bot became allowlisted");
    }

    /// @notice The same extraction reduced to ONE swap, so the number is unambiguous: the bot's profit is
    ///         the fee the honest depositor would otherwise have earned on that swap.
    function test_E1b_singleSwapJitTakesTheFeeAndTheHonestLpGetsNothing() public {
        // Measured against her PRE-DEPOSIT balance, so the figure is fee income and not principal.
        uint256 aliceStart = _bal(alice);
        uint256 aliceId = _open(alice, -30_000, 30_000, 20_000e18);
        _advance(61);

        uint256 snap = vm.snapshotState();

        // CONTROL: one 500e18 swap, then straight back to parity, then Alice exits.
        _swapAs(victimSwapper, true, 500e18);
        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 controlYield = int256(_bal(alice)) - int256(aliceStart);

        vm.revertToState(snap);

        // ATTACK: the bot fronts the same swap with vault liquidity and unwinds in the same block.
        uint256 jitStart = _bal(jit);
        uint256 jid = _open(jit, -600, 600, 5_000_000e18);
        _swapAs(victimSwapper, true, 500e18);
        vm.prank(jit);
        positions.withdrawAll(jid);
        int256 jitGain = int256(_bal(jit)) - int256(jitStart);

        _restoreToParity();
        vm.prank(alice);
        positions.withdrawAll(aliceId);
        int256 attackedYield = int256(_bal(alice)) - int256(aliceStart);

        console2.log("E1b honest LP on the swap, no JIT :", controlYield);
        console2.log("E1b honest LP on the swap, JIT on :", attackedYield);
        console2.log("E1b JIT bot net tokens            :", jitGain);

        assertGt(controlYield, int256(0), "premise failed");
        assertGt(jitGain, int256(0), "the single-swap JIT was not profitable");
        assertLt(attackedYield, controlYield / 4, "the honest LP kept most of the fee anyway");
    }

    /* ===============================================================================================
       E-2.  THE MANUFACTURED SURCHARGE HAS NO SIGNAL LEFT TO MANUFACTURE.

       WHAT THIS TEST USED TO BE, AND WHY IT CHANGED SHAPE. It used to prove the finding that killed the
       dynamic fee: a depositor could wash-trade the volatility surcharge to its ceiling INSIDE ONE BLOCK —
       billed at base the whole way, because a block-lagged quote cannot move inside its own block — and
       then collect that ceiling from third-party flow, because the fee is paid to whoever holds the
       in-range liquidity and `restrictedLiquidity` makes the vault the only holder. Measured then:
       attacker +114.9e18, third-party swappers -170.0e18. The response was to DELETE the mechanism, not
       to tune it: the party that collects the fee is the party that can manufacture the signal it is
       derived from, and no decay function changes that.

       So the finding is now a property of the source, and the honest thing for a test to assert is that
       the surface is GONE rather than to pretend it is still there. THE ATTACK MACHINERY IS UNCHANGED —
       same fifteen round trips in one block, same self-funded return to parity, same identical
       third-party flow measured against the same control. Only the ledger's verdict is inverted:

         * every one of the ~31 manufacture legs is billed the immutable fee, and so is every swap
           afterwards — there is no lag to exploit because there is nothing to lag;
         * the third-party flow costs the same as in the control run, to within rounding;
         * the attacker ends the sequence DOWN, not up. Wash trading is now pure expenditure, and the part
           of it that does not come back is a SUBSIDY TO THE HONEST LP.

       DELETED WITH THE FEATURE: the break-even-volume arithmetic that closed the old version. It was
       (maxFee - baseFee) x volume x liquidity share; with a single fee, (maxFee - baseFee) is not a
       quantity that exists, and computing it from any other pair of numbers would be theatre.
       =============================================================================================== */

    /// @dev Bring the pool back to exactly parity, paid for by `who` rather than by a third party, so a
    ///      manufacture sequence carries its own cost.
    function _toParityAs(address who) internal {
        (uint160 sp,,,) = StateLibrary.getSlot0(manager, pid);
        if (sp == SQRT_PRICE_1_1) return;
        bool zeroForOne = sp > SQRT_PRICE_1_1;
        vm.prank(who);
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(5_000_000e18),
                sqrtPriceLimitX96: SQRT_PRICE_1_1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Third-party flow: 20 alternating swaps, all inside one observation interval — the window in
    ///      which a manufactured quote would have applied to every one of them.
    function _thirdPartyFlow() internal returns (int256 victimNet, uint256 volume) {
        uint256 before = _bal(victimSwapper);
        for (uint256 i = 0; i < 20; i++) {
            _advance(3);
            _swapAs(victimSwapper, i % 2 == 0, 500e18);
            volume += 500e18;
        }
        victimNet = int256(_bal(victimSwapper)) - int256(before);
    }

    /// @dev Held in a struct rather than as locals: with via_ir at these optimizer settings the whole
    ///      ledger does not fit on the stack, and a hand-split test is harder to audit than a struct.
    struct Ledger {
        uint256 aliceStart;
        uint256 aliceId;
        uint256 attackerStart;
        uint256 attackerId;
        uint256 volume;
        int256 victimControl;
        int256 victimAttack;
        int256 attackerControl;
        int256 attackerAttack;
        int256 aliceControl;
        int256 aliceAttack;
        uint24 controlLo;
        uint24 controlHi;
        uint24 attackLo;
        uint24 attackHi;
    }

    function test_E2_washTradingCannotManufactureASurchargeBecauseTheFeeIsImmovable() public {
        // MEMORY, not storage: `vm.revertToState` rolls back the test contract's storage too, so a
        // ledger kept in storage would be erased by the control/attack switch. Memory in the running
        // frame is not journaled state and survives the revert.
        Ledger memory L;

        // The honest depositor, and the attacker's much larger position — both opened through the same
        // permissionless entry point, neither of them holding any key. The attacker is DOMINANT in range
        // (4,000,000 against 20,000), which is precisely the condition that made the old surcharge
        // collectable: it is preserved so the proof is not "the attacker was too small".
        L.aliceStart = _bal(alice);
        L.aliceId = _open(alice, -30_000, 30_000, 20_000e18);
        L.attackerStart = _bal(jit);
        L.attackerId = _open(jit, -6_000, 6_000, 4_000_000e18);

        _advance(61);
        assertEq(hook.currentFee(pid), D_LP_FEE, "premise failed: the pool did not open at the immutable fee");
        uint256 snap = vm.snapshotState();

        /* ---- CONTROL: the third-party flow against a pool nobody has touched. */
        vm.recordLogs();
        (L.victimControl, L.volume) = _thirdPartyFlow();
        (L.controlLo, L.controlHi,) = _feeQuotesFromLogs();
        vm.prank(jit);
        positions.withdrawAll(L.attackerId);
        L.attackerControl = int256(_bal(jit)) - int256(L.attackerStart);
        vm.prank(alice);
        positions.withdrawAll(L.aliceId);
        L.aliceControl = int256(_bal(alice)) - int256(L.aliceStart);

        vm.revertToState(snap);

        /* ---- ATTACK, step 1: try to manufacture the volatility, exactly as before. */
        _attemptToManufactureASurcharge();

        /* ---- Step 2: the identical third-party flow. It should be taxed identically. */
        vm.recordLogs();
        (L.victimAttack,) = _thirdPartyFlow();
        (L.attackLo, L.attackHi,) = _feeQuotesFromLogs();
        vm.prank(jit);
        positions.withdrawAll(L.attackerId);
        L.attackerAttack = int256(_bal(jit)) - int256(L.attackerStart);
        vm.prank(alice);
        positions.withdrawAll(L.aliceId);
        L.aliceAttack = int256(_bal(alice)) - int256(L.aliceStart);

        _settle(L);
    }

    function _attemptToManufactureASurcharge() internal {
        uint256 manufactureStart = _bal(jit);
        vm.recordLogs();
        for (uint256 i = 0; i < 15; i++) {
            _swapAs(jit, true, 120_000e18);
            _swapAs(jit, false, 120_000e18);
        }
        _toParityAs(jit); // the attacker pays to put the price back where it found it

        // 30 wash legs plus the parity leg, every one of them billed the same immutable number. The old
        // version asserted this too — it was the manufacturer's FRIEND then, because the quote it was
        // moving could not move inside its own block. Now it is simply what the fee always is.
        _assertEveryQuoteWasTheConstant(31, "manufacture");
        console2.log("E2 attacker wallet outflow, manufacture:", int256(manufactureStart) - int256(_bal(jit)));

        // Let a figure be written and its block end — the two ticks of the clock the old block-lagged
        // quote needed in order to publish. There is nothing to publish.
        _advance(61);
        vm.prank(jit);
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: true, amountSpecified: -1e12, sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        _advanceBlocksOnly(1);

        console2.log("E2 tick after the manufacture (should be ~0):", int256(_tick()));
        console2.log("E2 quoted fee after the manufacture (pips)  :", uint256(hook.currentFee(pid)));
        assertEq(hook.currentFee(pid), D_LP_FEE, "the wash trading moved the fee");
        assertEq(hook.lpFeePips(), D_LP_FEE, "the immutable itself moved, which is impossible");
    }

    function _settle(Ledger memory L) internal pure {
        int256 attackerGain = L.attackerAttack - L.attackerControl;
        int256 honestLpGain = L.aliceAttack - L.aliceControl;
        int256 swapperDelta = L.victimControl - L.victimAttack; // > 0 would mean the flow was taxed more

        console2.log("E2 third-party volume                 :", L.volume);
        console2.log("E2 fee that flow pays, quiet    (pips):", uint256(L.controlLo));
        console2.log("E2 fee that flow pays, wash-traded    :", uint256(L.attackLo));
        console2.log("E2 third-party net, quiet pool        :", L.victimControl);
        console2.log("E2 third-party net, wash-traded pool  :", L.victimAttack);
        console2.log("E2 attacker net, control run          :", L.attackerControl);
        console2.log("E2 attacker net, attack run           :", L.attackerAttack);
        console2.log("E2 ATTACKER P&L from manufacturing    :", attackerGain);
        console2.log("E2 honest LP gain (the wash subsidy)  :", honestLpGain);
        console2.log("E2 third-party extra cost             :", swapperDelta);

        // THE FEE NEVER MOVED, in either run, on any leg.
        assertEq(L.controlLo, D_LP_FEE, "quiet pool was not at the immutable fee");
        assertEq(L.controlHi, D_LP_FEE, "quiet pool quoted more than one fee");
        assertEq(L.attackLo, D_LP_FEE, "wash-traded pool billed below the immutable fee");
        assertEq(L.attackHi, D_LP_FEE, "wash-traded pool billed above the immutable fee");

        // AND THEREFORE THE THIRD PARTY PAID THE SAME. Not bit-identical: the manufacture leaves the pool
        // a dust swap away from parity, so the flow fills at a marginally different price. Bounded at one
        // part in a billion of what that flow costs at the immutable fee. The deleted mechanism moved
        // 17,000 pips of surcharge — 1.7% — onto exactly these swappers, so the two live nowhere near
        // each other and no re-measurement is going to confuse them.
        assertLt(
            _abs(swapperDelta) * 1_000_000_000,
            _abs(L.victimControl),
            "the wash trading materially changed what third-party flow pays"
        );

        // THE ATTACKER PAID FOR ITS OWN NOISE. This is the inversion: with a surcharge to collect, the
        // same sequence earned +114.9e18; with no surcharge it is a net outflow, and it stays one no
        // matter how dominant the attacker's liquidity share is, because there is no rate for dominance
        // to multiply.
        assertLt(attackerGain, int256(0), "manufacturing still paid for itself");

        // WHERE THE MONEY WENT, to the wei. The attacker's loss is exactly the honest LP's gain plus the
        // third party's (marginal) gain — nobody was taxed, the wash fees were a donation. This closure is
        // what makes the sign of `attackerGain` a transfer rather than a measurement artefact, and it is
        // the same conservation check the old version ran, with the recipients swapped round.
        assertGt(honestLpGain, int256(0), "the honest LP did not receive the wash fees");
        uint256 residual = _abs(-attackerGain - honestLpGain + swapperDelta);
        console2.log("E2 unaccounted residual (rounding)    :", residual);
        assertLt(
            residual * 1_000_000_000_000,
            uint256(-attackerGain),
            "the ledger does not close: something else moved"
        );
    }

    /* ===============================================================================================
       E-3.  THE FEE IS A FUNCTION OF NOTHING — NOT OF CADENCE, NOT OF ELAPSED TIME, NOT OF DISPLACEMENT.

       WHAT THIS TEST USED TO BE, AND WHY IT CHANGED SHAPE. `volWindow` was documented as the time over
       which accumulated volatility "decays to nothing", and the decay comment said "only time may
       discount it". It was applied once per WRITE as `v * (W - dtSinceLastSwap) / W` — a product over swap
       gaps, not a function of elapsed time — so the same elapsed hour discounted to zero if nobody traded
       and to a large residual if somebody kept touching the pool. Anyone who wanted the surcharge to
       survive could buy that with gas. The mirror-image defect was that an idle pool quoted its last
       surcharge forever, because nothing ages the number without a swap.

       Both died with the mechanism. The two arms are kept verbatim — an hour of silence against an hour of
       dust swaps, identical elapsed time, deliberately different cadence — because two arms that now agree
       is the proof that cadence is no longer an input. The premise assertion is inverted with them: the
       run opens by MOVING THE PRICE 4,000e18 in each direction, and asserts that even that produces no
       surcharge to decay.
       =============================================================================================== */

    function test_E3_feeDependsOnNeitherSwapCadenceNorElapsedTimeNorDisplacement() public {
        _open(alice, -30_000, 30_000, 20_000e18);

        vm.recordLogs();
        _advance(61);
        _swapAs(victimSwapper, true, 4_000e18); // one real move
        _advance(61);
        _swapAs(victimSwapper, false, 4_000e18); // back, adding more displacement
        _advanceBlocksOnly(1);

        // THE PREMISE, INVERTED. Real two-way displacement used to raise the fee above base; that is what
        // made it decayable, and what made it manufacturable in E-2. It now does nothing at all.
        _assertEveryQuoteWasTheConstant(2, "displacement");
        uint24 peakFee = hook.currentFee(pid);
        assertEq(peakFee, D_LP_FEE, "displacement produced a surcharge");

        uint256 snap = vm.snapshotState();

        /* ---- A: exactly one long span of silence, then one dust swap. */
        vm.recordLogs();
        _advance(LONG_SPAN);
        _swapAs(victimSwapper, true, 1e12);
        _advanceBlocksOnly(1);
        uint24 quietFee = hook.currentFee(pid);
        _assertEveryQuoteWasTheConstant(1, "silence");

        vm.revertToState(snap);

        /* ---- B: the same elapsed span, but a dust swap every 60 seconds throughout. */
        vm.recordLogs();
        for (uint256 i = 0; i < 60; i++) {
            _advance(LONG_SPAN / 60);
            _swapAs(victimSwapper, true, 1e12);
        }
        _advanceBlocksOnly(1);
        uint24 keptAliveFee = hook.currentFee(pid);
        _assertEveryQuoteWasTheConstant(60, "dust cadence");

        console2.log("E3 fee after displacement       (pips):", uint256(peakFee));
        console2.log("E3 fee after 1h of silence      (pips):", uint256(quietFee));
        console2.log("E3 fee after 1h of dust swaps   (pips):", uint256(keptAliveFee));

        // Identical elapsed time, opposite cadence, same answer — and the same answer as before either arm
        // ran. A stale surcharge cannot survive an idle hour because there is no surcharge to go stale.
        assertEq(keptAliveFee, quietFee, "swap cadence changed the fee after identical elapsed time");
        assertEq(quietFee, D_LP_FEE, "an idle pool drifted off the immutable fee");
        assertEq(keptAliveFee, D_LP_FEE, "300 dust swaps moved the fee");
    }

    /// @notice The other half of "immovable": no ACTOR can move it either, including the only two
    ///         privileged ones. There is no setter on the hook, and the PoolManager's own fee setter is
    ///         reserved to the hook — and even if the stored fee somehow changed, beforeSwap re-asserts
    ///         the immutable with OVERRIDE_FEE_FLAG on every swap, so the stored value is not what a
    ///         swapper pays.
    function test_E3b_noActorCanMoveTheFee() public {
        _open(alice, -30_000, 30_000, 20_000e18);
        _advance(61);

        assertEq(_storedLpFee(), D_LP_FEE, "afterInitialize did not stamp the immutable into the pool");

        // DEPLOYER is the pool creator and the keeper — the most privileged actor in this system, and the
        // holder of the hook's only admin function, which touches the allowlist and nothing else. It is in
        // this list beside two strangers and the vault because none of them can do this.
        address[4] memory movers = [DEPLOYER, address(positions), jit, victimSwapper];
        for (uint256 i = 0; i < movers.length; i++) {
            vm.prank(movers[i]);
            vm.expectRevert(IPoolManager.UnauthorizedDynamicLPFeeUpdate.selector);
            manager.updateDynamicLPFee(pk, 100);
        }

        // Two swaps, the second one quoted from a pool that is no longer at parity, so this also fails if
        // the fee ever becomes a function of market state again rather than of who is asking.
        vm.recordLogs();
        _swapAs(victimSwapper, true, 500e18);
        _advance(3);
        _swapAs(victimSwapper, false, 700e18);
        _assertEveryQuoteWasTheConstant(2, "after the update attempts");
        assertEq(hook.currentFee(pid), D_LP_FEE, "the fee moved");
        assertEq(_storedLpFee(), D_LP_FEE, "the stored pool fee moved");
    }

    /* ===============================================================================================
       E-4.  CONTROL. None of the above touches custody. Assert that explicitly so the finding is
             scoped as a value-transfer/economics problem and not misread as a theft claim.
       =============================================================================================== */

    function test_E4_control_noneOfTheseAttacksTouchesCustody() public {
        uint256 aliceId = _open(alice, -30_000, 30_000, 20_000e18);
        uint256 jid = _open(jit, -600, 600, 2_000_000e18);

        for (uint256 i = 0; i < 6; i++) {
            _advance(61);
            _swapAs(victimSwapper, i % 2 == 0, 200e18);
        }

        vm.prank(jit);
        positions.withdrawAll(jid);
        vm.prank(alice);
        positions.withdrawAll(aliceId);

        assertEq(positions.getPosition(aliceId).liquidity, 0, "honest exit blocked");
        assertEq(positions.getPosition(jid).liquidity, 0, "attacker exit blocked");
        assertEq(positions.ownerOf(aliceId), alice, "owner mutated");
        assertEq(MockERC20(Currency.unwrap(currency0)).balanceOf(address(positions)), 0, "vault kept currency0");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(address(positions)), 0, "vault kept currency1");
    }
}
