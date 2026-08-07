// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";
import {FixedPoint96} from "v4-core/libraries/FixedPoint96.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

/// @dev Isolating the crossing arithmetic from MoleQueue.settle so it can be fuzzed on its own.
contract QueueMathTest is Test {
    /// @notice crossed1 must NEVER exceed totalIn1, and crossed0 never totalIn0 — otherwise
    ///         `residual = total - crossed` underflows and settlement reverts for everyone.
    function testFuzz_crossingNeverExceedsEitherSide(uint128 in0, uint128 in1, int24 tickRaw) public pure {
        in0 = uint128(bound(in0, 0, type(uint96).max));
        in1 = uint128(bound(in1, 0, type(uint96).max));
        int24 tick = int24(bound(tickRaw, -400_000, 400_000));

        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        uint256 priceX96 = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), FixedPoint96.Q96);
        if (priceX96 == 0) return;

        uint256 want0 = FullMath.mulDiv(in1, FixedPoint96.Q96, priceX96);
        uint128 crossed0 = uint128(in0 < want0 ? in0 : want0);
        uint128 crossed1 = uint128(FullMath.mulDiv(crossed0, priceX96, FixedPoint96.Q96));

        assertLe(crossed0, in0, "crossed0 exceeds the side-0 escrow");
        assertLe(crossed1, in1, "crossed1 exceeds the side-1 escrow -- residual would underflow");
    }
}
