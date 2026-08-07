// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*//////////////////////////////////////////////////////////////////////////////
                    KEEPER REVOCATION ATTACK SUITE
                target:  src/MolePositions.sol (per-position keeper opt-out)
                lens:    every party who is NOT the position owner, plus the
                         owner's own exit after using the veto

  The feature under test is the owner's veto: `setKeeperRevoked(id, true)` must
  make `rebalance(id, ...)` revert `KeeperRevokedForPosition()` — checked FIRST,
  before every other bound — while touching nothing else. The claims, each of
  which is attacked below by the party with the incentive to break it:

    1. The KEEPER cannot rebalance a revoked position, and the refusal is that
       exact selector — checked before every other bound, so a keeper cannot
       learn anything else about a revoked position from revert reasons either.
    2. The veto is PER-POSITION. Revoking id A must not widen into a book-wide
       keeper freeze (that would be a grief lever), nor may managing B leak
       management of A back in.
    3. Only the OWNER holds the veto. A stranger flipping it on is a grief
       (freeze someone's position management); the KEEPER flipping it off is
       the direct bypass. Both must be NotOwner.
    4. It is REVERSIBLE by the owner alone, and the keeper genuinely works
       again afterwards — an un-revoke that left a sticky freeze would turn
       the veto into self-grief.
    5. THE ONE THAT MATTERS: the veto can never strand funds. A revoked
       position must remain fully withdrawable by its owner, for the full
       amount. A veto that could trap a deposit would be strictly worse than
       no veto at all.

  WORLD. minRebalanceInterval = 0 and minDwellL1Blocks = 0, so the rebalance
  path is reachable immediately after open and every refusal in this file is
  attributable to the veto and nothing else. Every test that asserts the veto
  blocks the keeper FIRST proves the same call shape SUCCEEDED before the
  revocation (or after the un-revoke), so the refusal is meaningful rather
  than a rebalance that would have failed anyway.

      forge test --match-path test/attack/AttackKeeperRevocation.t.sol -vv
//////////////////////////////////////////////////////////////////////////////*/

import {Test, console2} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {MolePositions} from "../../src/MolePositions.sol";
import {deployMoleVault, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

contract AttackKeeperRevocationTest is Deployers {
    MolePositions internal mole;

    address internal constant KEEPER = address(0xBADBEEF);
    address internal constant VICTIM = address(0x1C71);
    address internal constant VICTIM2 = address(0xC0117201);
    address internal constant STRANGER = address(0x51124A9E12);

    int24 internal constant MIN_WIDTH = 120;
    int24 internal constant MAX_WIDTH = 120_000;
    int24 internal constant SPACING = 60;

    // Balanced in-range band around spot (tick 0), and two shifted-but-still-two-sided bands the
    // keeper moves positions between. All legal, all containing spot, so every rebalance in this
    // file is one the contract would happily perform absent the veto.
    int24 internal constant IN_LOWER = -600;
    int24 internal constant IN_UPPER = 600;
    int24 internal constant ALT_LOWER = -1200;
    int24 internal constant ALT_UPPER = 600;
    int24 internal constant ALT2_LOWER = -600;
    int24 internal constant ALT2_UPPER = 1200;

    /// @dev Same hard wei budget as AttackKeeper.t.sol: v4 rounds mint costs up and burn proceeds
    ///      down, so one open + rebalance + withdraw round trip leaks a few wei to the pool.
    ///      Deliberately not a percentage — a proportional tolerance could absorb a real loss.
    uint256 internal constant DUST_WEI = 8;

    MockERC20 internal t0;
    MockERC20 internal t1;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);

        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        // Background liquidity so the pool is real and spot is anchored at tick 0.
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 1e19, salt: 0}),
            ZERO_BYTES
        );

        // minRebalanceInterval = 0 and minDwellL1Blocks = 0: the rebalance path is live from the
        // moment a position opens, so the ONLY thing standing between the keeper and a revoked
        // position is the veto itself.
        mole = deployMoleVault(
            manager,
            KEEPER,
            0, // minRebalanceInterval
            MIN_WIDTH,
            MAX_WIDTH,
            address(0), // hookless world: custody behaviour only
            0, // maxTwapDeviationTicks (needs an oracle; off)
            0, // twapWindow
            0, // minDwellL1Blocks
            0, // maxRebalancesPerL1Block (unlimited)
            10_000, // maxEjectionBps (unlimited)
            0, // maxRecenterTicks (unlimited)
            0, // performanceFeeBps
            address(0) // feeRecipient
        );
        mole.whitelistPool(key);

        _fund(VICTIM);
        _fund(VICTIM2);
    }

    /* ------------------------------------------------------------------ helpers */

    function _fund(address who) internal {
        t0.mint(who, 1_000e18);
        t1.mint(who, 1_000e18);
        vm.startPrank(who);
        t0.approve(address(mole), type(uint256).max);
        t1.approve(address(mole), type(uint256).max);
        vm.stopPrank();
    }

    function _bal(address who) internal view returns (uint256 b0, uint256 b1) {
        b0 = t0.balanceOf(who);
        b1 = t1.balanceOf(who);
    }

    /// @dev Both tokens are 18 decimals and the pool sits at 1:1, so raw units are a fair common
    ///      denominator for "value".
    function _value(address who) internal view returns (uint256) {
        return t0.balanceOf(who) + t1.balanceOf(who);
    }

    function _open(address who, uint128 liq) internal returns (uint256 id, uint256 spent0, uint256 spent1) {
        (uint256 a0, uint256 a1) = _bal(who);
        vm.prank(who);
        id = mole.open(key, IN_LOWER, IN_UPPER, liq, type(uint256).max, type(uint256).max, block.timestamp);
        (uint256 b0, uint256 b1) = _bal(who);
        spent0 = a0 - b0;
        spent1 = a1 - b1;
    }

    /// @dev A keeper rebalance that MUST succeed, asserted by the range actually moving. Every
    ///      blocked-rebalance assertion in this file leans on one of these having passed first.
    function _keeperRebalanceMustSucceed(uint256 id, int24 lower, int24 upper) internal {
        vm.prank(KEEPER);
        mole.rebalance(id, lower, upper);
        MolePositions.Position memory p = mole.getPosition(id);
        assertEq(p.tickLower, lower, "rebalance did not apply the new lower tick");
        assertEq(p.tickUpper, upper, "rebalance did not apply the new upper tick");
        assertGt(p.liquidity, 0, "rebalance wiped the position");
    }

    /* ==========================================================================
       1. The keeper cannot touch a revoked position — exact selector, checked
          before every other bound.
       ========================================================================== */

    /// The direct attack: the keeper keeps calling the exact call shape that verifiably worked
    /// moments earlier. After `setKeeperRevoked(id, true)` it must fail with
    /// KeeperRevokedForPosition and leave the position byte-identical. The illegal-range probe at
    /// the end pins the "checked FIRST" claim: even a rebalance that would ALSO break the width
    /// bound reports the veto, so a keeper cannot use revert reasons to probe a revoked position,
    /// and no later bound can mask the owner's refusal.
    function test_attack_keeperCannotRebalanceARevokedPosition() public {
        (uint256 id,,) = _open(VICTIM, 1e18);

        // The rebalance path is genuinely LIVE before the revocation — the same keeper, the same
        // position, a legal band. Without this the refusal below would prove nothing.
        _keeperRebalanceMustSucceed(id, ALT_LOWER, ALT_UPPER);

        vm.prank(VICTIM);
        mole.setKeeperRevoked(id, true);
        assertTrue(mole.keeperRevoked(id), "veto not recorded");

        MolePositions.Position memory frozen = mole.getPosition(id);

        // Same call shape that just succeeded. Now: the owner's exact refusal.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, ALT2_LOWER, ALT2_UPPER);

        // Checked FIRST: a range that would independently fail RangeWidthOutOfBounds (60 < 120)
        // still reports the veto, so the revocation check precedes the other bounds.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, 0, 60);

        // And a misordered range likewise — the veto wins over TicksMisordered too.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, ALT_UPPER, ALT_LOWER);

        // The refusals mutated nothing.
        MolePositions.Position memory after_ = mole.getPosition(id);
        assertEq(after_.tickLower, frozen.tickLower, "range mutated by a refused rebalance");
        assertEq(after_.tickUpper, frozen.tickUpper, "range mutated by a refused rebalance");
        assertEq(after_.liquidity, frozen.liquidity, "liquidity mutated by a refused rebalance");
        assertEq(after_.lastRebalancedAt, frozen.lastRebalancedAt, "rate limiter consumed by a refused rebalance");
    }

    /* ==========================================================================
       2. The veto is per-position, in both directions.
       ========================================================================== */

    /// Two positions, two owners. VICTIM revokes theirs; VICTIM2 still trusts the keeper. The
    /// keeper must be blocked on A with the exact selector and must simultaneously succeed on B —
    /// so one owner's veto is neither a book-wide freeze (grief on everyone else) nor does the
    /// keeper's legitimate work on B leak management of A back in.
    function test_attack_revokingOnePositionDoesNotFreezeOrUnlockAnother() public {
        (uint256 idA,,) = _open(VICTIM, 1e18);
        (uint256 idB,,) = _open(VICTIM2, 1e18);

        // Both start keeper-manageable — proven, not assumed.
        _keeperRebalanceMustSucceed(idA, ALT_LOWER, ALT_UPPER);
        _keeperRebalanceMustSucceed(idB, ALT_LOWER, ALT_UPPER);

        vm.prank(VICTIM);
        mole.setKeeperRevoked(idA, true);

        // A is refused...
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(idA, ALT2_LOWER, ALT2_UPPER);

        // ...while B rebalances normally in the same block, same keeper, same call shape.
        _keeperRebalanceMustSucceed(idB, ALT2_LOWER, ALT2_UPPER);

        // And working B did not un-freeze A.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(idA, IN_LOWER, IN_UPPER);

        // A kept the range the owner froze it at; B moved.
        assertEq(mole.getPosition(idA).tickLower, ALT_LOWER, "revoked position moved");
        assertEq(mole.getPosition(idA).tickUpper, ALT_UPPER, "revoked position moved");
        assertEq(mole.getPosition(idB).tickLower, ALT2_LOWER, "unrevoked position did not move");
        assertEq(mole.getPosition(idB).tickUpper, ALT2_UPPER, "unrevoked position did not move");
    }

    /* ==========================================================================
       3. Only the owner holds the veto — in BOTH directions.
       ========================================================================== */

    /// The grief direction: a stranger (or the keeper itself) flips the veto ON for someone
    /// else's position, silently freezing its management. Both must be NotOwner and the flag
    /// must not move.
    function test_attack_strangerAndKeeperCannotRevokeSomeoneElsesPosition() public {
        (uint256 id,,) = _open(VICTIM, 1e18);

        vm.prank(STRANGER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.setKeeperRevoked(id, true);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.setKeeperRevoked(id, true);

        assertFalse(mole.keeperRevoked(id), "a non-owner moved the veto");

        // The failed griefs changed nothing: the keeper still manages the position normally.
        _keeperRebalanceMustSucceed(id, ALT_LOWER, ALT_UPPER);
    }

    /// The bypass direction — the sharp one. The owner has revoked; the keeper (the exact party
    /// the veto is aimed at) tries to flip it back OFF and resume, and a stranger tries the same.
    /// Both must be NotOwner, and the keeper must still be refused with the veto selector after
    /// each attempt.
    function test_attack_keeperCannotClearTheOwnersVetoToLetItselfBackIn() public {
        (uint256 id,,) = _open(VICTIM, 1e18);
        _keeperRebalanceMustSucceed(id, ALT_LOWER, ALT_UPPER); // path live before the veto

        vm.prank(VICTIM);
        mole.setKeeperRevoked(id, true);

        // Keeper tries to un-revoke itself back in.
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.setKeeperRevoked(id, false);

        // A stranger cannot clear it for the keeper either.
        vm.prank(STRANGER);
        vm.expectRevert(MolePositions.NotOwner.selector);
        mole.setKeeperRevoked(id, false);

        // The veto held through both attempts.
        assertTrue(mole.keeperRevoked(id), "a non-owner cleared the veto");
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, ALT2_LOWER, ALT2_UPPER);
    }

    /* ==========================================================================
       4. Reversible by the owner, and the keeper genuinely works again.
       ========================================================================== */

    /// Full lifecycle: works -> revoked (refused, exact selector) -> un-revoked by the owner ->
    /// works again, proven by the range actually moving. An un-revoke that left any sticky freeze
    /// would make the veto a one-way self-grief; this pins that it is a clean toggle.
    function test_attack_ownerCanUnrevokeAndTheKeeperWorksAgain() public {
        (uint256 id,,) = _open(VICTIM, 1e18);
        _keeperRebalanceMustSucceed(id, ALT_LOWER, ALT_UPPER);

        vm.prank(VICTIM);
        mole.setKeeperRevoked(id, true);

        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, ALT2_LOWER, ALT2_UPPER);

        // Owner changes their mind. Owner alone — proven by test 3.
        vm.prank(VICTIM);
        mole.setKeeperRevoked(id, false);
        assertFalse(mole.keeperRevoked(id), "un-revoke not recorded");

        // The very call that was refused now succeeds, and the range provably moves.
        _keeperRebalanceMustSucceed(id, ALT2_LOWER, ALT2_UPPER);

        // And re-revoking works too — the toggle is not one-shot in either direction.
        vm.prank(VICTIM);
        mole.setKeeperRevoked(id, true);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, IN_LOWER, IN_UPPER);
    }

    /* ==========================================================================
       5. THE ONE THAT MATTERS: the veto can never strand a position.
       ========================================================================== */

    /// A veto that trapped funds would be worse than no veto: the owner would have handed
    /// themselves a freeze with no exit. So: open, let the keeper genuinely manage the position
    /// (a real successful rebalance), revoke, prove the keeper is locked out — and then withdraw
    /// EVERYTHING through the ordinary owner exit, recovering the full deposit to within the
    /// fixed wei dust budget, with the contract holding zero at the end. Withdrawal never
    /// consulted the veto, and this is the test that keeps it that way.
    function test_attack_revokedPositionIsNeverStranded_ownerWithdrawsAllInFull() public {
        uint256 victimStart = _value(VICTIM);

        (uint256 id, uint256 in0, uint256 in1) = _open(VICTIM, 1e18);
        uint256 deposited = in0 + in1;
        assertGt(deposited, 0, "nothing was deposited");

        // The keeper really was managing this position — the veto interrupts live management,
        // it does not refuse a rebalance that was already impossible. The rebalance may pay the
        // owner displaced-leg dust; count it, or the recovery accounting understates the owner.
        (uint256 a0, uint256 a1) = _bal(VICTIM);
        _keeperRebalanceMustSucceed(id, ALT_LOWER, ALT_UPPER);
        (uint256 b0, uint256 b1) = _bal(VICTIM);
        uint256 rebalanceDust = (b0 - a0) + (b1 - a1);

        vm.prank(VICTIM);
        mole.setKeeperRevoked(id, true);

        // Locked out, exact selector — the position is now beyond the keeper's reach...
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperRevokedForPosition.selector);
        mole.rebalance(id, ALT2_LOWER, ALT2_UPPER);

        // ...and NOT beyond the owner's. The one-call exit works while the veto is armed.
        (uint256 w0, uint256 w1) = _bal(VICTIM);
        vm.prank(VICTIM);
        mole.withdrawAll(id);
        (uint256 x0, uint256 x1) = _bal(VICTIM);
        uint256 withdrawn = (x0 - w0) + (x1 - w1);

        console2.log("deposited              ", deposited);
        console2.log("dust at rebalance      ", rebalanceDust);
        console2.log("withdrawn after revoke ", withdrawn);

        // FULL recovery: everything the owner put in came back, to within v4's fixed rounding.
        assertGt(withdrawn, 0, "revoked position paid out nothing - it was stranded");
        assertApproxEqAbs(withdrawn + rebalanceDust, deposited, DUST_WEI, "revoked position did not return the full deposit");
        assertApproxEqAbs(_value(VICTIM), victimStart, DUST_WEI, "owner did not end whole after revoking and exiting");

        // Clean end state: the position is empty and the contract holds not one wei of it.
        assertEq(mole.getPosition(id).liquidity, 0, "liquidity not fully withdrawn");
        assertEq(t0.balanceOf(address(mole)), 0, "contract kept token0 of a revoked position");
        assertEq(t1.balanceOf(address(mole)), 0, "contract kept token1 of a revoked position");
    }
    /* ========================================================== keeper expiry (dead man's switch) */

    /// @notice The keeper's authority can be made to EXPIRE. Revocation is one depositor opting out;
    ///         expiry is the protocol declining to trust an operator key indefinitely — so an abandoned,
    ///         sold or quietly compromised keeper closes its own blast radius instead of staying open
    ///         until somebody notices.
    function test_attack_keeperCannotRebalanceAfterItsAuthorityExpires() public {
        (uint256 id,,) = _open(VICTIM, 10e18);

        // Works before expiry is set at all (0 = disabled).
        assertEq(mole.keeperExpiry(), 0, "premise: expiry should start disabled");
        _keeperRebalanceMustSucceed(id, -1200, 1200);

        // Set it in the near future; still works while it is in force.
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setKeeperExpiry(deadline);
        assertEq(mole.keeperExpiry(), deadline, "expiry was not stored");
        _keeperRebalanceMustSucceed(id, -1800, 1800);

        // One second past it, the keeper is finished.
        vm.warp(uint256(deadline) + 1);
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.KeeperExpired.selector);
        mole.rebalance(id, -2400, 2400);

        // THE PART THAT MATTERS: an expired keeper does not strand anyone. Withdrawal never consulted
        // the keeper, and it still does not.
        (uint256 before0, uint256 before1) = _bal(VICTIM);
        vm.prank(VICTIM);
        mole.withdrawAll(id);
        assertEq(mole.getPosition(id).liquidity, 0, "an expired keeper stranded the position");
        (uint256 after0, uint256 after1) = _bal(VICTIM);
        assertTrue(after0 > before0 || after1 > before1, "the exit paid nothing");
    }

    /// @notice Expiry is the upgrade admin's to set, and nobody else's — least of all the keeper, which
    ///         would otherwise be able to extend its own mandate forever.
    function test_attack_keeperAndStrangersCannotSetOrExtendTheExpiry() public {
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        mole.setKeeperExpiry(uint64(block.timestamp + 365 days));

        vm.prank(STRANGER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        mole.setKeeperExpiry(uint64(block.timestamp + 365 days));

        vm.prank(VICTIM);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        mole.setKeeperExpiry(0);

        assertEq(mole.keeperExpiry(), 0, "expiry moved despite every caller being refused");

        // And once expired, the keeper cannot revive itself.
        vm.prank(TEST_UPGRADE_ADMIN);
        mole.setKeeperExpiry(uint64(block.timestamp - 1));
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        mole.setKeeperExpiry(uint64(block.timestamp + 365 days));
    }

}
