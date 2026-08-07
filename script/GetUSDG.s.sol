// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MiniSwapper} from "./MiniSwapper.sol";
import {RHChain} from "../src/config/RHChain.sol";

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice Wraps ETH and swaps a slice of it for USDG on the deepest existing WETH/USDG pool.
/// @dev Uses the hookless 0.05% pool (the deepest on this chain, ~1.76e17 liquidity), NOT our own pool —
///      ours has no liquidity yet, which is the whole reason we need the other side of the book.
contract GetUSDG is Script {
    function run() external {
        IPoolManager pm = IPoolManager(RHChain.POOL_MANAGER);
        IWETH weth = IWETH(RHChain.WETH);
        IERC20 usdg = IERC20(RHChain.USDG);
        address me = msg.sender;

        uint256 wrapAmount = vm.envOr("WRAP_WEI", uint256(0.005 ether));
        uint256 swapAmount = vm.envOr("SWAP_WEI", uint256(0.0035 ether));

        PoolKey memory liquid = PoolKey({
            currency0: Currency.wrap(RHChain.WETH),
            currency1: Currency.wrap(RHChain.USDG),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });

        vm.startBroadcast();

        MiniSwapper swapper = new MiniSwapper(pm);
        weth.deposit{value: wrapAmount}();
        weth.approve(address(swapper), type(uint256).max);
        usdg.approve(address(swapper), type(uint256).max);

        uint256 w0 = weth.balanceOf(me);
        uint256 u0 = usdg.balanceOf(me);

        // Exact input: negative amountSpecified. zeroForOne = WETH -> USDG.
        swapper.swap(liquid, true, -int256(swapAmount), TickMath.MIN_SQRT_PRICE + 1);

        uint256 w1 = weth.balanceOf(me);
        uint256 u1 = usdg.balanceOf(me);

        vm.stopBroadcast();

        console2.log("swapper          :", address(swapper));
        console2.log("WETH in (wei)    :", w0 - w1);
        console2.log("USDG out (6dp)   :", u1 - u0);
        console2.log("WETH balance now :", w1);
        console2.log("USDG balance now :", u1);
        console2.log("implied ETH price:", ((u1 - u0) * 1e18) / (w0 - w1) / 1e6);
    }
}
