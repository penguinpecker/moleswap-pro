/**
 * Cross-check every pool on-chain:
 *   - token0/token1/fee match the registry
 *   - decimals from registry match decimals() on-chain
 *   - slot0 sqrtPriceX96 → implied price (token1-per-token0)
 *   - pool balances (ERC20.balanceOf) for both tokens
 *   - cross-check reserve-implied price vs sqrtPrice-implied price
 *   - flag pools where liquidity=0, sqrtPriceX96=0, or balances are ~0
 *
 * Usage:  node scripts/audit-pools.mjs
 */
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// hand-parse contracts.ts so we don't need a TS build — just grep the literals
const contractsSrc = readFileSync(resolve(root, "lib/pushchain/contracts.ts"), "utf8");

function extractTokens() {
  const out = [];
  const re = /\{\s*address:\s*("0x[a-fA-F0-9]{40}"|CONTRACTS\.WPC)[^}]*?symbol:\s*"([^"]+)"[^}]*?decimals:\s*(\d+)/g;
  let m;
  while ((m = re.exec(contractsSrc))) {
    let addr = m[1];
    if (addr === "CONTRACTS.WPC") addr = '"0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9"';
    out.push({ address: JSON.parse(addr), symbol: m[2], decimals: Number(m[3]) });
  }
  return out;
}

function extractPools() {
  const out = [];
  const re = /\{\s*address:\s*"(0x[a-fA-F0-9]{40})"\s*,\s*token0:\s*("0x[a-fA-F0-9]{40}"|CONTRACTS\.WPC)\s*,\s*token1:\s*(CONTRACTS\.WPC|"0x[a-fA-F0-9]{40}")\s*,\s*fee:\s*(\d+)\s*,\s*name:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(contractsSrc))) {
    const toAddr = (s) => s === "CONTRACTS.WPC" ? "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9" : JSON.parse(s);
    out.push({ address: m[1], token0: toAddr(m[2]), token1: toAddr(m[3]), fee: Number(m[4]), name: m[5] });
  }
  return out;
}

const TOKENS = extractTokens();
const POOLS = extractPools();
const tokByAddr = Object.fromEntries(TOKENS.map(t => [t.address.toLowerCase(), t]));

const RPC = "https://evm.rpc-testnet-donut-node1.push.org/";
const p = new ethers.JsonRpcProvider(RPC);

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

console.log(`Found ${TOKENS.length} tokens, ${POOLS.length} pools`);
console.log("—".repeat(80));

// Step 1: verify every token contract's decimals+symbol match registry
console.log("\n=== TOKEN AUDIT ===");
for (const t of TOKENS) {
  if (t.address === "0x0000000000000000000000000000000000000000") {
    console.log(`[${t.symbol}] native — skipping on-chain check`);
    continue;
  }
  try {
    const c = new ethers.Contract(t.address, ERC20, p);
    const [dec, sym] = await Promise.all([c.decimals(), c.symbol()]);
    const ok = Number(dec) === t.decimals;
    console.log(`[${t.symbol.padEnd(10)}] ${t.address}  dec(chain)=${dec} dec(reg)=${t.decimals} symbol(chain)=${sym}  ${ok ? "OK" : "⚠️ DECIMALS MISMATCH"}`);
  } catch (e) {
    console.log(`[${t.symbol}] ERROR: ${e.shortMessage || e.message}`);
  }
}

console.log("\n=== POOL AUDIT ===");
const issues = [];
for (const pool of POOLS) {
  const c = new ethers.Contract(pool.address, POOL_ABI, p);
  try {
    const [t0, t1, fee, slot0, liq] = await Promise.all([
      c.token0(), c.token1(), c.fee(), c.slot0(), c.liquidity()
    ]);
    const sqrt = BigInt(slot0[0]);
    const tick = Number(slot0[1]);

    const registryT0 = tokByAddr[pool.token0.toLowerCase()];
    const registryT1 = tokByAddr[pool.token1.toLowerCase()];

    // on-chain vs registry token-order check
    const t0Match = t0.toLowerCase() === pool.token0.toLowerCase();
    const t1Match = t1.toLowerCase() === pool.token1.toLowerCase();
    const feeMatch = Number(fee) === pool.fee;

    // ERC20 balances at pool
    const t0C = new ethers.Contract(t0, ERC20, p);
    const t1C = new ethers.Contract(t1, ERC20, p);
    const [b0, b1, d0Chain, d1Chain] = await Promise.all([
      t0C.balanceOf(pool.address), t1C.balanceOf(pool.address),
      t0C.decimals(), t1C.decimals()
    ]);

    // Price derived from sqrtPriceX96
    let priceT1PerT0 = 0;
    if (sqrt > 0n) {
      const sqr = sqrt * sqrt;
      const raw = Number(sqr * 10n**18n / (2n**192n)) / 1e18;
      priceT1PerT0 = raw * Math.pow(10, Number(d0Chain) - Number(d1Chain));
    }

    // Price derived from reserves (only meaningful for V2-style; for V3 we just show for sanity)
    const b0F = Number(ethers.formatUnits(b0, Number(d0Chain)));
    const b1F = Number(ethers.formatUnits(b1, Number(d1Chain)));
    const ratioReservesT1PerT0 = b0F > 0 ? b1F / b0F : 0;

    const liqZero = liq === 0n;
    const sqrtZero = sqrt === 0n;
    const balZero  = b0 === 0n || b1 === 0n;

    console.log(`\n[${pool.name}] ${pool.address}`);
    console.log(`  token0: ${t0}  ${t0Match ? "✓" : "⚠️ REGISTRY MISMATCH"}`);
    console.log(`  token1: ${t1}  ${t1Match ? "✓" : "⚠️ REGISTRY MISMATCH"}`);
    console.log(`  fee: ${fee}  ${feeMatch ? "✓" : "⚠️ FEE MISMATCH"}  tick:${tick}  liquidity:${liq}`);
    console.log(`  sqrtPriceX96: ${sqrt}`);
    console.log(`  price (sqrt)   1 ${registryT0?.symbol ?? "T0"} = ${priceT1PerT0.toFixed(6)} ${registryT1?.symbol ?? "T1"}`);
    console.log(`  reserves: t0=${b0F} ${registryT0?.symbol ?? ""}   t1=${b1F} ${registryT1?.symbol ?? ""}`);
    console.log(`  reserves ratio 1 ${registryT0?.symbol ?? "T0"} ≈ ${ratioReservesT1PerT0.toFixed(6)} ${registryT1?.symbol ?? "T1"}`);

    const pct = (a,b) => a>0 && b>0 ? Math.abs(a-b)/Math.max(a,b) : 1;
    const skew = pct(priceT1PerT0, ratioReservesT1PerT0);
    if (skew > 0.5 && !sqrtZero && !balZero) {
      console.log(`  ⚠️ sqrt-price vs reserves skewed by ${(skew*100).toFixed(0)}% — possible concentrated-range pool or stale price`);
    }

    if (!t0Match) issues.push(`${pool.name}: registry token0 differs from on-chain`);
    if (!t1Match) issues.push(`${pool.name}: registry token1 differs from on-chain`);
    if (!feeMatch) issues.push(`${pool.name}: registry fee differs from on-chain`);
    if (sqrtZero) issues.push(`${pool.name}: pool not initialized (sqrtPriceX96=0)`);
    if (liqZero) issues.push(`${pool.name}: pool has zero active liquidity`);
    if (balZero) issues.push(`${pool.name}: one or both token reserves are zero`);
  } catch (e) {
    console.log(`[${pool.name}] ERROR: ${e.shortMessage || e.message}`);
    issues.push(`${pool.name}: RPC error — ${e.shortMessage || e.message}`);
  }
}

console.log("\n=== ISSUES SUMMARY ===");
if (issues.length === 0) console.log("No critical issues found.");
else for (const i of issues) console.log(" • " + i);
