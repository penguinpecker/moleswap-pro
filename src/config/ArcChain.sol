// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title ArcChain
/// @notice Verified address book and chain constants for Arc (chain id 5042).
///
/// Every address below was confirmed by direct RPC call on 2026-08-23, not read from documentation.
/// The PoolManager runtime is BYTE-FOR-BYTE IDENTICAL to Robinhood Chain's (both keccak
/// 0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626), so this is the same audited
/// Uniswap v4 deployment rather than a fork, and it sits at the same address.
///
/// ─────────────────────────────────────────────────────────────────────────────
///  THREE WAYS ARC DIFFERS FROM ROBINHOOD CHAIN THAT CHANGE CONTRACT BEHAVIOUR.
///  Each of these has already produced a wrong answer once during bring-up.
/// ─────────────────────────────────────────────────────────────────────────────
///
/// 1. `block.number` IS THE REAL CHAIN HEIGHT, AT ~0.51 SECONDS PER BLOCK.
///    On Robinhood Chain (an Arbitrum Orbit chain) `block.number` returns the ETHEREUM L1 height and
///    ticks about every 12 seconds, which is why the dwell guard is denominated in it: a sequencer
///    cannot fast-forward L1. Arc is Malachite BFT with no L1 underneath, so the same number advances
///    roughly every half second. Carrying Robinhood's default of 300 across would turn a ~60 minute
///    dwell into a ~2.5 minute one — a 24x weaker guard, silently, with nothing reverting. See
///    MIN_DWELL_BLOCKS_ONE_HOUR below and never reuse the Robinhood figure here.
///
/// 2. GAS IS USDC, AND THE SAME BALANCE HAS TWO DECIMAL CONVENTIONS.
///    The NATIVE unit is 18-decimal; the ERC-20 view of the very same balance at USDC is 6-decimal.
///    They are one balance, not two assets, and there is no wrapper between them. A 6-vs-18 mix-up is
///    a 12-order-of-magnitude, fund-loss error.
///
/// 3. TRANSFERS TO address(0) REVERT.
///    Arc's USDC rejects the zero address as a recipient, so any "burn the dust" path that works
///    elsewhere fails closed here. Seed and sweep to a real address.
///
/// There is NO WETH on Arc and no canonical wrapped ETH of any kind, so a pool here is ERC-20/ERC-20
/// against USDC, or native-USDC paired with an ERC-20. Prefer the ERC-20 form: it keeps the 6-decimal
/// convention on both sides of the accounting and never touches the native path.
library ArcChain {
    /* ------------------------------------------------------------------ chain */

    uint256 internal constant CHAIN_ID = 5042;

    /* -------------------------------------------------------------- uniswap v4 */

    /// @dev Same address as Robinhood Chain, and verified byte-identical runtime.
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Canonical Arachnid deterministic deployer, 69 bytes, present on Arc. Hook mining needs it.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /// @dev NOT deployed on Arc: Uniswap's PositionManager and UniversalRouter have no code at their
    ///      canonical addresses. Nothing here needs them — MolePositions is our own custody core — but
    ///      do not assume periphery exists because the singleton does.

    /* ------------------------------------------------------------------ tokens */

    /// @notice USDC. Gas token AND ERC-20, one balance, 6 decimals through this interface.
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    uint8 internal constant USDC_DECIMALS = 6;

    /* -------------------------------------------------------------- chain timing */

    /// @notice Measured block time in milliseconds: 1000 blocks spanned 507 seconds on 2026-08-23.
    uint256 internal constant BLOCK_TIME_MS = 507;

    /// @notice Blocks in roughly one hour at the measured cadence (3600 / 0.507). USE THIS for the
    ///         dwell bound instead of Robinhood's 300, which is an L1-paced figure and means 2.5
    ///         minutes here.
    uint64 internal constant MIN_DWELL_BLOCKS_ONE_HOUR = 7100;

    /* ---------------------------------------------------------------- adversary */

    /// @notice Arc orders transactions through a BFT validator set of roughly twenty regulated
    ///         institutions with finality on inclusion and no reorgs — not a single sequencer. There is
    ///         still no public mempool, so MEV defences are written against privileged ordering, but a
    ///         reorg-based attack is not the threat model here.
    bool internal constant HAS_PUBLIC_MEMPOOL = false;

    /* ------------------------------------------------------------------ helpers */

    function isSupportedChain() internal view returns (bool) {
        return block.chainid == CHAIN_ID;
    }
}
