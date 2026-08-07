// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @title CreatePool
/// @notice Creates the first WETH/USDG pool bound to MoleHook, and admits it to the vault.
///
/// THIS IS THE IRREVERSIBLE STEP. A v4 pool's hook is part of its PoolId, so this pool is married to this
/// hook forever. Redeploying the contracts was cheap up to now precisely because no pool existed; after
/// this, changing the hook means a new pool and a migration every user has to perform themselves.
///
/// NOT "ETH/USDC". There is no canonical USDC on this chain — both explorer entries named "USD Coin" are
/// 18-decimal impostors. The verified stable leg is USDG (Paxos) at SIX decimals, and the 18-vs-6 decimal
/// pair is exactly the shape that used to make `consult()` panic on an int56 overflow at large |tick|.
/// This pool opens at tick ~-201,118, which is that region, so it is also a live test of that fix.
contract CreatePool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        require(block.chainid == RHChain.CHAIN_ID_MAINNET, "CreatePool: wrong chain");

        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        MoleHook hook = MoleHook(vm.envAddress("MOLE_HOOK"));
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));

        // WETH (18) sorts below USDG (6), so WETH is currency0 and the price is USDG-per-WETH in raw units.
        require(RHChain.WETH < RHChain.USDG, "CreatePool: currency ordering assumption broken");

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(RHChain.WETH),
            currency1: Currency.wrap(RHChain.USDG),
            // MUST be the dynamic-fee flag. A static fee makes the entire fee engine dead code, and
            // beforeInitialize refuses it rather than letting that ship silently.
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        // sqrt(1845e6 / 1e18) * 2**96, i.e. ETH at ~$1,845.
        uint160 sqrtPriceX96 = uint160(vm.envOr("MOLE_INIT_SQRT_PRICE", uint256(3403123962154247711138459)));

        vm.startBroadcast();

        // beforeInitialize checks that the CALLER is poolCreator, so this must come from that key directly.
        int24 tick = pm.initialize(key, sqrtPriceX96);

        // Admission is separate and fail-closed: the vault only accepts a pool whose hook IS its pin.
        vault.whitelistPool(key);

        vm.stopBroadcast();

        PoolId id = key.toId();
        (uint160 sp, int24 t,, uint24 lpFee) = pm.getSlot0(id);
        (,,,,, bool oracleReady) = hook.poolStates(id);

        console2.log("pool id           :", vm.toString(PoolId.unwrap(id)));
        console2.log("currency0 (WETH)  :", RHChain.WETH);
        console2.log("currency1 (USDG)  :", RHChain.USDG);
        console2.log("tick at birth     :", tick);
        console2.log("slot0 tick        :", t);
        console2.log("slot0 sqrtPriceX96:", sp);
        console2.log("slot0 lpFee       :", lpFee);
        console2.log("oracle seeded     :", oracleReady);
        console2.log("admitted to vault :", vault.isWhitelisted(id));
    }
}
