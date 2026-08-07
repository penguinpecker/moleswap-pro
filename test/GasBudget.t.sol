// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {hookProxyArgs, TEST_UPGRADE_ADMIN} from "./helpers/ProxyDeploy.sol";

/// @title GasBudget
/// @notice P-20: a regression gate on what this hook costs every swapper in the pool.
///
/// WHY THIS IS A TEST AND NOT A RUNTIME GUARD. The dossier lists a "per-swap gas budget", and the
/// tempting reading is an on-chain check. That would be worse than useless: measuring gas on chain costs
/// gas, and a hook that reverts a swap for being expensive has converted a cost problem into an
/// availability problem. The real risk is a REGRESSION — somebody adds a mapping write to `afterSwap` and
/// every trade in every pool silently gets dearer, forever, with no test going red. So the budget belongs
/// here, where breaching it fails the build instead of the pool.
///
/// WHAT DRIVES THE NUMBER. This hook exists because v4 deleted v3's oracle, so a TWAP costs a real SSTORE
/// on the swap path. That is a deliberate, permanent tax on every swapper, and the ONLY reason the
/// observation write is time-gated rather than per-swap. These bounds pin both halves of that gate:
/// the expensive path (a swap that advances the ring) and the cheap one (a swap that does not).
contract GasBudgetTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    MoleHook internal hook;
    PoolKey internal hookKey;
    address internal treasury = makeAddr("gas.treasury");

    /// @dev Ceilings, not targets, and TIGHT ON PURPOSE. Measured today: 87,429 gas for a swap that
    ///      advances the ring and 62,097 for one that does not. The first draft of this file budgeted
    ///      165,000/145,000 — roughly double — which would have passed happily while somebody added
    ///      three cold SSTOREs to the swap path. A budget with that much slack is decoration.
    ///
    ///      These sit ~15% above the measurement: loose enough that compiler drift is not noise, tight
    ///      enough that ONE added cold SSTORE (~20,000 gas) breaches them and fails the build.
    ///
    ///      WHAT THIS GATE DOES AND DOES NOT CATCH, verified by deliberately regressing the hook rather
    ///      than asserted:
    ///        CAUGHT  — a fresh cold storage slot written every swap (~20,000 gas). Build goes red.
    ///        MISSED  — a repeated write to the SAME slot (~2,900 gas warm). Slips under the ceiling.
    ///      That is the honest limit of a budget test: it stops STRUCTURAL regressions, not marginal
    ///      ones. Tightening far enough to catch 2,900 gas would leave under 2% headroom and turn
    ///      ordinary compiler drift into a red build, which is how gas gates get deleted. Recorded here
    ///      so nobody reads a green run as "the swap path cannot have got more expensive".
    uint256 internal constant BUDGET_RING_ADVANCING = 100_000;
    uint256 internal constant BUDGET_NO_RING_WRITE = 72_000;

    function setUp() public {
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        address a = address(uint160(0x9a51 << 20) | HookPermissions.REQUIRED_FLAGS);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), 3000, 60, false, 0, treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        hookKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(a)
        });
        manager.initialize(hookKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            hookKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 20_000e18, salt: 0}),
            ZERO_BYTES
        );
    }

    function _swap(int256 amount) internal returns (uint256 gasUsed) {
        uint256 before = gasleft();
        swapRouter.swap(
            hookKey,
            SwapParams(true, amount, MIN_PRICE_LIMIT),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        gasUsed = before - gasleft();
    }

    /// @notice A swap that ADVANCES the observation ring — the expensive path, and the one a user pays
    ///         for the oracle on. Bounded so a future addition to `afterSwap` cannot quietly land here.
    function test_gas_swapThatAdvancesTheRingStaysInBudget() public {
        // Warm the pool first: the very first swap after initialization pays one-off costs that are not
        // representative of steady state, and budgeting against them would hide a real regression.
        _swap(-1e18);

        vm.warp(block.timestamp + 120); // past the 60s observation interval, so this one writes
        (uint16 before,,,,,) = hook.poolStates(hookKey.toId());
        uint256 used = _swap(-1e18);
        (uint16 after_,,,,,) = hook.poolStates(hookKey.toId());

        assertEq(after_, before + 1, "premise: this swap did NOT advance the ring, so it is the wrong path");
        emit log_named_uint("gas, ring-advancing swap", used);
        assertLt(used, BUDGET_RING_ADVANCING, "the ring-advancing swap breached its gas budget");
    }

    /// @notice A swap INSIDE the observation interval — the common case, which must not pay for a ring
    ///         write it does not perform. This is the half that proves the time gate is doing its job.
    function test_gas_swapInsideTheIntervalDoesNotPayForARingWrite() public {
        _swap(-1e18);
        vm.warp(block.timestamp + 120);
        _swap(-1e18); // advances the ring

        (uint16 before,,,,,) = hook.poolStates(hookKey.toId());
        uint256 used = _swap(-1e18); // same second: must NOT advance
        (uint16 after_,,,,,) = hook.poolStates(hookKey.toId());

        assertEq(after_, before, "premise: the ring advanced, so this is not the cheap path");
        emit log_named_uint("gas, non-writing swap", used);
        assertLt(used, BUDGET_NO_RING_WRITE, "the non-writing swap breached its gas budget");
    }

    /// @notice The gate must actually SAVE something. A time-gated write that costs the same as an
    ///         ungated one is a gate in name only, and the whole justification for the oracle's design
    ///         rests on the difference being real.
    function test_gas_theTimeGateIsWorthWhatItClaims() public {
        _swap(-1e18);
        vm.warp(block.timestamp + 120);
        uint256 writing = _swap(-1e18);
        uint256 notWriting = _swap(-1e18);

        emit log_named_uint("writing   ", writing);
        emit log_named_uint("not writing", notWriting);
        assertGt(
            writing,
            notWriting + 5_000,
            "a ring write costs no more than skipping one -- the time gate saves nothing"
        );
    }
}
