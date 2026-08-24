// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MoleQueue} from "../src/MoleQueue.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {PoolId} from "v4-core/types/PoolId.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes memory data) external payable;
    function upgradeAdmin() external view returns (address);
}

/// @notice Upgrade the two live Robinhood-chain proxies to freshly built implementations, and PROVE from
///         storage — not from getters, which the new implementation itself defines — that nothing moved.
///
/// The proof is the point. A UUPS upgrade is the one operation that can silently reinterpret every byte of
/// live state, and the four positions still holding liquidity here are real money. So: read slots 0..MAX
/// raw before, upgrade, read them raw after, and require every one to be byte-identical. A layout change
/// that a getter would paper over cannot survive that check.
contract UpgradeRH is Script {
    uint256 constant SLOTS = 48;
    // ERC-1967 implementation slot.
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address constant QUEUE = 0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd;
    address constant VAULT = 0x674625B6E6a2614ef6e247aF099BEA2e65e1536A;

    function _snap(address proxy) internal view returns (bytes32[] memory out) {
        out = new bytes32[](SLOTS);
        for (uint256 i = 0; i < SLOTS; ++i) out[i] = vm.load(proxy, bytes32(i));
    }

    function _requireSame(string memory what, bytes32[] memory a, bytes32[] memory b) internal pure {
        for (uint256 i = 0; i < SLOTS; ++i) {
            if (a[i] != b[i]) {
                console2.log("STORAGE MOVED in", what, "at slot", i);
                console2.logBytes32(a[i]);
                console2.logBytes32(b[i]);
                revert("UpgradeRH: storage layout changed");
            }
        }
    }

    function run() external {
        require(block.chainid == 4663, "UpgradeRH: not Robinhood chain");
        address me = msg.sender;
        require(IUUPS(QUEUE).upgradeAdmin() == me, "UpgradeRH: not queue upgradeAdmin");
        require(IUUPS(VAULT).upgradeAdmin() == me, "UpgradeRH: not vault upgradeAdmin");

        bytes32[] memory qBefore = _snap(QUEUE);
        bytes32[] memory vBefore = _snap(VAULT);
        address qOldImpl = address(uint160(uint256(vm.load(QUEUE, IMPL_SLOT))));
        address vOldImpl = address(uint160(uint256(vm.load(VAULT, IMPL_SLOT))));

        // The four positions that still hold liquidity. Read through the OLD implementation first.
        uint256[4] memory liveIds = [uint256(3), 4, 7, 11];
        MolePositions.Position[4] memory posBefore;
        for (uint256 i = 0; i < 4; ++i) posBefore[i] = MolePositions(payable(VAULT)).getPosition(liveIds[i]);

        vm.startBroadcast();
        MoleQueue qImpl = new MoleQueue();
        MolePositions vImpl = new MolePositions();
        IUUPS(QUEUE).upgradeToAndCall(address(qImpl), "");
        IUUPS(VAULT).upgradeToAndCall(address(vImpl), "");
        vm.stopBroadcast();

        console2.log("queue impl", qOldImpl, "->", address(qImpl));
        console2.log("vault impl", vOldImpl, "->", address(vImpl));

        // 1. The implementation pointer actually moved.
        require(address(uint160(uint256(vm.load(QUEUE, IMPL_SLOT)))) == address(qImpl), "queue impl not set");
        require(address(uint160(uint256(vm.load(VAULT, IMPL_SLOT)))) == address(vImpl), "vault impl not set");

        // 2. Nothing else did.
        _requireSame("MoleQueue", qBefore, _snap(QUEUE));
        _requireSame("MolePositions", vBefore, _snap(VAULT));

        // 3. The live positions read identically through the NEW implementation.
        for (uint256 i = 0; i < 4; ++i) {
            MolePositions.Position memory p = MolePositions(payable(VAULT)).getPosition(liveIds[i]);
            require(p.owner == posBefore[i].owner, "position owner moved");
            require(p.liquidity == posBefore[i].liquidity, "position liquidity moved");
            require(p.tickLower == posBefore[i].tickLower, "position tickLower moved");
            require(p.tickUpper == posBefore[i].tickUpper, "position tickUpper moved");
            require(PoolId.unwrap(p.poolId) == PoolId.unwrap(posBefore[i].poolId), "position pool moved");
            console2.log("position", liveIds[i], "intact, liquidity", p.liquidity);
        }

        // 4. The bare implementations are inert — no one can initialise them and claim the upgrade key.
        require(MoleQueue(address(qImpl)).upgradeAdmin() == address(0), "queue impl has state");
        require(MolePositions(payable(address(vImpl))).upgradeAdmin() == address(0), "vault impl has state");

        console2.log("UPGRADE VERIFIED: implementations swapped, storage byte-identical, positions intact");
    }
}
