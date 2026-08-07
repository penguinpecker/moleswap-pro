// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolSwapTest} from "v4-core/test/PoolSwapTest.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {MoleHook} from "../../src/MoleHook.sol";
import {HookPermissions} from "../../src/config/HookPermissions.sol";
import {deployMoleVault, deployMoleVaultOwned, hookProxyArgs, deployMoleHookAnywhere, TEST_UPGRADE_ADMIN} from "../helpers/ProxyDeploy.sol";

/// @notice A realistic attacker: N one-wei swaps inside a SINGLE `unlock`, settled once at the end.
///         This exists to price the attack honestly — routing every dust swap through PoolSwapTest would
///         overstate the cost by the router's own overhead.
///
///         KEPT ARMED ON PURPOSE. The dust-crush primitive is the cheapest way on any chain to manufacture
///         swap COUNT, and swap count is what the deleted dynamic fee was really keyed on. The primitive
///         still reaches `afterSwap` -> `_write`, so it still has a live target: the ORACLE. Keeping it
///         armed is the only way to keep proving that a swap-count flood moves neither the fee nor the
///         oracle's recorded state.
contract DustResetter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function run(PoolKey calldata key, uint256 n, bool zeroForOne) external {
        pm.unlock(abi.encode(key, n, zeroForOne));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "not pm");
        (PoolKey memory key, uint256 n, bool zeroForOne) = abi.decode(data, (PoolKey, uint256, bool));

        for (uint256 i = 0; i < n; i++) {
            pm.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -1,
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
        }

        _resolve(key.currency0);
        _resolve(key.currency1);
        return "";
    }

    function _resolve(Currency c) internal {
        int256 d = pm.currencyDelta(address(this), c);
        if (d < 0) {
            pm.sync(c);
            MockERC20(Currency.unwrap(c)).transfer(address(pm), uint256(-d));
            pm.settle();
        } else if (d > 0) {
            pm.take(c, address(this), uint256(d));
        }
    }
}

/// @notice ATTACK ANGLE: the LP fee. POST-REMOVAL STATE OF THIS FILE.
///
/// WHAT THIS FILE USED TO ATTACK. MoleHook's stated purpose was "a volatility-scaled dynamic fee" that
/// charged more when flow was toxic. Every test here tried to make that claim false in a way a swapper
/// could actually execute on-chain, measured in tokens moved rather than in the events the hook emitted
/// about itself. Six separate defects were found and, one after another, patched: decay keyed on swap
/// count, no time basis at all, the surcharge dumped on the next trader, a private base-fee lane for the
/// griefer, and a falling-fee regime that sold its discount to whoever moved the price.
///
/// WHY THE FEATURE IS NOW GONE RATHER THAN FIXED, AND WHY THAT REWROTE THIS FILE. The central defect was
/// never reachable by another decay function: **the party that COLLECTS the fee is the party that can
/// MANUFACTURE the signal it is derived from.** With `restrictedLiquidity` the vault is the only LP and
/// therefore always dominates, and an adversarial pass measured exactly that — wash-trading the surcharge
/// to its ceiling inside one block at base fee, then collecting it from third-party flow (attacker
/// +114.9e18, third-party swappers -170.0e18). Two further defects died with it: decay compounded per
/// WRITE rather than per second, so a busier pool decayed faster and the surcharge under-applied exactly
/// when flow was heaviest; and an idle pool quoted its last surcharge forever, because nothing ages the
/// number without a swap.
///
/// WHAT REPLACED IT. One immutable `uint24 lpFeePips`. `beforeSwap` re-asserts it every swap with
/// OVERRIDE_FEE_FLAG, `currentFee` returns it, and no party — swapper, LP, griefer or sequencer — can move
/// it. Gone with the feature: minFeePips/baseFeePips/maxFeePips, volSensitivity, volWindow,
/// feeRisesWithVolatility, the volatility accumulator, `liveVol()`, `feeQuotes`, the block-lagged quote,
/// and the directional falling-fee regime.
///
/// HOW THESE TESTS CHANGED SHAPE. Every attack that still has machinery worth keeping is executed EXACTLY
/// AS BEFORE — same setup, same primitive, same measurement — and now asserts that the surface is GONE:
/// the fee is identical before and after, and the attacker's fill is wei-for-wei identical to the honest
/// trader's. A fee nobody can move is trivially safe to READ, so nothing here asserts on `currentFee`
/// alone: every claim is pinned either to the `FeeQuoted` value actually handed to the PoolManager for a
/// real swap, or to token balances. Two tests were DELETED outright because their subject (volSensitivity,
/// and the min/max clamp) no longer exists in any form; each is named at its former position rather than
/// left as a shell. The `assertGt(elevated, BASE_FEE)` premises that every attack used to open with are
/// gone too — there is no elevated state to reach — so where a test needed a fee DIFFERENCE to be
/// meaningful it now gets one the only legitimate way left: a second pool deployed at a different
/// immutable fee.
///
/// TIMEKEEPING. `vm.warp(block.timestamp + d)` and `vm.roll(block.number + n)` do NOT accumulate inside a
/// loop — solc caches both within a call frame. `_advance` keeps explicit `_clock`/`_height` counters and
/// is the only way time moves in this file.
contract AttackMoleHookFee is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    address internal treasury = makeAddr("treasury");

    int24 internal constant SPACING = 60;

    /// @dev The immutable LP fee every pool in this file is deployed with, unless a test needs two pools
    ///      priced differently. 0.30%.
    uint24 internal constant FEE = 3000;
    /// @dev The two ends of the range the constructor will accept: 1 pip, and MAX_FEE_CEILING. Used to
    ///      prove the charge is exact at both extremes, and to give the override test a real difference
    ///      to measure now that no pool can be driven from one fee to another.
    uint24 internal constant FEE_FLOOR = 1;
    uint24 internal constant FEE_CEILING = 100_000; // == MoleHook.MAX_FEE_CEILING, asserted below

    uint32 internal constant OBS_INTERVAL = 60;

    uint256 internal _clock;
    /// @dev Explicit block height. Same reason as _clock: block.number cannot change inside a call
    ///      frame either, so solc may cache it and `vm.roll(block.number + n)` in a loop would stall.
    uint256 internal _height;

    function _advance(uint256 secs) internal {
        _clock += secs;
        vm.warp(_clock);
        // Time passing implies blocks passing. Foundry's vm.warp does NOT advance block.number, so a
        // harness that only warps models a chain where the clock moves but no block is ever produced.
        // On Robinhood Chain block.number is the ETHEREUM L1 height (~12s per tick), so one tick per
        // advance is the conservative mapping.
        _height += 1 + secs / 12;
        vm.roll(_height);
    }

    function _hookAddr(uint256 seed) internal pure returns (address) {
        uint160 high =
            uint160(uint256(keccak256(abi.encode("molehook-fee-attack", seed)))) & ~HookPermissions.ALL_HOOK_MASK;
        return address(high | HookPermissions.REQUIRED_FLAGS);
    }

    function _deploy(uint256 seed, uint24 feePips) internal returns (MoleHook h) {
        return _deployWithHookFee(seed, feePips, 0);
    }

    function _deployWithHookFee(uint256 seed, uint24 feePips, uint24 hookFeePips) internal returns (MoleHook h) {
        address a = _hookAddr(seed);
        deployCodeTo(
            "ERC1967Proxy.sol:ERC1967Proxy",
            hookProxyArgs(manager, address(this), feePips, OBS_INTERVAL, false, hookFeePips, treasury, address(this)),
            a
        );
        h = MoleHook(a);
        assertEq(h.lpFeePips(), feePips, "deploy did not take the fee it was given");
    }

    function setUp() public {
        _clock = block.timestamp;
        _height = block.number;
        deployFreshManagerAndRouters();
        (currency0, currency1) = deployMintAndApprove2Currencies();
    }

    function _newPool(MoleHook h, int24 spacing, int24 lower, int24 upper, int128 liq)
        internal
        returns (PoolKey memory k)
    {
        k = PoolKey({
            currency0: currency0,
            currency1: currency1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: spacing,
            hooks: IHooks(address(h))
        });
        manager.initialize(k, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liq, salt: 0}), ZERO_BYTES
        );
    }

    function _swap(PoolKey memory k, bool zeroForOne, int256 amountSpecified) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    function _swapTo(PoolKey memory k, bool zeroForOne, int256 amountSpecified, int24 limitTick) internal {
        swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(limitTick)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
    }

    /// @dev Buy currency1 with `amountIn` of currency0; return currency1 received.
    function _buyOne(PoolKey memory k, uint256 amountIn) internal returns (uint256 out) {
        uint256 before = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this));
        _swap(k, true, -int256(amountIn));
        out = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this)) - before;
    }

    /// @dev The mirror of _buyOne: oneForZero, i.e. pushes the price UP.
    function _sellOne(PoolKey memory k, uint256 amountIn) internal returns (uint256 out) {
        uint256 before = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        _swap(k, false, -int256(amountIn));
        out = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)) - before;
    }

    /// @dev THE PRIMITIVE, UNCHANGED. N swaps of 1 wei in one transaction, no elapsed time, price
    ///      untouched. Each one still reaches afterSwap -> _write, so it is still a live probe against the
    ///      oracle even though the fee it was invented to crush no longer exists.
    function _dustReset(PoolKey memory k, uint256 n) internal returns (uint256 gasUsed) {
        uint256 g0 = gasleft();
        for (uint256 i = 0; i < n; i++) {
            _swap(k, true, -1);
        }
        gasUsed = g0 - gasleft();
    }

    /// @dev The fee (and the vestigial second field) out of the hook's own FeeQuoted event, i.e. the value
    ///      actually handed to the PoolManager for that swap. Reverts if the swap emitted none, so a test
    ///      can never pass by having quoted nothing at all.
    function _feeQuotedFromLogs() internal returns (uint24 fee) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FeeQuoted(bytes32,uint24)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) {
                return abi.decode(logs[i].data, (uint24));
            }
        }
        revert("no FeeQuoted event");
    }

    /// @dev Assert EVERY fee quoted since `vm.recordLogs()` equals `expected`, and return how many there
    ///      were. Callers assert the count, so a recording that captured no swaps cannot pass vacuously.
    function _everyFeeQuotedEquals(uint24 expected) internal returns (uint256 count) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("FeeQuoted(bytes32,uint24)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != sig) continue;
            uint24 f = abi.decode(logs[i].data, (uint24));
            assertEq(f, expected, "a swap in this window was quoted a different fee from the rest");
            count++;
        }
    }

    /* ================================================================================================
       F-1  (WAS: the volatility surcharge can be deleted on demand, for gas only, immediately before a
            trade.)  NOW: there is no surcharge to delete, and the dust primitive is kept armed to prove
            the deletion primitive has no target left.
       ================================================================================================ */

    /// @notice REGRESSION, CHANGED SHAPE. This test used to build a surcharged pool with eight real swaps
    ///         across real elapsed time, then delete the surcharge with 90 one-wei swaps and pocket it on
    ///         the next trade. There is no surcharged state to build any more, so the OPENING of the test
    ///         changed: the volatility burst is still executed (it is what the attack fed on, and it still
    ///         drives the oracle), but the premise it used to assert — `fee > base` — is now false by
    ///         construction and is replaced by its opposite. The ATTACK ITSELF is unchanged: same 90 dust
    ///         swaps, same trade, same block, same two-world measurement.
    function test_regression_dustSwapsCannotMoveTheFeeBecauseNothingCan() public {
        MoleHook h = _deploy(1, FEE);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);
        PoolId id = k.toId();

        // The volatility the surcharge used to feed on: real swaps across real elapsed time.
        vm.recordLogs();
        for (uint256 i = 0; i < 8; i++) {
            _advance(61);
            _swap(k, i % 2 == 0, -400e18);
        }
        assertEq(_everyFeeQuotedEquals(FEE), 8, "the volatility burst repriced itself");
        assertEq(h.currentFee(id), FEE, "eight volatile swaps moved the fee");

        uint256 TRADE = 300e18;

        // ---- World A: the honest trader.
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        uint256 outHonest = _buyOne(k, TRADE);
        uint24 honestFee = _feeQuotedFromLogs();
        vm.revertToState(snap);

        // ---- World B: the attacker runs the old reset, then makes the identical trade.
        (uint160 spBefore,,,) = StateLibrary.getSlot0(manager, id);
        uint256 gasUsed = _dustReset(k, 90);
        (uint160 spAfter,,,) = StateLibrary.getSlot0(manager, id);
        assertEq(spBefore, spAfter, "dust swaps moved the price - the reset is not free");
        console2.log("gas burned on the reset (via router)  :", gasUsed);

        vm.recordLogs();
        uint256 outAttack = _buyOne(k, TRADE);
        uint24 attackFee = _feeQuotedFromLogs();

        console2.log("fee the honest trader was charged     :", honestFee);
        console2.log("fee the attacker was charged          :", attackFee);
        console2.log("honest output (wei)                   :", outHonest);
        console2.log("attacker output (wei)                 :", outAttack);

        assertEq(honestFee, FEE, "the honest trader was not charged the pool's fee");
        assertEq(attackFee, honestFee, "90 dust swaps changed what the next swap was charged");
        // Wei-for-wei, not `<=`: any difference at all would mean the 90 dust swaps left the pool in a
        // different state for the trade that followed them.
        assertEq(outAttack, outHonest, "the dust reset changed the attacker's fill relative to the honest trader");
    }

    // DELETED: test_regression_atAFunctionalSensitivityTheResetIsWorthNothing.
    // It re-ran the test above at volSensitivity = 40e6 — the setting at which the surcharge was worth
    // whole percent rather than ~10 bps — and opened by asserting the pool sat near the 5% ceiling.
    // volSensitivity, the ceiling and the clamp are all gone, so both its premise and its subject are
    // unreachable; every remaining claim it made is the one asserted above, on the same primitive.

    /// @notice REGRESSION, KEPT ARMED. The honest price of the primitive: N dust swaps inside ONE unlock,
    ///         by a purpose-built contract, which is how it would really be executed. It no longer has a
    ///         fee to crush, so what it now proves is the strictly broader statement — a swap-count flood
    ///         with no elapsed time moves NOTHING a later swap is priced from: not the fee, not the price,
    ///         and not the oracle's recorded tick or cumulative.
    function test_regression_batchedDustInOneUnlockMovesNeitherTheFeeNorTheOracle() public {
        MoleHook h = _deploy(3, FEE);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);
        PoolId id = k.toId();

        for (uint256 i = 0; i < 8; i++) {
            _advance(61);
            _swap(k, i % 2 == 0, -400e18);
        }

        DustResetter d = new DustResetter(manager);
        MockERC20(Currency.unwrap(currency0)).transfer(address(d), 1e18);
        MockERC20(Currency.unwrap(currency1)).transfer(address(d), 1e18);

        (uint160 spBefore,,,) = StateLibrary.getSlot0(manager, id);
        (uint16 idxBefore,,, int24 tickBefore, int56 cumBefore,) = h.poolStates(id);

        uint256 g0 = gasleft();
        d.run(k, 200, true);
        uint256 gasUsed = g0 - gasleft();

        (uint160 spAfter,,,) = StateLibrary.getSlot0(manager, id);
        (uint16 idxAfter,,, int24 tickAfter, int56 cumAfter,) = h.poolStates(id);

        console2.log("gas for 200 batched dust swaps        :", gasUsed);
        console2.log("gas per dust swap                     :", gasUsed / 200);

        assertEq(h.currentFee(id), FEE, "batched dust moved the fee");
        assertEq(spBefore, spAfter, "batched dust moved the price");
        assertEq(tickBefore, tickAfter, "batched dust moved the oracle's recorded tick");
        assertEq(cumBefore, cumAfter, "batched dust moved the oracle cumulative with zero elapsed time");
        assertEq(idxBefore, idxAfter, "200 dust swaps advanced the observation ring inside one block");

        // And the swap that follows the flood is charged the same as ever.
        vm.recordLogs();
        _buyOne(k, 10e18);
        uint24 afterFlood = _feeQuotedFromLogs();
        assertEq(afterFlood, FEE, "the swap behind the flood was charged something else");
    }

    /* ================================================================================================
       F-2  (WAS: the volatility estimate has no time basis whatsoever, and — after that was fixed — an
            idle pool went on quoting its last surcharge forever.)  NOW: neither the clock nor the swap
            count is a lever, because there is nothing for either of them to move. The staleness residual
            that survived every version of the fix is gone with the feature that had it.
       ================================================================================================ */

    /// @notice REGRESSION, CHANGED SHAPE. This was the time-decay test: it built a surcharge, proved 90
    ///         dust swaps could not cool it, then advanced a year and proved the clock could. Time-decay
    ///         has no subject any more, so the test now targets what the decay design could never fix and
    ///         what killing the feature did: THE STALE QUOTE. The old hook decayed its accumulator lazily,
    ///         inside `_write`, so a pool that went quiet carried its last surcharge until somebody
    ///         traded, and the first trader back paid a fee earned by a market that no longer existed —
    ///         asserted, at the time, as a documented residual. Same burst, same year of silence, same
    ///         first-trader-back measurement; the assertion is now that the year buys and costs nothing.
    function test_regression_anIdlePoolDoesNotQuoteAStaleFee() public {
        MoleHook h = _deploy(4, FEE);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);
        PoolId id = k.toId();

        for (uint256 i = 0; i < 8; i++) {
            _advance(61);
            _swap(k, i % 2 == 0, -400e18);
        }

        uint256 TRADE = 100e18;

        // What the trade costs while the burst is still fresh.
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        uint256 outFresh = _buyOne(k, TRADE);
        uint24 freshFee = _feeQuotedFromLogs();
        vm.revertToState(snap);

        // Swap count is not a lever either: 90 dust swaps with the clock frozen change nothing.
        _dustReset(k, 90);
        assertEq(h.currentFee(id), FEE, "dust moved the fee");

        // ---- A year of silence. Nothing ages, because there is nothing to age.
        _advance(365 days);
        assertEq(h.currentFee(id), FEE, "a year of silence moved the fee");

        vm.recordLogs();
        uint256 outStale = _buyOne(k, TRADE);
        uint24 firstBackFee = _feeQuotedFromLogs();

        console2.log("fee while the burst was fresh (pips)  :", freshFee);
        console2.log("fee the first trader back pays (pips) :", firstBackFee);
        console2.log("fill while fresh (wei)                :", outFresh);
        console2.log("fill a year later (wei)               :", outStale);

        assertEq(freshFee, FEE, "the fresh trader was not charged the pool's fee");
        assertEq(firstBackFee, FEE, "the first trader back was charged a stale fee");
        // The strongest form of the claim: the year did not change the trade by a single wei. Under the
        // old design this was the assertion that could NOT be made — the stale surcharge was real money.
        assertEq(outStale, outFresh, "a year of silence changed what the same trade cost");

        // ...and the swap that ended the silence did not reprice the swaps behind it, in its block or
        // after it.
        vm.recordLogs();
        _buyOne(k, 1e18);
        uint24 sameBlock = _feeQuotedFromLogs();
        assertEq(sameBlock, FEE, "the first trader back repriced its own block");
        _advance(61);
        vm.recordLogs();
        _buyOne(k, 1e18);
        uint24 nextBlock = _feeQuotedFromLogs();
        assertEq(nextBlock, FEE, "the first trader back repriced the block after it");
    }

    /// @notice REGRESSION, CHANGED SHAPE. WAS test_F2b_oneOutOfBandPushLatchesTheCeilingForAYear, which
    ///         asserted the residual it is named for: a single push through a narrow ALM band — the shape
    ///         MolePositions actually creates — pinned the 5% ceiling one block later and STAYED pinned
    ///         for a year, because only a swap could record a fresher figure. The push is executed
    ///         unchanged, because it is the cheapest manufacture of "volatility" this pool shape allows;
    ///         what it now asserts is that it latches nothing on anybody, in its own block or a year out.
    function test_regression_anOutOfBandPushCannotLatchAFeeOnAnybody() public {
        MoleHook h = _deploy(5, FEE);
        PoolKey memory k = _newPool(h, SPACING, -600, 600, 5_000e18);
        PoolId id = k.toId();

        assertEq(h.currentFee(id), FEE, "fresh pool should quote its immutable fee");
        _advance(61);
        vm.recordLogs();
        _swapTo(k, true, -1_000_000e18, -400_000); // eat the band, then free-fall
        uint24 pusherFee = _feeQuotedFromLogs();
        assertEq(pusherFee, FEE, "the pusher was surcharged for its own push");

        // Its own block, including anything the pusher could have bundled behind itself.
        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 behindPush = _feeQuotedFromLogs();
        assertEq(behindPush, FEE, "a swap behind the push, same block, was repriced by it");

        // One block later — the point at which the old design promoted its staged figure and pinned the
        // ceiling.
        _advance(1);
        assertEq(h.currentFee(id), FEE, "the push landed a fee one block later");
        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 nextBlock = _feeQuotedFromLogs();
        assertEq(nextBlock, FEE, "the push landed a fee on the next block's swaps");

        // ...and a year later, which is how long the old pin lasted.
        _advance(365 days);
        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 aYearLater = _feeQuotedFromLogs();
        console2.log("fee one year after the push (pips)    :", aYearLater);
        assertEq(aYearLater, FEE, "the push was still being charged to somebody a year later");
    }

    /* ================================================================================================
       F-3  (WAS: the trader who causes the volatility never pays for it; the next trader does.)
            NOW: nobody's fee moves, so there is no cost to shift onto anybody.
       ================================================================================================ */

    /// @notice REGRESSION, SAME SHAPE. The maximally toxic trade — one that takes the whole band — is
    ///         still executed, and the next trader in the same block, the next block, and after an
    ///         observation interval are all still measured. What used to be a three-step dance around a
    ///         block-lagged quote is now one flat claim: every one of them is charged the identical fee,
    ///         and it is the pool's.
    function test_regression_noFeeCanBeDumpedOnTheNextTrader() public {
        MoleHook h = _deploy(6, FEE);
        PoolKey memory k = _newPool(h, SPACING, -600, 600, 5_000e18);
        PoolId id = k.toId();

        assertEq(h.currentFee(id), FEE, "fresh pool should quote its immutable fee");

        vm.recordLogs();
        _swap(k, true, -400e18); // maximally toxic: takes the whole band
        uint24 causerPaid = _feeQuotedFromLogs();
        console2.log("fee the volatility-causer paid (pips) :", causerPaid);
        assertEq(causerPaid, FEE, "the mover was surcharged for its own move");

        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 nextPaid = _feeQuotedFromLogs();
        console2.log("fee the NEXT trader paid (pips)       :", nextPaid);
        assertEq(nextPaid, causerPaid, "the causer's move reached the next trader inside the block");

        // An observation interval later — the point at which the old hook wrote its observation and,
        // one block after that, charged everybody for the move.
        _advance(61);
        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 afterInterval = _feeQuotedFromLogs();
        assertEq(afterInterval, causerPaid, "the move reached the fee one interval later");

        _advance(1);
        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 afterBlock = _feeQuotedFromLogs();
        console2.log("fee after the observation lands (pips):", afterBlock);
        assertEq(afterBlock, causerPaid, "the move reached the fee once its observation's block ended");
        assertEq(h.currentFee(id), FEE, "the pool ended up quoting something other than its immutable fee");
    }

    /* ================================================================================================
       F-4  (WAS: ceiling grief plus a private cheap lane — hold everyone else at 5% and still trade at
            0.30%.)  NOW: the grief still moves the price, and it costs the griefer exactly what it costs
            everybody else, because there is no fee to raise on the victims and no lane to buy.
       ================================================================================================ */

    /// @notice REGRESSION, KEPT ARMED. The full grief is still executed — push the tick clean out of the
    ///         band for the ordinary price of arbing a narrow range, let an LP re-provision around the new
    ///         price, then run the dust reset before trading. The measurement that mattered is unchanged:
    ///         the ordinary trader's fee and fill against the griefer's, side by side, from the same pool
    ///         state via snapshot. Both are now identical, which is the claim.
    function test_regression_grieferGetsNoPrivateLaneBecauseThereAreNoLanes() public {
        MoleHook h = _deploy(7, FEE);
        PoolKey memory k = _newPool(h, SPACING, -600, 600, 5_000e18);
        PoolId id = k.toId();

        // --- Step 1: the grief. Past the band the swap consumes no input at all, so the whole
        //     displacement costs only the ordinary price of arbing a narrow range.
        _advance(61);
        int256 c0Before = int256(MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)));
        int256 c1Before = int256(MockERC20(Currency.unwrap(currency1)).balanceOf(address(this)));
        _swapTo(k, true, -1_000_000e18, -400_000);
        int256 c0Spent = c0Before - int256(MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)));
        int256 c1Got = int256(MockERC20(Currency.unwrap(currency1)).balanceOf(address(this))) - c1Before;
        console2.log("attacker currency0 spent              :", c0Spent);
        console2.log("attacker currency1 received           :", c1Got);
        console2.log("net token cost of the grief           :", c0Spent - c1Got);

        assertEq(h.currentFee(id), FEE, "the grief repriced its own block");
        _advance(1);
        assertEq(h.currentFee(id), FEE, "the grief pinned a fee one block later");

        // An LP re-provisions around the new price so the pool is tradable again.
        (, int24 tick,,) = StateLibrary.getSlot0(manager, id);
        int24 lo = ((tick - 6_000) / SPACING) * SPACING;
        int24 hi = ((tick + 6_000) / SPACING) * SPACING;
        modifyLiquidityRouter.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 5_000e18, salt: bytes32(uint256(1))}),
            ZERO_BYTES
        );
        assertEq(h.currentFee(id), FEE, "re-provisioning moved the fee");

        // --- Step 2: the lane that used to be private. Both parties make the identical trade from the
        //     identical state; only one of them runs the reset first.
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        uint256 victimOut = _sellOne(k, 1e18);
        uint24 victimFee = _feeQuotedFromLogs();
        vm.revertToState(snap);

        _dustReset(k, 200);
        vm.recordLogs();
        uint256 grieferOut = _sellOne(k, 1e18);
        uint24 attackerFee = _feeQuotedFromLogs();

        console2.log("fee for an ordinary trader (pips)     :", victimFee);
        console2.log("fee for the griefer (pips)            :", attackerFee);
        console2.log("ordinary trader fill (wei)            :", victimOut);
        console2.log("griefer fill (wei)                    :", grieferOut);
        assertEq(victimFee, FEE, "the ordinary trader was not charged the pool's fee");
        assertEq(attackerFee, victimFee, "the griefer bought itself a different fee from its victims");
        assertEq(grieferOut, victimOut, "the griefer's fill differed from its victim's on the identical trade");
    }

    /* ================================================================================================
       F-5  (WAS: the falling-fee regime hands the fee FLOOR to whoever is moving the price, so a trader
            can buy the discount with the first slice of their own order — in one block, and later, after
            the block lag, across one observation interval, at 1,875 pips of a 400e18 trade.)
            NOW: `feeRisesWithVolatility` and the whole falling regime are gone. Both order-splitting
            attacks are kept and executed unchanged, because order splitting is free to attempt on any
            pool and is the exact shape that used to pay.
       ================================================================================================ */

    /// @notice REGRESSION, SAME SHAPE. The in-block split: one order broken into eight inside a single
    ///         block, which is how the discount used to be bought. Every slice is now quoted the same fee,
    ///         and splitting can only cost the trader price impact — never pay them.
    function test_regression_splitTradeInOneBlockCannotBuyABetterFee() public {
        MoleHook h = _deploy(8, FEE);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);
        PoolId id = k.toId();

        uint256 TRADE = 400e18;

        uint256 snap = vm.snapshotState();
        uint256 outSingle = _buyOne(k, TRADE);
        vm.revertToState(snap);

        // Same size, same direction, same block, split into 8.
        vm.recordLogs();
        uint256 outSplit;
        for (uint256 i = 0; i < 8; i++) {
            outSplit += _buyOne(k, TRADE / 8);
        }
        assertEq(_everyFeeQuotedEquals(FEE), 8, "the split did not quote all eight slices at the pool fee");

        console2.log("fee at the end of the split (pips)    :", h.currentFee(id));
        console2.log("single-swap output (wei)              :", outSingle);
        console2.log("split-swap output (wei)               :", outSplit);
        assertEq(h.currentFee(id), FEE, "the split moved the fee");
        assertLe(outSplit, outSingle, "splitting captured a discount");
    }

    /// @notice REGRESSION, CHANGED SHAPE. WAS test_ATTACK_fallingRegimeStillSellsTheDiscountOneIntervalLater
    ///         and then ...DiscountCannotBeBoughtByThePriceMover: move the price, wait one
    ///         `minObservationInterval` so the discount that move created went live, then push the SAME
    ///         way again at the fee floor. Measured at 1,875 pips of a 400e18 trade taken from the LPs;
    ///         the block lag never touched it, and it was eventually closed by making the discount
    ///         directional. The attack is executed unchanged — the interval waits and the second push are
    ///         all still here. What CHANGED is the second half: it used to assert that the corrective
    ///         trade still received the floor, so the test could not pass by the regime being quietly
    ///         disabled. There is no regime to disable now, so the corrective trade instead pins the
    ///         property that replaced it — the fee does not depend on which way a swap moves spot.
    function test_regression_thePriceMoverCannotBuyADiscountAcrossAnInterval() public {
        MoleHook h = _deploy(19, FEE);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);
        uint256 TRADE = 400e18;

        // ---- World A: the honest trader buys the whole size in one go.
        uint256 snap = vm.snapshotState();
        _advance(61);
        uint256 outSingle = _buyOne(k, TRADE);
        vm.revertToState(snap);

        // ---- World B: the attack, executed exactly as it was when it worked. A first slice creates the
        //      divergence; one interval passes so the observation lands and its block ends; the rest of
        //      the order is pushed the SAME way, hoping for the floor.
        _advance(61);
        vm.recordLogs();
        uint256 outSplit = _buyOne(k, TRADE / 8);
        uint24 firstSlice = _feeQuotedFromLogs();
        assertEq(firstSlice, FEE, "the first slice was not charged the pool fee");

        _advance(61);
        vm.recordLogs();
        outSplit += _buyOne(k, (TRADE * 7) / 8);
        uint24 chargedToMover = _feeQuotedFromLogs();

        console2.log("fee charged to the price-mover (pips) :", chargedToMover);
        console2.log("single-swap output (wei)              :", outSingle);
        console2.log("interval-split output (wei)           :", outSplit);

        assertEq(chargedToMover, FEE, "the price-mover was handed a fee of its own making");
        assertLe(outSplit, outSingle, "splitting across an interval extracted value from LPs");

        // ---- Direction is not a price. Build the exact state the old falling regime keyed on — an
        //      observation landed (which set the reference tick), then a further push in the SAME
        //      interval that the oracle has not recorded — and check both the trade that pushes further
        //      away and the trade that corrects back toward it.
        _advance(61);
        _buyOne(k, 1e18); // lands an observation
        _buyOne(k, 50e18); // same interval, unrecorded: spot is now below what the oracle saw

        vm.recordLogs();
        _sellOne(k, 5e18); // corrective: pushes back up toward the recorded tick
        uint24 chargedToCorrector = _feeQuotedFromLogs();
        vm.recordLogs();
        _buyOne(k, 5e18); // divergent: pushes further away
        uint24 chargedToDiverger = _feeQuotedFromLogs();

        console2.log("fee charged to the corrector (pips)   :", chargedToCorrector);
        console2.log("fee charged to the diverger (pips)    :", chargedToDiverger);
        assertEq(chargedToCorrector, FEE, "the corrective trade was priced differently from the pool fee");
        assertEq(chargedToDiverger, chargedToCorrector, "the fee depends on which way the swap moves spot");
    }

    /* ================================================================================================
       F-6  (WAS: the protocol fee — the whole reason afterSwapReturnDelta was mined — is opt-out via
            exact-output swaps.)  NOW: the fee is charged on the MAGNITUDE of the unspecified leg, so the
            exact-output route pays too. Note the leg it is paid IN changes: on an exact-output swap the
            unspecified leg is the INPUT currency, so revenue arrives in currency0 for a zeroForOne swap.
            Measuring the old currency would make this test pass vacuously.

            UNTOUCHED BY THE REMOVAL. The hook fee is a separate immutable on a separate leg; only the
            constructor arguments below changed.
       ================================================================================================ */

    function test_regression_theProtocolFeeIsNotAvoidableWithExactOutputSwaps() public {
        MoleHook h = _deployWithHookFee(16, FEE, 5_000);
        assertEq(h.hookFeePips(), 5_000, "premise failed: hook fee not configured");

        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);

        // --- Honest exact-input swap: the hook takes its cut out of the output (unspecified) leg.
        uint256 snap = vm.snapshotState();
        uint256 t0 = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        uint256 got = _buyOne(k, 10e18);
        uint256 feeOnExactIn = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury) - t0;
        console2.log("exact-input: currency1 received       :", got);
        console2.log("exact-input: fee paid to treasury (c1):", feeOnExactIn);
        assertGt(feeOnExactIn, 0, "premise failed: no fee on the honest path");
        vm.revertToState(snap);

        // --- The same fill, requested as exact OUTPUT. The unspecified leg is now the INPUT, so the cut
        //     is taken in currency0 — both currencies are measured so the dodge cannot hide in either.
        uint256 t1c0 = MockERC20(Currency.unwrap(currency0)).balanceOf(treasury);
        uint256 t1c1 = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        uint256 c0Before = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        uint256 c1Before = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this));
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: true, amountSpecified: int256(got), sqrtPriceLimitX96: MIN_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        uint256 feeOutC0 = MockERC20(Currency.unwrap(currency0)).balanceOf(treasury) - t1c0;
        uint256 feeOutC1 = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury) - t1c1;
        uint256 paid = c0Before - MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        uint256 received = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this)) - c1Before;

        console2.log("exact-output: currency0 paid          :", paid);
        console2.log("exact-output: currency1 received      :", received);
        console2.log("exact-output: fee to treasury (c0)    :", feeOutC0);
        console2.log("exact-output: fee to treasury (c1)    :", feeOutC1);

        assertEq(received, got, "the two routes did not deliver the same fill");
        assertEq(feeOutC1, 0, "the fee was charged on the specified leg, which the hook may not touch");
        assertGt(feeOutC0, 0, "the exact-output route still paid the protocol no fee at all");

        // The two routes must cost the same to within rounding: at a 1:1 pool price, 0.5% of the input is
        // 0.5% of the output, so a router cannot pick a cheaper way to express the same fill.
        assertGe(feeOutC0, (feeOnExactIn * 99) / 100, "exact-output is still a materially cheaper route");
        assertLe(feeOutC0, (feeOnExactIn * 101) / 100, "exact-output is charged materially more than exact-input");
        // ...and dodging is not free on the swapper's side either: the extra input is really collected.
        assertGt(paid, got, "the exact-output swapper paid no more than it received at a 1:1 price");
        console2.log("protocol revenue no longer avoidable  :", feeOutC0);
    }

    /// @notice REGRESSION in the other direction, so the result is not an artifact of leg ordering. For a
    ///         oneForZero exact-output swap the unspecified leg is currency1.
    function test_regression_exactOutputPaysTheFeeInBothDirections() public {
        MoleHook h = _deployWithHookFee(17, FEE, 5_000);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);

        uint256 t0 = MockERC20(Currency.unwrap(currency0)).balanceOf(treasury);
        _swap(k, false, -10e18); // oneForZero, exact input -> fee is charged in currency0
        uint256 feeIn = MockERC20(Currency.unwrap(currency0)).balanceOf(treasury) - t0;
        assertGt(feeIn, 0, "premise failed");

        uint256 t1c0 = MockERC20(Currency.unwrap(currency0)).balanceOf(treasury);
        uint256 t1c1 = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        swapRouter.swap(
            k,
            SwapParams({zeroForOne: false, amountSpecified: int256(1e18), sqrtPriceLimitX96: MAX_PRICE_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ZERO_BYTES
        );
        uint256 feeOutC0 = MockERC20(Currency.unwrap(currency0)).balanceOf(treasury) - t1c0;
        uint256 feeOutC1 = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury) - t1c1;
        console2.log("oneForZero exact-input fee (c0)       :", feeIn);
        console2.log("oneForZero exact-output fee (c1)      :", feeOutC1);
        assertEq(feeOutC0, 0, "the fee was charged on the specified leg");
        assertGt(feeOutC1, 0, "exact-output still dodged the fee in this direction");
        // 0.5% of the input needed for 1e18 out, at a ~1:1 price.
        assertApproxEqRel(feeOutC1, 1e18 * 5_000 / 1_000_000, 0.01e18, "the exact-output cut is the wrong size");
    }

    /// @notice A token that blocklists the fee recipient must cost the protocol its fee, never the swap.
    ///         `take` is wrapped in try/catch for exactly this; with `feeRecipient` unable to receive, the
    ///         swap must still settle and the swapper must still be filled.
    function test_control_aFailingFeeTakeForgoesRevenueInsteadOfBrickingTheSwap() public {
        MoleHook h = _deployWithHookFee(20, FEE, 5_000);
        assertEq(h.hookFeePips(), 5_000, "premise failed: hook fee not configured");
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);

        // Baseline: the identical swap with the recipient NOT blocked, so the blocked run below cannot
        // pass by simply never having charged a fee in the first place.
        uint256 t0 = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury);
        uint256 snap = vm.snapshotState();
        uint256 outPaying = _buyOne(k, 10e18);
        uint256 feePaid = MockERC20(Currency.unwrap(currency1)).balanceOf(treasury) - t0;
        vm.revertToState(snap);
        assertGt(feePaid, 0, "premise failed: the fee path pays the treasury nothing even unblocked");

        // Make every transfer to the fee recipient revert, exactly as a blocklisting token would.
        vm.mockCallRevert(
            Currency.unwrap(currency1),
            abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), treasury),
            "BLOCKLISTED"
        );
        vm.recordLogs();
        uint256 out = _buyOne(k, 10e18);
        uint24 quotedWhileBlocked = _feeQuotedFromLogs();
        vm.clearMockedCalls();

        console2.log("fill when the fee is payable (wei)    :", outPaying);
        console2.log("fill when the recipient is blocked    :", out);
        console2.log("fee forgone (wei)                     :", feePaid);
        assertGt(out, 0, "the swap did not settle when the fee transfer reverted");
        assertEq(MockERC20(Currency.unwrap(currency1)).balanceOf(treasury), t0, "fee moved despite the blocklist");
        // The forgone revenue stays with the swapper, wei for wei — proof the catch branch is what ran.
        assertEq(out - outPaying, feePaid, "the blocked fee was not forgone cleanly");
        // The LP fee is untouched by the hook fee failing: the swapper still paid the pool's fee.
        assertEq(quotedWhileBlocked, FEE, "a failing hook-fee take changed the LP fee the swapper paid");
    }

    /* ================================================================================================
       CONTROLS — things I attacked and could NOT break. These must keep passing.
       ================================================================================================ */

    // DELETED: test_control_absurdSensitivityDoesNotOverflowTheQuote.
    // It deployed at volSensitivity = type(uint96).max and asserted the quote saturated at the ceiling
    // instead of overflowing. There is no sensitivity, no accumulator and no quote arithmetic left to
    // overflow — beforeSwap returns an immutable — so the test had no subject. The extreme-swap machinery
    // it used (a million-token push to MIN_TICK and back) is preserved in
    // test_control_maximumTickMoveDoesNotCorruptTheOracleOrTheFee below, which still has a live target.

    // RENAMED AND REPOINTED: test_control_quoteFeeStaysInsideItsBoundsUnderEveryAttack.
    // `_quoteFee`, minFeePips and maxFeePips are gone, so "the clamp is total" is not a statement about
    // anything. Its replacement is the test immediately below, which keeps the same six-round
    // million-token attack loop and the same two-pools-at-once structure, but asserts the stronger
    // property that survived: at BOTH ends of the range the constructor accepts, every swap is charged
    // that pool's exact fee, and the two pools never contaminate each other.

    /// @notice CONVERTED from the bounds control. Two hooks, deployed at the extreme ends of the fee range
    ///         the constructor accepts (1 pip and MAX_FEE_CEILING), attacked simultaneously with the same
    ///         six rounds of million-token swaps that used to drive the old quote to saturation. Every
    ///         swap must be charged its own pool's exact fee — no drift, no clamping, no crosstalk.
    function test_control_bothEndsOfTheFeeRangeAreChargedExactlyUnderEveryAttack() public {
        MoleHook low = _deploy(9, FEE_FLOOR);
        MoleHook high = _deploy(10, FEE_CEILING);
        assertEq(FEE_CEILING, low.MAX_FEE_CEILING(), "the ceiling under test is not the contract's ceiling");

        PoolKey memory kl = _newPool(low, 10, -600, 600, 5_000e18);
        PoolKey memory kh = _newPool(high, 20, -600, 600, 5_000e18);

        for (uint256 i = 0; i < 6; i++) {
            _advance(61);

            vm.recordLogs();
            _swap(kl, i % 2 == 0, -1_000_000e18);
            assertEq(_everyFeeQuotedEquals(FEE_FLOOR), 1, "the 1-pip pool did not charge exactly 1 pip");

            vm.recordLogs();
            _swap(kh, i % 2 == 0, -1_000_000e18);
            assertEq(_everyFeeQuotedEquals(FEE_CEILING), 1, "the ceiling pool did not charge exactly the ceiling");
        }

        assertEq(low.currentFee(kl.toId()), FEE_FLOOR, "the 1-pip pool drifted");
        assertEq(high.currentFee(kh.toId()), FEE_CEILING, "the ceiling pool drifted");
        // Cross-check: a hook's fee is per-DEPLOYMENT, and asking either one about the other's pool still
        // returns its own number, because the pool id is not read at all.
        assertEq(low.currentFee(kh.toId()), FEE_FLOOR, "a foreign pool id changed what a hook quotes");
        assertEq(high.currentFee(kl.toId()), FEE_CEILING, "a foreign pool id changed what a hook quotes");
    }

    /// @notice CONVERTED from test_control_maximumTickMoveDoesNotWrapTheVolAccumulator. The widest possible
    ///         single move (MIN_TICK -> MAX_TICK) no longer has an accumulator to wrap, but it still runs
    ///         through the int24/int56 arithmetic in `_write` — so the machinery is kept and pointed at the
    ///         target that survived: the oracle's recorded tick must equal the pool's real tick after the
    ///         widest move representable, and the fee must be untouched by it.
    function test_control_maximumTickMoveDoesNotCorruptTheOracleOrTheFee() public {
        MoleHook h = _deploy(11, FEE);
        PoolKey memory k = _newPool(h, 10, -600, 600, 5_000e18);
        PoolId id = k.toId();

        _advance(61);
        _swap(k, true, -1_000_000e18); // -> MIN_TICK
        (, int24 tickMin,,) = StateLibrary.getSlot0(manager, id);
        (,,, int24 recordedMin, int56 cumMin,) = h.poolStates(id);
        assertEq(recordedMin, tickMin, "the oracle recorded a different tick from the pool at MIN_TICK");

        _advance(61);
        _swap(k, false, -1_000_000e18); // -> MAX_TICK, the widest single move possible
        (, int24 tickMax,,) = StateLibrary.getSlot0(manager, id);
        (,,, int24 recordedMax, int56 cumMax,) = h.poolStates(id);
        assertEq(recordedMax, tickMax, "the oracle recorded a different tick from the pool at MAX_TICK");
        assertGt(recordedMax, recordedMin, "the widest possible tick move wrapped the recorded tick");
        // 61 seconds were spent at the deeply negative tick before the second swap, so the cumulative must
        // have moved DOWN by exactly that, not wrapped.
        assertEq(
            cumMax, cumMin + int56(61) * int56(recordedMin), "the cumulative wrapped across the widest tick move"
        );

        console2.log("tick after the max-width move         :", tickMax);
        assertEq(h.currentFee(id), FEE, "the widest possible move changed the fee");
        _advance(61);
        vm.recordLogs();
        _swap(k, true, -1e18); // and a swap still goes through
        uint24 after_ = _feeQuotedFromLogs();
        assertEq(after_, FEE, "a swap after the max-width move was charged something else");
    }

    /// @notice The override is per-swap and the STORED dynamic fee is never rewritten after creation, so
    ///         there is no way to desync slot0 from what the swapper actually pays. Under the dynamic fee
    ///         these two were expected to DIVERGE (storage held base, the override held the quote); the
    ///         claim is now the opposite and stronger — they must be equal forever, including after the
    ///         swaps that used to drive them apart.
    function test_control_storedLpFeeMatchesTheOverrideAndNeverDrifts() public {
        MoleHook h = _deploy(12, FEE);
        PoolKey memory k = _newPool(h, SPACING, -600, 600, 5_000e18);
        PoolId id = k.toId();

        (,,, uint24 storedAtBirth) = StateLibrary.getSlot0(manager, id);
        assertEq(storedAtBirth, FEE, "afterInitialize did not store the immutable fee");

        _advance(61);
        _swap(k, true, -400e18); // out of the band: the move that used to diverge the two
        (,,, uint24 storedFee) = StateLibrary.getSlot0(manager, id);
        assertEq(storedFee, FEE, "stored dynamic fee drifted");
        assertEq(h.currentFee(id), storedFee, "the quote diverged from storage");

        _advance(1);
        vm.recordLogs();
        _swap(k, false, -1e18);
        uint24 handedToManager = _feeQuotedFromLogs();
        assertEq(handedToManager, storedFee, "the override handed to the PoolManager differed from storage");
        // The "no volatility figure was published" half of this assertion is gone because the event no
        // longer HAS that field — the ABI itself is now the proof, which is stronger than an assertion.
        (,,, uint24 storedAfter) = StateLibrary.getSlot0(manager, id);
        assertEq(storedAfter, FEE, "the override rewrote the stored dynamic fee");
    }

    /// @notice A 1-wei swap really is free of price impact at every fee level — which is what made the
    ///         reset primitive cost nothing but gas, and is why every dust attack above is cheap enough to
    ///         be worth defending against in the first place.
    function test_control_dustSwapsNeverMoveThePrice() public {
        MoleHook h = _deploy(13, FEE);
        PoolKey memory k = _newPool(h, SPACING, -60_000, 60_000, 5_000e18);
        PoolId id = k.toId();

        _swap(k, true, -400e18);
        (uint160 sp0, int24 t0,,) = StateLibrary.getSlot0(manager, id);
        uint256 bal0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        _dustReset(k, 120);
        (uint160 sp1, int24 t1,,) = StateLibrary.getSlot0(manager, id);
        uint256 bal1 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));

        assertEq(sp0, sp1, "dust moved the price");
        assertEq(t0, t1, "dust moved the tick");
        console2.log("currency0 consumed by 120 dust swaps  :", bal0 - bal1);
        assertLe(bal0 - bal1, 120, "dust cost more than 1 wei per swap");
    }

    /// @notice CONVERTED. The hook's fee override really does reach the swapper's wallet. This used to be
    ///         proven by driving ONE pool from base to the ceiling and comparing fills across the change —
    ///         which is no longer possible, because no pool's fee can change. The only honest way left to
    ///         produce a fee difference is two deployments, so the identical trade is run against two
    ///         identical pools whose hooks differ ONLY in `lpFeePips`, and the difference in fills is
    ///         checked against what that fee gap is worth.
    function test_control_theFeeOverrideIsGenuinelyApplied() public {
        uint256 TRADE = 100e18;

        uint256 snap = vm.snapshotState();
        MoleHook cheap = _deploy(14, 500); // 0.05%
        PoolKey memory kc = _newPool(cheap, SPACING, -60_000, 60_000, 5_000e18);
        vm.recordLogs();
        uint256 outCheap = _buyOne(kc, TRADE);
        uint24 cheapFee = _feeQuotedFromLogs();
        vm.revertToState(snap);

        // Same pool shape, same trade, same starting price — only the immutable fee differs.
        MoleHook dear = _deploy(15, 50_000); // 5%
        PoolKey memory kd = _newPool(dear, SPACING, -60_000, 60_000, 5_000e18);
        vm.recordLogs();
        uint256 outDear = _buyOne(kd, TRADE);
        uint24 dearFee = _feeQuotedFromLogs();

        console2.log("output at 0.05% (wei)                 :", outCheap);
        console2.log("output at 5%    (wei)                 :", outDear);
        console2.log("difference (wei)                      :", outCheap - outDear);

        assertEq(cheapFee, 500, "the cheap pool did not quote its own fee");
        assertEq(dearFee, 50_000, "the dear pool did not quote its own fee");
        assertGt(outCheap, outDear, "the fee override is not reaching the swap at all");

        // The gap must be worth the 49,500 pips of notional that the two fees differ by, not some rounding
        // artifact. It is bounded on BOTH sides, and neither bound is a guessed tolerance:
        //   * strictly BELOW the notional difference, because the cheap trade puts more input into the
        //     curve and the extra input buys output at a progressively worse marginal price. A gap at or
        //     above it would mean the swapper was charged more than the fee difference;
        //   * at least 90% of it, which is the room that price impact on a 100e18 trade against 5,000e18
        //     of liquidity can account for. Measured: 4.7625e18 of a 4.95e18 notional difference, 96.2%.
        uint256 notionalGap = (TRADE * (50_000 - 500)) / 1_000_000;
        console2.log("difference the two fees are worth     :", notionalGap);
        assertLt(outCheap - outDear, notionalGap, "the swapper lost more than the two fees differ by");
        assertGe(outCheap - outDear, (notionalGap * 9) / 10, "the fee gap did not reach the swapper's wallet");
    }
}
