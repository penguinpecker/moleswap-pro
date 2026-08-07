// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {RHChain} from "../src/config/RHChain.sol";

interface IHasPoolManager {
    function poolManager() external view returns (address);
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
}

/// @notice Pins every fact this project's address book asserts, against the live chain.
///
/// This is deliberately the first test in the repo. Everything else we build assumes these facts, and
/// all of them are cheap to check and expensive to get wrong — a bad address or a wrong decimals value
/// is a fund-loss bug, not a failing unit test. Run against a fork so it re-verifies reality rather
/// than re-verifying our own constants:
///
///     forge test --match-contract RHChainFork --fork-url rh_mainnet -vv
contract RHChainForkTest is Test {
    /// @dev The canonical v4 PoolManager runtime size, identical on Base and Robinhood Chain.
    uint256 internal constant POOL_MANAGER_CODE_SIZE = 24_009;

    function setUp() public {
        // Skip cleanly when run without a fork, so `forge test` stays green offline.
        if (!RHChain.isSupportedChain()) vm.skip(true);
    }

    function test_chainIdIsRobinhoodMainnet() public view {
        assertEq(block.chainid, RHChain.CHAIN_ID_MAINNET, "not RH mainnet (46630 is the TESTNET)");
    }

    function test_poolManagerIsCanonicalV4() public view {
        uint256 size = RHChain.POOL_MANAGER.code.length;
        assertEq(size, POOL_MANAGER_CODE_SIZE, "PoolManager runtime size differs from canonical v4");
    }

    function test_peripheryPointsAtOurPoolManager() public view {
        assertEq(
            IHasPoolManager(RHChain.POSITION_MANAGER).poolManager(),
            RHChain.POOL_MANAGER,
            "PositionManager points elsewhere"
        );
        assertEq(
            IHasPoolManager(RHChain.STATE_VIEW).poolManager(), RHChain.POOL_MANAGER, "StateView points elsewhere"
        );
    }

    function test_deterministicDeployerPresent() public view {
        // Hook address mining is impossible without this. 69 bytes is the canonical Arachnid deployer.
        assertEq(RHChain.CREATE2_DEPLOYER.code.length, 69, "CREATE2 deployer missing or non-canonical");
        assertGt(RHChain.PERMIT2.code.length, 0, "Permit2 missing");
    }

    /// @notice USDG is SIX decimals. Treating it as 18 would overstate every stable amount by 1e12.
    function test_usdgIsSixDecimalsAndReal() public view {
        assertEq(IERC20Meta(RHChain.USDG).decimals(), RHChain.USDG_DECIMALS, "USDG decimals changed");
        assertEq(keccak256(bytes(IERC20Meta(RHChain.USDG).symbol())), keccak256("USDG"), "USDG symbol changed");
        // An impostor token would not carry a supply of this magnitude.
        assertGt(IERC20Meta(RHChain.USDG).totalSupply(), 1_000_000e6, "USDG supply implausibly small");
    }

    function test_wethIsEighteenDecimals() public view {
        assertEq(IERC20Meta(RHChain.WETH).decimals(), RHChain.WETH_DECIMALS, "WETH decimals changed");
    }

    /// @notice v4 cannot run without EIP-1153. Prove the opcodes execute rather than trusting the config.
    function test_transientStorageWorks() public {
        uint256 slot = 0x9e3a;
        assembly {
            tstore(slot, 0x2a)
        }
        uint256 got;
        assembly {
            got := tload(slot)
        }
        assertEq(got, 0x2a, "TSTORE/TLOAD unavailable - v4 cannot work here");
    }

    /// @notice TRAP 1, and the second trap hiding inside it: FOUNDRY FORKS DO NOT REPRODUCE THIS.
    ///
    /// On the real chain, `block.number` returns the ETHEREUM L1 height, not the L2 height. Measured
    /// simultaneously on 2026-08-01 against https://rpc.mainnet.chain.robinhood.com:
    ///
    ///     block.number via eth_call state-override .... 25,660,550   <- Ethereum L1 height
    ///     eth_blockNumber (real L2 head) .............. 25,102,181
    ///     block.l1BlockNumber field .................. 25,660,550   <- exact match
    ///
    /// Blocks are produced every ~100ms while `block.number` ticks every ~12s, so any duration written
    /// as "N blocks" is wrong by roughly 120x on this chain.
    ///
    /// The trap inside the trap: in a Foundry fork, `block.number` is the L2 height (Foundry sets it
    /// from eth_blockNumber), NOT the L1 height. So block.number-dependent logic behaves DIFFERENTLY
    /// in these tests than it will in production — and because the two heights are currently within
    /// 2% of each other (25.10M vs 25.66M), nothing looks wrong when it diverges.
    ///
    /// This is why the codebase rule is absolute: express every duration in `block.timestamp` seconds.
    /// `block.number` is used ONLY for anti-self-dealing and dwell guards, where L1 pacing is the point
    /// and where a fork-vs-production discrepancy is safe (the guard is merely stricter in production).
    /// Any test that needs true L1-paced behaviour must run against the live chain, not a fork.
    function test_blockNumberSemantics_forkDivergesFromProduction() public view {
        // In a fork this reads the L2 head; on-chain it reads the L1 head. Both are plausible values,
        // which is exactly why this cannot be asserted here — it is documented and pinned out-of-band.
        console2.log("block.number as seen in this fork (L2 height):", block.number);
        console2.log("block.timestamp:", block.timestamp);

        // What we CAN assert in a fork: timestamps are sane and usable as the duration source of truth.
        assertGt(block.timestamp, 1_700_000_000, "timestamp implausibly old");
        assertLt(block.timestamp, 4_000_000_000, "timestamp implausibly far in the future");
    }
}
