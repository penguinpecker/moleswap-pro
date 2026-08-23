// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {CustomRevert} from "v4-core/libraries/CustomRevert.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {MoleQueue, IMoleOracle} from "../src/MoleQueue.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {MoleFeeCollector} from "../src/MoleFeeCollector.sol";
import {ZapLogic} from "../src/libraries/ZapLogic.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {DeployConfig} from "../src/config/DeployConfig.sol";
import {
    deployMoleVault,
    deployMoleVaultOwned,
    deployMoleQueue,
    deployMoleRouter,
    hookProxyArgs,
    TEST_UPGRADE_ADMIN
} from "./helpers/ProxyDeploy.sol";

/// @dev A fee recipient that refuses every call. The performance fee is paid as an ERC-6909 CREDIT inside
///      the PoolManager, so this contract is never called — which is the point: if the payout ever became
///      a transfer or a callback, the exit that carries the fee would revert here.
contract RevertingRecipient {
    fallback() external payable {
        revert("RevertingRecipient: refused");
    }

    receive() external payable {
        revert("RevertingRecipient: refused");
    }
}

/// @dev The v4 PoolManager consults a hook by its ADDRESS BITS, so the strongest statement of the exit
///      guarantee is reached by replacing the hook's code with something that cannot answer anything.
///      `PUSH1 0 PUSH1 0 REVERT`: every call to an account holding it reverts with no data. (Not INVALID,
///      which would also burn all forwarded gas and turn each premise call into a 63/64 gas sink.)
bytes constant REVERT_EVERYTHING = hex"60006000fd";

/*//////////////////////////////////////////////////////////////////////////////
                          EXIT-PATH PROOFS — THE VAULT
//////////////////////////////////////////////////////////////////////////////*/

/// @title ExitPathVaultTest
/// @notice The dynamic half of C-8 / P-33 / P-69 / FLOW-12 / T-5: "no bug, key, pause or upgrade can block an
///         exit" stated as a battery of tests that first put the protocol into the most hostile state its own
///         levers allow — keeper revoked AND expired, every admin setter pointed at a useless value, the root
///         key burned, the oracle unable to answer, the hook's code replaced by a revert, the whitelist
///         changed — prove that the hostility is REAL (the keeper, the depositor and the former root key are
///         all refused), and only then withdraw. Every exit must pay the stored owner in full and leave the
///         vault holding nothing.
///
/// Companion: test/ExitPathStatic.t.sol reads the SOURCE and pins the same property structurally (no modifier
/// but the owner check on the exit call graph, the whole external surface pinned by signature so no recipient
/// can arrive under any name, every identifier in every exit body on a per-function allowlist and every
/// revert on the path pinned — so a keeper/oracle/admin/flag read under any name fails).
/// HookPermissions.t.sol pins the address-bit half (the PoolManager cannot call our hook on removal).
///
/// WHAT IS NOT CLAIMED HERE, stated so nobody reads this file as more than it is: a token that refuses to
/// pay the owner (blocklist, rebase, revert-on-transfer) still strands that owner — that is the accepted
/// price of the hardcoded recipient and is pinned as such in AttackPoolAndTokens.t.sol. And an UPGRADE of
/// the vault itself can replace `withdraw`; AttackUpgradeability.t.sol performs that, on purpose. The
/// claim proven here is the one that survives everything short of those two: no KEY we hold, no LEVER we
/// built, no PAUSE (there is none), no ORACLE state and no HOOK state can block the owner's exit.
///
/// TIME. `vm.warp(block.timestamp + d)` does not accumulate inside one call frame (block.timestamp is
/// cached), so the file moves an explicit `_clock` / `_height`.
contract ExitPathVaultTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    address internal KEEPER = makeAddr("exit.keeper");
    address internal alice = makeAddr("exit.alice");
    address internal bob = makeAddr("exit.bob");
    address internal stranger = makeAddr("exit.stranger");
    address internal treasuryOwner = makeAddr("exit.treasuryOwner");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;
    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;

    /// @dev A realistic chain timestamp: `consult` fails closed on `secondsAgo > block.timestamp`, so the
    ///      default timestamp of 1 would make the oracle revert for the wrong reason.
    uint256 internal constant T0 = 1_750_000_000;

    /// @dev Same hard wei budget as the keeper suites: v4 rounds mint costs up and burn proceeds down, so one
    ///      open + withdraw round trip leaks a few wei to the pool. A percentage could absorb a real loss.
    uint256 internal constant DUST_WEI = 8;

    MoleHook internal hook;
    PoolKey internal hookKey;
    MolePositions internal vault;
    MoleFeeCollector internal collector;
    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;

    /* ------------------------------------------------------------------ harness */

    function _advance(uint256 secs, uint256 blocks) internal {
        _clock += secs;
        _height += blocks;
        vm.warp(_clock);
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("exit-path", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deployHook(uint256 seed) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(
                manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasuryOwner, TEST_UPGRADE_ADMIN
            ),
            a
        );
        h = MoleHook(a);
    }

    function _newPool(MoleHook h, int24 spacing) internal returns (PoolKey memory k) {
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
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 5_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
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

    /// @dev Alternating swaps spaced beyond the observation interval, covering more than the vault's TWAP
    ///      window, so `consult(twapWindow)` answers and the keeper path is genuinely live. Alternation keeps
    ///      spot centred, so a position opened before the warm-up loses nothing to price movement and the
    ///      recovery assertions can be exact to the wei budget.
    function _warmOracle(PoolKey memory k) internal {
        for (uint256 i = 0; i < 8; i++) {
            _advance(300, 25);
            _swap(k, i % 2 == 0, 1e15);
        }
    }

    /// @dev The shipped keeper policy except the cadence and dwell, which are ZERO here so that the keeper
    ///      path is reachable the moment a position opens — every keeper refusal in this file is then
    ///      attributable to the hostility under test and not to a timer that would have refused anyway.
    function _newVault(address keeper_, address feeRecipient_) internal returns (MolePositions) {
        return deployMoleVault(
            manager,
            keeper_,
            0, // minRebalanceInterval
            MIN_W,
            MAX_W,
            address(hook),
            DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS,
            DeployConfig.DEFAULT_TWAP_WINDOW,
            0, // minDwellL1Blocks
            0, // maxRebalancesPerL1Block (off)
            DeployConfig.DEFAULT_MAX_EJECTION_BPS,
            DeployConfig.DEFAULT_MAX_RECENTER_TICKS,
            DeployConfig.DEFAULT_PERFORMANCE_FEE_BPS,
            feeRecipient_
        );
    }

    function _fund(address who, address spender) internal {
        t0.mint(who, 1_000_000e18);
        t1.mint(who, 1_000_000e18);
        vm.startPrank(who);
        t0.approve(spender, type(uint256).max);
        t1.approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _value(address who) internal view returns (uint256) {
        return t0.balanceOf(who) + t1.balanceOf(who);
    }

    function _open(MolePositions m, PoolKey memory k, address who, uint128 liq) internal returns (uint256 id) {
        vm.prank(who);
        id = m.open(k, -600, 600, liq, type(uint256).max, type(uint256).max, block.timestamp + 1);
    }

    function _zapOpen(MolePositions m, PoolKey memory k, address who, uint256 amountIn) internal returns (uint256 id) {
        ZapLogic.ZapParams memory z = ZapLogic.ZapParams({
            key: k,
            tickLower: -600,
            tickUpper: 600,
            zeroForOne: true,
            amountIn: amountIn,
            swapAmount: amountIn / 2,
            minLiquidity: 1,
            amountOutMin: 0
        });
        vm.prank(who);
        id = m.zapOpen(z, block.timestamp + 1);
    }

    /// @dev Everything the custody claim means, checked after every exit: the position is gone, the owner was
    ///      paid, the vault holds no token and no ERC-6909 claim of either currency.
    function _assertCleanExit(MolePositions m, uint256 id, address owner, uint256 ownerValueBefore) internal view {
        assertEq(m.getPosition(id).liquidity, 0, "exit left liquidity behind");
        assertGt(_value(owner), ownerValueBefore, "exit paid the owner nothing");
        assertEq(t0.balanceOf(address(m)), 0, "vault retained currency0");
        assertEq(t1.balanceOf(address(m)), 0, "vault retained currency1");
        assertEq(manager.balanceOf(address(m), currency0.toId()), 0, "vault retained currency0 claims");
        assertEq(manager.balanceOf(address(m), currency1.toId()), 0, "vault retained currency1 claims");
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        hook = _deployHook(1);
        hookKey = _newPool(hook, SPACING);

        collector = new MoleFeeCollector(manager, treasuryOwner);
        vault = _newVault(KEEPER, address(collector));
        vault.whitelistPool(hookKey);

        _fund(alice, address(vault));
        _fund(bob, address(vault));
    }

    /* ==========================================================================
       1. EVERY LEVER HOSTILE, ROOT KEY BURNED — the exit still pays in full.
       ========================================================================== */

    /// @notice THE HEADLINE. Positions are opened on a live, oracle-backed vault; the keeper is shown to be
    ///         genuinely managing them; then every party with any power uses it against the depositor —
    ///         the owner revokes the keeper, the root key expires the keeper, closes deposits with the size
    ///         band, makes every range illegal with the width band, repoints the fee to a contract that
    ///         refuses every call, lists a second pool, and finally BURNS ITSELF — and every one of those
    ///         refusals is proven live before the owner exits. Then the owner withdraws half, then the rest,
    ///         and the zap-opened position too, each paying the stored owner and leaving the vault empty.
    function test_exit_survivesEveryHostileLeverAndTheBurnedRootKey() public {
        // THE ORACLE IS WARMED FIRST NOW, and the fee-earning swaps moved to a SECOND round after A and B
        // open. `open`/`zapOpen` gained a spot-vs-TWAP gate on 2026-08-23 (F-07 mechanism A) and `consult`
        // fails closed on a pool younger than the window, so a deposit can no longer precede the warm-up.
        // What the original ordering was for — A and B holding REALIZED fees when they exit, so the
        // performance-fee leg of the exit is exercised rather than trivially zero — is preserved by the
        // second round, and is asserted rather than assumed at the end of this test (`refusedClaims > 0`).
        _warmOracle(hookKey);

        uint256 aliceStart = _value(alice);
        uint256 bobStart = _value(bob);

        uint256 idA = _open(vault, hookKey, alice, 1e18);
        uint256 idB = _zapOpen(vault, hookKey, bob, 1e18);
        _warmOracle(hookKey);
        // C opens AFTER the warm-up, so no swap touches it and its recovery can be asserted to the wei.
        uint256 valueBeforeC = _value(alice);
        uint256 idC = _open(vault, hookKey, alice, 1e18);
        uint256 depositedC = valueBeforeC - _value(alice);
        assertGt(depositedC, 0, "premise: nothing was deposited for C");

        // PREMISE: the keeper path is LIVE. Without this, "the keeper is refused" below proves nothing.
        vm.prank(KEEPER);
        vault.rebalance(idC, -540, 660);
        assertEq(vault.getPosition(idC).tickLower, -540, "premise: the keeper could not rebalance a fresh position");
        // The rebalance may hand the owner displaced-leg dust; fold it into C's recovery accounting.
        uint256 rebalanceDustC = _value(alice) - (valueBeforeC - depositedC);

        // ---- every lever, pointed at its worst value ----------------------------------------------
        vm.prank(alice);
        vault.setKeeperRevoked(idA, true);

        RevertingRecipient refusing = new RevertingRecipient();
        vm.startPrank(TEST_UPGRADE_ADMIN);
        vault.setKeeperExpiry(uint64(block.timestamp - 1)); // already expired
        vault.setPositionSizeBand(type(uint128).max, type(uint128).max); // no deposit can satisfy this
        vault.setRangeWidthBand(1, 1); // no range on spacing 60 can satisfy this
        vault.setFeeRecipient(address(refusing)); // the cut now goes to a contract that refuses every call
        vault.transferUpgradeAdmin(address(0)); // and the root key is gone
        vm.stopPrank();

        // A second pool on the same hook, listed after the positions exist — the whitelist CHANGED.
        PoolKey memory second = _newPool(hook, 10);
        vault.whitelistPool(second);
        assertTrue(vault.isWhitelisted(second.toId()), "premise: the second pool was not listed");

        // ---- prove the hostility is real, refusal by refusal -------------------------------------
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        vault.rebalance(idA, -540, 660);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperExpired.selector);
        vault.rebalance(idC, -600, 600);

        vm.prank(alice);
        vm.expectRevert(MolePositions.PositionTooSmall.selector);
        vault.open(hookKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        // (Created BEFORE the armed revert: `expectRevert` binds to the next call OR create.)
        MolePositions otherImpl = new MolePositions();
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.upgradeToAndCall(address(otherImpl), "");

        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.setKeeperExpiry(0);

        assertEq(vault.upgradeAdmin(), address(0), "premise: the root key was not burned");
        assertEq(vault.feeRecipient(), address(refusing), "premise: the fee was not repointed");

        // ---- and nobody but the owner can exit for the owner -------------------------------------
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        vault.withdraw(idA, 1);
        vm.prank(stranger);
        vm.expectRevert(MolePositions.NotOwner.selector);
        vault.withdrawAll(idA);
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MolePositions.NotOwner.selector);
        vault.withdrawAll(idA);

        // ---- THE EXITS ----------------------------------------------------------------------------
        uint128 liqA = vault.getPosition(idA).liquidity;
        uint256 aliceBeforeExit = _value(alice);

        vm.expectEmit(true, true, false, false, address(vault));
        emit MolePositions.PositionWithdrawn(idA, alice, liqA / 2, 0, 0);
        vm.prank(alice);
        vault.withdraw(idA, liqA / 2);
        assertEq(vault.getPosition(idA).liquidity, liqA - liqA / 2, "partial withdraw did not reduce liquidity");
        assertGt(_value(alice), aliceBeforeExit, "partial withdraw paid nothing");

        vm.prank(alice);
        vault.withdrawAll(idA);
        _assertCleanExit(vault, idA, alice, aliceBeforeExit);

        uint256 aliceBeforeC = _value(alice);
        vm.prank(alice);
        vault.withdrawAll(idC);
        _assertCleanExit(vault, idC, alice, aliceBeforeC);
        // C saw no swap, so it comes back whole: what was deposited, minus only v4's fixed rounding.
        assertApproxEqAbs(
            _value(alice) - aliceBeforeC + rebalanceDustC, depositedC, DUST_WEI, "C did not return the full deposit"
        );

        uint256 bobBefore = _value(bob);
        vm.prank(bob);
        vault.withdrawAll(idB);
        _assertCleanExit(vault, idB, bob, bobBefore);

        // Nothing was lost to custody. A earned fees through the warm-up and C came back whole, so alice
        // ends at or above her start (three exits, so three wei budgets). B paid the pool's fee and price
        // impact on the half it swapped to zap in, and nothing else: its loss is bounded by that.
        assertGe(_value(alice) + 3 * DUST_WEI, aliceStart, "alice ended below her starting value");
        int256 bobDelta = int256(_value(bob)) - int256(bobStart);
        uint256 swappedHalf = 1e18 / 2;
        int256 zapCostCeiling = int256(swappedHalf * uint256(LP_FEE) / 1_000_000 + swappedHalf / 1_000 + DUST_WEI);
        assertGe(bobDelta, -zapCostCeiling, "bob lost more than the zap's swap fee and impact");

        // The cut WAS taken — as a credit to a recipient that refuses every call — which is the proof the
        // fee leg of an exit never calls the recipient.
        uint256 refusedClaims =
            manager.balanceOf(address(refusing), currency0.toId()) + manager.balanceOf(address(refusing), currency1.toId());
        assertGt(refusedClaims, 0, "premise: no performance fee was charged, so the fee leg was not exercised");
    }

    /* ==========================================================================
       2. THE ORACLE CANNOT ANSWER — the keeper is blind, the owner is not.
       ========================================================================== */

    /// @notice An oracle that CANNOT ANSWER the vault's window, which fails the keeper CLOSED (the TWAP
    ///         bound refuses to act blind). The exit reads no oracle and must not notice.
    ///
    /// HOW THE UNANSWERABLE STATE IS BUILT, and why it is no longer "a young pool" (rewritten 2026-08-24).
    /// The original fixture opened into a brand-new pool and asserted that `consult(1800)` reverted. Two
    /// things about that went stale on 2026-08-23, in opposite directions:
    ///   - `open` gained the spot-vs-TWAP deposit gate (F-07 mechanism A), so a position can no longer be
    ///     created while the oracle is refusing at all. The position has to exist FIRST.
    ///   - `consult` gained the quiet-tail path, so a pool that has simply never traded now ANSWERS any
    ///     window inside its own life — correctly: with no swap in the window the mean IS `lastTick`.
    /// So the premise is rebuilt from the refusal that survives, and it is the one MoleHook's header calls
    /// out as cheaply reachable: THE SUB-INTERVAL BAND. A swap landing inside a ring write-gap advances
    /// `lastTimestamp` without writing an observation, and a window whose left edge falls into that gap has
    /// exact endpoints on both sides but an UNRECORDED tick path between them — so it takes the bracketed
    /// path, finds nothing newer than itself in the ring, and fails closed. Below: the ring is warmed
    /// (writes 300s apart), a dust swap lands 30s past the last write (60s interval, so no write), the
    /// position is opened while the oracle still answers, and the clock is then advanced until the window's
    /// left edge sits inside that 30-second gap. Nothing touches the pool after the position opens, which
    /// is what keeps the wei-exact recovery assertion meaningful.
    function test_exit_survivesAnOracleThatCannotAnswer() public {
        uint32 window = vault.twapWindow();
        PoolId pid = hookKey.toId();

        // Ring writes at T0, T0+300 ... T0+2400. `lastTimestamp == lastObsTimestamp == T0+2400`.
        _warmOracle(hookKey);

        // The dust swap that opens the band: 30 seconds past the last ring write, which is less than the
        // 60-second observation interval, so it moves `lastTimestamp` and writes NOTHING.
        _advance(30, 3);
        _swap(hookKey, true, 1e12);

        // The position is opened while the oracle can still answer — it has to be, now that the deposit is
        // gated on the same read the keeper uses.
        uint256 before = _value(alice);
        uint256 id = _open(vault, hookKey, alice, 1e18);
        uint256 deposited = before - _value(alice);

        // Advance until `block.timestamp - window` lands strictly inside the write gap: the left edge is
        // then newer than the newest observation and older than the last swap. No swap here, so the
        // position is untouched.
        _advance(window - 15, 150);

        // PREMISE: the oracle really cannot answer the vault's window...
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        hook.consult(pid, window);
        // ...and it is THE WINDOW that cannot be covered, not the oracle that is dead — a shorter window
        // clears the gap into the quiet tail and a longer one reaches back over it into the ring, and both
        // answer. Without this the test would also pass against an oracle that simply reverted always.
        hook.consult(pid, window - 60);
        hook.consult(pid, window + 60);

        // ...and the refusal is exactly what stops the keeper.
        vm.prank(KEEPER);
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        vault.rebalance(id, -540, 660);

        vm.prank(alice);
        vault.withdrawAll(id);
        _assertCleanExit(vault, id, alice, before - deposited);
        assertApproxEqAbs(_value(alice), before, DUST_WEI, "the owner did not get the deposit back");
    }

    /// @notice A STALE oracle: the pool is warmed, then idles for a month, then the market jumps. The TWAP
    ///         still answers but is far from spot, so the keeper's TWAP bound refuses a recentre to the new
    ///         price. Stale or fresh, the exit does not read it.
    function test_exit_survivesAStaleOracleAndAMovedMarket() public {
        _warmOracle(hookKey);
        uint256 id = _open(vault, hookKey, alice, 1e18);

        // PREMISE: the keeper path is live while the oracle is fresh.
        vm.prank(KEEPER);
        vault.rebalance(id, -540, 660);

        // A month of silence, then one large move UP. The 30-minute TWAP still answers — it is stale, not
        // broken — and trails spot by far more than the 600-tick deviation bound.
        _advance(30 days, 30 days / 12);
        _swap(hookKey, false, 800e18);
        int24 twap = hook.consult(hookKey.toId(), vault.twapWindow());
        (, int24 spot,,) = manager.getSlot0(hookKey.toId());
        int24 drift = spot > twap ? spot - twap : twap - spot;
        assertGt(drift, vault.maxTwapDeviationTicks(), "premise: the market move did not outrun the TWAP");

        // TWO REFUSALS, BOTH PROVEN, because the keeper's bounds were reworked on 2026-08-23 for F-07 and
        // the FIRST one to fire changed. Read them in the order the contract checks them.
        //
        // 1. THE PRICE-INDEPENDENT BOUND, now measured on the EDGES rather than the midpoint (F-07
        //    mechanism C: [-1000,1000] -> [540,660] moved a lower edge 1,540 ticks while the midpoint read
        //    600, which stepped a position clean off spot inside a bound that was satisfied on paper).
        //    (-540, 660) -> (360, 960) moves the lower edge 900, so this refusal now comes first. It was
        //    NOT the refusal this test used to get, and that is the whole change: the old assertion asked
        //    for a range that a midpoint bound admitted and an edge bound does not.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.RecenterTooFar.selector);
        vault.rebalance(id, 360, 960);

        // 2. THE STALE ORACLE, which is what this test is about. (-540, 660) -> (60, 1260) moves BOTH edges
        //    by exactly the 600-tick allowance, so the price-independent bound is satisfied and the keeper
        //    reaches the TWAP block — where the new spot-vs-TWAP gate (F-07 mechanism A) refuses, because
        //    the market has run 30 days ahead of an anchor that still reads ~0. That is the oracle's
        //    staleness deciding, exactly as before; it is a different error only because a STRICTER guard
        //    now stands in front of the one this test used to name. `RangeTooFarFromTwap` — the keeper
        //    picked a bad place to stand — is unreachable on this fixture once spot itself is out of band,
        //    and stays pinned in KeeperBounds.t.sol and the AttackKeeperBounds suites.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.SpotTooFarFromTwap.selector);
        vault.rebalance(id, 60, 1260);

        // ...and the owner, whose position is now one-sided, leaves anyway.
        uint256 before = _value(alice);
        vm.prank(alice);
        vault.withdrawAll(id);
        _assertCleanExit(vault, id, alice, before);
    }

    /* ==========================================================================
       3. THE HOOK'S CODE IS GONE — the PoolManager never calls it on removal.
       ========================================================================== */

    /// @notice The hook proxy's code is replaced by INVALID, so every call to it reverts: the oracle is
    ///         dead, swaps through the pool revert, new deposits revert (beforeAddLiquidity). Withdrawal
    ///         does not call the hook — the remove-liquidity bits are clear in its address — so it succeeds
    ///         against a pool that is otherwise completely frozen. This is the strongest form of the claim.
    function test_exit_survivesTheHookCodeBeingReplacedByRevertEverything() public {
        _warmOracle(hookKey);
        uint256 idA = _open(vault, hookKey, alice, 1e18);
        uint256 idB = _zapOpen(vault, hookKey, bob, 1e18);

        vm.etch(address(hook), REVERT_EVERYTHING);
        assertEq(address(hook).code, REVERT_EVERYTHING, "premise: the hook code was not replaced");
        assertTrue(HookPermissions.withdrawalIsUnblockable(address(hook)), "premise: the address bits moved");

        // PREMISES: everything that DOES reach the hook now fails.
        (bool ok,) = address(hook).staticcall(abi.encodeCall(IMoleOracle.consult, (hookKey.toId(), 1800)));
        assertFalse(ok, "premise: the dead hook answered consult");

        vm.expectPartialRevert(CustomRevert.WrappedError.selector);
        _swap(hookKey, true, 1e15);

        // NEW DEPOSITS REVERT — and WHERE they revert moved on 2026-08-23. `open` now consults the oracle
        // before it touches the pool (F-07 mechanism A), so a deposit dies at the gate and never reaches
        // `beforeAddLiquidity`; a high-level call into code that is `PUSH1 0 PUSH1 0 REVERT` bubbles a
        // revert with NO DATA, which is why the old `expectPartialRevert(WrappedError)` here now fails with
        // "reverted as expected, but without data". Asserted as what it actually is — a refusal carrying
        // zero bytes — rather than loosened to a bare `expectRevert()` that any revert would satisfy.
        vm.prank(alice);
        (bool openOk, bytes memory openRet) = address(vault).call(
            abi.encodeCall(
                MolePositions.open,
                (hookKey, -600, 600, 1e18, type(uint256).max, type(uint256).max, block.timestamp + 1)
            )
        );
        assertFalse(openOk, "a deposit succeeded against a dead oracle");
        assertEq(openRet.length, 0, "the dead hook's refusal arrived with data");

        // ...and the hook would refuse the add anyway, which is the fact the assertion above used to carry:
        // a direct add through the PoolManager still dies inside `beforeAddLiquidity`, wrapped by v4. So
        // both doors are still proven shut, they are just no longer the same door.
        vm.expectPartialRevert(CustomRevert.WrappedError.selector);
        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}),
            ZERO_BYTES
        );

        vm.prank(KEEPER);
        vm.expectRevert(); // the TWAP bound consults the hook, which now cannot answer at all
        vault.rebalance(idA, -540, 660);

        // THE EXITS: partial, then full, then the zap-opened one.
        uint256 aliceBefore = _value(alice);
        uint128 liqA = vault.getPosition(idA).liquidity;
        vm.prank(alice);
        vault.withdraw(idA, liqA / 3);
        assertGt(_value(alice), aliceBefore, "partial exit paid nothing against a dead hook");
        vm.prank(alice);
        vault.withdrawAll(idA);
        _assertCleanExit(vault, idA, alice, aliceBefore);

        uint256 bobBefore = _value(bob);
        vm.prank(bob);
        vault.withdrawAll(idB);
        _assertCleanExit(vault, idB, bob, bobBefore);
    }

    /// @notice NEGATIVE CONTROL for the test above — the same dead code at an address that DOES carry a
    ///         remove-liquidity bit blocks removal. Without this, "the exit survived a dead hook" could be
    ///         true of any hook and prove nothing about ours; with it, the bit is shown to be the difference.
    function test_control_aDeadHookWithTheRemoveBitBlocksRemoval_oursDoesNot() public {
        // A hook address whose ONLY bit is beforeRemoveLiquidity, holding revert-everything code. The
        // PoolManager initialises a pool against it (no beforeInitialize bit, so nothing is called).
        address blocking = address(
            (uint160(uint256(keccak256("exit-path.control"))) & ~HookPermissions.ALL_HOOK_MASK)
                | uint160(0x0200)
        );
        vm.etch(blocking, REVERT_EVERYTHING);
        assertFalse(HookPermissions.withdrawalIsUnblockable(blocking), "premise: control hook lacks the remove bit");

        PoolKey memory bk = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: 3000,
            tickSpacing: SPACING,
            hooks: IHooks(blocking)
        });
        manager.initialize(bk, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            bk, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}), ZERO_BYTES
        );

        // Removal through the PoolManager reaches the dead hook and dies with it.
        vm.expectPartialRevert(CustomRevert.WrappedError.selector);
        modifyLiquidityRouter.modifyLiquidity(
            bk, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: -1e18, salt: 0}), ZERO_BYTES
        );

        // The same dead code behind OUR bitmap: removal never reaches it.
        vm.etch(address(hook), REVERT_EVERYTHING);
        uint256 before = t0.balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -1_000e18, salt: 0}),
            ZERO_BYTES
        );
        assertGt(t0.balanceOf(address(this)), before, "removal against our dead hook paid nothing");

        // And the vault cannot even be pointed at the blocking shape: the pin is refused at initialisation.
        // (A bit-for-bit statement that the control hook is the thing our design forbids.)
        assertFalse(HookPermissions.isValid(blocking), "the control hook passes our own bitmap check");
    }

    /* ==========================================================================
       4. NO CODE ANYWHERE — keeper, root key and fee recipient are bare addresses,
          the hook is erased, and a decade passes. The exit is unchanged.
       ========================================================================== */

    /// @notice P-33's required shape: keeper, upgrade admin and fee recipient are CODELESS addresses (the
    ///         root key then burned), the hook's code is erased outright (not even a revert — empty), ten
    ///         years and a million L1 blocks go by. `withdraw` reads none of it.
    function test_exit_needsNoKeeperCodeNoAdminCodeNoHookCodeAndNoClock() public {
        // The deposit needs a warm oracle (see `test_exit_isIndifferentToTheWhitelist`). The hook is erased
        // AFTER the position exists, which is the state this test is actually about.
        _warmOracle(hookKey);

        address codelessKeeper = makeAddr("codeless.keeper");
        address codelessTreasury = makeAddr("codeless.treasury");
        assertEq(codelessKeeper.code.length, 0, "premise: keeper has code");
        assertEq(TEST_UPGRADE_ADMIN.code.length, 0, "premise: admin has code");

        MolePositions bare = _newVault(codelessKeeper, codelessTreasury);
        bare.whitelistPool(hookKey);
        _fund(alice, address(bare));

        uint256 before = _value(alice);
        uint256 id = _open(bare, hookKey, alice, 1e18);
        uint256 deposited = before - _value(alice);

        vm.prank(TEST_UPGRADE_ADMIN);
        bare.transferUpgradeAdmin(address(0));

        // Erase the hook entirely. A call to a codeless address returns success with NO data — nobody is
        // home — which every typed caller (the vault's TWAP bound included) rejects at decode time. A
        // different way of being unreachable than the revert-everything case, covered for that reason.
        vm.etch(address(hook), "");
        assertEq(address(hook).code.length, 0, "premise: the hook still has code");
        (bool ok, bytes memory ret) = address(hook).staticcall(abi.encodeCall(IMoleOracle.consult, (hookKey.toId(), 1800)));
        assertTrue(ok && ret.length == 0, "premise: something at the hook address still answers");

        // A decade later, on a chain that has produced a million more Ethereum blocks.
        _advance(3650 days, 1_000_000);

        vm.prank(alice);
        bare.withdrawAll(id);
        _assertCleanExit(bare, id, alice, before - deposited);
        assertApproxEqAbs(_value(alice), before, DUST_WEI, "the decade-old position did not come back whole");
    }

    /* ==========================================================================
       5. WHITELIST STATE IS NOT ON THE EXIT PATH, and cannot be made to be.
       ========================================================================== */

    /// @notice There is no way to un-list a pool, and listing more pools changes nothing for an existing
    ///         position. A re-listing of the SAME pool id is refused, so the stored key of a position's pool
    ///         can never be swapped out from under its exit.
    function test_exit_isIndifferentToTheWhitelist() public {
        // Warm the oracle before depositing. `open` gained a spot-vs-TWAP gate on 2026-08-23 (F-07
        // mechanism A) and `consult` fails closed on a pool younger than the window, so a DEPOSIT into a
        // cold pool is now refused. That is a deposit-side change and this test is about the whitelist, so
        // the fixture warms up; nothing about the exit under test moved.
        _warmOracle(hookKey);
        uint256 id = _open(vault, hookKey, alice, 1e18);

        // The same id cannot be re-registered (so `_pools[id]` is write-once).
        vm.expectRevert(MolePositions.PoolAlreadyWhitelisted.selector);
        vault.whitelistPool(hookKey);

        // Listing two more pools on the same hook: unrelated to the open position.
        vault.whitelistPool(_newPool(hook, 10));
        vault.whitelistPool(_newPool(hook, 120));

        uint256 before = _value(alice);
        vm.prank(alice);
        vault.withdrawAll(id);
        _assertCleanExit(vault, id, alice, before);
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                          EXIT-PATH PROOFS — THE QUEUE
//////////////////////////////////////////////////////////////////////////////*/

/// @title ExitPathQueueTest
/// @notice The queue is the one contract that holds user money between transactions, so its exits are the
///         ones a dead settler, a dead oracle or a burned root key could plausibly trap. Three exits exist —
///         cancel (before the cutoff), claim (after settlement), reclaim (after timeout) — and this file
///         proves each of them with the settler ABSENT, the oracle DEAD (its code replaced by a revert) and
///         the upgrade admin BURNED. The only time escrow is unreachable is the bounded window between the
///         cutoff and `maxEpochLife`, and the boundary of that window is pinned to the second on both the
///         never-frozen and the late-frozen paths.
contract ExitPathQueueTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint256 internal constant T0 = 1_750_000_000;

    // The SHIPPED queue policy, read from the one place it is defined.
    uint32 internal constant EPOCH = DeployConfig.DEFAULT_QUEUE_EPOCH;
    uint32 internal constant FREEZE = DeployConfig.DEFAULT_QUEUE_FREEZE;
    uint32 internal constant LIFE = DeployConfig.DEFAULT_QUEUE_MAX_LIFE;
    uint32 internal constant WINDOW = DeployConfig.DEFAULT_TWAP_WINDOW;
    int24 internal constant DEVIATION = DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS;
    uint16 internal constant RESIDUAL_BPS = DeployConfig.DEFAULT_QUEUE_RESIDUAL_BPS;

    address internal alice = makeAddr("q.alice");
    address internal bob = makeAddr("q.bob");
    address internal stranger = makeAddr("q.stranger");
    address internal treasury = makeAddr("q.treasury");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;
    MockERC20 internal t0;
    MockERC20 internal t1;

    uint256 internal _clock;
    uint256 internal _height;
    uint256 internal _epochStart;

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high = uint160(uint256(keccak256(abi.encode("exit-path-queue", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _swap(bool zeroForOne, uint256 amount) internal {
        swapRouter.swap(
            poolKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amount),
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Cover the shipped 30-minute window with alternating swaps, then go quiet for longer than the
    ///      window so the TWAP equals spot and a settlement cannot fail on the deviation band.
    function _warmOracle() internal {
        for (uint256 i = 0; i < 8; i++) {
            _advance(300);
            _swap(i % 2 == 0, 1e18);
        }
        _advance(WINDOW + 120);
    }

    function _fund(address who) internal {
        t0.transfer(who, 10_000e18);
        t1.transfer(who, 10_000e18);
        vm.startPrank(who);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    function _killOracle() internal {
        vm.etch(address(hook), REVERT_EVERYTHING);
        (bool ok,) = address(hook).staticcall(abi.encodeCall(IMoleOracle.consult, (poolKey.toId(), WINDOW)));
        assertFalse(ok, "premise: the oracle still answers");
    }

    function _burnAdmin() internal {
        vm.prank(TEST_UPGRADE_ADMIN);
        queue.transferUpgradeAdmin(address(0));
        assertEq(queue.upgradeAdmin(), address(0), "premise: the queue's root key was not burned");
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        address a = _hookAddr(1);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);
        poolKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(a)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200_000e18, salt: 0}),
            ZERO_BYTES
        );
        _warmOracle();

        queue = deployMoleQueue(
            manager, IMoleOracle(a), poolKey, EPOCH, FREEZE, LIFE, WINDOW, DEVIATION, RESIDUAL_BPS, TEST_UPGRADE_ADMIN
        );
        _epochStart = block.timestamp;

        _fund(alice);
        _fund(bob);
        _fund(stranger);
    }

    /* ==========================================================================
       1. CANCEL needs no settler, no oracle, no admin.
       ========================================================================== */

    function test_queueExit_cancelNeedsNoSettlerNoOracleNoAdmin() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 b1 = t1.balanceOf(bob);
        vm.prank(alice);
        uint256 iA = queue.place(true, 100e18);
        vm.prank(bob);
        uint256 iB = queue.place(false, 40e18);

        _killOracle();
        _burnAdmin();

        // Nobody else can take it back for them.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.cancel(0, iA);

        vm.prank(alice);
        queue.cancel(0, iA);
        vm.prank(bob);
        queue.cancel(0, iB);

        assertEq(t0.balanceOf(alice), a0, "alice's escrow did not come back in kind and in full");
        assertEq(t1.balanceOf(bob), b1, "bob's escrow did not come back in kind and in full");
        assertEq(t0.balanceOf(address(queue)), 0, "queue retained currency0 after both cancels");
        assertEq(t1.balanceOf(address(queue)), 0, "queue retained currency1 after both cancels");
    }

    /* ==========================================================================
       2. NEVER FROZEN, NOBODY SETTLES, ORACLE DEAD, ADMIN BURNED — a stranger
          times the epoch out at the exact bound and the owners reclaim in kind.
       ========================================================================== */

    function test_queueExit_neverFrozenEpoch_strangerTimesOutAndOwnersReclaimInKind() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 b1 = t1.balanceOf(bob);
        vm.prank(alice);
        uint256 iA = queue.place(true, 100e18);
        vm.prank(bob);
        uint256 iB = queue.place(false, 40e18);

        // Past the cutoff: the free exit closes (this is the hostage window, and it is real)...
        _advance(EPOCH);
        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.cancel(0, iA);
        // ...settlement is impossible (never frozen), and nobody is coming to freeze or settle.
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.settle(0);

        _killOracle();
        _burnAdmin();

        // One second before the bound the stranger is refused — the window is exactly what it says.
        _clock = _epochStart + EPOCH + LIFE - 1;
        vm.warp(_clock);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);
        vm.prank(alice);
        vm.expectRevert(MoleQueue.WrongPhase.selector);
        queue.claim(0, iA);

        // At the bound: a complete stranger frees everyone.
        _advance(1);
        vm.prank(stranger);
        queue.timeout(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Refunding), "epoch did not enter Refunding");

        // Only the owner may reclaim, and the reclaim is exact and in kind.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotOrderOwner.selector);
        queue.claim(0, iA);

        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "alice's reclaim is not her exact escrow");
        vm.prank(bob);
        assertEq(queue.claim(0, iB), 40e18, "bob's reclaim is not his exact escrow");
        assertEq(t0.balanceOf(alice), a0, "alice not made whole in kind");
        assertEq(t1.balanceOf(bob), b1, "bob not made whole in kind");
        assertEq(t0.balanceOf(address(queue)), 0, "queue retained currency0 after reclaims");
        assertEq(t1.balanceOf(address(queue)), 0, "queue retained currency1 after reclaims");

        vm.prank(alice);
        vm.expectRevert(MoleQueue.AlreadyWithdrawn.selector);
        queue.claim(0, iA);
    }

    /* ==========================================================================
       3. FROZEN LATE, NOBODY SETTLES (the oracle cannot answer) — the late freeze
          does not move the bound, and reclaim is in kind.
       ========================================================================== */

    function test_queueExit_lateFrozenEpoch_settleImpossible_timeoutAtTheScheduledBound() public {
        uint256 a0 = t0.balanceOf(alice);
        uint256 b1 = t1.balanceOf(bob);
        vm.prank(alice);
        uint256 iA = queue.place(true, 100e18);
        vm.prank(bob);
        uint256 iB = queue.place(false, 40e18);

        // A very late freeze by a stranger: 1000s after the cutoff.
        _advance(EPOCH + 1000);
        vm.prank(stranger);
        queue.freeze();
        (, uint64 frozenAt,,,,,,) = queue.epochs(0);
        assertEq(frozenAt, _epochStart + EPOCH, "freeze stamped the button press, not the cutoff");

        // THE F-05 DELAY FIRES FIRST, and that is the guard working rather than a stale expectation.
        // `freeze()` backdates `frozenAt` to the scheduled cutoff, so a delay anchored there would be
        // ALREADY ELAPSED after a press this late — `freeze(e); settle(e);` would fit in one transaction
        // and the settler would pick the exact block, and therefore the exact price, the batch is measured
        // against. The delay now runs from whichever came LATER, the cutoff or the press, so a late press
        // buys the settler nothing. Proven here before the oracle is killed, so the refusal below is
        // attributable to the ORACLE and not to a timer that would have refused anyway.
        vm.expectRevert(MoleQueue.TooEarly.selector);
        queue.settle(0);
        // Exactly the delay, not a second more: settlement is available the instant the wait elapses, so
        // the refusal that follows cannot be this one still running.
        _advance(FREEZE);

        // The oracle dies: settlement is now impossible for anyone, pinned to the oracle's own error.
        vm.mockCallRevert(
            address(hook),
            abi.encodeWithSelector(IMoleOracle.consult.selector),
            abi.encodeWithSelector(MoleHook.InsufficientObservations.selector)
        );
        vm.expectRevert(MoleHook.InsufficientObservations.selector);
        queue.settle(0);
        vm.clearMockedCalls();
        _killOracle();
        _burnAdmin();

        // THE BOUND IS THE SCHEDULED CUTOFF PLUS maxEpochLife PLUS ONE freezeDuration, and the late press
        // still bought nobody any delay — every term is anchored to the backdated `frozenAt`, so pressing
        // freeze 1000s late moved none of them.
        //
        // The extra freezeDuration is the F-06 fix and it is deliberate. `timeout` used to unlock on the
        // SAME SECOND as lenient `settle`, so the set of moments at which this escape hatch could run and
        // settlement could not was EMPTY — which meant any participant who disliked the cross could veto a
        // settleable batch simply by racing `timeout` first, and the crossed portion, which needs no pool
        // and was already priced, never happened. Whoever the sequencer ordered first decided, which is
        // not entitlement. Settlement now gets one freezeDuration of exclusive width before the fallback
        // opens.
        //
        // WHAT MATTERS FOR AN EXIT SUITE is that this lengthens the escrow's hold by a BOUNDED, KNOWN
        // amount and cannot lengthen it further: `freezeDuration` is written only by `initialize`, has no
        // setter, and `maxEpochLife > freezeDuration` is enforced at construction. So the worst case is
        // still a hard deadline, asserted to the second on both sides below.
        _clock = _epochStart + EPOCH + LIFE + FREEZE - 1;
        vm.warp(_clock);
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotTimedOut.selector);
        queue.timeout(0);

        _advance(1);
        vm.prank(stranger);
        queue.timeout(0);

        vm.prank(alice);
        assertEq(queue.claim(0, iA), 100e18, "alice's reclaim is not her exact escrow");
        vm.prank(bob);
        assertEq(queue.claim(0, iB), 40e18, "bob's reclaim is not his exact escrow");
        assertEq(t0.balanceOf(alice), a0, "alice not made whole in kind");
        assertEq(t1.balanceOf(bob), b1, "bob not made whole in kind");
        assertEq(t0.balanceOf(address(queue)), 0, "queue retained currency0");
        assertEq(t1.balanceOf(address(queue)), 0, "queue retained currency1");
    }

    /* ==========================================================================
       4. SETTLED — claim reads nothing external: the oracle can die and the
          admin can burn between settlement and claim.
       ========================================================================== */

    function test_queueExit_settledEpoch_claimNeedsNoOracleNoSettlerNoAdmin() public {
        vm.prank(alice);
        uint256 iA = queue.place(true, 10e18);
        vm.prank(bob);
        uint256 iB = queue.place(false, 10e18);

        _advance(EPOCH);
        vm.prank(stranger);
        queue.freeze();
        _advance(FREEZE);
        vm.prank(stranger);
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "premise: epoch did not settle");

        _killOracle();
        _burnAdmin();

        uint256 a1 = t1.balanceOf(alice);
        uint256 b0 = t0.balanceOf(bob);
        vm.prank(alice);
        uint256 outA = queue.claim(0, iA);
        vm.prank(bob);
        uint256 outB = queue.claim(0, iB);
        assertGt(outA, 0, "alice's claim paid nothing");
        assertGt(outB, 0, "bob's claim paid nothing");
        assertEq(t1.balanceOf(alice) - a1, outA, "alice's claim did not land in currency1");
        assertEq(t0.balanceOf(bob) - b0, outB, "bob's claim did not land in currency0");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                          EXIT-PATH PROOFS — THE ROUTER
//////////////////////////////////////////////////////////////////////////////*/

/// @title ExitPathRouterTest
/// @notice The router has no exit path because it has no custody: the claim re-asserted here is that it
///         holds NOTHING between transactions — no ERC-20, no ERC-6909 claim, no native ETH — after a
///         successful swap, after a reverted one, and after its root key is burned. That is what makes a
///         standing approval to it safe against everything except an upgrade (which
///         AttackRouterUpgradeability.t.sol performs on purpose).
contract ExitPathRouterTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MoleRouter internal router;
    MockWETH9 internal weth;
    address internal user = makeAddr("r.user");

    function setUp() public {
        deployFreshManagerAndRouters();
        weth = new MockWETH9();
        router = deployMoleRouter(manager, address(weth), address(0), address(0));
    }

    function _plan(PoolKey memory key, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (MoleRouter.SwapPlan memory plan)
    {
        address tIn = Currency.unwrap(key.currency0);
        address tOut = Currency.unwrap(key.currency1);
        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop(MoleRouter.Venue.UniswapV4, address(0), true, tIn, tOut, key);
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path(amountIn, hops);
        plan = MoleRouter.SwapPlan(tIn, tOut, amountIn, minOut, user, block.timestamp + 1, paths);
    }

    function _assertHoldsNothing(PoolKey memory key, string memory when) internal view {
        assertEq(MockERC20(Currency.unwrap(key.currency0)).balanceOf(address(router)), 0, string.concat("router holds currency0 ", when));
        assertEq(MockERC20(Currency.unwrap(key.currency1)).balanceOf(address(router)), 0, string.concat("router holds currency1 ", when));
        assertEq(manager.balanceOf(address(router), key.currency0.toId()), 0, string.concat("router holds currency0 claims ", when));
        assertEq(manager.balanceOf(address(router), key.currency1.toId()), 0, string.concat("router holds currency1 claims ", when));
        assertEq(address(router).balance, 0, string.concat("router holds ether ", when));
        assertEq(weth.balanceOf(address(router)), 0, string.concat("router holds WETH ", when));
    }

    function test_router_custodiesNothingBetweenTransactions_tokensClaimsAndEther() public {
        (Currency c0, Currency c1) = deployMintAndApprove2Currencies();
        PoolKey memory key =
            PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))});
        manager.initialize(key, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 100_000e18, salt: 0}), ""
        );
        MockERC20(Currency.unwrap(c0)).mint(user, 3e18);
        vm.prank(user);
        MockERC20(Currency.unwrap(c0)).approve(address(router), type(uint256).max);

        _assertHoldsNothing(key, "before any swap");

        // A successful swap: the whole output reaches the user, nothing stays.
        vm.prank(user);
        uint256 got = router.swap(_plan(key, 1e18, 1));
        assertGt(got, 0, "premise: the swap produced nothing");
        assertEq(MockERC20(Currency.unwrap(c1)).balanceOf(user), got, "output did not reach the user");
        _assertHoldsNothing(key, "after a successful swap");

        // A reverted swap (minOut unreachable): nothing moved, nothing stays.
        vm.prank(user);
        vm.expectPartialRevert(MoleRouter.InsufficientOutput.selector);
        router.swap(_plan(key, 1e18, type(uint128).max));
        _assertHoldsNothing(key, "after a reverted swap");

        // Stray ether outside a swap is refused outright, so none can accumulate.
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = address(router).call{value: 1 wei}("");
        assertFalse(ok, "the router accepted ether outside a swap");
        _assertHoldsNothing(key, "after a refused ether send");

        // The root key is burned; the router keeps working and keeps holding nothing.
        vm.prank(TEST_UPGRADE_ADMIN);
        router.transferUpgradeAdmin(address(0));
        MoleRouter otherImpl = new MoleRouter();
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MoleRouter.NotUpgradeAdmin.selector);
        router.upgradeToAndCall(address(otherImpl), "");
        vm.prank(user);
        router.swap(_plan(key, 1e18, 1));
        _assertHoldsNothing(key, "after the root key was burned");
    }
}

/// @dev Minimal WETH9 surface, so the router can be deployed with a real wrapper address.
contract MockWETH9 {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "MockWETH9: send failed");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
