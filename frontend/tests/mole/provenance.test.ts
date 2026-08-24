/**
 * provenance.test.ts — the mutability labels are a function of what the chain says, never a promise.
 *
 * Attacks first: a live upgrade key must never render the periphery as IMMUTABLE; an unread admin on
 * a proxy must fail closed to UPGRADEABLE; an unread implementation slot must be UNVERIFIED; a slot0
 * lpFee that disagrees with the hook's lpFeePips must show ✗; a nonzero hook fee must show ✗; unread
 * decimals must render "?" and never 18. Then the confirmations on a live-shaped fixture, and the
 * ERC-1967 slot pinned to its keccak derivation (a magic constant in a trust panel is the Cetus class).
 */
import { describe, it, expect } from "vitest";
import { keccak256, toHex } from "viem";
import {
  ERC1967_IMPLEMENTATION_SLOT,
  upgradeability,
  provenanceRows,
  addressesFor,
  type PoolProvenance,
} from "../../lib/mole/provenance";
import { hookBitmapProof } from "../../lib/mole/hookBitmap";
import { LIVE_POOL_KEY, LIVE_POOL_ID, MOLE_ADDRESSES } from "../../lib/mole/chain";
import { poolIdOf } from "../../lib/mole/poolId";

const ROOT = "0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8";
const ZERO = "0x0000000000000000000000000000000000000000";
const IMPL_HOOK = "0xE4192C72574e6E387D4C29Eb89feCeADa105F3e3";
const IMPL_VAULT = "0x13C9EA8E56897d9c6b3A58370e63c9b70276Ec17";
const IMPL_QUEUE = "0xF0d4a4a63A453197e99EDE1185A41054E524083c";
const IMPL_ROUTER = "0xEe714607B7aCD1B884189B40c4795a7F2d9B62e4";
const DIAL = "0x242263f3Ea6165a70B463d8b65F8DdFdd66762EA";

/** A fixture shaped like the live chain on 2026-08-22 (every proxy's admin = the root EOA). */
function live(overrides: Partial<PoolProvenance> = {}): PoolProvenance {
  const key = {
    currency0: LIVE_POOL_KEY.currency0,
    currency1: LIVE_POOL_KEY.currency1,
    fee: LIVE_POOL_KEY.fee,
    tickSpacing: LIVE_POOL_KEY.tickSpacing,
    hooks: LIVE_POOL_KEY.hooks,
  };
  return {
    poolKey: key,
    poolId: poolIdOf(key),
    bitmap: hookBitmapProof(key.hooks),
    served: true,
    slot0: { sqrtPriceX96: 3403123962154247711138459n, tick: -201118, protocolFee: 0, lpFee: 3000 },
    hook: { address: key.hooks, impl: IMPL_HOOK, upgradeAdmin: ROOT, lpFeePips: 3000, hookFeePips: 0, poolCreator: ROOT, restrictedLiquidity: false },
    vault: {
      address: MOLE_ADDRESSES.molePositions, impl: IMPL_VAULT, upgradeAdmin: ROOT, moleHook: key.hooks, whitelisted: true,
      minRangeWidth: 120, maxRangeWidth: 60000, minPositionLiquidity: 0n, maxPositionLiquidity: 0n, performanceFeeBps: 1000,
    },
    queue: { address: MOLE_ADDRESSES.moleQueue, impl: IMPL_QUEUE, upgradeAdmin: ROOT, boundToThisPool: true },
    router: { address: MOLE_ADDRESSES.moleRouter, impl: IMPL_ROUTER, upgradeAdmin: ROOT, feeDial: DIAL, feeBps: 69 },
    currencies: [
      { address: key.currency0, symbol: "WETH", decimals: 18 },
      { address: key.currency1, symbol: "USDG", decimals: 6 },
    ],
    readAt: 0,
    ...overrides,
  };
}

const row = (p: PoolProvenance, key: string) => {
  const r = provenanceRows(p).find((x) => x.key === key);
  if (!r) throw new Error(`no row ${key}`);
  return r;
};

const PERIPHERY_ROWS = ["hookCode", "vault", "vaultPin", "queue", "router", "lpFee", "hookFee", "perfFee"];
const KEY_ROWS = ["hook", "bitmap", "poolId", "currency0", "currency1", "tickSpacing", "feeMode"];
const TUNABLE_ROWS = ["rangeBand", "sizeBand", "aggFee"];

describe("ATTACK — the periphery is never called immutable while an upgrade key lives", () => {
  it("upgradeability(): proxy + live admin → UPGRADEABLE, never IMMUTABLE", () => {
    const u = upgradeability(IMPL_VAULT, ROOT);
    expect(u.label).toBe("UPGRADEABLE");
    expect(u.note).toMatch(/UUPS proxy/);
    expect(u.note).toContain("0xe456");
  });

  it("upgradeability(): proxy whose admin could not be read fails CLOSED to UPGRADEABLE", () => {
    expect(upgradeability(IMPL_VAULT, null).label).toBe("UPGRADEABLE");
  });

  it("upgradeability(): unread implementation slot is UNVERIFIED — not immutable, not upgradeable", () => {
    expect(upgradeability(null, ROOT).label).toBe("UNVERIFIED");
    expect(upgradeability(null, null).label).toBe("UNVERIFIED");
    expect(upgradeability(null, ZERO).label).toBe("UNVERIFIED");
  });

  it("upgradeability(): a zero implementation slot is a plain contract → IMMUTABLE 'not a proxy', whatever the admin read says", () => {
    for (const admin of [ROOT, null, ZERO]) {
      const u = upgradeability(ZERO, admin);
      expect(u.label, String(admin)).toBe("IMMUTABLE");
      expect(u.note, String(admin)).toBe("not a proxy");
    }
  });

  it("on the live-shaped fixture every periphery row is UPGRADEABLE and none is IMMUTABLE", () => {
    const p = live();
    for (const k of PERIPHERY_ROWS) {
      expect(row(p, k).mutability, k).toBe("UPGRADEABLE");
    }
  });

  it("the live lpFee row is never TUNABLE — nothing can move it in one transaction", () => {
    expect(row(live(), "lpFee").mutability).not.toBe("TUNABLE");
    expect(row(live(), "hookFee").mutability).not.toBe("TUNABLE");
  });

  it("a hook upgrade key that was burned flips the hook rows to IMMUTABLE — and ONLY the hook rows", () => {
    const p = live({ hook: { ...live().hook, upgradeAdmin: ZERO } });
    for (const k of ["hookCode", "lpFee", "hookFee"]) expect(row(p, k).mutability, k).toBe("IMMUTABLE");
    expect(row(p, "hookCode").note).toMatch(/burned/);
    for (const k of ["vault", "queue", "router", "perfFee"]) expect(row(p, k).mutability, k).toBe("UPGRADEABLE");
  });

  it("an unread hook implementation slot renders the hook rows UNVERIFIED", () => {
    const p = live({ hook: { ...live().hook, impl: null } });
    for (const k of ["hookCode", "lpFee", "hookFee"]) expect(row(p, k).mutability, k).toBe("UNVERIFIED");
    expect(row(p, "hookCode").value).toBe("?");
  });
});

describe("ATTACK — disagreements and unread values are shown, never smoothed over", () => {
  it("slot0 lpFee that differs from hook.lpFeePips shows ✗ and says DIFFERS", () => {
    const p = live({ slot0: { ...live().slot0!, lpFee: 2500 } });
    const r = row(p, "lpFee");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/DIFFERS/);
    expect(r.value).toBe("0.25%"); // the LIVE value is what is shown, not the hook's
  });

  it("slot0 lpFee HIGHER than hook.lpFeePips also shows ✗ — agreement is equality, not a one-sided bound", () => {
    const p = live({ slot0: { ...live().slot0!, lpFee: 3500 } });
    const r = row(p, "lpFee");
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/DIFFERS/);
    expect(r.note).not.toMatch(/re-asserted/);
    expect(r.value).toBe("0.35%");
  });

  it("a nonzero hook fee shows ✗ and names the delta", () => {
    const p = live({ hook: { ...live().hook, hookFeePips: 1000 } });
    const r = row(p, "hookFee");
    expect(r.ok).toBe(false);
    expect(r.value).toBe("0.10%");
    expect(r.note).toMatch(/delta/);
  });

  it("unread decimals render '?' — never assumed 18 (USDG is 6)", () => {
    const p = live({
      currencies: [
        { address: LIVE_POOL_KEY.currency0, symbol: "WETH", decimals: null },
        { address: LIVE_POOL_KEY.currency1, symbol: "USDG", decimals: null },
      ],
    });
    expect(row(p, "currency0").value).toBe("WETH · ? dec");
    expect(row(p, "currency1").value).toBe("USDG · ? dec");
    expect(row(p, "currency1").value).not.toMatch(/18/);
  });

  it("a pool the vault has NOT whitelisted shows ✗ on the vault row", () => {
    const p = live({ vault: { ...live().vault, whitelisted: false } });
    expect(row(p, "vault").ok).toBe(false);
    expect(row(p, "vault").note).toMatch(/NOT whitelisted/);
  });

  it("a vault pinned to a different hook than this pool's shows ✗", () => {
    const p = live({ vault: { ...live().vault, moleHook: "0x000000000000000000000000000000000000c0de" } });
    expect(row(p, "vaultPin").ok).toBe(false);
  });

  it("the vault hook pin compares ADDRESSES, not strings — lowercase pool hook (as mp_pools stores it) vs checksummed vault.moleHook (as viem returns it) is ✓", () => {
    // This is the PoolDetail shape on the live pool: the registry row carries the hook lowercase, the chain read
    // comes back checksummed. A string compare would render ✗ "differs from this pool's hook" on our own pool.
    const lc = LIVE_POOL_KEY.hooks.toLowerCase() as `0x${string}`;
    const checksummed = "0xb2c9A0af48dF8858F3765385E733Cd8776a138C4";
    expect(lc).not.toBe(checksummed); // the fixture really does differ in case
    const key = { ...live().poolKey, hooks: lc };
    const p = live({ poolKey: key, poolId: poolIdOf(key), bitmap: hookBitmapProof(lc), vault: { ...live().vault, moleHook: checksummed } });
    const r = row(p, "vaultPin");
    expect(r.ok).toBe(true);
    expect(r.note).toBe("equals this pool's hook");
    expect(row(p, "poolId").value.toLowerCase()).toBe(LIVE_POOL_ID.toLowerCase()); // case never changes the PoolId
    // and the other way round (checksummed pool hook, lowercase vault pin) is the same ✓
    const p2 = live({ vault: { ...live().vault, moleHook: lc } });
    expect(row(p2, "vaultPin").ok).toBe(true);
  });

  it("a queue bound to another pool says so", () => {
    const p = live({ queue: { ...live().queue!, boundToThisPool: false } });
    expect(row(p, "queue").ok).toBe(false);
    expect(row(p, "queue").note).toMatch(/another pool/);
  });

  it("resolves each chain's OWN contracts and never falls back across chains", () => {
    const rh = addressesFor(4663);
    const arc = addressesFor(5042);
    // vault and router exist on both chains and must DIFFER — one shared address here means a screen
    // is reading the other chain's deployment
    expect(rh.molePositions.toLowerCase()).not.toBe(arc.molePositions.toLowerCase());
    expect(rh.moleRouter.toLowerCase()).not.toBe(arc.moleRouter.toLowerCase());
    // Robinhood has a queue; Arc has none, and that must surface as undefined rather than as
    // Robinhood's address or a placeholder
    expect(rh.moleQueue).toBeTruthy();
    expect(arc.moleQueue).toBeUndefined();
  });

  it("a chain with no queue deployed says ABSENT rather than borrowing another chain's address", () => {
    // Arc has no batch queue. The row must survive, name no address, and never inherit Robinhood's.
    const p = live({ queue: null });
    const r = row(p, "queue");
    expect(r.mutability).toBe("ABSENT");
    expect(r.note).toMatch(/no batch queue deployed on this chain/);
    expect(r.value).toBe("—");
    expect(r.ok).toBeUndefined();
  });

  it("a hostile hook's bitmap row shows ✗ on the proof line", () => {
    const hostile = "0xdeadbeefdeadbeefdeadbeefdeadbeefdead3ac4"; // 0x38c4 | 0x0200
    const key = { ...live().poolKey, hooks: hostile as `0x${string}` };
    const p = live({ poolKey: key, bitmap: hookBitmapProof(hostile), served: false, poolId: poolIdOf(key) });
    const r = row(p, "bitmap");
    expect(r.ok).toBe(false);
    expect(r.note).toBe("uint160(hook) & 0x0301 == 0 ✗");
    expect(row(p, "hook").ok).toBeUndefined(); // not ours — no ✓ on the identity row
  });

  it("unread slot0 / vault bands / dial render '?' rather than a number", () => {
    const p = live({
      slot0: null,
      vault: { ...live().vault, minRangeWidth: null, maxRangeWidth: null, performanceFeeBps: null },
      router: { ...live().router, feeBps: null, feeDial: null },
    });
    expect(row(p, "lpFee").value).toBe("?");
    expect(row(p, "lpFee").ok).toBeUndefined();
    expect(row(p, "rangeBand").value).toBe("?");
    expect(row(p, "perfFee").value).toBe("?");
    expect(row(p, "aggFee").value).toBe("?");
    expect(row(p, "aggFee").note).toBe("dial unread");
  });
});

describe("CONFIRM — the live-shaped fixture", () => {
  it("the five PoolKey fields and the bitmap are IMMUTABLE by construction", () => {
    const p = live();
    for (const k of KEY_ROWS) expect(row(p, k).mutability, k).toBe("IMMUTABLE");
    expect(row(p, "poolId").value.toLowerCase()).toBe(LIVE_POOL_ID.toLowerCase());
    expect(row(p, "hook").value).toBe(LIVE_POOL_KEY.hooks);
    expect(row(p, "hook").ok).toBe(true);
    expect(row(p, "bitmap").value).toBe("0x38c4 · 11100011000100");
    expect(row(p, "bitmap").ok).toBe(true);
    expect(row(p, "bitmap").note).toBe("uint160(hook) & 0x0301 == 0 ✓");
    expect(row(p, "tickSpacing").value).toBe("60");
    expect(row(p, "feeMode").value).toBe("dynamic · 0x800000");
    expect(row(p, "currency0").value).toBe("WETH · 18 dec");
    expect(row(p, "currency1").value).toBe("USDG · 6 dec");
  });

  it("the setter-backed parameters are TUNABLE and name their setter / cap", () => {
    const p = live();
    for (const k of TUNABLE_ROWS) expect(row(p, k).mutability, k).toBe("TUNABLE");
    expect(row(p, "rangeBand").value).toBe("120–60000 ticks");
    expect(row(p, "rangeBand").note).toMatch(/setRangeWidthBand/);
    expect(row(p, "sizeBand").value).toBe("off – off");
    expect(row(p, "aggFee").value).toBe("69 bps");
    expect(row(p, "aggFee").note).toMatch(/cap 100 bps/);
  });

  it("live lpFee agrees with hook.lpFeePips and is marked re-asserted per swap; hook fee 0 is ✓", () => {
    const p = live();
    expect(row(p, "lpFee").value).toBe("0.30%");
    expect(row(p, "lpFee").ok).toBe(true);
    expect(row(p, "lpFee").note).toMatch(/re-asserted per swap/);
    expect(row(p, "hookFee").value).toBe("0.00%");
    expect(row(p, "hookFee").ok).toBe(true);
    expect(row(p, "perfFee").value).toBe("10%");
    expect(row(p, "queue").ok).toBe(true);
    expect(row(p, "vaultPin").ok).toBe(true);
  });

  it("every row carries one of the four labels and the set of keys is stable", () => {
    const rows = provenanceRows(live());
    const labels = new Set(["IMMUTABLE", "UPGRADEABLE", "TUNABLE", "UNVERIFIED"]);
    for (const r of rows) expect(labels.has(r.mutability), r.key).toBe(true);
    expect(rows.map((r) => r.key)).toEqual([...KEY_ROWS.slice(0, 2), "hookCode", ...KEY_ROWS.slice(2), "lpFee", "hookFee", "vault", "vaultPin", "rangeBand", "sizeBand", "perfFee", "queue", "router", "aggFee"]);
  });

  it("the ERC-1967 implementation slot is keccak256('eip1967.proxy.implementation') - 1", () => {
    const derived = toHex(BigInt(keccak256(toHex("eip1967.proxy.implementation"))) - 1n, { size: 32 });
    expect(ERC1967_IMPLEMENTATION_SLOT.toLowerCase()).toBe(derived.toLowerCase());
  });
});
