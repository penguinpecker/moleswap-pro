// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {deployMoleVault, deployMoleRouter, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice The two rotation setters that let a compromised LOW-privilege key be replaced without
///         reaching for the HIGHEST one.
///
/// WHY THIS FILE EXISTS. `keeper` on the vault and `feeRecipient` on the router were both
/// initializer-only on UUPS proxies. The vault could DISABLE a keeper (`setKeeperExpiry`) but not
/// REPLACE one, so recovering from a leaked keeper key meant shipping a new implementation through
/// `upgradeAdmin` — the key that can rewrite `withdraw`. That inverts the blast radius: an incident on
/// the least trusted key in the system forced the operator to use the most trusted one. A hot key that
/// signs on a schedule will eventually leak, and the recovery for it should be one transaction and an
/// event rather than a code deployment nobody can audit after the fact.
///
/// Neither setter grants new power — the upgrade key could already do both by replacing the
/// implementation. What they add is that the rotation is a LOGGED, single-purpose action.
contract AttackRoleRotation is Test, Deployers {
    MolePositions vault;
    MoleRouter router;

    address constant KEEPER = address(0xCEE9E4);
    address constant STRANGER = address(0xBAD1);
    address constant NEW_KEEPER = address(0x4E32);
    address constant TREASURY = address(0x77EA);

    int24 constant MIN_W = 120;
    int24 constant MAX_W = 60_000;

    function setUp() public {
        deployFreshManagerAndRouters();
        vault = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 10, 0, 10_000, 0, 0, address(0));
        router = deployMoleRouter(manager, address(0xDEAD), address(0), address(0xFEE));
    }

    /* ------------------------------------------------------------------ the vault's keeper */

    function test_theRootKeyCanRotateTheKeeperInOneTransaction() public {
        assertEq(vault.keeper(), KEEPER, "fixture");
        vm.prank(TEST_UPGRADE_ADMIN);
        vault.setKeeper(NEW_KEEPER);
        assertEq(vault.keeper(), NEW_KEEPER, "the keeper did not rotate");
    }

    function test_attack_aStrangerCannotRotateTheKeeper() public {
        vm.prank(STRANGER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.setKeeper(STRANGER);
        assertEq(vault.keeper(), KEEPER, "the keeper moved for a stranger");
    }

    /// The keeper is the obvious address to try this from: it is the key most likely to be stolen, and
    /// a thief who could re-point it at themselves permanently would turn a leak into a takeover.
    function test_attack_theKeeperCannotRotateItself() public {
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.setKeeper(STRANGER);
        assertEq(vault.keeper(), KEEPER, "a compromised keeper re-pointed the role at itself");
    }

    /// address(0) is allowed deliberately — it is the same "no keeper at all" state `setKeeperExpiry`
    /// already reaches, and every position owner keeps `setKeeperRevoked` regardless. Pinned so that
    /// somebody "hardening" this later has to argue with a test rather than a comment.
    function test_theKeeperCanBeRotatedToNobody() public {
        vm.prank(TEST_UPGRADE_ADMIN);
        vault.setKeeper(address(0));
        assertEq(vault.keeper(), address(0), "the keeper could not be stood down");
    }

    /* --------------------------------------------------------------- the router's fee target */

    function test_theRootKeyCanRotateTheRouterFeeTarget() public {
        vm.prank(TEST_UPGRADE_ADMIN);
        router.setFeeRecipient(TREASURY);
        assertEq(router.feeRecipient(), TREASURY, "the fee target did not rotate");
    }

    function test_attack_aStrangerCannotRotateTheRouterFeeTarget() public {
        address before = router.feeRecipient();
        vm.prank(STRANGER);
        vm.expectRevert(MoleRouter.NotUpgradeAdmin.selector);
        router.setFeeRecipient(STRANGER);
        assertEq(router.feeRecipient(), before, "the fee target moved for a stranger");
    }

    /// The four destinations `initialize` refuses must stay refused, or the setter is a way around the
    /// constructor's own rules. Zero burns the fee on every swap; the router itself rebuilds the shared
    /// pot the zero-residual invariant exists to prevent; weth and the PoolManager are both addresses
    /// the swap path already moves value to for unrelated reasons.
    function test_attack_theSetterCannotReachADestinationInitializeRefuses() public {
        address before = router.feeRecipient();
        address[4] memory forbidden = [address(0), address(router), address(0xDEAD), address(manager)];
        for (uint256 i = 0; i < forbidden.length; ++i) {
            vm.prank(TEST_UPGRADE_ADMIN);
            vm.expectRevert(MoleRouter.BadFeeConfig.selector);
            router.setFeeRecipient(forbidden[i]);
        }
        assertEq(router.feeRecipient(), before, "a forbidden destination stuck");
    }
}
