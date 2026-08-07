/**
 * Deploy MoleSwap FeeRouter + LiquidityProxy to PushChain Donut Testnet
 *
 * Usage:
 *   PRIVATE_KEY=0x... TREASURY=0x... node scripts/deploy.mjs
 *
 * Optional env:
 *   FEE_BPS=25          (default 25 = 0.25%)
 */
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const RPC = "https://evm.donut.rpc.push.org/";
const CHAIN_ID = 2442;

const SWAP_ROUTER = "0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037";
const WPC = "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9";
const POSITION_MANAGER = "0xf9b3ac66aed14A2C7D9AA7696841aB6B27a6231e";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TREASURY = process.env.TREASURY;
const FEE_BPS = parseInt(process.env.FEE_BPS || "25");

if (!PRIVATE_KEY) {
  console.error("Set PRIVATE_KEY env var");
  process.exit(1);
}
if (!TREASURY) {
  console.error("Set TREASURY env var (your fee collection wallet)");
  process.exit(1);
}

function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts", `${name}.json`);
  if (!fs.existsSync(p)) {
    console.error(`Artifact not found: ${p}\nRun: node scripts/compile.mjs`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function deploy(wallet, artifact, args, label) {
  console.log(`\nDeploying ${label}...`);
  console.log(`  Constructor args: ${JSON.stringify(args)}`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  console.log(`  Tx hash: ${tx.hash}`);
  console.log(`  Waiting for confirmation...`);
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  console.log(`  ${label} deployed at: ${addr}`);
  return addr;
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  MoleSwap Contract Deployment");
  console.log("  Chain: PushChain Donut Testnet (2442)");
  console.log("═══════════════════════════════════════════\n");

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: CHAIN_ID, name: "pushchain" }, { staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);

  console.log(`Deployer:  ${wallet.address}`);
  console.log(`Balance:   ${ethers.formatEther(balance)} PC`);
  console.log(`Treasury:  ${TREASURY}`);
  console.log(`Fee:       ${FEE_BPS} bps (${FEE_BPS / 100}%)`);

  if (balance === 0n) {
    console.error("\nNo PC balance. Get testnet tokens from https://faucet.push.org/");
    process.exit(1);
  }

  const feeRouterArtifact = loadArtifact("MoleSwapFeeRouter");
  const liquidityProxyArtifact = loadArtifact("MoleSwapLiquidityProxy");

  const feeRouterAddr = await deploy(
    wallet,
    feeRouterArtifact,
    [SWAP_ROUTER, WPC, TREASURY, FEE_BPS],
    "MoleSwapFeeRouter"
  );

  const liquidityProxyAddr = await deploy(
    wallet,
    liquidityProxyArtifact,
    [POSITION_MANAGER],
    "MoleSwapLiquidityProxy"
  );

  console.log("\n═══════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════");
  console.log(`  FeeRouter:       ${feeRouterAddr}`);
  console.log(`  LiquidityProxy:  ${liquidityProxyAddr}`);
  console.log(`  Owner:           ${wallet.address}`);
  console.log(`  Treasury:        ${TREASURY}`);
  console.log(`  Fee:             ${FEE_BPS} bps`);
  console.log("═══════════════════════════════════════════\n");

  console.log("Add these to lib/pushchain/contracts.ts:");
  console.log(`  MOLESWAP_FEE_ROUTER: "${feeRouterAddr}",`);
  console.log(`  MOLESWAP_LIQUIDITY_PROXY: "${liquidityProxyAddr}",`);

  console.log("\nIMPORTANT: For decrease/collect/burn liquidity operations,");
  console.log("users must call setApprovalForAll(LiquidityProxy, true)");
  console.log("on the PositionManager once. The frontend should prompt this.\n");

  const result = {
    chainId: CHAIN_ID,
    deployer: wallet.address,
    treasury: TREASURY,
    feeBps: FEE_BPS,
    contracts: {
      MoleSwapFeeRouter: feeRouterAddr,
      MoleSwapLiquidityProxy: liquidityProxyAddr,
    },
    upstream: {
      SwapRouter: SWAP_ROUTER,
      PositionManager: POSITION_MANAGER,
      WPC: WPC,
    },
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(__dirname, "..", "deployment.json"),
    JSON.stringify(result, null, 2)
  );
  console.log("Saved deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
