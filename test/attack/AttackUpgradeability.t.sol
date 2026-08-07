// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {
    deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN
} from "../helpers/ProxyDeploy.sol";

/// @notice A replacement implementation that hands every position's tokens to whoever calls it.
/// @dev Not hypothetical and not exaggerated for effect — this is the shortest expression of what an
///      upgrade key is worth, and it is here so the cost of the proxy decision is a measured number in
///      the suite rather than a sentence in a document.
contract StealEverything is MolePositions {
    function drain(PoolKey calldata, uint256) external pure returns (string memory) {
        return "an upgrade replaced the custody core";
    }
}

/// @title AttackUpgradeability
/// @notice ANGLE: the proxies themselves.
///
/// Both contracts sit behind UUPS proxies at the owner's explicit direction, which buys the ability to fix
/// a hook bug without abandoning every pool bound to it — the single largest structural liability this
/// design has, since a v4 pool is married to its hook address forever.
///
/// IT ALSO CREATES A ROOT KEY, and this file is where that is stated as executable fact rather than as a
/// caveat. `test_theUpgradeKeyCanReplaceTheCustodyCore` is the proof: it is a PASSING test that documents a
/// total-loss capability. Nothing here is a bug report — it is the price, made visible, so nobody reading
/// the suite later mistakes "all green" for "nobody can take the money".
///
/// WHAT SURVIVES A HOSTILE UPGRADE, and it is not nothing: the hook's permission bits are its ADDRESS. The
/// PoolManager reads them by bitwise AND with no storage lookup and no call, so no implementation — however
/// malicious — can add the remove-liquidity callbacks. Withdrawals remain impossible to block at the pool
/// level even if the hook is entirely replaced. That property is arithmetic and an upgrade cannot touch it.
contract AttackUpgradeabilityTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    address internal KEEPER = makeAddr("upg.keeper");
    address internal alice = makeAddr("upg.alice");
    address internal mallory = makeAddr("upg.mallory");
    address internal TREASURY = makeAddr("upg.treasury");

    int24 internal constant SPACING = 60;
    int24 internal constant MIN_W = 120;
    int24 internal constant MAX_W = 60_000;

    MolePositions internal vault;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
        (key,) = initPool(currency0, currency1, IHooks(address(0)), 3000, SPACING, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20_000e18, salt: 0}),
            ZERO_BYTES
        );
        vault = deployMoleVault(manager, KEEPER, 0, MIN_W, MAX_W, address(0), 0, 0, 0, 0, 10_000, 0, 1000, TREASURY);
        vault.whitelistPool(key);

        MockERC20(Currency.unwrap(currency0)).mint(alice, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(vault), type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    /* ============================================================== who may upgrade */

    /// @notice ATTACK — a stranger upgrades the vault to an implementation of their choosing.
    /// @dev Result: REFUSED. `_authorizeUpgrade` is the only thing standing between an arbitrary caller
    ///      and every deposit, so it is the single most important access check in the codebase now.
    function test_holds_aStrangerCannotUpgradeTheVault() public {
        StealEverything evil = new StealEverything();
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.upgradeToAndCall(address(evil), "");
    }

    /// @notice ATTACK — the KEEPER upgrades the vault. The keeper is the semi-trusted party the whole
    ///         bounds system exists to contain, so it must not also be the party that can remove them.
    /// @dev Result: REFUSED. Keeper and upgrade admin are separate roles and neither implies the other.
    function test_holds_theKeeperCannotUpgradeAwayItsOwnBounds() public {
        StealEverything evil = new StealEverything();
        vm.prank(KEEPER);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.upgradeToAndCall(address(evil), "");
    }

    /// @notice ATTACK — a position OWNER upgrades. Owning a position confers no authority over the code.
    function test_holds_aPositionOwnerCannotUpgrade() public {
        vm.prank(alice);
        vault.open(key, -600, 600, 100e18, type(uint256).max, type(uint256).max, block.timestamp + 1);

        StealEverything evil = new StealEverything();
        vm.prank(alice);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.upgradeToAndCall(address(evil), "");
    }

    /// @notice ATTACK — a stranger upgrades the HOOK. Distinct from the vault: a hostile hook cannot block
    ///         an exit (the bits forbid it) but it CAN lie in `consult()`, which MolePositions reads as the
    ///         anchor for its TWAP bound, and it can re-price every swap in the pool.
    /// @dev Result: REFUSED. Added after a mutation deleting the hook's `_authorizeUpgrade` check SURVIVED
    ///      the whole suite — every existing test upgraded the hook as the authorised admin, so nothing
    ///      ever asked whether an unauthorised one could.
    function test_holds_aStrangerCannotUpgradeTheHook() public {
        address mined = address(uint160(0x7171 << 20) | HookPermissions.REQUIRED_FLAGS);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), 3000, 60, false, 0, TREASURY, TEST_UPGRADE_ADMIN),
            mined
        );
        MoleHook hook = MoleHook(mined);

        MoleHook other = new MoleHook();
        vm.prank(mallory);
        vm.expectRevert(MoleHook.NotUpgradeAdmin.selector);
        hook.upgradeToAndCall(address(other), "");

        // And the keeper of a vault pinned to this hook has no authority over it either.
        vm.prank(KEEPER);
        vm.expectRevert(MoleHook.NotUpgradeAdmin.selector);
        hook.upgradeToAndCall(address(other), "");
    }

    /* ====================================================== the price, stated as a test */

    /// @notice THE COST OF THE PROXY DECISION, MEASURED. The upgrade admin replaces the custody core with
    ///         a contract of its choosing, and the vault at the SAME ADDRESS now runs that code against
    ///         the SAME storage — including everyone's positions.
    /// @dev This test PASSES. It is not a finding; it is the documented consequence of putting the vault
    ///      behind a proxy, and it exists so that "a compromised keeper cannot take a token" is never again
    ///      read as "nobody can take a token". The keeper still cannot. The upgrade admin can.
    function test_theUpgradeKeyCanReplaceTheCustodyCore() public {
        vm.prank(alice);
        uint256 id = vault.open(key, -600, 600, 100e18, type(uint256).max, type(uint256).max, block.timestamp + 1);
        assertGt(vault.getPosition(id).liquidity, 0, "premise: no position to put at risk");

        StealEverything evil = new StealEverything();
        vm.prank(TEST_UPGRADE_ADMIN);
        vault.upgradeToAndCall(address(evil), "");

        // Same address, same storage, entirely different code.
        assertEq(
            StealEverything(address(vault)).drain(key, id),
            "an upgrade replaced the custody core",
            "the upgrade did not take effect"
        );
        assertEq(vault.getPosition(id).liquidity, 100e18, "storage did not survive, which would be worse");
    }

    /// @notice The root key can be GIVEN UP, and giving it up is what restores the original guarantee.
    /// @dev The honest exit from the trade: hand `upgradeAdmin` to address(0) once the code is trusted and
    ///      the contract becomes permanently immutable again, at which point "a compromised keeper cannot
    ///      take a token" is true without qualification.
    function test_theRootKeyCanBeBurnedWhichMakesTheVaultImmutableAgain() public {
        vm.prank(TEST_UPGRADE_ADMIN);
        vault.transferUpgradeAdmin(address(0));
        assertEq(vault.upgradeAdmin(), address(0), "the root key was not surrendered");

        StealEverything evil = new StealEverything();
        vm.prank(TEST_UPGRADE_ADMIN);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.upgradeToAndCall(address(evil), "");

        // Nobody else can either — address(0) cannot be pranked into signing anything real, and the check
        // is an equality against a zeroed slot.
        vm.prank(mallory);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.upgradeToAndCall(address(evil), "");
    }

    /* ================================================ the implementation must stay locked */

    /// @notice ATTACK — initialize the IMPLEMENTATION directly and take ownership of it, then use it as a
    ///         delegatecall target. This is the uninitialised-implementation hole that has emptied real
    ///         protocols, and `_disableInitializers()` in the constructor is what closes it.
    /// @dev Result: REFUSED on both contracts.
    function test_holds_theImplementationsCannotBeInitialisedDirectly() public {
        MolePositions vaultImpl = new MolePositions();
        // PINNED, not a bare expectRevert. The hook implementation sits at an unmined address and would
        // revert with BadHookAddress whether or not initializers were disabled — so a bare check passes
        // for the wrong reason and a mutation deleting `_disableInitializers()` SURVIVES it. Measured.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vaultImpl.initialize(
            MolePositions.InitParams({
                poolManager: manager,
                keeper: mallory,
                minRebalanceInterval: 0,
                minRangeWidth: MIN_W,
                maxRangeWidth: MAX_W,
                moleHook: address(0),
                maxTwapDeviationTicks: 0,
                twapWindow: 0,
                minDwellL1Blocks: 0,
                maxRebalancesPerL1Block: 0,
                maxEjectionBps: 10_000,
                maxRecenterTicks: 0,
                performanceFeeBps: 0,
                feeRecipient: address(0),
                upgradeAdmin: mallory
            })
        );

        MoleHook hookImpl = new MoleHook();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        hookImpl.initialize(manager, mallory, 3000, 60, false, 0, TREASURY, mallory);
    }

    /// @notice A live proxy cannot be re-initialised either, which would otherwise reset every bound and
    ///         hand over the keeper role without an upgrade.
    function test_holds_aLiveProxyCannotBeReinitialised() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(
            MolePositions.InitParams({
                poolManager: manager,
                keeper: mallory,
                minRebalanceInterval: 0,
                minRangeWidth: MIN_W,
                maxRangeWidth: MAX_W,
                moleHook: address(0),
                maxTwapDeviationTicks: 0,
                twapWindow: 0,
                minDwellL1Blocks: 0,
                maxRebalancesPerL1Block: 0,
                maxEjectionBps: 10_000,
                maxRecenterTicks: 0,
                performanceFeeBps: 0,
                feeRecipient: address(0),
                upgradeAdmin: mallory
            })
        );
        assertEq(vault.keeper(), KEEPER, "the keeper was replaced by a re-initialisation");
    }

    /* ============================ what an upgrade CANNOT do, which is the part worth keeping */

    /// @notice THE GUARANTEE THAT SURVIVES EVERYTHING. A hook's permissions are the low 14 bits of its
    ///         address. The PoolManager reads them with a bitwise AND — no storage, no call — so an
    ///         upgrade can replace every line of the implementation and STILL cannot acquire the
    ///         remove-liquidity callbacks. Withdrawals stay unblockable at the pool level, permanently.
    /// @dev Asserted against the deployed proxy address rather than restated as prose, because this is the
    ///      one claim in the project that is genuinely immune to the root key.
    function test_theExitGuaranteeIsInTheAddressAndSurvivesAnyUpgrade() public {
        address mined = address(uint160(0x4242 << 20) | HookPermissions.REQUIRED_FLAGS);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), 3000, 60, false, 0, TREASURY, TEST_UPGRADE_ADMIN),
            mined
        );
        MoleHook hook = MoleHook(mined);
        assertEq(hook.upgradeAdmin(), TEST_UPGRADE_ADMIN, "premise: the hook proxy is not upgradeable");

        // Replace the implementation with something else entirely.
        MoleHook other = new MoleHook();
        vm.prank(TEST_UPGRADE_ADMIN);
        hook.upgradeToAndCall(address(other), "");

        // The address did not move, so neither did the permissions.
        assertTrue(
            HookPermissions.withdrawalIsUnblockable(address(hook)),
            "an upgrade acquired the remove-liquidity bits -- impossible, and if this fails the model is wrong"
        );
        assertTrue(HookPermissions.depositIsUntaxable(address(hook)), "an upgrade acquired the deposit-tax bit");
        assertEq(uint256(uint160(address(hook)) & 0x3FFF), 0x38C4, "the permission bits changed under an upgrade");
    }
}
