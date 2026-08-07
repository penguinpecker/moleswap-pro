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
import {RHChain} from "../src/config/RHChain.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @title OpsCheck
/// @notice Drives the live vault through a real deposit and a real exit on Robinhood Chain mainnet.
///
/// SINGLE-SIDED ON PURPOSE. The deployer holds no USDG and there is no way to obtain any without a bridge
/// or a trade, so this opens a range ENTIRELY ABOVE the current price — which in Uniswap's math is funded
/// by token0 alone. That exercises open(), the hook's beforeAddLiquidity, the fail-closed pool admission,
/// the amount ceilings and the exit path, all with real tokens. What it CANNOT exercise without USDG is
/// fee accrual, and therefore the performance fee and a fee-bearing rebalance.
contract OpsCheck is Script {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    function run() external {
        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        MolePositions vault = MolePositions(vm.envAddress("MOLE_VAULT"));
        IWETH weth = IWETH(RHChain.WETH);
        address me = msg.sender;

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(RHChain.WETH),
            currency1: Currency.wrap(RHChain.USDG),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(vm.envAddress("MOLE_HOOK"))
        });
        PoolId id = key.toId();

        (, int24 spot,,) = pm.getSlot0(id);
        // A range strictly above spot, on spacing, at least MIN_RANGE_WIDTH wide.
        int24 lower = ((spot / 60) + 2) * 60;
        int24 upper = lower + 600;
        require(lower > spot, "OpsCheck: range is not above spot");

        uint256 wrapAmount = vm.envOr("MOLE_WRAP_WEI", uint256(0.002 ether));

        vm.startBroadcast();

        weth.deposit{value: wrapAmount}();
        weth.approve(address(vault), type(uint256).max);

        uint256 wethBefore = weth.balanceOf(me);

        // Derive liquidity from the token amount with the same library the vault uses, so the two agree.
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmount0(
            TickMath.getSqrtPriceAtTick(lower), TickMath.getSqrtPriceAtTick(upper), wethBefore
        );
        require(liquidity > 0, "OpsCheck: nothing to deposit");

        uint256 posId = vault.open(key, lower, upper, liquidity, wethBefore, 0, block.timestamp + 600);

        uint256 wethAfterOpen = weth.balanceOf(me);
        MolePositions.Position memory p = vault.getPosition(posId);

        console2.log("--- OPEN ---");
        console2.log("spot tick        :", spot);
        console2.log("range lower      :", lower);
        console2.log("range upper      :", upper);
        console2.log("position id      :", posId);
        console2.log("owner            :", p.owner);
        console2.log("liquidity        :", uint256(p.liquidity));
        console2.log("WETH spent (wei) :", wethBefore - wethAfterOpen);
        console2.log("USDG spent       : 0 (single-sided, above spot)");

        // The exit. Owner-only, needs no keeper, and the hook cannot be called on this path at all.
        vault.withdrawAll(posId);

        uint256 wethAfterExit = weth.balanceOf(me);
        MolePositions.Position memory q = vault.getPosition(posId);

        console2.log("--- EXIT ---");
        console2.log("liquidity after  :", uint256(q.liquidity));
        console2.log("WETH returned    :", wethAfterExit - wethAfterOpen);
        console2.log("net WETH delta   :", int256(wethAfterExit) - int256(wethBefore));
        console2.log("vault WETH held  :", weth.balanceOf(address(vault)));

        vm.stopBroadcast();
    }
}
