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

    event PoolCreatorSet(address indexed from, address indexed to);
    event FeeRecipientSet(address indexed from, address indexed to);

    error PoolCreatorRequired();

    /// @notice Rotate the pool creator — the key that may bind new pools to this hook and edit the
    ///         liquidity allowlist.
    ///
    /// @dev WHY A SETTER EXISTS AT ALL, given that `poolCreator` is one of the least privileged roles here.
    ///      Without one, recovering from a compromised pool creator means shipping a new implementation
    ///      through `upgradeAdmin` — so an incident on a LOW-privilege key would force us to use the
    ///      HIGHEST-privilege key, which is the wrong direction for a break-glass. It grants no new power:
    ///      the upgrade key can already set this address to anything by replacing the code behind the
    ///      proxy. What it buys is that the change is an EVENT rather than a code diff, and that a planned
    ///      authority handover does not have to be an upgrade. Same argument MolePositions already makes
    ///      for `setFeeRecipient`.
    ///
    ///      ZERO IS REFUSED, unlike `transferUpgradeAdmin` where zero is the deliberate way to make the
    ///      hook immutable. Renouncing the upgrade key removes a power; renouncing this one FREEZES a
    ///      power that pools still depend on — on a `restrictedLiquidity` hook the allowlist could never
    ///      be edited again, so the vault could never be replaced as the pool's LP. That is a brick, not a
    ///      renunciation, and it must not be reachable by a fat finger.
    function setPoolCreator(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        if (to == address(0)) revert PoolCreatorRequired();
        emit PoolCreatorSet(poolCreator, to);
        poolCreator = to;
    }

    /// @notice Rotate where the optional protocol swap fee is paid.
    /// @dev Same reasoning as `setPoolCreator`: no new power, one fewer reason to reach for the upgrade
    ///      key. The zero check is the initializer's invariant restated rather than a new rule — a live
    ///      `hookFeePips` with no recipient does not revert, it makes `take` send the fee to address(0),
    ///      i.e. burns it silently. It reverts with the SAME error the initializer raises for the same
    ///      condition, so one invariant reports as one error whether it is violated at birth or later.
    function setFeeRecipient(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        if (hookFeePips != 0 && to == address(0)) revert BadFeeBounds();
        emit FeeRecipientSet(feeRecipient, to);
        feeRecipient = to;
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
    ///      The cumulative at `target` is INTERPOLATED between the two observations that bracket it. An
    ///      early version skipped that step and divided by the span to the older observation instead,
    ///      which silently answered a LONGER window than the caller asked for — measured at an 11x
    ///      understatement of a real 5-minute move. A caller that asks for 300 seconds and receives an
    ///      hour of smoothing is not protected by the bound it thinks it set.
    ///
    ///      THE LEFT EDGE MUST LAND ON RECORDED HISTORY (fixed 2026-08-23). The same defect survived that
    ///      repair in a second form, at the OTHER end of the ring. Whenever the window's left edge
    ///      post-dated the newest stored observation, the backward scan matched that newest entry on its
    ///      first step — it is, trivially, at or before the target — and with no observation newer than
    ///      the target to interpolate against, the code substituted `now`/`cumNow` as the right-hand end
    ///      of the bracket. Work the algebra through and the requested window cancels out entirely:
    ///
    ///          cumAtTarget = cum_o + (cumNow - cum_o) * (target - t_o) / (now - t_o)
    ///          (cumNow - cumAtTarget) / secondsAgo  ==  (cumNow - cum_o) / (now - t_o)
    ///
    ///      — the mean tick SINCE THE LAST RING WRITE, identical for every `secondsAgo`, and contaminated
    ///      by every tick that fell outside the window the caller actually asked for. Measured on the live
    ///      Arc pool 0x180a…1796 on 2026-08-23, with the last write 2,676 seconds old: consult at 60s,
    ///      300s, 600s, 900s, 1800s and 2670s ALL returned tick 338426; 2700s — the first window long
    ///      enough to reach past that write — returned 338427 and 3600s returned 338495. Every consumer
    ///      asking for thirty minutes of smoothing was handed forty-five minutes of whatever the last swap
    ///      left behind.
    ///
    ///      WHAT THAT WOULD HAVE COST. This is the only time-averaged price in the system and every
    ///      consumer of it is a GUARD: MolePositions bounds a rebalance by |mid - consult| and MoleQueue
    ///      refuses to settle a batch whose spot has drifted from consult. Both were comparing spot
    ///      against a number derived almost entirely from spot, so both read a deviation near zero by
    ///      construction and admitted whatever they were handed. With the vault as the only LP the pool
    ///      has regions of zero liquidity where one swap moves spot arbitrarily far for almost nothing
    ///      (see `restrictedLiquidity`), so the number was cheap to set as well as wrong. That is the
    ///      Arrakis V1 shape exactly — a manager valuing positions at instantaneous price while believing
    ///      a TWAP gated it.
    ///
    ///      THE FIX, AND WHY THIS SHAPE. Every cumulative this function uses must come from a point the
    ///      contract actually RECORDED. There are exactly three, and nothing else:
    ///        - the ring's observations, exact at their own timestamps;
    ///        - `(lastTimestamp, tickCumulative)`, exact — `_write` advances the cumulative by
    ///          elapsed*lastTick on EVERY swap, whether or not the ring happens to write;
    ///        - `cumNow`, exact, because no swap since `lastTimestamp` means the tick has not moved since.
    ///      The defect was the "nothing else": it invented a right-hand bracket end at `now` when the ring
    ///      held none, and that invention is what let `secondsAgo` cancel. So there are two ways to answer
    ///      and one way to refuse, and they must stay separate.
    ///
    ///      1. THE QUIET-TAIL PATH — `target >= lastTimestamp`. The window lies wholly after the last swap,
    ///         so the tick was CONSTANT across all of it and the arithmetic mean is exactly `lastTick`.
    ///         Nothing is interpolated and nothing is fabricated: the cumulative at `target` is
    ///         `tickCumulative + (target - lastTimestamp) * lastTick` — a recorded point plus a known tick
    ///         over a known span.
    ///
    ///         THIS IS NOT SPOT WEARING A TWAP'S NAME, and the reason is in `_write`: `lastTimestamp`
    ///         advances on EVERY swap while the ring advances only every `minObservationInterval`. So the
    ///         instant an attacker swaps to move the tick, `lastTimestamp` becomes `now`, `target >=
    ///         lastTimestamp` is false for every positive window, and this path is closed to them — the
    ///         read falls back to bracketing across the ring, which carries their pre-manipulation history.
    ///         The path is reachable ONLY when the pool genuinely has not traded inside the window, and
    ///         then `lastTick` is not a stand-in for the mean, it IS the mean. To make it return a moved
    ///         tick you must move the price and then HOLD it for the entire window against arbitrage,
    ///         which is precisely the cost a TWAP exists to impose.
    ///
    ///         DO NOT WIDEN THE CONDITION TO `lastObsTimestamp`. It looks like the same test and it is
    ///         exploitable: between the last ring write and the last swap the tick may have moved several
    ///         times, so a target in that band has an UNKNOWN cumulative, and answering it with `lastTick`
    ///         reports a manipulation that lasted seconds as though it had held for the whole window.
    ///         `test_aSubIntervalPoisonCannotBeReadBackAsTheTwap` exists to catch exactly that edit.
    ///
    ///      2. THE BRACKETED PATH — everything else. Interpolate between the two observations that straddle
    ///         `target`, and never extrapolate off either end of the ring. A target landing EXACTLY on a
    ///         stored observation is read off its cumulative directly and is exact.
    ///
    ///      3. THE REFUSAL — `!found`. A window whose left edge predates the OLDEST entry the ring still
    ///         holds cannot be answered from anything this contract has, and there is no honest number to
    ///         return. Every consumer is a guard and a guard that fails closed is correct, so it reverts
    ///         rather than quietly answering a shorter window than it was asked for. That is what
    ///         MolePositions' TWAP bound has always claimed and, until today, was not true.
    ///
    ///      A NARROW BAND ALSO REFUSES, deliberately rather than by oversight: a target sitting between the
    ///      newest ring entry and `lastTimestamp` has exact endpoints on both sides but an UNRECORDED tick
    ///      path between them, so it takes the bracketed path, finds nothing newer than itself in the ring,
    ///      and reverts. That band is narrower than `minObservationInterval` by construction — a swap that
    ///      far past the last write would have written — so on the shipped config it is at most 60 seconds
    ///      of windows, it moves with the clock, and it fails closed. It is cheaply GRIEFABLE, and that is
    ///      recorded here rather than hidden: a dust swap inside a write gap opens the band for the rest of
    ///      that gap. The grief is bounded by one observation interval, cannot be extended (the next swap
    ///      past the interval writes and closes it), and denies rather than mis-prices.
    ///
    ///      `secondsAgo == 0` REVERTS, and that is the same statement as the rest: a zero-length window is
    ///      spot by definition. Callers that want the instantaneous tick must read slot0 from the
    ///      PoolManager and own that choice visibly, rather than obtaining it from something named
    ///      `consult`.
    ///
    ///      WHAT THIS COSTS IN AVAILABILITY, stated plainly because an earlier draft of this fix got the
    ///      trade wrong. A QUIET POOL ANSWERS — that is the whole point of the tail path. Refusing every
    ///      window on a pool that simply has not traded would take rebalancing, queue settlement and the
    ///      frontend's deposit anchor offline whenever the market is calm, which on a chain this thin is
    ///      the normal state; an ALM that refuses deposits when the market is quiet is not safe, it is
    ///      broken, and people route around it. What still refuses is a window reaching past the oldest
    ///      entry the ring holds (255 write-gaps, ~4h at the shipped 60s interval) and the narrow band
    ///      above. A young pool answers its birth tick for any window inside its own life and refuses
    ///      anything older than itself, which is correct in both directions.
    ///
    ///      IF YOU ARE READING THIS BECAUSE A TEST STARTED REVERTING WITH `InsufficientObservations`: that
    ///      is one of the two refusals working, and the harness is what needs changing, not this function.
    ///      Either the window reaches past the oldest observation the ring still holds — warm it with more
    ///      WRITES, which means more swaps, not more idling — or its left edge landed in the sub-interval
    ///      band, which one further swap resolves. Do not collapse the tail path and the bracketed path
    ///      into a single condition to make a fixture green: they answer from different recorded points,
    ///      and conflating a recorded point with a convenient one is how the original defect was written.
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

        // PATH 1: THE WINDOW LIES WHOLLY AFTER THE LAST SWAP. Then no swap moved the tick inside it, the
        // tick was constant at `lastTick` throughout, and the cumulative at `target` follows from a
        // recorded point — `tickCumulative`, exact at `lastTimestamp` — plus that constant tick over a
        // known span. The mean this yields is exactly `lastTick`, and it is the true mean rather than a
        // stand-in for one. `lastTimestamp` advancing on EVERY swap is what makes this safe: an attacker
        // who moves the tick closes this path with their own transaction. See the header, and do not
        // widen the condition to `lastObsTimestamp`.
        if (target >= s.lastTimestamp) {
            unchecked {
                cumAtTarget =
                    s.tickCumulative + int56(int256(uint256(target - s.lastTimestamp))) * int56(s.lastTick);
            }
            found = true;
        } else {
            // PATH 2: BRACKET IT ACROSS THE RING.
            uint16 i = s.index;
            for (uint256 n = 0; n < CARDINALITY; n++) {
                Observation memory o = observations[id][i];
                if (!o.initialized) break;
                if (o.blockTimestamp <= target) {
                    if (o.blockTimestamp == target) {
                        // The left edge lands exactly on a stored observation. No interpolation, no second
                        // point, no approximation — and this is the ONLY case in which the newest observation
                        // alone is a sufficient answer.
                        cumAtTarget = o.tickCumulative;
                    } else {
                        // NEVER EXTRAPOLATE PAST THE NEWEST OBSERVATION. Reaching here means `target` sits
                        // between the newest ring entry and `lastTimestamp` — endpoints we hold exactly, but
                        // with an unrecorded tick path between them, because swaps inside a write gap leave
                        // no trace of WHEN they moved the price. The old code filled that hole with
                        // `now`/`cumNow` and the requested window cancelled out of the algebra entirely; see
                        // the header. This band is narrower than one observation interval and one more swap
                        // closes it, so refusing costs little and inventing the missing point costs the
                        // whole guarantee.
                        if (!haveNewer) revert InsufficientObservations();

                        // Both edges of the bracket are real observations now, and ring timestamps strictly
                        // increase (a write requires minObservationInterval >= 1 second to have elapsed), so
                        // `gap` is at least 2 here — o.blockTimestamp < target < newerTs. There is no
                        // divide-by-zero branch to keep, and keeping one would be a branch no test could reach.
                        uint32 gap;
                        uint32 into;
                        unchecked {
                            gap = newerTs - o.blockTimestamp;
                            into = target - o.blockTimestamp;
                        }
                        // WIDEN TO int256 FOR THE PRODUCT. The intermediate `deltaCumulative * into` overflows
                        // int56 long before either operand does: at a tick of ~-196,000 — which is exactly
                        // where an 18-decimal/6-decimal pair like WETH/USDG sits — a single multi-day gap is
                        // enough, and the failure surfaces as an opaque arithmetic Panic rather than as this
                        // contract's own error. int56 is the right width to STORE a cumulative; it is the
                        // wrong width to multiply one in. The quotient is a time-weighted mean of in-range
                        // ticks, so narrowing after the division is safe.
                        int256 numerator = int256(newerCum - o.tickCumulative) * int256(uint256(into));
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
        }
        // PATH 3: THE REFUSAL. The window reaches back past the oldest entry the ring still holds, so
        // there is nothing recorded to anchor its left edge on. Fail closed.
        if (!found) revert InsufficientObservations();

        // Divided by the REQUESTED window, because cumAtTarget is now exact at `target`.
        arithmeticMeanTick = int24((cumNow - cumAtTarget) / int56(int256(uint256(secondsAgo))));
    }


    /// @notice THE EVIDENCE BEHIND `consult(id, secondsAgo)`: how much of that answer rests on time in
    ///         which this pool recorded no trade at all. Additive, view-only, and it reads nothing the
    ///         oracle did not already store — no new state, no new write, no change to `_write` or to any
    ///         swap's gas.
    ///
    /// @dev WHY A SECOND NUMBER IS NEEDED AT ALL. `consult` is CORRECT and this does not second-guess it.
    ///      On a pool that has not traded inside the window the tick was constant across the whole window,
    ///      so `lastTick` IS the arithmetic mean and the quiet-tail path returns the true answer. The
    ///      trouble is downstream: every consumer of `consult` is a GUARD, and a guard needs to know
    ///      whether the number it was handed is OLD as well as whether it is RIGHT. Those are different
    ///      questions and `consult`'s return value cannot carry both — a fossil tick and a live tick are
    ///      the same int24.
    ///
    ///      WHY `lastObsTimestamp` WAS THE WRONG CLOCK TO ASK, which is the whole reason this exists.
    ///      MoleQueue measured freshness as `now - lastObsTimestamp`, i.e. seconds since the last RING
    ///      WRITE. `_write` stamps that on ANY swap past `minObservationInterval`, whatever its size and
    ///      whether or not the tick moved — so ONE RAW UNIT resets it to zero. The cumulative that same
    ///      swap records advances by `elapsed * lastTick`: it carries the fossil tick forward and adds no
    ///      information whatsoever. A heartbeat anybody can fake for a dust swap's gas is not a freshness
    ///      measurement; it is a liveness LED wired to the attacker's finger.
    ///
    ///      WHAT THIS MEASURES INSTEAD. `quietSpan` is the LONGEST STRETCH OF DEAD AIR the answer leans
    ///      on — the widest interval between two consecutive moments this pool actually recorded, across
    ///      the window and across the bracket its left edge is interpolated over. It is deliberately NOT
    ///      clipped to the window: when the left edge is interpolated between an observation from a month
    ///      ago and one from this block, the line is drawn over a month, and a month is the honest length
    ///      of that line however little of it falls inside the window.
    ///
    ///      A dust swap cannot shrink this. It can add ONE recorded point at `now`; the stretch behind it
    ///      is still empty, and the empty stretch is what gets reported. Making `quietSpan` small requires
    ///      the pool to have traded REPEATEDLY, spread across the whole window, before the settler needed
    ///      it — which is a cost paid in advance, in public, over time, rather than a byte appended to the
    ///      exploit transaction.
    ///
    ///      READ THE HONEST LIMIT OF IT PLAINLY: this measures that trades HAPPENED, never that they were
    ///      arm's length. A party willing to wash-trade its own pool on a schedule can hold `quietSpan`
    ///      arbitrarily low at the fossil tick and nothing in this contract can tell that apart from a
    ///      thin but genuine market. Closing THAT needs a price this pool does not produce; see
    ///      `MoleQueue._requireAnchorIsFresh`.
    ///
    /// @param secondsAgo The same window the caller passed, or is about to pass, to `consult`. The answer
    ///        describes THAT call: a different window is a different bracket and a different span.
    /// @return quietSpan Seconds of the widest recorded-nothing stretch the answer rests on.
    /// @return extrapolated True when `consult` took the QUIET-TAIL path — the window lies wholly after
    ///         the last swap, so the answer is one tick held across the entire window and the pool quoted
    ///         no price inside it. A caller whose premise is "the anchor is a TWAP, never spot" is being
    ///         told here that the premise does not hold for this answer: every window, long or short,
    ///         returns the same single number, so any check comparing two of them against each other is
    ///         comparing a number with itself.
    /// @dev Reverts exactly where `consult` reverts, with the same errors, so a caller cannot get an
    ///      evidence reading for an answer that does not exist.
    function consultEvidence(PoolId id, uint32 secondsAgo)
        external
        view
        returns (uint32 quietSpan, bool extrapolated)
    {
        PoolState memory s = poolStates[id];
        if (!s.initialized) revert PoolNotInitialized();
        if (secondsAgo == 0) revert InsufficientObservations();

        uint32 nowTs = uint32(block.timestamp);
        if (secondsAgo > nowTs) revert InsufficientObservations();

        uint32 target;
        unchecked {
            target = nowTs - secondsAgo;
            // The tail counts on BOTH paths, and it is where the fossil hides. `consult` extends the
            // cumulative from `lastTimestamp` to `now` with `lastTick`, and by construction nothing traded
            // in that stretch — that is what makes the extension exact, and equally what makes it silent.
            // Unchecked for the same reason `_write` is: uint32 subtraction is correct modulo 2^32 and a
            // checked one would start reverting forever in 2106.
            quietSpan = nowTs - s.lastTimestamp;
        }

        // PATH 1 mirrored: the window lies wholly after the last swap. There is one stretch and the whole
        // answer is inside it, so there is nothing further to measure.
        if (target >= s.lastTimestamp) return (quietSpan, true);

        // PATH 2 mirrored: walk the SAME backward scan `consult` walks and take the widest step. Every
        // step is a real gap between two recorded moments; `next` starts at `lastTimestamp` because the
        // stretch from the newest ring entry to the last swap is likewise unrecorded (it is narrower than
        // `minObservationInterval` by construction, so this costs nothing and never understates).
        uint16 i = s.index;
        bool haveNewer;
        uint32 newerTs;
        for (uint256 n = 0; n < CARDINALITY; n++) {
            Observation memory o = observations[id][i];
            if (!o.initialized) break;
            uint32 next = haveNewer ? newerTs : s.lastTimestamp;
            uint32 gap;
            unchecked {
                gap = next - o.blockTimestamp;
            }
            if (o.blockTimestamp <= target) {
                // `consult` refuses to invent a right-hand bracket end, so this refuses with it: without a
                // newer observation the only exact answer is the one that lands ON the observation.
                if (o.blockTimestamp != target && !haveNewer) revert InsufficientObservations();
                // THE BRACKET'S OWN SPAN, IN FULL AND UNCLIPPED. This is the step the dust swap cannot
                // shrink: `next` is the attacker's fresh observation, `o` is the fossil one behind it, and
                // the distance between them is how far the interpolated left edge was guessed across.
                if (gap > quietSpan) quietSpan = gap;
                return (quietSpan, false);
            }
            // A gap that falls INSIDE the window counts too. Both of its ends being recorded does not make
            // the silence between them informative — it only makes it measurable.
            if (gap > quietSpan) quietSpan = gap;
            haveNewer = true;
            newerTs = o.blockTimestamp;
            i = i == 0 ? uint16(CARDINALITY - 1) : i - 1;
        }
        // PATH 3 mirrored: the window reaches past the oldest entry the ring still holds. `consult` fails
        // closed here and so does this.
        revert InsufficientObservations();
    }

    /// @notice The fee every pool on this hook charges. Kept as a function rather than deleted in favour
    ///         of the public `lpFeePips` getter because integrations read it, but note the PoolId argument
    ///         is ignored: the fee is one immutable, not per-pool state.
    function currentFee(PoolId) external view returns (uint24) {
        return lpFeePips;
    }
}
