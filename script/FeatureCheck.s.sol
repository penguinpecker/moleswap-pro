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
import {MoleHook} from "../src/MoleHook.sol";
import {MolePositions} from "../src/MolePositions.sol";
import {MiniSwapper} from "./MiniSwapper.sol";
import {RHChain} from "../src/config/RHChain.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Exercises the fee-bearing path on the LIVE pool: a two-sided position, real swaps through it,
///         and an exit that must pay the protocol its 10% of REALIZED FEES and nothing else.
contract FeatureCheck is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        MoleHook hook = MoleHook(vm.envAddress("MOLE_HOOK"));
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));
        MiniSwapper swapper = MiniSwapper(vm.envAddress("MOLE_SWAPPER"));
        IERC20 weth = IERC20(RHChain.WETH);
        IERC20 usdg = IERC20(RHChain.USDG);
        address me = msg.sender;
        address treasury = vault.feeRecipient();

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(RHChain.WETH),
            currency1: Currency.wrap(RHChain.USDG),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        PoolId id = key.toId();

        (uint160 sp, int24 spot,,) = pm.getSlot0(id);
        // Two-sided: straddle spot so the position holds BOTH tokens and earns on both directions.
        int24 lower = ((spot / 60) - 5) * 60;
        int24 upper = ((spot / 60) + 5) * 60;

        vm.startBroadcast();

        weth.approve(address(vault), type(uint256).max);
        usdg.approve(address(vault), type(uint256).max);
        weth.approve(address(swapper), type(uint256).max);
        usdg.approve(address(swapper), type(uint256).max);

        uint256 w0 = weth.balanceOf(me);
        uint256 u0 = usdg.balanceOf(me);

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sp, TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), w0 / 2, u0 / 2
        );
        uint256 posId = vault.open(key, lower, upper, liq, w0, u0, block.timestamp + 900);

        console2.log("--- OPEN (two-sided) ---");
        console2.log("spot tick     :", spot);
        console2.log("lower         :", lower);
        console2.log("upper         :", upper);
        console2.log("position id   :", posId);
        console2.log("liquidity     :", uint256(vault.getPosition(posId).liquidity));
        console2.log("WETH in       :", w0 - weth.balanceOf(me));
        console2.log("USDG in       :", u0 - usdg.balanceOf(me));

        // Trade through it, both ways, so fees accrue on BOTH legs.
        uint256 tradeW = weth.balanceOf(me) / 4;
        for (uint256 i; i < 3; ++i) {
            swapper.swap(key, true, -int256(tradeW), TickMath.MIN_SQRT_PRICE + 1);
            swapper.swap(key, false, -int256(usdg.balanceOf(me) / 2), TickMath.MAX_SQRT_PRICE - 1);
        }

        (, int24 afterTick,, uint24 lpFeeNow) = pm.getSlot0(id);
        console2.log("--- AFTER 6 SWAPS ---");
        console2.log("tick now      :", afterTick);
        console2.log("lpFee charged :", lpFeeNow);

        uint256 tw0 = pm.balanceOf(treasury, uint256(uint160(RHChain.WETH)));
        uint256 tu0 = pm.balanceOf(treasury, uint256(uint160(RHChain.USDG)));

        uint256 wPre = weth.balanceOf(me);
        uint256 uPre = usdg.balanceOf(me);
        vault.withdrawAll(posId);

        vm.stopBroadcast();

        console2.log("--- EXIT ---");
        console2.log("WETH returned :", weth.balanceOf(me) - wPre);
        console2.log("USDG returned :", usdg.balanceOf(me) - uPre);
        console2.log("--- PERFORMANCE FEE (ERC-6909 claims minted to treasury) ---");
        console2.log("treasury WETH :", pm.balanceOf(treasury, uint256(uint160(RHChain.WETH))) - tw0);
        console2.log("treasury USDG :", pm.balanceOf(treasury, uint256(uint160(RHChain.USDG))) - tu0);
        console2.log("--- CUSTODY INVARIANT ---");
        console2.log("vault WETH    :", weth.balanceOf(address(vault)));
        console2.log("vault USDG    :", usdg.balanceOf(address(vault)));
        console2.log("vault 6909 W  :", pm.balanceOf(address(vault), uint256(uint160(RHChain.WETH))));
        console2.log("vault 6909 U  :", pm.balanceOf(address(vault), uint256(uint160(RHChain.USDG))));
    }
}
