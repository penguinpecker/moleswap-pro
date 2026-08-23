// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";

import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @dev Someone who holds a v4 unlock and, from inside it, calls MoleQueue's callback directly. The
///      caller check catches this one — which is the point of showing it: the two guards are separate
///      properties, and only the first of them was ever present.
contract UnlockSquatter is IUnlockCallback {
    address public immutable manager;
    MoleQueue public immutable queue;
    bytes public payload;

    constructor(address _manager, MoleQueue _queue) {
        manager = _manager;
        queue = _queue;
    }

    function attack(bytes memory p) external {
        payload = p;
        (bool ok, bytes memory ret) = manager.call(abi.encodeWithSignature("unlock(bytes)", bytes("")));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        // We hold the unlock. Now make the queue believe it is being called back.
        queue.unlockCallback(payload);
        return "";
    }
}

/// @notice H-1 / P-28 — THE CALLBACK KNEW WHO CALLED IT AND NOT WHY.
///
/// `unlockCallback` is a public entry point whose only authentication was `msg.sender == poolManager`.
/// That is a check on the messenger, not on the message: the arguments it then decodes — two residual
/// sizes and the price the residual is bounded against — are treated as ones this contract encoded
/// moments earlier, and nothing in the function established that. Today v4 refuses a nested unlock, so
/// the reachability argument is "unreachable by construction"; the sentinel turns that into "refused",
/// which is a different and much shorter sentence to have to defend after the next upgrade of anything.
///
/// MoleRouter already pins every one of its callbacks this way, in transient storage, and says why:
/// "a stale active-pool authorisation leaking into a later call is precisely the hole this guards".
/// The queue's callback moves the escrow of everybody in an epoch and had no such pin.
contract AttackHardening_unlockAuth is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH = 600;
    uint32 internal constant FREEZE = 120;
    uint32 internal constant LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 1800;
    int24 internal constant TWAP_BAND = 500;
    uint16 internal constant RESIDUAL_BPS = 200;
    uint256 internal constant T0 = 1_750_000_000;

    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MoleHook internal hook;
    MoleQueue internal queue;
    PoolKey internal qKey;

    uint256 internal _clock;
    uint256 internal _height;

    function _advance(uint256 s) internal {
        _clock += s;
        vm.warp(_clock);
        _height += 1 + s / 12;
        vm.roll(_height);
    }

    function setUp() public {
        vm.warp(T0);
        _clock = block.timestamp;
        _height = block.number;

        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();

        address a = address(
            uint160(
                (uint160(uint256(keccak256("attack-unlock-auth"))) & ~HookPermissions.ALL_HOOK_MASK)
                    | HookPermissions.REQUIRED_FLAGS
            )
        );
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        qKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        manager.initialize(qKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            qKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200_000e18, salt: 0}),
            ZERO_BYTES
        );

        _advance(uint256(TWAP_WINDOW) * 2);

        queue = deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            qKey,
            EPOCH,
            FREEZE,
            LIFE,
            TWAP_WINDOW,
            TWAP_BAND,
            RESIDUAL_BPS,
            TEST_UPGRADE_ADMIN
        );

        MockERC20(Currency.unwrap(currency0)).transfer(alice, 1_000_000e18);
        MockERC20(Currency.unwrap(currency1)).transfer(bob, 1_000_000e18);
        vm.prank(alice);
        MockERC20(Currency.unwrap(currency0)).approve(address(queue), type(uint256).max);
        vm.prank(bob);
        MockERC20(Currency.unwrap(currency1)).approve(address(queue), type(uint256).max);
    }

    /// @notice A DIRECT CALL FROM THE POOL MANAGER'S OWN ADDRESS IS STILL REFUSED, because passing the
    ///         `msg.sender` test was never the same as this contract having asked for an unlock. The
    ///         payload here is a well-formed one — two residual sizes and a price — so the only thing
    ///         standing between it and a swap of the queue's escrow is the sentinel.
    function test_unlockCallbackRefusesACallTheQueueDidNotInitiate() public {
        bytes memory payload = abi.encode(uint128(1_000e18), uint128(0), uint256(FixedPoint96.Q96));

        vm.prank(address(manager));
        vm.expectRevert(MoleQueue.UnlockNotInitiated.selector);
        queue.unlockCallback(payload);
    }

    /// @notice THE TWO GUARDS ARE DIFFERENT PROPERTIES, and this test holds them apart.
    ///
    ///         A squatter who holds a real v4 unlock and calls the callback from inside it is stopped by
    ///         the CALLER check — that one was always there. The interesting case is the same moment with
    ///         the PoolManager itself making the call, which is what "the callback ran while somebody
    ///         else held the unlock" actually looks like from the queue's side. `msg.sender` is then
    ///         perfect and the payload is well-formed, and only the sentinel is left: without it the
    ///         queue would run a swap of its escrow inside a stranger's unlock, where the stranger owns
    ///         the resulting deltas.
    function test_unlockCallbackRefusesAnUnlockHeldBySomebodyElse() public {
        vm.prank(alice);
        queue.place(true, 1_000e18);

        UnlockSquatter squatter = new UnlockSquatter(address(manager), queue);
        bytes memory payload = abi.encode(uint128(1_000e18), uint128(0), uint256(FixedPoint96.Q96));

        uint256 potBefore = MockERC20(Currency.unwrap(currency0)).balanceOf(address(queue));

        // Layer one: not the PoolManager.
        vm.expectRevert(MoleQueue.NotPoolManager.selector);
        squatter.attack(payload);

        // Layer two: it IS the PoolManager, and a stranger holds the unlock. `_stranger` runs inside a
        // live unlock it opened itself, so the queue is being called back exactly as it would be, at
        // exactly the moment where the deltas would not be its own.
        _pendingPayload = payload;
        vm.expectRevert(MoleQueue.UnlockNotInitiated.selector);
        manager.unlock("");

        assertEq(
            MockERC20(Currency.unwrap(currency0)).balanceOf(address(queue)),
            potBefore,
            "escrow moved inside somebody else's unlock"
        );
    }

    bytes internal _pendingPayload;

    /// @dev This test contract is the stranger holding the unlock. Pranking the PoolManager from here is
    ///      the only way to reproduce "the callback is invoked by the PoolManager while the unlock
    ///      belongs to somebody else" — v4 will not do it for us, which is exactly why the sentinel is
    ///      defence in depth rather than a live fix.
    function unlockCallback(bytes calldata) external returns (bytes memory) {
        vm.prank(address(manager));
        queue.unlockCallback(_pendingPayload);
        return "";
    }

    /// @notice The sentinel does not survive the transaction that set it, so a settlement cannot leave an
    ///         authorisation lying around for a later caller to walk into. The check is run AFTER a real
    ///         settlement, which is the only moment the flag was ever set.
    function test_theSentinelIsNotLeftArmedAfterARealSettlement() public {
        vm.prank(alice);
        queue.place(true, 1_500e18);
        vm.prank(bob);
        queue.place(false, 1_000e18);

        _advance(EPOCH);
        queue.freeze();
        _advance(FREEZE);
        queue.settle(0);
        assertEq(uint8(queue.phaseOf(0)), uint8(MoleQueue.Phase.Settled), "premise: the settlement did not happen");

        // A fresh transaction. If the flag were storage rather than transient, this would now be armed.
        bytes memory payload = abi.encode(uint128(1_000e18), uint128(0), uint256(FixedPoint96.Q96));
        vm.prank(address(manager));
        vm.expectRevert(MoleQueue.UnlockNotInitiated.selector);
        queue.unlockCallback(payload);
    }
}
