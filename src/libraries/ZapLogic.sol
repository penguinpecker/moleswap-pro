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

    /// @dev The burn-and-re-mint half of a keeper rebalance. Same shape and same reason as `ZapParams`:
    ///      the tuple lives here so the library does not import the contract that imports it.
    ///
    ///      EVERY FIELD IS AN ARGUMENT BECAUSE NO FIELD IS READ FROM STORAGE. The vault reads its own
    ///      position and its own policy, hands them over, and writes back what comes out. That is the same
    ///      discipline `execute` follows and it exists for the same reason: a delegatecalled library that
    ///      touched `_positions` would be hard-coding a slot number that any future reordering silently
    ///      invalidates. What the vault does NOT delegate is every check that reads vault state — the
    ///      position size band and the aggregate pool ceiling are applied by the caller to the liquidity
    ///      this function returns, before it is written.
    struct RebalanceParams {
        PoolKey key;
        int24 oldLower;
        int24 oldUpper;
        int24 newLower;
        int24 newUpper;
        uint128 liquidity;
        uint256 id;
        address owner;
        uint16 performanceFeeBps;
        address feeRecipient;
        uint16 maxEjectionBps;
    }

    event ZapResidualPaid(uint256 indexed positionId, address indexed owner, uint256 amount0, uint256 amount1);
    /// @dev Declared here as well as in MolePositions because a delegatecall emits from the VAULT's
    ///      address with the vault's topics, so an indexer cannot tell which body wrote the log — and the
    ///      revenue model's whole auditability rests on this event existing for every realization.
    event PerformanceFeeTaken(uint256 indexed positionId, address indexed recipient, uint128 amount0, uint128 amount1);

    error ZeroLiquidity();
    error SwapOutputBelowMinimum();
    error DepositAccruedFees();
    error NotSelfFunding();
    error TransferFailed();
    /// @dev Same names, and therefore the same four-byte selectors, as the errors MolePositions declares.
    ///      An integrator decoding a revert cannot tell that this code moved, which is the point.
    error RebalanceNotSelfFunding();
    error EjectionTooLarge();

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

    /// @notice Burn a position at its old range and re-mint it at the new one, inside the caller's unlock.
    ///
    /// MOVED HERE 2026-08-23, and the reason is EIP-170 rather than design. Closing F-07 added a
    /// spot-vs-TWAP gate, an edge-measured recenter bound, a size-band re-check and an aggregate pool
    /// ceiling to MolePositions, which pushed it 1,367 bytes past the 24,576-byte limit — undeployable,
    /// which for a UUPS proxy over four funded positions means the fix cannot ship at all. This block was
    /// the right thing to move: it is the only user of `TickMath.getSqrtPriceAtTick` and
    /// `LiquidityAmounts` in the vault, and those two are most of the weight.
    ///
    /// NOTHING ABOUT THE SEMANTICS CHANGED. The arithmetic, the ordering, the error selectors and the
    /// events are the same lines they were inside `unlockCallback`; a delegatecall runs in the vault's
    /// context, so every delta, every `take` and every mint is still the vault's. What did change is that
    /// the checks reading VAULT STORAGE — the position size band, the aggregate ceiling — now run in the
    /// caller against the value this returns, which is where they have to be for a library that reads no
    /// storage.
    ///
    /// THE THING THAT MUST BE CONSERVED IS TOKEN AMOUNTS, NOT THE LIQUIDITY NUMBER. The token value of a
    /// fixed L depends on the range width, so re-minting the same L at a narrower range needs fewer tokens
    /// and leaves a surplus — and re-minting at a wider range needs more. An earlier version of this kept
    /// L constant and parked that surplus in the vault's own balance, which created one unattributed pot
    /// shared by every position: a narrowing rebalance of a victim funded a widening rebalance of the
    /// keeper's own position, and the keeper then withdrew to itself entirely legitimately, since it
    /// really was the stored owner. Measured at ~86x the attacker's stake against a victim who lost 98.8%
    /// of a deposit. So:
    ///
    ///   - the new liquidity is DERIVED from the amounts the burn actually returned, at the new range and
    ///     the current price, rounded down by construction;
    ///   - accrued fees are included in those amounts, so they compound into the owner's own position
    ///     rather than being swept anywhere;
    ///   - the leftover goes to the OWNER, never to the vault;
    ///   - the vault neither holds nor spends an inventory, so no shared pot can exist.
    ///
    /// @return newLiquidity what the re-mint actually created. The CALLER checks it against the size band
    ///         and the aggregate ceiling and writes it; this function only reports it.
    function rebalance(IPoolManager pm, RebalanceParams memory r)
        external
        returns (uint128 newLiquidity, uint256 residual0, uint256 residual1)
    {
        (BalanceDelta removed, BalanceDelta feesAccrued) = _modify(pm, r.key, r.oldLower, r.oldUpper, -int256(uint256(r.liquidity)), r.id);

        // THE PROTOCOL'S CUT, taken here and nowhere else on this path, from the fee component only. What
        // remains compounds into the owner's own new position — the fee changes how much compounds, never
        // who it belongs to. Minted as ERC-6909 claims rather than `take`n, so a hostile token cannot
        // revert inside an unlock that a withdrawal also runs through.
        uint128 cut0 = _cutOf(feesAccrued.amount0(), r.performanceFeeBps);
        uint128 cut1 = _cutOf(feesAccrued.amount1(), r.performanceFeeBps);
        if (cut0 != 0) pm.mint(r.feeRecipient, r.key.currency0.toId(), cut0);
        if (cut1 != 0) pm.mint(r.feeRecipient, r.key.currency1.toId(), cut1);
        if (cut0 != 0 || cut1 != 0) emit PerformanceFeeTaken(r.id, r.feeRecipient, cut0, cut1);

        // Everything the burn returned MINUS our cut: principal plus the fees the owner keeps. Both legs
        // are non-negative here, and the subtraction cannot underflow because `removed` is principal plus
        // fees while the cut is a fraction of fees alone — but it is bounded rather than asserted, since
        // an underflow here would revert a rebalance rather than mis-price one, and a keeper that cannot
        // rebalance is a far better failure than a keeper that silently takes principal.
        uint256 have0 = removed.amount0() > 0 ? uint256(uint128(removed.amount0())) : 0;
        uint256 have1 = removed.amount1() > 0 ? uint256(uint128(removed.amount1())) : 0;
        have0 = have0 > cut0 ? have0 - cut0 : 0;
        have1 = have1 > cut1 ? have1 - cut1 : 0;

        // SPOT, and the caller has already proven it agrees with the oracle. Reading `getSlot0` here is
        // what made F-07 mechanism A possible — a keeper that walked spot outside the old range made the
        // burn return one token, and this line then priced the re-mint at the price the keeper made. The
        // gate that stops it is `MolePositions._requireSpotNearTwap`, applied before the unlock is even
        // opened; this line is unchanged because the fix belongs at the gate, not at the arithmetic.
        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(pm, r.key.toId());
        newLiquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(r.newLower),
            TickMath.getSqrtPriceAtTick(r.newUpper),
            have0,
            have1
        );
        if (newLiquidity == 0) revert ZeroLiquidity();

        (BalanceDelta added,) = _modify(pm, r.key, r.newLower, r.newUpper, int256(uint256(newLiquidity)), r.id);
        // The cut has already been minted out of our delta, so it is subtracted here too. Leaving it in
        // would pay the owner the protocol's share as residual AND mint it to the recipient — the same
        // wei counted twice, which the unlock would then refuse to balance.
        BalanceDelta net = removed + added - toBalanceDelta(int128(cut0), int128(cut1));

        // getLiquidityForAmounts rounds down, so the mint can never cost more than the burn returned.
        // If it somehow does, that is a broken invariant and we refuse rather than dip into anything.
        if (net.amount0() < 0 || net.amount1() < 0) revert RebalanceNotSelfFunding();

        // THE RESIDUAL BELONGS TO THE OWNER. Calling it "dust" was wrong: when the new range wants a token
        // ratio the old range does not hold, this can be most of a leg. It still goes to the owner and the
        // vault still keeps nothing — that is the custody invariant — but it is returned so the caller can
        // emit the size, and bounded when the deployment asks for it.
        residual0 = net.amount0() > 0 ? uint256(uint128(net.amount0())) : 0;
        residual1 = net.amount1() > 0 ? uint256(uint128(net.amount1())) : 0;

        if (r.maxEjectionBps < 10_000) {
            if (residual0 * 10_000 > have0 * uint256(r.maxEjectionBps)) revert EjectionTooLarge();
            if (residual1 * 10_000 > have1 * uint256(r.maxEjectionBps)) revert EjectionTooLarge();
        }

        // Recipient is the stored owner, read by the caller from `positions[id].owner` and passed in.
        if (net.amount0() > 0) pm.take(r.key.currency0, r.owner, residual0);
        if (net.amount1() > 0) pm.take(r.key.currency1, r.owner, residual1);
    }

    /// @dev Salt is the position id, so every position is distinct inside the PoolManager and remains
    ///      enumerable from the vault's own events alone — required for the TVL adapter.
    function _modify(IPoolManager pm, PoolKey memory key, int24 lower, int24 upper, int256 liquidityDelta, uint256 id)
        private
        returns (BalanceDelta, BalanceDelta)
    {
        return pm.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidityDelta, salt: bytes32(id)}),
            ""
        );
    }

    /// @dev ROUNDS DOWN, so the remainder goes to the USER. NON-POSITIVE MEANS ZERO, because
    ///      `uint256(uint128(negative))` is an enormous number and a cut computed from it would be a
    ///      catastrophic mint rather than a small error. Identical to MolePositions._cutOf, with the rate
    ///      passed in rather than read from storage.
    function _cutOf(int128 feeComponent, uint16 feeBps) private pure returns (uint128) {
        if (feeComponent <= 0 || feeBps == 0) return 0;
        return uint128((uint256(uint128(feeComponent)) * feeBps) / 10_000);
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
