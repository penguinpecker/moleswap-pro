// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {HookMiner} from "v4-periphery/../test/shared/HookMiner.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {ArcChain} from "../src/config/ArcChain.sol";
import {DeployConfig} from "../src/config/DeployConfig.sol";

/// @title DeployArcPools
/// @notice Deploys MoleHook (at a mined address) and MolePositions on Arc, chain 5042.
///
/// This is script/Deploy.s.sol's twin, and the differences are the point — a straight copy of the
/// Robinhood deployment onto Arc would be quietly unsafe in one specific way:
///
///   THE DWELL GUARD IS DENOMINATED IN `block.number`, AND `block.number` MEANS SOMETHING ELSE HERE.
///   On Robinhood Chain it is the Ethereum L1 height, ~12s per tick, so the default of 300 is about an
///   hour that a sequencer cannot fast-forward. Arc is Malachite BFT with no L1 beneath it, and the
///   same counter advances every ~0.51 seconds. Carried over unchanged, a 60-minute dwell silently
///   becomes 2.5 minutes. This script therefore defaults the dwell to ArcChain's measured one-hour
///   figure and REFUSES the Robinhood value outright, because inheriting it is the mistake.
///
/// Everything else — the mined hook bitmap, the immutable hook pin, the env-var policy, the range
/// checks that stop a typo from silently disabling a bound — is deliberately identical, so the two
/// chains cannot drift apart in the parts that are supposed to match.
///
///   forge script script/DeployArcPools.s.sol --rpc-url arc --broadcast
contract DeployArcPools is Script {
    function _requireFits(string memory key, uint256 dflt, uint256 max) internal view {
        require(vm.envOr(key, dflt) <= max, string.concat("DeployArcPools: ", key, " does not fit its type"));
    }

    function run() external {
        require(ArcChain.isSupportedChain(), "DeployArcPools: not Arc 5042");

        IPoolManager pm = IPoolManager(ArcChain.POOL_MANAGER);
        address deployer = msg.sender;

        uint24 lpFee = uint24(vm.envOr("MOLE_LP_FEE_PIPS", uint256(DeployConfig.DEFAULT_LP_FEE_PIPS)));
        uint32 obsInterval = uint32(vm.envOr("MOLE_OBS_INTERVAL", uint256(DeployConfig.DEFAULT_OBS_INTERVAL)));
        bool restricted = vm.envOr("MOLE_RESTRICTED_LIQUIDITY", DeployConfig.DEFAULT_RESTRICTED_LIQUIDITY);
        uint24 hookFee = uint24(vm.envOr("MOLE_HOOK_FEE_PIPS", uint256(DeployConfig.DEFAULT_HOOK_FEE_PIPS)));
        address feeRecipient = vm.envOr("MOLE_FEE_RECIPIENT", deployer);
        address upgradeAdmin = vm.envOr("MOLE_UPGRADE_ADMIN", deployer);

        address keeper = vm.envOr("MOLE_KEEPER", deployer);
        uint32 minRebalanceInterval =
            uint32(vm.envOr("MOLE_MIN_REBALANCE_INTERVAL", uint256(DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL)));
        int24 minRangeWidth =
            int24(int256(vm.envOr("MOLE_MIN_RANGE_WIDTH", uint256(uint24(DeployConfig.DEFAULT_MIN_RANGE_WIDTH)))));
        int24 maxRangeWidth =
            int24(int256(vm.envOr("MOLE_MAX_RANGE_WIDTH", uint256(uint24(DeployConfig.DEFAULT_MAX_RANGE_WIDTH)))));
        int24 maxTwapDev = int24(
            int256(vm.envOr("MOLE_MAX_TWAP_DEVIATION_TICKS", uint256(uint24(DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS))))
        );
        uint32 twapWindow = uint32(vm.envOr("MOLE_TWAP_WINDOW", uint256(DeployConfig.DEFAULT_TWAP_WINDOW)));

        // ── the one parameter that must NOT inherit the Robinhood default ──
        uint64 minDwellBlocks =
            uint64(vm.envOr("MOLE_MIN_DWELL_L1_BLOCKS", uint256(ArcChain.MIN_DWELL_BLOCKS_ONE_HOUR)));
        require(
            minDwellBlocks != DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS,
            "DeployArcPools: 300 is the Robinhood L1-paced dwell and means ~2.5 min on Arc - set it deliberately"
        );

        uint16 maxRebalPerL1 =
            uint16(vm.envOr("MOLE_MAX_REBALANCES_PER_L1_BLOCK", uint256(DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK)));
        uint16 maxEjectionBps =
            uint16(vm.envOr("MOLE_MAX_EJECTION_BPS", uint256(DeployConfig.DEFAULT_MAX_EJECTION_BPS)));
        int24 maxRecenterTicks =
            int24(int256(vm.envOr("MOLE_MAX_RECENTER_TICKS", uint256(uint24(DeployConfig.DEFAULT_MAX_RECENTER_TICKS)))));
        uint16 performanceFeeBps =
            uint16(vm.envOr("MOLE_PERFORMANCE_FEE_BPS", uint256(DeployConfig.DEFAULT_PERFORMANCE_FEE_BPS)));

        _requireFits("MOLE_LP_FEE_PIPS", DeployConfig.DEFAULT_LP_FEE_PIPS, type(uint24).max);
        _requireFits("MOLE_HOOK_FEE_PIPS", DeployConfig.DEFAULT_HOOK_FEE_PIPS, type(uint24).max);
        _requireFits("MOLE_OBS_INTERVAL", DeployConfig.DEFAULT_OBS_INTERVAL, type(uint32).max);
        _requireFits("MOLE_MIN_REBALANCE_INTERVAL", DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL, type(uint32).max);
        _requireFits("MOLE_TWAP_WINDOW", DeployConfig.DEFAULT_TWAP_WINDOW, type(uint32).max);
        _requireFits("MOLE_MIN_RANGE_WIDTH", uint24(DeployConfig.DEFAULT_MIN_RANGE_WIDTH), uint256(uint24(type(int24).max)));
        _requireFits("MOLE_MAX_RANGE_WIDTH", uint24(DeployConfig.DEFAULT_MAX_RANGE_WIDTH), uint256(uint24(type(int24).max)));
        _requireFits(
            "MOLE_MAX_TWAP_DEVIATION_TICKS", uint24(DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS), uint256(uint24(type(int24).max))
        );
        _requireFits("MOLE_MIN_DWELL_L1_BLOCKS", ArcChain.MIN_DWELL_BLOCKS_ONE_HOUR, type(uint64).max);
        _requireFits(
            "MOLE_MAX_REBALANCES_PER_L1_BLOCK", DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK, type(uint16).max
        );
        _requireFits("MOLE_MAX_EJECTION_BPS", DeployConfig.DEFAULT_MAX_EJECTION_BPS, DeployConfig.DEFAULT_MAX_EJECTION_BPS);
        _requireFits("MOLE_MAX_RECENTER_TICKS", uint24(DeployConfig.DEFAULT_MAX_RECENTER_TICKS), uint256(uint24(type(int24).max)));
        _requireFits("MOLE_PERFORMANCE_FEE_BPS", DeployConfig.DEFAULT_PERFORMANCE_FEE_BPS, DeployConfig.MAX_PERFORMANCE_FEE_BPS);

        DeployConfig.Params memory cfg = DeployConfig.Params({
            lpFeePips: lpFee,
            obsInterval: obsInterval,
            hookFeePips: hookFee,
            feeRecipient: feeRecipient,
            restrictedLiquidity: restricted,
            minRebalanceInterval: minRebalanceInterval,
            minRangeWidth: minRangeWidth,
            maxRangeWidth: maxRangeWidth,
            maxTwapDeviationTicks: maxTwapDev,
            twapWindow: twapWindow,
            minDwellL1Blocks: minDwellBlocks,
            maxRebalancesPerL1Block: maxRebalPerL1,
            maxEjectionBps: maxEjectionBps,
            maxRecenterTicks: maxRecenterTicks,
            performanceFeeBps: performanceFeeBps
        });
        DeployConfig.validate(cfg);
        require(
            DeployConfig.allUserBoundsEnabled(cfg) || vm.envOr("MOLE_ACK_UNGUARDED", false),
            "DeployArcPools: a user-protecting bound is disabled - set MOLE_ACK_UNGUARDED=true to mean it"
        );

        vm.startBroadcast();

        // 1. The hook. The bits live on the PROXY address, so that is what gets mined.
        MoleHook hookImpl = new MoleHook();
        bytes memory hookInit = abi.encodeCall(
            MoleHook.initialize, (pm, deployer, lpFee, obsInterval, restricted, hookFee, feeRecipient, upgradeAdmin)
        );
        bytes memory proxyArgs = abi.encode(address(hookImpl), hookInit);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            ArcChain.CREATE2_DEPLOYER, HookPermissions.REQUIRED_FLAGS, type(ERC1967Proxy).creationCode, proxyArgs
        );
        MoleHook hook = MoleHook(address(new ERC1967Proxy{salt: salt}(address(hookImpl), hookInit)));
        require(address(hook) == hookAddr, "DeployArcPools: mined address mismatch");
        require(HookPermissions.isValid(address(hook)), "DeployArcPools: hook bitmap is not 0x38C4");
        require(HookPermissions.withdrawalIsUnblockable(address(hook)), "DeployArcPools: exits would be blockable");
        require(HookPermissions.depositIsUntaxable(address(hook)), "DeployArcPools: deposits would be taxable");

        // 2. The custody core, permanently pinned to that hook.
        MolePositions vaultImpl = new MolePositions();
        MolePositions positions = MolePositions(
            address(
                new ERC1967Proxy(
                    address(vaultImpl),
                    abi.encodeCall(
                        MolePositions.initialize,
                        (
                            MolePositions.InitParams({
                                poolManager: pm,
                                keeper: keeper,
                                minRebalanceInterval: minRebalanceInterval,
                                minRangeWidth: minRangeWidth,
                                maxRangeWidth: maxRangeWidth,
                                moleHook: address(hook),
                                maxTwapDeviationTicks: maxTwapDev,
                                twapWindow: twapWindow,
                                minDwellL1Blocks: minDwellBlocks,
                                maxRebalancesPerL1Block: maxRebalPerL1,
                                maxEjectionBps: maxEjectionBps,
                                maxRecenterTicks: maxRecenterTicks,
                                performanceFeeBps: performanceFeeBps,
                                feeRecipient: feeRecipient,
                                upgradeAdmin: upgradeAdmin
                            })
                        )
                    )
                )
            )
        );

        if (restricted) hook.setLiquidityAllowed(address(positions), true);

        vm.stopBroadcast();

        // Read every claim back THROUGH the proxies, so the log is chain state and not intent.
        require(positions.moleHook() == address(hook), "DeployArcPools: hook pin wrong");
        require(positions.upgradeAdmin() == upgradeAdmin, "DeployArcPools: upgradeAdmin wrong");
        require(address(positions.poolManager()) == ArcChain.POOL_MANAGER, "DeployArcPools: poolManager wrong");
        require(MoleHook(address(hookImpl)).upgradeAdmin() == address(0), "DeployArcPools: hook impl has state");
        require(
            MolePositions(payable(address(vaultImpl))).upgradeAdmin() == address(0),
            "DeployArcPools: vault impl has state"
        );

        console2.log("chain id                :", block.chainid);
        console2.log("MoleHook                :", address(hook));
        console2.log("  salt                  :", vm.toString(salt));
        console2.log("  bitmap (low 14 bits)  :", uint160(address(hook)) & HookPermissions.ALL_HOOK_MASK);
        console2.log("MolePositions           :", address(positions));
        console2.log("  moleHook pin          :", positions.moleHook());
        console2.log("  keeper                :", keeper);
        console2.log("  min dwell (blocks)    :", minDwellBlocks);
        console2.log("  upgradeAdmin (ROOT)   :", positions.upgradeAdmin());
        console2.log("  hook impl             :", address(hookImpl));
        console2.log("  vault impl            :", address(vaultImpl));
    }
}
