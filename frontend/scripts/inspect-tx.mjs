/**
 * Inspect a Push Chain tx: decodes Transfer/Withdrawal/Deposit logs on WPC
 * and pSOL, and shows the native-PC balance delta of the recipient — so we
 * can tell whether the user ultimately received native PC (unwrapped) or
 * WPC (stuck as a wrapped token).
 *
 * Usage: node scripts/inspect-tx.mjs <txHash>
 */
import { ethers } from "ethers";

const RPC  = "https://evm.rpc-testnet-donut-node1.push.org/";
const WPC  = "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9";
const PSOL = "0x5D525Df2bD99a6e7ec58b76aF2fd95F39874EBed";
const FEE_ROUTER = "0x2845d303d9C367bF9ad555b0de81945E02861adD";
const SWAP_ROUTER = "0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037";
const HELPER = "0x7db2Bdc454C62354C660a673B317D6945065cd0c";

const TX = process.argv[2] ?? "0x29148600c7a224305e2f66d61944d07ce16a567fa37705cf2402fc2d531241ff";

const p = new ethers.JsonRpcProvider(RPC);
const [tx, r] = await Promise.all([p.getTransaction(TX), p.getTransactionReceipt(TX)]);
if (!tx || !r) { console.log("tx not found"); process.exit(1); }

console.log("tx.hash  :", TX);
console.log("tx.from  :", tx.from);
console.log("tx.to    :", tx.to);
console.log("tx.value :", ethers.formatEther(tx.value), "PC (native value sent)");
console.log("status   :", r.status === 1 ? "success" : "FAILED");
console.log("logs     :", r.logs.length);

const label = (addr) => {
  const a = addr.toLowerCase();
  if (a === WPC.toLowerCase())          return "WPC";
  if (a === PSOL.toLowerCase())         return "pSOL";
  if (a === FEE_ROUTER.toLowerCase())   return "FeeRouter";
  if (a === SWAP_ROUTER.toLowerCase())  return "SwapRouter";
  if (a === HELPER.toLowerCase())       return "BridgeHelper";
  return addr;
};

// Event signatures we care about
const TRANSFER          = ethers.id("Transfer(address,address,uint256)");
const WITHDRAW          = ethers.id("Withdrawal(address,uint256)");
const DEPOSIT           = ethers.id("Deposit(address,uint256)");
// Uniswap V3 position-manager events — emitted on add/remove liquidity + fee collect
const INCREASE_LIQ      = ethers.id("IncreaseLiquidity(uint256,uint128,uint256,uint256)");
const DECREASE_LIQ      = ethers.id("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
const COLLECT           = ethers.id("Collect(uint256,address,uint256,uint256)");
// Pool-level burn (fires when decreaseLiquidity calls burn on the pool)
const POOL_BURN         = ethers.id("Burn(address,int24,int24,uint128,uint256,uint256)");

const safeBig = (hex) => (!hex || hex === "0x" || hex === "0x0" ? 0n : BigInt(hex));

console.log("\n=== decoded logs ===");
for (const log of r.logs) {
  const topic = log.topics[0];
  const token = log.address;
  if (topic === TRANSFER) {
    // ERC-20 Transfer has 2 indexed topics + amount in data.
    // ERC-721 Transfer (NFT) has 3 indexed topics (from,to,tokenId) and empty data.
    const isNft = log.topics.length === 4;
    const from = "0x" + log.topics[1].slice(-40);
    const to   = "0x" + log.topics[2].slice(-40);
    if (isNft) {
      const tokenId = BigInt(log.topics[3]);
      console.log(`Transfer721 [${label(token).slice(0,12).padEnd(12)}]  ${label(from).slice(0,20).padEnd(20)} → ${label(to).slice(0,20).padEnd(20)}  tokenId=${tokenId}`);
    } else {
      const amt  = safeBig(log.data);
      const dec  = label(token) === "pSOL" ? 9 : 18;
      console.log(`Transfer    [${label(token).slice(0,12).padEnd(12)}]  ${label(from).slice(0,20).padEnd(20)} → ${label(to).slice(0,20).padEnd(20)}  ${ethers.formatUnits(amt, dec)}`);
    }
  } else if (topic === WITHDRAW) {
    const who = "0x" + log.topics[1].slice(-40);
    const amt = safeBig(log.data);
    console.log(`Withdrawal  [${label(token).slice(0,12).padEnd(12)}]  ${label(who).slice(0,20).padEnd(20)}  ${ethers.formatUnits(amt, 18)}  (WPC → native PC unwrap)`);
  } else if (topic === DEPOSIT) {
    const who = "0x" + log.topics[1].slice(-40);
    const amt = safeBig(log.data);
    console.log(`Deposit     [${label(token).slice(0,12).padEnd(12)}]  ${label(who).slice(0,20).padEnd(20)}  ${ethers.formatUnits(amt, 18)}  (native PC → WPC wrap)`);
  } else if (topic === DECREASE_LIQ) {
    // topics: [sig, tokenId]; data: (liquidity, amount0, amount1)
    const tokenId = BigInt(log.topics[1]);
    const [liq, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(["uint128","uint256","uint256"], log.data);
    console.log(`DecreaseLiq [${label(token).slice(0,12).padEnd(12)}]  tokenId=${tokenId}  liquidity=${liq}  amount0=${a0}  amount1=${a1}`);
  } else if (topic === INCREASE_LIQ) {
    const tokenId = BigInt(log.topics[1]);
    const [liq, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(["uint128","uint256","uint256"], log.data);
    console.log(`IncreaseLiq [${label(token).slice(0,12).padEnd(12)}]  tokenId=${tokenId}  liquidity=${liq}  amount0=${a0}  amount1=${a1}`);
  } else if (topic === COLLECT) {
    // topics: [sig, tokenId]; data: (recipient, amount0, amount1)
    const tokenId = BigInt(log.topics[1]);
    const [recipient, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(["address","uint256","uint256"], log.data);
    console.log(`Collect     [${label(token).slice(0,12).padEnd(12)}]  tokenId=${tokenId}  recipient=${label(recipient).slice(0,20)}  amount0=${a0}  amount1=${a1}`);
  } else if (topic === POOL_BURN) {
    // topics: [sig, owner, tickLower, tickUpper]; data: (amount, amount0, amount1)
    const owner = "0x" + log.topics[1].slice(-40);
    const tickLower = Number(BigInt.asIntN(24, BigInt(log.topics[2])));
    const tickUpper = Number(BigInt.asIntN(24, BigInt(log.topics[3])));
    const [amount, a0, a1] = ethers.AbiCoder.defaultAbiCoder().decode(["uint128","uint256","uint256"], log.data);
    console.log(`Pool.Burn   [${label(token).slice(0,12).padEnd(12)}]  owner=${label(owner).slice(0,20)}  ticks=[${tickLower},${tickUpper}]  liquidity=${amount}  amount0=${a0}  amount1=${a1}`);
  } else {
    console.log(`(unknown)   [${label(token).slice(0,12).padEnd(12)}]  topic0=${topic.slice(0,10)}…  topics=${log.topics.length}  dataBytes=${(log.data.length - 2) / 2}`);
  }
}

// Native-PC balance delta of the sender (usually the end-recipient of a swap-to-PC).
const beforeBal = await p.getBalance(tx.from, r.blockNumber - 1);
const afterBal  = await p.getBalance(tx.from, r.blockNumber);
const delta     = afterBal - beforeBal;
console.log(`\n=== native PC balance delta for ${tx.from} ===`);
console.log(`before block ${r.blockNumber-1}: ${ethers.formatEther(beforeBal)}`);
console.log(`after  block ${r.blockNumber}:   ${ethers.formatEther(afterBal)}`);
console.log(`delta:                       ${delta >= 0n ? "+" : ""}${ethers.formatEther(delta)}`);

// Final WPC balance of sender (to confirm none stuck).
const wpc = new ethers.Contract(WPC, ["function balanceOf(address) view returns (uint256)"], p);
const wpcBalAfter = await wpc.balanceOf(tx.from);
console.log(`\nWPC balance of ${tx.from} after tx: ${ethers.formatEther(wpcBalAfter)}`);
