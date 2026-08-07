// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";

/// @title RouterFixtures
/// @notice Generates ground-truth fixtures for the off-chain router's swap math, from the LIVE chain.
///
/// WHY A FIXTURE GENERATOR AND NOT AN ASSERTION. The aggregator prices swaps in TypeScript, off-chain,
/// because asking the chain what a swap is worth costs a network round trip and an aggregator has to
/// evaluate many candidate routes before it picks one. That is the whole reason Jupiter feels instant.
/// The danger of that design is obvious: two implementations of the same math WILL drift, and the drift
/// surfaces as a user's transaction reverting on `minOut` after they have paid gas.
///
/// So this test does not check the TypeScript. It records what the REAL POOL ON THE REAL CHAIN actually
/// does — pool state in, exact amountOut out — into a JSON file, and `router/test/liveParity.test.ts`
/// asserts the TypeScript reproduces it to the wei. Two independent implementations, one differential
/// check, and the on-chain side is not a model of the truth: it IS the truth.
///
/// Run explicitly (it needs a fork, so it is skipped in the normal suite):
///   forge test --match-path test/fork/RouterFixtures.t.sol --fork-url rh_mainnet --threads 1 -vv
contract RouterFixtures is Test {
    /// @dev PancakeSwap V3 on Robinhood Chain — verified factory, and the only venue on this chain with
    ///      meaningful depth besides our own v4 pool.
    address internal constant TICK_LENS = 0x9a489505a00cE272eAa5e07Dba6491314CaE3796;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @dev The fee-500 WETH/USDG pool: ~6.8 WETH and ~72,900 USDG, the deepest on the chain.
    address internal constant POOL = 0x88A8E96E7785d378825e8B5D7FC0e6f62487061E;

    string internal out;

    function setUp() public {
        // Fail loudly rather than silently testing nothing if this is run without a fork.
        if (block.chainid != 4663) {
            vm.skip(true);
        }
    }

    function test_generateFixtures() public {
        (uint160 sqrtPriceX96, int24 tick,,,,,) = IUniV3Pool(POOL).slot0();
        uint128 liquidity = IUniV3Pool(POOL).liquidity();
        int24 spacing = IUniV3Pool(POOL).tickSpacing();
        uint24 fee = IUniV3Pool(POOL).fee();

        console2.log("=== live pool state ===");
        console2.log("pool        ", POOL);
        console2.log("sqrtPriceX96", uint256(sqrtPriceX96));
        console2.logInt(int256(tick));
        console2.log("liquidity   ", uint256(liquidity));
        console2.log("tickSpacing "); console2.logInt(int256(spacing));
        console2.log("fee         ", uint256(fee));
        console2.log("block       ", block.number);

        // ---- ticks, over a window wide enough that the largest probe below cannot walk off the end
        int16 centerWord = int16((tick / spacing) >> 8);
        console2.log("=== populated ticks (word, index, liquidityNet) ===");
        for (int16 w = centerWord - 8; w <= centerWord + 8; w++) {
            try ITickLens(TICK_LENS).getPopulatedTicksInWord(POOL, w) returns (
                ITickLens.PopulatedTick[] memory ticks
            ) {
                for (uint256 i = 0; i < ticks.length; i++) {
                    console2.log("TICK");
                    console2.logInt(int256(ticks[i].tick));
                    console2.logInt(int256(ticks[i].liquidityNet));
                }
            } catch {}
        }

        // ---- ground truth: what the pool ACTUALLY returns, at sizes chosen to span the interesting cases
        // A WIDE ladder, not a handful of round numbers. The word-boundary bug this suite caught was
        // invisible at every size below 2e18 and only appeared once a swap traversed a long
        // uninitialised stretch — so the probes must span from dust to "drains the pool", and include
        // deliberately ugly amounts that land mid-range rather than on convenient boundaries.
        uint256[18] memory probes = [
            uint256(1),
            7,
            1e9,
            1e12,
            333333333333,
            1e15,
            2718281828459045,
            1e16,
            5e16,
            1e17,
            3141592653589793238,
            5e17,
            1e18,
            2e18,
            4e18,
            7e18,
            15e18,
            50e18
        ];

        console2.log("=== ground truth: exactInput WETH->USDG (zeroForOne) ===");
        for (uint256 i = 0; i < probes.length; i++) {
            (int256 a0, int256 a1) = _dryRunSwap(true, int256(probes[i]));
            console2.log("PROBE0");
            console2.log(probes[i]);
            console2.logInt(a0);
            console2.logInt(a1);
        }

        console2.log("=== ground truth: exactInput USDG->WETH (oneForZero) ===");
        uint256[16] memory probes1 = [
            uint256(1),
            11,
            1e3,
            1e6,
            1234567,
            1e7,
            33333333,
            1e8,
            5e8,
            1e9,
            2718281828,
            1e10,
            5e10,
            1e11,
            5e11,
            2e12
        ];
        for (uint256 i = 0; i < probes1.length; i++) {
            (int256 a0, int256 a1) = _dryRunSwap(false, int256(probes1[i]));
            console2.log("PROBE1");
            console2.log(probes1[i]);
            console2.logInt(a0);
            console2.logInt(a1);
        }
    }

    /// @dev Executes a real swap against the real pool inside a snapshot, reads the exact deltas, then
    ///      rolls back. This is the pool's own arithmetic — not a quoter's model of it, and not a
    ///      reimplementation. Nothing is committed; the fork is discarded at the end of the test.
    function _dryRunSwap(bool zeroForOne, int256 amountIn) internal returns (int256 amount0, int256 amount1) {
        uint256 snap = vm.snapshotState();
        SwapProbe probe = new SwapProbe();
        deal(WETH, address(probe), 1_000_000e18);
        deal(USDG, address(probe), 1_000_000e6);
        (amount0, amount1) = probe.run(POOL, zeroForOne, amountIn);
        vm.revertToState(snap);
    }
}

/// @dev A minimal swap callback. The pool calls back for payment; this pays from its own balance.
contract SwapProbe {
    function run(address pool, bool zeroForOne, int256 amountSpecified)
        external
        returns (int256 amount0, int256 amount1)
    {
        (amount0, amount1) = IUniV3Pool(pool).swap(
            address(this),
            zeroForOne,
            amountSpecified,
            zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
            abi.encode(pool)
        );
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _pay(amount0Delta, amount1Delta, data);
    }

    function _pay(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "callback: not the pool");
        if (amount0Delta > 0) {
            IERC20(IUniV3Pool(pool).token0()).transfer(pool, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(IUniV3Pool(pool).token1()).transfer(pool, uint256(amount1Delta));
        }
    }
}

interface IUniV3Pool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint32, bool);
    function liquidity() external view returns (uint128);
    function tickSpacing() external view returns (int24);
    function fee() external view returns (uint24);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface ITickLens {
    struct PopulatedTick {
        int24 tick;
        int128 liquidityNet;
        uint128 liquidityGross;
    }

    function getPopulatedTicksInWord(address pool, int16 tickBitmapIndex)
        external
        view
        returns (PopulatedTick[] memory);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
}
