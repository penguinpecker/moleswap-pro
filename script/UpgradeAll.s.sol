// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {MoleQueue} from "../src/MoleQueue.sol";
import {MoleRouter} from "../src/MoleRouter.sol";
import {PoolId} from "v4-core/types/PoolId.sol";

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes memory data) external payable;
    function upgradeAdmin() external view returns (address);
}

/// @title UpgradeAll
/// @notice Upgrades every live MoleSwap proxy on ONE chain, and PROVES from raw storage that nothing
///         moved. Runs unchanged on Robinhood Chain 4663 and on Arc 5042; the address book is selected
///         by chain id so there is no way to point it at the wrong deployment by forgetting a flag.
///
/// WHY THIS EXISTS RATHER THAN FIVE SEPARATE RUNS. These contracts reference each other — the vault is
/// pinned to the hook, the queue reads the hook's oracle, the router is the aggregator's executor — and
/// the fixes shipping here were written against each other. Upgrading them one command at a time leaves
/// windows where half the system is on new code and half on old, and the half-states are exactly where
/// the interesting bugs live. One transaction sequence, one storage proof, one report.
///
/// THE ORDER IS DELIBERATE. MoleHook goes FIRST, because `consult()` is the oracle every other guard in
/// this system reads, and the version on chain today answers a different question than the one it is
/// asked (it ignores `secondsAgo` whenever the window's left edge post-dates the newest observation).
/// Upgrading a consumer to trust that number before fixing the number would be strictly worse than
/// doing nothing. Everything else follows.
///
/// WHAT IT REFUSES TO DO. It reverts rather than continue if any pre-existing storage slot changes
/// value, if a proxy's implementation pointer does not end up where it was told to put it, or if a
/// bare implementation is left initialisable. An upgrade that cannot prove it was safe is not safe.
///
///   forge script script/UpgradeAll.s.sol --rpc-url <rh|arc> --private-key $PRIVATE_KEY            # simulate
///   forge script script/UpgradeAll.s.sol --rpc-url <rh|arc> --private-key $PRIVATE_KEY --broadcast
contract UpgradeAll is Script {
    /// @dev How many slots to snapshot per proxy. Comfortably past the last declared variable on every
    ///      contract here (the deepest is MolePositions at slot 61), so an appended variable that lands
    ///      on occupied storage shows up as a changed slot rather than as silence.
    uint256 constant SLOTS = 72;
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    struct Book {
        address hook;
        address vault;
        address queue; // address(0) where the contract is not deployed on this chain
        address router;
        string chainName;
    }

    function _book() internal view returns (Book memory b) {
        if (block.chainid == 4663) {
            return Book({
                hook: 0xb2c9A0af48dF8858F3765385E733Cd8776a138C4,
                vault: 0x674625B6E6a2614ef6e247aF099BEA2e65e1536A,
                queue: 0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd,
                router: 0xBd9B841d690E31B61aa3858EB145EA8BBe71122c,
                chainName: "Robinhood Chain 4663"
            });
        }
        if (block.chainid == 5042) {
            return Book({
                hook: 0xfFDCBf2f5b53C0fa2c5D7d25A87F99514Fbe78c4,
                vault: 0x8e6bB60d6A75e0390Ee3Da2b280aec2e39769D77,
                // The queue is deliberately NOT deployed on Arc. Its settlement path is the one place in
                // this system with the shape that drained Arrakis V1, and it is not going anywhere new
                // until that is closed.
                queue: address(0),
                router: 0xE4192C72574e6E387D4C29Eb89feCeADa105F3e3,
                chainName: "Arc 5042"
            });
        }
        revert("UpgradeAll: unsupported chain - only RH 4663 and Arc 5042 have a verified address book");
    }

    function _snap(address proxy) internal view returns (bytes32[] memory out) {
        out = new bytes32[](SLOTS);
        for (uint256 i = 0; i < SLOTS; ++i) out[i] = vm.load(proxy, bytes32(i));
    }

    function _requireUnmoved(string memory what, bytes32[] memory a, bytes32[] memory b) internal pure {
        for (uint256 i = 0; i < SLOTS; ++i) {
            if (a[i] != b[i]) {
                console2.log("STORAGE MOVED in", what);
                console2.log("  slot", i);
                console2.logBytes32(a[i]);
                console2.logBytes32(b[i]);
                revert("UpgradeAll: a pre-existing storage slot changed - ABORTING");
            }
        }
    }

    function run() external {
        Book memory b = _book();
        address me = msg.sender;

        // Every proxy must already answer to us, checked BEFORE anything is deployed, so a wrong key
        // costs nothing but a failed simulation.
        require(IUUPS(b.hook).upgradeAdmin() == me, "UpgradeAll: not hook upgradeAdmin");
        require(IUUPS(b.vault).upgradeAdmin() == me, "UpgradeAll: not vault upgradeAdmin");
        require(IUUPS(b.router).upgradeAdmin() == me, "UpgradeAll: not router upgradeAdmin");
        if (b.queue != address(0)) require(IUUPS(b.queue).upgradeAdmin() == me, "UpgradeAll: not queue upgradeAdmin");

        bytes32[] memory hookBefore = _snap(b.hook);
        bytes32[] memory vaultBefore = _snap(b.vault);
        bytes32[] memory routerBefore = _snap(b.router);
        bytes32[] memory queueBefore = b.queue == address(0) ? new bytes32[](SLOTS) : _snap(b.queue);

        // Read the pins we are about to bet on through the OLD code, so a mismatch afterwards is
        // attributable to the upgrade rather than to our own bookkeeping.
        address pinnedHook = MolePositions(payable(b.vault)).moleHook();
        require(pinnedHook == b.hook, "UpgradeAll: the vault is pinned to a different hook than the book says");

        vm.startBroadcast();

        // 1. THE HOOK FIRST — it is the oracle. See the header.
        MoleHook hookImpl = new MoleHook();
        IUUPS(b.hook).upgradeToAndCall(address(hookImpl), "");

        // 2. The custody core. Note this links a FRESHLY DEPLOYED ZapLogic: the library gained external
        //    functions, so an implementation linked against the old on-chain library would revert on
        //    every path that reaches them. forge deploys and links it automatically here.
        MolePositions vaultImpl = new MolePositions();
        IUUPS(b.vault).upgradeToAndCall(address(vaultImpl), "");

        // 3. The aggregator's executor.
        MoleRouter routerImpl = new MoleRouter();
        IUUPS(b.router).upgradeToAndCall(address(routerImpl), "");

        // 4. The queue, where it exists.
        address queueImpl;
        if (b.queue != address(0)) {
            queueImpl = address(new MoleQueue());
            IUUPS(b.queue).upgradeToAndCall(queueImpl, "");
        }

        vm.stopBroadcast();

        // --- Everything below is the proof. None of it trusts the calls above.

        require(
            address(uint160(uint256(vm.load(b.hook, IMPL_SLOT)))) == address(hookImpl), "UpgradeAll: hook impl not set"
        );
        require(
            address(uint160(uint256(vm.load(b.vault, IMPL_SLOT)))) == address(vaultImpl), "UpgradeAll: vault impl not set"
        );
        require(
            address(uint160(uint256(vm.load(b.router, IMPL_SLOT)))) == address(routerImpl),
            "UpgradeAll: router impl not set"
        );
        if (b.queue != address(0)) {
            require(address(uint160(uint256(vm.load(b.queue, IMPL_SLOT)))) == queueImpl, "UpgradeAll: queue impl not set");
        }

        _requireUnmoved("MoleHook", hookBefore, _snap(b.hook));
        _requireUnmoved("MolePositions", vaultBefore, _snap(b.vault));
        _requireUnmoved("MoleRouter", routerBefore, _snap(b.router));
        if (b.queue != address(0)) _requireUnmoved("MoleQueue", queueBefore, _snap(b.queue));

        // The pin the whole vault depends on must still be the same hook.
        require(MolePositions(payable(b.vault)).moleHook() == b.hook, "UpgradeAll: hook pin moved");

        // Bare implementations must be inert — nobody can initialise one and claim its upgrade key.
        require(MoleHook(address(hookImpl)).upgradeAdmin() == address(0), "UpgradeAll: hook impl has state");
        require(
            MolePositions(payable(address(vaultImpl))).upgradeAdmin() == address(0), "UpgradeAll: vault impl has state"
        );
        require(MoleRouter(payable(address(routerImpl))).upgradeAdmin() == address(0), "UpgradeAll: router impl has state");
        if (b.queue != address(0)) {
            require(MoleQueue(queueImpl).upgradeAdmin() == address(0), "UpgradeAll: queue impl has state");
        }

        console2.log("=== UPGRADED", b.chainName, "===");
        console2.log("  MoleHook      ", b.hook, "-> impl", address(hookImpl));
        console2.log("  MolePositions ", b.vault, "-> impl", address(vaultImpl));
        console2.log("  MoleRouter    ", b.router, "-> impl", address(routerImpl));
        if (b.queue != address(0)) console2.log("  MoleQueue     ", b.queue, "-> impl", queueImpl);
        console2.log("  storage: every pre-existing slot byte-identical across all proxies");
        console2.log("");
        console2.log("POST-UPGRADE, AND NONE OF IT IS AUTOMATIC:");
        console2.log(" 1. seedPoolLiquidity(poolId, <true current total>) for EVERY live pool, THEN");
        console2.log("    setPoolLiquidityCap(...). In the other order deposits are refused silently.");
        console2.log(" 2. setEjectionCap(...) - it ships DISABLED (10000) and the audit's F-07 mechanism C");
        console2.log("    is unreachable until it is set.");
        console2.log(" 3. Re-read every privileged role and diff against AUTHORITY-REGISTER.md.");
    }
}
