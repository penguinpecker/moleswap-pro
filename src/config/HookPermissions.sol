// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/libraries/Hooks.sol";

/// @title HookPermissions
/// @notice The permission bitmap for MoleHook, and the reasoning for every bit — set or unset.
///
/// THIS IS A ONE-WAY DOOR. A hook's permissions are the low 14 bits of its own address, which the
/// PoolManager reads by bitwise AND with no storage lookup. You cannot add a callback later: not by
/// upgrading, not by proxying, not by governance. Changing any bit changes the address, which changes
/// every PoolId derived from it, which means new pools and a user base that must migrate itself.
///
/// So the bitmap must cover everything the hook will EVER do, while staying minimal — because every
/// set bit is a callback an attacker can call directly, and every unset bit is a class of attack that
/// becomes structurally impossible.
library HookPermissions {
    /* ------------------------------------------------------------------ MINED */

    /// beforeInitialize  — enforce the pool whitelist at creation. Without it, anyone can create a
    ///                     pool pointing at our hook and seed per-pool state we later trust.
    /// afterInitialize   — seed the oracle's first observation and the pool's fee atomically with pool
    ///                     creation, so no pool of ours ever exists in an unconfigured state.
    /// beforeAddLiquidity— reject third-party LPs when our pools are closed. NOTE: this was ALSO mined
    ///                     to stamp liquidity age for a JIT guard. That guard does not exist and cannot:
    ///                     the hook is handed the address that called modifyLiquidity, which is our vault,
    ///                     never the depositor. The stamp was removed as write-only. See MoleHook.
    /// beforeSwap        — quote the pool's LP fee for this swap. NOTE: this was mined for a
    ///                     volatility-scaled DYNAMIC fee, which has since been deleted (it could not be
    ///                     made safe). The bit is permanent, so it is now used to re-assert a fixed fee.
    /// afterSwap         — write the oracle observation. (The volatility accumulator this bit was also
    ///                     mined for no longer exists.)
    /// afterSwapReturnDelta — reserved for protocol fee capture. Mined because it CANNOT be added
    ///                     later; whether it is ever used is still open (see Part 16 conflict C1).
    ///                     This is the one bit we mine speculatively, and the trade is deliberate:
    ///                     an unused set bit is an attack surface we must defend, but a missing bit
    ///                     is a migration.

    /* ---------------------------------------------------------------- NOT MINED */

    /// beforeRemoveLiquidity, afterRemoveLiquidity, afterRemoveLiquidityReturnDelta — DELIBERATELY
    /// OMITTED, and this is the single most important decision in the contract.
    ///
    /// With these three bits clear, the PoolManager can never call our hook when a user removes
    /// liquidity. No bug in our hook, no compromised key, no upgrade, and no pause can block a
    /// withdrawal — not because we promise not to, but because the code path does not exist. Anyone
    /// can verify it from the address alone: `uint160(hook) & 0x0301 == 0`.
    ///
    /// That turns "we can disappear and you still get your money out" from a marketing claim into
    /// arithmetic. The price is real and permanent: we can never charge an exit fee at the pool
    /// level, never enforce a JIT penalty at removal time, and never enforce a minimum liquidity age
    /// on exit. Exit-side accounting must live in our own contracts instead. We take that trade.
    ///
    /// beforeDonate / afterDonate — omitted. We do not build any fee, reward or penalty on donate(),
    /// so there is nothing to observe, and two fewer callbacks to defend.
    ///
    /// beforeSwapReturnDelta, afterAddLiquidityReturnDelta — omitted. We never take a delta on those
    /// paths; taking one would let the hook alter user-facing amounts in ways we do not want to have
    /// to reason about.

    /// @notice The mask of every remove-liquidity bit. MUST be zero in the mined address, forever.
    /// @dev BEFORE_REMOVE_LIQUIDITY (1<<9 = 0x0200) | AFTER_REMOVE_LIQUIDITY (1<<8 = 0x0100)
    ///      | AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA (1<<0 = 0x0001) = 0x0301.
    uint160 internal constant WITHDRAWAL_PATH_MASK = 0x0301;

    /// @notice The mask of the one add-liquidity bit that can tax a deposit. MUST be zero in the
    ///         mined address (our bitmap 0x38C4 clears it), and must be clear on any hook this
    ///         contract pins.
    /// @dev AFTER_ADD_LIQUIDITY_RETURNS_DELTA (1<<1 = 0x0002). With this bit set, a hook returns a
    ///      delta on the add-liquidity path, inflating what open() owes and therefore what it pulls
    ///      from the opener's ERC-20 allowance — the F-1 drain, measured at ~194x the honest bill.
    ///      Derived from the named v4-core flag rather than written as a bare literal: a magic hex
    ///      constant in a security guard is the Cetus ($223M) failure mode, so its value is also
    ///      re-asserted against the flag in HookPermissions.t.sol.
    uint160 internal constant DEPOSIT_TAX_MASK = uint160(Hooks.AFTER_ADD_LIQUIDITY_RETURNS_DELTA_FLAG);

    /// @notice The exact permission bits MoleHook's address must carry.
    uint160 internal constant REQUIRED_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    /// @notice Every one of the 14 permission bits, for exact-match checking.
    uint160 internal constant ALL_HOOK_MASK = uint160((1 << 14) - 1);

    /// @notice True only if `hook` carries exactly REQUIRED_FLAGS and no other permission bit.
    function isValid(address hook) internal pure returns (bool) {
        return (uint160(hook) & ALL_HOOK_MASK) == REQUIRED_FLAGS;
    }

    /// @notice True if the withdrawal path provably cannot reach this hook.
    /// @dev The property users and reviewers should check for themselves. Cheap, total, permanent.
    function withdrawalIsUnblockable(address hook) internal pure returns (bool) {
        return (uint160(hook) & WITHDRAWAL_PATH_MASK) == 0;
    }

    /// @notice True if this hook provably cannot return a delta on the add-liquidity path, i.e. it
    ///         cannot tax a deposit above the amount the pool math itself owes.
    /// @dev Belt-and-braces on the deposit side of the fail-closed admission allowlist: identity
    ///      pinning is the primary control, but a pinned hook must still be unable to tax a deposit.
    function depositIsUntaxable(address hook) internal pure returns (bool) {
        return (uint160(hook) & DEPOSIT_TAX_MASK) == 0;
    }
}
