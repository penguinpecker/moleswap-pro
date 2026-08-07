// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/types/Currency.sol";

/// @title MoleFeeCollector
/// @notice Turns the protocol's performance fee into tokens it can actually spend.
///
/// WHY THIS EXISTS. MolePositions pays its cut as ERC-6909 claims minted inside the PoolManager, and that
/// choice is deliberate: minting touches no token contract, so a blocklisting or pausable token can never
/// revert on the fee and take a user's WITHDRAWAL down with it. The cost of that choice is that claims are
/// not ERC-20 — redeeming them means calling `unlock` and then `burn`/`take` from inside the callback,
/// which a plain wallet cannot do. Point `feeRecipient` at an EOA and the revenue accrues, correctly and
/// permanently, somewhere nobody can reach.
///
/// This contract is the somewhere-reachable. It holds nothing of its own, and it exists only to convert.
///
/// DELIBERATELY NOT UPGRADEABLE. It is forty lines of logic, it custodies nothing between transactions,
/// and anything wrong with it is fixed by pointing `feeRecipient` at a new one. An upgrade key here would
/// add a root key over accrued revenue and buy nothing in return.
contract MoleFeeCollector is IUnlockCallback {
    IPoolManager public immutable poolManager;

    /// @notice May sweep. Nothing else in this contract is permissioned, because nothing else moves value.
    address public owner;

    event Swept(Currency indexed currency, address indexed to, uint256 amount);
    event OwnerTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPoolManager();
    error NothingToSweep();
    error ZeroRecipient();

    constructor(IPoolManager _poolManager, address _owner) {
        require(_owner != address(0), "owner required");
        poolManager = _poolManager;
        owner = _owner;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwner(address to) external onlyOwner {
        emit OwnerTransferred(owner, to);
        owner = to;
    }

    /// @notice Redeem every claim this contract holds in `currency` and send the tokens to `to`.
    /// @dev The whole balance, not a caller-named amount. A partial-sweep parameter would be one more
    ///      number to get wrong for no benefit — there is no scenario where leaving some behind helps.
    function sweep(Currency currency, address to) external onlyOwner returns (uint256 amount) {
        if (to == address(0)) revert ZeroRecipient();
        amount = poolManager.balanceOf(address(this), currency.toId());
        if (amount == 0) revert NothingToSweep();
        poolManager.unlock(abi.encode(currency, to, amount));
        emit Swept(currency, to, amount);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (Currency currency, address to, uint256 amount) = abi.decode(data, (Currency, address, uint256));

        // burn -> take is the whole conversion: burning the claim creates the positive delta that `take`
        // then pays out as real tokens. `to` is checked non-zero by the caller and never read from here.
        poolManager.burn(address(this), currency.toId(), amount);
        poolManager.take(currency, to, amount);
        return "";
    }

    /// @dev Native ETH arrives here only if a sweep targets this contract, which `sweep` does not do.
    ///      Present so a native `take` cannot revert if a future caller routes one through.
    receive() external payable {}
}
