// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @title Upgrade
/// @notice Ships new implementations behind the EXISTING proxies. This is what the proxies were for.
///
/// THE POOL SURVIVES. A v4 pool is bound to its hook ADDRESS forever, and an upgrade changes the code
/// behind an address, never the address — so the live WETH/USDG pool, every position in it and every
/// PoolId derived from the hook all carry straight over. Before the proxy migration this same change
/// would have meant a new hook, a new pool and a migration every depositor had to perform by hand.
///
/// WHAT IT CANNOT BREAK, no matter what the new implementation contains: the hook's permission bits are
/// in the proxy's address, so `0x38C4 & 0x0301 == 0` still holds afterwards and withdrawals still cannot
/// be blocked at the pool level. That is asserted below rather than assumed.
contract Upgrade is Script {
    function run() external {
        require(block.chainid == RHChain.CHAIN_ID_MAINNET, "Upgrade: wrong chain");

        MoleHook hook = MoleHook(vm.envAddress("MOLE_HOOK"));
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));

        // Storage that must survive the upgrade untouched. Read BEFORE, asserted AFTER.
        address keeperBefore = vault.keeper();
        address pinBefore = vault.moleHook();
        uint16 feeBefore = vault.performanceFeeBps();
        address recipBefore = vault.feeRecipient();
        uint256 countBefore = vault.positionCount();
        uint24 lpFeeBefore = hook.lpFeePips();

        vm.startBroadcast();

        MoleHook newHookImpl = new MoleHook();
        MolePositions newVaultImpl = new MolePositions();

        // No initializer data: these are re-implementations, not re-initialisations. Passing initData
        // here would try to run `initialize` again on live storage, which the initializer guard refuses
        // anyway — but the right way to express "no migration needed" is to pass nothing.
        hook.upgradeToAndCall(address(newHookImpl), "");
        vault.upgradeToAndCall(address(newVaultImpl), "");

        vm.stopBroadcast();

        require(vault.keeper() == keeperBefore, "Upgrade: keeper moved");
        require(vault.moleHook() == pinBefore, "Upgrade: hook pin moved");
        require(vault.performanceFeeBps() == feeBefore, "Upgrade: fee moved");
        require(vault.feeRecipient() == recipBefore, "Upgrade: fee recipient moved");
        require(vault.positionCount() == countBefore, "Upgrade: position count moved");
        require(hook.lpFeePips() == lpFeeBefore, "Upgrade: lp fee moved");
        require(HookPermissions.isValid(address(hook)), "Upgrade: hook bitmap changed");
        require(HookPermissions.withdrawalIsUnblockable(address(hook)), "Upgrade: exits became blockable");

        console2.log("hook proxy        :", address(hook));
        console2.log("  new impl        :", address(newHookImpl));
        console2.log("vault proxy       :", address(vault));
        console2.log("  new impl        :", address(newVaultImpl));
        console2.log("storage preserved : keeper/pin/fee/recipient/positionCount all unchanged");
        console2.log("positions carried :", countBefore);
    }
}
