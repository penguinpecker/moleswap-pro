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
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {ZapLogic} from "../src/libraries/ZapLogic.sol";
import {RHChain} from "../src/config/RHChain.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Exercises the features added on 2026-08-06 against the LIVE vault with real money: the zap,
///         the owner's keeper veto, and the position size band.
///
/// The zap is the one that matters — it is the only path where the vault swaps a user's tokens, and it
/// carries the fix for the Z-A finding (`amountOutMin` binding the swap itself, because `minLiquidity`
/// alone is not a bound when the post-swap price leaves the range on one side).
contract LiveNewFeatures is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function _sqrt(IPoolManager pm, PoolKey memory k) internal view returns (uint160 sp) {
        (sp,,,) = StateLibrary.getSlot0(pm, k.toId());
    }

    function run() external {
        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));
        IERC20 weth = IERC20(RHChain.WETH);
        IERC20 usdg = IERC20(RHChain.USDG);
        address me = msg.sender;

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(RHChain.WETH),
            currency1: Currency.wrap(RHChain.USDG),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(vm.envAddress("MOLE_HOOK"))
        });
        (, int24 spot,,) = pm.getSlot0(key.toId());

        // Straddle spot so the zap has to use both legs.
        int24 lower = ((spot / 60) - 5) * 60;
        int24 upper = ((spot / 60) + 5) * 60;

        uint256 amountIn = vm.envOr("ZAP_IN_WEI", uint256(0.0008 ether));
        uint256 swapAmount = amountIn / 2;
        // A REAL floor, but sized for the pool that actually exists rather than for an ideal one. The
        // first attempt at this script used 1.2 USDG and was REFUSED with SwapOutputBelowMinimum —
        // correctly, because both earlier positions had been withdrawn and the pool was empty, so the
        // swap would have executed at a ruinous price. That refusal is the Z-A guard doing its job on
        // its first real use. The pool is seeded below before the zap runs, and this floor is set to
        // what a ~$0.75 swap can clear in the resulting (still thin) book.
        uint256 amountOutMin = vm.envOr("ZAP_OUT_MIN", uint256(200_000));

        vm.startBroadcast();

        weth.approve(address(vault), type(uint256).max);
        usdg.approve(address(vault), type(uint256).max);

        // --- SEED. The zap swaps through this pool, so it needs depth to swap against. A normal
        //     two-sided open() supplies it, and doubles as a live exercise of the ordinary deposit path.
        {
            uint128 seedLiq = LiquidityAmounts.getLiquidityForAmounts(
                _sqrt(pm, key),
                TickMath.getSqrtPriceAtTick(lower),
                TickMath.getSqrtPriceAtTick(upper),
                weth.balanceOf(me) / 2,
                usdg.balanceOf(me) / 2
            );
            uint256 seedId = vault.open(
                key, lower, upper, seedLiq, weth.balanceOf(me), usdg.balanceOf(me), block.timestamp + 900
            );
            console2.log("--- SEED (ordinary two-sided open) ---");
            console2.log("seed position  :", seedId);
            console2.log("seed liquidity :", uint256(vault.getPosition(seedId).liquidity));
        }

        uint256 w0 = weth.balanceOf(me);
        uint256 u0 = usdg.balanceOf(me);

        uint256 id = vault.zapOpen(
            ZapLogic.ZapParams({
                key: key,
                tickLower: lower,
                tickUpper: upper,
                zeroForOne: true,
                amountIn: amountIn,
                swapAmount: swapAmount,
                minLiquidity: 1,
                amountOutMin: amountOutMin
            }),
            block.timestamp + 900
        );

        MolePositions.Position memory p = vault.getPosition(id);

        console2.log("--- ZAP (one token in, two-sided position out) ---");
        console2.log("spot tick      :", spot);
        console2.log("range lower    :", lower);
        console2.log("range upper    :", upper);
        console2.log("position id    :", id);
        console2.log("owner          :", p.owner);
        console2.log("liquidity      :", uint256(p.liquidity));
        console2.log("WETH spent     :", w0 - weth.balanceOf(me));
        console2.log("USDG delta     :", int256(usdg.balanceOf(me)) - int256(u0));

        // --- the owner's veto, on a real position
        vault.setKeeperRevoked(id, true);
        console2.log("--- KEEPER VETO ---");
        console2.log("keeperRevoked  :", vault.keeperRevoked(id));

        // --- the size band, set then RESET so production config is left as it was found
        vault.setPositionSizeBand(1e6, 1e24);
        console2.log("--- SIZE BAND ---");
        console2.log("min set to     :", uint256(vault.minPositionLiquidity()));
        console2.log("max set to     :", uint256(vault.maxPositionLiquidity()));
        vault.setPositionSizeBand(0, 0);
        console2.log("reset to       :", uint256(vault.minPositionLiquidity()), uint256(vault.maxPositionLiquidity()));

        vm.stopBroadcast();

        console2.log("--- CUSTODY ---");
        console2.log("vault WETH     :", weth.balanceOf(address(vault)));
        console2.log("vault USDG     :", usdg.balanceOf(address(vault)));
        console2.log("");
        console2.log("Position", id, "is LEFT OPEN so the 1-day rebalance cadence can be tested tomorrow.");
    }
}
