// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {HookPermissions} from "../../../src/config/HookPermissions.sol";

/// @title VulnerableMolePositions
/// @notice THE 2026-08-01 CONTRACT, REBUILT ON PURPOSE. Test-only. Never deployed, never imported by
///         anything under src/.
///
/// This exists to answer the only question that matters about a passing invariant suite: CAN IT FAIL?
/// A handler-based suite that greens up against a fixed contract proves nothing on its own — it might
/// be measuring the wrong thing, tolerating too much, or never reaching the interesting states. The
/// honest way to establish that the six invariants have teeth is to point them at the exact contract
/// that was broken and require them to break.
///
/// It reproduces the 2026-08-01 contract, whose vulnerability was these two things:
///
///   1. `rebalance` re-mints the SAME LIQUIDITY NUMBER at the new range instead of re-deriving it
///      from the tokens the burn actually returned. Because the token value of a fixed L depends on
///      range width, a narrower range needs fewer tokens and leaves a surplus; a wider range needs
///      more and runs a deficit.
///   2. `_settleNet` is restored: surplus is taken to `address(this)` and deficits are paid out of
///      `address(this)`. One unattributed pot, shared by every position, is the bridge that moved a
///      victim's principal into the attacker's position.
///
/// WHAT THIS IS AND IS NOT, stated exactly, because it used to overclaim. This file said it was
/// "byte-for-byte the current MolePositions" apart from those two lines and that "the external ABI is
/// identical". Neither is true any more and neither needs to be. The current contract has since gained a
/// twelve-argument constructor (seven keeper bounds), `withdrawAll`, `RebalanceResidualPaid`, the
/// fail-closed hook allowlist and the ejection and recenter caps; this one still takes six arguments and
/// has none of them. It is a snapshot of the contract AS IT WAS, which is the only thing that makes it a
/// useful negative control — a control that tracked every subsequent fix would eventually stop failing.
///
/// What must remain true is narrower and is what the mutation proof actually depends on: the SUBSET of
/// the ABI the handler drives — open, withdraw, rebalance, getPosition, ownerOf, whitelistPool — is
/// call-compatible, so the same handler drives both builds and the invariants are pointed at the same
/// operations. Everything the handler touches behaves as it did on 2026-08-01, including the owner-only
/// withdrawal and the stored-owner payout target, so the ONLY thing the suite can be detecting is the pot.
contract VulnerableMolePositions is IUnlockCallback {
    using PoolIdLibrary for PoolKey;

    struct Position {
        address owner;
        PoolId poolId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint64 openedAtL1Block;
        uint64 lastRebalancedAt;
    }

    enum Action {
        Open,
        Withdraw,
        Rebalance
    }

    IPoolManager public immutable poolManager;
    address public immutable keeper;
    uint32 public immutable minRebalanceInterval;
    int24 public immutable minRangeWidth;
    int24 public immutable maxRangeWidth;

    mapping(uint256 id => Position) private _positions;
    mapping(PoolId => PoolKey) private _pools;
    mapping(PoolId => bool) public isWhitelisted;
    mapping(address owner => uint256[] ids) private _ownerPositions;

    uint256 public positionCount;

    error NotOwner();
    error NotKeeper();
    error NotPoolManager();
    error PoolNotWhitelisted();
    error NoSuchPosition();
    error ZeroLiquidity();
    error InsufficientLiquidity();
    error RebalanceTooSoon();
    error RangeWidthOutOfBounds();
    error TicksMisordered();
    error TickNotOnSpacing();
    error PoolAlreadyWhitelisted();
    error TransferFailed();
    error WithdrawalWouldBeBlockable();
    error InvalidTickSpacing();
    error DeadlinePassed();
    error ExceedsMaxAmount();
    error DepositWouldBeTaxable();
    error HookNotPermitted();

    address public immutable moleHook;

    constructor(
        IPoolManager _poolManager,
        address _keeper,
        uint32 _minRebalanceInterval,
        int24 _minRangeWidth,
        int24 _maxRangeWidth,
        address _moleHook
    ) {
        require(_minRangeWidth > 0 && _maxRangeWidth >= _minRangeWidth, "bad range bounds");
        if (_moleHook != address(0)) {
            if (!HookPermissions.withdrawalIsUnblockable(_moleHook)) revert WithdrawalWouldBeBlockable();
            if (!HookPermissions.depositIsUntaxable(_moleHook)) revert DepositWouldBeTaxable();
        }
        poolManager = _poolManager;
        keeper = _keeper;
        minRebalanceInterval = _minRebalanceInterval;
        minRangeWidth = _minRangeWidth;
        maxRangeWidth = _maxRangeWidth;
        moleHook = _moleHook;
    }

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    modifier onlyPositionOwner(uint256 id) {
        if (_positions[id].owner != msg.sender) revert NotOwner();
        _;
    }

    function whitelistPool(PoolKey calldata key) external {
        // Mirrors the fixed contract's fail-closed admission so the ONLY behavioural difference
        // between this mutant and MolePositions is the custody vulnerability restored below.
        if (address(key.hooks) != moleHook) revert HookNotPermitted();
        if (key.tickSpacing <= 0) revert InvalidTickSpacing();
        PoolId id = key.toId();
        if (isWhitelisted[id]) revert PoolAlreadyWhitelisted();
        isWhitelisted[id] = true;
        _pools[id] = key;
    }

    function open(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Max,
        uint256 amount1Max,
        uint256 deadline
    ) external returns (uint256 id) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        PoolId poolId = key.toId();
        if (!isWhitelisted[poolId]) revert PoolNotWhitelisted();
        if (liquidity == 0) revert ZeroLiquidity();
        _validateRange(key, tickLower, tickUpper);

        id = ++positionCount;
        _positions[id] = Position({
            owner: msg.sender,
            poolId: poolId,
            tickLower: tickLower,
            tickUpper: tickUpper,
            liquidity: liquidity,
            openedAtL1Block: uint64(block.number),
            lastRebalancedAt: uint64(block.timestamp)
        });
        _ownerPositions[msg.sender].push(id);

        poolManager.unlock(
            abi.encode(Action.Open, id, msg.sender, int256(uint256(liquidity)), int24(0), int24(0), amount0Max, amount1Max)
        );
    }

    function withdraw(uint256 id, uint128 liquidityToRemove) external onlyPositionOwner(id) {
        Position storage p = _positions[id];
        if (liquidityToRemove == 0) revert ZeroLiquidity();
        if (liquidityToRemove > p.liquidity) revert InsufficientLiquidity();

        p.liquidity -= liquidityToRemove;

        poolManager.unlock(
            abi.encode(
                Action.Withdraw, id, p.owner, -int256(uint256(liquidityToRemove)), int24(0), int24(0), uint256(0), uint256(0)
            )
        );
    }

    function rebalance(uint256 id, int24 newTickLower, int24 newTickUpper) external onlyKeeper {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert NoSuchPosition();
        if (block.timestamp < uint256(p.lastRebalancedAt) + minRebalanceInterval) revert RebalanceTooSoon();

        PoolKey memory key = _pools[p.poolId];
        _validateRange(key, newTickLower, newTickUpper);
        if (p.liquidity == 0) revert ZeroLiquidity();

        p.lastRebalancedAt = uint64(block.timestamp);

        poolManager.unlock(
            abi.encode(Action.Rebalance, id, p.owner, int256(0), newTickLower, newTickUpper, uint256(0), uint256(0))
        );
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (
            Action action,
            uint256 id,
            address owner,
            int256 liquidityDelta,
            int24 newLower,
            int24 newUpper,
            uint256 amount0Max,
            uint256 amount1Max
        ) = abi.decode(data, (Action, uint256, address, int256, int24, int24, uint256, uint256));

        Position storage p = _positions[id];
        PoolKey memory key = _pools[p.poolId];

        if (action == Action.Open) {
            BalanceDelta delta = _modify(key, p.tickLower, p.tickUpper, liquidityDelta, id);
            if (delta.amount0() < 0 && uint256(uint128(-delta.amount0())) > amount0Max) revert ExceedsMaxAmount();
            if (delta.amount1() < 0 && uint256(uint128(-delta.amount1())) > amount1Max) revert ExceedsMaxAmount();
            _payOwed(key, delta, owner);
            return "";
        }

        if (action == Action.Withdraw) {
            BalanceDelta delta = _modify(key, p.tickLower, p.tickUpper, liquidityDelta, id);
            (uint256 a0, uint256 a1) = _collectTo(key, delta, p.owner);
            return abi.encode(a0, a1);
        }

        // ---------------------------------------------------------- THE MUTATION
        // The liquidity NUMBER is conserved across the range change. Everything downstream of this
        // line follows from it: a narrower range needs fewer tokens for the same L, so the burn
        // returns more than the mint consumes, and the difference has to go somewhere.
        uint128 liq = p.liquidity;
        BalanceDelta removed = _modify(key, p.tickLower, p.tickUpper, -int256(uint256(liq)), id);

        p.tickLower = newLower;
        p.tickUpper = newUpper;

        BalanceDelta added = _modify(key, newLower, newUpper, int256(uint256(liq)), id);
        BalanceDelta net = removed + added;

        // ...and here is where it goes: into this contract, belonging to nobody, spendable by the
        // next rebalance of any position.
        _settleNet(key, net);
        return "";
    }

    function _modify(PoolKey memory key, int24 lower, int24 upper, int256 liquidityDelta, uint256 id)
        private
        returns (BalanceDelta)
    {
        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidityDelta, salt: bytes32(id)}),
            ""
        );
        return callerDelta;
    }

    function _payOwed(PoolKey memory key, BalanceDelta delta, address payer) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) _settleFrom(key.currency0, uint256(uint128(-d0)), payer);
        if (d1 < 0) _settleFrom(key.currency1, uint256(uint128(-d1)), payer);
    }

    function _collectTo(PoolKey memory key, BalanceDelta delta, address to) private returns (uint256 a0, uint256 a1) {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 > 0) {
            a0 = uint256(uint128(d0));
            poolManager.take(key.currency0, to, a0);
        }
        if (d1 > 0) {
            a1 = uint256(uint128(d1));
            poolManager.take(key.currency1, to, a1);
        }
    }

    /// @dev THE DELETED FUNCTION, restored. Surplus in, deficit out, one balance for all positions.
    function _settleNet(PoolKey memory key, BalanceDelta delta) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 > 0) poolManager.take(key.currency0, address(this), uint256(uint128(d0)));
        else if (d0 < 0) _settleFrom(key.currency0, uint256(uint128(-d0)), address(this));
        if (d1 > 0) poolManager.take(key.currency1, address(this), uint256(uint128(d1)));
        else if (d1 < 0) _settleFrom(key.currency1, uint256(uint128(-d1)), address(this));
    }

    function _settleFrom(Currency currency, uint256 amount, address payer) private {
        poolManager.sync(currency);
        if (payer == address(this)) {
            _safeTransfer(Currency.unwrap(currency), address(poolManager), amount);
        } else {
            _safeTransferFrom(Currency.unwrap(currency), payer, address(poolManager), amount);
        }
        poolManager.settle();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory ret) =
            token.call(abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _validateRange(PoolKey memory key, int24 lower, int24 upper) private view {
        if (lower >= upper) revert TicksMisordered();
        if (lower % key.tickSpacing != 0 || upper % key.tickSpacing != 0) revert TickNotOnSpacing();
        if (lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK) revert RangeWidthOutOfBounds();
        int24 width = upper - lower;
        if (width < minRangeWidth || width > maxRangeWidth) revert RangeWidthOutOfBounds();
    }

    function getPosition(uint256 id) external view returns (Position memory) {
        return _positions[id];
    }

    function ownerOf(uint256 id) external view returns (address) {
        return _positions[id].owner;
    }

    function positionsOf(address owner) external view returns (uint256[] memory) {
        return _ownerPositions[owner];
    }

    function poolKeyOf(PoolId id) external view returns (PoolKey memory) {
        return _pools[id];
    }
}
