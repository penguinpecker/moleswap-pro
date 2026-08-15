// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/types/PoolOperation.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/libraries/TransientStateLibrary.sol";
import {LiquidityAmounts} from "v4-periphery/libraries/LiquidityAmounts.sol";
import {HookPermissions} from "./config/HookPermissions.sol";
import {DeployConfig} from "./config/DeployConfig.sol";
import {ZapLogic} from "./libraries/ZapLogic.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @notice The only thing MolePositions needs from MoleHook. Declared as a minimal interface rather than
///         importing the hook, so the custody core stays independent of the hook's implementation and does
///         not carry its bytecode.
interface IMoleOracle {
    function consult(PoolId id, uint32 secondsAgo) external view returns (int24 arithmeticMeanTick);
}

/// @title MolePositions
/// @notice Custody core. Holds per-user Uniswap v4 liquidity positions under a permission split:
///         the owner alone can withdraw, and the keeper can only reshape a position in place.
///
/// THE SECURITY CLAIM, stated so it can be checked rather than believed:
///
///   1. No code path in this contract sends a token to an address that was supplied by a caller.
///      Every payout target is read from `positions[id].owner` in storage. `take()` is called with
///      that stored owner and nothing else. There is no `to`, `recipient` or `receiver` parameter
///      anywhere in this contract's external surface.
///   2. `owner` is written exactly once, at open(), and there is no setter and no transfer function.
///      A position cannot change hands, so the payout target of a given id is fixed for all time.
///   3. The keeper can call exactly one state-changing function, `rebalance`, which cannot change
///      liquidity ownership, cannot move value out of the pool, and is bounded by SEVEN immutable limits
///      set at construction, none of which it can widen because there is no setter:
///        - `minRebalanceInterval` — per-position cadence, in block.timestamp seconds;
///        - `minDwellL1Blocks` — position age in ETHEREUM blocks, which the sequencer cannot fast-forward
///          and which is therefore the only bound still standing if the timestamp clock is manipulated;
///        - `maxRebalancesPerL1Block` — a global budget, so one transaction cannot reshape the whole book;
///        - `minRangeWidth` / `maxRangeWidth` — how wide a range may be;
///        - `maxTwapDeviationTicks` (+ `twapWindow`) — where the range may sit, measured against the
///          time-averaged tick from our own oracle rather than slot0, and failing CLOSED when the oracle
///          cannot cover the window;
///        - `maxEjectionBps` — optional cap on how much of a leg one rebalance may return to the owner;
///        - `maxRecenterTicks` — how far ONE rebalance may move the position from where it already is.
///          This is the only bound that reads no price, and therefore the only one that still holds when
///          the oracle itself has been manipulated. Do not disable it; see DeployConfig.
///   4. Withdrawal does not depend on the keeper, on any off-chain service, or on the hook — the
///      pool's hook deliberately does not carry the remove-liquidity permission bits, so the
///      PoolManager cannot even call it on this path. See HookPermissions.
///
/// Consequence: a fully compromised keeper key can degrade returns. It cannot take a token.
///
/// ────────────────────────────────────────────────────────────────────────────────────────────────────
/// READ THIS BEFORE BELIEVING ANY OF THE ABOVE. THIS CONTRACT IS UPGRADEABLE.
///
/// Everything on this page describes the CURRENT implementation. It sits behind a UUPS proxy, and whoever
/// holds `upgradeAdmin` can replace every line of it — including `withdraw` — while the address, the
/// storage and every open position stay exactly where they are. So the honest statement of the security
/// model is narrower than it used to be, and it is this:
///
///   - the KEEPER cannot take a token. Still true, still enforced by the seven bounds below, and still
///     the thing those bounds exist for.
///   - the UPGRADE ADMIN can take everything. There is no bound on that and there cannot be one; an
///     upgrade key is a root key by definition, and calling it anything else would be dishonest.
///
/// This was a deliberate trade, made by the owner with the cost stated: an upgradeable HOOK means a hook
/// bug never forces every pool to be abandoned, which is this design's largest structural liability. The
/// vault was included in that decision. `test/attack/AttackUpgradeability.t.sol` carries a PASSING test
/// that replaces this contract wholesale, so the capability is a measured fact in the suite rather than a
/// footnote nobody reads.
///
/// THE WAY OUT, if the trade stops being worth it: `transferUpgradeAdmin(address(0))`. That surrenders the
/// root key permanently and makes every claim above true without qualification again.
///
/// One property is genuinely immune, and it is worth knowing which: the pool can never block a
/// WITHDRAWAL, because that is decided by the hook's permission BITS, which live in its address. An
/// upgrade replaces code behind an address; it cannot replace the address. See HookPermissions.
/// ────────────────────────────────────────────────────────────────────────────────────────────────────
///
/// TIMING. On Robinhood Chain `block.number` is the ETHEREUM L1 height, not the L2 height, and blocks
/// arrive ~120x faster than it ticks. Durations here are therefore in `block.timestamp` seconds. The
/// one deliberate exception is `openedAtL1Block`, which uses `block.number` precisely because it is
/// L1-paced and the sequencer cannot advance it by producing blocks — that makes it a dwell measure
/// an ordering-privileged sequencer cannot fake. See RHChain and Part 16.11 of learnings.txt.
contract MolePositions is IUnlockCallback, Initializable, UUPSUpgradeable {
    using PoolIdLibrary for PoolKey;

    /* --------------------------------------------------------------------- types */

    struct Position {
        /// @dev The one and only payout target. Written at open(), never mutated.
        address owner;
        PoolId poolId;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        /// @dev L1-paced (see contract docs). Dwell guard that the sequencer cannot fast-forward.
        uint64 openedAtL1Block;
        uint64 lastRebalancedAt;
    }

    enum Action {
        Open,
        Withdraw,
        Rebalance,
        ZapOpen
    }

    // ZapParams now lives in ZapLogic — see the note on `zapOpen`. The tuple shape is unchanged, so
    // the external ABI is identical and nothing already encoding a zap call breaks.


    /* ------------------------------------------------------------------ immutable */

    IPoolManager public poolManager;

    /// @notice May call `rebalance` and nothing else. Holds no allowance and no withdrawal reach.
    address public keeper;

    /// @notice The ONLY hook a pool may carry to be admissible here — the fail-closed admission
    ///         allowlist. A pool's hook is part of its PoolId and can never change, and our own
    ///         TWAP/fee oracle is first-party hook code, so a pool that does not carry our hook is
    ///         unservable by construction; admitting one would be pointless and would expose every
    ///         non-withdrawal hook callback (swap pricing, dynamic fee, add-liquidity delta) to an
    ///         attacker who authored the hook. So whitelistPool admits a pool iff its hook equals
    ///         this address and nothing else.
    /// @dev address(0) is a legal pin and means "hookless pools only" — pools with no callbacks on any
    ///      path. It is NOT what deploys: script/Deploy.s.sol mines MoleHook and pins that address, so
    ///      every real deployment carries a real hook. This used to be described as "the pre-MoleHook
    ///      interim", written before the hook existed and left standing after it did; the tests and
    ///      staging worlds that pass address(0) are the only remaining users, and they pass it because a
    ///      hookless pool isolates custody behaviour from hook behaviour, not because the hook is pending.
    ///      Whatever is pinned, the constructor proves it cannot block a withdrawal or tax a deposit, so
    ///      a mis-pin fails at deploy rather than at first use.
    address public moleHook;

    /// @notice The protocol's cut of REALIZED TRADING FEES, in basis points. 1000 = 10%.
    ///
    /// THREE THINGS THIS IS NOT, because each one is a different product and a different promise:
    ///   - it is NOT a deposit or withdrawal fee. It is computed exclusively from the `feesAccrued`
    ///     component the PoolManager reports, never from the principal component of a delta. Putting a
    ///     bps on the wrong component is how a performance fee silently becomes a deposit fee, so the
    ///     separation is structural (two distinct return values) rather than a matter of care.
    ///   - it is NOT an AUM fee. A position that earns nothing pays nothing, forever.
    ///   - it is NOT a swap tax. MoleHook CAN charge one (`hookFeePips`) and ships at zero: that path
    ///     taxes every trader in the pool including LPs who never deposited with us, and it lives in
    ///     immutable hook code. Our revenue is a performance fee on our OWN depositors' fees.
    ///
    /// SET ONCE AT INITIALIZATION, and there is no setter — so the keeper, the fee recipient and every
    /// user are all equally unable to move it. That was originally the whole argument for choosing this
    /// over Revert Compoundor's downward-only ratchet: a ratchet needs an admin role and this contract
    /// had none.
    ///
    /// IT NO LONGER MEANS WHAT IT MEANT. This contract is now upgradeable, so `upgradeAdmin` can change
    /// this rate — or remove the ceiling that bounds it — by shipping a new implementation. "No setter"
    /// is still literally true and is still worth having, because it means a fee change is a visible
    /// code deployment rather than a quiet transaction. It is no longer a guarantee.
    uint16 public performanceFeeBps;

    /// @notice Where the cut goes. Receives ERC-6909 claims against the PoolManager, not ERC-20.
    /// @dev NOTE FOR DEPLOYMENT: this address must be able to redeem those claims, i.e. call
    ///      `poolManager.unlock` and then `burn`/`take`. A plain EOA cannot, and revenue sent to one is
    ///      stranded inside the PoolManager rather than lost — recoverable only by a contract that can
    ///      unlock. Point this at a contract that can, or accept that the balance accrues unclaimed.
    address public feeRecipient;

    /// @notice The compiled-in hard ceiling on `performanceFeeBps`. 2000 = 20%.
    /// @dev A bound that a deployer can choose is not a bound. This one is a `constant`, so it is in the
    ///      bytecode of every MolePositions ever deployed and no constructor argument, key or upgrade can
    ///      exceed it. 20% is the top of the observed market (Charm's own contract cap; Gamma charges
    ///      14-20%), so this refuses anything the industry itself would call an outlier.
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = DeployConfig.MAX_PERFORMANCE_FEE_BPS;

    /// @notice Safety ceilings, set at initialization. A compromised KEEPER cannot widen these, because
    ///         there is no setter — a keeper that could raise its own bounds is not a bounded keeper.
    /// @dev The upgrade admin can, by replacing the implementation. See the header: these bound the
    ///      keeper, which is what they were built for, and they do not bound the root key.
    uint32 public minRebalanceInterval;
    int24 public minRangeWidth;
    int24 public maxRangeWidth;

    /// @notice Maximum distance, in ticks, between the midpoint of a new range and the pool's TWAP.
    ///         Zero disables the check. THIS IS THE GUARD THAT STOPS A KEEPER RECENTERING INTO A WICK:
    ///         width and rate limits bound how OFTEN and how WIDE it can move a position, but nothing
    ///         previously bounded WHERE. Spot is manipulable by whoever is ordering-privileged — on a
    ///         single-sequencer chain, that is not a theoretical adversary — so the anchor is the
    ///         time-averaged tick from our own oracle, never slot0.
    int24 public maxTwapDeviationTicks;

    /// @notice Window passed to the oracle. Longer is harder to manipulate and slower to react.
    uint32 public twapWindow;

    /// @notice Maximum distance, in ticks, that ONE rebalance may move a position's midpoint from where it
    ///         already is. Zero disables the check.
    ///
    ///         THIS IS THE BOUND THAT DOES NOT TRUST A PRICE. `maxTwapDeviationTicks` anchors on the
    ///         oracle, and an oracle is only as honest as the pool under it: with `restrictedLiquidity`
    ///         on, the only liquidity provider is this vault, so a pool has regions of ZERO liquidity
    ///         where a dust swap moves spot arbitrarily far for almost nothing. An adversary walks spot,
    ///         holds it for the window, and the TWAP follows — after which the deviation bound is
    ///         satisfied at an absurd tick and a compromised keeper can place a position anywhere. That
    ///         was demonstrated taking 100% of a position's principal, which is precisely the outcome
    ///         this contract's security claim denies.
    ///
    ///         A relative bound cannot be moved by manipulating anything, because it reads nothing. The
    ///         keeper may still walk a position, but only `maxRecenterTicks` per `minRebalanceInterval`,
    ///         and the owner can exit at any moment in between — exits being unblockable by construction.
    ///         The dossier's own Part 6 says TWAP is not safe at any window length on a thin pool; this
    ///         is the guard that holds when that is true.
    int24 public maxRecenterTicks;

    /// @notice Minimum L1 blocks a position must exist before the keeper may reshape it.
    ///         `block.number` on Robinhood Chain is the ETHEREUM height, so this is a duration the
    ///         sequencer cannot fast-forward by producing L2 blocks — which is the whole point of measuring
    ///         dwell in blocks here rather than in `block.timestamp`, a clock the sequencer writes.
    uint64 public minDwellL1Blocks;

    /// @notice PER-REBALANCE cap, in basis points, on how much of either leg ONE rebalance may hand back
    ///         to the owner instead of re-minting it. 10_000 (100%) disables the check.
    ///
    ///         IT IS A STEP LIMIT, NOT A CUMULATIVE BUDGET, and the difference matters. The denominator is
    ///         what THIS burn returned, so each rebalance re-bases it: at 5_000 bps ("at most half"), five
    ///         legal rebalances were measured stranding 88.6% of a leg, because half of a half of a half
    ///         compounds. `maxRebalancesPerL1Block` is what bounds how fast that can compound; this bounds
    ///         only the size of a single step. Anyone reading "5_000 = at most half the position" without
    ///         that sentence would be wrong, which is why the sentence is here.
    ///
    ///         WHY THIS EXISTS. Re-minting at a new range needs a token ratio the old range may not hold,
    ///         and whatever will not fit is returned to the owner. That residual was described in this
    ///         file as "dust". It is not: a rebalance to a legal, TWAP-compliant range was measured
    ///         returning 99% of one leg — half the position's principal — leaving the position one-sided
    ///         and no longer earning on that side. No token is stolen (it goes to the owner, and the
    ///         contract keeps nothing), so this is degradation rather than theft and the custody claim
    ///         holds. But it is a big enough lever to be worth bounding explicitly rather than mislabelling.
    ///
    ///         THE TRADE-OFF IS REAL, which is why this is opt-in. After a large price move the old range
    ///         is entirely in one token, so ANY recentre produces a large residual. Setting this tight
    ///         means the keeper cannot rebalance at all in exactly that situation — it fails closed, the
    ///         position stays where it is, and the owner can always `withdrawAll` and reopen.
    uint16 public maxEjectionBps;

    /// @notice Cap on how many positions the keeper may rebalance within one L1 block. Without it the
    ///         per-position interval is no constraint at all in aggregate: one transaction could touch the
    ///         entire book, so a single compromised-keeper transaction was previously unbounded in blast
    ///         radius even though every individual position was rate-limited. Zero disables the cap.
    uint16 public maxRebalancesPerL1Block;

    /* -------------------------------------------------------------------- storage */

    mapping(uint256 id => Position) private _positions;
    mapping(PoolId => PoolKey) private _pools;
    mapping(PoolId => bool) public isWhitelisted;
    mapping(address owner => uint256[] ids) private _ownerPositions;

    /// @notice Total positions ever opened. Position ids are 1-based; id 0 is never valid.
    uint256 public positionCount;

    /// @notice How many rebalances the keeper has already spent in a given L1 block.
    mapping(uint256 l1Block => uint16 used) public rebalancesUsedInL1Block;

    /* --------------------------------------------------------------------- events */

    /// @dev Emitted so an indexer (and the DefiLlama TVL adapter) can enumerate every position
    ///      without relying on our API. See Part 16.10.
    event PositionOpened(
        uint256 indexed id, address indexed owner, PoolId indexed poolId, int24 tickLower, int24 tickUpper, uint128 liquidity
    );
    event PositionWithdrawn(uint256 indexed id, address indexed owner, uint128 liquidityRemoved, uint256 amount0, uint256 amount1);
    event PositionRebalanced(uint256 indexed id, int24 oldLower, int24 oldUpper, int24 newLower, int24 newUpper, uint128 liquidity);
    event PoolWhitelisted(PoolId indexed poolId);
    /// @dev How much a rebalance handed back to the owner rather than re-minting. Emitted on every
    ///      rebalance so a one-sided outcome is visible to monitoring instead of being inferred.
    /// @notice The protocol's cut of realized fees. Amounts are ERC-6909 claims minted to `recipient`.
    event PerformanceFeeTaken(uint256 indexed positionId, address indexed recipient, uint128 amount0, uint128 amount1);

    event RebalanceResidualPaid(uint256 indexed id, address indexed owner, uint256 amount0, uint256 amount1);

    /* --------------------------------------------------------------------- errors */

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
    error RebalanceNotSelfFunding();
    error HookNotPermitted();
    error WithdrawalWouldBeBlockable();
    error InvalidTickSpacing();
    error DeadlinePassed();
    error ExceedsMaxAmount();
    error DwellNotElapsed();
    error DepositWouldBeTaxable();
    error RangeTooFarFromTwap();
    error RebalanceBudgetExhausted();
    error EjectionTooLarge();
    error RecenterTooFar();
    error FeeAboveCeiling();
    error FeeRecipientRequired();
    error FeeRecipientCannotBeThisContract();
    error DepositAccruedFees();
    error NativeCurrencyNotSupported();
    error PositionTooSmall();
    error PositionTooLarge();
    error KeeperRevokedForPosition();
    error CapAboveCeiling();
    error KeeperExpired();
    error NativeRefundFailed();
    /// @dev These six replaced string `require`s in the initializer. Strings are stored verbatim in the
    ///      bytecode; six of them cost enough to push this contract past the 24,576-byte EIP-170 limit,
    ///      which is a deployment failure rather than a style issue. Custom errors are also a better ABI:
    ///      an integrator gets a decodable selector instead of a sentence to string-match on.
    error OwnerRequired();
    error BadRangeBounds();
    error BadTwapDeviation();
    error TwapBoundNeedsAnOracle();
    error BadEjectionCap();
    error BadRecenterCap();
    /// @dev Was `ExceedsMaxAmount`, whose name says the OPPOSITE of what it tests and would mislead an
    ///      integrator decoding a revert.
    error MintedBelowMinimum();

    /* ---------------------------------------------------------------- constructor */

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Locks the IMPLEMENTATION so nobody can initialize it directly and then, via a delegatecall
        // from a contract they control, act as though they were this vault.
        _disableInitializers();
    }

    /// @notice Everything this vault is, in one struct.
    /// @dev A struct rather than fifteen parameters because fifteen ABI-decoded arguments overflow the
    ///      Yul stack even with via_ir enabled. It also reads better at the call site: a deployment names
    ///      every field it is setting instead of relying on positional order across fifteen slots, and
    ///      three of those slots are addresses that would otherwise be trivially transposable.
    struct InitParams {
        IPoolManager poolManager;
        address keeper;
        uint32 minRebalanceInterval;
        int24 minRangeWidth;
        int24 maxRangeWidth;
        address moleHook;
        int24 maxTwapDeviationTicks;
        uint32 twapWindow;
        uint64 minDwellL1Blocks;
        uint16 maxRebalancesPerL1Block;
        uint16 maxEjectionBps;
        int24 maxRecenterTicks;
        uint16 performanceFeeBps;
        address feeRecipient;
        address upgradeAdmin;
    }

    function initialize(InitParams memory p_) external initializer {
        // Hot fields cached into locals. Measured both ways: locals are ~140 bytes SMALLER than reading
        // `p_.field` repeatedly, because each read is an mload plus offset arithmetic and several fields
        // are read two or three times. The intuitive optimisation is the wrong one here, and this
        // contract has only a few hundred bytes of EIP-170 headroom to spend on being wrong.
        IPoolManager pm_ = p_.poolManager;
        address hook_ = p_.moleHook;
        int24 minW_ = p_.minRangeWidth;
        int24 maxW_ = p_.maxRangeWidth;
        int24 twapDev_ = p_.maxTwapDeviationTicks;
        uint32 twapWin_ = p_.twapWindow;
        uint16 feeBps_ = p_.performanceFeeBps;
        address recip_ = p_.feeRecipient;

        if (p_.upgradeAdmin == address(0)) revert OwnerRequired();
        upgradeAdmin = p_.upgradeAdmin;
        if (minW_ <= 0 || maxW_ < minW_) revert BadRangeBounds();

        // Prove the pinned hook is safe at DEPLOY time, not at first whitelist. address(0) is the
        // hookless-only pin and is trivially safe. Any non-zero pin must provably be unable to block a
        // withdrawal or tax a deposit — our bitmap 0x38C4 clears both masks — so a mis-pin cannot deploy.
        if (hook_ != address(0)) {
            if (!HookPermissions.withdrawalIsUnblockable(hook_)) revert WithdrawalWouldBeBlockable();
            if (!HookPermissions.depositIsUntaxable(hook_)) revert DepositWouldBeTaxable();
        }

        poolManager = pm_;
        keeper = p_.keeper;
        minRebalanceInterval = p_.minRebalanceInterval;
        minRangeWidth = minW_;
        maxRangeWidth = maxW_;
        moleHook = hook_;

        // A TWAP bound with no oracle to read is a bound in name only.
        if (twapDev_ < 0) revert BadTwapDeviation();
        if (twapDev_ > 0) {
            if (hook_ == address(0) || twapWin_ == 0) revert TwapBoundNeedsAnOracle();
        }
        maxTwapDeviationTicks = twapDev_;
        twapWindow = twapWin_;
        minDwellL1Blocks = p_.minDwellL1Blocks;
        maxRebalancesPerL1Block = p_.maxRebalancesPerL1Block;
        if (p_.maxEjectionBps > 10_000) revert BadEjectionCap();
        maxEjectionBps = p_.maxEjectionBps;
        if (p_.maxRecenterTicks < 0) revert BadRecenterCap();
        maxRecenterTicks = p_.maxRecenterTicks;

        // The ceiling is a compiled-in constant — the one bound a deployer cannot argue with.
        if (feeBps_ > MAX_PERFORMANCE_FEE_BPS) revert FeeAboveCeiling();
        // A live rate with nowhere to send the proceeds mints every cut to address(0), burning revenue
        // silently and forever.
        if (feeBps_ != 0 && recip_ == address(0)) revert FeeRecipientRequired();
        // THE ONE THAT MATTERS: paying ourselves rebuilds the 2026-08-01 shared pot in ERC-6909 form.
        if (recip_ == address(this)) revert FeeRecipientCannotBeThisContract();
        performanceFeeBps = feeBps_;
        feeRecipient = recip_;
    }

    /// @notice THE ROOT KEY. Whoever holds this can replace every line of this contract, including
    ///         `withdraw`. Read the header: it is why the custody claim here is a claim about the CURRENT
    ///         implementation and about this address's diligence, not about arithmetic.
    address public upgradeAdmin;

    /// @notice Position size band. 0 disables either end. Both are settable by `upgradeAdmin` ALONE.
    ///
    /// WHY A SETTER IS DEFENSIBLE HERE AND WOULD NOT HAVE BEEN BEFORE. This contract is upgradeable, so
    /// `upgradeAdmin` can already change any of these by shipping a new implementation. A bounded setter
    /// therefore grants NO new power — it only makes an existing power cheaper and, more importantly,
    /// VISIBLE as an event instead of arriving buried in a code diff. The alternative was another
    /// initializer argument, which would have churned ~100 call sites for no security gain.
    ///
    /// `minPositionLiquidity` is the dust floor: positions too small to be worth a keeper's gas are the
    /// reason F-2's minimum-viable-deposit arithmetic exists. `maxPositionLiquidity` is the deposit cap —
    /// its real job is stopping THIS VAULT from becoming the pool's dominant LP, which is the condition
    /// that made the oracle cheap to walk in F-4.
    uint128 public minPositionLiquidity;
    uint128 public maxPositionLiquidity;

    /// @notice Positions whose owner has opted OUT of keeper management. Owner-set, owner-only, one way
    ///         per position and reversible only by the owner.
    /// @dev The missing half of the keeper story. Every bound in this contract limits what a keeper may
    ///      do; none of them let a user say "not to mine". A depositor who stops trusting the keeper had
    ///      only one remedy — withdraw — which is a real remedy but a blunt one, and it forces an exit
    ///      at whatever the price happens to be. This is the surgical version.
    mapping(uint256 => bool) public keeperRevoked;


    /// @notice The keeper's authority ends at this timestamp. 0 = never expires.
    /// @dev A dead man's switch on the operator. Revocation is the depositor opting out one position at
    ///      a time; this is the PROTOCOL declining to trust a key indefinitely. If the keeper service is
    ///      abandoned, sold, or quietly compromised and nobody notices, an expiry means the blast radius
    ///      closes on its own instead of staying open until someone acts. Positions are never stranded by
    ///      it — an expired keeper only stops REBALANCING, and withdrawal never needed the keeper.
    uint64 public keeperExpiry;

    event KeeperExpirySet(uint64 expiry);
    event FeeRecipientSet(address indexed from, address indexed to);

    /// @notice Extend or clear the keeper's expiry. 0 disables it.
    function setKeeperExpiry(uint64 expiry) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        keeperExpiry = expiry;
        emit KeeperExpirySet(expiry);
    }

    /// @notice Repoint the performance fee.
    /// @dev Needed because the fee is paid as ERC-6909 claims, which only a contract that can `unlock`
    ///      is able to redeem — see MoleFeeCollector. Without a setter, a deployment that named a plain
    ///      wallet would accrue revenue nobody could ever reach. Same argument as the size band: the
    ///      upgrade key can already do this by shipping a new implementation, so a bounded setter grants
    ///      no new power and makes the change an event instead of a code diff.
    function setFeeRecipient(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        if (performanceFeeBps != 0 && to == address(0)) revert FeeRecipientRequired();
        // The one that matters: paying ourselves rebuilds the shared pot in ERC-6909 form.
        if (to == address(this)) revert FeeRecipientCannotBeThisContract();
        emit FeeRecipientSet(feeRecipient, to);
        feeRecipient = to;
    }

    event PositionSizeBandSet(uint128 minLiquidity, uint128 maxLiquidity);
    event KeeperRevoked(uint256 indexed id, address indexed owner, bool revoked);

    /// @notice The leftover from a zap, paid straight to the depositor.
    event ZapResidualPaid(uint256 indexed positionId, address indexed owner, uint256 amount0, uint256 amount1);

    /// @notice Set the position size band. Emits, so a change is observable without reading storage.
    function setPositionSizeBand(uint128 minLiquidity, uint128 maxLiquidity) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        // A max below a live min would refuse every deposit, which is a pause by arithmetic — and a
        // pause on the DEPOSIT side is legitimate, but it must be deliberate rather than a fat finger.
        if (maxLiquidity != 0 && minLiquidity > maxLiquidity) revert CapAboveCeiling();
        minPositionLiquidity = minLiquidity;
        maxPositionLiquidity = maxLiquidity;
        emit PositionSizeBandSet(minLiquidity, maxLiquidity);
    }

    event RangeWidthBandSet(int24 minWidth, int24 maxWidth);

    /// @notice Set the legal range-width band for new positions. Emits, so a change is observable.
    /// @dev The band was initializer-only, which froze `maxRangeWidth` at 60,000 ticks while the
    ///      launchpad seeds this chain's pools with 120,000-tick single-sided ranges — so a deposit
    ///      matching the native launch shape was refusable but not configurable. Same invariants as
    ///      `initialize`, checked the same way. Existing positions are untouched: the band gates
    ///      `_validateRange` on open/rebalance only, never withdrawal.
    function setRangeWidthBand(int24 minWidth, int24 maxWidth) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        if (minWidth <= 0 || maxWidth < minWidth) revert BadRangeBounds();
        minRangeWidth = minWidth;
        maxRangeWidth = maxWidth;
        emit RangeWidthBandSet(minWidth, maxWidth);
    }

    /// @notice Opt a position in or out of keeper management. Owner only.
    /// @dev Note what this deliberately does NOT touch: withdrawal. Revoking the keeper cannot strand a
    ///      position, because the exit never depended on the keeper in the first place.
    function setKeeperRevoked(uint256 id, bool revoked) external onlyPositionOwner(id) {
        keeperRevoked[id] = revoked;
        emit KeeperRevoked(id, msg.sender, revoked);
    }

    /// @dev Reserved so a future version can add state without colliding with anything below it.
    uint256[45] private __gap;

    event UpgradeAdminTransferred(address indexed from, address indexed to);

    error NotUpgradeAdmin();

    function _authorizeUpgrade(address) internal override {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
    }

    /// @notice Hand the root key to somebody else — a multisig, a timelock, or address(0) to give it up.
    /// @dev Transferring to address(0) makes this contract permanently immutable and restores the
    ///      original security property in full. That is a real option and it is the one that makes the
    ///      "a compromised keeper cannot take a token" claim true again.
    function transferUpgradeAdmin(address to) external {
        if (msg.sender != upgradeAdmin) revert NotUpgradeAdmin();
        emit UpgradeAdminTransferred(upgradeAdmin, to);
        upgradeAdmin = to;
    }

    /* ------------------------------------------------------------------ modifiers */

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    /// @dev Note the absence of a `whenNotPaused` anywhere in this contract. Withdrawal must never be
    ///      pausable. This is currently enforced by review and by the absence of any pause machinery at
    ///      all — an earlier version of this comment claimed "a static check in CI asserts" it, which was
    ///      false: there is no CI in this repository, and it is not a git repository.
    modifier onlyPositionOwner(uint256 id) {
        if (_positions[id].owner != msg.sender) revert NotOwner();
        _;
    }

    /* ----------------------------------------------------------------- whitelist */

    /// @notice Register a pool this contract will manage positions in.
    /// @dev Permissionless, and fail-closed. Admission is an ALLOWLIST on the pool's hook identity:
    ///      the hook must equal `moleHook` and nothing else. Permissionless is safe precisely because
    ///      the allowlist is compiled in — anyone may call this, but no caller can enlarge the set of
    ///      admissible hooks, so the keeper's and the deposit path's reach cannot be widened by a
    ///      stranger.
    ///
    ///      Why identity and not a permission-bit filter. An earlier version admitted any hook that
    ///      lacked the remove-liquidity bits ("absence of power over the withdrawal path"). That is
    ///      fail-OPEN: it admits every hook shape except the ones it enumerates, so a hook carrying
    ///      AFTER_ADD_LIQUIDITY_RETURNS_DELTA (0x0002) passed admission and then taxed open() to the
    ///      limit of the opener's allowance (finding F-1), and a hook could still manipulate swap
    ///      pricing or abuse the dynamic fee on callbacks the filter never named. The fix is not to
    ///      enumerate one more forbidden bit — that is the same fail-open shape and the same
    ///      deposit-path-validator-with-a-carve-out that cost Gamma $6.18M — but to deny by default.
    ///
    ///      This costs nothing real. A pool's hook is part of its PoolId and can never change, and our
    ///      price/fee oracle is first-party hook code, so a pool that does not carry our hook has no
    ///      oracle and is unservable anyway. Admitting a foreign hook only ever adds attack surface.
    ///
    ///      A deployment always pins the mined MoleHook. address(0) remains legal and means hookless-only
    ///      admission, which is what the test and staging worlds use to separate custody behaviour from
    ///      hook behaviour; it is not a pending state. The bit-safety of a non-zero pin is proven once, in
    ///      the constructor, and test/GuardCoverage.t.sol drives both refusals.
    function whitelistPool(PoolKey calldata key) external {
        if (address(key.hooks) != moleHook) revert HookNotPermitted();
        if (key.tickSpacing <= 0) revert InvalidTickSpacing();
        // NATIVE ETH IS SUPPORTED. It used to be refused here, because every deposit settled with
        // `transferFrom` on `Currency.unwrap(currency)` — address(0) for native, which is a call to an
        // EMPTY ACCOUNT that returns SUCCESS with empty returndata, so the transfer layer could never
        // catch it and the deposit died much later as an unsettled delta. `_settleFrom` now branches on
        // the native case and pays with `settle{value:}` instead, which is the only correct way, so the
        // refusal is no longer needed. Native can only ever be currency0 (address(0) sorts lowest).

        PoolId id = key.toId();
        if (isWhitelisted[id]) revert PoolAlreadyWhitelisted();
        isWhitelisted[id] = true;
        _pools[id] = key;
        emit PoolWhitelisted(id);
    }

    /* ---------------------------------------------------------------- user entry */

    /// @notice Deposit ONE token and get a two-sided position. The product's headline promise, finally in
    ///         code: swap part of the input and mint liquidity from both halves, inside a single unlock.
    ///
    /// @dev WHY `swapAmount` IS A PARAMETER AND NOT COMPUTED HERE. The optimal split depends on the range,
    ///      the current price and the pool's depth, and solving it on chain costs gas on every deposit to
    ///      reproduce a number the caller can compute for free. Worse, an on-chain solver would have to
    ///      read spot — and a deposit path that reads spot is a deposit path an ordering-privileged party
    ///      can price. So the caller names the split and `minLiquidity` is the slippage bound: if the swap
    ///      returns less than expected, the whole thing reverts and the user keeps their tokens.
    ///
    ///      THE VAULT STILL HOLDS NOTHING. Every leg here is a PoolManager delta inside one unlock —
    ///      settle the input, swap, mint, return the remainder to the owner — and deltas net to zero
    ///      before the unlock closes. No ERC-20 balance is ever held between transactions, so INV-1 is
    ///      untouched. Verify it the same way as everywhere else: `balanceOf(vault) == 0`.
    ///
    ///      The residual goes to the OWNER, never to this contract — the same rule as a rebalance, and for
    ///      the same reason.
    function zapOpen(ZapLogic.ZapParams calldata z, uint256 deadline) external payable returns (uint256 id) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        PoolId poolId = z.key.toId();
        if (!isWhitelisted[poolId]) revert PoolNotWhitelisted();
        if (z.amountIn == 0 || z.swapAmount >= z.amountIn) revert ZeroLiquidity();
        if (z.minLiquidity == 0) revert ZeroLiquidity();
        if (minPositionLiquidity != 0 && z.minLiquidity < minPositionLiquidity) revert PositionTooSmall();
        if (maxPositionLiquidity != 0 && z.minLiquidity > maxPositionLiquidity) revert PositionTooLarge();
        _validateRange(z.key, z.tickLower, z.tickUpper);

        id = ++positionCount;
        _positions[id] = Position({
            owner: msg.sender,
            poolId: poolId,
            tickLower: z.tickLower,
            tickUpper: z.tickUpper,
            liquidity: 0, // written by the callback, once the swap has told us what we can actually mint
            openedAtL1Block: uint64(block.number),
            lastRebalancedAt: uint64(block.timestamp)
        });
        _ownerPositions[msg.sender].push(id);

        bytes memory res = poolManager.unlock(abi.encode(Action.ZapOpen, id, z));
        uint128 minted = abi.decode(res, (uint128));
        if (minted < z.minLiquidity) revert MintedBelowMinimum();

        // THE SINGLE STORAGE WRITE, and it lives here rather than in the library on purpose. A
        // delegatecalled library shares this contract's storage LAYOUT, so a library that wrote
        // `_positions[id]` would be hard-coding a slot that any future reordering of fields silently
        // invalidates. ZapLogic therefore reads and writes no storage at all: it returns what it minted
        // and the vault records it. (Caught by the tests the moment it was missing — every zap minted a
        // position with zero liquidity.)
        _positions[id].liquidity = minted;

        // THE BAND IS RE-CHECKED ON WHAT WAS ACTUALLY MINTED, and this line is the whole point.
        // The pre-check above reads `z.minLiquidity`, which is the CALLER'S OWN DECLARED FLOOR — a number
        // they choose freely. Checking only that let anyone declare a floor inside the band and then
        // deposit whatever they liked: an adversarial test measured a position more than 10x the cap,
        // opened under a cap that was configured and live. A deposit cap validated against a
        // caller-supplied number is not a deposit cap.
        //
        // The cap exists to stop THIS VAULT becoming the pool's dominant LP, which is the condition that
        // made the oracle cheap to walk in F-4 — so a bypass here is not a bookkeeping nicety.
        // ONLY THE CEILING, and the asymmetry is the interesting part. The FLOOR needs no re-check because
        // it is already enforced transitively: the pre-check above rejects `z.minLiquidity` below the
        // floor, and the line above rejects `minted` below `z.minLiquidity`, so
        // `minted >= z.minLiquidity >= minPositionLiquidity` holds without a third comparison. Mutation
        // testing confirmed it — deleting a floor re-check here killed nothing, because nothing could
        // reach it. The CEILING has no such chain: `minted` may exceed `z.minLiquidity` without limit,
        // which is exactly the bypass an adversarial test measured at more than 10x the configured cap.
        if (maxPositionLiquidity != 0 && minted > maxPositionLiquidity) revert PositionTooLarge();

        _refundNative();
        emit PositionOpened(id, msg.sender, poolId, z.tickLower, z.tickUpper, minted);
    }


    /// @notice Open a position owned by `msg.sender`. Tokens are pulled from the caller and become
    ///         v4 liquidity inside the PoolManager; this contract never retains a balance.
    /// @dev There is deliberately no `owner` or `recipient` parameter. The owner is `msg.sender`,
    ///      full stop — so a phished approval cannot be used to open a position that pays elsewhere.
    /// @param amount0Max Hard ceiling on currency0 pulled from the caller. NOT a courtesy — without it
    ///        the caller names a liquidity amount and the spot price decides the bill against their
    ///        whole approval, so whoever orders transactions chooses what basket they buy. On a chain
    ///        with a single sequencer and no public mempool, that is not a theoretical ordering risk.
    /// @param amount1Max Hard ceiling on currency1, same reasoning.
    /// @param deadline Rejects execution after this timestamp.
    function open(
        PoolKey calldata key,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 amount0Max,
        uint256 amount1Max,
        uint256 deadline
    ) external payable returns (uint256 id) {
        if (block.timestamp > deadline) revert DeadlinePassed();
        PoolId poolId = key.toId();
        if (!isWhitelisted[poolId]) revert PoolNotWhitelisted();
        if (liquidity == 0) revert ZeroLiquidity();
        // The size band. Checked on the DECLARED liquidity, before anything is pulled, so a refused
        // deposit costs the user gas and nothing else.
        if (minPositionLiquidity != 0 && liquidity < minPositionLiquidity) revert PositionTooSmall();
        if (maxPositionLiquidity != 0 && liquidity > maxPositionLiquidity) revert PositionTooLarge();
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

        _refundNative();
        emit PositionOpened(id, msg.sender, poolId, tickLower, tickUpper, liquidity);
    }

    /// @notice Withdraw the entire position in one call.
    /// @dev Exists because a position's liquidity NUMBER changes across a rebalance — the fix to the
    ///      2026-08-01 exploit conserves token AMOUNTS, so narrowing a range means the same tokens buy
    ///      MORE liquidity. Any caller that read `liquidity`, waited, and then passed it back would
    ///      under-withdraw and leave a remainder behind. Reading it inside the same call removes that
    ///      race entirely, and it is the exit an integrator should reach for by default.
    function withdrawAll(uint256 id) external {
        withdraw(id, _positions[id].liquidity);
    }

    /// @notice Withdraw liquidity. Proceeds go to `positions[id].owner`, read from storage.
    /// @dev The only exit path, and it needs neither the keeper nor any off-chain component. If every
    ///      service this project runs disappeared, this function would still work.
    function withdraw(uint256 id, uint128 liquidityToRemove) public onlyPositionOwner(id) {
        Position storage p = _positions[id];
        if (liquidityToRemove == 0) revert ZeroLiquidity();
        if (liquidityToRemove > p.liquidity) revert InsufficientLiquidity();

        p.liquidity -= liquidityToRemove;

        bytes memory res = poolManager.unlock(
            abi.encode(
                Action.Withdraw, id, p.owner, -int256(uint256(liquidityToRemove)), int24(0), int24(0), uint256(0), uint256(0)
            )
        );
        (uint256 amount0, uint256 amount1) = abi.decode(res, (uint256, uint256));

        emit PositionWithdrawn(id, p.owner, liquidityToRemove, amount0, amount1);
    }

    /* -------------------------------------------------------------------- keeper */

    /// @notice Move a position to a new range. Liquidity is removed and re-added in one unlock, so it
    ///         never leaves the PoolManager and never passes through an address the keeper chooses.
    /// @dev What the keeper provably cannot do here: change the owner, withdraw to itself, touch a
    ///      different pool, or exceed the immutable width bounds. What it CAN do is pick a bad range —
    ///      that is the residual grief budget. It is now bounded on six axes rather than two: the
    ///      per-position cadence, the L1-paced dwell, the global per-L1-block budget, the TWAP deviation
    ///      bound on where the new range may sit, the price-INDEPENDENT limit on how far one rebalance may
    ///      move it, and the optional cap on how much of a leg a single rebalance may hand back. What remains unbounded is taste — a legal range can still be a poor
    ///      one, and that is degradation, which the security model permits.
    function rebalance(uint256 id, int24 newTickLower, int24 newTickUpper) external onlyKeeper {
        Position storage p = _positions[id];
        if (p.owner == address(0)) revert NoSuchPosition();
        // THE OWNER'S VETO, checked first because it is the only bound here that is not ours to set. Every
        // other limit below is a promise the protocol makes about the keeper; this one is the depositor
        // overriding all of them for their own position. Cheapest check, and the one that should win.
        if (keeperRevoked[id]) revert KeeperRevokedForPosition();
        if (keeperExpiry != 0 && block.timestamp > keeperExpiry) revert KeeperExpired();
        if (block.timestamp < uint256(p.lastRebalancedAt) + minRebalanceInterval) revert RebalanceTooSoon();

        // DWELL. A position must exist for a minimum number of L1 blocks before the keeper may touch it.
        // This is the guard the contract header has always described; until now the field was stamped and
        // never read, so the claim was decoration. It closes same-transaction open-then-reshape patterns,
        // and it is measured in `block.number` precisely because on this chain that is the Ethereum height
        // and therefore a clock the sequencer cannot advance by producing L2 blocks.
        if (block.number < uint256(p.openedAtL1Block) + minDwellL1Blocks) revert DwellNotElapsed();

        // GLOBAL BUDGET. The per-position interval says nothing about the book as a whole: without this,
        // one transaction could reshape every position at once, so a compromised keeper's blast radius was
        // unbounded even though each position was individually rate-limited.
        if (maxRebalancesPerL1Block != 0) {
            uint16 used = rebalancesUsedInL1Block[block.number] + 1;
            if (used > maxRebalancesPerL1Block) revert RebalanceBudgetExhausted();
            rebalancesUsedInL1Block[block.number] = used;
        }

        PoolKey memory key = _pools[p.poolId];
        _validateRange(key, newTickLower, newTickUpper);

        // RELATIVE BOUND, CHECKED FIRST because it is the one that survives a dishonest oracle. It reads
        // no price at all: a rebalance may only move the position's midpoint `maxRecenterTicks` from where
        // it already is, so however far an attacker walks spot or the TWAP, the position follows only at
        // the rate the cadence allows — and the owner can exit at any point in between.
        if (maxRecenterTicks > 0) {
            int24 oldMid = (p.tickLower + p.tickUpper) / 2;
            int24 newMid = (newTickLower + newTickUpper) / 2;
            int24 moved = newMid > oldMid ? newMid - oldMid : oldMid - newMid;
            if (moved > maxRecenterTicks) revert RecenterTooFar();
        }

        // TWAP BOUND. The keeper picks WHERE the position sits; this is the only thing that stops it
        // picking a wick. The anchor is the time-averaged tick from our own oracle, never slot0, because
        // spot is exactly what an ordering-privileged party can move for free. Note the oracle REVERTS
        // when the requested window is not covered, so a young or idle pool cannot be rebalanced at all
        // until the oracle has warmed up — that is deliberate: refusing to act beats acting blind.
        if (maxTwapDeviationTicks > 0) {
            int24 twapTick = IMoleOracle(moleHook).consult(p.poolId, twapWindow);
            int24 mid = (newTickLower + newTickUpper) / 2;
            int24 deviation = mid > twapTick ? mid - twapTick : twapTick - mid;
            if (deviation > maxTwapDeviationTicks) revert RangeTooFarFromTwap();
        }

        int24 oldLower = p.tickLower;
        int24 oldUpper = p.tickUpper;
        uint128 liq = p.liquidity;
        if (liq == 0) revert ZeroLiquidity();

        p.lastRebalancedAt = uint64(block.timestamp);

        poolManager.unlock(
            abi.encode(Action.Rebalance, id, p.owner, int256(0), newTickLower, newTickUpper, uint256(0), uint256(0))
        );

        emit PositionRebalanced(id, oldLower, oldUpper, newTickLower, newTickUpper, p.liquidity);
    }

    /* ------------------------------------------------------------------ callback */

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        // The zap carries a different payload shape, so it is peeled off before the positional decode
        // below. Reading the discriminator alone first is the only safe way to branch on a union.
        if (abi.decode(data[:32], (Action)) == Action.ZapOpen) {
            (, uint256 zid, ZapLogic.ZapParams memory z) = abi.decode(data, (Action, uint256, ZapLogic.ZapParams));
            // owner READ FROM STORAGE and handed to the library, which reads no storage itself.
            return abi.encode(ZapLogic.execute(poolManager, z, _positions[zid].owner, zid));
        }

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
            // NO FEE HERE, EVER. A deposit realizes nothing: the position is new, its salt is this id and
            // no other, so there are no accrued fees to take a cut of. The fee-free-deposit promise is
            // therefore structural, but it is also asserted below rather than left to reasoning.
            (BalanceDelta delta, BalanceDelta feesOnOpen) = _modify(key, p.tickLower, p.tickUpper, liquidityDelta, id);
            if (feesOnOpen.amount0() != 0 || feesOnOpen.amount1() != 0) revert DepositAccruedFees();
            if (delta.amount0() < 0 && uint256(uint128(-delta.amount0())) > amount0Max) revert ExceedsMaxAmount();
            if (delta.amount1() < 0 && uint256(uint128(-delta.amount1())) > amount1Max) revert ExceedsMaxAmount();
            _payOwed(key, delta, owner);
            return "";
        }

        if (action == Action.Withdraw) {
            (BalanceDelta delta, BalanceDelta exitFees) =
                _modify(key, p.tickLower, p.tickUpper, liquidityDelta, id);

            // The cut is charged here too, and it has to be: fees realize on ANY liquidity change, so a
            // vault that only skimmed at rebalance would be avoidable by anyone who exits before one.
            // It is still not a withdrawal fee — `feesAccrued` is what the position EARNED, and the
            // principal component of `delta` is never touched. A user who earned nothing pays nothing
            // and gets every wei of principal back.
            (uint128 exitCut0, uint128 exitCut1) = _takePerformanceFee(key, exitFees, id);

            // Recipient is the stored owner. Never a parameter, never msg.sender, never the keeper.
            (uint256 a0, uint256 a1) =
                _collectTo(key, delta - toBalanceDelta(int128(exitCut0), int128(exitCut1)), p.owner);
            return abi.encode(a0, a1);
        }

        // Rebalance: burn the whole position at the old range and re-mint at the new one.
        //
        // THE THING THAT MUST BE CONSERVED IS TOKEN AMOUNTS, NOT THE LIQUIDITY NUMBER. The token value
        // of a fixed L depends on the range width, so re-minting the same L at a narrower range needs
        // fewer tokens and leaves a surplus — and re-minting at a wider range needs more. An earlier
        // version of this function kept L constant and parked that surplus in this contract's own
        // balance, which created one unattributed pot shared by every position: a narrowing rebalance
        // of a victim funded a widening rebalance of the keeper's own position, and the keeper then
        // withdrew to itself entirely legitimately, since it really was the stored owner. Measured at
        // ~86x the attacker's stake against a victim who lost 98.8% of a deposit. So:
        //
        //   - the new liquidity is DERIVED from the amounts the burn actually returned, at the new
        //     range and the current price, rounded down by construction;
        //   - accrued fees are included in those amounts, so they compound into the owner's own
        //     position rather than being swept anywhere;
        //   - the leftover dust goes to the OWNER, never to this contract;
        //   - this contract neither holds nor spends an inventory, so no shared pot can exist.
        //
        // A rebalance is now delta-neutral by construction and moves no value between positions.
        uint128 liq = p.liquidity;
        (BalanceDelta removed, BalanceDelta feesAccrued) =
            _modify(key, p.tickLower, p.tickUpper, -int256(uint256(liq)), id);

        // THE PROTOCOL'S CUT, taken here and nowhere else on this path, from the fee component only. What
        // remains compounds into the owner's own new position exactly as it did before — the fee changes
        // how much compounds, never who it belongs to.
        (uint128 cut0, uint128 cut1) = _takePerformanceFee(key, feesAccrued, id);

        // Everything the burn returned MINUS our cut: principal plus the fees the owner keeps. Both legs
        // are non-negative here, and the subtraction cannot underflow because `removed` is principal plus
        // fees while the cut is a fraction of fees alone — but it is bounded rather than asserted, since
        // an underflow here would revert a rebalance rather than mis-price one, and a keeper that cannot
        // rebalance is a far better failure than a keeper that silently takes principal.
        uint256 gross0 = removed.amount0() > 0 ? uint256(uint128(removed.amount0())) : 0;
        uint256 gross1 = removed.amount1() > 0 ? uint256(uint128(removed.amount1())) : 0;
        uint256 have0 = gross0 > cut0 ? gross0 - cut0 : 0;
        uint256 have1 = gross1 > cut1 ? gross1 - cut1 : 0;

        (uint160 sqrtPriceX96,,,) = StateLibrary.getSlot0(poolManager, p.poolId);
        uint128 newLiquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(newLower),
            TickMath.getSqrtPriceAtTick(newUpper),
            have0,
            have1
        );
        if (newLiquidity == 0) revert ZeroLiquidity();

        p.tickLower = newLower;
        p.tickUpper = newUpper;
        p.liquidity = newLiquidity;

        (BalanceDelta added,) = _modify(key, newLower, newUpper, int256(uint256(newLiquidity)), id);
        // The cut has already been minted out of our delta, so it is subtracted here too. Leaving it in
        // would pay the owner the protocol's share as residual AND mint it to the recipient — the same
        // wei counted twice, which the unlock would then refuse to balance.
        BalanceDelta net = removed + added - toBalanceDelta(int128(cut0), int128(cut1));

        // getLiquidityForAmounts rounds down, so the mint can never cost more than the burn returned.
        // If it somehow does, that is a broken invariant and we refuse rather than dip into anything.
        if (net.amount0() < 0 || net.amount1() < 0) revert RebalanceNotSelfFunding();

        // THE RESIDUAL BELONGS TO THE OWNER. Calling it "dust" here was wrong: when the new range wants a
        // token ratio the old range does not hold, this can be most of a leg. It still goes to the owner
        // and this contract still keeps nothing — that is the custody invariant — but it is emitted so the
        // size is observable off-chain rather than silent, and bounded when the deployment asks for it.
        uint256 residual0 = net.amount0() > 0 ? uint256(uint128(net.amount0())) : 0;
        uint256 residual1 = net.amount1() > 0 ? uint256(uint128(net.amount1())) : 0;

        if (maxEjectionBps < 10_000) {
            if (residual0 * 10_000 > have0 * uint256(maxEjectionBps)) revert EjectionTooLarge();
            if (residual1 * 10_000 > have1 * uint256(maxEjectionBps)) revert EjectionTooLarge();
        }

        _collectTo(key, net, p.owner);
        emit RebalanceResidualPaid(id, p.owner, residual0, residual1);
        return "";
    }


    /// @dev Return any ETH the deposit did not consume. A concentrated-liquidity mint takes the amount
    ///      the MATH decides, never the amount the caller happened to send, so an exact-value rule would
    ///      make every native deposit a guessing game. Sending too much is normal and is refunded here.
    ///
    ///      Sweeping the whole balance is correct rather than sloppy: this contract holds no ETH between
    ///      transactions by construction — that is INV-1 — so anything sitting here at the end of a
    ///      deposit is this caller's change.
    function _refundNative() private {
        uint256 left = address(this).balance;
        if (left == 0) return;
        (bool ok,) = msg.sender.call{value: left}("");
        if (!ok) revert NativeRefundFailed();
    }

    // NO `receive()`, deliberately. Nothing ever sends this contract bare ETH: a native `take()` pays
    // the stored owner directly, and a depositor's ETH arrives as `msg.value` on the payable entry
    // points. Adding one would make the contract's TYPE payable, which forces every
    // `MolePositions(address)` cast in the codebase to become `MolePositions(payable(address))` — real
    // churn across ~90 call sites, bought for a path that does not exist.

    /* ------------------------------------------------------------------ internals */

    /// @dev Returns BOTH halves of what the PoolManager reports, and the second one is load-bearing.
    ///      `callerDelta` is principal PLUS fees; `feesAccrued` is the fee component alone. The
    ///      performance fee is computed only ever from the second. This used to discard `feesAccrued`
    ///      with `(BalanceDelta callerDelta,)` — the number the whole revenue model needs was being
    ///      thrown away one line after the pool handed it over.
    function _modify(PoolKey memory key, int24 lower, int24 upper, int256 liquidityDelta, uint256 id)
        private
        returns (BalanceDelta, BalanceDelta)
    {
        // Salt is the position id, so every position is distinct inside the PoolManager and remains
        // enumerable from our own events alone — required for the TVL adapter (Part 16.10).
        (BalanceDelta callerDelta, BalanceDelta feesAccrued) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(id)
            }),
            ""
        );
        return (callerDelta, feesAccrued);
    }

    /// @dev Take the protocol's cut of REALIZED fees and mint it to the recipient as ERC-6909 claims.
    ///
    ///      WHY MINT AND NOT TRANSFER. `take()` would move real ERC-20s and call the token, which means a
    ///      blocklisting, pausable or otherwise hostile token could revert inside the unlock — and this
    ///      function is on the WITHDRAWAL path. A fee that can brick an exit is not a fee, it is a
    ///      hostage. `mint` is a balance credit inside the PoolManager that touches no token contract, so
    ///      it cannot revert on anything the token does. If the recipient is broken or unreachable, the
    ///      claims simply sit there unswept, which is harmless and does not delay anyone's withdrawal.
    ///
    ///      Only POSITIVE components are charged. A negative fee component is not a thing v4 produces on
    ///      a position we own, but treating one as chargeable would invert the sign and mint against the
    ///      user, so the guard is written rather than assumed.
    function _takePerformanceFee(PoolKey memory key, BalanceDelta feesAccrued, uint256 id)
        private
        returns (uint128 cut0, uint128 cut1)
    {
        if (performanceFeeBps == 0) return (0, 0);

        cut0 = _cutOf(feesAccrued.amount0());
        cut1 = _cutOf(feesAccrued.amount1());

        if (cut0 != 0) poolManager.mint(feeRecipient, key.currency0.toId(), cut0);
        if (cut1 != 0) poolManager.mint(feeRecipient, key.currency1.toId(), cut1);

        // Emitted even when a leg is zero, so the off-chain net-APY figure can be reconstructed from
        // events alone. A performance fee nobody can measure is a performance fee nobody can check.
        if (cut0 != 0 || cut1 != 0) emit PerformanceFeeTaken(id, feeRecipient, cut0, cut1);
    }

    /// @dev The fee arithmetic, alone and side-effect free, so it can be fuzzed directly instead of only
    ///      being inferred from payouts. Two properties live here and both were unkillable by payout-level
    ///      tests — a wei of rounding hides inside any sane tolerance:
    ///
    ///        ROUNDS DOWN. Integer division truncates, so the remainder goes to the USER. A later refactor
    ///        to a mulDivUp-style helper would silently invert that, and on a busy pool "one wei per
    ///        realization, in our favour" is a policy nobody voted for.
    ///
    ///        NON-POSITIVE MEANS ZERO. v4 does not hand a position owner a negative fee component, so this
    ///        branch is unreachable today — but `uint256(uint128(negative))` is an enormous number, and a
    ///        cut computed from it would be a catastrophic mint rather than a small error. The guard is
    ///        cheap; the failure it prevents is not.
    function _cutOf(int128 feeComponent) internal view returns (uint128) {
        if (feeComponent <= 0) return 0;
        return uint128((uint256(uint128(feeComponent)) * performanceFeeBps) / 10_000);
    }

    /// @dev Pull what we owe from `payer` and settle it. Used on open().
    function _payOwed(PoolKey memory key, BalanceDelta delta, address payer) private {
        int128 d0 = delta.amount0();
        int128 d1 = delta.amount1();
        if (d0 < 0) _settleFrom(key.currency0, uint256(uint128(-d0)), payer);
        if (d1 < 0) _settleFrom(key.currency1, uint256(uint128(-d1)), payer);
    }

    /// @dev Send everything the pool owes us straight to `to`. `to` is always a stored owner.
    function _collectTo(PoolKey memory key, BalanceDelta delta, address to)
        private
        returns (uint256 a0, uint256 a1)
    {
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

    // _settleNet was deleted deliberately. It was the function that gave this contract an inventory —
    // taking surplus to address(this) and paying deficits from address(this) — and that inventory was
    // the bridge a compromised keeper used to move one user's principal into another position. There
    // is now no code path in this contract that leaves it holding a token balance, and none that
    // spends one. If a future change needs the contract to hold tokens, that change reintroduces the
    // vulnerability and must be argued for explicitly rather than added quietly.

    /// @dev sync -> transferFrom -> settle, as one indivisible triple with no external call between the
    ///      sync and the settle. Interleaving anything there is a known way to misattribute a balance.
    ///
    ///      `payer` is always a user, and there is deliberately NO branch that pays from this contract's
    ///      own balance. There used to be one — it is what `_settleNet` called, and it is the shared pot
    ///      described above. Deleting `_settleNet` left it orphaned and unreachable, which made the
    ///      paragraph above true only by accident; a single future call site would have quietly restored
    ///      the 2026-08-01 attack surface. Removing it makes "this contract never spends an inventory"
    ///      something a reader verifies from this function instead of trusting from a comment, and it
    ///      fails closed regardless: paying from self would now need a self-allowance that never exists.
    function _settleFrom(Currency currency, uint256 amount, address payer) private {
        if (Currency.unwrap(currency) == address(0)) {
            // NATIVE. There is nothing to sync and nothing to transfer — the value rides along with the
            // call. It comes from `msg.value`, which `open`/`zapOpen` checked was sufficient before the
            // unlock, so `payer` is not consulted here: native ETH cannot be pulled from an allowance and
            // pretending otherwise would be the only dishonest line in this function.
            poolManager.settle{value: amount}();
            return;
        }
        poolManager.sync(currency);
        _safeTransferFrom(Currency.unwrap(currency), payer, address(poolManager), amount);
        poolManager.settle();
    }

    /// @dev Tolerates tokens that return nothing on success (USDT-style) while still reverting on an
    ///      explicit `false`. We will list arbitrary long-tail and memecoin assets, where assuming a
    ///      standards-compliant bool return is a fund-loss bug rather than a style issue.
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

    /* ---------------------------------------------------------------------- views */

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
