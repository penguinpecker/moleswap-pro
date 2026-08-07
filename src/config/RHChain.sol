// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title RHChain
/// @notice Verified address book and chain constants for Robinhood Chain.
///
/// Every address here was confirmed by direct RPC call on 2026-08-01, not read from documentation:
/// eth_getCode returned non-empty for each contract, and each periphery contract's poolManager()
/// was checked to match POOL_MANAGER. The PoolManager runtime is byte-for-byte identical to Base's
/// canonical v4 PoolManager apart from the 20 bytes holding its own address, so this is the audited
/// Uniswap deployment rather than a fork.
///
/// NEVER resolve a token on this chain by symbol. There is no canonical USDC here; both explorer
/// entries named "USD Coin" are 18-decimal impostors, there are six distinct tokens named INTC, and
/// a fake MSFT. The stable leg is USDG at SIX decimals, and a 6-vs-18 decimals mistake is a fund-loss
/// bug.
///
/// WHERE THAT IS ACTUALLY CHECKED, stated precisely because it used to be stated wrongly. This header
/// claimed USDG_DECIMALS was "asserted against the token at deploy time". It is not, and there is nowhere
/// for such an assertion to live: script/Deploy.s.sol deploys the hook and the vault, both of which are
/// token-agnostic and never name a token. The real check is test/RHChainFork.t.sol, which reads
/// `decimals()` from the live token over RPC — and which SKIPS ITSELF when the run is not forked against
/// RH, so on a normal `forge test` nothing verifies it at all. Choosing the token pair is an operator
/// decision made when a pool is created, and this library is the reference for making it correctly.
library RHChain {
    /* ------------------------------------------------------------------ chain */

    /// @dev Mainnet. Note 46630 is the TESTNET — an easy and expensive confusion.
    uint256 internal constant CHAIN_ID_MAINNET = 4663;
    uint256 internal constant CHAIN_ID_TESTNET = 46630;

    /* ------------------------------------------------- uniswap v4 (same on both) */

    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant POSITION_MANAGER = 0x58daec3116aae6D93017bAAea7749052E8a04fA7;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    /// @dev Verified but not referenced by any contract in this repo: nothing here quotes or routes.
    ///      Kept because re-verifying an address by RPC later is strictly more work than carrying a
    ///      `internal constant`, which costs zero bytecode until something reads it.
    address internal constant QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev Canonical Arachnid deterministic deployer, 69 bytes. Required for hook address mining.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /* ------------------------------------------------------------------ tokens */

    /// @notice Paxos "Global Dollar". THE STABLE LEG. Six decimals, not eighteen.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint8 internal constant USDG_DECIMALS = 6;

    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint8 internal constant WETH_DECIMALS = 18;

    /* -------------------------------------------------------------- chain timing */

    /// @notice Measured L2 block time, in milliseconds. ~100ms, versus Ethereum's ~12s.
    ///
    /// This matters more than it looks. On this Arbitrum Orbit chain, `block.number` inside the EVM
    /// returns the ETHEREUM L1 block height, not the L2 height — measured simultaneously on
    /// 2026-08-01: block.number = 25,660,521 while the real chain head was 25,098,710. So
    /// `block.number` advances roughly every 12 seconds while blocks are produced every 100ms.
    ///
    /// Consequences, and both directions are used deliberately in this codebase:
    ///   - Durations, epochs, decay and TWAP windows MUST be expressed in `block.timestamp` seconds.
    ///     Any parameter written as "N blocks" is wrong here by a factor of about 120.
    ///   - Anti-self-dealing and dwell guards SHOULD use `block.number`, precisely because it is
    ///     L1-paced: the sequencer cannot advance it by producing blocks, so one tick is ~12 seconds
    ///     of real Ethereum progress that cannot be faked. Against `block.timestamp`, which the
    ///     sequencer sets, the same guard is far weaker.
    uint256 internal constant L2_BLOCK_TIME_MS = 100;

    /// @notice Approximate seconds per `block.number` increment (i.e. per L1 block).
    uint256 internal constant SECONDS_PER_BLOCK_NUMBER_TICK = 12;

    /* ---------------------------------------------------------------- adversary */

    /// @notice This chain has NO public mempool: txpool_status and pending-tx filters are not
    /// exposed, and a single centralized sequencer orders every transaction. MEV defences must
    /// therefore be written against a privileged sequencer that sees everything and orders at will,
    /// not against searchers racing in a public mempool. Private-orderflow style mitigations are
    /// meaningless here; TWAP bounds and batch settlement are what remain.
    bool internal constant HAS_PUBLIC_MEMPOOL = false;

    /* ------------------------------------------------------------------ helpers */

    /// @dev `isMainnet()` was removed rather than left unused. Nothing called it, and a chain guard that
    ///      exists but is never invoked is worse than no guard: the next person to need one is as likely
    ///      to reach for it as for `isSupportedChain()`, and on this chain those two differ by 46630 —
    ///      the testnet id that the header at the top of this file calls "an easy and expensive
    ///      confusion". One chain predicate, used everywhere, is the safer shape.
    function isSupportedChain() internal view returns (bool) {
        return block.chainid == CHAIN_ID_MAINNET || block.chainid == CHAIN_ID_TESTNET;
    }
}
