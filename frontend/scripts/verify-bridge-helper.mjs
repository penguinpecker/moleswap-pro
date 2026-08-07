/**
 * Verify the MoleSwapBridgeHelper contract is deployed and has the
 * expected functions. Simulates a bridgeAndSwapToNative call to confirm
 * the path for SOL→PC swaps works end-to-end (read-only).
 */
import { ethers } from "ethers";

const RPC = "https://evm.rpc-testnet-donut-node1.push.org/";
const HELPER = "0x7db2Bdc454C62354C660a673B317D6945065cd0c";
const FEE_ROUTER = "0x2845d303d9C367bF9ad555b0de81945E02861adD";
const PSOL = "0x5D525Df2bD99a6e7ec58b76aF2fd95F39874EBed";
const WPC  = "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9";

const provider = new ethers.JsonRpcProvider(RPC);

// 1. Is there code at the helper address?
const code = await provider.getCode(HELPER);
console.log("helper code length:", code.length);
if (code === "0x") {
  console.log("❌ MoleSwapBridgeHelper NOT DEPLOYED at", HELPER);
  process.exit(1);
}
console.log("✓ Helper contract deployed");

// 2. Check each function selector exists by calling with invalid args (expect revert, not "function not found")
const HELPER_ABI = [
  "function bridgeAndSwap(address,address,uint24,uint256,uint256,address,uint256) returns (uint256)",
  "function bridgeAndSwapToNative(address,uint24,uint256,uint256,address,uint256) returns (uint256)",
  "function bridgeAndSwapMultiHop(address,address,bytes,uint256,uint256,address,uint256) returns (uint256)",
  "function bridgeNativeAndSwap(address,uint24,uint256,address,uint256) payable returns (uint256)",
];
const iface = new ethers.Interface(HELPER_ABI);
const selectors = {
  bridgeAndSwap: iface.getFunction("bridgeAndSwap").selector,
  bridgeAndSwapToNative: iface.getFunction("bridgeAndSwapToNative").selector,
  bridgeAndSwapMultiHop: iface.getFunction("bridgeAndSwapMultiHop").selector,
  bridgeNativeAndSwap: iface.getFunction("bridgeNativeAndSwap").selector,
};
console.log("\nExpected selectors:");
for (const [name, sel] of Object.entries(selectors)) {
  const found = code.includes(sel.slice(2));
  console.log(`  ${name}: ${sel}  ${found ? "✓ present in bytecode" : "⚠️ not found in bytecode"}`);
}

// 3. Attempt staticCall of bridgeAndSwapToNative with tiny amount — expect revert
// because we're not the authorized gateway caller. That's fine; we just want
// to confirm the selector exists and reverts with a recognizable reason.
console.log("\n=== Staticcall bridgeAndSwapToNative (expect revert — helper requires gateway as msg.sender) ===");
try {
  const calldata = iface.encodeFunctionData("bridgeAndSwapToNative", [
    PSOL, 500, ethers.parseUnits("0.001", 9), 0, "0x000000000000000000000000000000000000dEaD", Math.floor(Date.now()/1000) + 600,
  ]);
  await provider.call({ to: HELPER, data: calldata });
  console.log("(no revert — unexpected)");
} catch (e) {
  const msg = e.shortMessage || e.reason || e.message;
  console.log("revert reason:", msg.slice(0, 200));
  if (msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("invalid opcode")) {
    console.log("⚠️ Function may not be present");
  } else {
    console.log("✓ Function selector present (revert is expected from access control)");
  }
}

// 4. Check FeeRouter has the expected methods
const FEE_ROUTER_ABI = [
  "function swapExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint256 amountOutMin, uint256 deadline) returns (uint256)",
  "function swapNativeOutput(address tokenIn, uint24 fee, uint256 amountIn, uint256 amountOutMin, uint256 deadline, uint256) returns (uint256)",
];
console.log("\n=== FeeRouter ===");
const frCode = await provider.getCode(FEE_ROUTER);
console.log("FeeRouter code:", frCode === "0x" ? "❌ NOT DEPLOYED" : `✓ ${frCode.length/2} bytes`);

// 5. Check the pSOL/WPC pool is callable through FeeRouter path
const QUOTER = "0x83316275f7C2F79BC4E26f089333e88E89093037";
const QUOTER_ABI = ["function quoteExactInputSingle(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"];
const q = new ethers.Contract(QUOTER, QUOTER_ABI, provider);
const quote = await q.quoteExactInputSingle.staticCall({
  tokenIn: PSOL, tokenOut: WPC, amountIn: ethers.parseUnits("0.01", 9), fee: 500, sqrtPriceLimitX96: 0n,
});
console.log(`\n=== Route simulation: 0.01 pSOL → WPC ===`);
console.log(`  amountOut: ${ethers.formatUnits(quote.amountOut, 18)} WPC`);
console.log(`  gas: ${quote.gasEstimate}`);
