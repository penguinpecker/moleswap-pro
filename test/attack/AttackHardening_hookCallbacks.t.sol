// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  every one of the TEN IHooks callbacks on MoleHook (dossier Part 2 §8 Cork, §14 rule 1).
  Lens:    Cork lost ~$11M because ONE callback lacked onlyPoolManager. So every callback — the five
           we mined AND the five we did not — is called directly from four different identities: an
           EOA, the vault (the address the PoolManager would name as `sender`), the pool creator (the
           only privileged role the hook has), and a contract that merely claims to be a PoolManager.
           Each must revert NotPoolManager, and the oracle state the dangerous ones could rewrite must
           be byte-identical before and after. Then the five unmined callbacks are shown UNREACHABLE
           even through the real PoolManager: a donate and a remove-liquidity on the hook's own pool
           both succeed while those five functions revert unconditionally.

  RESULT: HOLDS. GuardCoverage.t.sol already pins the five mined callbacks from an EOA; this file
  adds the five unmined ones, three more callers, the state diff, and the unreachability proof.
  Mutation: delete `onlyPoolManager` on beforeAddLiquidity -> RED; replace the `revert
  NotPoolManager()` in beforeDonate with `return IHooks.beforeDonate.selector` -> RED.
//////////////////////////////////////////////////////////////////////////////*/
contract AttackHardeningHookCallbacks is HardeningBase {
    using PoolIdLibrary for PoolKey;

    function setUp() public {
        _buildWorld(0);
        _open(alice, -600, 600, 10e18);
    }

    struct OracleSnap {
        uint16 index;
        uint32 lastTs;
        uint32 lastObsTs;
        int24 lastTick;
        int56 cum;
        bool init;
        uint24 lpFee;
        bool aliceAllowed;
    }

    function _snap() internal view returns (OracleSnap memory s) {
        (s.index, s.lastTs, s.lastObsTs, s.lastTick, s.cum, s.init) = hook.poolStates(hookId);
        (,,, s.lpFee) = StateLibrary.getSlot0(manager, hookId);
        s.aliceAllowed = hook.liquidityAllowed(alice);
    }

    function _assertSame(OracleSnap memory a, OracleSnap memory b, string memory when) internal pure {
        assertEq(a.index, b.index, string.concat("ring index changed: ", when));
        assertEq(a.lastTs, b.lastTs, string.concat("oracle clock changed: ", when));
        assertEq(a.lastObsTs, b.lastObsTs, string.concat("observation clock changed: ", when));
        assertEq(a.lastTick, b.lastTick, string.concat("last tick changed: ", when));
        assertEq(a.cum, b.cum, string.concat("cumulative changed: ", when));
        assertEq(a.init, b.init, string.concat("initialized flag changed: ", when));
        assertEq(a.lpFee, b.lpFee, string.concat("pool lp fee changed: ", when));
        assertEq(a.aliceAllowed, b.aliceAllowed, string.concat("liquidity allowlist changed: ", when));
    }

    /// @dev Every callback, from `caller`. All ten must revert with the hook's own NotPoolManager.
    function _callAllTenAs(address caller, string memory who) internal {
        ModifyLiquidityParams memory mp = ModifyLiquidityParams(-600, 600, 1e18, bytes32(0));
        SwapParams memory sp = SwapParams(true, -1e18, MIN_PRICE_LIMIT);
        BalanceDelta zero = BalanceDelta.wrap(0);

        vm.startPrank(caller);
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeInitialize(caller, hookKey, SQRT_PRICE_1_1);
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterInitialize(caller, hookKey, SQRT_PRICE_1_1, 0);
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeAddLiquidity(caller, hookKey, mp, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterAddLiquidity(caller, hookKey, mp, zero, zero, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeRemoveLiquidity(caller, hookKey, mp, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterRemoveLiquidity(caller, hookKey, mp, zero, zero, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeSwap(caller, hookKey, sp, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterSwap(caller, hookKey, sp, zero, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.beforeDonate(caller, hookKey, 1, 1, "");
        vm.expectRevert(MoleHook.NotPoolManager.selector);
        hook.afterDonate(caller, hookKey, 1, 1, "");
        vm.stopPrank();
        who; // label only
    }

    /* ================================================================ direct calls, four identities */

    function test_allTenCallbacksRefuseAnEOA() public {
        OracleSnap memory before = _snap();
        _callAllTenAs(mallory, "eoa");
        _assertSame(before, _snap(), "after EOA calls");
    }

    /// @notice The VAULT is the address the PoolManager hands the hook as `sender` on every add. It is
    ///         still not the PoolManager, and is refused like anyone else.
    function test_allTenCallbacksRefuseTheVault() public {
        OracleSnap memory before = _snap();
        _callAllTenAs(address(vault), "vault");
        _assertSame(before, _snap(), "after vault calls");
    }

    /// @notice The POOL CREATOR is the only privileged role the hook has (admission + allowlist). That
    ///         privilege does not extend to driving a callback.
    function test_allTenCallbacksRefuseThePoolCreator() public {
        assertEq(hook.poolCreator(), address(this), "premise: this contract is the pool creator");
        OracleSnap memory before = _snap();
        _callAllTenAs(address(this), "poolCreator");
        _assertSame(before, _snap(), "after pool-creator calls");
    }

    /// @notice A contract that merely CLAIMS to be a PoolManager. The hook is bound to one address.
    function test_allTenCallbacksRefuseAPoolManagerImpostor() public {
        OracleSnap memory before = _snap();
        address impostor = address(new PoolManagerImpostor());
        _callAllTenAs(impostor, "impostor");
        _assertSame(before, _snap(), "after impostor calls");
    }

    /* ================================================================ unmined == unreachable */

    /// @notice The five unmined callbacks revert UNCONDITIONALLY — and the real PoolManager never calls
    ///         them, because their bits are clear in the hook's address. Proof by doing the thing: a
    ///         donate and a remove-liquidity on the hook's own pool both succeed, and the hook's state is
    ///         untouched by either.
    function test_unminedCallbacksAreUnreachableThroughTheRealPoolManager() public {
        OracleSnap memory before = _snap();

        // donate() on our pool: beforeDonate/afterDonate would revert if they ran. They do not run.
        donateRouter.donate(hookKey, 1e18, 1e18, ZERO_BYTES);
        _assertSame(before, _snap(), "after a donate on the hook's pool");

        // remove liquidity: beforeRemoveLiquidity/afterRemoveLiquidity would revert if they ran.
        modifyLiquidityRouter.modifyLiquidity(
            hookKey, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: -1e18, salt: 0}), ZERO_BYTES
        );
        _assertSame(before, _snap(), "after a remove on the hook's pool");

        // And the vault's exit, which is the whole point of leaving those bits clear.
        vm.prank(alice);
        vault.withdrawAll(1);
        _assertSame(before, _snap(), "after a vault withdrawal");
        assertEq(vault.getPosition(1).liquidity, 0, "withdrawal did not complete");
    }
}

/// @dev Claims to be a PoolManager; is nothing of the sort.
contract PoolManagerImpostor {
    function unlock(bytes calldata) external pure returns (bytes memory) {
        return "";
    }
}
