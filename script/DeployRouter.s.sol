// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {MoleFeeDial} from "../src/MoleFeeDial.sol";
import {MoleOrders} from "../src/MoleOrders.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @notice Deploys the aggregator stack to Robinhood Chain: fee dial, MoleRouter behind a UUPS proxy, and
///         MoleOrders bound to that router.
///
/// THE SPLIT. The FEE NUMBER is a value read at swap time from MoleFeeDial, clamped by the router at its
/// compiled MAX_FEE_BPS (1%), with any dial failure resolving to fee = 0 — so the fee is tunable with one
/// dial transaction and never touches user approvals.
///
/// THE ROUTER IS UPGRADEABLE, which is a reversal of the previous deployment and the stack's largest trust
/// assumption. Operator decision, 2026-08-15, taken knowingly: the router holds unlimited approvals, so
/// whoever holds `upgradeAdmin` can replace its code and reach every wallet that ever approved it, up to
/// that wallet's allowance. `MoleRouter.transferUpgradeAdmin(address(0))` surrenders the key permanently
/// and restores the immutable guarantee; that is the intended end state once the fee model settles.
///
/// MOLEORDERS IS REDEPLOYED WITH IT, and this is not optional: it stores its router as an `immutable`, so
/// the existing MoleOrders can only ever route through the OLD router. It is NOT upgradeable, by design.
///
/// Env:
///   MOLE_FEE_BPS        — initial fee in bps (default 69 = 0.69%)
///   MOLE_FEE_RECIPIENT  — treasury receiving the fee (default: the broadcaster)
///   MOLE_UPGRADE_ADMIN  — the router's upgrade key (default: the broadcaster)
///   MOLE_ORDERS_KEEPER  — the keeper allowed to fill DCA/limit legs (default: the broadcaster)
///   MOLE_ORDERS_ADMIN   — MoleOrders admin (default: the broadcaster)
contract DeployRouter is Script {
    function run() external {
        uint16 feeBps = uint16(vm.envOr("MOLE_FEE_BPS", uint256(69)));
        address feeRecipient = vm.envOr("MOLE_FEE_RECIPIENT", msg.sender);
        address upgradeAdmin = vm.envOr("MOLE_UPGRADE_ADMIN", msg.sender);
        address ordersKeeper = vm.envOr("MOLE_ORDERS_KEEPER", msg.sender);
        address ordersAdmin = vm.envOr("MOLE_ORDERS_ADMIN", msg.sender);

        vm.startBroadcast();
        MoleFeeDial dial = new MoleFeeDial(msg.sender, feeBps);

        MoleRouter impl = new MoleRouter();
        MoleRouter router = MoleRouter(
            payable(
                address(
                    new ERC1967Proxy(
                        address(impl),
                        abi.encodeCall(
                            MoleRouter.initialize,
                            (IPoolManager(RHChain.POOL_MANAGER), RHChain.WETH, address(dial), feeRecipient, upgradeAdmin)
                        )
                    )
                )
            )
        );

        MoleOrders orders = new MoleOrders(router, ordersAdmin, ordersKeeper);
        vm.stopBroadcast();

        // Read the wiring back from the deployed contracts rather than trusting the arguments. Reading
        // through the PROXY is the point: it proves initialize ran against proxy storage, which is the one
        // mistake a UUPS deployment actually makes (immutables set on an implementation read as zero here).
        require(address(router.poolManager()) == RHChain.POOL_MANAGER, "DeployRouter: poolManager mismatch");
        require(router.weth() == RHChain.WETH, "DeployRouter: weth mismatch");
        require(router.feeDial() == address(dial), "DeployRouter: dial mismatch");
        require(router.feeRecipient() == feeRecipient, "DeployRouter: recipient mismatch");
        require(router.upgradeAdmin() == upgradeAdmin, "DeployRouter: upgradeAdmin mismatch");
        require(dial.feeBps() == feeBps, "DeployRouter: feeBps mismatch");
        require(dial.owner() == msg.sender, "DeployRouter: dial owner mismatch");
        require(address(orders.router()) == address(router), "DeployRouter: orders router mismatch");

        // The implementation must not be initializable in its own right.
        require(impl.upgradeAdmin() == address(0), "DeployRouter: bare impl has state");

        console2.log("MoleFeeDial       :", address(dial));
        console2.log("  owner           :", dial.owner());
        console2.log("  feeBps          :", dial.feeBps());
        console2.log("MoleRouter (proxy):", address(router));
        console2.log("  implementation  :", address(impl));
        console2.log("  poolManager     :", address(router.poolManager()));
        console2.log("  weth            :", router.weth());
        console2.log("  feeDial         :", router.feeDial());
        console2.log("  feeRecipient    :", router.feeRecipient());
        console2.log("  upgradeAdmin    :", router.upgradeAdmin());
        console2.log("MoleOrders        :", address(orders));
        console2.log("  router          :", address(orders.router()));
    }
}
