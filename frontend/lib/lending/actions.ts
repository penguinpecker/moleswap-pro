/**
 * actions.ts — the write side of the rh-lending market.
 *
 * Every action follows the same shape as `lib/mole/vault.ts`, deliberately, so there is one
 * pattern in this codebase rather than two:
 *
 *   1. get the wallet the user CONNECTED (wagmi's connector; the injected provider only as a fallback), or refuse
 *   2. ASK THE WALLET WHAT CHAIN IT IS ON and refuse on a mismatch — never force a switch
 *   3. SIMULATE, so a revert is surfaced as words before anything is signed
 *   4. send
 *
 * Step 2 matters most here. A supply built for Robinhood and signed against whatever chain the
 * wallet happens to be on is how funds reach a pool that is not this one. Refusing and naming the
 * chain is answerable with a button; guessing is not.
 *
 * Step 3 matters because Aave's reverts are NAMED errors. `BorrowingHalted`, `MustNotLeaveDust`,
 * `HealthFactorNotBelowThreshold` and `SelfLiquidation` all mean something specific, and a
 * simulation turns them into a sentence instead of a failed transaction the user paid for.
 */
import { createPublicClient, http, type Address } from "viem";
import { RH_CHAIN } from "@/lib/chain/chains";
import { connectedWallet } from "@/lib/wallet/connectedWallet";
import {
  LENDING,
  poolAbi,
  gatewayAbi,
  erc20Abi,
  lendingAvailableOn,
  type LendingAsset,
} from "./market";

export interface ActionResult {
  success: boolean;
  hash?: `0x${string}`;
  error?: string;
}

function pub() {
  const rpc =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_RH_RPC_URL) || RH_CHAIN.rpcUrl;
  return createPublicClient({ chain: RH_CHAIN as any, transport: http(rpc) });
}

/** Refuse rather than switch: the user chose their network, and a silent switch is a surprise. */
function wrongChain(actual: number | undefined): string | null {
  if (actual === undefined) {
    return "Could not read your wallet's network. Nothing was submitted — reconnect and try again.";
  }
  if (actual === RH_CHAIN.id) return null;
  return `Your wallet is on chain ${actual}, but this market lives on ${RH_CHAIN.name}. Switch networks and try again — nothing was submitted.`;
}

/** Aave errors are named; surface the name, not a stack trace. */
function readable(e: any): string {
  const s: string = e?.shortMessage || e?.message || String(e);
  if (/BorrowingHalted/i.test(s))
    return "Borrowing is paused right now: the market's liveness gate is not allowing new debt. Supplying, withdrawing and repaying still work.";
  if (/HealthFactorLowerThanLiquidationThreshold|CollateralCannotCoverNewBorrow/i.test(s))
    return "That borrow would put your position below the liquidation threshold. Borrow less or add collateral.";
  if (/NotEnoughAvailableUserBalance/i.test(s))
    return "You do not have that much supplied to withdraw.";
  if (/SupplyCapExceeded/i.test(s)) return "That would exceed this reserve's supply cap.";
  if (/BorrowCapExceeded/i.test(s)) return "That would exceed this reserve's borrow cap.";
  if (/ReserveFrozen|ReservePaused/i.test(s)) return "This reserve is currently paused or frozen.";
  if (/User rejected|denied/i.test(s)) return "You rejected the transaction in your wallet.";
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

type Ctx = { wallet: any; account: Address };

async function connect(): Promise<Ctx | ActionResult> {
  if (!lendingAvailableOn(RH_CHAIN.id)) return { success: false, error: "Lending is not available." };
  const cw = await connectedWallet(RH_CHAIN as any);
  if (!cw) return { success: false, error: "No wallet found." };
  const bad = wrongChain(cw.chainId);
  if (bad) return { success: false, error: bad };
  return { wallet: cw.wallet, account: cw.account };
}

const isErr = (x: Ctx | ActionResult): x is ActionResult => "success" in x;

/** Approve only when the current allowance is short — an unnecessary approval is a wasted signature. */
async function ensureAllowance(
  ctx: Ctx,
  token: Address,
  spender: Address,
  amount: bigint,
): Promise<void> {
  const current = (await pub().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [ctx.account, spender],
  })) as bigint;
  if (current >= amount) return;
  const hash = await ctx.wallet.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, amount],
    account: ctx.account,
    chain: RH_CHAIN as any,
  });
  await pub().waitForTransactionReceipt({ hash });
}

async function send(ctx: Ctx, req: any): Promise<ActionResult> {
  const hash = await ctx.wallet.writeContract({ ...req, account: ctx.account, chain: RH_CHAIN as any });
  await pub().waitForTransactionReceipt({ hash });
  return { success: true, hash };
}

/**
 * Supply. NATIVE ETH goes through WrappedTokenGateway, which wraps internally — the user never
 * holds or approves WETH. Verified on mainnet: the supplier's WETH balance is identical either
 * side of a deposit.
 */
export async function supply(asset: LendingAsset, amount: bigint): Promise<ActionResult> {
  const ctx = await connect();
  if (isErr(ctx)) return ctx;
  try {
    if (asset.isWrappedNative) {
      const sim = await pub().simulateContract({
        address: LENDING.wrappedTokenGateway,
        abi: gatewayAbi,
        functionName: "depositETH",
        args: [LENDING.pool, ctx.account, 0],
        value: amount,
        account: ctx.account,
      });
      return await send(ctx, sim.request);
    }
    await ensureAllowance(ctx, asset.address, LENDING.pool, amount);
    const sim = await pub().simulateContract({
      address: LENDING.pool,
      abi: poolAbi,
      functionName: "supply",
      args: [asset.address, amount, ctx.account, 0],
      account: ctx.account,
    });
    return await send(ctx, sim.request);
  } catch (e) {
    return { success: false, error: readable(e) };
  }
}

/** Withdraw. For native ETH the gateway must be allowed to burn the user's aTokens first. */
export async function withdraw(asset: LendingAsset, amount: bigint): Promise<ActionResult> {
  const ctx = await connect();
  if (isErr(ctx)) return ctx;
  try {
    if (asset.isWrappedNative) {
      await ensureAllowance(ctx, asset.aToken, LENDING.wrappedTokenGateway, amount);
      const sim = await pub().simulateContract({
        address: LENDING.wrappedTokenGateway,
        abi: gatewayAbi,
        functionName: "withdrawETH",
        args: [LENDING.pool, amount, ctx.account],
        account: ctx.account,
      });
      return await send(ctx, sim.request);
    }
    const sim = await pub().simulateContract({
      address: LENDING.pool,
      abi: poolAbi,
      functionName: "withdraw",
      args: [asset.address, amount, ctx.account],
      account: ctx.account,
    });
    return await send(ctx, sim.request);
  } catch (e) {
    return { success: false, error: readable(e) };
  }
}

/**
 * Borrow. Interest rate mode 2 = variable; v3.7 has no stable rate.
 * The simulation is what turns the debt token's `BorrowingHalted` veto into a sentence rather
 * than a reverted transaction.
 */
export async function borrow(asset: LendingAsset, amount: bigint): Promise<ActionResult> {
  const ctx = await connect();
  if (isErr(ctx)) return ctx;
  if (!asset.borrowable) return { success: false, error: `${asset.symbol} cannot be borrowed on this market.` };
  try {
    const sim = await pub().simulateContract({
      address: LENDING.pool,
      abi: poolAbi,
      functionName: "borrow",
      args: [asset.address, amount, 2n, 0, ctx.account],
      account: ctx.account,
    });
    return await send(ctx, sim.request);
  } catch (e) {
    return { success: false, error: readable(e) };
  }
}

/** Repay. Pass `max` to clear the debt including interest accrued since the last read. */
export async function repay(
  asset: LendingAsset,
  amount: bigint,
  max = false,
): Promise<ActionResult> {
  const ctx = await connect();
  if (isErr(ctx)) return ctx;
  const MAX = (1n << 256n) - 1n;
  const value = max ? MAX : amount;
  try {
    // Approve the exact amount when repaying max: allowance must cover the debt, and the debt is
    // still growing between the read and the send.
    await ensureAllowance(ctx, asset.address, LENDING.pool, max ? amount : value);
    const sim = await pub().simulateContract({
      address: LENDING.pool,
      abi: poolAbi,
      functionName: "repay",
      args: [asset.address, value, 2n, ctx.account],
      account: ctx.account,
    });
    return await send(ctx, sim.request);
  } catch (e) {
    return { success: false, error: readable(e) };
  }
}
