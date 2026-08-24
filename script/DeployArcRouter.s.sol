// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {MoleFeeDial} from "../src/MoleFeeDial.sol";

/// @notice Deploys the aggregator executor to ARC (chain 5042): the fee dial and MoleRouter behind a UUPS
///         proxy. Deliberately does NOT deploy MoleOrders — the DCA/limit product is withdrawn (its fill
///         path has no price bound of its own, see AUDIT-2026-08-23.md F-02), so nothing on Arc should be
///         able to pull a user's tokens on a keeper's schedule.
///
/// WHAT IS DIFFERENT ABOUT ARC, and why the `weth` slot is not a WETH:
///   Arc's native token IS USDC — the same balance seen as 18 decimals natively and 6 decimals through the
///   ERC-20 at 0x3600…0000. There is no wrapped-native token to wrap into, so the router's native path
///   (wrap at the edges, hops always in ERC-20) has nothing to point at. Rather than leave the slot empty —
///   `IWETH(address(0)).deposit{value: x}()` is a call to an empty account, which SUCCEEDS silently on a
///   normal EVM — the slot is pinned to the ERC-20 USDC, a contract with code and no `deposit()`. Every
///   native-sentinel plan therefore REVERTS instead of quietly losing the value: native routing is
///   unavailable on Arc, fail-closed, and ERC-20 routes (which is every route here) are unaffected.
///
/// Env (all required except where noted):
///   ARC_POOL_MANAGER    — Uniswap v4 PoolManager on Arc
///   ARC_NATIVE_WRAPPER  — the address pinned into `weth` (the ERC-20 USDC; see above)
///   MOLE_FEE_BPS        — initial fee in bps (default 69 = 0.69%)
///   MOLE_FEE_RECIPIENT  — treasury receiving the fee (default: the broadcaster)
///   MOLE_UPGRADE_ADMIN  — the router's upgrade key (default: the broadcaster)
contract DeployArcRouter is Script {
    function run() external {
        address poolManager = vm.envAddress("ARC_POOL_MANAGER");
        address nativeWrapper = vm.envAddress("ARC_NATIVE_WRAPPER");
        uint16 feeBps = uint16(vm.envOr("MOLE_FEE_BPS", uint256(69)));
        address feeRecipient = vm.envOr("MOLE_FEE_RECIPIENT", msg.sender);
        address upgradeAdmin = vm.envOr("MOLE_UPGRADE_ADMIN", msg.sender);

        // Deploy-time facts, not documentation: a codeless PoolManager or wrapper is a typo that would only
        // surface on the first swap, and the chain id pins this script to Arc.
        require(block.chainid == 5042, "DeployArcRouter: not Arc");
        require(poolManager.code.length > 0, "DeployArcRouter: poolManager has no code");
        require(nativeWrapper.code.length > 0, "DeployArcRouter: wrapper has no code");

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
                            (IPoolManager(poolManager), nativeWrapper, address(dial), feeRecipient, upgradeAdmin)
                        )
                    )
                )
            )
        );
        vm.stopBroadcast();

        // Read the wiring back THROUGH THE PROXY: that is what proves initialize ran against proxy storage,
        // the one mistake a UUPS deployment actually makes.
        require(address(router.poolManager()) == poolManager, "DeployArcRouter: poolManager mismatch");
        require(router.weth() == nativeWrapper, "DeployArcRouter: wrapper mismatch");
        require(router.feeDial() == address(dial), "DeployArcRouter: dial mismatch");
        require(router.feeRecipient() == feeRecipient, "DeployArcRouter: recipient mismatch");
        require(router.upgradeAdmin() == upgradeAdmin, "DeployArcRouter: upgradeAdmin mismatch");
        require(dial.feeBps() == feeBps, "DeployArcRouter: feeBps mismatch");
        require(dial.owner() == msg.sender, "DeployArcRouter: dial owner mismatch");
        require(impl.upgradeAdmin() == address(0), "DeployArcRouter: bare impl has state");

        console2.log("chain             :", block.chainid);
        console2.log("MoleFeeDial       :", address(dial));
        console2.log("MoleRouter (proxy):", address(router));
        console2.log("  implementation  :", address(impl));
        console2.log("  poolManager     :", address(router.poolManager()));
        console2.log("  weth slot       :", router.weth());
        console2.log("  feeRecipient    :", router.feeRecipient());
        console2.log("  upgradeAdmin    :", router.upgradeAdmin());
        console2.log("  feeBps          :", dial.feeBps());
    }
}
