// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {MoleQueue, IMoleOracle} from "../src/MoleQueue.sol";
import {RHChain} from "../src/config/RHChain.sol";
import {DeployConfig} from "../src/config/DeployConfig.sol";

/// @notice Deploys MoleQueue — the batch auction — behind a UUPS proxy, bound to the live WETH/USDG pool.
///
/// THE QUEUE IS BOUND TO ONE POOL FOREVER. `key` is set at initialisation and every order, every crossing
/// and every residual swap goes through it. A different pool means a different queue. The key is rebuilt
/// here from the same constants `CreatePool.s.sol` used rather than passed in, so a typo cannot silently
/// point escrow at a pool that does not exist.
contract DeployQueue is Script {
    using PoolIdLibrary for PoolKey;

    function run() external {
        address hook = vm.envAddress("MOLE_HOOK");
        address upgradeAdmin = vm.envOr("MOLE_UPGRADE_ADMIN", msg.sender);

        require(RHChain.WETH < RHChain.USDG, "DeployQueue: currency ordering assumption broken");
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(RHChain.WETH),
            currency1: Currency.wrap(RHChain.USDG),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });

        vm.startBroadcast();
        MoleQueue impl = new MoleQueue();
        MoleQueue queue = MoleQueue(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeCall(
                        MoleQueue.initialize,
                        (
                            IPoolManager(RHChain.POOL_MANAGER),
                            IMoleOracle(hook),
                            key,
                            DeployConfig.DEFAULT_QUEUE_EPOCH,
                            DeployConfig.DEFAULT_QUEUE_FREEZE,
                            DeployConfig.DEFAULT_QUEUE_MAX_LIFE,
                            DeployConfig.DEFAULT_TWAP_WINDOW,
                            DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS,
                            DeployConfig.DEFAULT_QUEUE_RESIDUAL_BPS,
                            upgradeAdmin
                        )
                    )
                )
            )
        );
        vm.stopBroadcast();

        // Read the deployed state back rather than trusting the arguments — a proxy whose initializer
        // silently did not run looks identical from the outside until somebody escrows into it.
        require(queue.upgradeAdmin() == upgradeAdmin, "DeployQueue: admin not set");
        require(queue.epochDuration() == DeployConfig.DEFAULT_QUEUE_EPOCH, "DeployQueue: epoch not set");
        require(
            queue.maxResidualSlippageBps() == DeployConfig.DEFAULT_QUEUE_RESIDUAL_BPS,
            "DeployQueue: residual bound not set"
        );
        require(queue.epochStartedAt() != 0, "DeployQueue: clock not started");

        console2.log("MoleQueue (proxy) :", address(queue));
        console2.log("  implementation  :", address(impl));
        console2.log("  upgradeAdmin    :", queue.upgradeAdmin());
        console2.log("  hook / oracle   :", hook);
        console2.log("  epoch (s)       :", queue.epochDuration());
        console2.log("  freeze (s)      :", queue.freezeDuration());
        console2.log("  maxEpochLife (s):", queue.maxEpochLife());
        console2.log("  twapWindow (s)  :", queue.twapWindow());
        console2.log("  residual bps    :", queue.maxResidualSlippageBps());
        console2.logBytes32(PoolId.unwrap(key.toId()));
    }
}
