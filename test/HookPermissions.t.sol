// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";

/// @notice Pins the hook permission bitmap. These assertions are not style checks — the bitmap is
/// encoded in the hook's address, so changing any bit means a new address, new PoolIds, new pools and
/// a forced user migration. If one of these fails, someone has proposed a migration without saying so.
contract HookPermissionsTest is Test {
    /// @notice The load-bearing property of the whole product: withdrawals can never reach our hook.
    function test_withdrawalPathIsProvablyUnreachable() public pure {
        assertEq(
            HookPermissions.REQUIRED_FLAGS & HookPermissions.WITHDRAWAL_PATH_MASK,
            0,
            "a remove-liquidity bit is set - withdrawals would become blockable"
        );
    }

    /// @notice Guard against v4-core's flag constants drifting from the values we reasoned about.
    function test_withdrawalMaskMatchesCoreFlags() public pure {
        uint160 fromCore = uint160(
            Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG
                | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG
        );
        assertEq(fromCore, HookPermissions.WITHDRAWAL_PATH_MASK, "v4-core remove-liquidity flags moved");
        assertEq(HookPermissions.WITHDRAWAL_PATH_MASK, 0x0301, "withdrawal mask is not 0x0301");
    }

    /// @notice Every bit we mine is a callback someone can call directly. Keep the set intentional.
    function test_bitmapIsExactlyTheSixIntendedBits() public pure {
        uint160 f = HookPermissions.REQUIRED_FLAGS;

        assertTrue(f & uint160(Hooks.BEFORE_INITIALIZE_FLAG) != 0, "beforeInitialize missing (pool whitelist)");
        assertTrue(f & uint160(Hooks.AFTER_INITIALIZE_FLAG) != 0, "afterInitialize missing (oracle seed)");
        assertTrue(f & uint160(Hooks.BEFORE_ADD_LIQUIDITY_FLAG) != 0, "beforeAddLiquidity missing (JIT stamp)");
        assertTrue(f & uint160(Hooks.BEFORE_SWAP_FLAG) != 0, "beforeSwap missing (dynamic fee quote)");
        assertTrue(f & uint160(Hooks.AFTER_SWAP_FLAG) != 0, "afterSwap missing (oracle write)");
        assertTrue(f & uint160(Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG) != 0, "afterSwapReturnDelta missing (fee capture)");

        // And nothing else.
        assertTrue(f & uint160(Hooks.AFTER_ADD_LIQUIDITY_FLAG) == 0, "afterAddLiquidity set unintentionally");
        assertTrue(f & uint160(Hooks.BEFORE_DONATE_FLAG) == 0, "beforeDonate set - we build nothing on donate()");
        assertTrue(f & uint160(Hooks.AFTER_DONATE_FLAG) == 0, "afterDonate set - we build nothing on donate()");
        assertTrue(f & uint160(Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG) == 0, "beforeSwapReturnDelta set");
        assertTrue(f & uint160(Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG) == 0, "afterAddLiquidityReturnDelta set");

        // 0x2000 beforeInitialize | 0x1000 afterInitialize | 0x0800 beforeAddLiquidity
        //       | 0x0080 beforeSwap | 0x0040 afterSwap | 0x0004 afterSwapReturnDelta  =  0x38C4
        assertEq(f, 0x38C4, "bitmap changed - this is a migration, not an edit");
    }

    function test_isValidAcceptsOnlyExactBitmap() public pure {
        uint160 highBits = uint160(uint256(keccak256("mole"))) & ~HookPermissions.ALL_HOOK_MASK;
        address good = address(highBits | HookPermissions.REQUIRED_FLAGS);
        assertTrue(HookPermissions.isValid(good), "exact bitmap rejected");
        assertTrue(HookPermissions.withdrawalIsUnblockable(good), "exact bitmap should be unblockable");

        // One extra bit must invalidate it, even a harmless-looking one.
        address extra = address(uint160(good) | uint160(Hooks.AFTER_DONATE_FLAG));
        assertFalse(HookPermissions.isValid(extra), "extra permission bit accepted");

        // A remove-liquidity bit must break the withdrawal guarantee.
        address blockable = address(uint160(good) | uint160(Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG));
        assertFalse(HookPermissions.withdrawalIsUnblockable(blockable), "remove-liquidity bit not detected");
    }

    /// @notice Any address a miner produces must satisfy both properties, for any high bits.
    function testFuzz_minedAddressAlwaysUnblockable(uint160 highBits) public pure {
        address mined = address((highBits & ~HookPermissions.ALL_HOOK_MASK) | HookPermissions.REQUIRED_FLAGS);
        assertTrue(HookPermissions.isValid(mined), "valid bitmap rejected");
        assertTrue(HookPermissions.withdrawalIsUnblockable(mined), "withdrawal path reachable");
    }

    /// @notice Re-derive the F-1 deposit-tax guard's own boundary. A magic hex constant in a security
    ///         guard with no test asserting its value is the Cetus ($223M) failure mode, so the mask is
    ///         pinned to the named v4-core flag AND to its literal value here.
    function test_depositTaxMaskMatchesCoreFlag() public pure {
        assertEq(
            HookPermissions.DEPOSIT_TAX_MASK,
            uint160(Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG),
            "deposit-tax mask drifted from the v4-core add-liquidity return-delta flag"
        );
        assertEq(HookPermissions.DEPOSIT_TAX_MASK, 0x0002, "deposit-tax mask is not 0x0002");
        // Our own hook must itself be untaxable, or the fail-closed pin would reject us at construction.
        assertEq(
            HookPermissions.REQUIRED_FLAGS & HookPermissions.DEPOSIT_TAX_MASK,
            0,
            "our own bitmap carries the deposit-tax bit"
        );
    }

    /// @notice depositIsUntaxable is true iff the add-liquidity return-delta bit is clear, and it is the
    ///         one bit that lets a hook inflate what open() pulls from the opener's allowance (F-1).
    function test_depositIsUntaxableDetectsTheTaxBit() public pure {
        uint160 highBits = uint160(uint256(keccak256("mole-deposit"))) & ~HookPermissions.ALL_HOOK_MASK;

        // A hook carrying our exact (untaxable) bitmap is untaxable.
        address ours = address(highBits | HookPermissions.REQUIRED_FLAGS);
        assertTrue(HookPermissions.depositIsUntaxable(ours), "our own bitmap read as taxable");

        // Add the tax bit and it must be detected, even alongside our authentic bits.
        address taxing = address(uint160(ours) | uint160(Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG));
        assertFalse(HookPermissions.depositIsUntaxable(taxing), "deposit-tax bit not detected");

        // A hookless address (the interim pin) is trivially untaxable.
        assertTrue(HookPermissions.depositIsUntaxable(address(0)), "address(0) read as taxable");
    }

    /// @notice The exact F-1 hook shapes from the dossier — 0x0402 and 0x0C02 — must be caught as taxable.
    function test_knownF1HookAddressesAreTaxable() public pure {
        // AFTER_ADD_LIQUIDITY (0x0400) | AFTER_ADD_LIQUIDITY_RETURNS_DELTA (0x0002).
        assertFalse(HookPermissions.depositIsUntaxable(address(uint160(0x0402))), "0x0402 not caught");
        // BEFORE_ADD (0x0800) | AFTER_ADD (0x0400) | AFTER_ADD_RETURNS_DELTA (0x0002).
        assertFalse(HookPermissions.depositIsUntaxable(address(uint160(0x0C02))), "0x0C02 not caught");
        // Neither carries a remove-path bit, which is why the OLD withdrawal-only gate admitted them.
        assertTrue(HookPermissions.withdrawalIsUnblockable(address(uint160(0x0402))), "0x0402 has a remove bit?");
        assertTrue(HookPermissions.withdrawalIsUnblockable(address(uint160(0x0C02))), "0x0C02 has a remove bit?");
    }
}
