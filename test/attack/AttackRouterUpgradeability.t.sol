// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {deployMoleRouter, deployMoleRouterOwned, TEST_UPGRADE_ADMIN, MoleDeployer} from "../helpers/ProxyDeploy.sol";

/// @title AttackRouterUpgradeability
/// @notice The router became upgradeable on 2026-08-15, reversing a deliberate immutability decision. That
///         makes `upgradeAdmin` the single largest trust assumption in the stack, so it gets the same
///         treatment MoleQueue's and MolePositions' admins got: the theft is PERFORMED, not described.
///
///         These tests are written to be uncomfortable on purpose. If the operator ever reads them and
///         does not like what the passing ones prove, the answer is `transferUpgradeAdmin(address(0))`.
contract AttackRouterUpgradeability is Test, Deployers {
    MoleRouter internal router;
    address internal user = makeAddr("user");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        deployFreshManagerAndRouters();
        router = deployMoleRouter(manager, makeAddr("weth"), address(0), address(0));
    }

    /* ─── the guard itself ─── */

    function test_onlyUpgradeAdminMayUpgrade() public {
        MoleRouter fresh = new MoleRouter();
        vm.prank(attacker);
        vm.expectRevert(MoleRouter.NotUpgradeAdmin.selector);
        router.upgradeToAndCall(address(fresh), "");
    }

    function test_onlyUpgradeAdminMayTransferTheKey() public {
        vm.prank(attacker);
        vm.expectRevert(MoleRouter.NotUpgradeAdmin.selector);
        router.transferUpgradeAdmin(attacker);
        assertEq(router.upgradeAdmin(), TEST_UPGRADE_ADMIN, "a refused transfer must not move the key");
    }

    function test_initializeCannotBeRunTwice() public {
        vm.expectRevert();
        router.initialize(manager, makeAddr("weth2"), address(0), address(0), attacker);
    }

    function test_theBareImplementationIsNotInitializable() public {
        // A bare implementation owns nothing (the proxy holds state), but leaving it open is free to close.
        MoleRouter impl = new MoleRouter();
        vm.expectRevert();
        impl.initialize(manager, makeAddr("weth"), address(0), address(0), attacker);
    }

    function test_initializeRefusesAZeroUpgradeAdmin() public {
        // A router deployed with no admin could never be upgraded OR burned — bricked, not immutable.
        // Through the external wrapper: a proxy deploy is TWO creates and vm.expectRevert would otherwise
        // be consumed by the implementation create, which always succeeds. See ProxyDeploy.sol.
        MoleDeployer d = new MoleDeployer();
        vm.expectRevert(MoleRouter.OwnerRequired.selector);
        d.router(manager, makeAddr("weth"), address(0), address(0), address(0));
    }

    /* ─── the price of the proxy, performed rather than described ─── */

    /// @notice THE COST OF THIS DEPLOYMENT, MADE VISIBLE. The router holds unlimited approvals; the upgrade
    ///         admin replaces its code with a drainer and empties a user's WALLET — funds the router never
    ///         custodied. This test PASSES. It is the reason `transferUpgradeAdmin(address(0))` exists.
    function test_upgradeAdminCanDrainEveryApprovedWallet() public {
        MockToken token = new MockToken();
        token.mint(user, 1_000e18);
        vm.prank(user);
        token.approve(address(router), type(uint256).max); // exactly what the app does

        assertEq(token.balanceOf(user), 1_000e18);

        DrainRouter drainer = new DrainRouter();
        vm.prank(TEST_UPGRADE_ADMIN);
        router.upgradeToAndCall(address(drainer), "");

        DrainRouter(payable(address(router))).drain(address(token), user, attacker);

        assertEq(token.balanceOf(user), 0, "the whole approved balance is gone");
        assertEq(token.balanceOf(attacker), 1_000e18, "and it is the attacker's");
    }

    /// @notice And the mechanical escape: once the key is surrendered, the same attack is impossible
    ///         forever. This is the property the immutable router had by construction.
    function test_burningTheKeyMakesTheRouterPermanentlyImmutable() public {
        vm.prank(TEST_UPGRADE_ADMIN);
        router.transferUpgradeAdmin(address(0));
        assertEq(router.upgradeAdmin(), address(0));

        DrainRouter drainer = new DrainRouter();
        // Nobody can upgrade it now — not the old admin, not the attacker, not address(0) itself.
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MoleRouter.NotUpgradeAdmin.selector);
        router.upgradeToAndCall(address(drainer), "");

        vm.prank(attacker);
        vm.expectRevert(MoleRouter.NotUpgradeAdmin.selector);
        router.upgradeToAndCall(address(drainer), "");
    }

    /// @notice Storage must survive an upgrade — the wiring is proxy state now, not implementation
    ///         immutables, and getting that wrong reads back as zero and bricks every swap.
    function test_wiringSurvivesAnUpgrade() public {
        address wethBefore = router.weth();
        address pmBefore = address(router.poolManager());

        MoleRouter fresh = new MoleRouter();
        vm.prank(TEST_UPGRADE_ADMIN);
        router.upgradeToAndCall(address(fresh), "");

        assertEq(router.weth(), wethBefore, "weth must survive");
        assertEq(address(router.poolManager()), pmBefore, "poolManager must survive");
        assertEq(router.upgradeAdmin(), TEST_UPGRADE_ADMIN, "the admin must survive");
    }
}

/// @dev A malicious implementation: one arbitrary-transferFrom verb, which is exactly the class the
///      immutable router's "two verbs, no arbitrary calls" claim ruled out at the ADDRESS level.
///
///      NOTE `proxiableUUID`. The first version of this attacker omitted it and the upgrade was REFUSED
///      with ERC1967InvalidImplementation — UUPS checks that the incoming implementation declares the
///      standard slot. That is a genuine guard against upgrading to a non-UUPS address by accident, and it
///      is worth nobody mistaking it for protection against a deliberate attacker: eleven lines restore
///      the attack in full. Which is the point of this file.
contract DrainRouter {
    /// @dev keccak256("eip1967.proxy.implementation") - 1, the slot UUPS requires an implementation to name.
    bytes32 private constant _IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    function proxiableUUID() external pure returns (bytes32) {
        return _IMPL_SLOT;
    }

    function drain(address token, address from, address to) external {
        IERC20Minimal(token).transferFrom(from, to, IERC20Minimal(token).balanceOf(from));
    }

    receive() external payable {}
}

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        require(balanceOf[from] >= amount, "balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
