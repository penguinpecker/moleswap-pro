// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @notice Deploys MoleRouter — the aggregator's on-chain executor — to Robinhood Chain.
///
/// IMMUTABLE, NO PROXY, NO ADMIN. Unlike the vault, this contract custodies nothing between transactions,
/// so it ships as a plain immutable deployment: what is verified on the explorer is exactly what runs,
/// forever. The only constructor inputs are the v4 PoolManager (for the unlock/settle handshake) and WETH
/// (the wrapped-native token used at the edges of a native-ETH swap) — both read from the verified RHChain
/// address book rather than passed in, so a fat-fingered address cannot reach mainnet.
contract DeployRouter is Script {
    function run() external {
        vm.startBroadcast();
        MoleRouter router = new MoleRouter(IPoolManager(RHChain.POOL_MANAGER), RHChain.WETH);
        vm.stopBroadcast();

        // Read the wiring back from the deployed contract rather than trusting the constructor arguments.
        require(address(router.poolManager()) == RHChain.POOL_MANAGER, "DeployRouter: poolManager mismatch");
        require(router.weth() == RHChain.WETH, "DeployRouter: weth mismatch");

        console2.log("MoleRouter        :", address(router));
        console2.log("  poolManager     :", address(router.poolManager()));
        console2.log("  weth            :", router.weth());
    }
}
