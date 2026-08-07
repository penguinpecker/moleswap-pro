// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/types/PoolOperation.sol";

/// @notice A minimal v4 swap router, for driving the live pool during verification.
/// @dev Deliberately not the Universal Router: that path needs Permit2 approvals and command encoding,
///      which is a lot of moving parts to trust when the only goal is "move tokens through this pool so
///      fees accrue". This is small enough to read in one sitting. It holds no funds between calls.
contract MiniSwapper is IUnlockCallback {
    IPoolManager public immutable poolManager;

    constructor(IPoolManager _pm) {
        poolManager = _pm;
    }

    function swap(PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)
        external
        returns (int128 delta0, int128 delta1)
    {
        bytes memory res =
            poolManager.unlock(abi.encode(msg.sender, key, zeroForOne, amountSpecified, sqrtPriceLimitX96));
        (delta0, delta1) = abi.decode(res, (int128, int128));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pm");
        (address payer, PoolKey memory key, bool zeroForOne, int256 amountSpecified, uint160 limit) =
            abi.decode(data, (address, PoolKey, bool, int256, uint160));

        BalanceDelta d = poolManager.swap(
            key, SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}), ""
        );

        // Pay what we owe from the payer, collect what we are owed to the payer.
        if (d.amount0() < 0) _settle(key.currency0, payer, uint256(uint128(-d.amount0())));
        if (d.amount1() < 0) _settle(key.currency1, payer, uint256(uint128(-d.amount1())));
        if (d.amount0() > 0) poolManager.take(key.currency0, payer, uint256(uint128(d.amount0())));
        if (d.amount1() > 0) poolManager.take(key.currency1, payer, uint256(uint128(d.amount1())));

        return abi.encode(d.amount0(), d.amount1());
    }

    function _settle(Currency c, address payer, uint256 amount) private {
        poolManager.sync(c);
        IERC20Minimal(Currency.unwrap(c)).transferFrom(payer, address(poolManager), amount);
        poolManager.settle();
    }
}
