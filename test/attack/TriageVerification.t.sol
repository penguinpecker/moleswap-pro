// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////

    TriageVerification — originally an independent re-derivation of the EXPLOITABLE claims made
    against src/MolePositions.sol by five separate attacker agents on 2026-08-01. The findings were
    fixed on 2026-08-02; this file was repaired on 2026-08-03 into the PERMANENT REGRESSION SUITE
    for that fix. The attack machinery is untouched — every exploit is still attempted, in full, with
    the same actors, the same ordering and the same atomicity. Only the expected OUTCOME changed, and
    every changed expectation is justified below.

    THE FIX, in one paragraph, because every assertion here traces back to it. rebalance() used to
    hold the LIQUIDITY NUMBER constant while moving the RANGE. The token value of a fixed L depends
    on range width, so re-minting the same L at a narrower range needed fewer tokens and left a
    surplus; `_settleNet` parked that surplus in address(this) — one unattributed pot shared by every
    position — and funded widening rebalances out of it. rebalance() now conserves TOKEN AMOUNTS: it
    burns, reads the amounts actually returned (principal AND accrued fees), derives the new
    liquidity with LiquidityAmounts.getLiquidityForAmounts at the new range (rounds down), and pays
    the leftover dust to the OWNER via _collectTo. `_settleNet` was deleted. The contract holds no
    inventory and spends none.

    THE ONE INVARIANT THAT KILLS F1/F2/F3/F5/F7 AT ONCE, and the reason most tests below assert it:

        t0.balanceOf(address(mole)) == 0 && t1.balanceOf(address(mole)) == 0, always.

    That is exactly what the deleted _settleNet used to accumulate. It is asserted as an equality to
    zero, not as a bound, and it is asserted after every single leg of every attack — so the pot
    cannot come back by any route, including a route nobody has thought of yet. It is preferred over
    asserting a revert string because it survives refactors: any future change that gives this
    contract a token balance re-arms the theft primitive and fails these tests.

    CONSEQUENCE FOR TEST EXPECTATIONS (this is the "old semantics" rewrite, stated once). A position's
    liquidity NUMBER now changes across a rebalance, because the token amounts are what is conserved.
    Narrowing buys MORE liquidity with the same tokens; widening buys LESS. Tests that opened with
    L=X, rebalanced, then withdrew the literal X are wrong on the new (correct) semantics and now
    withdraw getPosition(id).liquidity instead. That is the fix working, not a bug.

    STATUS OF EACH 2026-08-01 FINDING

    DEAD — converted to regression, exploit still attempted in full
      F1  keeper narrows a victim into the pot, widens its own position out of the pot, withdraws.
          Now: no pot forms (balance is 0 after every leg), the keeper's widen shrinks its OWN
          liquidity instead of being funded, and the keeper cannot end the sequence up on either
          token. The victim recovers her deposit.
          -> test_regression_keeperCannotMoveVictimPrincipalIntoItsOwnWallet
          -> testFuzz_regression_narrowingRebalanceStrandsNothingAndOwnerKeepsValue
      F2  a same-range rebalance confiscated the owner's fees. Now those fees are inside the burn
          amounts, so they COMPOUND: the position's liquidity strictly INCREASES across a no-op
          rebalance, and the rebalanced LP is not worse off than an identical untouched control.
          -> test_regression_sameRangeRebalanceCompoundsOwnerFeesIntoLiquidity
      F3  the pot was a black hole nobody could empty. There is no pot to empty.
          -> test_regression_noUnattributedPotEverForms
      F4  whitelistPool() validated no hook at all. It is now a FAIL-CLOSED ALLOWLIST on hook
          IDENTITY: the pool's hook must equal the compiled-in `moleHook` pin (address(0) in the
          interim, before MoleHook ships) or admission reverts HookNotPermitted. A lockable pool —
          indeed ANY pool carrying a foreign hook — can never be listed, so open() can never take a
          deposit into one. This is strictly stronger than the old remove-path-bit filter: it refuses
          a foreign hook whether or not it carries a remove bit.
          -> test_regression_whitelistRejectsBlockingHookSoNoDepositCanBeTrapped
          -> test_regression_whitelistAdmitsOnlyTheHooklessPinAndRejectsEveryForeignHook
      F4b a hook carrying AFTER_ADD_LIQUIDITY_RETURNS_DELTA (0x0002, no remove bit) used to pass the
          old remove-path-only filter, name an inflated bill on open() and drain the opener's whole
          allowance (finding F-1). Under the fail-closed allowlist that hook is foreign — its identity
          is not moleHook — so whitelistPool reverts HookNotPermitted, the hostile pool can never be
          listed, and the drain is unreachable at admission, strictly earlier than the amount cap that
          was its only backstop. The hostile hook and its take() are still deployed and still refused;
          the amount-cap defence is preserved on an admissible pool in the same test.
          -> test_regression_hostileHookCannotBeWhitelistedSoItsAllowanceDrainIsUnreachable
      F5  the first rebalance of a fresh deployment reverted TransferFailed because _settleNet paid
          a wei-sized deficit out of an empty contract. Nothing is paid out of the contract now, so
          a fresh deployment rebalances on its first try with no donation from anyone.
          -> test_regression_freshDeploymentFirstRebalanceNeedsNoDonation
      F6  open() had no maximum spend and no deadline. It now takes amount0Max/amount1Max/deadline
          and reverts ExceedsMaxAmount / DeadlinePassed. The price-manipulation attack is still run
          in full and is now stopped by the cap.
          -> test_regression_openEnforcesMaxAmountsAndDeadlineAgainstAPriceMove
      F7  openedAtL1Block enabled a zero-L1-dwell extraction. The extraction yields nothing now.
          -> test_regression_zeroL1DwellExtractionYieldsNothing

    NO FINDING LEFT LIVE — the fail-closed allowlist closed the last one
      The 2026-08-03 suite left F4b (above) as a passing test_attack_*, because whitelistPool then
      filtered on the remove-path bits ONLY and so still admitted a foreign non-remove hook. Admission
      is now deny-by-default on hook identity (see the src header), which removes the last admissible
      foreign hook: nothing in this file is deliberately left red or left exploitable. The amount cap
      remains a real, independently-tested defence for honest-but-mispriced opens (F6); it is simply no
      longer the only thing standing between a user and a hostile hook.

    RESIDUAL OBSERVATION (not a value-extraction path, not left red)
      Position.openedAtL1Block is still stamped at open() and read by nothing, and the declared
      error DwellNotElapsed is never used. The dwell guard the contract header argues for is still
      not implemented. Nothing can be extracted with it absent, so this is a doc/code mismatch
      rather than a finding; it is recorded here and pinned in the F7 regression.

    REFUTED / holds up — unchanged
      R1  unlockCallback() is not reachable with attacker-chosen calldata.
          -> test_attack_unlockCallbackDirectCallIsRejected
      R2  Payout targeting is honest. No caller-supplied address is ever paid.
          -> test_attack_noThirdPartyCanWithdrawOrRebalance

    ------------------------------------------------------------------------------------------
    ENVIRONMENT NOTE. This file does not import PoolManager or Deployers; the canonical creation code
    from lib/v4-core/src/PoolManager.sol is embedded at the bottom and CREATEd in setUp(). That was
    originally a workaround for optimizer_runs = 800, which solc 0.8.26 + via_ir cannot use to
    compile v4-core's PoolManager at all ("stack too deep" in Pool.swap); foundry.toml now carries
    44444444 and the import would work, but the embedded bytecode is kept because it pins the exact
    PoolManager these numbers were measured against. This is a real v4 PoolManager, not a mock:
    every number below comes from v4's own liquidity math.

//////////////////////////////////////////////////////////////////////////////*/

import {Test, console2} from "forge-std/Test.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice Hook carrying ONLY BEFORE_REMOVE_LIQUIDITY_FLAG (1 << 9 = 0x200). Accepts everything the
///         PoolManager can reach without that bit (initialize, add liquidity, swap) and reverts on
///         the one callback it does receive: the withdrawal path.
contract BlockingRemoveHook {
    fallback() external {
        revert("hook: exits are closed");
    }
}

/// @notice Hook carrying AFTER_ADD_LIQUIDITY_FLAG (1 << 10) + AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG
///         (1 << 1). It names an extra amount on the add-liquidity delta; the PoolManager charges
///         that to the caller (MolePositions) and credits it to the hook, which takes it and walks.
///         MolePositions then pulls the whole bill from the opener's ERC-20 approval in _payOwed.
contract AllowanceDrainHook {
    IPoolManager public pm;
    address public loot;
    uint128 public extra;

    function arm(IPoolManager _pm, address _loot, uint128 _extra) external {
        pm = _pm;
        loot = _loot;
        extra = _extra;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata k,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external returns (bytes4, BalanceDelta) {
        pm.take(k.currency1, loot, extra);
        return (AllowanceDrainHook.afterAddLiquidity.selector, toBalanceDelta(0, int128(extra)));
    }

    fallback() external {
        revert("unreachable");
    }
}

contract TriageVerification is Test {
    using PoolIdLibrary for PoolKey;

    /* ------------------------------------------------------------------ fixture */

    IPoolManager internal manager;
    PoolModifyLiquidityTest internal lpRouter;
    PoolSwapTest internal swapRouter;
    MolePositions internal mole;

    MockERC20 internal t0;
    MockERC20 internal t1;
    Currency internal c0;
    Currency internal c1;
    PoolKey internal key;

    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice"); // honest depositor
    address internal carol = makeAddr("carol"); // honest control depositor
    address internal mallory = makeAddr("mallory"); // unprivileged attacker

    uint160 internal constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint160 internal constant MIN_PRICE_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_PRICE_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    /// @dev v4 rounds against the LP by a wei or so per modifyLiquidity leg, and
    ///      getLiquidityForAmounts rounds the re-mint down. Measured worst case across this file is
    ///      2 wei per currency per round trip. Kept this tight on purpose: the failure mode these
    ///      tests exist to catch moves percentages of a deposit, so a slack of 1e6 would have let the
    ///      original F1 through on small positions.
    uint256 internal constant ROUNDING_WEI = 1000;

    uint32 internal constant MIN_INTERVAL = 1 hours;
    int24 internal constant MIN_WIDTH = 60;
    int24 internal constant MAX_WIDTH = 200_000;
    int24 internal constant SPACING = 60;

    function setUp() public {
        manager = _deployPoolManager(address(this));
        lpRouter = new PoolModifyLiquidityTest(manager);
        swapRouter = new PoolSwapTest(manager);

        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        (t0, t1) = address(a) < address(b) ? (a, b) : (b, a);
        c0 = Currency.wrap(address(t0));
        c1 = Currency.wrap(address(t1));

        mole = deployMoleVault(manager, keeper, MIN_INTERVAL, MIN_WIDTH, MAX_WIDTH, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));

        key = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(address(0))});
        manager.initialize(key, SQRT_PRICE_1_1);
        mole.whitelistPool(key);

        address[5] memory who = [alice, carol, mallory, keeper, address(this)];
        for (uint256 i; i < who.length; ++i) {
            t0.mint(who[i], 1e30);
            t1.mint(who[i], 1e30);
            vm.startPrank(who[i]);
            t0.approve(address(mole), type(uint256).max);
            t1.approve(address(mole), type(uint256).max);
            t0.approve(address(lpRouter), type(uint256).max);
            t1.approve(address(lpRouter), type(uint256).max);
            t0.approve(address(swapRouter), type(uint256).max);
            t1.approve(address(swapRouter), type(uint256).max);
            vm.stopPrank();
        }

        // Deep background liquidity so swaps in these tests are price-takers, not the whole book.
        lpRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -120_000, tickUpper: 120_000, liquidityDelta: 5e21, salt: 0}),
            ""
        );
    }

    /*//////////////////////////////////////////////////////////////////////////
                    F1 — the keeper takes tokens. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: three keeper-legal txs (narrow victim -> pot, widen own position <- pot, withdraw) moved
    /// a victim's principal into the keeper's wallet at ~86x its stake. Now pins: the pot never forms
    /// (contract balance is exactly 0 after every leg), the keeper's widen shrinks its OWN liquidity
    /// instead of being funded by anyone, the keeper cannot end the sequence up on either token, and
    /// the victim recovers her deposit.
    function test_regression_keeperCannotMoveVictimPrincipalIntoItsOwnWallet() public {
        // --- victim opens a wide, ordinary position.
        uint256 aliceIn0 = t0.balanceOf(alice);
        uint256 aliceIn1 = t1.balanceOf(alice);
        vm.prank(alice);
        uint256 victim = mole.open(key, -6000, 6000, 25e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 aliceDeposit0 = aliceIn0 - t0.balanceOf(alice);
        uint256 aliceDeposit1 = aliceIn1 - t1.balanceOf(alice);
        assertGt(aliceDeposit0, 0, "victim deposited nothing");

        // --- keeper opens the cheapest position the bounds allow, as itself.
        uint256 keeperIn0 = t0.balanceOf(keeper);
        uint256 keeperIn1 = t1.balanceOf(keeper);
        vm.prank(keeper);
        uint256 sink = mole.open(key, -60, 60, 20e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 keeperStake0 = keeperIn0 - t0.balanceOf(keeper);
        uint256 keeperStake1 = keeperIn1 - t1.balanceOf(keeper);

        assertEq(t0.balanceOf(address(mole)), 0, "precondition: pot empty");
        assertEq(t1.balanceOf(address(mole)), 0, "precondition: pot empty");

        // One wait, up front, to clear the per-position interval for BOTH ids. Everything after this
        // point happens at a single timestamp and a single block height: the victim gets no window
        // in which to react, and on a no-mempool single-sequencer chain nobody could interleave
        // anything even if they saw it coming.
        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        uint256 atT = block.timestamp;
        uint256 atN = block.number;

        // --- (1) squeeze the victim to the minimum legal width. This is the leg that used to strand
        //         the victim's surplus in the shared pot. It now strands NOTHING: the surplus buys
        //         the victim more liquidity at the narrower range, and the dust goes to the victim.
        uint128 victimLbefore = mole.getPosition(victim).liquidity;
        uint256 aliceMid0 = t0.balanceOf(alice);
        uint256 aliceMid1 = t1.balanceOf(alice);
        vm.prank(keeper);
        mole.rebalance(victim, -60, 60);
        _assertNoPot("after the victim squeeze");
        uint128 victimLafter = mole.getPosition(victim).liquidity;
        // Correct post-fix semantics: token amounts are conserved, so a narrower range buys MORE L.
        assertGt(victimLafter, victimLbefore, "narrowing did not buy the victim more liquidity");
        // Any leftover the mint could not use was paid to the victim, never to the contract.
        assertGe(t0.balanceOf(alice), aliceMid0, "victim lost currency0 on the squeeze");
        assertGe(t1.balanceOf(alice), aliceMid1, "victim lost currency1 on the squeeze");

        // --- (2) widen the keeper's OWN position. This is the leg that used to be FUNDED out of the
        //         pot. With no pot to draw on, the same tokens simply buy less liquidity at the wider
        //         range, so the attack's funding step is now a self-financed shrink.
        uint128 sinkLbefore = mole.getPosition(sink).liquidity;
        vm.prank(keeper);
        mole.rebalance(sink, -6000, 6000);
        _assertNoPot("after the keeper widens its own position");
        uint128 sinkLafter = mole.getPosition(sink).liquidity;
        assertLt(sinkLafter, sinkLbefore, "widening was funded from somewhere");

        // --- (3) withdraw the keeper's own position, in full. Payout target is positions[id].owner
        //         = keeper, exactly as before: the permission split was never the problem.
        vm.prank(keeper);
        mole.withdraw(sink, sinkLafter);
        _assertNoPot("after the keeper withdraws");

        assertEq(block.timestamp, atT, "steps 1-3 were not atomic in time");
        assertEq(block.number, atN, "steps 1-3 were not atomic in height");

        int256 keeperNet0 = int256(t0.balanceOf(keeper)) - int256(keeperIn0);
        int256 keeperNet1 = int256(t1.balanceOf(keeper)) - int256(keeperIn1);
        console2.log("keeper stake c0", keeperStake0);
        console2.log("keeper stake c1", keeperStake1);
        console2.log("keeper NET c0", keeperNet0);
        console2.log("keeper NET c1", keeperNet1);

        // THE HEADLINE. The whole sequence is still executed, by the same keeper, atomically; it just
        // does not pay. The keeper cannot end up holding more of either token than it started with.
        assertLe(keeperNet0, 0, "keeper profited in currency0");
        assertLe(keeperNet1, 0, "keeper profited in currency1");
        // And what it did lose is v4's rounding against the LP, not a share of anyone's principal.
        assertLt(uint256(-keeperNet0), ROUNDING_WEI, "keeper's own round-trip lost more than dust in c0");
        assertLt(uint256(-keeperNet1), ROUNDING_WEI, "keeper's own round-trip lost more than dust in c1");

        // --- and the victim, withdrawing 100% of the liquidity she owns, is made whole.
        vm.prank(alice);
        mole.withdraw(victim, victimLafter);
        _assertNoPot("after the victim withdraws");

        // Everything alice ever received back, including the rebalance dust paid to her directly.
        uint256 got0 = t0.balanceOf(alice) + aliceDeposit0 - aliceIn0;
        uint256 got1 = t1.balanceOf(alice) + aliceDeposit1 - aliceIn1;
        console2.log("victim deposited c0 / recovered c0", aliceDeposit0, got0);
        console2.log("victim deposited c1 / recovered c1", aliceDeposit1, got1);
        // Was: recovered under 10% of the deposit. Now: recovers essentially all of it. The bound is
        // deliberately per-currency, so a fix that merely rebalanced her into the other token fails.
        assertGe(got0, aliceDeposit0 - ROUNDING_WEI, "victim did not recover currency0");
        assertGe(got1, aliceDeposit1 - ROUNDING_WEI, "victim did not recover currency1");

        assertEq(mole.ownerOf(victim), alice, "owner mutated");
        assertEq(mole.ownerOf(sink), keeper, "owner mutated");
    }

    /// Was: for any size and any narrower target, a narrowing rebalance moved owner value into the
    /// pot and the owner could not withdraw it back out. Now pins the same sweep of sizes and target
    /// widths against the invariant that replaced it: the contract holds exactly zero afterwards, the
    /// narrower range buys strictly more liquidity, and the owner's round trip is whole to within
    /// v4's rounding.
    function testFuzz_regression_narrowingRebalanceStrandsNothingAndOwnerKeepsValue(uint128 liqRaw, uint16 hwRaw)
        public
    {
        uint128 liq = uint128(bound(uint256(liqRaw), 1e15, 200e18));
        int24 halfWidth = int24(uint24(bound(uint256(hwRaw), 1, 50) * 60)); // 60 .. 3000, on spacing

        uint256 in0 = t0.balanceOf(alice);
        uint256 in1 = t1.balanceOf(alice);
        vm.prank(alice);
        uint256 id = mole.open(key, -30000, 30000, liq, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 dep0 = in0 - t0.balanceOf(alice);
        uint256 dep1 = in1 - t1.balanceOf(alice);

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(id, -halfWidth, halfWidth);

        // The pot the exploit was built out of. Exactly zero, not "small".
        assertEq(t0.balanceOf(address(mole)), 0, "narrowing rebalance stranded currency0 in the contract");
        assertEq(t1.balanceOf(address(mole)), 0, "narrowing rebalance stranded currency1 in the contract");

        uint128 newL = mole.getPosition(id).liquidity;
        assertGt(newL, liq, "narrowing did not buy more liquidity with the same tokens");

        vm.prank(alice);
        mole.withdraw(id, newL); // 100% of what she owns, at the post-rebalance liquidity number

        assertEq(t0.balanceOf(address(mole)), 0, "withdrawal left currency0 in the contract");
        assertEq(t1.balanceOf(address(mole)), 0, "withdrawal left currency1 in the contract");

        // Round trip measured from before the deposit: rebalance dust was paid straight to her, so
        // this covers every wei that ever left or entered her wallet.
        uint256 out0 = t0.balanceOf(alice) + dep0 - in0;
        uint256 out1 = t1.balanceOf(alice) + dep1 - in1;
        assertGe(out0 + out1, dep0 + dep1 - ROUNDING_WEI, "owner did not recover their deposit after a narrowing");
    }

    /*//////////////////////////////////////////////////////////////////////////
            F2 — fees confiscated by a no-op rebalance. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: the most benign call the keeper can make — rebalance to the range the position is already
    /// in — stripped every fee the owner had accrued into the pot, leaving liquidity byte-identical.
    /// Now pins the property that killed it: because the fees come back inside the burn amounts and
    /// are re-minted, a SAME-RANGE rebalance strictly INCREASES the position's liquidity, confiscates
    /// nothing, and leaves the rebalanced LP no worse off than the identical untouched control.
    function test_regression_sameRangeRebalanceCompoundsOwnerFeesIntoLiquidity() public {
        uint256 aliceIn = t0.balanceOf(alice) + t1.balanceOf(alice);
        uint256 carolIn = t0.balanceOf(carol) + t1.balanceOf(carol);

        vm.prank(alice);
        uint256 victim = mole.open(key, -6000, 6000, 50e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.prank(carol);
        uint256 control = mole.open(key, -6000, 6000, 50e18, type(uint256).max, type(uint256).max, block.timestamp);

        for (uint256 i; i < 8; ++i) {
            _swap(i % 2 == 0, 20e18);
        }

        MolePositions.Position memory beforeP = mole.getPosition(victim);
        _assertNoPot("precondition");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(victim, -6000, 6000); // identical range

        MolePositions.Position memory afterP = mole.getPosition(victim);
        assertEq(afterP.tickLower, beforeP.tickLower, "ticks moved");
        assertEq(afterP.tickUpper, beforeP.tickUpper, "ticks moved");

        // THE PROPERTY THAT KILLED F2. The fees are inside the amounts the burn returned, so the
        // re-mint at the same range buys MORE liquidity than the position had. They compounded into
        // the owner's own position; they were not swept anywhere. This is the single assertion that
        // would fail again the moment a sweep of any kind is reintroduced.
        assertGt(afterP.liquidity, beforeP.liquidity, "same-range rebalance did not compound the owner's fees");
        console2.log("liquidity before / after same-range rebalance", beforeP.liquidity, afterP.liquidity);

        // And nothing was confiscated: exactly zero, in both currencies.
        assertEq(t0.balanceOf(address(mole)), 0, "no-op rebalance confiscated currency0");
        assertEq(t1.balanceOf(address(mole)), 0, "no-op rebalance confiscated currency1");

        // Both LPs exit in full. Alice must withdraw her post-rebalance liquidity, not the literal
        // 50e18 she opened with — that number is no longer what she owns, and that is correct.
        vm.prank(alice);
        mole.withdraw(victim, afterP.liquidity);
        vm.prank(carol);
        mole.withdraw(control, 50e18);
        _assertNoPot("after both LPs exit");

        // Same deposit, same fees, same range: the rebalanced LP is not worse off than the control.
        // (aliceIn/carolIn are pre-deposit balances, so the rebalance dust paid directly to alice is
        // included and cannot be used to hide a shortfall.)
        uint256 aliceOut = t0.balanceOf(alice) + t1.balanceOf(alice);
        uint256 carolOut = t0.balanceOf(carol) + t1.balanceOf(carol);
        int256 aliceNet = int256(aliceOut) - int256(aliceIn);
        int256 carolNet = int256(carolOut) - int256(carolIn);
        console2.log("alice net (rebalanced)", aliceNet);
        console2.log("carol net (control)   ", carolNet);
        assertGe(aliceNet, carolNet - int256(ROUNDING_WEI), "rebalanced LP was worse off than the untouched control");
        // Both earned fees on the same position; neither ended the test down on their deposit.
        assertGt(aliceNet, 0, "rebalanced LP did not keep its fees");
        assertGt(carolNet, 0, "control LP did not earn fees; the test proves nothing");
    }

    /*//////////////////////////////////////////////////////////////////////////
                   F3 — the pot is a black hole. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: once value reached address(this) nobody could get it out — no sweep, no owner, no rescue,
    /// and the only exit was F1's widening leg, which only the keeper could pull. Now pins the reason
    /// that stopped mattering: the black hole has no input. The same narrowing rebalance is run, and
    /// the contract's balance is exactly zero before it, after it, after the owner's full exit, and
    /// after every remaining door has been tried. There is still no rescue function — there is still
    /// nothing to rescue, and that ordering is the point.
    function test_regression_noUnattributedPotEverForms() public {
        uint256 in0 = t0.balanceOf(alice);
        uint256 in1 = t1.balanceOf(alice);
        vm.prank(alice);
        uint256 id = mole.open(key, -30000, 30000, 60e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 dep0 = in0 - t0.balanceOf(alice);
        uint256 dep1 = in1 - t1.balanceOf(alice);
        _assertNoPot("after open");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(id, -60, 60);
        _assertNoPot("after the narrowing that used to fill the pot");

        // The owner empties the position completely, at the liquidity she actually owns now.
        uint128 newL = mole.getPosition(id).liquidity;
        assertGt(newL, 60e18, "narrowing did not buy more liquidity with the same tokens");
        vm.prank(alice);
        mole.withdraw(id, newL);
        _assertNoPot("after the owner's full withdrawal");
        assertEq(mole.getPosition(id).liquidity, 0, "position not empty");

        // She got her deposit back. Nothing was left behind for a rescue function to need to reach.
        assertGe(t0.balanceOf(alice) + dep0 - in0 + t1.balanceOf(alice) + dep1 - in1, dep0 + dep1 - ROUNDING_WEI, "owner short");

        // And every remaining door is still shut — the permission surface is unchanged, which is why
        // the absence of an inventory is what has to carry the guarantee.
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolAlreadyWhitelisted.selector);
        mole.whitelistPool(key);

        vm.prank(alice);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.withdraw(id, 0);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1);

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        vm.expectRevert(MolePositions.ZeroLiquidity.selector);
        mole.rebalance(id, -6000, 6000); // position is empty; the keeper cannot even re-route it

        _assertNoPot("after every remaining door has been tried");
    }

    /*//////////////////////////////////////////////////////////////////////////
          F4 — the whitelist validated no hook at all. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: anyone could whitelist a pool whose hook holds BEFORE_REMOVE_LIQUIDITY; deposits worked
    /// and every withdrawal reverted inside that hook forever, with the position still showing full
    /// liquidity and the correct owner. Now pins the admission check that killed it: whitelistPool is
    /// a fail-closed allowlist on hook IDENTITY, so this foreign hook (whatever bits it carries) is
    /// not the moleHook pin and admission reverts HookNotPermitted. The trap pool is never listed,
    /// and — the invariant that actually matters to a user — open() therefore cannot take a deposit
    /// into it at all, so there is no trapped position to be locked. The whole trap is still built,
    /// still a genuine remove-path hook, and still offered; it is simply refused on identity, which is
    /// strictly earlier and broader than the old remove-path-bit check.
    function test_regression_whitelistRejectsBlockingHookSoNoDepositCanBeTrapped() public {
        address hookAddr = address(uint160(uint160(0xBAD) << 20) | uint160(0x200)); // only BEFORE_REMOVE_LIQUIDITY
        // The hook is a genuine remove-path blocker — the attack is real — but under the identity gate
        // that no longer matters: it is refused because it is not our pin, not because of these bits.
        assertEq(uint160(hookAddr) & HookPermissions.WITHDRAWAL_PATH_MASK, 0x200, "hook lacks the blocking bit");
        assertFalse(HookPermissions.withdrawalIsUnblockable(hookAddr), "control: helper says it IS blockable");
        assertFalse(HookPermissions.isValid(hookAddr), "control: helper rejects this hook");

        BlockingRemoveHook impl = new BlockingRemoveHook();
        vm.etch(hookAddr, address(impl).code);

        PoolKey memory trap =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(hookAddr)});
        manager.initialize(trap, SQRT_PRICE_1_1);

        // Still permissionless — and now it denies by default: this hook is not the moleHook pin.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(trap);
        assertFalse(mole.isWhitelisted(trap.toId()), "trap pool was whitelisted");

        // The consequence a depositor can check: no deposit can enter the trap in the first place.
        // This is the assertion to keep if the revert reason is ever renamed.
        uint256 in0 = t0.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(trap, -6000, 6000, 10e18, type(uint256).max, type(uint256).max, block.timestamp);
        assertEq(t0.balanceOf(alice), in0, "a deposit was taken into a pool that can block exits");
        assertEq(mole.positionCount(), 0, "a position was created in the trap pool");

        // The trap does not become listable by waiting, either: a pool's hook is part of its PoolId
        // and can never change, so its identity is refused forever.
        vm.warp(block.timestamp + 3650 days);
        vm.roll(block.number + 10_000_000);
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(trap);
    }

    /// Was: structural proof that the deployed runtime consulted neither of HookPermissions' guards
    /// and would list a hook carrying every dangerous bit at once. The admission check is now a
    /// fail-closed allowlist on hook IDENTITY, so this pins the stronger shape that replaced the
    /// remove-path filter: every hook carrying any remove-path bit (0x0001 / 0x0100 / 0x0200, or all
    /// three at once) is refused with HookNotPermitted — and so is a foreign hook that carries NO
    /// remove bit (0x402), because "not our pin" is the whole test now. The only pool that lists is
    /// the hookless one, whose hook equals the interim moleHook pin (address(0)). Asserting BOTH
    /// directions — foreign-with-remove-bits AND foreign-without — is what proves admission is
    /// deny-by-default and not merely the old carve-out with one more forbidden bit. The 0x402
    /// positive control that used to assert acceptance is inverted here: that was the F-1 admissible
    /// hook, and denying it by identity is the intended, user-approved design change.
    function test_regression_whitelistAdmitsOnlyTheHooklessPinAndRejectsEveryForeignHook() public {
        BlockingRemoveHook impl = new BlockingRemoveHook();

        // Every individual remove-path bit, then all of them at once: 0x0301.
        uint160[4] memory removeBits =
            [uint160(0x0001), uint160(0x0100), uint160(0x0200), HookPermissions.WITHDRAWAL_PATH_MASK];
        for (uint256 i; i < removeBits.length; ++i) {
            address bad = address(uint160(uint160(0xDEAD + i) << 20) | removeBits[i]);
            vm.etch(bad, address(impl).code);
            // Control: these are genuine remove-path hooks (the old filter would have caught them too),
            // which makes the point that the identity gate refuses them for a broader reason.
            assertFalse(HookPermissions.withdrawalIsUnblockable(bad), "control: helper says this hook is safe");

            PoolKey memory k = PoolKey({
                currency0: c0,
                currency1: c1,
                fee: uint24(4000 + i),
                tickSpacing: SPACING,
                hooks: IHooks(bad)
            });
            vm.prank(mallory);
            vm.expectRevert(MolePositions.HookNotPermitted.selector);
            mole.whitelistPool(k);
            assertFalse(mole.isWhitelisted(k.toId()), "a foreign remove-path hook was admitted");
        }

        // The other direction, and the genuine positive control. The ONLY pool that lists is the
        // hookless one, whose hook equals the interim moleHook pin (address(0)) and so clears the
        // identity gate. Authenticity IS the guarantee now: no callbacks on any path, and it is ours.
        PoolKey memory hookless =
            PoolKey({currency0: c0, currency1: c1, fee: 4100, tickSpacing: SPACING, hooks: IHooks(address(0))});
        vm.prank(mallory);
        mole.whitelistPool(hookless);
        assertTrue(mole.isWhitelisted(hookless.toId()), "a hookless pool must still be listable");

        // The inversion. A foreign hook carrying NO remove bit — 0x402 is the allowance-drain hook's
        // own bitmap, and `withdrawalIsUnblockable` is even true for it — used to be ADMITTED by the
        // old remove-path filter (that was F-1). Under the identity allowlist it is refused like any
        // other foreign hook: it is not our pin, so it can never carry a servable position, and
        // admitting it would only add attack surface. This acceptance-to-rejection flip is the
        // intended, user-approved design change.
        address addSide = address(uint160(uint160(0xFEE) << 20) | uint160(0x402));
        assertTrue(HookPermissions.withdrawalIsUnblockable(addSide), "control: 0x402 carries no remove bit");
        PoolKey memory addSideKey =
            PoolKey({currency0: c0, currency1: c1, fee: 4200, tickSpacing: SPACING, hooks: IHooks(addSide)});
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(addSideKey);
        assertFalse(mole.isWhitelisted(addSideKey.toId()), "a foreign hook off the remove path was still admitted");

        // And the second half of the same admission check: a non-positive tickSpacing is refused,
        // because _validateRange's `% tickSpacing` is undefined at 0 and negative spacing is nonsense.
        PoolKey memory zeroSpacing =
            PoolKey({currency0: c0, currency1: c1, fee: 4300, tickSpacing: 0, hooks: IHooks(address(0))});
        vm.prank(mallory);
        vm.expectRevert(MolePositions.InvalidTickSpacing.selector);
        mole.whitelistPool(zeroSpacing);
    }

    /// @notice F-1, now DEAD and blocked AT ADMISSION. whitelistPool() used to be permissionless with
    ///         a REMOVE-path-only check, so a hook carrying AFTER_ADD_LIQUIDITY_RETURNS_DELTA (0x402 —
    ///         no remove bit, so `withdrawalIsUnblockable` is true) was admissible, named the bill on
    ///         open() and pulled it out of the opener's whole approval. Admission is now a fail-closed
    ///         allowlist on hook IDENTITY: that hook is not the moleHook pin, so the hostile pool can
    ///         never be listed and the drain is UNREACHABLE — strictly earlier than the amount cap
    ///         that used to be its only backstop. The same hostile hook is still deployed and armed;
    ///         it is the thing being refused, and the test proves the skim never happens. The amount
    ///         cap remains a real defence for an honest-but-mispriced open, so its coverage is
    ///         preserved here on the admissible hookless pool.
    function test_regression_hostileHookCannotBeWhitelistedSoItsAllowanceDrainIsUnreachable() public {
        uint128 EXTRA = 500e18;

        // Honest baseline for the identical size in the honest (hookless) pool — the bill the hostile
        // hook would have inflated, and the size the amount cap is exercised against below.
        uint256 h1 = t1.balanceOf(carol);
        vm.prank(carol);
        mole.open(key, -6000, 6000, 10e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 honestBill1 = h1 - t1.balanceOf(carol);
        assertGt(honestBill1, 0, "baseline open charged nothing; the test proves nothing");

        // The SAME hostile hook, deployed and armed exactly as before: AFTER_ADD_LIQUIDITY (1<<10) |
        // AFTER_ADD_LIQUIDITY_RETURNS_DELTA (1<<1) = 0x402, wired to take() EXTRA to mallory on every
        // add-liquidity callback. The attack machine is intact — it is the thing being refused.
        address hookAddr = address(uint160(uint160(0xFEE) << 20) | uint160(0x402));
        AllowanceDrainHook impl = new AllowanceDrainHook();
        vm.etch(hookAddr, address(impl).code);
        AllowanceDrainHook(payable(hookAddr)).arm(manager, mallory, EXTRA);

        PoolKey memory trap =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: SPACING, hooks: IHooks(hookAddr)});
        manager.initialize(trap, SQRT_PRICE_1_1);

        // --- the drain is now unreachable AT ADMISSION. whitelistPool is still permissionless, but it
        // is a fail-closed allowlist on hook identity: this hook is not the moleHook pin, so the
        // attacker cannot list their own pool. 0x402 carries no remove bit — the OLD remove-path
        // filter would have admitted it, which is exactly why identity, not capability, is the fix.
        assertTrue(HookPermissions.withdrawalIsUnblockable(hookAddr), "control: the drain hook carries no remove bit");
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(trap);
        assertFalse(mole.isWhitelisted(trap.toId()), "the hostile pool was whitelisted");

        // With the pool unlisted, open() into it reverts PoolNotWhitelisted before it can name any
        // bill, so the hook's take() never runs: the opener spends nothing, the attacker skims
        // nothing, and no position is created. This is the drain measured as UNREACHABLE.
        uint256 mBefore = t1.balanceOf(mallory);
        uint256 aBefore0 = t0.balanceOf(alice);
        uint256 aBefore1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.PoolNotWhitelisted.selector);
        mole.open(trap, -6000, 6000, 10e18, type(uint256).max, type(uint256).max, block.timestamp); // same size the honest pool charged for
        assertEq(t0.balanceOf(alice), aBefore0, "opener spent currency0 into an unlisted hostile pool");
        assertEq(t1.balanceOf(alice), aBefore1, "opener spent currency1 into an unlisted hostile pool");
        assertEq(t1.balanceOf(mallory), mBefore, "attacker skimmed the opener's allowance");
        assertEq(mole.positionCount(), 1, "a position was created in the hostile pool (only carol's honest one may exist)");
        _assertNoPot("after the refused hostile open");

        // Waiting does not make the hostile pool listable either: a pool's hook is part of its PoolId
        // and can never change, so its identity is refused forever.
        vm.warp(block.timestamp + 3650 days);
        vm.roll(block.number + 10_000_000);
        vm.prank(mallory);
        vm.expectRevert(MolePositions.HookNotPermitted.selector);
        mole.whitelistPool(trap);

        // --- the amount-cap defence is preserved. It was F-1's only backstop before admission was
        // fixed; it still binds, exercised here on the admissible hookless pool. An opener naming a
        // ceiling below the real bill is refused ExceedsMaxAmount and spends nothing — so a mispriced
        // honest open is still stopped even though the hostile hook can no longer get near a user.
        uint256 aCap0 = t0.balanceOf(alice);
        uint256 aCap1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.ExceedsMaxAmount.selector);
        mole.open(key, -6000, 6000, 10e18, type(uint256).max, honestBill1 * 9 / 10, block.timestamp);
        assertEq(t0.balanceOf(alice), aCap0, "capped open still spent the opener's currency0");
        assertEq(t1.balanceOf(alice), aCap1, "capped open still spent the opener's currency1");
        _assertNoPot("after the capped open reverted");
    }

    /*//////////////////////////////////////////////////////////////////////////
                 F5 — the keeper was dead on arrival. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: v4 rounds against the LP on both legs, so remove-L-then-add-the-same-L owed the pool a few
    /// wei; _settleNet paid that from address(this), which is empty on a fresh deployment, so the
    /// FIRST rebalance ever attempted reverted TransferFailed and a stranger had to donate dust before
    /// the product worked. Now pins the structural reason that cannot happen: deriving the new
    /// liquidity from the amounts the burn returned (rounded down) makes the re-mint self-funding by
    /// construction, so the contract never needs an inventory — and still has none afterwards.
    function test_regression_freshDeploymentFirstRebalanceNeedsNoDonation() public {
        MolePositions fresh = deployMoleVault(manager, keeper, MIN_INTERVAL, MIN_WIDTH, MAX_WIDTH, address(0), 0, 0, 0, 0, 10_000, 0, 0, address(0));
        fresh.whitelistPool(key);

        vm.startPrank(alice);
        t0.approve(address(fresh), type(uint256).max);
        t1.approve(address(fresh), type(uint256).max);
        uint256 id = fresh.open(key, -6000, 6000, 30e18, type(uint256).max, type(uint256).max, block.timestamp);
        vm.stopPrank();

        // Nobody has donated anything. This is the state that used to be fatal.
        assertEq(t0.balanceOf(address(fresh)), 0, "fresh deployment already holds a balance");
        assertEq(t1.balanceOf(address(fresh)), 0, "fresh deployment already holds a balance");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        fresh.rebalance(id, -6000, 6000); // the same-range rebalance that used to revert TransferFailed

        // Still zero: the rebalance neither needed nor created an inventory.
        assertEq(t0.balanceOf(address(fresh)), 0, "rebalance left currency0 in a fresh deployment");
        assertEq(t1.balanceOf(address(fresh)), 0, "rebalance left currency1 in a fresh deployment");

        // The position survived the round trip intact — a same-range rebalance with no fees accrued
        // can only lose v4's rounding, never a meaningful slice of the owner's liquidity.
        uint128 newL = fresh.getPosition(id).liquidity;
        assertGt(newL, 0, "rebalance emptied the position");
        assertGe(newL, 30e18 - ROUNDING_WEI, "same-range rebalance lost more than rounding");
        assertLe(newL, 30e18, "same-range rebalance minted liquidity out of nowhere");

        // And the owner can still get everything out of the fresh deployment.
        vm.prank(alice);
        fresh.withdraw(id, newL);
        assertEq(fresh.getPosition(id).liquidity, 0, "position not empty");
        assertEq(t0.balanceOf(address(fresh)), 0, "withdrawal left currency0 behind");
        assertEq(t1.balanceOf(address(fresh)), 0, "withdrawal left currency1 behind");
    }

    /*//////////////////////////////////////////////////////////////////////////
                   F6 — open() had no amount bound. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: open() took a liquidity amount and never a maximum spend, and had no deadline, so the
    /// spot price at execution time decided the bill and pulled it from the caller's whole approval —
    /// an attacker who moved the price first made the depositor buy one side of the book. Now pins
    /// the three guards that replaced it. The price manipulation is still performed, in full, and
    /// still moves the bill exactly as it used to; what changed is that the depositor's own ceiling
    /// now stops the call. Note this pins the CAP, not the price: the attacker keeps the ability to
    /// make the deposit one-sided, and that is asserted too, so the test cannot silently stop
    /// exercising the attack.
    function test_regression_openEnforcesMaxAmountsAndDeadlineAgainstAPriceMove() public {
        // Deadline is checked before anything else, at any price.
        vm.prank(alice);
        vm.expectRevert(MolePositions.DeadlinePassed.selector);
        mole.open(key, -6000, 6000, 40e18, type(uint256).max, type(uint256).max, block.timestamp - 1);

        // Control: what the deposit costs at the price alice saw when she signed.
        uint256 c0Before = t0.balanceOf(carol);
        uint256 c1Before = t1.balanceOf(carol);
        vm.prank(carol);
        mole.open(key, -6000, 6000, 40e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 fair0 = c0Before - t0.balanceOf(carol);
        uint256 fair1 = c1Before - t1.balanceOf(carol);
        assertGt(fair0, 0);
        assertGt(fair1, 0);

        // Both ceilings bind independently, at the honest price, before any manipulation.
        vm.prank(alice);
        vm.expectRevert(MolePositions.ExceedsMaxAmount.selector);
        mole.open(key, -6000, 6000, 40e18, fair0 / 2, type(uint256).max, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(MolePositions.ExceedsMaxAmount.selector);
        mole.open(key, -6000, 6000, 40e18, type(uint256).max, fair1 / 2, block.timestamp);

        // Attacker pushes the price above alice's whole range, then her identical open lands.
        _swapAs(mallory, false, 3000e18);

        // THE FIX. Alice signed for roughly the fair basket with 10% of headroom. The manipulated
        // bill exceeds it, so her deposit does not happen and she spends nothing.
        uint256 guarded0 = t0.balanceOf(alice);
        uint256 guarded1 = t1.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(MolePositions.ExceedsMaxAmount.selector);
        mole.open(key, -6000, 6000, 40e18, fair0 * 11 / 10, fair1 * 11 / 10, block.timestamp);
        assertEq(t0.balanceOf(alice), guarded0, "guarded open still spent currency0");
        assertEq(t1.balanceOf(alice), guarded1, "guarded open still spent currency1");
        assertEq(mole.positionCount(), 1, "guarded open still created a position");

        // The attack itself is undiminished — proved by letting the same call through uncapped, which
        // is what the old signature forced on everyone. She would hold a 100%-currency1 position she
        // never asked for, bought at the top. The cap is the whole defence, so it had better bind.
        uint256 a0Before = t0.balanceOf(alice);
        uint256 a1Before = t1.balanceOf(alice);
        vm.prank(alice);
        mole.open(key, -6000, 6000, 40e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 paid0 = a0Before - t0.balanceOf(alice);
        uint256 paid1 = a1Before - t1.balanceOf(alice);

        console2.log("fair bill  c0/c1", fair0, fair1);
        console2.log("sandwiched c0/c1", paid0, paid1);
        assertEq(paid0, 0, "position was not forced entirely onto one side");
        assertGt(paid1, fair1 * 19 / 10, "one-sided bill was not materially larger");
        assertGt(paid1, fair1 * 11 / 10, "the cap that reverted above was not actually binding");
    }

    /*//////////////////////////////////////////////////////////////////////////
              F7 — zero-L1-dwell extraction. DEAD. Now a regression.
    //////////////////////////////////////////////////////////////////////////*/

    /// Was: with block.number frozen at its open-time value — modelling exactly the authority a
    /// sequencer that already sets block.timestamp has — the full extraction sequence ran to
    /// completion, because openedAtL1Block gates nothing. Now pins that the same zero-dwell sequence
    /// extracts NOTHING: the contract's balance is exactly zero after both rebalances and the owner
    /// still gets her deposit back.
    ///
    /// RESIDUAL, recorded rather than asserted: openedAtL1Block is still written and read by nothing,
    /// and the declared error DwellNotElapsed is still unused, so the L1-paced dwell guard the
    /// contract header argues for is still not implemented. That is now a doc/code mismatch with no
    /// value-extraction path behind it. It is deliberately NOT pinned as "rebalance must succeed at
    /// zero dwell" — that would be a regression test defending a weakness, and would break the day
    /// the guard is actually added.
    function test_regression_zeroL1DwellExtractionYieldsNothing() public {
        uint256 frozen = block.number;
        uint256 in0 = t0.balanceOf(alice);
        uint256 in1 = t1.balanceOf(alice);

        vm.prank(alice);
        uint256 id = mole.open(key, -30000, 30000, 40e18, type(uint256).max, type(uint256).max, block.timestamp);
        uint256 dep0 = in0 - t0.balanceOf(alice);
        uint256 dep1 = in1 - t1.balanceOf(alice);
        assertEq(mole.getPosition(id).openedAtL1Block, uint64(frozen), "stamp not taken from block.number");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(id, -6000, 6000);
        _assertNoPot("after the first zero-dwell rebalance");

        vm.warp(block.timestamp + MIN_INTERVAL + 1);
        vm.prank(keeper);
        mole.rebalance(id, -60, 60);
        _assertNoPot("after the second zero-dwell rebalance");

        assertEq(block.number, frozen, "L1 height advanced; the test would prove nothing");
        assertEq(mole.getPosition(id).openedAtL1Block, uint64(frozen), "stamp mutated");

        // And the owner of the squeezed position walks away whole, at zero L1 dwell.
        uint128 finalL = mole.getPosition(id).liquidity;
        vm.prank(alice);
        mole.withdraw(id, finalL);
        _assertNoPot("after the owner exits at zero L1 dwell");
        uint256 out0 = t0.balanceOf(alice) + dep0 - in0;
        uint256 out1 = t1.balanceOf(alice) + dep1 - in1;
        assertGe(out0 + out1, dep0 + dep1 - ROUNDING_WEI, "owner lost value across two zero-dwell rebalances");
    }

    /*//////////////////////////////////////////////////////////////////////////
                          R1/R2 — defences that actually hold
    //////////////////////////////////////////////////////////////////////////*/

    /// @notice The Open branch of unlockCallback uses a calldata-supplied address as the PAYER, which
    ///         would drain any approver if it were reachable. It is not: the PoolManager only ever
    ///         calls back the address that called unlock(), so no attacker calldata can arrive here.
    function test_attack_unlockCallbackDirectCallIsRejected() public {
        uint256 v0 = t0.balanceOf(alice);
        uint256 v1 = t1.balanceOf(alice);

        // Encoded with the post-fix arity (…, amount0Max, amount1Max) so the payload really would
        // decode if it ever reached the body, rather than dying early on a malformed abi.decode.
        bytes memory forgedOpen = abi.encode(
            MolePositions.Action.Open,
            uint256(1),
            alice,
            int256(1e18),
            int24(0),
            int24(0),
            type(uint256).max,
            type(uint256).max
        );
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(forgedOpen);

        bytes memory forgedWithdraw = abi.encode(
            MolePositions.Action.Withdraw,
            uint256(1),
            mallory,
            -int256(1e18),
            int24(0),
            int24(0),
            uint256(0),
            uint256(0)
        );
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        mole.unlockCallback(forgedWithdraw);

        // Even the PoolManager itself cannot be used as a courier for attacker calldata, because
        // unlock() dispatches the callback to its own caller.
        vm.prank(address(manager));
        vm.expectRevert(); // reaches the branch, then fails inside v4 (manager is not unlocked)
        mole.unlockCallback(forgedOpen);

        assertEq(t0.balanceOf(alice), v0, "victim paid something");
        assertEq(t1.balanceOf(alice), v1, "victim paid something");
    }

    /// @notice Control case for F1: the payout mechanism is honest. The problem is not who may call
    ///         withdraw, it is that the value has already been moved before they do.
    function test_attack_noThirdPartyCanWithdrawOrRebalance() public {
        vm.prank(alice);
        uint256 id = mole.open(key, -6000, 6000, 10e18, type(uint256).max, type(uint256).max, block.timestamp);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1e18);

        vm.prank(keeper);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.withdraw(id, 1e18);

        vm.warp(block.timestamp + MIN_INTERVAL + 1);

        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, -60, 60);

        vm.prank(alice);
        vm.expectRevert(MolePositions.NotKeeper.selector);
        mole.rebalance(id, -60, 60);

        assertEq(mole.ownerOf(id), alice);
    }

    /*//////////////////////////////////////////////////////////////////////////
                                     helpers
    //////////////////////////////////////////////////////////////////////////*/

    /// @dev The one invariant that killed F1, F2, F3, F5 and F7 at once, and the exact quantity the
    ///      deleted _settleNet used to accumulate. Asserted as an equality to zero after every leg of
    ///      every attack, so no future change can rebuild the shared pot by any route.
    function _assertNoPot(string memory when) internal view {
        assertEq(t0.balanceOf(address(mole)), 0, string.concat("contract holds currency0 ", when));
        assertEq(t1.balanceOf(address(mole)), 0, string.concat("contract holds currency1 ", when));
    }

    function _swap(bool zeroForOne, uint256 amountIn) internal {
        _swapAs(address(this), zeroForOne, amountIn);
    }

    function _swapAs(address who, bool zeroForOne, uint256 amountIn) internal {
        vm.prank(who);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _deployPoolManager(address initialOwner) internal returns (IPoolManager pm) {
        bytes memory code = abi.encodePacked(PM_CREATION, abi.encode(initialOwner));
        address addr;
        assembly {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), "PoolManager deploy failed");
        pm = IPoolManager(addr);
    }

    /// @dev Canonical creation code of lib/v4-core/src/PoolManager.sol, embedded rather than imported
    ///      because the repo's committed optimizer settings cannot compile that file. See the header.
    bytes internal constant PM_CREATION = hex"60a03460a057601f615eab38819003918201601f19168301916001600160401b0383118484101760a45780849260209460405283398101031260a057516001600160a01b0381169081900360a0575f80546001600160a01b0319168217815560405191907f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e08180a330608052615df290816100b98239608051816135260152f35b5f80fd5b634e487b7160e01b5f52604160045260245ffdfe60a0806040526004361015610012575f80fd5b5f3560e01c908162fdd58e14612cd55750806301ffc9a714612c16578063095bcdb614612b6c5780630b0d9c0914612ae057806311da60b414612a85578063156e29f6146129d55780631e2eaeaf1461299b578063234266d7146126fc5780632d7713891461265157806335fd631a146125dd5780633dd45adb14612579578063426a8493146124f557806348c894911461226a5780635275965114612152578063558a72971461207b578063598af9e714611fe35780635a6bcfda1461144f5780636276cbbe14610f965780637e87ce7d14610e5957806380f0b44c14610d875780638161b87414610c315780638da5cb5b14610be157806397e8cd4e14610b7e5780639bf6645f14610b31578063a584119414610a66578063b6363cf2146109d5578063dbd035ff1461097f578063f02de3b21461092e578063f135baaa146108f4578063f2fde38b14610848578063f3cd914c146104ff578063f5298aca146103345763fe99049a14610186575f80fd5b346103305760807ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330576101bd612d3f565b6101c5612d62565b90604435917f1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac72885961027973ffffffffffffffffffffffffffffffffffffffff80606435951693843314158061030d575b610287575b845f52600460205260405f20875f5260205260405f2061023a878254612fed565b90551693845f52600460205260405f20865f5260205260405f2061025f828254612ffa565b905560408051338152602081019290925290918291820190565b0390a4602060405160018152f35b845f52600560205260405f208233165f5260205260405f20875f5260205260405f2054867fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff82036102da575b5050610219565b6102e391612fed565b855f52600560205260405f208333165f5260205260405f20885f5260205260405f20555f866102d3565b50845f52600360205260405f208233165f5260205260ff60405f20541615610214565b5f80fd5b346103305761034236612d85565b7fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d7577f1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac7288596103ed73ffffffffffffffffffffffffffffffffffffffff805f9516956103bb6103b3866130aa565b3390896130f0565b169233841415806104a0575b6103f2575b8385526004602052604085208686526020526040852061025f828254612fed565b0390a4005b83855260056020526040852073ffffffffffffffffffffffffffffffffffffffff33168652602052604085208686526020526040852054817fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8203610459575b50506103cc565b61046291612fed565b84865260056020526040862073ffffffffffffffffffffffffffffffffffffffff331687526020526040862087875260205260408620558681610452565b5083855260036020526040852073ffffffffffffffffffffffffffffffffffffffff3316865260205260ff604086205416156103c7565b7f54e3ca0d000000000000000000000000000000000000000000000000000000005f5260045ffd5b34610330576101207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305761053836612e81565b60607fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff5c360112610330576040519061056f82612df6565b60a4358015158103610330578252602082019060c435825260e4359073ffffffffffffffffffffffffffffffffffffffff8216820361033057604084019182526101043567ffffffffffffffff8111610330576105d0903690600401612f4d565b9290937fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d75761060261350f565b51156108205760a0822092835f52600660205260405f209061062382613576565b60808401958482828a8a5173ffffffffffffffffffffffffffffffffffffffff169361064e94613b44565b90949195606088015160020b908b511515905173ffffffffffffffffffffffffffffffffffffffff1691604051986106858a612e12565b895260208901526040880152606087015262ffffff166080860152885115155f149862ffffff6107a2986106db61078f9860209d6108005773ffffffffffffffffffffffffffffffffffffffff8b511695614959565b9492968291926107d3575b505073ffffffffffffffffffffffffffffffffffffffff845116938e6fffffffffffffffffffffffffffffffff60408301511691015160020b90604051958860801d600f0b875288600f0b60208801526040870152606086015260808501521660a08301527f40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f60c03393a38673ffffffffffffffffffffffffffffffffffffffff8a5116613d81565b809491946107aa575b5050823391613652565b604051908152f35b73ffffffffffffffffffffffffffffffffffffffff6107cc9251169083613652565b8480610798565b73ffffffffffffffffffffffffffffffffffffffff165f5260018f5260405f209081540190558e806106e6565b73ffffffffffffffffffffffffffffffffffffffff8e8c01511695614959565b7fbe8b8507000000000000000000000000000000000000000000000000000000005f5260045ffd5b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330577fffffffffffffffffffffffff00000000000000000000000000000000000000006108a0612d3f565b73ffffffffffffffffffffffffffffffffffffffff5f54916108c58284163314613007565b1691829116175f55337f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e05f80a3005b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330576004355c5f5260205ff35b34610330575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057602073ffffffffffffffffffffffffffffffffffffffff60025416604051908152f35b346103305761098d36612f7b565b6040519160408360208152836020820152019160051b8301916020806040850193925b83355481520191019084838210156109cc5750602080916109b0565b60408186030190f35b346103305760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057610a0c612d3f565b73ffffffffffffffffffffffffffffffffffffffff610a29612d62565b91165f52600360205273ffffffffffffffffffffffffffffffffffffffff60405f2091165f52602052602060ff60405f2054166040519015158152f35b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057610a9d612d3f565b73ffffffffffffffffffffffffffffffffffffffff81169081610ae15750505f7f27e098c505d44ec3574004bca052aabf76bd35004c182099d8c575fb238593b95d005b610aea90613a92565b907f27e098c505d44ec3574004bca052aabf76bd35004c182099d8c575fb238593b95d7f1e0745a7db1623981f0b2a5d4232364c00787266eb75ad546f190e6cebe9bd955d005b3461033057610b3f36612f7b565b6040519160408360208152836020820152019160051b8301916020806040850193925b83355c81520191019084838210156109cc575060208091610b62565b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305773ffffffffffffffffffffffffffffffffffffffff610bca612d3f565b165f526001602052602060405f2054604051908152f35b34610330575f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057602073ffffffffffffffffffffffffffffffffffffffff5f5416604051908152f35b346103305760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057610c68612d3f565b610c70612d62565b60443573ffffffffffffffffffffffffffffffffffffffff600254163303610d5f5773ffffffffffffffffffffffffffffffffffffffff821680151580610d1f575b610cf7576020936107a29280610cef5750815f526001855260405f20549384925b5f526001865260405f20610ce8848254612fed565b90556131f8565b938492610cd3565b7fc79e5948000000000000000000000000000000000000000000000000000000005f5260045ffd5b508073ffffffffffffffffffffffffffffffffffffffff7f27e098c505d44ec3574004bca052aabf76bd35004c182099d8c575fb238593b95c1614610cb2565b7f48f5c3ed000000000000000000000000000000000000000000000000000000005f5260045ffd5b346103305760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057610dbe612d3f565b7fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d757335f90815273ffffffffffffffffffffffffffffffffffffffff8216602052604090205c610e146024356130aa565b9081600f0b03610e3157610e2f9133915f03600f0b906130f0565b005b7fbda73abf000000000000000000000000000000000000000000000000000000005f5260045ffd5b346103305760c07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057610e9136612e81565b610e99612e6f565b9073ffffffffffffffffffffffffffffffffffffffff600254163303610d5f57623e900062fff0008316106103e9610fff8416101615610f6557602060a07fe9c42593e71f84403b84352cd168d693e2c9fcd1fdbcc3feb21d92b43e6696f9922092835f526006825260405f20610f0f81613576565b805479ffffff00000000000000000000000000000000000000000000008360b81b16907fffffffffffff000000ffffffffffffffffffffffffffffffffffffffffffffff1617905562ffffff60405191168152a2005b62ffffff827fa7abe2f7000000000000000000000000000000000000000000000000000000005f521660045260245ffd5b346103305760c07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057610fce36612e81565b60a4359073ffffffffffffffffffffffffffffffffffffffff821680830361033057610ff861350f565b6060820191825160020b617fff81136114245750825160020b600181126113f9575073ffffffffffffffffffffffffffffffffffffffff815116602082019073ffffffffffffffffffffffffffffffffffffffff825116808210156113c2575050608082019073ffffffffffffffffffffffffffffffffffffffff82511690604084019161108c62ffffff845116826139b7565b1561139757506110a162ffffff835116613a75565b96835173ffffffffffffffffffffffffffffffffffffffff8116908133036112e0575b505060a0852090815f52600660205260405f2090815473ffffffffffffffffffffffffffffffffffffffff166112b8576020997fdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438927cffffff000000000000000000000000000000000000000000000000000061114260a0946145fc565b9260d01b168a76ffffff000000000000000000000000000000000000000084861b161717905562ffffff73ffffffffffffffffffffffffffffffffffffffff808a5116965116965116995160020b73ffffffffffffffffffffffffffffffffffffffff885116906040519b8c528c8c015260408b01528860608b015260020b98896080820152a45173ffffffffffffffffffffffffffffffffffffffff8116908133036111f4575b8585604051908152f35b61100016611203575b806111ea565b6112af9261128d604051937f6fe7e6eb0000000000000000000000000000000000000000000000000000000088860152336024860152604485019073ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b60e48301528361010483015261010482526112aa61012483612e2e565b613f25565b508280806111fd565b7f7983c051000000000000000000000000000000000000000000000000000000005f5260045ffd5b612000166112ef575b806110c4565b61139090604051907fdc98354e00000000000000000000000000000000000000000000000000000000602083015233602483015261137a604483018973ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b8860e483015260e482526112aa61010483612e2e565b50886112e9565b7fe65af6a0000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b60449250604051917f6e6c983000000000000000000000000000000000000000000000000000000000835260048301526024820152fd5b7fe9e90588000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7fb70024f8000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b34610330576101407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305761148836612e81565b60807fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff5c36011261033057604051906114bf82612dda565b60a4358060020b810361033057825260c4358060020b810361033057602083015260e43560408301526101043560608301526101243567ffffffffffffffff811161033057611512903690600401612f4d565b90927fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d75761154361350f565b60a0832093845f52600660205260405f20608052611562608051613576565b608084015173ffffffffffffffffffffffffffffffffffffffff811690813303611ede575b5050815160020b92602083015160020b916115a56040850151613785565b93606087015160020b9760608201516040519960c08b018b811067ffffffffffffffff821117611eb157604052338b528860208c01528660408c015287600f0b60608c015260808b015260a08a01525f9185881215611e7a577ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff276188812611e4e57620d89e88613611e22576040519261163c84612dda565b5f84525f60208501525f60408501525f606085015287600f0b611b25575b600460805101978960020b5f528860205260405f20988860020b5f5260205260405f206080515460a01c60020b8b81125f14611acf575060028060018c0154600184015490039b015491015490039b5b60a073ffffffffffffffffffffffffffffffffffffffff825116910151906040519160268301528960068301528b600383015281525f603a600c83012091816040820152816020820152525f5260066080510160205260405f20976fffffffffffffffffffffffffffffffff8954169982600f0b155f14611a72578a15611a4a5761176f61176960409f9b61184e9c6118609e5b60018301956117616002611755848a548503615703565b95019283548503615703565b9655556130aa565b916130aa565b6fffffffffffffffffffffffffffffffff169060801b179a8b965f84600f0b126119dc575b5082600f0b611898575b5050506117c46117b58560801d8360801d01613785565b9185600f0b90600f0b01613785565b6fffffffffffffffffffffffffffffffff169060801b1791815160020b90602083015160020b8c8401516060850151918e5194855260208501528d84015260608301527ff208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec60803393a38873ffffffffffffffffffffffffffffffffffffffff60808201511661385b565b8094919461186c575b50833391613652565b82519182526020820152f35b6118929073ffffffffffffffffffffffffffffffffffffffff6080840151169083613652565b85611857565b60805154929350909173ffffffffffffffffffffffffffffffffffffffff81169060a01c60020b828112156118fe575050906118f2926118e76118dd6118ed94614158565b91600f0b92614158565b90614527565b613785565b60801b5b8b808061179e565b92809193125f146119a95761193d9161192a6118ed6118ed9361192488600f0b91614158565b87614527565b9361193886600f0b92614158565b6144ca565b6fffffffffffffffffffffffffffffffff169060801b17906fffffffffffffffffffffffffffffffff61197c60036080510192600f0b8284541661456e565b167fffffffffffffffffffffffffffffffff000000000000000000000000000000008254161790556118f6565b906118ed9250926119bf6118dd6119c595614158565b906144ca565b6fffffffffffffffffffffffffffffffff166118f6565b808f9151611a1e575b01516119f2575b8e611794565b611a198260805160049160020b5f52016020525f6002604082208281558260018201550155565b6119ec565b611a458360805160049160020b5f52016020525f6002604082208281558260018201550155565b6119e5565b7faefeb924000000000000000000000000000000000000000000000000000000005f5260045ffd5b61176f61176960409f9b61184e9c6118609e6fffffffffffffffffffffffffffffffff611aa289600f0b8361456e565b167fffffffffffffffffffffffffffffffff0000000000000000000000000000000084541617835561173e565b9099908913611af55760028060018c0154600184015490039b015491015490039b6116aa565b9860026001608051015460018c01549003600183015490039a81806080510154910154900391015490039b6116aa565b6004608051018960020b5f5280602052898960405f20611b7e81546fffffffffffffffffffffffffffffffff611b6181831695600f0b8661456e565b16931594858515141595611dee575b508d600f0b9060801d613d3a565b60801b82179055602087015285528760020b5f5260205260405f208054906fffffffffffffffffffffffffffffffff8216611bbc8b600f0b8261456e565b901592836fffffffffffffffffffffffffffffffff831615141593611dc1575b8b600f0b9060801d600f0b03916f7fffffffffffffffffffffffffffffff83137fffffffffffffffffffffffffffffffff80000000000000000000000000000000841217611d9457826fffffffffffffffffffffffffffffffff935060801b83831617905516606086015260408501525f88600f0b1215611ca1575b8351611c85575b60408401511561165a57611c8060808c015160020b8860056080510161410c565b61165a565b611c9c60808c015160020b8a60056080510161410c565b611c5f565b60808b015160020b6fffffffffffffffffffffffffffffffff600181602088015116925f817ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff276180712817ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27618050390620d89e8050301810416809111611d68576fffffffffffffffffffffffffffffffff6060860151161115611c5857867fb8e3c385000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b897fb8e3c385000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b6080515460a01c60020b8b13611bdc57600160805101546001840155600260805101546002840155611bdc565b6080515460a01c60020b1215611e05575b8e611b70565b600160805101546001840155600260805101546002840155611dff565b857f1ad777f8000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b877fd5e2f7ab000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b60448887604051917fc4433ed500000000000000000000000000000000000000000000000000000000835260048301526024820152fd5b7f4e487b71000000000000000000000000000000000000000000000000000000005f52604160045260245ffd5b5f604085015113808091611fd6575b15611f6b5750506040517f259982e5000000000000000000000000000000000000000000000000000000006020820152611f62916112aa82611f368887898c33602487016136cb565b037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101845283612e2e565b505b8580611587565b159081611fc8575b50611f7f575b50611f64565b6040517f21d0ee70000000000000000000000000000000000000000000000000000000006020820152611fc1916112aa82611f368887898c33602487016136cb565b5085611f79565b610200915016151587611f73565b5061080082161515611eed565b346103305760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305761201a612d3f565b73ffffffffffffffffffffffffffffffffffffffff612037612d62565b91165f52600560205273ffffffffffffffffffffffffffffffffffffffff60405f2091165f5260205260405f206044355f52602052602060405f2054604051908152f35b346103305760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330576120b2612d3f565b602435908115158092036103305773ffffffffffffffffffffffffffffffffffffffff90335f52600360205260405f208282165f5260205260405f207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0081541660ff851617905560405192835216907fceb576d9f15e4e200fdb5096d64d5dfd667e16def20c1eefd14256d8e3faa26760203392a3602060405160018152f35b346103305760c07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305761218a36612e81565b612192612e6f565b906280000062ffffff60408301511614801590612246575b61221e5760a0906121ba8361368e565b205f52600660205260405f20906121d082613576565b81547fffffff000000ffffffffffffffffffffffffffffffffffffffffffffffffffff1660d09190911b7cffffff000000000000000000000000000000000000000000000000000016179055005b7f30d21641000000000000000000000000000000000000000000000000000000005f5260045ffd5b5073ffffffffffffffffffffffffffffffffffffffff6080820151163314156121aa565b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305760043567ffffffffffffffff8111610330576122b9903690600401612f4d565b7fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c6124cd57612345915f9160017fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235d60405193849283927f91dd734600000000000000000000000000000000000000000000000000000000845260206004850152602484019161306c565b038183335af19081156124c2575f9161241a575b507f7d4b3164c6e45b97e7d87b7125a44c5828d005af88f9d751cfd78729c5d99a0b5c6123f25760406020915f7fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235d7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f835194859381855280519182918282880152018686015e5f85828601015201168101030190f35b7f5212cba1000000000000000000000000000000000000000000000000000000005f5260045ffd5b90503d805f833e61242b8183612e2e565b8101906020818303126103305780519067ffffffffffffffff8211610330570181601f820112156103305780519067ffffffffffffffff8211611eb1576040519261249e60207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f8601160185612e2e565b8284526020838301011161033057815f9260208093018386015e8301015281612359565b6040513d5f823e3d90fd5b7f5090d6c6000000000000000000000000000000000000000000000000000000005f5260045ffd5b346103305773ffffffffffffffffffffffffffffffffffffffff61251836612d85565b91929092335f52600560205260405f208282165f5260205260405f20845f526020528260405f205560405192835216907fb3fd5071835887567a0671151121894ddccc2842f1d10bedad13e0d17cace9a760203392a4602060405160018152f35b60207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330576125ab612d3f565b7fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d7576107a260209161342d565b346103305760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330576024356004356040519160408360208152826020820152019060051b8301916001602060408501935b835481520191019084838210156109cc57506020600191612635565b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305773ffffffffffffffffffffffffffffffffffffffff61269d612d3f565b6126ab825f54163314613007565b16807fffffffffffffffffffffffff000000000000000000000000000000000000000060025416176002557fb4bd8ef53df690b9943d3318996006dbb82a25f54719d8c8035b516a2a5b8acc5f80a2005b34610330576101007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305761273536612e81565b60c4359060a43560e43567ffffffffffffffff81116103305761275c903690600401612f4d565b9190937fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d75761278e61350f565b60a0842094855f52600660205260405f20946127a986613576565b60808101805173ffffffffffffffffffffffffffffffffffffffff811690813303612943575b50506fffffffffffffffffffffffffffffffff60038801541697881561291b576020986127fb876130aa565b5f03612806876130aa565b5f036fffffffffffffffffffffffffffffffff169060801b179887612907575b866128f2575b5050612839338985613652565b60405190868252858a8301527f29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb60403393a3519273ffffffffffffffffffffffffffffffffffffffff841693843303612897575b8888604051908152f35b6010166128a5575b8061288d565b6128e6956112aa93611f36926040519788957fe1b4af69000000000000000000000000000000000000000000000000000000008d88015233602488016135bc565b5082808080808061289f565b600201908660801b048154019055898061282c565b60018101828960801b048154019055612826565b7fa74f97ab000000000000000000000000000000000000000000000000000000005f5260045ffd5b602016612951575b806127cf565b6040517fb6a8b0fa000000000000000000000000000000000000000000000000000000006020820152612994916112aa82611f368b898b8d8b33602488016135bc565b508861294b565b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057600435545f5260205ff35b34610330576129e336612d85565b907fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d7577f1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac7288596103ed73ffffffffffffffffffffffffffffffffffffffff805f941695612a62612a55876130aa565b8603600f0b3390896130f0565b16938484526004602052604084208685526020526040842061025f828254612ffa565b5f7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330577fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d75760206107a23361342d565b346103305760607ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261033057612b17612d3f565b612b1f612d62565b604435907fc090fc4683624cfc3884e9d8de5eca132f2d0ec062aff75d43c0465d5ceeab235c156104d757610e2f92612b67612b5a846130aa565b5f03600f0b3390836130f0565b6131f8565b346103305773ffffffffffffffffffffffffffffffffffffffff612b8f36612d85565b91929092335f52600460205260405f20845f5260205260405f20612bb4848254612fed565b90551690815f52600460205260405f20835f5260205260405f20612bd9828254612ffa565b9055604080513380825260208201939093527f1b3d7edb2e9c0b0e7c525b20aaaef0f5940d2ed71663c7d39266ecafac7288599181908101610279565b346103305760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610330576004357fffffffff00000000000000000000000000000000000000000000000000000000811680910361033057807f01ffc9a70000000000000000000000000000000000000000000000000000000060209214908115612cab575b506040519015158152f35b7f0f632fb30000000000000000000000000000000000000000000000000000000091501482612ca0565b346103305760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc3601126103305760209073ffffffffffffffffffffffffffffffffffffffff612d24612d3f565b165f526004825260405f206024355f52825260405f20548152f35b6004359073ffffffffffffffffffffffffffffffffffffffff8216820361033057565b6024359073ffffffffffffffffffffffffffffffffffffffff8216820361033057565b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc60609101126103305760043573ffffffffffffffffffffffffffffffffffffffff8116810361033057906024359060443590565b6080810190811067ffffffffffffffff821117611eb157604052565b6060810190811067ffffffffffffffff821117611eb157604052565b60a0810190811067ffffffffffffffff821117611eb157604052565b90601f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0910116810190811067ffffffffffffffff821117611eb157604052565b60a4359062ffffff8216820361033057565b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc60a09101126103305760405190612eb882612e12565b8160043573ffffffffffffffffffffffffffffffffffffffff8116810361033057815260243573ffffffffffffffffffffffffffffffffffffffff8116810361033057602082015260443562ffffff811681036103305760408201526064358060020b81036103305760608201526084359073ffffffffffffffffffffffffffffffffffffffff821682036103305760800152565b9181601f840112156103305782359167ffffffffffffffff8311610330576020838186019501011161033057565b9060207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc8301126103305760043567ffffffffffffffff811161033057826023820112156103305780600401359267ffffffffffffffff84116103305760248460051b83010111610330576024019190565b91908203918211611d9457565b91908201809211611d9457565b1561300e57565b60646040517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600c60248201527f554e415554484f52495a454400000000000000000000000000000000000000006044820152fd5b601f82602094937fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe093818652868601375f8582860101520116010190565b6f800000000000000000000000000000008110156130c857600f0b90565b7f93dafdf1000000000000000000000000000000000000000000000000000000005f5260045ffd5b9190600f0b9182156131f357613126919073ffffffffffffffffffffffffffffffffffffffff8092165f521660205260405f2090565b613132815c9283613b29565b80915d6131a357507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f7d4b3164c6e45b97e7d87b7125a44c5828d005af88f9d751cfd78729c5d99a0b5c017f7d4b3164c6e45b97e7d87b7125a44c5828d005af88f9d751cfd78729c5d99a0b5d5b565b156131aa57565b60017f7d4b3164c6e45b97e7d87b7125a44c5828d005af88f9d751cfd78729c5d99a0b5c017f7d4b3164c6e45b97e7d87b7125a44c5828d005af88f9d751cfd78729c5d99a0b5d565b505050565b90919073ffffffffffffffffffffffffffffffffffffffff811690816132ea5750505f80808093855af11561322a5750565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f3d011673ffffffffffffffffffffffffffffffffffffffff604051927f90bfb8650000000000000000000000000000000000000000000000000000000084521660048301525f6024830152608060448301528060a00160648301523d60848301523d5f60a484013e7ff4b3b1bc0000000000000000000000000000000000000000000000000000000060c4828401600460a4820152015260e40190fd5b60205f60448194968260409573ffffffffffffffffffffffffffffffffffffffff988751998a947fa9059cbb00000000000000000000000000000000000000000000000000000000865216600485015260248401525af13d15601f3d116001855114161716928281528260208201520152156133635750565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f3d0116604051917f90bfb86500000000000000000000000000000000000000000000000000000000835260048301527fa9059cbb000000000000000000000000000000000000000000000000000000006024830152608060448301528060a00160648301523d60848301523d5f60a484013e7ff27f64e40000000000000000000000000000000000000000000000000000000060c4828401600460a4820152015260e40190fd5b7f27e098c505d44ec3574004bca052aabf76bd35004c182099d8c575fb238593b95c919073ffffffffffffffffffffffffffffffffffffffff8316613482576131a19034935b61347c856130aa565b906130f0565b346134e7576131a1906134be7f1e0745a7db1623981f0b2a5d4232364c00787266eb75ad546f190e6cebe9bd955c6134b986613a92565b612fed565b935f7f27e098c505d44ec3574004bca052aabf76bd35004c182099d8c575fb238593b95d613473565b7fb0ec849e000000000000000000000000000000000000000000000000000000005f5260045ffd5b73ffffffffffffffffffffffffffffffffffffffff7f000000000000000000000000000000000000000000000000000000000000000016300361354e57565b7f0d89438e000000000000000000000000000000000000000000000000000000005f5260045ffd5b5473ffffffffffffffffffffffffffffffffffffffff161561359457565b7f486aa307000000000000000000000000000000000000000000000000000000005f5260045ffd5b91926136376101209473ffffffffffffffffffffffffffffffffffffffff61364f999794168552602085019073ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b60c083015260e082015281610100820152019161306c565b90565b9073ffffffffffffffffffffffffffffffffffffffff60206131a1949361368185848351168660801d906130f0565b01511690600f0b906130f0565b62ffffff16620f424081116136a05750565b7f14002113000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b9061364f95936137486101609473ffffffffffffffffffffffffffffffffffffffff61377794168552602085019073ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b8051600290810b60c08501526020820151900b60e0840152604081015161010084015260600151610120830152565b81610140820152019161306c565b9081600f0b9182036130c857565b926138419061381261364f99979473ffffffffffffffffffffffffffffffffffffffff6101a09895168752602087019073ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b8051600290810b60c08701526020820151900b60e0860152604081015161010086015260600151610120850152565b61014083015261016082015281610180820152019161306c565b939590919296945f9673ffffffffffffffffffffffffffffffffffffffff861633146139ac57885f6040870151135f1461393b5761040087166138a2575b50505050505050565b61392e9799985092613927969594926138ef9261391b956040519788967f9f063efc0000000000000000000000000000000000000000000000000000000060208901523360248901613793565b037fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08101835282612e2e565b6002821615159161459f565b80926145bf565b915f808080808080613899565b95949392919061010086166139535750505050505050565b61392e979950869850916138ef916139a09493613927986040519788967f6c2bbe7e0000000000000000000000000000000000000000000000000000000060208901523360248901613793565b6001821615159161459f565b505f96505050505050565b608081161580613a69575b613a3f57604081161580613a5d575b613a3f5761040081161580613a51575b613a3f5761010081161580613a45575b613a3f5773ffffffffffffffffffffffffffffffffffffffff8116613a1f575062ffffff1662800000141590565b613fff161590811591613a30575090565b62800000915062ffffff161490565b50505f90565b506001811615156139f1565b506002811615156139e1565b506004811615156139d1565b506008811615156139c2565b6280000062ffffff821614613a8d5761364f8161368e565b505f90565b73ffffffffffffffffffffffffffffffffffffffff1680613ab257504790565b6020602491604051928380927f70a082310000000000000000000000000000000000000000000000000000000082523060048301525afa9081156124c2575f91613afa575090565b90506020813d602011613b21575b81613b1560209383612e2e565b81010312610330575190565b3d9150613b08565b9190915f8382019384129112908015821691151617611d9457565b6020830151955f9586959194913373ffffffffffffffffffffffffffffffffffffffff851614613d2d5760808416613b7e575b5050505050565b613c66926138ef613c6092613c4c946040519586947f575e24b4000000000000000000000000000000000000000000000000000000006020870152336024870152613c16604487018c73ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b8051151560e487015260208101516101048701526040015173ffffffffffffffffffffffffffffffffffffffff16610124860152565b61014061014485015261016484019161306c565b82613f25565b916060835103613d05576040015162ffffff166280000014613cf9575b600816613c94575b80808080613b77565b604001519250608083901d600f0b8015613c8b57613cb5905f861295613b29565b9315613cf1575f84135b613cc9575f613c8b565b7ffa0b71d6000000000000000000000000000000000000000000000000000000005f5260045ffd5b5f8412613cbf565b60608201519350613c83565b7f1e048e1d000000000000000000000000000000000000000000000000000000005f5260045ffd5b505f965086955050505050565b90600f0b90600f0b01907fffffffffffffffffffffffffffffffff8000000000000000000000000000000082126f7fffffffffffffffffffffffffffffff831317611d9457565b9196959394929473ffffffffffffffffffffffffffffffffffffffff83163314613f18578460801d94600f0b938860408516613e40575b50505050505f9481600f0b15801590613e34575b613dd8575b5050509190565b613e0f9395505f60208201511290511515145f14613e17576fffffffffffffffffffffffffffffffff169060801b175b80936145bf565b5f8080613dd1565b906fffffffffffffffffffffffffffffffff169060801b17613e08565b5082600f0b1515613dcc565b613efc613f08946138ef6118ed95613f0e999895613ee1613c16966040519788967fb47b2fb1000000000000000000000000000000000000000000000000000000006020890152336024890152604488019073ffffffffffffffffffffffffffffffffffffffff6080809282815116855282602082015116602086015262ffffff6040820151166040860152606081015160020b6060860152015116910152565b8c61014485015261016061016485015261018484019161306c565b6004821615159161459f565b90613d3a565b5f80808088613db8565b5050505050909150905f90565b9190918251925f8060208301958682865af115613fc3575050604051917fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0603f3d011683016040523d83523d9060208401915f833e6020845110918215613f8f575b5050613d0557565b5190517fffffffff000000000000000000000000000000000000000000000000000000009182169116141590505f80613f87565b5183517fffffffff00000000000000000000000000000000000000000000000000000000811691600481106140d7575b50507fffffffff000000000000000000000000000000000000000000000000000000007fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f3d01169173ffffffffffffffffffffffffffffffffffffffff604051947f90bfb865000000000000000000000000000000000000000000000000000000008652166004850152166024830152608060448301528060a00160648301523d60848301523d5f60a484013e7fa9e35b2f0000000000000000000000000000000000000000000000000000000060c4828401600460a4820152015260e40190fd5b7fffffffff000000000000000000000000000000000000000000000000000000009250829060040360031b1b16168280613ff3565b919060020b9060020b9081810761413a5705908160081d5f52602052600160ff60405f2092161b8154189055565b601c906044926040519163d4d8f3e683526020830152604082015201fd5b60020b908160ff1d82810118620d89e8811161449e5763ffffffff9192600182167001fffcb933bd6fad37aa2d162d1a59400102700100000000000000000000000000000000189160028116614482575b60048116614466575b6008811661444a575b6010811661442e575b60208116614412575b604081166143f6575b608081166143da575b61010081166143be575b61020081166143a2575b6104008116614386575b610800811661436a575b611000811661434e575b6120008116614332575b6140008116614316575b61800081166142fa575b6201000081166142de575b6202000081166142c3575b6204000081166142a8575b620800001661428f575b5f12614268575b0160201c90565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff04614261565b6b048a170391f7dc42444e8fa290910260801c9061425a565b6d2216e584f5fa1ea926041bedfe9890920260801c91614250565b916e5d6af8dedb81196699c329225ee6040260801c91614245565b916f09aa508b5b7a84e1c677de54f3e99bc90260801c9161423a565b916f31be135f97d08fd981231505542fcfa60260801c9161422f565b916f70d869a156d2a1b890bb3df62baf32f70260801c91614225565b916fa9f746462d870fdf8a65dc1f90e061e50260801c9161421b565b916fd097f3bdfd2022b8845ad8f792aa58250260801c91614211565b916fe7159475a2c29b7443b29c7fa6e889d90260801c91614207565b916ff3392b0822b70005940c7a398e4b70f30260801c916141fd565b916ff987a7253ac413176f2b074cf7815e540260801c916141f3565b916ffcbe86c7900a88aedcffc83b479aa3a40260801c916141e9565b916ffe5dee046a99a2a811c461f1969c30530260801c916141df565b916fff2ea16466c96a3843ec78b326b528610260801c916141d6565b916fff973b41fa98c081472e6896dfb254c00260801c916141cd565b916fffcb9843d60f6159c9db58835c9266440260801c916141c4565b916fffe5caca7e10e4e61c3624eaa0941cd00260801c916141bb565b916ffff2e50f5f656932ef12357cf3c7fdcc0260801c916141b2565b916ffff97272373d413259a46990580e213a0260801c916141a9565b827f8b86327a000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b905f83600f0b125f146144ff576144f5925f036fffffffffffffffffffffffffffffffff1691615a3d565b5f81126130c85790565b61451b926fffffffffffffffffffffffffffffffff16916159e2565b5f81126130c8575f0390565b905f83600f0b125f14614552576144f5925f036fffffffffffffffffffffffffffffffff1691615b34565b61451b926fffffffffffffffffffffffffffffffff1691615a7d565b906fffffffffffffffffffffffffffffffff90600f0b911601908160801c61459257565b6393dafdf15f526004601cfd5b906145a991613f25565b9015613a8d576040815103613d05576040015190565b6145e2906145d48360801d8260801d03613785565b92600f0b90600f0b03613785565b6fffffffffffffffffffffffffffffffff169060801b1790565b73fffd8963efd1fc6a506488495d951d516396168273ffffffffffffffffffffffffffffffffffffffff7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffefffd895d830116116148e05777ffffffffffffffffffffffffffffffffffffffff000000008160201b168060ff61467983615bdb565b1691608083106148d457507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8182011c5b800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c800280607f1c8160ff1c1c80029081607f1c8260ff1c1c80029283607f1c8460ff1c1c80029485607f1c8660ff1c1c80029687607f1c8860ff1c1c80029889607f1c8a60ff1c1c80029a8b607f1c8c60ff1c1c80029c8d80607f1c9060ff1c1c800260cd1c6604000000000000169d60cc1c6608000000000000169c60cb1c6610000000000000169b60ca1c6620000000000000169a60c91c6640000000000000169960c81c6680000000000000169860c71c670100000000000000169760c61c670200000000000000169660c51c670400000000000000169560c41c670800000000000000169460c31c671000000000000000169360c21c672000000000000000169260c11c674000000000000000169160c01c67800000000000000016907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff800160401b1717171717171717171717171717693627a301d71055774c85027ffffffffffffffffffffffffffffffffffd709b7e5480fba5a50fed5e62ffc556810160801d60020b906fdb2df09e81959a81455e260799a0632f0160801d60020b918282145f146148915750905090565b73ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff6148c584614158565b16116148cf575090565b905090565b905081607f031b6146a9565b73ffffffffffffffffffffffffffffffffffffffff907f61487524000000000000000000000000000000000000000000000000000000005f521660045260245ffd5b811561492c570490565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601260045260245ffd5b6040519290915f61496985612df6565b5f855260208501925f845260408601955f875280968654956040860151159586155f146156f557610fff8860b81c16945b8151925f948a73ffffffffffffffffffffffffffffffffffffffff16918288528b60a01c60020b90526fffffffffffffffffffffffffffffffff60038d0154169052608083015162400000811615155f146156e65762bfffff166149fd8161368e565b61ffff88166156cb575b8096620f424062ffffff8316101561569a575b8451156156845750508861562457606083019073ffffffffffffffffffffffffffffffffffffffff825116818110156155ed5750505173ffffffffffffffffffffffffffffffffffffffff166401000276a38111156155c257505b604051986101008a018a811067ffffffffffffffff821117611eb1576040525f8a525f60208b01525f60408b01525f60608b01525f60808b01525f60a08b01525f60c08b015288155f146155b45760018b0154949390945b60e08b01525b8015801561557a575b6154205788868d8c8e73ffffffffffffffffffffffffffffffffffffffff8351168252602083015160020b602089015160020b90815f8183071291050386155f14615275576fffffffffffffffffffffffffffffffff937ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff2761860409460019484600560ff60609716938260020b60081d890b5f5201602052875f207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8460ff031c9054169283151593845f146152635790614bb760ff92615bdb565b90031660020b900360020b0260020b5b905b15158684015260020b8060208401521315615238575b620d89e8602082015160020b121561522a575b73ffffffffffffffffffffffffffffffffffffffff614c17602083015160020b614158565b16918291015273ffffffffffffffffffffffffffffffffffffffff8551169673ffffffffffffffffffffffffffffffffffffffff60608c0151169283911516818310189118021892015116928d73ffffffffffffffffffffffffffffffffffffffff8316821015915f87125f1461507f5762ffffff8516620f424003614c9f81895f03615785565b94841561506e57614cb1888483615a7d565b955b868110614fb257509660a093929173ffffffffffffffffffffffffffffffffffffffff98978891620f424062ffffff8316145f14614f9e575050865b955b15614f905791614d0092615a3d565b925b60c0820152015260808d0152168c525f8351135f14614f605760a08a0151905f82126130c8570392614d3d60808b015160c08c015190612ffa565b5f81126130c8578103908113600116611d9457935b61ffff8716614f18575b6fffffffffffffffffffffffffffffffff60408d01511680614efe575b5073ffffffffffffffffffffffffffffffffffffffff8c511673ffffffffffffffffffffffffffffffffffffffff60608c01511681145f14614ec2575060408a0151614e10575b88614e03577fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff60208b015160020b0160020b5b60020b60208d01525b9392614ad3565b60208a015160020b614df3565b88614e96576fffffffffffffffffffffffffffffffff614e7d8d8d8d600460e08201519260206002820154935b015160020b60020b5f520160205260405f2091600183019081549003905560028201908154900390555460801d908c15614e88575b60400151831661456e565b1660408d0152614dc0565b5f91909103600f0b90614e72565b6fffffffffffffffffffffffffffffffff614e7d8d8d8d6004600183015492602060e084015193614e3d565b73ffffffffffffffffffffffffffffffffffffffff8b51168103614ee7575b50614dfc565b614ef0906145fc565b60020b60208d01525f614ee1565b60c08b015160801b0460e08b01510160e08b01525f614d79565b9662ffffff861661ffff881603614f435760c08a0151905b8160c08c01510360c08c01520196614d5c565b620f424060808b015161ffff89169060c08d015101020490614f30565b60808a015160c08b015101905f82126130c857019260a08a01515f81126130c857614f8a91613b29565b93614d52565b614f9992615b34565b614d00565b62ffffff614fad921689615c68565b614cef565b9650505092505082918415811517615061578e60a09173ffffffffffffffffffffffffffffffffffffffff96845f14614ffc57614ff0878284615d07565b80978a015f0395614cf1565b87871161503a576150356150306150286fffffffffffffffffffffffffffffffff84168a60601b614922565b8a8516612ffa565b615d9b565b614ff0565b61503561503061505c6fffffffffffffffffffffffffffffffff84168a61588a565b615028565b634f2461b85f526004601cfd5b6150798882856159e2565b95614cb3565b9193509190831561521957615095858284615a3d565b915b8287106150f7579073ffffffffffffffffffffffffffffffffffffffff9560a09280965b156150e857916150ca92615a7d565b925b6150e362ffffff8d16620f42408190039086615c68565b614d02565b6150f1926159e2565b926150cc565b50915050838315821517615061578d83156151ef575073ffffffffffffffffffffffffffffffffffffffff851161519c578460601b6fffffffffffffffffffffffffffffffff851680820615159104015b73ffffffffffffffffffffffffffffffffffffffff8316928184111561518f578f939573ffffffffffffffffffffffffffffffffffffffff60a093819803165b80966150bb565b634323a5555f526004601cfd5b6fffffffffffffffffffffffffffffffff84166151c7816c0100000000000000000000000088615943565b90801561492c576c010000000000000000000000008709156151485760010180615148575f80fd5b9180856152148873ffffffffffffffffffffffffffffffffffffffff9860a095615c91565b615188565b615224858383615b34565b91615097565b620d89e86020820152614bf2565b7ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff276186020820152614bdf565b5060020b900360020b0260020b614bc7565b60019194939650600592955001938460020b60081d60010b5f520160205260405f207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff600160ff86161b0119905416908d8b831592831597885f146153c15750505050610330578f9160018f8f96907ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff276186060928f989560409660ff896fffffffffffffffffffffffffffffffff9a5f03166101e07f804040554300526644320000502061067405302602000010750620017611707760fc7fb6db6db6ddddddddd34d34d349249249210842108c6318c639ce739cffffffff840260f81c161b60f71c167e1f0d1e100c1d070f090b19131c1706010e11080a1a141802121b1503160405601f85851693831c63d76453e004161a17031660020b9060020b0160020b0260020b5b90614bc9565b90956fffffffffffffffffffffffffffffffff955060409450600193987ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27618918960ff6060969b811681031660020b9060020b0160020b0260020b6153bb565b949891955099969298919598602088015160a01b76ffffff0000000000000000000000000000000000000000167fffffffffffffffffff000000000000000000000000000000000000000000000073ffffffffffffffffffffffffffffffffffffffff8a51169216171782556fffffffffffffffffffffffffffffffff6003830154166fffffffffffffffffffffffffffffffff604089015116809103615535575b5082156155265760e060029101519101555b825190155f82121461551057506154ee6154f69293613785565b925103613785565b6fffffffffffffffffffffffffffffffff169060801b1793565b6154f69250906155209103613785565b91613785565b60e060019101519101556154d4565b6fffffffffffffffffffffffffffffffff167fffffffffffffffffffffffffffffffff000000000000000000000000000000006003840154161760038301555f6154c2565b5073ffffffffffffffffffffffffffffffffffffffff8c511673ffffffffffffffffffffffffffffffffffffffff60608501511614614adc565b60028b015494939094614acd565b7f9e4d7cc7000000000000000000000000000000000000000000000000000000005f5260045260245ffd5b60449250604051917f7c9c6e8f00000000000000000000000000000000000000000000000000000000835260048301526024820152fd5b606083019073ffffffffffffffffffffffffffffffffffffffff825116818111156155ed5750505173ffffffffffffffffffffffffffffffffffffffff1673fffd8963efd1fc6a506488495d951d5263988d268110156155c25750614a75565b9a509a50509950505050505050505f925f929190565b5f85511315614a1a577f96206246000000000000000000000000000000000000000000000000000000005f5260045ffd5b62ffffff610fff89169116620f424081830204910103614a07565b508960d01c62ffffff166149fd565b610fff8860c41c169461499a565b90808202917fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff828209918380841093039280840393847001000000000000000000000000000000001115610330571461577c57700100000000000000000000000000000000910990828211900360801b910360801c1790565b50505060801c90565b818102907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff83820990828083109203918083039283620f424011156103305714615804577fde8f6cefed634549b62c77574f722e1ac57e23f24d8fd5cb790fb65668c2613993620f4240910990828211900360fa1b910360061c170290565b5050620f424091500490565b90808202917fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff828209918380841093039280840393846c0100000000000000000000000011156103305714615881576c01000000000000000000000000910990828211900360a01b910360601c1790565b50505060601c90565b908160601b907fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6c01000000000000000000000000840992828085109403938085039485841115610330571461593c576c0100000000000000000000000082910981805f03168092046002816003021880820260020302808202600203028082026002030280820260020302808202600203028091026002030293600183805f03040190848311900302920304170290565b5091500490565b91818302917fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8185099383808610950394808603958685111561033057146159da579082910981805f03168092046002816003021880820260020302808202600203028082026002030280820260020302808202600203028091026002030293600183805f03040190848311900302920304170290565b505091500490565b6fffffffffffffffffffffffffffffffff6c010000000000000000000000009173ffffffffffffffffffffffffffffffffffffffff80600195169116038060ff1d90810118931692615a348185615810565b93091515160190565b6fffffffffffffffffffffffffffffffff9073ffffffffffffffffffffffffffffffffffffffff8061364f9594169116038060ff1d908101189116615810565b9073ffffffffffffffffffffffffffffffffffffffff811673ffffffffffffffffffffffffffffffffffffffff831611615b2e575b73ffffffffffffffffffffffffffffffffffffffff8216928315615b22577bffffffffffffffffffffffffffffffff00000000000000000000000073ffffffffffffffffffffffffffffffffffffffff615b16948185169403169160601b16615c68565b90808206151591040190565b62bfc9215f526004601cfd5b90615ab2565b73ffffffffffffffffffffffffffffffffffffffff821673ffffffffffffffffffffffffffffffffffffffff821611615bd5575b73ffffffffffffffffffffffffffffffffffffffff8116918215615b225761364f937bffffffffffffffffffffffffffffffff00000000000000000000000073ffffffffffffffffffffffffffffffffffffffff615bd0948185169403169160601b16615943565b614922565b90615b68565b8015610330577f07060605060205000602030205040001060502050303040105050304000000006f8421084210842108cc6318c6db6d54be826fffffffffffffffffffffffffffffffff1060071b83811c67ffffffffffffffff1060061b1783811c63ffffffff1060051b1783811c61ffff1060041b1783811c60ff1060031b1792831c1c601f161a1790565b929190615c76828286615943565b93821561492c5709615c8457565b9060010190811561033057565b91908115615d02577bffffffffffffffffffffffffffffffff00000000000000000000000073ffffffffffffffffffffffffffffffffffffffff9160601b169216918282029183838311918404141615615cf55761364f9261503092820391615c68565b63f5c787f15f526004601cfd5b505090565b90918015615d955773ffffffffffffffffffffffffffffffffffffffff7bffffffffffffffffffffffffffffffff000000000000000000000000819460601b16921680820281615d578483614922565b14615d7d575b5090615d6c615d719284614922565b612ffa565b80820615159104011690565b8301838110615d5d579150615d9192615c68565b1690565b50905090565b9073ffffffffffffffffffffffffffffffffffffffff82169182036130c85756fea2646970667358221220255672e3fe782a34aefafbcc828d1cd93c6b2261e205f65c6197dd833e65f44464736f6c634300081a0033";
}
