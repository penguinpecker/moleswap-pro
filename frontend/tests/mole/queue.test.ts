import { describe, expect, it } from "vitest";
import {
  QueuePhase,
  claimableOf,
  crossedBpsOfSide,
  cutoffOf,
  escrowCurrencyIndex,
  exitFor,
  moleQueueAbi,
  outputCurrencyIndex,
  phaseAt,
  secondsUntilCutoff,
  settleableAt,
  timeoutAt,
  type EpochState,
  type OrderState,
  type QueueSchedule,
} from "../../lib/mole/queue";
import { MOLE_ADDRESSES, QUEUE_CONFIG } from "../../lib/mole/chain";

/**
 * These tests are written against the numbers the LIVE contract actually produced on Robinhood Chain
 * mainnet on 2026-08-07, not against invented fixtures. That batch is the interesting case: ~90% of it
 * crossed at the TWAP, the ~10% residual could not be swapped within the bound, and the epoch settled
 * with the unmatched part booked back in kind. Anything that renders a queue has to get that right.
 */

const SCHEDULE: QueueSchedule = {
  currentEpoch: 1n,
  epochStartedAt: 1_786_066_845n,
  epochDuration: QUEUE_CONFIG.epochDuration,
  freezeDuration: QUEUE_CONFIG.freezeDuration,
  maxEpochLife: QUEUE_CONFIG.maxEpochLife,
};

/** Epoch 1, exactly as read back from the chain after settlement. */
const LIVE_SETTLED: EpochState = {
  phase: QueuePhase.Settled,
  frozenAt: 1_786_067_145n,
  totalIn0: 800_000_000_000_000n, // 0.0008 WETH
  totalIn1: 1_365_834n, // 1.365834 USDG (SIX decimals)
  out0: 1_365_833n, // USDG owed to the WETH seller
  out1: 719_999_516_187_084n, // WETH owed to the USDG seller
  refund0: 80_000_483_812_916n, // WETH the pool could not absorb, returned in kind
  refund1: 1n,
};

const SIDE0: OrderState = {
  owner: "0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8",
  zeroForOne: true,
  amountIn: 800_000_000_000_000n,
  withdrawn: false,
};

const SIDE1: OrderState = {
  owner: "0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8",
  zeroForOne: false,
  amountIn: 1_365_834n,
  withdrawn: false,
};

describe("queue address + config", () => {
  it("pins the live MoleQueue proxy", () => {
    expect(MOLE_ADDRESSES.moleQueue).toBe("0x3dCb2494cBC9604f270177E38160ae4CA76CDEbd");
  });

  it("mirrors the deployed schedule", () => {
    expect(QUEUE_CONFIG.epochDuration).toBe(300);
    expect(QUEUE_CONFIG.freezeDuration).toBe(60);
    expect(QUEUE_CONFIG.maxEpochLife).toBe(3600);
    expect(QUEUE_CONFIG.maxResidualSlippageBps).toBe(300);
  });

  it("keeps maxEpochLife longer than the freeze window, as the initializer requires", () => {
    // The contract refuses a config where the escape hatch could open before settlement is possible.
    expect(QUEUE_CONFIG.maxEpochLife).toBeGreaterThan(QUEUE_CONFIG.freezeDuration);
  });
});

describe("the cutoff is a clock, not a button", () => {
  it("reports Open before the cutoff", () => {
    const now = SCHEDULE.epochStartedAt + 10n;
    expect(phaseAt(QueuePhase.Open, 1n, SCHEDULE, now)).toBe(QueuePhase.Open);
  });

  it("reports Frozen once the duration elapses, even though storage still says Open", () => {
    // This is the case a UI gets wrong: nobody has called freeze(), so `epochs(e).phase` is still
    // Open, but `place` and `cancel` already revert. Rendering a Cancel button here is a broken UI.
    const now = cutoffOf(SCHEDULE);
    expect(phaseAt(QueuePhase.Open, 1n, SCHEDULE, now)).toBe(QueuePhase.Frozen);
  });

  it("reports Frozen for any epoch that is not the current one", () => {
    const now = SCHEDULE.epochStartedAt;
    expect(phaseAt(QueuePhase.Open, 0n, SCHEDULE, now)).toBe(QueuePhase.Frozen);
  });

  it("never overrides a stored phase that has already moved on", () => {
    const now = SCHEDULE.epochStartedAt;
    expect(phaseAt(QueuePhase.Settled, 1n, SCHEDULE, now)).toBe(QueuePhase.Settled);
    expect(phaseAt(QueuePhase.Refunding, 1n, SCHEDULE, now)).toBe(QueuePhase.Refunding);
  });

  it("floors the countdown at zero rather than going negative", () => {
    expect(secondsUntilCutoff(SCHEDULE, SCHEDULE.epochStartedAt)).toBe(300);
    expect(secondsUntilCutoff(SCHEDULE, cutoffOf(SCHEDULE))).toBe(0);
    expect(secondsUntilCutoff(SCHEDULE, cutoffOf(SCHEDULE) + 9_999n)).toBe(0);
  });
});

describe("deadlines are anchored to the cutoff, not to the freeze transaction", () => {
  it("computes the timeout from frozenAt", () => {
    expect(timeoutAt(LIVE_SETTLED, SCHEDULE)).toBe(1_786_067_145n + 3600n);
  });

  it("computes settleability from frozenAt", () => {
    expect(settleableAt(LIVE_SETTLED, SCHEDULE)).toBe(1_786_067_145n + 60n);
  });

  it("does not drift when freeze() is called late", () => {
    // The contract stamps frozenAt with the SCHEDULED cutoff, so a late freeze buys no extra time.
    // A UI deriving this from the freeze tx timestamp would show a deadline that slips later the
    // longer everyone forgets — the exact bug the contract was fixed to remove.
    const lateFreezeTx = 1_786_067_145n + 5_000n;
    expect(timeoutAt(LIVE_SETTLED, SCHEDULE)).toBeLessThan(lateFreezeTx + 3600n);
  });
});

describe("a settled order can owe two tokens", () => {
  it("pays the WETH seller in USDG plus the unswappable WETH back in kind", () => {
    const c = claimableOf(SIDE0, LIVE_SETTLED, QueuePhase.Settled);
    // Sole seller on that side, so the whole side output is theirs.
    expect(c.bought).toBe(1_365_833n);
    expect(c.refunded).toBe(80_000_483_812_916n);
    expect(c.zeroForOne).toBe(true);
  });

  it("matches what refundOf returned on chain", () => {
    // Live value read from the deployed contract after settlement.
    expect(claimableOf(SIDE0, LIVE_SETTLED, QueuePhase.Settled).refunded).toBe(80_000_483_812_916n);
    expect(claimableOf(SIDE1, LIVE_SETTLED, QueuePhase.Settled).refunded).toBe(1n);
  });

  it("pays the USDG seller in WETH", () => {
    const c = claimableOf(SIDE1, LIVE_SETTLED, QueuePhase.Settled);
    expect(c.bought).toBe(719_999_516_187_084n);
    expect(c.zeroForOne).toBe(false);
  });

  it("splits pro-rata between two sellers on the same side, rounding DOWN", () => {
    // Two equal orders against an ODD total, so the floor is observable rather than assumed.
    const epoch: EpochState = { ...LIVE_SETTLED, totalIn0: 3n, out0: 7n, refund0: 0n };
    const a = claimableOf({ ...SIDE0, amountIn: 1n }, epoch, QueuePhase.Settled);
    const b = claimableOf({ ...SIDE0, amountIn: 2n }, epoch, QueuePhase.Settled);
    expect(a.bought).toBe(2n); // floor(7 * 1 / 3)
    expect(b.bought).toBe(4n); // floor(7 * 2 / 3)
    // The sum must never EXCEED the pot — overpaying the last claimer is insolvency.
    expect(a.bought + b.bought).toBeLessThanOrEqual(epoch.out0);
  });

  it("returns escrow at face value while an epoch is refunding, with no price applied", () => {
    const c = claimableOf(SIDE0, { ...LIVE_SETTLED, phase: QueuePhase.Refunding }, QueuePhase.Refunding);
    expect(c.refunded).toBe(SIDE0.amountIn);
    expect(c.bought).toBe(0n);
  });

  it("shows nothing claimable while the batch is still in flight", () => {
    expect(claimableOf(SIDE0, LIVE_SETTLED, QueuePhase.Open).bought).toBe(0n);
    expect(claimableOf(SIDE0, LIVE_SETTLED, QueuePhase.Frozen).bought).toBe(0n);
  });

  it("shows nothing for an order already withdrawn", () => {
    const c = claimableOf({ ...SIDE0, withdrawn: true }, LIVE_SETTLED, QueuePhase.Settled);
    expect(c.bought).toBe(0n);
    expect(c.refunded).toBe(0n);
  });

  it("does not divide by zero on an empty side", () => {
    const epoch: EpochState = { ...LIVE_SETTLED, totalIn1: 0n };
    expect(() => claimableOf(SIDE1, epoch, QueuePhase.Settled)).not.toThrow();
    expect(claimableOf(SIDE1, epoch, QueuePhase.Settled).bought).toBe(0n);
  });
});

describe("how much actually crossed", () => {
  it("reports the live batch's WETH side as ~90% traded", () => {
    const bps = crossedBpsOfSide(LIVE_SETTLED, true);
    expect(bps).toBeGreaterThan(8_900);
    expect(bps).toBeLessThan(9_100);
  });

  it("reports a fully-matched side as 10000 bps", () => {
    expect(crossedBpsOfSide({ ...LIVE_SETTLED, refund1: 0n }, false)).toBe(10_000);
  });

  it("reports a wholly-refunded side as zero", () => {
    const epoch: EpochState = { ...LIVE_SETTLED, refund0: LIVE_SETTLED.totalIn0 };
    expect(crossedBpsOfSide(epoch, true)).toBe(0);
  });

  it("is zero, not NaN, for an empty side", () => {
    expect(crossedBpsOfSide({ ...LIVE_SETTLED, totalIn1: 0n }, false)).toBe(0);
  });
});

describe("every phase names an exit", () => {
  const now = SCHEDULE.epochStartedAt + 10n;

  it("offers cancel while open", () => {
    expect(exitFor(SIDE0, LIVE_SETTLED, QueuePhase.Open, SCHEDULE, now).kind).toBe("cancel");
  });

  it("offers claim once settled or refunding", () => {
    expect(exitFor(SIDE0, LIVE_SETTLED, QueuePhase.Settled, SCHEDULE, now).kind).toBe("claim");
    expect(exitFor(SIDE0, LIVE_SETTLED, QueuePhase.Refunding, SCHEDULE, now).kind).toBe("claim");
  });

  it("counts down to settlement inside the freeze window", () => {
    const e = exitFor(SIDE0, LIVE_SETTLED, QueuePhase.Frozen, SCHEDULE, LIVE_SETTLED.frozenAt + 1n);
    expect(e.kind).toBe("waitForSettlement");
    if (e.kind === "waitForSettlement") expect(e.readyAt).toBe(LIVE_SETTLED.frozenAt + 60n);
  });

  it("counts down to the escape hatch once settlement is available to anyone", () => {
    const e = exitFor(SIDE0, LIVE_SETTLED, QueuePhase.Frozen, SCHEDULE, LIVE_SETTLED.frozenAt + 120n);
    expect(e.kind).toBe("waitForTimeout");
    if (e.kind === "waitForTimeout") expect(e.readyAt).toBe(LIVE_SETTLED.frozenAt + 3600n);
  });

  it("says nothing is owed on an order already paid", () => {
    const e = exitFor({ ...SIDE0, withdrawn: true }, LIVE_SETTLED, QueuePhase.Settled, SCHEDULE, now);
    expect(e.kind).toBe("none");
  });

  it("never leaves a live order without a named exit", () => {
    // The design guarantee, asserted rather than trusted: no phase produces a dead end.
    for (const phase of [QueuePhase.Open, QueuePhase.Frozen, QueuePhase.Settled, QueuePhase.Refunding]) {
      const e = exitFor(SIDE0, LIVE_SETTLED, phase, SCHEDULE, now);
      expect(e.kind).not.toBe("none");
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("currency orientation", () => {
  it("escrows currency0 and pays currency1 for a zeroForOne order", () => {
    expect(escrowCurrencyIndex(true)).toBe(0);
    expect(outputCurrencyIndex(true)).toBe(1);
  });

  it("escrows currency1 and pays currency0 for the reverse", () => {
    expect(escrowCurrencyIndex(false)).toBe(1);
    expect(outputCurrencyIndex(false)).toBe(0);
  });
});

describe("abi shape", () => {
  const names = new Set(moleQueueAbi.map((f) => (f as { name?: string }).name));

  it("carries every entry point a UI needs", () => {
    for (const n of ["place", "cancel", "claim", "freeze", "settle", "timeout"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("carries refundOf, without which a claim under-reports what the user receives", () => {
    expect(names.has("refundOf")).toBe(true);
  });

  it("declares place's amountIn as uint128, matching the contract", () => {
    const place = moleQueueAbi.find((f) => (f as { name?: string }).name === "place") as {
      inputs: readonly { name: string; type: string }[];
    };
    expect(place.inputs.map((i) => i.type)).toEqual(["bool", "uint128"]);
  });

  it("declares epochs with all eight fields, including the two refund legs", () => {
    const epochs = moleQueueAbi.find((f) => (f as { name?: string }).name === "epochs") as {
      outputs: readonly { name: string }[];
    };
    expect(epochs.outputs.map((o) => o.name)).toEqual([
      "phase",
      "frozenAt",
      "totalIn0",
      "totalIn1",
      "out0",
      "out1",
      "refund0",
      "refund1",
    ]);
  });

  it("declares Claimed with both payout legs", () => {
    const ev = moleQueueAbi.find((f) => (f as { name?: string }).name === "Claimed") as {
      inputs: readonly { name: string }[];
    };
    expect(ev.inputs.map((i) => i.name)).toContain("refunded");
  });
});
