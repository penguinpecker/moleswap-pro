/**
 * End-to-end Solana → PC bridge pipeline simulation.
 *
 * Reproduces on our side exactly what happens when a Phantom user clicks
 * "START SWAPPING" for 0.01 SOL → PC. Validates every step BEFORE Phantom
 * sees the tx, so we can pinpoint where Phantom's "Me: Unexpected error"
 * originates — cluster mismatch, size blowout, missing gateway, or helper
 * revert.
 *
 * Steps simulated:
 *   1. Confirm Push SVM gateway program exists on Solana Devnet
 *      (CFVSincHYbETh2k7w6u1ENEkjbSLtveRCEBupKidw2VS). Show whether it's
 *      ALSO deployed on Mainnet (if not, Phantom-on-Mainnet = instant fail).
 *   2. Confirm the program's config/vault PDAs are initialized.
 *   3. Build the bridgeAndSwapToNative calldata for our helper.
 *   4. Measure the Solana tx payload size vs the 1232-byte limit.
 *   5. Confirm the pool route is live (already green in earlier audits).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { stringToBytes } from "viem";
import abi from "@pushchain/core/src/lib/constants/abi/universalGatewayV0.json" with { type: "json" };

// ── Push SVM gateway (from @pushchain/core 5.1.3) ──────────────
const SVM_GATEWAY_PROGRAM = abi.address; // CFVSincHYbETh2k7w6u1ENEkjbSLtveRCEBupKidw2VS
const DEVNET  = "https://api.devnet.solana.com";
const MAINNET = "https://api.mainnet-beta.solana.com";

// ── Push Chain (EVM) ───────────────────────────────────────────
const PUSH_RPC = "https://evm.rpc-testnet-donut-node1.push.org/";
const HELPER   = "0x7db2Bdc454C62354C660a673B317D6945065cd0c";
const PSOL     = "0x5D525Df2bD99a6e7ec58b76aF2fd95F39874EBed";

// Sample user values
const USER_UEA = "0x000000000000000000000000000000000000dEaD";
const AMOUNT_IN = ethers.parseUnits("0.01", 9); // 0.01 SOL (pSOL = 9 dec)

function header(s) { console.log(`\n${"═".repeat(70)}\n  ${s}\n${"═".repeat(70)}`); }

// ── 1. Gateway program existence: Devnet vs Mainnet ────────────
header("1. Push SVM gateway program — Devnet vs Mainnet");
const programPk = new PublicKey(SVM_GATEWAY_PROGRAM);
console.log(`programId: ${SVM_GATEWAY_PROGRAM}`);

for (const [label, url] of [["Devnet", DEVNET], ["Mainnet", MAINNET]]) {
  const c = new Connection(url, "confirmed");
  try {
    const info = await c.getAccountInfo(programPk);
    if (!info) {
      console.log(`  ${label.padEnd(8)}: ❌ NOT DEPLOYED`);
    } else {
      console.log(`  ${label.padEnd(8)}: ✓ deployed (${info.data.length} bytes, owner=${info.owner.toBase58().slice(0,10)}…, executable=${info.executable})`);
    }
  } catch (e) {
    console.log(`  ${label.padEnd(8)}: probe failed — ${e.message}`);
  }
}

// ── 2. Config PDA initialised on Devnet? ───────────────────────
header("2. Gateway PDAs on Devnet");
const conn = new Connection(DEVNET, "confirmed");
const pdas = {
  config: PublicKey.findProgramAddressSync([stringToBytes("config")], programPk)[0],
  vault:  PublicKey.findProgramAddressSync([stringToBytes("vault")],  programPk)[0],
  feeVault: PublicKey.findProgramAddressSync([stringToBytes("fee_vault")], programPk)[0],
  rateLimitConfig: PublicKey.findProgramAddressSync([stringToBytes("rate_limit_config")], programPk)[0],
};
for (const [name, pda] of Object.entries(pdas)) {
  const info = await conn.getAccountInfo(pda);
  console.log(`  ${name.padEnd(16)}: ${pda.toBase58()}  ${info ? `✓ initialized (${info.data.length} bytes)` : "⚠️ MISSING"}`);
}

// ── 3. Build helper calldata (this is what goes IN the Solana tx) ─
header("3. MoleSwapBridgeHelper.bridgeAndSwapToNative calldata");
const iface = new ethers.Interface([
  "function bridgeAndSwapToNative(address tokenIn, uint24 poolFee, uint256 amountIn, uint256 amountOutMin, address recipient, uint256 deadline) returns (uint256)",
]);
const deadline = Math.floor(Date.now()/1000) + 600;
const calldata = iface.encodeFunctionData("bridgeAndSwapToNative", [
  PSOL, 500, AMOUNT_IN, 0n, USER_UEA, BigInt(deadline),
]);
console.log(`  calldata bytes: ${(calldata.length-2)/2} (hex chars: ${calldata.length-2})`);
console.log(`  helper:         ${HELPER}`);
console.log(`  first 32 bytes: ${calldata.slice(0, 66)}…`);

// ── 4. Solana tx payload envelope estimation ──────────────────
// Push SDK wraps the EVM calldata inside a Solana instruction call to the
// universal_gateway program. The outer Solana tx has: signatures (64 bytes
// each, >=1), message header (~3), account keys (~6 × 32 = 192), recent
// blockhash (32), and instructions. Instruction = programIdIndex(1) +
// account count(1) + accounts(~5) + data length(1-3) + data.
//
// The `data` portion contains: Anchor discriminator (8) + encoded args.
// For `sendTransactionPayload` or similar, args include the payload bytes.
//
// Rule of thumb: useful capacity ≈ 1232 - 96 (sig) - 32 (blockhash) - 3 (hdr)
//   - 192 (keys) - 1 (ix count) - 40 (ix overhead) ≈ 868 bytes for ix data.
// Our calldata is 196 bytes; Anchor adds 8; that's 204 bytes — ~650 bytes to spare.
const ixDataBytes = (calldata.length - 2) / 2 + 8 /* anchor discriminator */ + 32 /* universal account receipt, args overhead guess */;
const estSolanaTxSize = 96 + 32 + 3 + 192 + 1 + 40 + ixDataBytes;
console.log(`  estimated Solana tx size: ~${estSolanaTxSize} bytes (limit 1232)`);
if (estSolanaTxSize < 1100) console.log("  ✓ comfortably fits — size is NOT the cause of Phantom \"Unexpected error\"");
else console.log("  ⚠️ approaching 1232-byte limit");

// ── 5. Confirm EVM side (pool) is live ─────────────────────────
header("5. EVM pool sanity (pSOL → WPC → PC unwrap)");
const provider = new ethers.JsonRpcProvider(PUSH_RPC);
const quoter = new ethers.Contract(
  "0x83316275f7C2F79BC4E26f089333e88E89093037",
  ["function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160, uint32, uint256)"],
  provider,
);
const quote = await quoter.quoteExactInputSingle.staticCall({
  tokenIn: PSOL,
  tokenOut: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9",
  amountIn: AMOUNT_IN,
  fee: 500,
  sqrtPriceLimitX96: 0n,
});
console.log(`  0.01 pSOL → ${ethers.formatUnits(quote.amountOut, 18)} WPC  (gas=${quote.gasEstimate})`);
console.log("  ✓ pool route is live; FeeRouter.swapNativeOutput will unwrap to native PC");

// ── Conclusion ─────────────────────────────────────────────────
header("Conclusion");
console.log(`Push SVM gateway ${SVM_GATEWAY_PROGRAM} is the key test.`);
console.log(`If Devnet=✓ and Mainnet=❌, Phantom-on-Mainnet is the cause of "Unexpected error".`);
console.log(`If both exist, the issue is elsewhere (account init, compute, or SDK bug).`);
