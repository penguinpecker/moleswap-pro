// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {MoleFeeDial} from "../src/MoleFeeDial.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @notice Deploys the aggregator's fee dial and MoleRouter to Robinhood Chain.
///
/// THE SPLIT: the router is IMMUTABLE (no proxy, no admin — an upgradeable approval target is a standing-
/// approval risk), while the FEE is a number read at swap time from MoleFeeDial. The router clamps the
/// dial at its compiled-in MAX_FEE_BPS (1%), pins the fee destination as an immutable, and treats any
/// dial failure as fee = 0 — so fees are tunable with one dial transaction, forever, without touching
/// user approvals or re-deploying anything.
///
/// Env:
///   MOLE_FEE_BPS        — initial fee in bps (default 69 = 0.69%)
///   MOLE_FEE_RECIPIENT  — treasury receiving the fee (default: the broadcaster)
contract DeployRouter is Script {
    function run() external {
        uint16 feeBps = uint16(vm.envOr("MOLE_FEE_BPS", uint256(69)));
        address feeRecipient = vm.envOr("MOLE_FEE_RECIPIENT", msg.sender);

        vm.startBroadcast();
        MoleFeeDial dial = new MoleFeeDial(msg.sender, feeBps);
        MoleRouter router =
            new MoleRouter(IPoolManager(RHChain.POOL_MANAGER), RHChain.WETH, address(dial), feeRecipient);
        vm.stopBroadcast();

        // Read the wiring back from the deployed contracts rather than trusting the constructor arguments.
        require(address(router.poolManager()) == RHChain.POOL_MANAGER, "DeployRouter: poolManager mismatch");
        require(router.weth() == RHChain.WETH, "DeployRouter: weth mismatch");
        require(router.feeDial() == address(dial), "DeployRouter: dial mismatch");
        require(router.feeRecipient() == feeRecipient, "DeployRouter: recipient mismatch");
        require(dial.feeBps() == feeBps, "DeployRouter: feeBps mismatch");
        require(dial.owner() == msg.sender, "DeployRouter: dial owner mismatch");

        console2.log("MoleFeeDial       :", address(dial));
        console2.log("  owner           :", dial.owner());
        console2.log("  feeBps          :", dial.feeBps());
        console2.log("MoleRouter        :", address(router));
        console2.log("  poolManager     :", address(router.poolManager()));
        console2.log("  weth            :", router.weth());
        console2.log("  feeDial         :", router.feeDial());
        console2.log("  feeRecipient    :", router.feeRecipient());
    }
}
