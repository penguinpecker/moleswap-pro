// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {MoleQueue} from "../../src/MoleQueue.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {HardeningBase} from "../helpers/HardeningBase.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   F I N D I N G S

  Target:  unlockCallback on MolePositions, MoleQueue, MoleRouter (dossier Part 2 §12/§14, P-28).
  Lens:    "the PoolManager calls unlockCallback, but the DATA is crafted by whoever triggered the
            unlock. Who called you and what they claim are two different questions." Every test
            below separates the two.

  CHECK 1 — msg.sender == poolManager.                                          HOLDS, all three.
    A direct caller, a foreign unlock initiator forwarding our payload from inside ITS callback on
    the REAL PoolManager, a hostile PoolManager look-alike, and a byte-identical second PoolManager
    are each refused with NotPoolManager, and nothing moves. The structural reason: the canonical
    PoolManager only ever calls back `msg.sender` of `unlock`, and the only callers of `unlock` in
    our code are our own entrypoints with self-built payloads.

  CHECK 2 — the transient initiator sentinel ("did I start this unlock?").
    MoleRouter   HOLDS.   `_lockValue()` is set by `_swap` before `unlock` and checked in the
                          callback: a payload the router did not author is refused (UnexpectedCallback)
                          even when it arrives with msg.sender == PoolManager mid-unlock.
    MolePositions FAILS.  No sentinel. A payload the vault did not author — (Open, <attacker's id>,
                          <victim as payer>, +L) — is executed if it arrives as the PoolManager mid-
                          unlock: the victim's standing ERC-20 allowance to the vault is pulled to fund
                          liquidity under the attacker's position id, stranded on top of the stored
                          number. See HARDENING-FINDINGS.md H-1.
    MoleQueue     FAILS.  No sentinel. A payload the queue did not author — (residual0 = escrow,
                          residual1 = 0, priceX96 = 1) — swaps the escrow through the pool with the
                          Q-1 bound defeated (the bound reads priceX96 from the payload). See H-1.

  WHAT THE TWO FAILS ARE AND ARE NOT. Against the canonical PoolManager the second check is
  unreachable: the singleton calls back only its `unlock` caller. The tests reproduce the condition
  the second check exists for — our callback entered with msg.sender == PoolManager but a payload we
  did not build — by initiating a REAL unlock from this test contract and impersonating the manager
  for one call from inside it. That is the defence-in-depth half of P-28, recorded as absent on two
  of the three contracts, and left RED on purpose. They are NOT an exploit against the live
  deployment; they are the reason `poolManager` being storage (re-settable by an upgrade) is a
  sharper edge than it looks.
//////////////////////////////////////////////////////////////////////////////*/

/// @dev An attacker that initiates a REAL unlock and, from inside its own callback, forwards a payload
///      to one of our contracts' `unlockCallback`. Records the inner result; settles nothing, so the
///      outer unlock closes with zero deltas and the forwarded call's effect (if any) would persist.
contract ForeignInitiator is IUnlockCallback {
    IPoolManager internal immutable pm;
    bool public innerOk;
    bytes public innerRet;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function attack(address target, bytes calldata payload) external {
        pm.unlock(abi.encode(target, payload));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "wrong manager");
        (address target, bytes memory payload) = abi.decode(data, (address, bytes));
        (innerOk, innerRet) = target.call(abi.encodeWithSelector(IUnlockCallback.unlockCallback.selector, payload));
        return "";
    }
}

/// @dev A contract that CLAIMS to be a PoolManager: its `unlock` calls the target's `unlockCallback`
///      directly with whatever payload it likes. The shape of "a hostile PoolManager clone".
contract FakePoolManager {
    bool public innerOk;
    bytes public innerRet;

    function unlock(address target, bytes calldata payload) external {
        (innerOk, innerRet) = target.call(abi.encodeWithSelector(IUnlockCallback.unlockCallback.selector, payload));
    }
}

contract AttackHardeningUnlockAuth is HardeningBase, IUnlockCallback {
    uint256 internal victimId;
    uint256 internal malloryId;

    /// @dev Set by a test before it initiates its own unlock; read inside `unlockCallback`.
    address internal pranked_target;
    bytes internal pranked_payload;
    bool internal pranked_ok;
    bytes internal pranked_ret;

    function setUp() public {
        _buildWorld(0);
        victimId = _open(alice, -600, 600, 10e18);
        malloryId = _open(mallory, -600, 600, 1e18);
        // An epoch with live escrow, so a queue payload has something to act on.
        vm.prank(bob);
        queue.place(true, 100e18);
    }

    /* ------------------------------------------------------------------ payloads */

    /// @dev The most damaging vault payload: add liquidity to MALLORY's position, paid by ALICE.
    function _vaultPayload() internal view returns (bytes memory) {
        return abi.encode(
            MolePositions.Action.Open, malloryId, alice, int256(1e18), int24(0), int24(0), type(uint256).max, type(uint256).max
        );
    }

    /// @dev The most damaging queue payload: swap the whole currency0 escrow with the Q-1 bound read
    ///      from the payload itself (priceX96 = 1 makes the "fair" output zero, so any fill passes).
    function _queuePayload() internal pure returns (bytes memory) {
        return abi.encode(uint128(100e18), uint128(0), uint256(1));
    }

    /// @dev The most damaging router payload: a plan naming ALICE as payer and MALLORY as recipient.
    function _routerPayload() internal view returns (bytes memory) {
        MoleRouter.SwapPlan memory plan = _v4Plan(true, 5e18, 1, mallory);
        return abi.encode(plan, alice);
    }

    function _snapshot() internal view returns (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vaultLiq) {
        (a0, a1) = _bal(alice);
        q0 = t0.balanceOf(address(queue));
        (m0, m1) = _bal(mallory);
        vaultLiq = _onChainLiquidity(malloryId);
    }

    function _assertUntouched(
        uint256 a0,
        uint256 a1,
        uint256 q0,
        uint256 m0,
        uint256 m1,
        uint128 vaultLiq,
        string memory when
    ) internal view {
        (uint256 b0, uint256 b1) = _bal(alice);
        assertEq(b0, a0, string.concat("alice currency0 moved: ", when));
        assertEq(b1, a1, string.concat("alice currency1 moved: ", when));
        assertEq(t0.balanceOf(address(queue)), q0, string.concat("queue escrow moved: ", when));
        (uint256 n0, uint256 n1) = _bal(mallory);
        assertEq(n0, m0, string.concat("mallory currency0 moved: ", when));
        assertEq(n1, m1, string.concat("mallory currency1 moved: ", when));
        assertEq(_onChainLiquidity(malloryId), vaultLiq, string.concat("mallory's on-chain liquidity changed: ", when));
        assertEq(vault.getPosition(malloryId).liquidity, 1e18, string.concat("mallory's stored liquidity changed: ", when));
        _assertHoldsNothing(address(vault), when);
        _assertHoldsNothing(address(router), when);
    }

    /* ================================================================ CHECK 1: who called me */

    /// @notice A direct caller — any EOA — is refused by all three, with the named error.
    function test_check1_directCallerIsRefusedByEveryContract() public {
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();

        vm.startPrank(mallory);
        vm.expectRevert(MolePositions.NotPoolManager.selector);
        vault.unlockCallback(_vaultPayload());
        vm.expectRevert(MoleQueue.NotPoolManager.selector);
        queue.unlockCallback(_queuePayload());
        vm.expectRevert(MoleRouter.NotPoolManager.selector);
        router.unlockCallback(_routerPayload());
        vm.stopPrank();

        _assertUntouched(a0, a1, q0, m0, m1, vl, "after direct calls");
    }

    /// @notice A FOREIGN unlock on the REAL PoolManager cannot deliver our payload to us. The attacker
    ///         is a legitimate unlock initiator — the manager IS unlocked, the attacker IS inside a
    ///         callback — and still the forwarded call arrives with msg.sender == attacker, never the
    ///         manager. The PoolManager calls back only whoever called `unlock`.
    function test_check1_foreignUnlockCannotDeliverOurCallbackSelector() public {
        ForeignInitiator fi = new ForeignInitiator(manager);
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();

        fi.attack(address(vault), _vaultPayload());
        assertFalse(fi.innerOk(), "vault accepted a payload forwarded from a foreign unlock");
        assertEq(bytes4(fi.innerRet()), MolePositions.NotPoolManager.selector, "vault: wrong reason");

        fi.attack(address(queue), _queuePayload());
        assertFalse(fi.innerOk(), "queue accepted a payload forwarded from a foreign unlock");
        assertEq(bytes4(fi.innerRet()), MoleQueue.NotPoolManager.selector, "queue: wrong reason");

        fi.attack(address(router), _routerPayload());
        assertFalse(fi.innerOk(), "router accepted a payload forwarded from a foreign unlock");
        assertEq(bytes4(fi.innerRet()), MoleRouter.NotPoolManager.selector, "router: wrong reason");

        _assertUntouched(a0, a1, q0, m0, m1, vl, "after foreign unlocks");
    }

    /// @notice While a stranger holds the manager unlocked, none of our ENTRYPOINTS can be driven
    ///         either: every one of them opens its own unlock, and the singleton refuses a nested one.
    ///         So a foreign callback frame is not a window into any of our state transitions.
    function test_check1_ourEntrypointsAreUnreachableFromInsideAForeignUnlock() public {
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();
        pranked_target = address(0); // plain mode: the callback below probes the entrypoints
        manager.unlock(abi.encode(uint256(1)));
        _assertUntouched(a0, a1, q0, m0, m1, vl, "after probing entrypoints mid-unlock");
        assertEq(vault.positionCount(), 2, "a position was minted from inside a foreign unlock");
    }

    /// @notice A hostile PoolManager look-alike — a contract that simply calls our callback — and a
    ///         byte-identical SECOND PoolManager are both rejected: our contracts are bound to ONE
    ///         manager address, pinned at initialization.
    function test_check1_hostilePoolManagerCloneIsRejected() public {
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();

        FakePoolManager fake = new FakePoolManager();
        fake.unlock(address(vault), _vaultPayload());
        assertFalse(fake.innerOk(), "vault obeyed a fake PoolManager");
        assertEq(bytes4(fake.innerRet()), MolePositions.NotPoolManager.selector, "vault: wrong reason (fake)");
        fake.unlock(address(queue), _queuePayload());
        assertFalse(fake.innerOk(), "queue obeyed a fake PoolManager");
        assertEq(bytes4(fake.innerRet()), MoleQueue.NotPoolManager.selector, "queue: wrong reason (fake)");
        fake.unlock(address(router), _routerPayload());
        assertFalse(fake.innerOk(), "router obeyed a fake PoolManager");
        assertEq(bytes4(fake.innerRet()), MoleRouter.NotPoolManager.selector, "router: wrong reason (fake)");

        // The real article, deployed a second time: identical code, different address, no authority.
        PoolManager clone = new PoolManager(address(this));
        ForeignInitiator viaClone = new ForeignInitiator(IPoolManager(address(clone)));
        viaClone.attack(address(vault), _vaultPayload());
        assertFalse(viaClone.innerOk(), "vault obeyed a byte-identical second PoolManager");
        assertEq(bytes4(viaClone.innerRet()), MolePositions.NotPoolManager.selector, "vault: wrong reason (clone)");
        viaClone.attack(address(queue), _queuePayload());
        assertFalse(viaClone.innerOk(), "queue obeyed a byte-identical second PoolManager");
        assertEq(bytes4(viaClone.innerRet()), MoleQueue.NotPoolManager.selector, "queue: wrong reason (clone)");
        viaClone.attack(address(router), _routerPayload());
        assertFalse(viaClone.innerOk(), "router obeyed a byte-identical second PoolManager");
        assertEq(bytes4(viaClone.innerRet()), MoleRouter.NotPoolManager.selector, "router: wrong reason (clone)");

        _assertUntouched(a0, a1, q0, m0, m1, vl, "after clone attempts");
    }

    /* ================================================================ CHECK 2: did I start this */

    /// @dev Initiate a REAL unlock from this contract and, inside it, deliver `payload` to `target`
    ///      AS the PoolManager. Reproduces "msg.sender == PoolManager, payload not ours".
    function _deliverAsManager(address target, bytes memory payload) internal {
        pranked_target = target;
        pranked_payload = payload;
        manager.unlock(abi.encode(uint256(2)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "not the manager");
        uint256 mode = abi.decode(data, (uint256));
        if (mode == 1) {
            // Probe every entrypoint from inside a foreign unlock. Each must be refused, and for the
            // reason that proves the frame is closed: our own unlock is refused as NESTED by the
            // singleton (open, swap), and a stranger's exit is refused on ownership (withdrawAll).
            (bool ok1, bytes memory r1) = address(vault).call(
                abi.encodeCall(
                    MolePositions.open,
                    (hookKey, int24(-600), int24(600), uint128(1e18), type(uint256).max, type(uint256).max, block.timestamp)
                )
            );
            assertFalse(ok1, "vault.open succeeded inside a foreign unlock");
            assertEq(bytes4(r1), IPoolManager.AlreadyUnlocked.selector, "vault.open refused for the wrong reason");
            (bool ok2, bytes memory r2) = address(vault).call(abi.encodeCall(MolePositions.withdrawAll, (victimId)));
            assertFalse(ok2, "vault.withdrawAll succeeded inside a foreign unlock");
            assertEq(bytes4(r2), MolePositions.NotOwner.selector, "withdrawAll refused for the wrong reason");
            (bool ok3, bytes memory r3) =
                address(router).call(abi.encodeCall(MoleRouter.swap, (_v4Plan(true, 1e18, 1, address(this)))));
            assertFalse(ok3, "router.swap succeeded inside a foreign unlock");
            assertEq(bytes4(r3), IPoolManager.AlreadyUnlocked.selector, "router.swap refused for the wrong reason");
            return "";
        }
        vm.prank(address(manager));
        (pranked_ok, pranked_ret) =
            pranked_target.call(abi.encodeWithSelector(IUnlockCallback.unlockCallback.selector, pranked_payload));
        return "";
    }

    /// @notice ROUTER: a payload the router did not author is refused even as the PoolManager mid-unlock.
    ///         The transient lock is the sentinel — set by `_swap`, read by the callback.
    function test_check2_router_refusesACallbackItDidNotInitiate() public {
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();
        _deliverAsManager(address(router), _routerPayload());
        assertFalse(pranked_ok, "router executed a plan it did not author (victim as payer)");
        assertEq(bytes4(pranked_ret), MoleRouter.UnexpectedCallback.selector, "router: wrong reason");
        _assertUntouched(a0, a1, q0, m0, m1, vl, "after the unauthored router payload");
    }

    /// @notice VAULT: a payload the vault did not author must be refused even as the PoolManager.
    ///         RED TODAY — no sentinel; see HARDENING-FINDINGS.md H-1. What happens instead: the
    ///         victim's allowance funds liquidity under the attacker's id, above the stored number.
    function test_check2_vault_refusesACallbackItDidNotInitiate() public {
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();
        _deliverAsManager(address(vault), _vaultPayload());
        assertFalse(pranked_ok, "P-28: vault executed a payload it did not author (H-1)");
        _assertUntouched(a0, a1, q0, m0, m1, vl, "after the unauthored vault payload");
    }

    /// @notice QUEUE: a payload the queue did not author must be refused even as the PoolManager.
    ///         RED TODAY — no sentinel; see HARDENING-FINDINGS.md H-1. What happens instead: the
    ///         escrow is swapped with the Q-1 bound read from the payload, output left unattributed.
    function test_check2_queue_refusesACallbackItDidNotInitiate() public {
        (uint256 a0, uint256 a1, uint256 q0, uint256 m0, uint256 m1, uint128 vl) = _snapshot();
        _deliverAsManager(address(queue), _queuePayload());
        assertFalse(pranked_ok, "P-28: queue executed a payload it did not author (H-1)");
        _assertUntouched(a0, a1, q0, m0, m1, vl, "after the unauthored queue payload");
    }
}
