// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {LPFeeLibrary} from "v4-core/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {HookPermissions} from "./config/HookPermissions.sol";
import {DeployConfig} from "./config/DeployConfig.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @title MoleHook
/// @notice The hook half of moleswap-pro: the price oracle v4 does not ship, a FIXED LP fee, pool
///         admission at creation, and an optional restriction on who may provide liquidity.
///
/// WHAT THIS DELIBERATELY IS NOT. There is no volatility-scaled dynamic fee — it was deleted rather than
/// repaired, because the party that collects such a fee is the party that can manufacture the signal
/// behind it (see `lpFeePips`). And the liquidity restriction is NOT a JIT defence; see
/// `restrictedLiquidity` for what it actually does and why JIT on the exit side is unpreventable here.
///
/// WHY THIS CONTRACT MUST EXIST AT ALL. Uniswap v4 deleted v3's oracle: there is no `observe()`, no
/// `observations[]`, no `tickCumulative` anywhere in v4-core (verified against the vendored source, not
/// assumed). Slot0 carries only sqrtPriceX96/tick/protocolFee/lpFee. So every TWAP this product relies on
/// is first-party code — this file — and it costs an SSTORE on the swap path. That cost is the reason the
/// observation write is time-gated rather than per-swap.
///
/// THE ADDRESS IS THE PERMISSIONS. This contract must be reached at an address whose low 14 bits equal
/// HookPermissions.REQUIRED_FLAGS (0x38C4): beforeInitialize, afterInitialize, beforeAddLiquidity,
/// beforeSwap, afterSwap, afterSwapReturnDelta. `initialize` asserts its own address, so a mis-mined
/// deployment reverts instead of silently running with the wrong callbacks wired.
///
/// UNDER THE PROXY, THE MINED ADDRESS IS THE PROXY'S. The PoolManager only ever sees the proxy, and
/// `initialize` runs by delegatecall so its address check reads the proxy too. The implementation's own
/// address is irrelevant and is deliberately unmined. This is also why the permission bits — and the
/// unblockable-exit guarantee that rests on them — survive any upgrade: an upgrade changes the code
/// behind an address, never the address.
///
/// WHAT THIS HOOK DELIBERATELY CANNOT DO. None of the three remove-liquidity bits are mined, so the
/// PoolManager physically cannot call this contract when a user withdraws. That makes exits unblockable by
/// construction — no bug, key compromise or pause here can trap a withdrawal — and it permanently costs us
/// any exit fee, any JIT penalty at removal, and any minimum-age-on-exit rule. The JIT defence below is
/// therefore ADD-SIDE ONLY, and that asymmetry is a design decision, not an oversight.
contract MoleHook is IHooks, Initializable, UUPSUpgradeable {
    using PoolIdLibrary for PoolKey;
    using LPFeeLibrary for uint24;

    /* ------------------------------------------------------------------- types */

    /// @dev One ring-buffer entry. Packed into a single slot: 32 + 56 + 8 bits.
    struct Observation {
        uint32 blockTimestamp;
        int56 tickCumulative;
        bool initialized;
    }

    /// @dev Per-pool oracle state, packed into ONE slot (168 bits: 16+32+32+24+56+8).
    ///      `lastTimestamp`/`lastTick` extend the cumulative without touching the ring.
    ///      `lastObsTimestamp` is the load-bearing one: the ring write MUST be gated on time since the
    ///      last OBSERVATION, not time since the last SWAP. Gating on the swap clock means a pool busier
    ///      than the interval never writes at all — and then reads stale forever, silently.
    struct PoolState {
        uint16 index;
        uint32 lastTimestamp; // last swap that touched this pool
        uint32 lastObsTimestamp; // last ring write
        int24 lastTick;
        int56 tickCumulative;
        bool initialized;
    }

    /* --------------------------------------------------------------- immutable */

    IPoolManager public poolManager;

    /// @notice May create pools bound to this hook. Pool creation seeds state we later trust, which is the
    ///         entire reason beforeInitialize is mined; leaving it open would let anyone plant a pool.
    address public poolCreator;

    /// @notice The pool's LP fee, in pips (1e6 = 100%). FIXED, and deliberately so.
    ///
    ///         THIS USED TO BE A VOLATILITY-SCALED DYNAMIC FEE. It was removed rather than repaired,
    ///         because the central problem is not implementable away: **the party that collects the fee is
    ///         the party that can manufacture the signal it is derived from.** With `restrictedLiquidity`
    ///         the vault is the only LP, so it always holds the dominant share — and an adversarial pass
    ///         measured exactly that, wash-trading the surcharge to its ceiling inside one block at base
    ///         fee and then collecting it from third-party flow (attacker +114.9e18, swappers -170.0e18).
    ///         No decay function fixes that; a better one only changes the price of the manufacture.
    ///
    ///         Two further defects fell out of the same machinery and are deleted with it: the decay
    ///         compounded per WRITE rather than per second, so a busier pool decayed faster and the
    ///         surcharge under-applied exactly when flow was heaviest; and an idle pool quoted its last
    ///         surcharge indefinitely, because nothing ages the number without a swap.
    ///
    ///         It also settles learnings.txt §1.10 C4 — "should the fee rise or fall with volatility?" —
    ///         which was never resolved and shipped as a constructor flag. The evidenced answer is
    ///         neither: a fee derived from manipulable state, collected by whoever can manipulate it, is
    ///         not safe in either direction on a pool this thin.
    ///
    ///         The dynamic-fee PLUMBING is kept because the bit is mined and permanent. To be exact about
    ///         what that buys: there is no governance entry point here — `lpFeePips` has no setter — so
    ///         changing the fee means shipping a new implementation, which is visible on chain. What the
    ///         plumbing preserves is the OPTION for a future version to add a setter without re-mining
    ///         the address. NOTE that this contract is upgradeable, so "no setter" bounds who can change
    ///         the fee QUIETLY, not who can change it at all.
    uint24 public lpFeePips;

    /// @notice Minimum seconds between oracle writes. Bounds the SSTORE cost the oracle adds to swaps; the
    ///         cumulative itself is exact regardless, because it is extended by elapsed*lastTick.
    uint32 public minObservationInterval;

    /// @notice If true, only allowlisted addresses may add liquidity.
    ///
    ///         THIS IS NOT A JIT DEFENCE, AND CALLING IT ONE WAS WRONG. The hook is handed the address
    ///         that called PoolManager.modifyLiquidity — which is the VAULT, never the depositor. The
    ///         vault (MolePositions) is permissionless by design and its exits are unblockable by
    ///         construction, so anyone can open, swap and withdraw in a single transaction and the
    ///         allowlist sees only an approved caller throughout. Measured: a stranger JIT-sandwiching
    ///         through the vault took ~99% of an honest depositor's fee income.
    ///
    ///         JIT on the exit side is STRUCTURALLY UNPREVENTABLE here, and deliberately so: it is the
    ///         price of the remove-liquidity bits being unmined, which is what makes withdrawals
    ///         impossible to block. That trade was made knowingly (see the header) and this flag does not
    ///         undo it. What the flag actually does is keep THIRD-PARTY LPs out of the pool, so the
    ///         vault's depositors are not diluted by outside liquidity — a real property, just not that one.
    ///
    ///         NOTE THE SIDE EFFECT, which is not obvious: with the vault as the only LP the pool has
    ///         regions of ZERO liquidity, and in those regions a swap moves spot arbitrarily far for
    ///         almost nothing. That is what makes the oracle walkable, and it is why the keeper's
    ///         price-independent `maxRecenterTicks` bound exists rather than relying on the TWAP alone.
    bool public restrictedLiquidity;

    /// @notice Protocol fee taken from swaps, in pips, via the afterSwapReturnDelta bit.
    /// @dev May be zero. The bit is mined because it can never be added later (Part 16 conflict C1), but
    ///      whether it is USED is a live product decision — so the rate is a deploy-time number and the
    ///      zero case is the default and is tested.
    uint24 public hookFeePips;
    address public feeRecipient;

    /* ---------------------------------------------------------------- constants */

    /// @notice Ring size. Fixed, with no growth path. The write that wraps overwrites the oldest entry,
    ///         so the oldest READABLE observation is (CARDINALITY - 1) write-gaps back and the longest
    ///         window `consult` can answer is 255 * minObservationInterval, NOT 256 *. Choose the interval
    ///         with that ceiling in mind; beyond it consult() reverts rather than returning a short window.
    uint16 public constant CARDINALITY = DeployConfig.CARDINALITY;

    /// @dev P-9 (per-observation tick clamp) WAS BUILT AND THEN REMOVED, deliberately. A clamp bounds how
    ///      far one observation may move the recorded tick, which does blunt a manufactured excursion —
    ///      but it also makes `consult()` stop being the arithmetic mean it says it is, and MolePositions
    ///      anchors `maxTwapDeviationTicks` on exactly that number. Nine existing tests failed on the
    ///      change, correctly: they assert the cumulative is EXACT across negative ticks and that consult
    ///      answers the true requested-window mean. Rewriting them to accept a clamped answer would have
    ///      been the weakened-assertion failure this project keeps finding.
    ///
    ///      What the clamp was for is already covered, and covered better: `maxRecenterTicks` on the vault
    ///      bounds how far ONE rebalance may move a position and READS NO PRICE AT ALL, so it holds even
    ///      when the oracle has been walked successfully. A price-independent bound beats a price-derived
    ///      one at the same job. The spec left the clamp value as an open DECIDE per tier; it stays open,
    ///      and unimplemented, rather than guessed at.
    /// @dev Hard ceiling on the configurable max fee. learnings.txt carries FIVE conflicting values for
    ///      MAX_DYNAMIC_FEE (1%, 0.5%/2%, 3%, 10%+cliff, "well under 100%"); exactly one can ship, so the
    ///      contract refuses anything above the highest defensible bound rather than encoding a guess.
    ///      DEFINED IN DeployConfig AND READ FROM THERE, not restated. These two values were written out
    ///      as literals in both files, with a comment in DeployConfig calling them "mirrored from the
    ///      contracts" — and nothing anywhere asserted the two copies agreed. A ceiling that disagrees
    ///      with the ceiling the deploy script validates against is a config that passes validation and
    ///      then reverts in the constructor mid-broadcast, or worse, passes both while meaning different
    ///      things. One definition, referenced twice.
    uint24 public constant MAX_FEE_CEILING = DeployConfig.MAX_FEE_CEILING; // 10%
    /// @dev Cap on hookFeePips, so a deployment cannot quietly tax swaps into oblivion.
    uint24 public constant MAX_HOOK_FEE = DeployConfig.MAX_HOOK_FEE; // 1%

    /* ------------------------------------------------------------------ storage */

    mapping(PoolId => PoolState) public poolStates;
    mapping(PoolId => mapping(uint16 => Observation)) public observations;

    mapping(address => bool) public liquidityAllowed;

    /* ------------------------------------------------------------------- errors */

    error NotPoolManager();
    error NotPoolCreator();
    error FeeMustBeDynamic();
    error BadFeeBounds();
    error BadHookAddress();
    error LiquidityNotAllowed();
    error PoolNotInitialized();
    error InsufficientObservations();

    /* ------------------------------------------------------------------- events */

    /// @dev `initialFee` was dropped: it was always `lpFeePips`, i.e. an always-constant event field.
    event PoolPrimed(PoolId indexed poolId, int24 tick);
    /// @dev Emitted per swap with the fee actually handed to the PoolManager. It is a CONSTANT now, so
    ///      this is observability rather than a signal: it lets a test assert what the pool was really
    ///      charged rather than what a view reports. The old `volEwma` parameter went with the volatility
    ///      accumulator — leaving it as a permanent zero would have been a lie in the ABI.
    event FeeQuoted(PoolId indexed poolId, uint24 fee);
    event ObservationWritten(PoolId indexed poolId, uint16 index, int56 tickCumulative);

    /* -------------------------------------------------------------- constructor */

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Locks the IMPLEMENTATION. An uninitialised implementation is an unowned contract with an
        // `initialize` anyone may call, and from there `upgradeToAndCall` runs in whatever storage the
        // caller delegatecalls it from.
        _disableInitializers();
    }

    /// @dev NOTE THE ADDRESS CHECK BELOW. Under a proxy, `address(this)` here is the PROXY, because
    ///      `initialize` runs by delegatecall — which is exactly what must carry 0x38C4, since the
    ///      PoolManager only ever sees the proxy. The implementation's own address is irrelevant and is
    ///      deliberately not checked. This is the one place where moving from a constructor to an
    ///      initializer changes the MEANING of a check rather than just its timing, and it changes it in
    ///      the direction we want.
    function initialize(
        IPoolManager _poolManager,
        address _poolCreator,
        uint24 _lpFeePips,
        uint32 _minObservationInterval,
        bool _restrictedLiquidity,
        uint24 _hookFeePips,
        address _feeRecipient,
        address _owner
    ) external initializer {
        require(_owner != address(0), "owner required");
        upgradeAdmin = _owner;
        // A zero fee lets arbitrage reprice the pool for free; the ceiling bounds how far the pool may
        // sit from true price, since arbitrage only corrects a mispricing larger than the fee.
        if (_lpFeePips == 0 || _lpFeePips > MAX_FEE_CEILING) revert BadFeeBounds();
        if (_hookFeePips > MAX_HOOK_FEE) revert BadFeeBounds();
        if (_hookFeePips != 0 && _feeRecipient == address(0)) revert BadFeeBounds();
        // A zero observation interval writes a ring entry on every swap, exhausting all 256 slots for the
        // price of dust and collapsing the readable window to nothing.
        if (_minObservationInterval == 0) revert BadFeeBounds();

        // Checked LAST so a configuration error reports as itself rather than being masked by the address
        // check, and so the bounds stay testable with a plain `new` at any address. The permissions ARE
        // the address: mis-mined, the PoolManager simply never calls the callbacks we rely on.
        if (!HookPermissions.isValid(address(this))) revert BadHookAddress();

        poolManager = _poolManager;
        poolCreator = _poolCreator;
        lpFeePips = _lpFeePips;
        minObservationInterval = _minObservationInterval;
        restrictedLiquidity = _restrictedLiquidity;
        hookFeePips = _hookFeePips;
        feeRecipient = _feeRecipient;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    /* --------------------------------------------------------------- upgradeability */

    /// @notice THE ROOT KEY for this hook's implementation.
    /// @dev What it CANNOT do, whoever holds it: block a withdrawal, or tax a deposit. Those are fixed by
    ///      the PROXY's address bits (0x38C4), which the PoolManager reads by bitwise AND — no storage
    ///      lookup, no call, nothing an implementation can influence. An upgrade replaces the code behind
    ///      the address; it cannot replace the address. So the unblockable-exit guarantee is the one
    ///      property here that genuinely survives a compromised upgrade key.
    ///
    ///      Everything else does not. A hostile upgrade can lie in `consult()` — which MolePositions reads
    ///      as its TWAP anchor — re-price swaps, and refuse deposits. The remaining bound on that is
    ///      `maxRecenterTicks` on the vault, which reads no price at all.
    address public upgradeAdmin;

    /// @dev Reserved so a later version can add state without colliding with whatever sits below.
    uint256[45] private __gap;

    event UpgradeAdminTransferred(address indexed from, address indexed to);

    error NotUpgradeAdmin();

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
    }

    /// @notice Hand the root key on, or set it to address(0) to make this hook permanently immutable.
    function transferUpgradeAdmin(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        emit UpgradeAdminTransferred(upgradeAdmin, to);
        upgradeAdmin = to;
    }

    /* ------------------------------------------------------------- admin (tiny) */

    /// @notice Allow an address to provide liquidity when `restrictedLiquidity` is on. Only the pool
    ///         creator may call, and this power cannot touch funds, prices, fees or exits.
    function setLiquidityAllowed(address who, bool allowed) external {
        if (msg.sender != poolCreator) revert NotPoolCreator();
        liquidityAllowed[who] = allowed;
    }

    /* ---------------------------------------------------------------- callbacks */

    /// @dev Pool admission. Two things are enforced here because neither can be fixed afterwards: the pool
    ///      must be a DYNAMIC-fee pool, and only the pool creator may bind a pool to this hook.
    ///
    ///      The dynamic-fee check is not defensive padding. `updateDynamicLPFee` and the beforeSwap fee
    ///      override BOTH no-op unless `key.fee == DYNAMIC_FEE_FLAG` — and they no-op SILENTLY, so a pool
    ///      created with a static fee would run this entire fee engine as dead code with no revert
    ///      anywhere. That is the exact shape of bug this project keeps finding, so it reverts at birth.
    function beforeInitialize(address sender, PoolKey calldata key, uint160)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (sender != poolCreator) revert NotPoolCreator();
        if (!key.fee.isDynamicFee()) revert FeeMustBeDynamic();
        return IHooks.beforeInitialize.selector;
    }

    /// @dev Seed the oracle's first observation and set the opening fee, atomically with creation, so no
    ///      pool of ours ever exists in an unconfigured state (an unseeded oracle reads as zero elapsed
    ///      time, which is exactly the divide-by-zero cold-start the dossier flags).
    function afterInitialize(address, PoolKey calldata key, uint160, int24 tick)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        PoolId id = key.toId();
        PoolState storage s = poolStates[id];

        s.index = 0;
        s.lastTimestamp = uint32(block.timestamp);
        s.lastObsTimestamp = uint32(block.timestamp);
        s.lastTick = tick;
        s.tickCumulative = 0;
        s.initialized = true;

        observations[id][0] =
            Observation({blockTimestamp: uint32(block.timestamp), tickCumulative: 0, initialized: true});

        poolManager.updateDynamicLPFee(key, lpFeePips);
        emit PoolPrimed(id, tick);
        return IHooks.afterInitialize.selector;
    }

    /// @dev Gate on WHO may provide liquidity. Read `restrictedLiquidity` before reading this as a JIT
    ///      defence — it is not one, and an earlier version of this comment claiming otherwise was wrong.
    ///      The hook is handed the address that called modifyLiquidity, which is the vault, never the
    ///      depositor.
    ///
    ///      A per-(pool, provider, salt) L1-block stamp used to be written here "so a JIT add is
    ///      observable". It was removed: nothing on-chain ever read it, the guard it was intended for does
    ///      not exist, and it cost a cold SSTORE (~20k gas) on every single add. The same information is
    ///      available from the PoolManager's own ModifyLiquidity events.
    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4)
    {
        if (restrictedLiquidity && !liquidityAllowed[sender]) revert LiquidityNotAllowed();
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @dev Return this pool's fixed fee with OVERRIDE_FEE_FLAG set,
    ///      which is what makes the PoolManager use it for THIS swap instead of the stored value.
    ///
    ///      The fee is an immutable, so this path touches no storage at all. The full TWAP (`consult`) is
    ///      a view for the keeper and periphery and is never read here.
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        // A CONSTANT, re-asserted per swap with the override flag. Note honestly what that is and is not
        // worth: nothing can currently nudge the stored fee (updateDynamicLPFee is hook-gated and this
        // contract calls it only at afterInitialize), so the override and the stored value always agree
        // and deleting the flag is unobservable. It is kept as belt-and-braces against a future change
        // introducing a second writer, not because it defends anything today.
        emit FeeQuoted(id, lpFeePips);
        return (
            IHooks.beforeSwap.selector,
            BeforeSwapDeltaLibrary.ZERO_DELTA,
            lpFeePips | LPFeeLibrary.OVERRIDE_FEE_FLAG
        );
    }

    /// @dev Write the oracle observation, then optionally take the
    ///      protocol's cut.
    ///
    ///      The returned int128 is a delta in the UNSPECIFIED currency — output on an exact-input swap,
    ///      input on an exact-output swap — because we did not mine BEFORE_SWAP_RETURNS_DELTA. Positive
    ///      means the hook is owed, and the swapper pays it. We immediately `take()` it so the hook never
    ///      carries an unresolved delta into the end of the unlock (which would revert the whole swap).
    function afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        external
        override
        onlyPoolManager
        returns (bytes4, int128)
    {
        PoolId id = key.toId();
        (, int24 tick,,) = StateLibrary.getSlot0(poolManager, id);
        _write(id, tick);

        if (hookFeePips == 0) return (IHooks.afterSwap.selector, 0);

        // The unspecified leg — the only one we may charge against, since BEFORE_SWAP_RETURNS_DELTA is
        // not mined. It is currency1 when the specified leg is currency0, and vice versa.
        bool unspecifiedIsOne = (params.amountSpecified < 0 == params.zeroForOne);
        int128 unspecifiedDelta = unspecifiedIsOne ? delta.amount1() : delta.amount0();
        if (unspecifiedDelta == 0) return (IHooks.afterSwap.selector, 0);

        // Charge on the MAGNITUDE of that leg, whichever way it points. Charging only the positive
        // (received) side meant exact-OUTPUT swaps paid nothing at all: the identical fill, quoted as
        // exact-output, paid zero fee and consumed LESS input, so every unit of this revenue leaked to
        // any router willing to quote that way. Integrators must leave slippage headroom on the
        // unspecified leg, which is the ordinary cost of a hook that charges.
        uint256 magnitude =
            unspecifiedDelta > 0 ? uint256(uint128(unspecifiedDelta)) : uint256(uint128(-unspecifiedDelta));
        uint256 amount = (magnitude * hookFeePips) / LPFeeLibrary.MAX_LP_FEE;
        if (amount == 0) return (IHooks.afterSwap.selector, 0);

        // Resolve the credit immediately — a delta left unresolved at the end of the unlock reverts the
        // whole swap. If the transfer cannot be made (a token whose issuer blocklists feeRecipient, say)
        // we FORGO the fee rather than revert: optional revenue must never be able to brick the swap
        // path, and the LP fee and every exit stay untouched either way.
        try poolManager.take(unspecifiedIsOne ? key.currency1 : key.currency0, feeRecipient, amount) {
            return (IHooks.afterSwap.selector, int128(uint128(amount)));
        } catch {
            return (IHooks.afterSwap.selector, 0);
        }
    }

    /* -------------------------------------------------------- unmined callbacks */

    // These four exist only to satisfy IHooks. Their bits are NOT mined, so the PoolManager can never call
    // them; each reverts so that a future mis-mined redeployment fails loudly instead of silently enabling
    // a code path nobody reviewed. The three remove-liquidity ones are the load-bearing omission: with
    // their bits clear, withdrawal provably cannot reach this contract.

    function afterAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, BalanceDelta)
    {
        revert NotPoolManager();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotPoolManager();
    }

    function afterRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata)
        external
        pure
        override
        returns (bytes4, BalanceDelta)
    {
        revert NotPoolManager();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotPoolManager();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external
        pure
        override
        returns (bytes4)
    {
        revert NotPoolManager();
    }

    /* ----------------------------------------------------------------- internals */

    /// @dev Extend the cumulative to now and push a ring entry if the
    ///      minimum interval has elapsed. Time-gating the SSTORE is what keeps the oracle affordable;
    ///      the cumulative stays exact either way because it is advanced by elapsed * lastTick.
    function _write(PoolId id, int24 tick) internal {
        PoolState storage s = poolStates[id];
        uint32 nowTs = uint32(block.timestamp);

        // Timestamp deltas are deliberately unchecked, exactly as Uniswap v3's oracle does it: uint32
        // subtraction is correct modulo 2^32 for any span shorter than ~136 years, whereas a CHECKED
        // subtraction reverts forever once the clock passes 2106-02-07 and would brick every swap on
        // every pool that existed before the rollover.
        uint32 elapsed;
        uint32 sinceObs;
        unchecked {
            elapsed = nowTs - s.lastTimestamp;
            sinceObs = nowTs - s.lastObsTimestamp;
        }

        if (elapsed > 0) {
            s.tickCumulative += int56(int256(uint256(elapsed))) * int56(s.lastTick);
        }

        s.lastTick = tick;
        s.lastTimestamp = nowTs;

        // THE FIX THAT MATTERS: gate on time since the last OBSERVATION, not since the last swap. The
        // previous version compared against `elapsed` while updating `lastTimestamp` on every swap, so on
        // any pool with swaps closer together than the interval the condition was never true and the ring
        // never advanced past its seed — the oracle silently recorded nothing, forever, on exactly the
        // busy pools it exists to serve, and consult() then failed OPEN with a stale answer.
        if (sinceObs >= minObservationInterval) {
            uint16 nextIndex = uint16((uint256(s.index) + 1) % CARDINALITY);
            observations[id][nextIndex] =
                Observation({blockTimestamp: nowTs, tickCumulative: s.tickCumulative, initialized: true});
            s.index = nextIndex;
            s.lastObsTimestamp = nowTs;

            emit ObservationWritten(id, nextIndex, s.tickCumulative);
        }
    }

    /* -------------------------------------------------------------------- views */

    /// @notice Arithmetic-mean tick over EXACTLY the last `secondsAgo` seconds — the TWAP v4 does not
    ///         provide.
    /// @dev Reverts rather than returning a half-covered answer: a TWAP whose window is not actually
    ///      covered by observations is the manipulation surface, not the mitigation.
    ///
    ///      The cumulative at `target` is INTERPOLATED between the two observations that bracket it. The
    ///      previous version skipped that step and divided by the span to the older observation instead,
    ///      which silently answered a LONGER window than the caller asked for — measured at an 11x
    ///      understatement of a real 5-minute move. A caller that asks for 300 seconds and receives an
    ///      hour of smoothing is not protected by the bound it thinks it set.
    function consult(PoolId id, uint32 secondsAgo) external view returns (int24 arithmeticMeanTick) {
        PoolState memory s = poolStates[id];
        if (!s.initialized) revert PoolNotInitialized();
        if (secondsAgo == 0) revert InsufficientObservations();

        uint32 nowTs = uint32(block.timestamp);

        // FAIL CLOSED on an over-long window. The swap path subtracts timestamps unchecked so a 2106
        // rollover can never brick a swap, but the same treatment here would be a lie rather than a
        // liveness win: an unchecked `nowTs - secondsAgo` wraps to a huge target, the backward scan then
        // matches the NEWEST observation immediately, and consult returns a confident garbage mean. That
        // is the same fails-open shape as the freeze bug. A view that reverts is safe; one that lies is
        // not, so this stays explicit and returns the guard's own error rather than an arithmetic panic.
        if (secondsAgo > nowTs) revert InsufficientObservations();

        uint32 target;
        int56 cumNow;
        unchecked {
            target = nowTs - secondsAgo;
            // Cumulative as of now, extended past the last write with the tick in force since it.
            cumNow = s.tickCumulative + int56(int256(uint256(nowTs - s.lastTimestamp))) * int56(s.lastTick);
        }

        int56 cumAtTarget;
        bool found;
        bool haveNewer;
        uint32 newerTs;
        int56 newerCum;

        uint16 i = s.index;
        for (uint256 n = 0; n < CARDINALITY; n++) {
            Observation memory o = observations[id][i];
            if (!o.initialized) break;
            if (o.blockTimestamp <= target) {
                // Bracket found: interpolate the cumulative at `target` between this observation and the
                // next one forward (or, if `target` is newer than every observation, between it and now).
                uint32 rightTs = haveNewer ? newerTs : nowTs;
                int56 rightCum = haveNewer ? newerCum : cumNow;
                uint32 gap;
                unchecked {
                    gap = rightTs - o.blockTimestamp;
                }
                if (gap == 0) {
                    cumAtTarget = o.tickCumulative;
                } else {
                    uint32 into;
                    unchecked {
                        into = target - o.blockTimestamp;
                    }
                    // WIDEN TO int256 FOR THE PRODUCT. The intermediate `deltaCumulative * into` overflows
                    // int56 long before either operand does: at a tick of ~-196,000 — which is exactly
                    // where an 18-decimal/6-decimal pair like WETH/USDG sits — a single multi-day gap is
                    // enough, and the failure surfaces as an opaque arithmetic Panic rather than as this
                    // contract's own error. int56 is the right width to STORE a cumulative; it is the
                    // wrong width to multiply one in. The quotient is a time-weighted mean of in-range
                    // ticks, so narrowing after the division is safe.
                    int256 numerator = int256(rightCum - o.tickCumulative) * int256(uint256(into));
                    cumAtTarget = o.tickCumulative + int56(numerator / int256(uint256(gap)));
                }
                found = true;
                break;
            }
            haveNewer = true;
            newerTs = o.blockTimestamp;
            newerCum = o.tickCumulative;
            i = i == 0 ? uint16(CARDINALITY - 1) : i - 1;
        }
        if (!found) revert InsufficientObservations();

        // Divided by the REQUESTED window, because cumAtTarget is now exact at `target`.
        arithmeticMeanTick = int24((cumNow - cumAtTarget) / int56(int256(uint256(secondsAgo))));
    }

    /// @notice The fee every pool on this hook charges. Kept as a function rather than deleted in favour
    ///         of the public `lpFeePips` getter because integrations read it, but note the PoolId argument
    ///         is ignored: the fee is one immutable, not per-pool state.
    function currentFee(PoolId) external view returns (uint24) {
        return lpFeePips;
    }
}
