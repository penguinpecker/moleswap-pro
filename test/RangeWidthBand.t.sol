// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {deployMoleVaultOwned} from "./helpers/ProxyDeploy.sol";

/// @title RangeWidthBand
/// @notice The range-width band was initializer-only, freezing maxRangeWidth at its deploy value while
///         the launchpad seeds pools with 120,000-tick single-sided ranges. setRangeWidthBand makes the
///         band operable; these tests pin its guards the way the deposit-band setter's are pinned.
///         Written as the attack first: an outsider moving the band, and an admin fat-fingering a band
///         that refuses every deposit.
contract RangeWidthBandTest is Test {
    MolePositions internal vault;
    address internal admin = makeAddr("admin");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        vault = deployMoleVaultOwned(
            IPoolManager(makeAddr("pm")), // never called by the setter path
            makeAddr("keeper"),
            uint32(60),
            int24(120),
            int24(60_000),
            address(0), // hookless pin: no TWAP oracle needed for these tests
            int24(0),
            uint32(0),
            uint64(0),
            uint16(0),
            uint16(0),
            int24(0),
            uint16(0),
            makeAddr("recip"),
            admin
        );
    }

    function test_onlyUpgradeAdminMayMoveTheBand() public {
        vm.prank(outsider);
        vm.expectRevert(MolePositions.NotUpgradeAdmin.selector);
        vault.setRangeWidthBand(120, 120_000);
        // the failed attempt must not have moved anything
        assertEq(vault.maxRangeWidth(), 60_000);
    }

    function test_adminWidensToLaunchpadParity() public {
        vm.prank(admin);
        vault.setRangeWidthBand(120, 120_000);
        assertEq(vault.minRangeWidth(), 120);
        assertEq(vault.maxRangeWidth(), 120_000);
    }

    function test_sameInvariantsAsInitialize() public {
        vm.startPrank(admin);
        vm.expectRevert(MolePositions.BadRangeBounds.selector);
        vault.setRangeWidthBand(0, 60_000); // min must be > 0
        vm.expectRevert(MolePositions.BadRangeBounds.selector);
        vault.setRangeWidthBand(-60, 60_000); // negative min
        vm.expectRevert(MolePositions.BadRangeBounds.selector);
        vault.setRangeWidthBand(600, 120); // max below min = pause by arithmetic, must be deliberate
        vm.stopPrank();
        assertEq(vault.maxRangeWidth(), 60_000); // untouched by any refused call
    }

    function test_emitsSoAChangeIsObservable() public {
        vm.expectEmit(false, false, false, true);
        emit MolePositions.RangeWidthBandSet(120, 120_000);
        vm.prank(admin);
        vault.setRangeWidthBand(120, 120_000);
    }
}
