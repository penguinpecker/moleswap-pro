// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {MoleOrders} from "../src/MoleOrders.sol";

/// @notice Deploys MoleOrders — the non-custodial DCA / limit-order book — bound to the live MoleRouter.
///
/// NON-UPGRADEABLE (an upgradeable approval target could be turned malicious). The admin can only ROTATE
/// the keeper; the keeper can only TRIGGER orders (output goes to the owner, bounded by budget/floor/
/// interval) — never steal. Set the keeper to the bot's own wallet after it exists; start it as the admin.
///
/// Env:
///   MOLE_ORDERS_ROUTER   — the fee-aware MoleRouter (default: the live 0x7D74a095…)
///   MOLE_ORDERS_KEEPER   — the keeper wallet (default: the broadcaster; rotate later)
contract DeployOrders is Script {
    function run() external {
        address routerAddr = vm.envOr("MOLE_ORDERS_ROUTER", address(0x7D74a0959A321e362aDb171E405Ee97ADA6ca79d));
        address keeper = vm.envOr("MOLE_ORDERS_KEEPER", msg.sender);

        vm.startBroadcast();
        MoleOrders book = new MoleOrders(MoleRouter(payable(routerAddr)), msg.sender, keeper);
        vm.stopBroadcast();

        require(address(book.router()) == routerAddr, "DeployOrders: router mismatch");
        require(book.admin() == msg.sender, "DeployOrders: admin mismatch");
        require(book.keeper() == keeper, "DeployOrders: keeper mismatch");

        console2.log("MoleOrders   :", address(book));
        console2.log("  router     :", address(book.router()));
        console2.log("  admin      :", book.admin());
        console2.log("  keeper     :", book.keeper());
    }
}
