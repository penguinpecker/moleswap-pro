// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MolePositions} from "../../src/MolePositions.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {MoleQueue} from "../../src/MoleQueue.sol";
import {MoleRouter} from "../../src/MoleRouter.sol";
import {IMoleOracle} from "../../src/MoleQueue.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";

// Deploy helpers for the UUPS build.
//
// Both contracts moved from constructors to initializers behind ERC-1967 proxies, which changes how every
// test builds a world. These helpers keep the OLD ARGUMENT LISTS so the ~90 existing call sites keep
// asserting exactly what they asserted before the change — the point of the migration was to change who
// can replace the code, not what the code does, and a suite rewritten alongside it would no longer be
// evidence of that.
//
// The upgrade admin defaults to `TEST_UPGRADE_ADMIN`, a fixed address derived from a string. It is NOT
// the calling test contract: these are file-level functions and Solidity gives them no `this`. A constant
// is better here anyway — it is the same address in every world, so a test that wants to exercise the
// upgrade path just pranks it, and a test that does not can never accidentally hold the root key itself
// and upgrade something by accident.
address constant TEST_UPGRADE_ADMIN = address(uint160(uint256(keccak256("mole.test.upgradeAdmin"))));

/// @notice External wrappers, for tests that expect the deployment to REVERT.
///
/// @dev `vm.expectRevert` arms for the next call or create. A proxy deployment is TWO creates — the
///      implementation, then the proxy whose constructor runs `initialize` — and the implementation
///      always succeeds, so the cheatcode is consumed by the wrong one and the test reports "next call
///      did not revert as expected" while the contract is behaving perfectly. Routing through an external
///      call makes the whole deployment a single frame, so the initializer's revert is what surfaces.
contract MoleDeployer {
    /// @dev Router variant of the wrapper below — a proxy deploy is two creates, so a test expecting the
    ///      INITIALIZER to revert must route through one external frame or the cheatcode is consumed by the
    ///      implementation create, which always succeeds.
    function router(IPoolManager poolManager, address weth, address feeDial, address feeRecipient, address upgradeAdmin)
        external
        returns (MoleRouter)
    {
        return deployMoleRouterOwned(poolManager, weth, feeDial, feeRecipient, upgradeAdmin);
    }

    function vault(
        IPoolManager poolManager,
        address keeper,
        uint32 minRebalanceInterval,
        int24 minRangeWidth,
        int24 maxRangeWidth,
        address moleHook,
        int24 maxTwapDeviationTicks,
        uint32 twapWindow,
        uint64 minDwellL1Blocks,
        uint16 maxRebalancesPerL1Block,
        uint16 maxEjectionBps,
        int24 maxRecenterTicks,
        uint16 performanceFeeBps,
        address feeRecipient
    ) external returns (MolePositions) {
        return deployMoleVault(
            poolManager,
            keeper,
            minRebalanceInterval,
            minRangeWidth,
            maxRangeWidth,
            moleHook,
            maxTwapDeviationTicks,
            twapWindow,
            minDwellL1Blocks,
            maxRebalancesPerL1Block,
            maxEjectionBps,
            maxRecenterTicks,
            performanceFeeBps,
            feeRecipient
        );
    }

    function hookAnywhere(
        IPoolManager poolManager,
        address poolCreator,
        uint24 lpFeePips,
        uint32 minObservationInterval,
        bool restrictedLiquidity,
        uint24 hookFeePips,
        address feeRecipient
    ) external returns (MoleHook) {
        return deployMoleHookAnywhere(
            poolManager, poolCreator, lpFeePips, minObservationInterval, restrictedLiquidity, hookFeePips, feeRecipient
        );
    }

    /// @dev Same purpose for the queue: `vm.expectRevert` arms for ONE call or create, and deploying
    ///      through a proxy is TWO creates. Wrapping the pair behind a single external call is what makes
    ///      an initializer rule provable at the point it actually matters — the deployment.
    function queue(
        IPoolManager poolManager,
        IMoleOracle oracle,
        PoolKey memory key,
        uint32 epochDuration,
        uint32 freezeDuration,
        uint32 maxEpochLife,
        uint32 twapWindow,
        int24 maxTwapDeviationTicks,
        uint16 maxResidualSlippageBps,
        address upgradeAdmin
    ) external returns (MoleQueue) {
        return deployMoleQueue(
            poolManager,
            oracle,
            key,
            epochDuration,
            freezeDuration,
            maxEpochLife,
            twapWindow,
            maxTwapDeviationTicks,
            maxResidualSlippageBps,
            upgradeAdmin
        );
    }
}

/// @dev Implementation + proxy + initialize. Returns the PROXY typed as MolePositions.
function deployMoleVault(
    IPoolManager poolManager,
    address keeper,
    uint32 minRebalanceInterval,
    int24 minRangeWidth,
    int24 maxRangeWidth,
    address moleHook,
    int24 maxTwapDeviationTicks,
    uint32 twapWindow,
    uint64 minDwellL1Blocks,
    uint16 maxRebalancesPerL1Block,
    uint16 maxEjectionBps,
    int24 maxRecenterTicks,
    uint16 performanceFeeBps,
    address feeRecipient
) returns (MolePositions) {
    return deployMoleVaultOwned(
        poolManager,
        keeper,
        minRebalanceInterval,
        minRangeWidth,
        maxRangeWidth,
        moleHook,
        maxTwapDeviationTicks,
        twapWindow,
        minDwellL1Blocks,
        maxRebalancesPerL1Block,
        maxEjectionBps,
        maxRecenterTicks,
        performanceFeeBps,
        feeRecipient,
        TEST_UPGRADE_ADMIN
    );
}

/// @dev Same, with an explicit upgrade admin. Separate because the 14-argument form above has to stay
///      call-compatible with every existing test.
function deployMoleVaultOwned(
    IPoolManager poolManager,
    address keeper,
    uint32 minRebalanceInterval,
    int24 minRangeWidth,
    int24 maxRangeWidth,
    address moleHook,
    int24 maxTwapDeviationTicks,
    uint32 twapWindow,
    uint64 minDwellL1Blocks,
    uint16 maxRebalancesPerL1Block,
    uint16 maxEjectionBps,
    int24 maxRecenterTicks,
    uint16 performanceFeeBps,
    address feeRecipient,
    address upgradeAdmin
) returns (MolePositions) {
    MolePositions impl = new MolePositions();
    bytes memory data = abi.encodeCall(
        MolePositions.initialize,
        (
            MolePositions.InitParams({
                poolManager: poolManager,
                keeper: keeper,
                minRebalanceInterval: minRebalanceInterval,
                minRangeWidth: minRangeWidth,
                maxRangeWidth: maxRangeWidth,
                moleHook: moleHook,
                maxTwapDeviationTicks: maxTwapDeviationTicks,
                twapWindow: twapWindow,
                minDwellL1Blocks: minDwellL1Blocks,
                maxRebalancesPerL1Block: maxRebalancesPerL1Block,
                maxEjectionBps: maxEjectionBps,
                maxRecenterTicks: maxRecenterTicks,
                performanceFeeBps: performanceFeeBps,
                feeRecipient: feeRecipient,
                upgradeAdmin: upgradeAdmin
            })
        )
    );
    return MolePositions(address(new ERC1967Proxy(address(impl), data)));
}

/// @dev A hook proxy at whatever address CREATE happens to give us. Used by the configuration tests,
///      which expect `initialize` to REVERT — so where it lands is irrelevant.
///
///      The validation order matters and is preserved from the old constructor: the fee and interval
///      checks run BEFORE the address check, so a bad configuration still reports as itself rather than
///      being masked by `BadHookAddress` at an unmined address.
function deployMoleHookAnywhere(
    IPoolManager poolManager,
    address poolCreator,
    uint24 lpFeePips,
    uint32 minObservationInterval,
    bool restrictedLiquidity,
    uint24 hookFeePips,
    address feeRecipient
) returns (MoleHook) {
    MoleHook impl = new MoleHook();
    bytes memory data = abi.encodeCall(
        MoleHook.initialize,
        (
            poolManager,
            poolCreator,
            lpFeePips,
            minObservationInterval,
            restrictedLiquidity,
            hookFeePips,
            feeRecipient,
            TEST_UPGRADE_ADMIN
        )
    );
    return MoleHook(address(new ERC1967Proxy(address(impl), data)));
}

/// @dev The constructor arguments for a hook proxy, for use with forge's `deployCodeTo` — which is the
///      only way to place a proxy at a MINED address and still have its constructor run there.
///
///      The permission bits must be on the PROXY, never the implementation: the PoolManager only ever sees
///      the proxy address, and `initialize` runs by delegatecall so its own `address(this)` check reads the
///      proxy too. An implementation sitting at a random address is correct and expected.
function hookProxyArgs(
    IPoolManager poolManager,
    address poolCreator,
    uint24 lpFeePips,
    uint32 minObservationInterval,
    bool restrictedLiquidity,
    uint24 hookFeePips,
    address feeRecipient,
    address upgradeAdmin
) returns (bytes memory) {
    MoleHook impl = new MoleHook();
    return abi.encode(
        address(impl),
        abi.encodeCall(
            MoleHook.initialize,
            (
                poolManager,
                poolCreator,
                lpFeePips,
                minObservationInterval,
                restrictedLiquidity,
                hookFeePips,
                feeRecipient,
                upgradeAdmin
            )
        )
    );
}

/// @notice MoleQueue behind its UUPS proxy — the shape it actually deploys in. Tests that build the queue
///         with `new MoleQueue(...)` would exercise an implementation with `_disableInitializers` already
///         run and every configuration slot empty, i.e. a contract that cannot exist on chain.
function deployMoleQueue(
    IPoolManager poolManager,
    IMoleOracle oracle,
    PoolKey memory key,
    uint32 epochDuration,
    uint32 freezeDuration,
    uint32 maxEpochLife,
    uint32 twapWindow,
    int24 maxTwapDeviationTicks,
    uint16 maxResidualSlippageBps,
    address upgradeAdmin
) returns (MoleQueue) {
    MoleQueue impl = new MoleQueue();
    bytes memory data = abi.encodeCall(
        MoleQueue.initialize,
        (
            poolManager,
            oracle,
            key,
            epochDuration,
            freezeDuration,
            maxEpochLife,
            twapWindow,
            maxTwapDeviationTicks,
            maxResidualSlippageBps,
            upgradeAdmin
        )
    );
    return MoleQueue(address(new ERC1967Proxy(address(impl), data)));
}

/// @notice A MoleRouter behind an ERC-1967 proxy, keeping the pre-proxy constructor argument list so the
///         existing router/fee/orders suites keep asserting exactly what they asserted before the router
///         became upgradeable. Same reasoning as the vault helper above: the migration changed WHO can
///         replace the code, not what the code does, and a suite rewritten alongside it would stop being
///         evidence of that.
function deployMoleRouter(IPoolManager poolManager, address weth, address feeDial, address feeRecipient)
    returns (MoleRouter)
{
    return deployMoleRouterOwned(poolManager, weth, feeDial, feeRecipient, TEST_UPGRADE_ADMIN);
}

/// @notice As above, with the upgrade admin named — for tests that exercise the upgrade path itself.
function deployMoleRouterOwned(
    IPoolManager poolManager,
    address weth,
    address feeDial,
    address feeRecipient,
    address upgradeAdmin
) returns (MoleRouter) {
    MoleRouter impl = new MoleRouter();
    bytes memory data =
        abi.encodeCall(MoleRouter.initialize, (poolManager, weth, feeDial, feeRecipient, upgradeAdmin));
    return MoleRouter(payable(address(new ERC1967Proxy(address(impl), data))));
}
