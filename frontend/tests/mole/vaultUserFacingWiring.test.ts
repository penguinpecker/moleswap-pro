import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { encodeErrorResult, parseAbi } from "viem";
import { decodeSwapFailure } from "@/lib/aggregator/errors";

/**
 * THE GAP THESE TESTS EXIST TO CLOSE, and it is a gap between two pieces of correct code.
 *
 * Both halves of each feature below were built and both were right. Neither was reachable by a user,
 * because the wiring between them lived in a file the lane that built the other half was not allowed
 * to touch. That is not a hypothetical: it is how BOTH of these shipped un-wired on 2026-08-24, and a
 * whole-suite green run said nothing about it, because every test covered one half.
 *
 * So these tests assert REACHABILITY, not capability. They fail if the pieces stop being connected,
 * which is the only failure mode the per-half tests structurally cannot see.
 */

const root = path.join(process.cwd());
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

describe("a vault revert reaches the user as words, not as eight bytes of hex", () => {
  // The registries were added to errors.ts and wired into decodeSwapFailure — and then nothing in the
  // vault called the decoder, so every one of these still surfaced as a raw selector.
  const VAULT_ERRORS = parseAbi([
    "error PoolTooLarge()",
    "error SpotTooFarFromTwap()",
    "error MintedBelowMinimum()",
    "error RangeTooFarFromTwap()",
  ]);

  for (const name of ["PoolTooLarge", "SpotTooFarFromTwap", "MintedBelowMinimum", "RangeTooFarFromTwap"] as const) {
    it(`${name} decodes to something a depositor can act on`, () => {
      const data = encodeErrorResult({ abi: VAULT_ERRORS, errorName: name });
      const decoded = decodeSwapFailure({ shortMessage: "reverted", details: data, data });
      expect(decoded?.message, `${name} produced no message`).toBeTruthy();
      // The failure mode being guarded: the "message" is really just the selector echoed back.
      expect(decoded!.message).not.toMatch(/^0x[0-9a-f]{8}$/i);
      expect(decoded!.message.length).toBeGreaterThan(20);
    });
  }

  it("the vault module actually calls the decoder — the wiring, not the capability", () => {
    const src = read("lib/mole/vault.ts");
    expect(src).toMatch(/decodeSwapFailure/);
    expect(src).toMatch(/function vaultFailure/);
    // Every user-facing failure goes through the helper. A bare passthrough is the bug returning:
    // `err?.shortMessage` alone is the raw selector for a custom error.
    expect(src).not.toMatch(/error: err\?\.shortMessage \|\| err\?\.message/);
  });
});

describe("the exit the user actually gets is the one with a floor", () => {
  it("the vault screen calls almWithdrawWithFloor, not the unfloored almWithdraw", () => {
    const src = read("screens/vault/index.tsx");
    expect(src).toMatch(/almWithdrawWithFloor\(/);
    // The precise regression: the screen calling the unfloored exit as its FIRST choice. It may still
    // appear as the fallback below, so pin the order rather than the mere presence.
    const floored = src.indexOf("almWithdrawWithFloor(");
    const plain = src.indexOf("await almWithdraw(");
    expect(floored).toBeGreaterThan(-1);
    if (plain > -1) expect(floored).toBeLessThan(plain);
  });

  it("the unfloored exit REMAINS reachable as the fallback — trapping funds is the worse failure", () => {
    // Deliberate and load-bearing. A floor that is too high does not cost the owner slippage, it stops
    // them leaving at all. If a later change makes the floored exit the only path, an owner whose
    // position cannot meet its own floor has no way out, and that is a worse bug than the one the
    // floor fixes.
    const src = read("screens/vault/index.tsx");
    expect(src).toMatch(/floorNotMet/);
    expect(src).toMatch(/await almWithdraw\(/);
  });

  it("floorNotMet is set ONLY by the floor's own refusal, never by any other revert", () => {
    const src = read("lib/mole/vault.ts");
    const hits = src.match(/floorNotMet: true/g) ?? [];
    expect(hits.length, "floorNotMet is set in more than one place — it can no longer discriminate").toBe(1);
    // and it sits on the line that reports the floor's own message
    expect(src).toMatch(/floorNotMetMessage\(floor\), floorNotMet: true/);
  });
});
