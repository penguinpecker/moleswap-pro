// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title DeployConfig
/// @notice The rules a moleswap deployment must satisfy, in ONE place that both the deploy script and the
///         tests call.
///
/// WHY THIS IS A LIBRARY AND NOT A LIST OF `require`s IN THE SCRIPT. It used to be the latter, and the
/// tests kept a hand-written copy of "the three requires in Deploy.s.sol". That copy drifted twice: it
/// still allowed a TWAP window the ring can never cover after the script was fixed, and it modelled 3 of
/// the script's 12 rules while claiming to model all of them. A test that mirrors a rule instead of calling
/// it is a test of the mirror. Now there is one implementation and no mirror.
///
/// Every value here becomes an IMMUTABLE on a deployed contract. There is no setter and no upgrade path,
/// so a mistake in this struct is a redeployment and — for the hook — a new address, new PoolIds and a
/// forced user migration.
library DeployConfig {
    struct Params {
        // --- hook
        uint24 lpFeePips;
        uint32 obsInterval;
        uint24 hookFeePips;
        address feeRecipient;
        /// @dev Included so EVERY hook policy value passes through validate(). It previously bypassed the
        ///      library entirely, which meant the one knob that changes the pool's liquidity shape — and
        ///      therefore how expensive the oracle is to walk — was the only one nothing checked.
        bool restrictedLiquidity;
        // --- keeper
        uint32 minRebalanceInterval;
        int24 minRangeWidth;
        int24 maxRangeWidth;
        int24 maxTwapDeviationTicks;
        uint32 twapWindow;
        uint64 minDwellL1Blocks;
        uint16 maxRebalancesPerL1Block;
        uint16 maxEjectionBps;
        /// @dev The price-INDEPENDENT recenter bound. Listed last because it was added last, but it is
        ///      the most important of these: it is what stops a compromised keeper following a walked
        ///      oracle, and disabling it re-opens a demonstrated total-loss path.
        int24 maxRecenterTicks;
        /// @dev The protocol's share of REALIZED trading fees, in bps. 1000 = 10%. Charged on earned fees
        ///      only — never on principal, never on AUM, never on a deposit or a withdrawal.
        uint16 performanceFeeBps;
    }

    /// @notice Ring slots in MoleHook. The write that wraps overwrites the oldest entry, so the oldest
    ///         READABLE observation is CARDINALITY - 1 write-gaps back.
    uint16 internal constant CARDINALITY = 256;

    /// @notice Hard fee ceilings. THE definition — MoleHook reads these rather than restating them, so a
    ///         config is rejected here rather than by a constructor revert halfway through a broadcast,
    ///         and the two can no longer disagree. They previously existed as literals in both files with
    ///         no test asserting they matched.
    uint24 internal constant MAX_FEE_CEILING = 100_000; // 10%
    uint24 internal constant MAX_HOOK_FEE = 10_000; // 1%

    /// @notice Hard ceiling on the performance fee. 2000 = 20%. THE definition — MolePositions reads it
    ///         from here and compiles it in, so no constructor argument can exceed it.
    /// @dev 20% is the top of the surveyed market rather than a round number: Charm's own contract caps at
    ///      20%, and Gamma charges 14-20%. Anything above this is outside what the industry itself does.
    uint16 internal constant MAX_PERFORMANCE_FEE_BPS = 2000;

    /* ------------------------------------------------------- the shipped defaults, in ONE place */

    /// @notice The policy this project actually deploys when no env var overrides it.
    /// @dev These were literals in `vm.envOr(...)`, re-typed in the script's `_requireFits` expectations,
    ///      AND hand-copied into the attack suite as `SHIPPED_*` constants — three copies of one decision.
    ///      They drifted: after the deploy defaults were tightened to a 1-day cadence and a 300-block
    ///      dwell, the suite went on asserting against 1 hour and 5 blocks. Nothing failed, because a
    ///      weaker policy still satisfies the same assertions — the tests simply stopped describing the
    ///      deployment. The same class of drift is what made this file a library in the first place.
    uint24 internal constant DEFAULT_LP_FEE_PIPS = 3000; // 0.30%
    uint32 internal constant DEFAULT_OBS_INTERVAL = 60;
    uint24 internal constant DEFAULT_HOOK_FEE_PIPS = 0;
    bool internal constant DEFAULT_RESTRICTED_LIQUIDITY = false;
    uint32 internal constant DEFAULT_MIN_REBALANCE_INTERVAL = 1 days;
    int24 internal constant DEFAULT_MIN_RANGE_WIDTH = 120;
    int24 internal constant DEFAULT_MAX_RANGE_WIDTH = 60_000;
    int24 internal constant DEFAULT_MAX_TWAP_DEVIATION_TICKS = 600;
    uint32 internal constant DEFAULT_TWAP_WINDOW = 1800; // 30 min
    uint64 internal constant DEFAULT_MIN_DWELL_L1_BLOCKS = 300; // ~1 hour of ETHEREUM time
    uint16 internal constant DEFAULT_MAX_REBALANCES_PER_L1_BLOCK = 10;
    /// @notice 7_500 = a rebalance may hand back at most three quarters of either leg. NOT 10_000.
    ///
    /// @dev THIS SHIPPED AT 10_000 — DISABLED — AND IS LIVE AT 10_000 ON BOTH CHAINS. The 2026-08-23 audit
    ///      (F-07 mechanism C) turned that from a conservative default into a load-bearing one: one legal
    ///      keeper step could move a range's EDGE far enough that spot ended up outside it, at which point
    ///      `getLiquidityForAmounts` takes a single-sided branch and an entire leg is ejected to the owner.
    ///      `maxEjectionBps` is named in the finding as the bound that exists for exactly that, and it was
    ///      switched off. A bound that ships off is not a bound; it is a comment.
    ///
    ///      WHY 7_500 AND NOT SOMETHING TIGHTER. The residual a legal recentre produces is a function of
    ///      how far the range moves relative to its own half-width, and it is not small: with the shipped
    ///      600-tick recenter cap, recentring a 1,200-tick range by the full 600 ejects 100% of a leg, by
    ///      300 ejects 66%, by 120 ejects 33%; on a 6,000-tick range the same full 600-tick step ejects
    ///      16%, and on a 60,000-tick range 1.7%. So the cap binds hardest exactly where the step is large
    ///      relative to the position, which is the case worth refusing, and is nearly silent on wide
    ///      ranges. 7_500 makes the total single-step ejection that mechanism C produces impossible while
    ///      still permitting a two-thirds recentre of a minimum-width range. Solving
    ///      (1 - e^-(w-d)) / (1 - e^-(w+d)) = 0.25 puts the binding point at d ≈ 0.6w — a recentre of more
    ///      than 60% of the half-width — which is a keeper decision worth a second look, not a routine one.
    ///
    ///      IT IS A STEP LIMIT, NOT A BUDGET. Five legal 5_000-bps steps were measured stranding 88.6% of
    ///      a leg, because half of a half compounds; `maxRebalancesPerL1Block` and the cadence are what
    ///      bound the compounding. Anyone reading "7_500 = at most three quarters of the position" without
    ///      that sentence is wrong.
    ///
    ///      IT FAILS CLOSED. Refusing a rebalance leaves the position where it is and the owner can always
    ///      `withdrawAll`. Refusing to act is the cheap failure here; acting is not.
    ///
    ///      THE LIVE VAULTS CANNOT BE FIXED BY CHANGING THIS. `maxEjectionBps` is initializer-only, so
    ///      Robinhood Chain 4663 and Arc 5042 stay at 10_000 until someone calls
    ///      `MolePositions.setEjectionCap`, which exists for this and is documented there.
    uint16 internal constant DEFAULT_MAX_EJECTION_BPS = 7_500;
    int24 internal constant DEFAULT_MAX_RECENTER_TICKS = 600;
    /// @dev 10%. Surveyed 2026-08-05 against protocol docs: Charm 2-5%, Beefy CLM 9.5%, ICHI 10%,
    ///      Steer 15%, Gamma 14-20%. 10% is the median and the only rate that can be called standard
    ///      truthfully. Undercutting to 9.5% is imperceptible to a depositor and costs 5% of revenue
    ///      permanently; charging 15% needs a track record this protocol does not have yet.
    uint16 internal constant DEFAULT_PERFORMANCE_FEE_BPS = 1000;

    /* ------------------------------------------------------------- the batch auction (MoleQueue) */

    /// @notice The queue's schedule and price bounds, here for the same reason as everything above: this
    ///         decision must exist once. They are not part of `Params` because the queue is a separate
    ///         deployment with its own initializer, which enforces the relationships between them.
    ///
    /// @dev DEFAULT_QUEUE_EPOCH — 5 minutes. Long enough that opposing flow can actually meet (netting is
    ///      the entire product; an epoch nobody else is in is just a slower swap), short enough that a
    ///      depositor is not committing to an unknown price for an uncomfortable length of time.
    uint32 internal constant DEFAULT_QUEUE_EPOCH = 300;

    /// @dev The B8 freeze window. Its job is to make the settlement price something nobody chose: with no
    ///      wait, `freeze()` and `settle()` fit in one transaction and the settler picks the exact block,
    ///      and therefore the exact spot price, the batch is measured against.
    uint32 internal constant DEFAULT_QUEUE_FREEZE = 60;

    /// @dev The escape hatch. After this much time past the cutoff, an epoch that never settled is
    ///      reclaimable in kind by anyone's call, and a settlement that cannot execute its residual within
    ///      the bound resolves anyway with the unmatched part returned. Must outlast the freeze window.
    uint32 internal constant DEFAULT_QUEUE_MAX_LIFE = 3600;

    /// @dev How far the aggregated residual swap may execute from the TWAP. 300 bps = 3%.
    ///
    ///      THIS IS ALSO A SIZE CAP, and it should be read as one. A batch's own honest price impact is
    ///      indistinguishable from a sandwicher's, so a one-sided epoch large relative to pool depth will
    ///      breach this and have its unmatched part returned in kind at the deadline rather than swapped.
    ///      On a thin pool that is most of them. That is the correct outcome — the alternative is filling
    ///      users at a price the bound exists to refuse — but it means the queue's usefulness scales with
    ///      the pool's depth, and on a young pool the crossing is the only part that will do any work.
    uint16 internal constant DEFAULT_QUEUE_RESIDUAL_BPS = 300;

    /// @notice Reverts with a specific reason if `p` could not or should not be deployed.
    /// @dev Split from the script so it is directly callable from tests. Ordered cheapest-first so a
    ///      typo reports as itself rather than as a downstream consequence.
    function validate(Params memory p) internal pure {
        // --- fee shape. One fixed LP fee: the volatility-scaled version was removed, not repaired,
        //     because whoever collects such a fee is whoever can manufacture the signal behind it.
        require(p.lpFeePips > 0, "cfg: zero fee lets arbitrage reprice the pool for free");
        require(p.lpFeePips <= MAX_FEE_CEILING, "cfg: lp fee above the hard ceiling");
        require(p.hookFeePips <= MAX_HOOK_FEE, "cfg: hook fee above 1%");
        require(p.hookFeePips == 0 || p.feeRecipient != address(0), "cfg: hook fee with no recipient");
        require(p.performanceFeeBps <= MAX_PERFORMANCE_FEE_BPS, "cfg: performance fee above the hard ceiling");
        require(
            p.performanceFeeBps == 0 || p.feeRecipient != address(0),
            "cfg: performance fee with no recipient - the cut would be minted to address(0) and burned"
        );

        // --- oracle shape
        require(p.obsInterval > 0, "cfg: zero observation interval exhausts the ring for the price of dust");
        // --- keeper shape
        require(p.minRangeWidth > 0, "cfg: zero minimum range width");
        require(p.maxRangeWidth >= p.minRangeWidth, "cfg: max range width below min");
        require(p.maxTwapDeviationTicks >= 0, "cfg: negative twap deviation");
        require(p.maxEjectionBps <= 10_000, "cfg: ejection cap above 100%");
        // Zero is a pause by arithmetic: a rebalance almost always leaves SOME residual, so a cap of zero
        // refuses the keeper permanently. Pausing the keeper is a legitimate thing to want and there is a
        // deliberate way to say it (revoke, or expire the key); arriving at it because a uint16 env var
        // truncated to 0 is not. Rejected here rather than discovered on the first rebalance attempt.
        require(p.maxEjectionBps > 0, "cfg: ejection cap of zero refuses every rebalance");
        require(p.maxRecenterTicks >= 0, "cfg: negative recenter cap");
        // Upper bounds too: a "bound" set absurdly high is not a bound. A recenter cap wider than the max
        // range width lets one rebalance move a position further than its own width, and a TWAP band wider
        // than the max range width admits any range the width check already allows.
        require(p.maxRecenterTicks <= p.maxRangeWidth, "cfg: recenter cap wider than the max range width");
        require(p.maxTwapDeviationTicks <= p.maxRangeWidth, "cfg: twap band wider than the max range width");
        // restrictedLiquidity is a security TRADE, not a free win: vault-only liquidity creates
        // zero-liquidity regions, which is what makes spot and therefore the oracle cheap to walk. It is
        // allowed, but it must be paired with the price-independent bound that survives a walked oracle.
        require(
            !p.restrictedLiquidity || p.maxRecenterTicks > 0,
            "cfg: restrictedLiquidity without a recenter cap - the oracle becomes walkable and unbounded"
        );

        // The backtester's finding: the 1-hour floor is never optimal, and longer cadences reduce losses
        // on majors without materially hurting memecoins.
        require(p.minRebalanceInterval >= 1 hours, "cfg: cadence below the backtested floor");

        // A TWAP bound needs a window the ring can actually answer, at both ends.
        if (p.maxTwapDeviationTicks > 0) {
            require(p.twapWindow >= uint32(p.obsInterval) * 2, "cfg: twap window too short for the ring");
            require(
                p.twapWindow <= uint32(p.obsInterval) * uint32(CARDINALITY - 1),
                "cfg: twap window exceeds what the ring can cover (255 gaps)"
            );
        }
    }

    /// @notice True when every bound that protects a user is actually switched on. Zero means DISABLED for
    ///         each of these, which is legitimate but must be deliberate — the script requires an explicit
    ///         acknowledgement rather than letting a typo silently ship an unguarded deployment.
    function allUserBoundsEnabled(Params memory p) internal pure returns (bool) {
        // maxRecenterTicks is in this list deliberately. It is the only bound that survives a dishonest
        // oracle, so shipping with it at zero re-opens the path where a compromised keeper plus one
        // ordinary address took 100% of a position's principal. Disabling it must be said out loud.
        //
        // maxEjectionBps is in this list as of 2026-08-23, and note that its OFF value is 10_000, not 0 —
        // which is why it was missing. Every other bound here reads "0 means disabled", so a list built by
        // testing `> 0` silently gave a pass to the one bound whose disabled value is 10_000. It shipped
        // disabled on both live chains for exactly that reason: nothing ever asked. It is the bound F-07
        // mechanism C names, so shipping without it is a choice, and choices go through MOLE_ACK_UNGUARDED.
        return p.minDwellL1Blocks > 0 && p.maxRebalancesPerL1Block > 0 && p.maxTwapDeviationTicks > 0
            && p.maxRecenterTicks > 0 && p.maxEjectionBps < 10_000;
    }
}
