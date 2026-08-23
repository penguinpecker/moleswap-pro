// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {ZapLogic} from "../../src/libraries/ZapLogic.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";
import {deployMoleVault, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  every sync -> transfer -> settle triple in the codebase (P-29, dossier Part 2 §4):
             MoleRouter._settle          (the v4 hop's payment)
             MoleQueue._swapExactIn      (the residual swap's payment)
             ZapLogic._settle            (the one-token deposit's pull)
           MolePositions._settleFrom is the fourth and is already attacked in
           AttackPoolAndTokens / AttackCustody (reentrantToken{Hijack,Resync,Reenter}); it is not
           repeated here.
  Lens:    "settle() credits the caller for ANY balance increase since the last sync(), so whoever
            settles next after a sync claims everything that landed in between." The ERC-20 in the
            middle of the triple is the one party that runs code between our sync and our settle.
            Give it a transfer hook and let it try: a rogue settle (steal the credit), a rogue sync
            of the other currency (re-point the credit), a rogue take (walk out with tokens), and a
            re-entry into our own entrypoint or our own callback.

  RESULT: every rogue action FAILS CLOSED on all three triples — the whole transaction reverts
  with the PoolManager's own CurrencyNotSettled, the user keeps every token, and our contract holds
  nothing. Re-entering our entrypoints hits the router's lock / the singleton's AlreadyUnlocked; re-
  entering our callback hits NotPoolManager. The queue's catch-and-rethrow does NOT convert any of
  these into a quiet in-kind refund: only the two price selectors are refund-eligible.

  WHY THE PROPERTY HOLDS, so the next reader knows what the test is pinning: (a) v4 core's
  NonzeroDeltaCount — an unlock cannot close with anyone owing or owed; and (b) none of our three
  contracts holds or spends an inventory, so there is no float a stolen credit could be absorbed by.
  Mutation: delete `poolManager.sync(...)` in any of the three triples and that contract's honest
  control leg goes RED (settle then diffs against a stale baseline and credits nothing). Widen the
  queue's catch to a blanket `if (!lenient) _rethrow(err)` and the rogue-settle-is-rethrown test goes
  RED (the stolen credit would be booked as a quiet in-kind refund). All four run; see
  HARDENING-FINDINGS.md.

  ONE PROBE DID NOT FAIL CLOSED — recorded, not patched: see `test_queue_hostileCurrencyCanFlipA
  LenientSettleIntoARefundAndDrainTheNextEpoch` and HARDENING-FINDINGS.md H-2.
//////////////////////////////////////////////////////////////////////////////*/

/// @dev ERC-777-style token that runs an arbitrary call in the middle of a transfer — but ONLY on a
///      transfer INTO the PoolManager, i.e. exactly between our sync() and our settle(). Every other
///      transfer (the pull into the router/queue, the payout to the owner) is inert, so what fires is
///      the triple and nothing else. One shot.
contract TripleReentrantToken is MockERC20 {
    address public pm;
    address public target;
    bytes public payload;
    bool public armed;
    bool public fired;
    bool public innerOk;
    bytes public innerRet;

    constructor() MockERC20("TRIPLE", "TRP", 18) {}

    function setPoolManager(address _pm) external {
        pm = _pm;
    }

    function arm(address _target, bytes memory _payload) external {
        target = _target;
        payload = _payload;
        armed = true;
        fired = false;
        innerOk = false;
        innerRet = "";
    }

    function disarm() external {
        armed = false;
    }

    function transfer(address to, uint256 amt) public override returns (bool) {
        bool ok = super.transfer(to, amt);
        _maybeFire(to);
        return ok;
    }

    function transferFrom(address from, address to, uint256 amt) public override returns (bool) {
        bool ok = super.transferFrom(from, to, amt);
        _maybeFire(to);
        return ok;
    }

    function _maybeFire(address to) internal {
        if (!armed || fired || to != pm) return;
        fired = true;
        (innerOk, innerRet) = target.call(payload);
    }
}

contract AttackHardeningSettleTriple is HardeningBase {
    using PoolIdLibrary for PoolKey;

    TripleReentrantToken internal evil;
    MockERC20 internal other;
    Currency internal cEvil;
    Currency internal cOther;
    bool internal evilIsZero;

    PoolKey internal plainKey; // hookless: vault (zap) and router worlds
    PoolKey internal evilHookKey; // hooked: the queue needs an oracle
    MolePositions internal evilVault;
    MoleQueue internal evilQueue;

    function setUp() public {
        _buildWorld(0);

        evil = new TripleReentrantToken();
        evil.setPoolManager(address(manager));
        other = new MockERC20("OTHER", "OTH", 18);
        evilIsZero = address(evil) < address(other);
        (cEvil, cOther) = (Currency.wrap(address(evil)), Currency.wrap(address(other)));
        (Currency c0, Currency c1) = evilIsZero ? (cEvil, cOther) : (cOther, cEvil);

        // Background liquidity on both pools, provided by this contract.
        evil.mint(address(this), FUNDING);
        other.mint(address(this), FUNDING);
        evil.approve(address(modifyLiquidityRouter), type(uint256).max);
        other.approve(address(modifyLiquidityRouter), type(uint256).max);
        evil.approve(address(swapRouter), type(uint256).max);
        other.approve(address(swapRouter), type(uint256).max);

        plainKey = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(plainKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            plainKey, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 50_000e18, salt: 0}), ZERO_BYTES
        );

        evilHookKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: SPACING,
            hooks: IHooks(address(hook))
        });
        manager.initialize(evilHookKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            evilHookKey, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 50_000e18, salt: 0}), ZERO_BYTES
        );
        _warmOracle(evilHookKey, 1e18);

        // A hookless vault for the zap path (the pin must equal the pool's hook).
        evilVault = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        evilVault.whitelistPool(plainKey);

        evilQueue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            evilHookKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            MAX_TWAP_DEVIATION_TICKS,
            RESIDUAL_SLIPPAGE_BPS,
            TEST_UPGRADE_ADMIN
        );

        address[3] memory users = [alice, bob, mallory];
        for (uint256 i; i < users.length; ++i) {
            evil.mint(users[i], FUNDING);
            other.mint(users[i], FUNDING);
            vm.startPrank(users[i]);
            evil.approve(address(router), type(uint256).max);
            other.approve(address(router), type(uint256).max);
            evil.approve(address(evilVault), type(uint256).max);
            other.approve(address(evilVault), type(uint256).max);
            evil.approve(address(evilQueue), type(uint256).max);
            other.approve(address(evilQueue), type(uint256).max);
            vm.stopPrank();
        }
    }

    /* ------------------------------------------------------------------ helpers */

    function _evilBal(address who) internal view returns (uint256, uint256) {
        return (evil.balanceOf(who), other.balanceOf(who));
    }

    function _assertHoldsNeither(address who, string memory when) internal view {
        assertEq(evil.balanceOf(who), 0, string.concat("holds evil: ", when));
        assertEq(other.balanceOf(who), 0, string.concat("holds other: ", when));
        assertEq(manager.balanceOf(who, cEvil.toId()), 0, string.concat("holds evil claims: ", when));
        assertEq(manager.balanceOf(who, cOther.toId()), 0, string.concat("holds other claims: ", when));
    }

    /// @dev A router plan that SPENDS evil through the hookless pool, so the v4 hop's `_settle` pays
    ///      evil into the PoolManager and the token fires inside the triple.
    function _evilPlan(uint256 amt, address recipient) internal view returns (MoleRouter.SwapPlan memory plan) {
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), evilIsZero, address(evil), address(other), plainKey);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amt, hops);
        plan = MoleRouter.SwapPlan(address(evil), address(other), amt, 1, recipient, block.timestamp + 1, paths);
    }

    function _zapEvilIn(uint256 amountIn, uint256 swapAmount) internal view returns (ZapLogic.ZapParams memory z) {
        z = ZapLogic.ZapParams({
            key: plainKey,
            tickLower: -6000,
            tickUpper: 6000,
            zeroForOne: evilIsZero, // selling evil == selling currency0 iff evil is currency0
            amountIn: amountIn,
            swapAmount: swapAmount,
            minLiquidity: 1,
            amountOutMin: 0
        });
    }

    function _rogueSettle() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("settle()");
    }

    function _rogueSyncOther() internal view returns (bytes memory) {
        return abi.encodeWithSignature("sync(address)", address(other));
    }

    function _rogueTake(address to) internal view returns (bytes memory) {
        return abi.encodeWithSignature("take(address,address,uint256)", address(evil), to, uint256(1e18));
    }

    /* ================================================================ 1. MoleRouter._settle */

    /// @notice Control: an un-armed evil token swaps cleanly. Pinned here so the failures below are
    ///         attributable to the re-entry and not to the token being unusable.
    function test_router_controlSwapSucceedsWhenTheTokenIsInert() public {
        (uint256 e0, uint256 o0) = _evilBal(alice);
        vm.prank(alice);
        uint256 got = router.swap(_evilPlan(10e18, alice));
        (uint256 e1, uint256 o1) = _evilBal(alice);
        assertGt(got, 0, "control swap produced nothing");
        assertEq(e0 - e1, 10e18, "control: input not consumed exactly");
        assertEq(o1 - o0, got, "control: output not delivered exactly");
        _assertHoldsNeither(address(router), "router after control");
        assertFalse(evil.fired(), "premise: the inert token fired");
    }

    /// @notice ATTACK: the token calls PoolManager.settle() itself between the router's sync and
    ///         settle, stealing the credit for the tokens the router just paid. The router's own
    ///         settle then credits nothing, its debt stands, and the unlock refuses to close.
    function test_router_rogueSettleInsideTheTripleFailsClosed() public {
        evil.arm(address(manager), _rogueSettle());
        (uint256 e0, uint256 o0) = _evilBal(alice);

        // NON-VACUITY. The token's own storage is rolled back with the revert, so `fired` cannot be
        // read afterwards; the trace can. The router settles ONCE per v4 hop, so exactly TWO settle()
        // calls means the rogue one was made.
        vm.expectCall(address(manager), _rogueSettle(), 2);
        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        router.swap(_evilPlan(10e18, alice));

        (uint256 e1, uint256 o1) = _evilBal(alice);
        assertEq(e1, e0, "alice lost input to a reverted swap");
        assertEq(o1, o0, "alice balance moved on a reverted swap");
        _assertHoldsNeither(address(router), "router after rogue settle");
    }

    /// @notice ATTACK: the token re-syncs the OTHER currency mid-transfer so the router's settle is
    ///         attributed to the wrong currency. Fails closed the same way.
    function test_router_rogueSyncOfAnotherCurrencyFailsClosed() public {
        evil.arm(address(manager), _rogueSyncOther());
        (uint256 e0,) = _evilBal(alice);
        // The router never syncs `other` on this plan, so one such call is the rogue one.
        vm.expectCall(address(manager), _rogueSyncOther(), 1);
        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        router.swap(_evilPlan(10e18, alice));
        (uint256 e1,) = _evilBal(alice);
        assertEq(e1, e0, "alice lost input");
        _assertHoldsNeither(address(router), "router after rogue sync");
    }

    /// @notice ATTACK: the token `take`s tokens to the attacker while the manager is unlocked. The
    ///         take succeeds at the call level — and leaves the token owing, so the unlock reverts
    ///         and the attacker's balance is rolled back with it.
    function test_router_rogueTakeInsideTheTripleIsRolledBack() public {
        evil.arm(address(manager), _rogueTake(mallory));
        (uint256 m0,) = _evilBal(mallory);
        vm.expectCall(address(manager), _rogueTake(mallory), 1);
        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        router.swap(_evilPlan(10e18, alice));
        (uint256 m1,) = _evilBal(mallory);
        assertEq(m1, m0, "mallory kept tokens taken inside a reverted unlock");
    }

    /// @notice ATTACK: the token re-enters `router.swap` mid-triple. The transient lock refuses it;
    ///         the outer swap completes EXACTLY as the inert control did.
    function test_router_reenteringSwapHitsTheLock_andTheOuterSwapIsUnchanged() public {
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        uint256 control = router.swap(_evilPlan(10e18, alice));
        vm.revertToState(snap);

        evil.arm(address(router), abi.encodeCall(MoleRouter.swap, (_evilPlan(1e18, mallory))));
        (uint256 e0, uint256 o0) = _evilBal(alice);
        vm.prank(alice);
        uint256 got = router.swap(_evilPlan(10e18, alice));

        assertTrue(evil.fired(), "vacuous");
        assertFalse(evil.innerOk(), "a nested swap got through the lock");
        assertEq(bytes4(evil.innerRet()), MoleRouter.Locked.selector, "nested swap refused for the wrong reason");
        assertEq(got, control, "the re-entry attempt changed the outer swap's output");
        (uint256 e1, uint256 o1) = _evilBal(alice);
        assertEq(e0 - e1, 10e18, "input not consumed exactly");
        assertEq(o1 - o0, got, "output not delivered exactly");
        _assertHoldsNeither(address(router), "router after nested swap attempt");
    }

    /// @notice ATTACK: the token calls `router.unlockCallback` directly from inside the triple — the
    ///         manager IS unlocked, the lock IS held — and is refused on identity alone.
    function test_router_reenteringTheCallbackDirectlyIsRefused() public {
        bytes memory forged = abi.encode(_evilPlan(5e18, mallory), alice);
        evil.arm(address(router), abi.encodeCall(MoleRouter.unlockCallback, (forged)));
        (uint256 m0, uint256 mo0) = _evilBal(mallory);
        vm.prank(alice);
        router.swap(_evilPlan(10e18, alice));
        assertTrue(evil.fired(), "vacuous");
        assertFalse(evil.innerOk(), "direct callback re-entry succeeded");
        assertEq(bytes4(evil.innerRet()), MoleRouter.NotPoolManager.selector, "wrong reason");
        (uint256 m1, uint256 mo1) = _evilBal(mallory);
        assertEq(m1, m0, "mallory profited from a forged callback");
        assertEq(mo1, mo0, "mallory profited from a forged callback");
        _assertHoldsNeither(address(router), "router after forged callback");
    }

    /* ================================================================ 2. ZapLogic._settle */

    function test_zap_controlZapSucceedsWhenTheTokenIsInert() public {
        vm.prank(alice);
        uint256 id = evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        assertGt(evilVault.getPosition(id).liquidity, 0, "control zap minted nothing");
        _assertHoldsNeither(address(evilVault), "vault after control zap");
        assertFalse(evil.fired(), "premise: inert token fired");
    }

    /// @notice ATTACK: rogue settle between the zap's sync and settle. The zap's single pull is the
    ///         triple, so the whole deposit reverts and no position survives — positionCount included,
    ///         even though zapOpen writes storage BEFORE the unlock.
    /// @dev The selector is ZeroLiquidity, not CurrencyNotSettled, and that is the interesting part:
    ///      the zap settles FIRST and swaps SECOND, so a stolen credit leaves the vault with nothing to
    ///      build a position from and the library refuses to mint a zero-sized one before the unlock
    ///      ever tries to close. Same outcome — fail closed, nothing persists — one frame earlier.
    function test_zap_rogueSettleInsideTheTripleFailsClosed() public {
        evil.arm(address(manager), _rogueSettle());
        (uint256 e0, uint256 o0) = _evilBal(alice);
        uint256 count = evilVault.positionCount();
        vm.expectCall(address(manager), _rogueSettle(), 2); // the zap's own + the rogue one
        vm.prank(alice);
        vm.expectRevert(ZapLogic.ZeroLiquidity.selector);
        evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        (uint256 e1, uint256 o1) = _evilBal(alice);
        assertEq(e1, e0, "alice paid into a reverted zap");
        assertEq(o1, o0, "alice balance moved");
        assertEq(evilVault.positionCount(), count, "a position survived a reverted zap");
        _assertHoldsNeither(address(evilVault), "vault after rogue settle");
    }

    function test_zap_rogueSyncOfAnotherCurrencyFailsClosed() public {
        evil.arm(address(manager), _rogueSyncOther());
        uint256 count = evilVault.positionCount();
        vm.expectCall(address(manager), _rogueSyncOther(), 1);
        vm.prank(alice);
        vm.expectRevert(ZapLogic.ZeroLiquidity.selector); // see the rogue-settle case above
        evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        assertEq(evilVault.positionCount(), count, "a position survived");
        _assertHoldsNeither(address(evilVault), "vault after rogue sync");
    }

    function test_zap_rogueTakeInsideTheTripleIsRolledBack() public {
        evil.arm(address(manager), _rogueTake(mallory));
        (uint256 m0,) = _evilBal(mallory);
        vm.expectCall(address(manager), _rogueTake(mallory), 1);
        vm.prank(alice);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        (uint256 m1,) = _evilBal(mallory);
        assertEq(m1, m0, "mallory kept taken tokens");
    }

    /// @notice ATTACK: re-enter `zapOpen`, `open`, and `withdraw(victim)` from inside the zap's
    ///         triple. Nested unlock -> AlreadyUnlocked; foreign withdraw -> NotOwner. The outer zap
    ///         completes and mints exactly what the inert control minted.
    function test_zap_reenteringEntrypointsIsRefused_andTheOuterZapIsUnchanged() public {
        vm.prank(bob);
        uint256 victim = evilVault.zapOpen(_zapEvilIn(50e18, 20e18), block.timestamp);

        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        uint256 cid = evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        uint128 control = evilVault.getPosition(cid).liquidity;
        vm.revertToState(snap);

        // (a) nested zapOpen
        evil.arm(address(evilVault), abi.encodeCall(MolePositions.zapOpen, (_zapEvilIn(1e18, 4e17), block.timestamp)));
        vm.prank(alice);
        uint256 id = evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        assertTrue(evil.fired(), "vacuous (a)");
        assertFalse(evil.innerOk(), "nested zapOpen succeeded");
        assertEq(bytes4(evil.innerRet()), IPoolManager.AlreadyUnlocked.selector, "(a) wrong reason");
        assertEq(evilVault.getPosition(id).liquidity, control, "re-entry changed what the outer zap minted");

        // (b) nested open
        evil.arm(
            address(evilVault),
            abi.encodeCall(
                MolePositions.open, (plainKey, int24(-600), int24(600), uint128(1e18), type(uint256).max, type(uint256).max, block.timestamp)
            )
        );
        vm.prank(alice);
        evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        assertFalse(evil.innerOk(), "nested open succeeded");
        assertEq(bytes4(evil.innerRet()), IPoolManager.AlreadyUnlocked.selector, "(b) wrong reason");

        // (c) foreign withdraw of the victim's position
        uint128 victimLiq = evilVault.getPosition(victim).liquidity;
        evil.arm(address(evilVault), abi.encodeCall(MolePositions.withdrawAll, (victim)));
        vm.prank(alice);
        evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        assertFalse(evil.innerOk(), "foreign withdraw succeeded");
        assertEq(bytes4(evil.innerRet()), MolePositions.NotOwner.selector, "(c) wrong reason");
        assertEq(evilVault.getPosition(victim).liquidity, victimLiq, "victim liquidity moved");

        // (d) our own callback, directly
        evil.arm(
            address(evilVault),
            abi.encodeCall(
                MolePositions.unlockCallback,
                (abi.encode(MolePositions.Action.Withdraw, victim, alice, -int256(uint256(victimLiq)), int24(0), int24(0), uint256(0), uint256(0)))
            )
        );
        vm.prank(alice);
        evilVault.zapOpen(_zapEvilIn(100e18, 40e18), block.timestamp);
        assertFalse(evil.innerOk(), "direct callback succeeded");
        assertEq(bytes4(evil.innerRet()), MolePositions.NotPoolManager.selector, "(d) wrong reason");
        assertEq(evilVault.getPosition(victim).liquidity, victimLiq, "victim liquidity moved (d)");
        _assertHoldsNeither(address(evilVault), "vault after re-entry probes");
    }

    /* ================================================================ 3. MoleQueue._swapExactIn */

    /// @dev Place a one-sided evil order so settlement runs the residual swap on the evil leg, freeze,
    ///      and sit inside the settlement window. Returns the epoch.
    function _oneSidedEvilEpoch(uint128 amount) internal returns (uint64 e) {
        e = evilQueue.currentEpoch();
        vm.prank(alice);
        evilQueue.place(evilIsZero, amount);
        _advance(EPOCH_DURATION);
        evilQueue.freeze();
        _advance(FREEZE_DURATION);
    }

    function test_queue_controlSettleSucceedsWhenTheTokenIsInert() public {
        uint64 e = _oneSidedEvilEpoch(10e18);
        evilQueue.settle(e);
        (MoleQueue.Phase p,,,,,,,) = evilQueue.epochs(e);
        assertEq(uint8(p), uint8(MoleQueue.Phase.Settled), "control did not settle");
        assertFalse(evil.fired(), "premise: inert token fired");
    }

    /// @notice ATTACK: rogue settle inside the residual swap's triple. The inner unlock reverts with
    ///         CurrencyNotSettled; the queue's catch recognises it is NOT a price failure and re-throws
    ///         it verbatim — no quiet refund, no half-done swap, escrow untouched, epoch still Frozen,
    ///         and the in-kind exit (timeout -> claim) still works afterwards.
    function test_queue_rogueSettleInsideTheResidualTripleIsRethrownNotRefunded() public {
        uint64 e = _oneSidedEvilEpoch(10e18);
        evil.arm(address(manager), _rogueSettle());
        uint256 qBefore = evil.balanceOf(address(evilQueue));

        // Two settlement attempts below, each = the queue's own settle() + the rogue one: four in all.
        // (A counted expectCall can only be armed once per test.)
        vm.expectCall(address(manager), _rogueSettle(), 4);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        evilQueue.settle(e);
        assertEq(evil.balanceOf(address(evilQueue)), qBefore, "escrow moved on a reverted settlement");
        (MoleQueue.Phase p,,,,,, uint128 r0, uint128 r1) = evilQueue.epochs(e);
        assertEq(uint8(p), uint8(MoleQueue.Phase.Frozen), "a non-price failure changed the phase");
        assertEq(uint256(r0) + r1, 0, "a non-price failure was booked as an in-kind refund");

        // Past the deadline the failure is STILL re-thrown (not refund-eligible)...
        _advance(MAX_EPOCH_LIFE);
        evil.arm(address(manager), _rogueSettle());
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        evilQueue.settle(e);
        // ...and the escape hatch is intact: timeout, then reclaim in kind, to the wei.
        evil.disarm();
        evilQueue.timeout(e);
        (uint256 a0,) = _evilBal(alice);
        vm.prank(alice);
        evilQueue.claim(e, 0);
        (uint256 a1,) = _evilBal(alice);
        assertEq(a1 - a0, 10e18, "reclaim did not return the escrow in kind");
        _assertHoldsNeither(address(evilQueue), "queue after reclaim");
    }

    function test_queue_rogueSyncOfAnotherCurrencyIsRethrownNotRefunded() public {
        uint64 e = _oneSidedEvilEpoch(10e18);
        evil.arm(address(manager), _rogueSyncOther());
        uint256 qBefore = evil.balanceOf(address(evilQueue));
        vm.expectCall(address(manager), _rogueSyncOther(), 1);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        evilQueue.settle(e);
        assertEq(evil.balanceOf(address(evilQueue)), qBefore, "escrow moved");
        (MoleQueue.Phase p,,,,,,,) = evilQueue.epochs(e);
        assertEq(uint8(p), uint8(MoleQueue.Phase.Frozen), "phase changed");
    }

    function test_queue_rogueTakeInsideTheResidualTripleIsRolledBack() public {
        uint64 e = _oneSidedEvilEpoch(10e18);
        evil.arm(address(manager), _rogueTake(mallory));
        (uint256 m0,) = _evilBal(mallory);
        vm.expectCall(address(manager), _rogueTake(mallory), 1);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        evilQueue.settle(e);
        (uint256 m1,) = _evilBal(mallory);
        assertEq(m1, m0, "mallory kept taken tokens");
    }

    /// @notice ATTACK: re-enter `settle(e)` from inside its own residual swap. The nested unlock is
    ///         refused by the singleton, the queue re-throws it, the token swallows it, and the OUTER
    ///         settlement completes with exactly the control's outputs.
    function test_queue_reenteringSettleIsRefused_andTheOuterSettlementIsUnchanged() public {
        uint64 e = _oneSidedEvilEpoch(10e18);
        uint256 snap = vm.snapshotState();
        evilQueue.settle(e);
        (,,,, uint128 cOut0, uint128 cOut1,,) = evilQueue.epochs(e);
        vm.revertToState(snap);

        evil.arm(address(evilQueue), abi.encodeCall(MoleQueue.settle, (e)));
        evilQueue.settle(e);
        assertTrue(evil.fired(), "vacuous");
        assertFalse(evil.innerOk(), "nested settle succeeded");
        assertEq(bytes4(evil.innerRet()), IPoolManager.AlreadyUnlocked.selector, "wrong reason");
        (MoleQueue.Phase p,,,, uint128 out0, uint128 out1,,) = evilQueue.epochs(e);
        assertEq(uint8(p), uint8(MoleQueue.Phase.Settled), "outer did not settle");
        assertEq(out0, cOut0, "re-entry changed out0");
        assertEq(out1, cOut1, "re-entry changed out1");
    }

    /// @notice ATTACK: re-enter `unlockCallback` directly from inside the residual swap, with a payload
    ///         that would swap the rest of the escrow at any price. Refused on identity.
    function test_queue_reenteringTheCallbackDirectlyIsRefused() public {
        uint64 e = _oneSidedEvilEpoch(10e18);
        evil.arm(
            address(evilQueue),
            abi.encodeCall(MoleQueue.unlockCallback, (abi.encode(uint128(1e18), uint128(0), uint256(1))))
        );
        evilQueue.settle(e);
        assertTrue(evil.fired(), "vacuous");
        assertFalse(evil.innerOk(), "direct callback succeeded");
        assertEq(bytes4(evil.innerRet()), MoleQueue.NotPoolManager.selector, "wrong reason");
    }

    /// @notice PROBE, PAST THE DEADLINE: the hostile currency re-enters `timeout(e)` and then
    ///         `claim(e, own order)` from inside the lenient settlement's residual swap. The epoch is
    ///         already past `maxEpochLife`, so `timeout` succeeds mid-settle (phase -> Refunding), the
    ///         in-kind claim pays the attacker's FULL input back out of the queue's pooled balance —
    ///         which at that instant is the remaining crossed escrow of this epoch PLUS the next
    ///         epoch's fresh escrow — and then the outer `settle` finishes and stamps Settled over it.
    ///
    ///         Expected property: a settlement cannot be re-phased underneath itself, so the attacker's
    ///         order ends either Settled-and-claimable or Refunded, never refunded from inside its own
    ///         settlement, and epoch e+1's escrow is whole. RED TODAY — see HARDENING-FINDINGS.md H-2.
    function test_queue_hostileCurrencyCanFlipALenientSettleIntoARefundAndDrainTheNextEpoch() public {
        // Epoch 0: the attacker (a contract that is also the hostile token's re-entry target) sells
        // 100 evil; bob buys 40 evil-worth on the other side, so part crosses at TWAP and the rest is
        // a residual that must go through the pool — which is where the token fires.
        TimeoutThenClaim attacker = new TimeoutThenClaim(evilQueue, 0, 0);
        evil.mint(address(attacker), 100e18);
        attacker.approveAndPlace(evil, evilIsZero, 100e18);
        vm.prank(bob);
        evilQueue.place(!evilIsZero, 40e18);
        _advance(EPOCH_DURATION);
        evilQueue.freeze();

        // Epoch 1: an honest depositor (mallory) parks fresh evil escrow in the SAME queue.
        vm.prank(mallory);
        uint256 mIdx = evilQueue.place(evilIsZero, 100e18);
        uint64 next = evilQueue.currentEpoch();

        // Past the deadline: lenient settlement is now the only kind there is.
        _advance(FREEZE_DURATION + MAX_EPOCH_LIFE);
        uint256 attackerBefore = evil.balanceOf(address(attacker));

        evil.arm(address(attacker), abi.encodeCall(TimeoutThenClaim.run, ()));
        evilQueue.settle(0);
        assertTrue(evil.fired(), "vacuous: the residual triple never ran");
        (MoleQueue.Phase p,,,,,,,) = evilQueue.epochs(0);

        // THE PROPERTY: no order is refunded in kind from inside the settlement of its own epoch.
        assertFalse(attacker.claimOk(), "H-2: an in-kind claim was paid from INSIDE the settlement of the same epoch");
        assertEq(
            evil.balanceOf(address(attacker)), attackerBefore, "H-2: the attacker was refunded in kind during settlement"
        );
        assertEq(uint8(p), uint8(MoleQueue.Phase.Settled), "epoch 0 did not end Settled");

        // And epoch 1's escrow must be whole: mallory reclaims in kind after its own timeout.
        _advance(EPOCH_DURATION + MAX_EPOCH_LIFE + 1);
        evilQueue.timeout(next);
        (uint256 mBefore,) = _evilBal(mallory);
        vm.prank(mallory);
        evilQueue.claim(next, mIdx);
        (uint256 mAfter,) = _evilBal(mallory);
        assertEq(mAfter - mBefore, 100e18, "H-2: the next epoch's depositor was short-paid");
    }
}

/// @dev The H-2 attacker: owns an order in the epoch being settled, and — called by the hostile token
///      from inside that settlement's residual swap — times the epoch out and claims itself in kind.
contract TimeoutThenClaim {
    MoleQueue public immutable q;
    uint64 public immutable epoch;
    uint256 public immutable index;
    bool public timeoutOk;
    bool public claimOk;
    bytes public claimRet;

    constructor(MoleQueue _q, uint64 _epoch, uint256 _index) {
        q = _q;
        epoch = _epoch;
        index = _index;
    }

    function approveAndPlace(MockERC20 token, bool zeroForOne, uint128 amount) external {
        token.approve(address(q), type(uint256).max);
        q.place(zeroForOne, amount);
    }

    function run() external {
        (timeoutOk,) = address(q).call(abi.encodeCall(MoleQueue.timeout, (epoch)));
        (claimOk, claimRet) = address(q).call(abi.encodeCall(MoleQueue.claim, (epoch, index)));
    }
}
