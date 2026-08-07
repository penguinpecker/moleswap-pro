// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {HookMiner} from "v4-periphery/../test/shared/HookMiner.sol";

import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {HookPermissions} from "../src/config/HookPermissions.sol";
import {RHChain} from "../src/config/RHChain.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DeployConfig} from "../src/config/DeployConfig.sol";

/// @title Deploy
/// @notice Deploys MoleHook at a mined address and MolePositions pinned to it.
///
/// ORDER IS FORCED AND IRREVERSIBLE. A hook's permissions are the low 14 bits of its address, so MoleHook
/// must be CREATE2-deployed to a mined salt; and `MolePositions.moleHook` is IMMUTABLE, so the hook must
/// exist before the custody core is deployed. There is no upgrade path from one to the other: pointing an
/// existing MolePositions at a new hook means deploying MolePositions again.
///
/// STAGE ON TESTNET FIRST. Uniswap v4 sits at identical addresses on RH 46630 and 4663, and every pool is
/// permanently bound to its hook, so a mainnet pool created with a hook you later regret is a permanent
/// liability. This script is written to run unchanged against either chain.
///
///   forge script script/Deploy.s.sol --rpc-url rh_testnet --broadcast
///   forge script script/Deploy.s.sol --rpc-url rh_mainnet --broadcast
///
/// PARAMETERS ARE READ FROM THE ENVIRONMENT so that a deployment states its policy explicitly rather than
/// inheriting whatever a source file happened to contain. Every one of them is immutable once deployed.
contract Deploy is Script {
    using LPFeeLibrary for uint24;

    /// @dev Reads the env var at its FULL uint256 width and refuses anything the destination type would
    ///      silently truncate. Truncation here most often lands on 0, which means "bound disabled".
    function _requireFits(string memory key, uint256 dflt, uint256 max) internal view {
        require(vm.envOr(key, dflt) <= max, string.concat("Deploy: ", key, " does not fit its type"));
    }

    function run() external {
        // --- Chain sanity. Refuse to run anywhere the address book has not been verified.
        require(
            RHChain.isSupportedChain(),
            "Deploy: unverified chain - the RHChain address book only covers RH 4663 / 46630"
        );

        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        address deployer = msg.sender;

        // --- Hook policy.
        uint24 lpFee = uint24(vm.envOr("MOLE_LP_FEE_PIPS", uint256(DeployConfig.DEFAULT_LP_FEE_PIPS))); // 0.30%
        uint32 obsInterval = uint32(vm.envOr("MOLE_OBS_INTERVAL", uint256(DeployConfig.DEFAULT_OBS_INTERVAL)));
        // DEFAULT CHANGED true -> false. Restricting liquidity to the vault does NOT prevent JIT (the hook
        // is handed the vault's address, never the depositor's), and it actively creates the harm: with the
        // vault as sole LP the pool has ZERO-liquidity regions, which is what makes spot — and therefore
        // the oracle — walkable for almost nothing. Third-party depth is a security asset here.
        bool restricted = vm.envOr("MOLE_RESTRICTED_LIQUIDITY", DeployConfig.DEFAULT_RESTRICTED_LIQUIDITY);
        uint24 hookFee = uint24(vm.envOr("MOLE_HOOK_FEE_PIPS", uint256(DeployConfig.DEFAULT_HOOK_FEE_PIPS)));
        address feeRecipient = vm.envOr("MOLE_FEE_RECIPIENT", deployer);
        // THE ROOT KEY. Whoever holds this can replace either implementation, including `withdraw`.
        // Defaults to the deployer; point it at a multisig or a timelock for anything real, or at
        // address(0) after deployment to make both contracts permanently immutable again.
        address upgradeAdmin = vm.envOr("MOLE_UPGRADE_ADMIN", deployer);

        // --- Keeper policy. These are the bounds a compromised keeper cannot exceed.
        address keeper = vm.envOr("MOLE_KEEPER", deployer);
        uint32 minRebalanceInterval = uint32(vm.envOr("MOLE_MIN_REBALANCE_INTERVAL", uint256(DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL)));
        int24 minRangeWidth = int24(int256(vm.envOr("MOLE_MIN_RANGE_WIDTH", uint256(uint24(DeployConfig.DEFAULT_MIN_RANGE_WIDTH)))));
        int24 maxRangeWidth = int24(int256(vm.envOr("MOLE_MAX_RANGE_WIDTH", uint256(uint24(DeployConfig.DEFAULT_MAX_RANGE_WIDTH)))));
        int24 maxTwapDev = int24(int256(vm.envOr("MOLE_MAX_TWAP_DEVIATION_TICKS", uint256(uint24(DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS)))));
        uint32 twapWindow = uint32(vm.envOr("MOLE_TWAP_WINDOW", uint256(DeployConfig.DEFAULT_TWAP_WINDOW))); // 30 min
        // 300 L1 blocks is ~1 hour of ETHEREUM time. The default used to be 5 (~60s), which made the
        // dwell decorative: the cadence check is on block.timestamp, a clock the SEQUENCER WRITES, so
        // under a timestamp-manipulation attack the cadence can be satisfied instantly and the dwell is
        // the only bound left standing. A 60-second backstop against a 1-day intended cadence is not a
        // backstop. This is the floor an ordering-privileged party genuinely cannot move.
        uint64 minDwellL1 = uint64(vm.envOr("MOLE_MIN_DWELL_L1_BLOCKS", uint256(DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS)));
        uint16 maxRebalPerL1 = uint16(vm.envOr("MOLE_MAX_REBALANCES_PER_L1_BLOCK", uint256(DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK)));
        // 10_000 = disabled. Left OFF by default deliberately: after a large move ANY recentre produces a
        // large residual, so a tight cap would refuse the keeper in exactly the case it is most needed.
        // Set it once monitoring shows what residuals this pool actually produces (see RebalanceResidualPaid).
        uint16 maxEjectionBps = uint16(vm.envOr("MOLE_MAX_EJECTION_BPS", uint256(DeployConfig.DEFAULT_MAX_EJECTION_BPS)));
        // The price-independent bound. Default 600 ticks per rebalance: at the 1-day cadence a keeper
        // needs months to walk a position anywhere meaningful, and the owner can exit at any point.
        int24 maxRecenterTicks = int24(int256(vm.envOr("MOLE_MAX_RECENTER_TICKS", uint256(uint24(DeployConfig.DEFAULT_MAX_RECENTER_TICKS)))));
        // The protocol's share of REALIZED trading fees. 1000 = 10%, the market median. Charged on earned
        // fees only; deposits and withdrawals of principal are always free.
        uint16 performanceFeeBps = uint16(vm.envOr("MOLE_PERFORMANCE_FEE_BPS", uint256(DeployConfig.DEFAULT_PERFORMANCE_FEE_BPS)));

        // EVERY VALUE ABOVE IS NARROWED FROM uint256, so an out-of-range env var would silently TRUNCATE
        // — and for these bounds the most likely truncation result is 0, which means DISABLED. A typo that
        // turns a safety limit off without a word is exactly the failure this project keeps finding, so
        // each is range-checked against the width it will be stored in BEFORE it is narrowed.
        _requireFits("MOLE_LP_FEE_PIPS", DeployConfig.DEFAULT_LP_FEE_PIPS, type(uint24).max);
        _requireFits("MOLE_HOOK_FEE_PIPS", DeployConfig.DEFAULT_HOOK_FEE_PIPS, type(uint24).max);
        _requireFits("MOLE_OBS_INTERVAL", DeployConfig.DEFAULT_OBS_INTERVAL, type(uint32).max);
        _requireFits("MOLE_MIN_REBALANCE_INTERVAL", DeployConfig.DEFAULT_MIN_REBALANCE_INTERVAL, type(uint32).max);
        _requireFits("MOLE_TWAP_WINDOW", DeployConfig.DEFAULT_TWAP_WINDOW, type(uint32).max);
        _requireFits("MOLE_MIN_RANGE_WIDTH", uint24(DeployConfig.DEFAULT_MIN_RANGE_WIDTH), uint256(uint24(type(int24).max)));
        _requireFits("MOLE_MAX_RANGE_WIDTH", uint24(DeployConfig.DEFAULT_MAX_RANGE_WIDTH), uint256(uint24(type(int24).max)));
        _requireFits("MOLE_MAX_TWAP_DEVIATION_TICKS", uint24(DeployConfig.DEFAULT_MAX_TWAP_DEVIATION_TICKS), uint256(uint24(type(int24).max)));
        _requireFits("MOLE_MIN_DWELL_L1_BLOCKS", DeployConfig.DEFAULT_MIN_DWELL_L1_BLOCKS, type(uint64).max);
        _requireFits("MOLE_MAX_REBALANCES_PER_L1_BLOCK", DeployConfig.DEFAULT_MAX_REBALANCES_PER_L1_BLOCK, type(uint16).max);
        _requireFits("MOLE_MAX_EJECTION_BPS", DeployConfig.DEFAULT_MAX_EJECTION_BPS, DeployConfig.DEFAULT_MAX_EJECTION_BPS);
        _requireFits("MOLE_MAX_RECENTER_TICKS", uint24(DeployConfig.DEFAULT_MAX_RECENTER_TICKS), uint256(uint24(type(int24).max)));
        _requireFits("MOLE_PERFORMANCE_FEE_BPS", DeployConfig.DEFAULT_PERFORMANCE_FEE_BPS, DeployConfig.MAX_PERFORMANCE_FEE_BPS);

        // EVERY OTHER RULE LIVES IN DeployConfig, which the tests call directly. There is deliberately no
        // second copy of these checks anywhere: the previous hand-copy in the test suite drifted twice.
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
            minDwellL1Blocks: minDwellL1,
            maxRebalancesPerL1Block: maxRebalPerL1,
            maxEjectionBps: maxEjectionBps,
            maxRecenterTicks: maxRecenterTicks,
            performanceFeeBps: performanceFeeBps
        });
        DeployConfig.validate(cfg);

        // Disabling a user-protecting bound is legitimate but must be said out loud.
        require(
            DeployConfig.allUserBoundsEnabled(cfg) || vm.envOr("MOLE_ACK_UNGUARDED", false),
            "Deploy: a user-protecting bound is disabled - set MOLE_ACK_UNGUARDED=true to mean it"
        );

        vm.startBroadcast();

        // --- 1. MoleHook: implementation first, then MINE THE PROXY.
        //
        // THE BITS GO ON THE PROXY, and this is the whole reason the mining step moved. The PoolManager
        // reads a hook's permissions by bitwise AND on the address it calls — which is the proxy, always.
        // The implementation's address is never seen by anything and does not need to be mined at all.
        // Mine the wrong one and the pool silently never calls the callbacks this product depends on.
        //
        // The implementation address is a constructor argument to the proxy, so it must exist BEFORE the
        // salt search: the search is over proxy creation code that already embeds it.
        MoleHook hookImpl = new MoleHook();
        bytes memory hookInit = abi.encodeCall(
            MoleHook.initialize,
            (pm, deployer, lpFee, obsInterval, restricted, hookFee, feeRecipient, upgradeAdmin)
        );
        bytes memory proxyArgs = abi.encode(address(hookImpl), hookInit);
        (address hookAddr, bytes32 salt) = HookMiner.find(
            RHChain.CREATE2_DEPLOYER, HookPermissions.REQUIRED_FLAGS, type(ERC1967Proxy).creationCode, proxyArgs
        );
        MoleHook hook = MoleHook(address(new ERC1967Proxy{salt: salt}(address(hookImpl), hookInit)));
        require(address(hook) == hookAddr, "Deploy: mined address mismatch");

        // Belt and braces on the one-way door. `initialize` already asserts this — and under a proxy it
        // asserts it about the PROXY, since it runs by delegatecall — but a deployment is permanent and
        // the check costs nothing here.
        require(HookPermissions.isValid(address(hook)), "Deploy: hook bitmap is not 0x38C4");
        require(HookPermissions.withdrawalIsUnblockable(address(hook)), "Deploy: exits would be blockable");
        require(HookPermissions.depositIsUntaxable(address(hook)), "Deploy: deposits would be taxable");

        // --- 2. The custody core, also behind a proxy, permanently pinned to that hook.
        //
        // Note what "permanently" now means: the PIN is permanent, but the code that honours it is not.
        // Whoever holds `upgradeAdmin` can replace this implementation, including `withdraw`. That is a
        // deliberate trade, made explicitly — see the header of MolePositions.
        MolePositions vaultImpl = new MolePositions();
        MolePositions positions = MolePositions(address(new ERC1967Proxy(
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
                                minDwellL1Blocks: minDwellL1,
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

        // --- 3. The vault must be allowed to provide liquidity when the hook is in restricted mode,
        //        otherwise every open() reverts and the deployment is inert.
        if (restricted) {
            hook.setLiquidityAllowed(address(positions), true);
        }

        vm.stopBroadcast();

        console2.log("chain id                :", block.chainid);
        console2.log("MoleHook                :", address(hook));
        console2.log("  salt                  :", vm.toString(salt));
        console2.log("  bitmap (low 14 bits)  :", uint160(address(hook)) & HookPermissions.ALL_HOOK_MASK);
        console2.log("MolePositions           :", address(positions));
        console2.log("  keeper                :", keeper);
        console2.log("  moleHook pin          :", positions.moleHook());
        console2.log("  performance fee bps   :", positions.performanceFeeBps());
        console2.log("  fee recipient         :", positions.feeRecipient());
        console2.log("  upgradeAdmin (ROOT)   :", positions.upgradeAdmin());
        console2.log("  hook impl             :", address(hookImpl));
        console2.log("  vault impl            :", address(vaultImpl));
        console2.log("");
        console2.log("NEXT, and none of it is automatic:");
        console2.log(" 1. Create the pool with fee == LPFeeLibrary.DYNAMIC_FEE_FLAG (0x800000).");
        console2.log("    A static fee makes the whole fee engine silently dead code; beforeInitialize refuses it.");
        console2.log(" 2. positions.whitelistPool(key) for that pool.");
        console2.log(" 3. Seed liquidity and let the oracle warm past MOLE_TWAP_WINDOW before enabling the keeper -");
        console2.log("    rebalance() fails CLOSED until the window is covered.");
    }
}
