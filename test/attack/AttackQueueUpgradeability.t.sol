// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue, IMoleOracle} from "../../src/MoleQueue.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {hookProxyArgs, deployMoleQueue, MoleDeployer, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @title AttackQueueUpgradeability
/// @notice THE QUEUE HOLDS OTHER PEOPLE'S MONEY AND IS UPGRADEABLE. Those two facts together are the whole
///         subject of this file.
///
/// The project rule is that every new contract ships behind a UUPS proxy, and the queue follows it. That is
/// a deliberate trade, not an oversight, and it is the same one the custody core already makes: the upgrade
/// admin can replace every line — including `claim` — and walk off with every escrowed deposit. The point of
/// this file is that the trade is MEASURED rather than assumed. One test below actually performs the theft,
/// so nobody reads "upgradeable" as a footnote.
///
/// What is bounded is everything else: nobody but the admin may upgrade, the configuration cannot be
/// re-initialised to loosen a bound, the implementation cannot be initialised out from under the proxy, and
/// the admin can surrender the key permanently and make all of the above impossible.
contract AttackQueueUpgradeability is Test, Deployers {
    using PoolIdLibrary for PoolKey;

    uint24 internal constant LP_FEE = 3000;
    uint32 internal constant OBS_INTERVAL = 60;
    uint32 internal constant EPOCH_DURATION = 600;
    uint32 internal constant FREEZE_DURATION = 300;
    uint32 internal constant MAX_EPOCH_LIFE = 3600;
    uint32 internal constant TWAP_WINDOW = 300;
    int24 internal constant TWAP_BAND = 600;
    uint16 internal constant RESIDUAL_BPS = 500;
    uint256 internal constant T0 = 1_750_000_000;

    address internal treasury = makeAddr("treasury");
    address internal admin = TEST_UPGRADE_ADMIN;
    address internal alice = makeAddr("alice");
    address internal stranger = makeAddr("stranger");

    MoleHook internal hook;
    PoolKey internal poolKey;
    MoleQueue internal queue;
    MockERC20 internal t0;
    MockERC20 internal t1;
    MoleDeployer internal deployer;

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
        t0 = MockERC20(Currency.unwrap(currency0));
        t1 = MockERC20(Currency.unwrap(currency1));

        uint160 high = uint160(uint256(keccak256("attack-queue-upgrade"))) & ~HookPermissions.ALL_HOOK_MASK;
        address a = address(high | HookPermissions.REQUIRED_FLAGS);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), LP_FEE, OBS_INTERVAL, false, uint24(0), treasury, TEST_UPGRADE_ADMIN),
            a
        );
        hook = MoleHook(a);

        poolKey = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(a)
        });
        manager.initialize(poolKey, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: 200_000e18, salt: 0}),
            ZERO_BYTES
        );
        _warmOracle();

        deployer = new MoleDeployer();
        queue = _deployQueue();

        t0.transfer(alice, 100_000e18);
        t1.transfer(alice, 100_000e18);
        vm.startPrank(alice);
        t0.approve(address(queue), type(uint256).max);
        t1.approve(address(queue), type(uint256).max);
        vm.stopPrank();
    }

    function _warmOracle() internal {
        for (uint256 i = 0; i < 8; i++) {
            _advance(90);
            swapRouter.swap(
                poolKey,
                SwapParams({zeroForOne: i % 2 == 0, amountSpecified: -1e18, sqrtPriceLimitX96: i % 2 == 0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT}),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ZERO_BYTES
            );
        }
        _advance(TWAP_WINDOW + 120);
    }

    function _deployQueue() internal returns (MoleQueue) {
        return deployMoleQueue(
            manager,
            IMoleOracle(address(hook)),
            poolKey,
            EPOCH_DURATION,
            FREEZE_DURATION,
            MAX_EPOCH_LIFE,
            TWAP_WINDOW,
            TWAP_BAND,
            RESIDUAL_BPS,
            admin
        );
    }

    /* ============================================================ who may upgrade */

    /// @notice Everyone who is not the admin is refused, including the parties with the most obvious motive.
    function test_onlyTheUpgradeAdminMayUpgrade() public {
        address fresh = address(new MoleQueue());

        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotUpgradeAdmin.selector);
        queue.upgradeToAndCall(fresh, "");

        // A depositor with real money at stake is refused just the same.
        vm.prank(alice);
        queue.place(true, 100e18);
        vm.prank(alice);
        vm.expectRevert(MoleQueue.NotUpgradeAdmin.selector);
        queue.upgradeToAndCall(fresh, "");

        // And so is the queue itself, which is what a confused-deputy attempt would look like.
        vm.prank(address(queue));
        vm.expectRevert(MoleQueue.NotUpgradeAdmin.selector);
        queue.upgradeToAndCall(fresh, "");

        vm.prank(admin);
        queue.upgradeToAndCall(fresh, "");
    }

    /// @notice An upgrade must not disturb escrow. Money in flight is the thing most likely to be silently
    ///         corrupted by a storage-layout mistake, so this drives a real epoch across the upgrade.
    function test_upgradePreservesEscrowAndTheEpochInFlight() public {
        vm.prank(alice);
        uint256 iA = queue.place(true, 400e18);
        vm.prank(alice);
        queue.place(false, 250e18);

        _advance(EPOCH_DURATION);
        queue.freeze();

        (MoleQueue.Phase phBefore, uint64 frozenBefore, uint128 in0Before, uint128 in1Before,,,,) =
            queue.epochs(0);
        uint256 escrowBefore = t0.balanceOf(address(queue));

        // Deploy the new implementation BEFORE the prank: `vm.prank` arms one call, and a CREATE in the
        // argument list consumes it, so the upgrade would arrive from this test contract instead.
        address fresh = address(new MoleQueue());
        vm.prank(admin);
        queue.upgradeToAndCall(fresh, "");

        (MoleQueue.Phase phAfter, uint64 frozenAfter, uint128 in0After, uint128 in1After,,,,) = queue.epochs(0);
        assertEq(uint8(phAfter), uint8(phBefore), "the epoch phase moved across an upgrade");
        assertEq(frozenAfter, frozenBefore, "the freeze anchor moved across an upgrade");
        assertEq(in0After, in0Before, "side-0 escrow accounting moved across an upgrade");
        assertEq(in1After, in1Before, "side-1 escrow accounting moved across an upgrade");
        assertEq(t0.balanceOf(address(queue)), escrowBefore, "real tokens moved across an upgrade");

        // The configuration survives too — a bound that silently reset to zero would be a live hole.
        assertEq(queue.maxResidualSlippageBps(), RESIDUAL_BPS, "the residual bound reset across an upgrade");
        assertEq(queue.maxTwapDeviationTicks(), TWAP_BAND, "the deviation band reset across an upgrade");
        assertEq(queue.upgradeAdmin(), admin, "the admin reset across an upgrade");

        // And the batch still completes normally afterwards.
        _advance(FREEZE_DURATION);
        queue.settle(0);
        vm.prank(alice);
        assertGt(queue.claim(0, iA), 0, "a settled batch paid nothing after an upgrade");
    }

    /// @notice THE COST OF THE PROXY, PERFORMED RATHER THAN DESCRIBED. This test passes, and it is supposed
    ///         to: the admin replaces the implementation with one that pays escrow to itself. Anyone
    ///         weighing whether to deposit here should read this test, not the marketing.
    function test_theUpgradeAdminCanTakeEveryDepositAndThisIsNotABug() public {
        vm.prank(alice);
        queue.place(true, 900e18);
        assertEq(t0.balanceOf(address(queue)), 900e18, "premise: the escrow is really held here");

        uint256 adminBefore = t0.balanceOf(admin);

        address hostile = address(new DrainingQueue()); // created before the prank; see above
        vm.prank(admin);
        queue.upgradeToAndCall(hostile, "");
        DrainingQueue(address(queue)).sweep(address(t0), admin);

        assertEq(t0.balanceOf(address(queue)), 0, "the escrow survived a hostile upgrade");
        assertEq(t0.balanceOf(admin) - adminBefore, 900e18, "the admin did not receive the escrow");
    }

    /// @notice The way out of the trade above, and it must be genuinely one-way.
    function test_surrenderingTheAdminMakesTheQueueImmutableForever() public {
        vm.prank(alice);
        uint256 iA = queue.place(true, 500e18);

        vm.prank(admin);
        queue.transferUpgradeAdmin(address(0));
        assertEq(queue.upgradeAdmin(), address(0), "the admin was not surrendered");

        address fresh = address(new MoleQueue());
        vm.prank(admin);
        vm.expectRevert(MoleQueue.NotUpgradeAdmin.selector);
        queue.upgradeToAndCall(fresh, "");

        // Nobody can take it back. Stated precisely rather than over-claimed: the guard compares
        // msg.sender to `upgradeAdmin`, which is now address(0), and no transaction can originate from
        // address(0) on a real chain because there is no key for it. A test CAN prank it, which is why
        // this asserts the reachable case — every actual actor is refused — instead of pretending the
        // comparison itself is what makes the surrender one-way.
        vm.prank(stranger);
        vm.expectRevert(MoleQueue.NotUpgradeAdmin.selector);
        queue.transferUpgradeAdmin(stranger);

        // And the contract still WORKS — surrendering the key must not brick the escrow.
        vm.prank(alice);
        queue.cancel(0, iA);
        assertEq(t0.balanceOf(address(queue)), 0, "escrow was stranded by surrendering the admin");
    }

    /* ============================================================ initialisation */

    /// @notice A second `initialize` would let anyone re-point the oracle, widen the bounds or seize the
    ///         admin on a contract that already holds money.
    function test_theProxyCannotBeReinitialised() public {
        vm.prank(alice);
        queue.place(true, 100e18);

        vm.prank(stranger);
        vm.expectRevert(); // OpenZeppelin: InvalidInitialization
        queue.initialize(
            manager, IMoleOracle(address(hook)), poolKey, 1, 1, 2, TWAP_WINDOW, 1, 1, stranger
        );

        assertEq(queue.upgradeAdmin(), admin, "a re-initialisation attempt changed the admin");
        assertEq(queue.maxResidualSlippageBps(), RESIDUAL_BPS, "a re-initialisation attempt changed a bound");
    }

    /// @notice The IMPLEMENTATION must be dead on arrival. An uninitialised implementation is claimable by
    ///         anyone, and a UUPS implementation whose admin is an attacker can be told to upgrade itself
    ///         to a destructing contract, taking every proxy pointed at it down with it.
    function test_theImplementationItselfCannotBeInitialised() public {
        MoleQueue impl = new MoleQueue();
        vm.prank(stranger);
        vm.expectRevert(); // _disableInitializers in the constructor
        impl.initialize(
            manager, IMoleOracle(address(hook)), poolKey, 600, 300, 3600, TWAP_WINDOW, 600, 500, stranger
        );
        assertEq(impl.upgradeAdmin(), address(0), "the implementation was claimable");
    }

    /* ============================================================ initializer bounds */

    /// @notice Protection in name only must not deploy. Each of these was a string `require` on the old
    ///         constructor with no test behind it at all; they are now errors, and pinned by selector.
    function test_theInitializerRefusesEveryUselessConfiguration() public {
        // No deviation band: the batch would cross at any anchor, however stale.
        vm.expectRevert(MoleQueue.TwapBandRequired.selector);
        _init(0, RESIDUAL_BPS, EPOCH_DURATION, FREEZE_DURATION, MAX_EPOCH_LIFE, admin);

        // No residual bound, or one so wide it bounds nothing.
        vm.expectRevert(MoleQueue.BadSlippageBps.selector);
        _init(TWAP_BAND, 0, EPOCH_DURATION, FREEZE_DURATION, MAX_EPOCH_LIFE, admin);
        vm.expectRevert(MoleQueue.BadSlippageBps.selector);
        _init(TWAP_BAND, 10_000, EPOCH_DURATION, FREEZE_DURATION, MAX_EPOCH_LIFE, admin);

        // A zero-length epoch or freeze window.
        vm.expectRevert(MoleQueue.BadDurations.selector);
        _init(TWAP_BAND, RESIDUAL_BPS, 0, FREEZE_DURATION, MAX_EPOCH_LIFE, admin);
        vm.expectRevert(MoleQueue.BadDurations.selector);
        _init(TWAP_BAND, RESIDUAL_BPS, EPOCH_DURATION, 0, MAX_EPOCH_LIFE, admin);

        // A timeout that fires before settlement is even possible: no batch could ever complete.
        vm.expectRevert(MoleQueue.LifeMustOutlastFreeze.selector);
        _init(TWAP_BAND, RESIDUAL_BPS, EPOCH_DURATION, FREEZE_DURATION, FREEZE_DURATION, admin);

        // No admin at all. Not merely useless — it would deploy a contract that can take deposits and can
        // never be fixed, which is strictly worse than refusing.
        vm.expectRevert(MoleQueue.UpgradeAdminRequired.selector);
        _init(TWAP_BAND, RESIDUAL_BPS, EPOCH_DURATION, FREEZE_DURATION, MAX_EPOCH_LIFE, address(0));

        // The positive control: the same call with sane values does deploy, so the reverts above are the
        // rules firing and not something incidental about this harness.
        _init(TWAP_BAND, RESIDUAL_BPS, EPOCH_DURATION, FREEZE_DURATION, MAX_EPOCH_LIFE, admin);
    }

    /// @dev Deploys through the proxy exactly as production does, so an initializer rule is proven to stop
    ///      a DEPLOYMENT rather than merely a direct call to an implementation nobody uses.
    function _init(
        int24 band,
        uint16 bps,
        uint32 epoch,
        uint32 freeze,
        uint32 life,
        address upgradeAdmin_
    ) internal {
        deployer.queue(
            manager,
            IMoleOracle(address(hook)),
            poolKey,
            epoch,
            freeze,
            life,
            TWAP_WINDOW,
            band,
            bps,
            upgradeAdmin_
        );
    }
}

/// @dev The hostile implementation used to perform the admin's power rather than assert it.
contract DrainingQueue {
    function sweep(address token, address to) external {
        (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, _bal(token)));
        require(ok, "sweep failed");
    }

    function _bal(address token) internal view returns (uint256 b) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(this)));
        require(ok, "bal failed");
        b = abi.decode(ret, (uint256));
    }

    function proxiableUUID() external pure returns (bytes32) {
        return 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    }
}
