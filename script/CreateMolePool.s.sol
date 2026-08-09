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

/// @title CreateMolePool
/// @notice Parameterized sibling of CreatePool.s.sol: mint ANY MoleHook v4 pool and admit it to the vault.
///         CreatePool.s.sol created the first WETH/USDG pool; this one takes the pair, price and spacing
///         from the environment so new pairs can be launched without editing code.
///
/// IRREVERSIBLE: a v4 pool's hook is part of its PoolId — the pool is married to MoleHook forever.
///
/// The broadcasting key MUST be the hook's `poolCreator` (beforeInitialize reverts otherwise), and the
/// fee MUST be the dynamic-fee sentinel (the fee engine is dead code under a static fee, so it reverts).
///
/// Env:
///   MOLE_HOOK, MOLE_VAULT           — deployed proxy addresses
///   MOLE_POOL_TOKEN_A, MOLE_POOL_TOKEN_B — the two currencies (any order; sorted here; address(0)=native)
///   MOLE_INIT_SQRT_PRICE            — uint160 sqrtPriceX96 for currency1-per-currency0 at the sorted order
///   MOLE_POOL_TICK_SPACING          — optional, default 60
contract CreateMolePool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        require(block.chainid == RHChain.CHAIN_ID_MAINNET, "CreateMolePool: wrong chain");

        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        MoleHook hook = MoleHook(vm.envAddress("MOLE_HOOK"));
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));

        address a = vm.envAddress("MOLE_POOL_TOKEN_A");
        address b = vm.envAddress("MOLE_POOL_TOKEN_B");
        require(a != b, "CreateMolePool: tokens must differ");
        // v4 currency ordering: currency0 < currency1 by address (address(0) native sorts lowest).
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);

        int24 tickSpacing = int24(int256(vm.envOr("MOLE_POOL_TICK_SPACING", uint256(60))));
        uint160 sqrtPriceX96 = uint160(vm.envUint("MOLE_INIT_SQRT_PRICE"));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(hook))
        });

        vm.startBroadcast();
        int24 tick = pm.initialize(key, sqrtPriceX96); // beforeInitialize requires caller == poolCreator
        vault.whitelistPool(key); // admits it; requires key.hooks == moleHook
        vm.stopBroadcast();

        PoolId id = key.toId();
        (uint160 sp, int24 t,, uint24 lpFee) = pm.getSlot0(id);
        console2.log("pool id           :", vm.toString(PoolId.unwrap(id)));
        console2.log("currency0         :", c0);
        console2.log("currency1         :", c1);
        console2.log("tick at birth     :", tick);
        console2.log("slot0 tick        :", t);
        console2.log("slot0 sqrtPriceX96:", sp);
        console2.log("slot0 lpFee       :", lpFee);
        console2.log("admitted to vault :", vault.isWhitelisted(id));
    }
}
