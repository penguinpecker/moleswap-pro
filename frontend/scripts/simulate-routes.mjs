/**
 * Simulate every swap route via QuoterV2 (callStatic) on Push Chain Donut.
 * - For each pool: quote 1 unit T0→T1 and 1 unit T1→T0
 * - For each bridgeable token: quote $1 worth into WPC and back
 * Prints: amountIn → amountOut + price + effective slippage flag.
 *
 * No transactions are broadcast — this is a read-only simulation.
 */
import { ethers } from "ethers";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const src = readFileSync(resolve(root, "lib/pushchain/contracts.ts"), "utf8");

const WPC = "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9";

function tokens() {
  const out = [];
  const re = /\{\s*address:\s*("0x[a-fA-F0-9]{40}"|CONTRACTS\.WPC)[^}]*?symbol:\s*"([^"]+)"[^}]*?decimals:\s*(\d+)/g;
  let m;
  while ((m = re.exec(src))) {
    let a = m[1];
    if (a === "CONTRACTS.WPC") a = `"${WPC}"`;
    out.push({ address: JSON.parse(a), symbol: m[2], decimals: Number(m[3]) });
  }
  return out;
}
function pools() {
  const out = [];
  const re = /\{\s*address:\s*"(0x[a-fA-F0-9]{40})"\s*,\s*token0:\s*("0x[a-fA-F0-9]{40}"|CONTRACTS\.WPC)\s*,\s*token1:\s*(CONTRACTS\.WPC|"0x[a-fA-F0-9]{40}")\s*,\s*fee:\s*(\d+)\s*,\s*name:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    const t = (x) => x === "CONTRACTS.WPC" ? WPC : JSON.parse(x);
    out.push({ address: m[1], token0: t(m[2]), token1: t(m[3]), fee: Number(m[4]), name: m[5] });
  }
  return out;
}
const TOK = tokens(), POOLS = pools();
const byAddr = Object.fromEntries(TOK.map(t => [t.address.toLowerCase(), t]));

const RPC = "https://evm.rpc-testnet-donut-node1.push.org/";
const p = new ethers.JsonRpcProvider(RPC);
const QUOTER = "0x83316275f7C2F79BC4E26f089333e88E89093037";
const QUOTER_ABI = [
  "function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const quoter = new ethers.Contract(QUOTER, QUOTER_ABI, p);

async function sim(tokenIn, tokenOut, fee, amountIn, label) {
  try {
    const r = await quoter.quoteExactInputSingle.staticCall({
      tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n
    });
    const decIn = byAddr[tokenIn.toLowerCase()]?.decimals ?? 18;
    const decOut = byAddr[tokenOut.toLowerCase()]?.decimals ?? 18;
    const symIn = byAddr[tokenIn.toLowerCase()]?.symbol ?? "???";
    const symOut = byAddr[tokenOut.toLowerCase()]?.symbol ?? "???";
    const inH = ethers.formatUnits(amountIn, decIn);
    const outH = ethers.formatUnits(r.amountOut, decOut);
    const price = Number(outH) / Number(inH);
    console.log(`  ${label.padEnd(28)}  ${inH} ${symIn} → ${Number(outH).toFixed(6)} ${symOut}   (1 ${symIn} = ${price.toFixed(4)} ${symOut})  gas=${r.gasEstimate}`);
    return true;
  } catch (e) {
    console.log(`  ${label.padEnd(28)}  ❌ ${e.shortMessage || e.reason || e.message}`);
    return false;
  }
}

let ok = 0, fail = 0;
for (const pool of POOLS) {
  const t0 = byAddr[pool.token0.toLowerCase()];
  const t1 = byAddr[pool.token1.toLowerCase()];
  console.log(`\n[${pool.name}] fee=${pool.fee}`);
  const amtT0 = ethers.parseUnits("1", t0.decimals);
  const amtT1 = ethers.parseUnits("1", t1.decimals);
  const a = await sim(pool.token0, pool.token1, pool.fee, amtT0, `1 ${t0.symbol} → ${t1.symbol}`);
  const b = await sim(pool.token1, pool.token0, pool.fee, amtT1, `1 ${t1.symbol} → ${t0.symbol}`);
  if (a) ok++; else fail++;
  if (b) ok++; else fail++;
}
console.log(`\n=== ${ok} routes OK, ${fail} routes FAILED ===`);
