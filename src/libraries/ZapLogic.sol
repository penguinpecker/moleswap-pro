// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";

/// @title ZapLogic
/// @notice The one-token deposit, extracted from MolePositions into an EXTERNAL library.
///
/// WHY THIS IS A SEPARATE DEPLOYED LIBRARY AND NOT AN INTERNAL ONE. MolePositions reached 24,583 bytes —
/// seven bytes past the 24,576-byte EIP-170 limit, i.e. undeployable. Byte-shaving bought it back to ~180
/// bytes of headroom, which is not a margin, it is a countdown. An `internal` library would not have
/// helped: internal library functions are INLINED into the caller and change nothing. Functions here are
/// `external`, so this library is deployed at its own address and reached by DELEGATECALL — the bytecode
/// genuinely leaves MolePositions while still executing in its storage, with its `address(this)` and its
/// msg.sender. Uniswap's own periphery is built this way for exactly this reason.
///
/// WHAT THAT COSTS, stated plainly: one DELEGATECALL of gas per zap, and a deployment that must link this
/// library's address into the implementation. Nothing about custody changes — a delegatecall runs in the
/// vault's context, so every balance, every position and every invariant is the vault's, unchanged.
///
/// NO STORAGE IS TOUCHED HERE, deliberately. A delegatecalled library shares the caller's storage layout,
/// and a library that wrote to `_positions` would be depending on a slot number staying put across every
/// future edit to the vault — a silent corruption waiting for the first reordered field. Instead this
/// returns what it computed and MolePositions performs the single storage write itself.
library ZapLogic {
    using PoolIdLibrary for PoolKey;

    /// @dev The zap's arguments. Lives here rather than in MolePositions so the library does not have to
    ///      import the contract that imports it.
    struct ZapParams {
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        bool zeroForOne;
        uint256 amountIn;
        uint256 swapAmount;
        uint128 minLiquidity;
        /// @dev THE REAL SLIPPAGE BOUND. `minLiquidity` alone is NOT protection on a one-sided range:
        ///      when the post-swap price sits at or below `tickLower`,
        ///      LiquidityAmounts.getLiquidityForAmounts takes its FIRST branch and derives liquidity from
        ///      `amount0` ALONE — the swap output is discarded. On that path the minted amount is a closed
        ///      form over amountIn, swapAmount and the two ticks, all caller-chosen, so the check compared
        ///      a constant against itself and passed even if the swap returned one wei. Measured: a 99%
        ///      deposit could be sold at any price with nothing firing, because the loss lands inside the
        ///      swap, before any custody accounting, invisible to every balance assertion.
        uint256 amountOutMin;
    }

    event ZapResidualPaid(uint256 indexed positionId, address indexed owner, uint256 amount0, uint256 amount1);

    error ZeroLiquidity();
    error SwapOutputBelowMinimum();
    error DepositAccruedFees();
    error NotSelfFunding();
    error TransferFailed();

    /// @notice Settle the deposit, swap the named slice, mint from the result, pay the remainder to the
    ///         owner — all inside the caller's existing unlock.
    /// @param owner MUST be read from `positions[id].owner` by the caller. Passed rather than looked up
    ///        because this library deliberately reads no storage; the caller keeps the invariant that
    ///        every payout target comes from storage.
    /// @return minted the liquidity actually created, which the caller writes to the position.
    function execute(IPoolManager pm, ZapParams memory z, address owner, uint256 id)
        external
        returns (uint128 minted)
    {
        Currency cIn = z.zeroForOne ? z.key.currency0 : z.key.currency1;

        // 1. Take the whole input. The ONLY pull, bounded by the caller's own `amountIn`.
        _settle(pm, cIn, z.amountIn, owner);

        // 2. Swap the named slice, exact input.
        BalanceDelta swapDelta = pm.swap(
            z.key,
            SwapParams({
                zeroForOne: z.zeroForOne,
                amountSpecified: -int256(z.swapAmount),
                sqrtPriceLimitX96: z.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        // BIND THE EXECUTION, not just the result. See `amountOutMin` above.
        int128 out = z.zeroForOne ? swapDelta.amount1() : swapDelta.amount0();
        if (out < 0 || uint256(uint128(out)) < z.amountOutMin) revert SwapOutputBelowMinimum();

        // 3. Build the position from whatever we now hold as positive deltas.
        int256 d0 = TransientStateLibrary.currencyDelta(pm, address(this), z.key.currency0);
        int256 d1 = TransientStateLibrary.currencyDelta(pm, address(this), z.key.currency1);
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(pm, z.key.toId());
        minted = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(z.tickLower),
            TickMath.getSqrtPriceAtTick(z.tickUpper),
            d0 > 0 ? uint256(d0) : 0,
            d1 > 0 ? uint256(d1) : 0
        );
        // REDUNDANT, and mutation testing proved it: the vault rejects `z.minLiquidity == 0` before the
        // unlock and then rejects `minted < z.minLiquidity` after it, so `minted == 0` cannot survive to
        // here. Kept because this library is reached only through that caller today, and a guard that
        // costs one comparison is the wrong place to economise if a second caller ever appears.
        if (minted == 0) revert ZeroLiquidity();

        (, BalanceDelta feesOnZap) = pm.modifyLiquidity(
            z.key,
            ModifyLiquidityParams({
                tickLower: z.tickLower,
                tickUpper: z.tickUpper,
                liquidityDelta: int256(uint256(minted)),
                salt: bytes32(id)
            }),
            ""
        );
        // A deposit into a BRAND NEW position id realizes nothing, so this never fires — a mutation
        // deleting it kills no test, exactly like the identical assertion on the ordinary `open` path.
        // It stays as a tripwire for the day the zap is pointed at an EXISTING position, where a
        // silently-swallowed fee component would be a real accounting hole.
        if (feesOnZap.amount0() != 0 || feesOnZap.amount1() != 0) revert DepositAccruedFees();

        // 4. The remainder belongs to the OWNER. getLiquidityForAmounts rounds down, so there is always
        //    some of one leg left; it is paid out rather than kept.
        int256 r0 = TransientStateLibrary.currencyDelta(pm, address(this), z.key.currency0);
        int256 r1 = TransientStateLibrary.currencyDelta(pm, address(this), z.key.currency1);
        // Unreachable by construction — the mint cannot cost more than it was derived from — but the
        // thing it forbids is this contract paying out of a deficit, which is the shared-pot failure.
        if (r0 < 0 || r1 < 0) revert NotSelfFunding();
        if (r0 > 0) pm.take(z.key.currency0, owner, uint256(r0));
        if (r1 > 0) pm.take(z.key.currency1, owner, uint256(r1));

        emit ZapResidualPaid(id, owner, uint256(r0), uint256(r1));
    }

    /// @dev sync -> pay -> settle, with the native branch. Mirrors MolePositions._settleFrom exactly;
    ///      duplicated rather than shared because a delegatecalled library cannot call the caller's
    ///      private functions, and making them internal would inline them back into the contract this
    ///      extraction exists to shrink.
    function _settle(IPoolManager pm, Currency c, uint256 amount, address payer) private {
        if (Currency.unwrap(c) == address(0)) {
            pm.settle{value: amount}();
            return;
        }
        pm.sync(c);
        (bool ok, bytes memory ret) = Currency.unwrap(c).call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, payer, address(pm), amount)
        );
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        pm.settle();
    }
}
