"use client";
/**
 * vault.ts — client for the MoleSwap ALM vault (MolePositions proxy on Robinhood Chain 4663).
 *
 * This wires the on-chain primitives that were built and tested in this repo:
 *   - positionsOf / getPosition  → read a wallet's ALM positions (exact, view-only)
 *   - withdrawAll(id)            → exit a position (the verified-safe one-arg exit; reads liquidity
 *                                   inside the call, so no stale-read race — see records.txt:545/1211)
 *   - zapOpen(z, deadline)       → single-token deposit into a bounded range around spot
 *
 * IMPORTANT: the vault REJECTS full-range positions — it enforces minRangeWidth/maxRangeWidth (live:
 * 120 / 60000 ticks), so a deposit must sit in a bounded range. And the ZapParams slippage bound is
 * `amountOutMin` on the swap leg (records.txt:1354 — `minLiquidity` alone is NOT protection on a
 * one-sided zap). Every write is also `simulateContract`-checked against the vault before it is sent.
 *
 * WHERE THE DEPOSIT'S NUMBERS COME FROM, and why it is not slot0 any more. `zapOpen` has no price gate
 * of its own — `_validateRange` checks width and spacing, nothing else — so `amountOutMin` and
 * `minLiquidity` ARE the deposit's entire protection, and both are supplied by this file. They used to
 * be computed from `slot0`: the expected output of the swap at the pool's instantaneous price, less
 * slippage, with `minLiquidity` hard-coded to 1. That bound was anchored to the one number an attacker
 * can move for free, and then enforced against a swap executing at that same number — it compared the
 * bad price against itself and passed. Skew the pool, hold it a block, and any user who loads this page
 * inside the window signs a bound the manipulation clears by construction; on Arc the deepest pool on
 * the chain is ~$74k, so holding the skew is cheap. Both numbers now come from the MoleHook TWAP via
 * lib/mole/priceAnchor + lib/mole/zapPlan, and a pool whose spot has walked past the vault's OWN
 * `maxTwapDeviationTicks` is refused outright rather than quietly deposited into.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { molePositionsAbi, erc20Abi } from "./abi";
import {
  MOLE_ADDRESSES,
  LIVE_POOL_KEY,
  LIVE_POOL_ID,
  WETH,
  USDG,
  ROBINHOOD_RPC_URL,
} from "./chain";
import { STATE_VIEW, assertAnchorUsable, readPriceAnchor, stateViewAbi, viemAnchorReads } from "./priceAnchor";
import { DEFAULT_SLIPPAGE_BPS, RANGE_HALF_WIDTH, buildZapPlan } from "./zapPlan";

const VAULT = MOLE_ADDRESSES.molePositions;
const TICK_SPACING = 60;
// Theoretical v3 full-range bounds. A position is flagged "full range" only if it spans essentially the
// whole tick space; the vault's maxRangeWidth (60000) means real positions never do, so this is normally
// false — but it MUST be defined: referencing it undefined threw inside getAlmPositions' per-position
// try/catch and silently emptied every wallet's position list.
const FULL_LOWER = -887272;
const FULL_UPPER = 887272;
// The vault refuses full-range; positions must sit in [minRangeWidth, maxRangeWidth] (live 120/60000).
// RANGE_HALF_WIDTH / DEFAULT_SLIPPAGE_BPS live in ./zapPlan with the arithmetic that uses them, and
// STATE_VIEW / stateViewAbi in ./priceAnchor with the rule about what spot may and may not be used for.
const RH_HEX = "0x1237";

export const VAULT_TOKENS = [WETH, USDG] as const;

export function almPublicClient() {
  return createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
}

export interface VaultBalances {
  weth: bigint;
  usdg: bigint;
  native: bigint;
}

/**
 * Read a wallet's WETH, USDG and native-ETH balances in one shot. The deposit card needs all three:
 * WETH/USDG are the only assets the vault can pull (the pool's two currencies), and native ETH is shown
 * so a user who has *only* gas understands why a deposit would fail before they try it.
 */
export async function getVaultBalances(owner: string): Promise<VaultBalances> {
  const pub = almPublicClient();
  const readBal = (t: Address) =>
    pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] }) as Promise<bigint>;
  const [weth, usdg, native] = await Promise.all([
    readBal(WETH.address as Address),
    readBal(USDG.address as Address),
    pub.getBalance({ address: owner as Address }),
  ]);
  return { weth, usdg, native };
}

function browserEth(): any {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum ?? null;
}

async function ensureChain(eth: any) {
  try {
    const cid = await eth.request({ method: "eth_chainId" });
    if (parseInt(cid, 16) !== robinhoodChain.id) {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: RH_HEX }] });
    }
  } catch {
    /* wallet will surface the error */
  }
}

export interface AlmPosition {
  id: string;
  owner: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  openedAtL1Block: bigint;
  fullRange: boolean;
}

/** Read every ALM position a wallet owns (positions with liquidity > 0). */
export async function getAlmPositions(owner: string): Promise<AlmPosition[]> {
  const pub = almPublicClient();
  const ids = (await pub.readContract({
    address: VAULT as Address,
    abi: molePositionsAbi,
    functionName: "positionsOf",
    args: [owner as Address],
  })) as bigint[];

  const out: AlmPosition[] = [];
  for (const id of ids) {
    try {
      const p = (await pub.readContract({
        address: VAULT as Address,
        abi: molePositionsAbi,
        functionName: "getPosition",
        args: [id],
      })) as any;
      const liquidity = BigInt(p.liquidity ?? 0n);
      if (liquidity === 0n) continue;
      out.push({
        id: id.toString(),
        owner: p.owner,
        poolId: p.poolId,
        tickLower: Number(p.tickLower),
        tickUpper: Number(p.tickUpper),
        liquidity,
        openedAtL1Block: BigInt(p.openedAtL1Block ?? 0n),
        fullRange: Number(p.tickLower) <= FULL_LOWER && Number(p.tickUpper) >= FULL_UPPER,
      });
    } catch {
      /* skip a position that fails to read */
    }
  }
  return out;
}

function poolKeyArg() {
  return {
    currency0: LIVE_POOL_KEY.currency0 as Address,
    currency1: LIVE_POOL_KEY.currency1 as Address,
    fee: LIVE_POOL_KEY.fee,
    tickSpacing: LIVE_POOL_KEY.tickSpacing,
    hooks: LIVE_POOL_KEY.hooks as Address,
  };
}

/**
 * Build the zapOpen argument for a single-token deposit of `amountIn` of `token`.
 *
 * Reads the TWAP (the anchor), spot (only to judge it), and the vault's own deviation band, then hands
 * all three to the pure builder in ./zapPlan. THROWS on a pool whose spot has walked outside that band:
 * see the header — a bound is not the answer when the price the swap executes at is the price we
 * distrust, and the caller turns the throw into a message rather than a transaction.
 */
export async function buildZap(
  pub: ReturnType<typeof almPublicClient>,
  token: Address,
  amountIn: bigint,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
) {
  const isToken0 = token.toLowerCase() === (WETH.address as string).toLowerCase(); // WETH=currency0, USDG=currency1
  const anchor = await readPriceAnchor(viemAnchorReads(pub, LIVE_POOL_ID));
  const plan = buildZapPlan({
    anchor,
    zeroForOne: isToken0,
    amountIn,
    tickSpacing: TICK_SPACING,
    slippageBps,
    rangeHalfWidthTicks: RANGE_HALF_WIDTH,
  });

  return {
    key: poolKeyArg(),
    tickLower: plan.tickLower,
    tickUpper: plan.tickUpper,
    zeroForOne: plan.zeroForOne,
    amountIn: plan.amountIn,
    swapAmount: plan.swapAmount,
    minLiquidity: plan.minLiquidity,
    amountOutMin: plan.amountOutMin,
  };
}

/**
 * Live pool state for the strategy chart: current tick + sqrtPrice, read from the v4 StateView.
 *
 * DISPLAY ONLY, and that is the whole reason this read is still allowed to be spot. A chart is meant to
 * show where the market IS, including when someone has just walked it. Nothing derived from this number
 * may become a transaction bound — the bounds come from `buildZap`, which anchors on the TWAP.
 */
export async function getPoolState(): Promise<{ tick: number; sqrtPriceX96: bigint } | null> {
  try {
    const pub = almPublicClient();
    const slot0 = (await pub.readContract({
      address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [LIVE_POOL_ID as `0x${string}`],
    })) as readonly [bigint, number, number, number];
    return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]) };
  } catch {
    return null;
  }
}

export interface DepositResult { success: boolean; txHash?: string; error?: string; positionId?: string }

const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

function deadline(): bigint {
  // 20 minutes from a server-supplied-ish clock. Date.now is fine in the browser.
  return BigInt(Math.floor(Date.now() / 1000) + 1200);
}

/**
 * Deposit NATIVE ETH: wrap it to WETH first (WETH.deposit is a proxy predeploy, verified live), then run
 * the normal single-sided zap. The pool's WETH leg IS wrapped ETH, and there is no ETH/WETH pool because
 * ETH↔WETH is a 1:1 wrap, not a trade — so this is the correct path for a user who holds only ETH.
 * (The vault mints the position to msg.sender and has no `openFor`, so the wrap can't be folded into the
 * same transaction as the zap — it's wrap → deposit, sequenced automatically.)
 */
export async function almDepositNative(amountIn: bigint, onStep?: (s: string) => void): Promise<DepositResult> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = almPublicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };

    // THE REFUSAL COMES BEFORE THE IRREVERSIBLE STEP. Wrapping is a one-way trip for a user who only
    // holds ETH, so a pool that is going to be refused must be refused here — not after they are left
    // holding WETH they never asked for. Same read the deposit itself will do a moment later.
    await readPriceAnchor(viemAnchorReads(pub, LIVE_POOL_ID)).then((a) => assertAnchorUsable(a));

    onStep?.("Wrapping ETH → WETH…");
    const wrapHash = await wallet.writeContract({
      address: WETH.address as Address, abi: wethAbi, functionName: "deposit", value: amountIn, account, chain: robinhoodChain,
    });
    const wr = await pub.waitForTransactionReceipt({ hash: wrapHash });
    if (wr.status !== "success") return { success: false, txHash: wrapHash, error: "Wrap reverted" };

    onStep?.("Depositing WETH…");
    return await almDeposit(WETH.address as Address, amountIn);
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Deposit failed" };
  }
}

/**
 * Deposit `amountIn` (wei) of `token` (WETH or USDG) into the ALM as a full-range position.
 * Simulates against the live vault first; only sends if the simulation succeeds.
 */
export async function almDeposit(token: Address, amountIn: bigint): Promise<DepositResult> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = almPublicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };

    // 1) the bounds, FIRST. buildZap reads the TWAP, judges spot against the vault's own band and
    //    throws on a pool that looks manipulated. Doing it before the approval means a refused deposit
    //    leaves nothing behind — no standing allowance granted for a transaction we then declined to
    //    build. The range and both bounds are anchored to the TWAP; see the file header.
    const z = await buildZap(pub, token, amountIn);

    // 2) allowance → vault
    const allowance = (await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, VAULT as Address],
    })) as bigint;
    if (allowance < amountIn) {
      const ah = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [VAULT as Address, amountIn],
        account,
        chain: robinhoodChain,
      });
      await pub.waitForTransactionReceipt({ hash: ah });
    }

    // 3) simulate zapOpen against the live vault, then send
    const sim = await pub.simulateContract({
      address: VAULT as Address,
      abi: molePositionsAbi,
      functionName: "zapOpen",
      args: [z as any, deadline()],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash, positionId: sim.result?.toString() };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Deposit failed" };
  }
}

/** Exit a position fully via the verified-safe withdrawAll(id). */
export async function almWithdraw(id: string | bigint): Promise<DepositResult> {
  try {
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    await ensureChain(eth);
    const wallet = createWalletClient({ chain: robinhoodChain, transport: custom(eth) });
    const pub = almPublicClient();
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const sim = await pub.simulateContract({
      address: VAULT as Address,
      abi: molePositionsAbi,
      functionName: "withdrawAll",
      args: [BigInt(id)],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: robinhoodChain });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash };
  } catch (err: any) {
    return { success: false, error: err?.shortMessage || err?.message?.split("\n")[0] || "Withdraw failed" };
  }
}
