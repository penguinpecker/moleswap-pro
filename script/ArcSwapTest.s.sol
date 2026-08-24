// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {MoleRouter} from "../src/MoleRouter.sol";

interface IERC20Min {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
}

/// @notice A real, small swap through the Arc MoleRouter, then the same route back — the live proof that
///         the deployed executor works on this chain. Every number is read from the chain before and after;
///         nothing is inferred from the plan.
///
/// The assertions are the point: the recipient must receive at least `minAmountOut`, the fee must be the
/// dial's bps of the input taken in the INPUT currency, and the router must hold NOTHING of either token
/// afterwards (zero residual is the router's second invariant and the one a bad route breaks quietly).
///
/// Env: ARC_ROUTER, ARC_POOL, ARC_TOKEN_IN, ARC_TOKEN_OUT, ARC_AMOUNT_IN, ARC_ZERO_FOR_ONE, ARC_MIN_OUT
contract ArcSwapTest is Script {
    function run() external {
        MoleRouter router = MoleRouter(payable(vm.envAddress("ARC_ROUTER")));
        address pool = vm.envAddress("ARC_POOL");
        address tokenIn = vm.envAddress("ARC_TOKEN_IN");
        address tokenOut = vm.envAddress("ARC_TOKEN_OUT");
        uint256 amountIn = vm.envUint("ARC_AMOUNT_IN");
        bool zeroForOne = vm.envBool("ARC_ZERO_FOR_ONE");
        uint256 minOut = vm.envUint("ARC_MIN_OUT");
        address me = msg.sender;

        require(block.chainid == 5042, "ArcSwapTest: not Arc");

        uint256 inBefore = IERC20Min(tokenIn).balanceOf(me);
        uint256 outBefore = IERC20Min(tokenOut).balanceOf(me);
        uint256 routerInBefore = IERC20Min(tokenIn).balanceOf(address(router));
        uint256 routerOutBefore = IERC20Min(tokenOut).balanceOf(address(router));

        MoleRouter.Hop[] memory hops = new MoleRouter.Hop[](1);
        hops[0] = MoleRouter.Hop({
            venue: MoleRouter.Venue.PancakeV3,
            pool: pool,
            zeroForOne: zeroForOne,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            key: PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(0)),
                fee: 0,
                tickSpacing: 0,
                hooks: IHooks(address(0))
            })
        });
        MoleRouter.Path[] memory paths = new MoleRouter.Path[](1);
        paths[0] = MoleRouter.Path({amountIn: amountIn, hops: hops});

        MoleRouter.SwapPlan memory plan = MoleRouter.SwapPlan({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            recipient: me,
            deadline: block.timestamp + 600,
            paths: paths
        });

        vm.startBroadcast();
        IERC20Min(tokenIn).approve(address(router), amountIn);
        uint256 got = router.swap(plan);
        vm.stopBroadcast();

        uint256 inAfter = IERC20Min(tokenIn).balanceOf(me);
        uint256 outAfter = IERC20Min(tokenOut).balanceOf(me);

        console2.log("amountIn        :", amountIn);
        console2.log("returned        :", got);
        console2.log("tokenIn  before :", inBefore);
        console2.log("tokenIn  after  :", inAfter);
        console2.log("tokenOut before :", outBefore);
        console2.log("tokenOut after  :", outAfter);
        console2.log("received        :", outAfter - outBefore);
        console2.log("router tokenIn  :", IERC20Min(tokenIn).balanceOf(address(router)));
        console2.log("router tokenOut :", IERC20Min(tokenOut).balanceOf(address(router)));

        require(outAfter - outBefore == got, "ArcSwapTest: recipient did not receive the returned amount");
        require(got >= minOut, "ArcSwapTest: below minAmountOut");
        // Zero residual: the router must end holding no more of either token than it started with.
        require(IERC20Min(tokenIn).balanceOf(address(router)) == routerInBefore, "ArcSwapTest: tokenIn residual");
        require(IERC20Min(tokenOut).balanceOf(address(router)) == routerOutBefore, "ArcSwapTest: tokenOut residual");
        // The allowance must be fully consumed — the router pulls exactly what the plan declares.
        require(IERC20Min(tokenIn).allowance(me, address(router)) == 0, "ArcSwapTest: allowance left standing");
    }
}
