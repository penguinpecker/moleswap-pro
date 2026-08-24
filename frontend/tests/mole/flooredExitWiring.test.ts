/**
 * flooredExitWiring.test.ts — the floored exit driven THROUGH `lib/mole/vault`, not read out of it.
 *
 * WHY A SECOND FILE. `withdrawFloor.test.ts` proves the arithmetic: the minimums are the TWAP's, they
 * fail loose, and they are the exact joint bound the contract's own check accepts. What it cannot prove
 * is that any of those numbers reach a transaction — several of its wiring assertions are greps over
 * `vault.ts`, and a grep survives a client that computes a perfect floor and then sends `(0, 0)`. So this
 * file stubs the transport and calls `almWithdrawWithFloor` / `almWithdraw` for real, then reads the
 * arguments that arrived at `simulateContract`. The four things asserted here are the four that a source
 * grep gets wrong:
 *
 *   1. the minimums that reach the chain are the ones built at the TWAP, and a walked spot does not move
 *      them — the same manipulation the deposit path was rebuilt to survive, run against the exit;
 *   2. the Settings panel's live value is spent, at the moment of the exit, not a literal;
 *   3. a pool with no TWAP refuses the FLOORED exit and sends nothing, with a message that names the
 *      unfloored one — because "no way to leave" is the one impression this path must never leave; and
 *   4. `almWithdraw` still exits with every price read failing, which is what makes (3) survivable and
 *      what lets the floor above be strict.
 *
 * The fixtures are the live chain, read 2026-08-24: MoleHook `consult(1800)` = -200461 on Robinhood's
 * WETH/USDG pool, spot tick -200461, vault `maxTwapDeviationTicks` = 600, and MolePositions #3 —
 * liquidity 4976312705240 over [-201060, -200460], owner 0xe4563270…8C8. Those numbers were also run
 * against the deployed vault by `eth_call`: the floor this client builds for #3 at 50 bps (0, 5965653)
 * simulates clean, and one wei above what the burn actually pays reverts `0x0fdbcf37`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSqrtRatioAtTick } from "@/lib/aggregator/math/tickMath";
import { buildWithdrawFloor } from "@/lib/mole/withdrawPlan";
import { FALLBACK_TWAP_WINDOW_SECONDS, type PriceAnchor } from "@/lib/mole/priceAnchor";
import { DEFAULT_SWAP_SETTINGS, slippageBpsFor, writeSwapSettings } from "@/lib/settings/swapSettings";

/* ----------------------------------------------------------------------- the stubs */

const RH_CHAIN_ID = 4663;
const OWNER = "0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8" as const;
const POOL_ID = "0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029" as const;
const POSITION = { id: 3n, tickLower: -201_060, tickUpper: -200_460, liquidity: 4_976_312_705_240n };
const TWAP_TICK = -200_461;
const MAX_DEVIATION_TICKS = 600;
const TX_HASH = "0x" + "ab".repeat(32);

/** Every call the stubbed clients received, so a test can assert on what was SENT, not on what is written. */
interface Recorder {
  simulated: any[];
  written: any[];
}

const h = vi.hoisted(() => ({ pub: null as any, wallet: null as any }));

// Only the two client CONSTRUCTORS are replaced. Everything else in viem — the ABI encoder that turns a
// bad argument type into a selector that exists nowhere — stays real, because that is part of what this
// file is checking.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: () => h.pub, createWalletClient: () => h.wallet };
});

/** A chain that answers reads the way Robinhood did on 2026-08-24, with the failures a test asks for. */
function stubChain(opts: {
  spotTick?: number;
  /** `consult` reverts: a ring younger than the window, or a pool the hook never primed. */
  noTwap?: boolean;
  /** The spot read fails too — the state a floorless exit still has to survive. */
  noSpot?: boolean;
  /** What `simulateContract` throws instead of returning a request. */
  simulateThrows?: unknown;
}): Recorder {
  const rec: Recorder = { simulated: [], written: [] };
  const spotTick = opts.spotTick ?? TWAP_TICK;
  h.pub = {
    readContract: async ({ functionName }: any) => {
      switch (functionName) {
        case "getPosition":
          return {
            owner: OWNER,
            poolId: POOL_ID,
            tickLower: POSITION.tickLower,
            tickUpper: POSITION.tickUpper,
            liquidity: POSITION.liquidity,
            openedAtL1Block: 25_698_554n,
          };
        case "consult":
          if (opts.noTwap) throw new Error("execution reverted: InsufficientObservations()");
          return TWAP_TICK;
        case "getSlot0":
          if (opts.noSpot) throw new Error("execution reverted");
          return [getSqrtRatioAtTick(spotTick), spotTick, 0, 3000] as const;
        case "maxTwapDeviationTicks":
          return MAX_DEVIATION_TICKS;
        case "twapWindow":
          return FALLBACK_TWAP_WINDOW_SECONDS;
        default:
          throw new Error(`unexpected read: ${String(functionName)}`);
      }
    },
    simulateContract: async (args: any) => {
      rec.simulated.push(args);
      if (opts.simulateThrows) throw opts.simulateThrows;
      return { request: { ...args } };
    },
    waitForTransactionReceipt: async () => ({ status: "success" }),
  };
  h.wallet = {
    getAddresses: async () => [OWNER],
    writeContract: async (req: any) => {
      rec.written.push(req);
      return TX_HASH;
    },
  };
  return rec;
}

/** The wallet says it is on Robinhood, which is where these fixtures live. */
function connectWalletOn(chainId: number) {
  (window as any).ethereum = {
    request: async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
      throw new Error(`unexpected wallet call: ${method}`);
    },
  };
}

/** The anchor `readPriceAnchor` returns for these fixtures, rebuilt here so the expected floor is independent. */
function anchorAt(spotTick: number): PriceAnchor {
  const deviationTicks = Math.abs(spotTick - TWAP_TICK);
  return {
    deviationTicks,
    maxDeviationTicks: MAX_DEVIATION_TICKS,
    manipulated: deviationTicks > MAX_DEVIATION_TICKS,
    twapTick: TWAP_TICK,
    twapSqrtPriceX96: getSqrtRatioAtTick(TWAP_TICK),
    spotTick,
    spotSqrtPriceX96: getSqrtRatioAtTick(spotTick),
    twapWindowSeconds: FALLBACK_TWAP_WINDOW_SECONDS,
  };
}

const expectedFloor = (slippageBps: number, spotTick = TWAP_TICK) =>
  buildWithdrawFloor({
    anchor: anchorAt(spotTick),
    tickLower: POSITION.tickLower,
    tickUpper: POSITION.tickUpper,
    liquidityToRemove: POSITION.liquidity,
    slippageBps,
  });

/** The four `withdrawWithMinimums` arguments, in order, as they were handed to the simulation. */
function sentArgs(rec: Recorder) {
  expect(rec.simulated).toHaveLength(1);
  return { fn: rec.simulated[0].functionName as string, args: rec.simulated[0].args as any[] };
}

beforeEach(() => {
  connectWalletOn(RH_CHAIN_ID);
  writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "AUTO" });
  vi.resetModules();
});

/* ================================================ what actually reaches the contract */

describe("the minimums that reach the vault are the TWAP's, and spot cannot move them", () => {
  it("sends withdrawWithMinimums with the floor built at the time-averaged price", async () => {
    const rec = stubChain({});
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    const res = await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(TX_HASH);
    const { fn, args } = sentArgs(rec);
    expect(fn).toBe("withdrawWithMinimums");
    const floor = expectedFloor(slippageBpsFor("AUTO"));
    expect(args).toEqual([POSITION.id, floor.liquidityToRemove, floor.amount0Min, floor.amount1Min]);
    // and the position's live liquidity is what got burned, not a number the caller carried in
    expect(args[1]).toBe(POSITION.liquidity);
    expect(rec.written).toHaveLength(1);
  });

  it("ATTACK: a spot walked inside AND outside the vault's band produces byte-identical minimums", async () => {
    const sent: any[][] = [];
    for (const spotTick of [TWAP_TICK, TWAP_TICK - 500, TWAP_TICK + 500, TWAP_TICK - 5_000]) {
      const rec = stubChain({ spotTick });
      const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
      const res = await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);
      // The manipulated pool is NOT refused: refusing to build an exit is the client inventing the
      // censorship lever MolePositions.withdraw documents itself as refusing to be.
      expect(res.success).toBe(true);
      sent.push(sentArgs(rec).args);
      vi.resetModules();
    }
    for (const args of sent) expect(args).toEqual(sent[0]);
  });

  it("a floor priced at the walked spot would have been a different, lower number", async () => {
    // The defect this wiring avoids, made visible: had the client anchored on slot0, a pool walked down
    // 500 ticks would have shipped a smaller token1 minimum — one the manipulated burn clears.
    const honest = expectedFloor(slippageBpsFor("AUTO"));
    const spotAnchored = buildWithdrawFloor({
      anchor: { ...anchorAt(TWAP_TICK - 500), twapTick: TWAP_TICK - 500 },
      tickLower: POSITION.tickLower,
      tickUpper: POSITION.tickUpper,
      liquidityToRemove: POSITION.liquidity,
      slippageBps: slippageBpsFor("AUTO"),
    });
    expect(spotAnchored.amount1Min).toBeLessThan(honest.amount1Min);

    const rec = stubChain({ spotTick: TWAP_TICK - 500 });
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);
    expect(sentArgs(rec).args[3]).toBe(honest.amount1Min);
    expect(sentArgs(rec).args[3]).not.toBe(spotAnchored.amount1Min);
  });

  it("the Settings panel's value is spent at the moment of the exit, not a literal", async () => {
    writeSwapSettings({ ...DEFAULT_SWAP_SETTINGS, maxSlippage: "5" });
    const rec = stubChain({});
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);

    const wide = expectedFloor(slippageBpsFor("5"));
    expect(sentArgs(rec).args[3]).toBe(wide.amount1Min);
    // 5% tolerance is a LOWER floor than the 0.5% default — the setting can only ever loosen an exit.
    expect(wide.amount1Min).toBeLessThan(expectedFloor(slippageBpsFor("AUTO")).amount1Min);
  });

  it("a partial exit floors the slice the caller named", async () => {
    const half = POSITION.liquidity / 2n;
    const rec = stubChain({});
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    await almWithdrawWithFloor(POSITION.id, { liquidityToRemove: half }, RH_CHAIN_ID);
    const { args } = sentArgs(rec);
    expect(args[1]).toBe(half);
    expect(args[3]).toBeLessThan(expectedFloor(slippageBpsFor("AUTO")).amount1Min);
  });

  it("more liquidity than the position holds is refused before anything is simulated", async () => {
    const rec = stubChain({});
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    const res = await almWithdrawWithFloor(
      POSITION.id,
      { liquidityToRemove: POSITION.liquidity + 1n },
      RH_CHAIN_ID,
    );
    expect(res.success).toBe(false);
    expect(rec.simulated).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
  });
});

/* ============================================ refusals that must not read as a trap */

describe("every refusal on the floored path leaves the user owning the position, and says so", () => {
  it("no TWAP: the floored exit refuses, sends nothing, and NAMES the exit that carries no floor", async () => {
    const rec = stubChain({ noTwap: true });
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    const res = await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);

    expect(res.success).toBe(false);
    expect(rec.simulated).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
    expect(res.error).toMatch(/withdraw all/i);
    expect(res.error).toMatch(/[Nn]othing was submitted/);
    expect(res.error).toMatch(/untouched/);
    // and it never silently degrades to a floor of zero, which is the failure the user would believe
    expect(res.error).not.toMatch(/try again in a few minutes/i);
  });

  it("WithdrawBelowMinimum in simulation becomes the floor's message, and nothing is signed", async () => {
    const rec = stubChain({
      simulateThrows: Object.assign(new Error("execution reverted"), {
        shortMessage: "execution reverted",
        details: 'reverted with data "0x0fdbcf37"',
      }),
    });
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    const res = await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/floor was not met/);
    expect(res.error).toMatch(/withdraw all/i);
    expect(rec.written).toHaveLength(0);
  });

  it("NotOwner is NOT dressed up as a price problem — it is a different thing to go and fix", async () => {
    // 0x30cd7471, read off the live vault by calling the exit from an address that owns nothing.
    const rec = stubChain({
      simulateThrows: Object.assign(new Error("execution reverted"), {
        shortMessage: "execution reverted",
        details: 'reverted with data "0x30cd7471"',
      }),
    });
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    const res = await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);

    expect(res.success).toBe(false);
    expect(res.error).not.toMatch(/floor was not met/);
    expect(rec.written).toHaveLength(0);
  });

  it("a wallet on the wrong chain is refused, never switched", async () => {
    connectWalletOn(5042); // Arc, where this Robinhood position does not exist
    const rec = stubChain({});
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    const res = await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Switch networks/);
    expect(rec.simulated).toHaveLength(0);
  });
});

/* ================================================== the escape hatch, exercised */

describe("the unfloored exit stays reachable, including when the floored one cannot run", () => {
  it("almWithdraw sends withdrawAll(id) and reads no price at all", async () => {
    // Every price read on this chain fails — the exact state that refuses the floored exit above. The
    // one-call exit still has to work, or the strict path above would have no counterpart and this app
    // would be standing between an owner and their own position.
    const rec = stubChain({ noTwap: true, noSpot: true });
    const { almWithdraw } = await import("@/lib/mole/vault");
    const res = await almWithdraw(POSITION.id, RH_CHAIN_ID);

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(TX_HASH);
    const { fn, args } = sentArgs(rec);
    expect(fn).toBe("withdrawAll");
    expect(args).toEqual([POSITION.id]);
    expect(rec.written).toHaveLength(1);
  });

  it("MUTATION: the floored exit never quietly becomes the unfloored one", async () => {
    // A floor the client drops when it becomes inconvenient is not a floor. Both failing paths above end
    // with zero writes; this pins the one that succeeds to the floored function name.
    const rec = stubChain({});
    const { almWithdrawWithFloor } = await import("@/lib/mole/vault");
    await almWithdrawWithFloor(POSITION.id, {}, RH_CHAIN_ID);
    expect(sentArgs(rec).fn).toBe("withdrawWithMinimums");
    expect(rec.written[0].functionName).toBe("withdrawWithMinimums");
    expect(rec.written[0].args[2] + rec.written[0].args[3]).toBeGreaterThan(0n);
  });

  it("previewWithdrawFloor shows the same numbers the exit would send, sending nothing", async () => {
    const rec = stubChain({});
    const { previewWithdrawFloor } = await import("@/lib/mole/vault");
    const preview = await previewWithdrawFloor(POSITION.id, {}, RH_CHAIN_ID);

    const floor = expectedFloor(slippageBpsFor("AUTO"));
    expect(preview.amount0Min).toBe(floor.amount0Min);
    expect(preview.amount1Min).toBe(floor.amount1Min);
    expect(preview.expected1).toBe(floor.expected1);
    expect(rec.simulated).toHaveLength(0);
    expect(rec.written).toHaveLength(0);
  });
});
