// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MoleFeeDial
/// @notice The aggregator fee, as a single mutable number — and nothing else.
///
/// THE DESIGN SPLIT: MoleRouter (the contract users grant token approvals to) is immutable, because an
/// upgradeable approval target is a standing-approval-turned-malicious risk. But an immutable router
/// cannot have its fee tuned. This contract is the resolution: the router reads `feeBps` from here at
/// swap time, so the fee changes with ONE transaction here — while everything with power stays immutable
/// in the router:
///
///   - the router CAPS whatever this returns at its compiled-in MAX_FEE_BPS (1%),
///   - the fee DESTINATION is an immutable in the router — this contract cannot redirect a wei,
///   - the router reads via a gas-capped staticcall and treats any failure as fee = 0, so a broken or
///     hostile dial makes swaps FREE, never stuck,
///   - minAmountOut is enforced on the post-fee amount the user receives, so a fee change landing
///     mid-block cannot push a swap below the floor it was quoted.
///
/// Consequently the worst a compromised owner key can do here is move a number within [0, router cap].
/// This contract's own code is deliberately NOT upgradeable either (no proxy): the entire mutable surface
/// of the fee system is one uint16 in storage.
contract MoleFeeDial {
    /// @dev Self-imposed ceiling, mirroring the router's compiled-in cap. The router clamps regardless —
    ///      this just makes an out-of-range set revert loudly here instead of being silently clamped there.
    uint16 public constant MAX_FEE_BPS = 100; // 1%

    address public owner;
    address public pendingOwner;
    uint16 public feeBps;

    event FeeSet(uint16 oldBps, uint16 newBps);
    event OwnerTransferStarted(address indexed current, address indexed pending);
    event OwnerTransferred(address indexed previous, address indexed current);

    error NotOwner();
    error NotPendingOwner();
    error FeeAboveCap();

    constructor(address _owner, uint16 _feeBps) {
        if (_feeBps > MAX_FEE_BPS) revert FeeAboveCap();
        owner = _owner;
        feeBps = _feeBps;
        emit FeeSet(0, _feeBps);
        emit OwnerTransferred(address(0), _owner);
    }

    /// @notice Set the aggregator fee in basis points. Takes effect on the next swap — no queue, no
    ///         redeploy, no user re-approval. Quotes read this live, so the UI shows the new fee within
    ///         its refresh interval and every plan's minAmountOut is computed against it.
    function setFeeBps(uint16 _feeBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (_feeBps > MAX_FEE_BPS) revert FeeAboveCap();
        emit FeeSet(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    /// @dev Two-step transfer: a typo'd owner address is unrecoverable on an immutable contract, so the
    ///      new owner must prove control by accepting.
    function transferOwnership(address _pending) external {
        if (msg.sender != owner) revert NotOwner();
        pendingOwner = _pending;
        emit OwnerTransferStarted(owner, _pending);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnerTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
