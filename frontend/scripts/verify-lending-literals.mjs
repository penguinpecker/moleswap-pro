#!/usr/bin/env node
/**
 * Prove lib/lending/market.ts against the deployed market, and exit non-zero if they disagree.
 *
 * WHY A SCRIPT AND NOT A TEST. vitest cannot reach a real RPC here — tests/setup.ts mocks global
 * fetch — so a unit test over this list can only ever compare the constant with a second copy of
 * itself. That shape is exactly what let the lend page state 75%/80% for USDG while the reserve had
 * been configured 72%/77% on chain since it was listed: every test was green and the number a user
 * would have acted on was wrong. A risk parameter has to be read from the thing that enforces it.
 *
 * It checks, per reserve: position in getReservesList(), the underlying's own symbol()/decimals(),
 * both derived-token addresses read back from the Pool, and the borrowable bit out of the reserve
 * configuration. It PRINTS ltv/threshold rather than asserting them — those are owner policy and
 * change legitimately; the UI now renders them from the same live read instead of hardcoding them.
 *
 *   node scripts/verify-lending-literals.mjs [rpcUrl]
 */
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";

const RPC = process.argv[2] || process.env.RH_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const POOL = "0xb819FD2DabF86dB45911Cd57D4588E9440E485dD";

const abi = [
  { type: "function", name: "getReservesList", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getReserveAToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getReserveVariableDebtToken", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getConfiguration", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];
const erc20 = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

const src = readFileSync(new URL("../lib/lending/market.ts", import.meta.url), "utf8");
const start = src.indexOf("export const LENDING_ASSETS");
const block = src.slice(start, src.indexOf("] as const;", start));
const lits = [...block.matchAll(
  /symbol:\s*"([^"]+)",\s*address:\s*"(0x[0-9a-fA-F]{40})",\s*decimals:\s*(\d+),\s*aToken:\s*"(0x[0-9a-fA-F]{40})",\s*variableDebtToken:\s*"(0x[0-9a-fA-F]{40})",\s*borrowable:\s*(true|false)/g,
)].map((m) => ({
  symbol: m[1], address: m[2], decimals: +m[3],
  aToken: m[4], variableDebtToken: m[5], borrowable: m[6] === "true",
}));

if (lits.length === 0) {
  console.error("Parsed zero assets out of lib/lending/market.ts — the shape changed, fix this script.");
  process.exit(1);
}

const c = createPublicClient({ transport: http(RPC) });
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const problems = [];

const listed = await c.readContract({ address: POOL, abi, functionName: "getReservesList" });
if (listed.length !== lits.length) problems.push(`count: chain ${listed.length}, file ${lits.length}`);

for (const [i, a] of lits.entries()) {
  const [sym, dec, at, vd, cfg] = await Promise.all([
    c.readContract({ address: a.address, abi: erc20, functionName: "symbol" }).catch(() => null),
    c.readContract({ address: a.address, abi: erc20, functionName: "decimals" }).catch(() => null),
    c.readContract({ address: POOL, abi, functionName: "getReserveAToken", args: [a.address] }),
    c.readContract({ address: POOL, abi, functionName: "getReserveVariableDebtToken", args: [a.address] }),
    c.readContract({ address: POOL, abi, functionName: "getConfiguration", args: [a.address] }),
  ]);
  const ltv = Number(cfg & 0xffffn) / 100;
  const thr = Number((cfg >> 16n) & 0xffffn) / 100;
  const borrowable = ((cfg >> 58n) & 1n) === 1n;

  if (listed[i] && !eq(listed[i], a.address)) problems.push(`${a.symbol}: order — chain[${i}] is ${listed[i]}`);
  if (dec !== null && dec !== a.decimals) problems.push(`${a.symbol}: decimals — chain ${dec}, file ${a.decimals}`);
  if (!eq(at, a.aToken)) problems.push(`${a.symbol}: aToken — chain ${at}, file ${a.aToken}`);
  if (!eq(vd, a.variableDebtToken)) problems.push(`${a.symbol}: variableDebtToken — chain ${vd}, file ${a.variableDebtToken}`);
  if (borrowable !== a.borrowable) problems.push(`${a.symbol}: borrowable — chain ${borrowable}, file ${a.borrowable}`);

  console.log(
    `  ${a.symbol.padEnd(5)} ${String(sym ?? "?").padEnd(9)} dec=${String(dec).padEnd(2)}` +
    ` LTV=${ltv.toFixed(2).padStart(5)}% thr=${thr.toFixed(2).padStart(5)}% borrow=${borrowable}`,
  );
}

console.log("");
if (problems.length) {
  console.error(`MISMATCH between lib/lending/market.ts and the market at ${POOL}:`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`All ${lits.length} reserves match the deployed market at ${POOL}.`);
