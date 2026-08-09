// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {RHChain} from "../src/config/RHChain.sol";

/// @title SeedMolePool
/// @notice Two-sided first deposit into a freshly-created (empty) MoleHook pool via the vault's `open()`.
///         An empty pool cannot be zapped (zapOpen's swap leg has nothing to swap against), so the first
///         liquidity must arrive two-sided; every later depositor can use the normal single-token zap.
///
/// Env:
///   MOLE_VAULT                      — MolePositions proxy
///   MOLE_HOOK                       — MoleHook proxy (pool key pin)
///   MOLE_POOL_TOKEN_A/B             — the pool's currencies (any order; sorted here)
///   MOLE_POOL_TICK_SPACING          — must match the created pool's spacing
///   MOLE_SEED_AMOUNT0/1             — raw-unit budgets for currency0/currency1 (sorted order)
///   MOLE_SEED_HALF_WIDTH            — optional half range width in ticks (default 1000)
contract SeedMolePool is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        require(block.chainid == RHChain.CHAIN_ID_MAINNET, "SeedMolePool: wrong chain");

        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));

        address a = vm.envAddress("MOLE_POOL_TOKEN_A");
        address b = vm.envAddress("MOLE_POOL_TOKEN_B");
        (address c0, address c1) = uint160(a) < uint160(b) ? (a, b) : (b, a);
        int24 spacing = int24(int256(vm.envOr("MOLE_POOL_TICK_SPACING", uint256(60))));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(vm.envAddress("MOLE_HOOK"))
        });
        PoolId id = key.toId();

        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(id);
        require(sqrtP != 0, "SeedMolePool: pool not initialised");

        // Range centred on spot, snapped to spacing, width inside the vault's [minRangeWidth, maxRangeWidth].
        int24 half = int24(int256(vm.envOr("MOLE_SEED_HALF_WIDTH", uint256(1000))));
        int24 center = (tick / spacing) * spacing;
        int24 lower = center - (half / spacing) * spacing;
        int24 upper = center + (half / spacing) * spacing;

        uint256 amt0 = vm.envUint("MOLE_SEED_AMOUNT0");
        uint256 amt1 = vm.envUint("MOLE_SEED_AMOUNT1");

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), amt0, amt1
        );
        require(liq > 0, "SeedMolePool: computed zero liquidity");

        vm.startBroadcast();
        // Exact-allowance approvals; open() pulls at most amountXMax.
        IERC20Minimal(c0).approve(address(vault), amt0);
        IERC20Minimal(c1).approve(address(vault), amt1);
        uint256 posId = vault.open(key, lower, upper, liq, amt0, amt1, block.timestamp + 1200);
        vm.stopBroadcast();

        (, int24 tAfter,,) = pm.getSlot0(id);
        console2.log("position id       :", posId);
        console2.log("tickLower         :", int256(lower));
        console2.log("tickUpper         :", int256(upper));
        console2.log("liquidity minted  :", uint256(liq));
        console2.log("pool liquidity now:", uint256(pm.getLiquidity(id)));
        console2.log("tick after        :", tAfter);
    }
}
