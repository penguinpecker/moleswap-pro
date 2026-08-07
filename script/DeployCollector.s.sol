// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleFeeCollector} from "../src/MoleFeeCollector.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @notice Deploys the fee collector and repoints the vault's `feeRecipient` at it, so accrued revenue
///         becomes redeemable instead of sitting as claims nobody can convert.
contract DeployCollector is Script {
    function run() external {
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));
        address owner = vm.envOr("COLLECTOR_OWNER", msg.sender);

        vm.startBroadcast();
        MoleFeeCollector collector = new MoleFeeCollector(IPoolManager(RHChain.POOL_MANAGER), owner);
        vault.setFeeRecipient(address(collector));
        vm.stopBroadcast();

        require(vault.feeRecipient() == address(collector), "DeployCollector: repoint failed");
        console2.log("MoleFeeCollector :", address(collector));
        console2.log("  owner          :", collector.owner());
        console2.log("vault feeRecipient now:", vault.feeRecipient());
    }
}
