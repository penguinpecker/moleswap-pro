import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * A PROVIDER URL PUBLISHED TO USERS IS A PUBLISHED API KEY.
 *
 * lib/rpc/upstreams.ts has said so since Arc launched, and Arc was built correctly because of it.
 * Robinhood was not: its endpoint reached the browser as `NEXT_PUBLIC_RH_RPC_URL`, and NEXT_PUBLIC_
 * means "inline this into the client bundle at build time". On 2026-08-24 a keyed Alchemy URL was
 * readable in three of the shipped JavaScript chunks on the live site — not leaked by a mistake in
 * the code, but published exactly as configured.
 *
 * Nothing in the suite could see it, because the value lived in a deployment environment variable
 * rather than in the repository. So this test does not look for a key. It looks for the SHAPE that
 * makes publishing one possible, which is the part that lives in the tree and the part a reviewer can
 * actually be asked to check.
 */

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

/** Hosts that only ever answer for a key. A URL naming one is a credential, whatever it is called. */
const KEYED_PROVIDERS = [
  "alchemy.com",
  "infura.io",
  "quiknode.pro",
  "quicknode.pro",
  "ankr.com/premium",
  "blastapi.io",
  "chainstack.com",
  "getblock.io",
];

describe("no keyed provider URL can reach the browser", () => {
  it("no NEXT_PUBLIC_ variable in .env.example names a keyed provider", () => {
    // .env.example is the shape every deployment gets copied from, so a keyed provider sitting behind
    // a NEXT_PUBLIC_ name here is an instruction to publish a credential.
    const src = read(".env.example");
    for (const line of src.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("NEXT_PUBLIC_")) continue;
      for (const host of KEYED_PROVIDERS) {
        expect(
          t.toLowerCase(),
          `${t.split("=")[0]} names ${host} — anything NEXT_PUBLIC_ is inlined into the client bundle`,
        ).not.toContain(host);
      }
    }
  });

  it("the RH upstream resolver is server-only, exactly like Arc's", () => {
    const src = read("lib/rpc/upstreams.ts");
    expect(src).toMatch(/export function rhUpstreams/);
    // The env var it reads must NOT be public. This is the whole property.
    expect(src).toMatch(/process\.env\.RH_RPC_UPSTREAMS/);
    expect(src).not.toMatch(/NEXT_PUBLIC_RH_RPC_UPSTREAMS/);
    expect(src).not.toMatch(/process\.env\.NEXT_PUBLIC_[A-Z_]*UPSTREAM/);
  });

  it("Arc's proxy exists, and any chain proxy added later must not reuse Arc's constants", () => {
    expect(fs.existsSync(path.join(root, "app/rpc/v1/arc/route.ts"))).toBe(true);

    // A Robinhood proxy was written on 2026-08-24 by copying the Arc route, and it was WRONG in a way
    // worth pinning against. lib/rpc/policy.ts and lib/rpc/proxy.ts answer eth_chainId from
    // ARC_CHAIN_ID_HEX as a last resort — a deliberate Arc-specific optimisation, since a chain id is
    // a constant of the protocol rather than state. Reused unchanged for Robinhood, the endpoint
    // forwarded eth_blockNumber to Robinhood (44,758,712, real RH data) while answering eth_chainId
    // with 0x13b2, Arc's id. Reads worked, so it looked healthy; a wallet would have been told it was
    // on a chain it was not reading. That is worse than an outright failure.
    //
    // The route was removed rather than patched: the shared proxy has to be parameterised by chain
    // first, and a half-built proxy that reports the wrong chain id is worse than no proxy.
    for (const dir of fs.readdirSync(path.join(root, "app/rpc/v1"), { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === "arc") continue;
      const route = path.join(root, "app/rpc/v1", dir.name, "route.ts");
      if (!fs.existsSync(route)) continue;
      const body = fs.readFileSync(route, "utf8");
      expect(body, `${dir.name} reuses Arc's chain constants — it will report Arc's chain id`).not.toMatch(/ARC_CHAIN_ID/);
    }
  });

  it("no keyed provider URL is hardcoded anywhere the client can import", () => {
    // A literal in shipped source is worse than a published env var: rotating it needs a deploy.
    const dirs = ["lib", "screens", "components", "app"];
    const offenders: string[] = [];
    const walk = (d: string) => {
      const abs = path.join(root, d);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const body = read(rel).toLowerCase();
          for (const host of KEYED_PROVIDERS) {
            // A bare mention in a comment is fine; a URL with a path after the host is a credential.
            const re = new RegExp(`https?://[a-z0-9.-]*${host.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/[a-z0-9]`, "i");
            if (re.test(body)) offenders.push(`${rel} -> ${host}`);
          }
        }
      }
    };
    dirs.forEach(walk);
    expect(offenders, `keyed provider URLs hardcoded in client-reachable source:\n${offenders.join("\n")}`).toEqual([]);
  });
});
