"use client";
/**
 * vault.ts — client for the MoleSwap ALM vault (the MolePositions proxy on whichever chain the wallet is on).
 *
 * This wires the on-chain primitives that were built and tested in this repo:
 *   - positionsOf / getPosition  → read a wallet's ALM positions (exact, view-only)
 *   - withdrawAll(id)            → exit a position (the verified-safe one-arg exit; reads liquidity
 *                                   inside the call, so no stale-read race — see records.txt:545/1211)
 *   - withdrawWithMinimums(...)  → the same exit with a floor under what comes back, built from the TWAP
 *                                   in ./withdrawPlan. The floored exit and the unfloored one BOTH stay
 *                                   reachable; see `almWithdraw` for why that is not redundancy.
 *   - zapOpen(z, deadline)       → single-token deposit into a bounded range around spot
 *
 * IT IS NOT ROBINHOOD-ONLY ANY MORE, and that was the worst thing in this file. `chains.ts` advertises
 * LP on Arc — the ALM is deployed there and was round-tripped with real funds on 2026-08-23 — while every
 * function here built one hard-wired Robinhood client, priced one hard-wired WETH/USDG pool, and called
 * `wallet_switchEthereumChain` to drag the user back to 4663 before each deposit. The app promised a
 * product and then quietly took it away, with no message saying so. Every entry point now resolves its
 * chain through `lib/mole/vaultChain`, and the wallet's own network is CHECKED rather than overridden:
 * a mismatch is refused with a sentence, because silently moving somebody's wallet to a different chain
 * than the one they chose is the app deciding where a user's money goes.
 *
 * IMPORTANT: the vault REJECTS full-range positions — it enforces minRangeWidth/maxRangeWidth (live:
 * 120 / 120000 on Robinhood, 120 / 60000 on Arc), so a deposit must sit in a bounded range. And the
 * ZapParams slippage bound is `amountOutMin` on the swap leg (records.txt:1354 — `minLiquidity` alone is
 * NOT protection on a one-sided zap). Every write is also `simulateContract`-checked before it is sent.
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
 * `maxTwapDeviationTicks` is refused outright rather than quietly deposited into. The TWAP and the band
 * are read from the ACTIVE chain's hook and vault — the band that judges a deposit has to be the band
 * the contract receiving it will enforce.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
} from "viem";
import { molePositionsAbi, erc20Abi } from "./abi";
import {
  NoHonestAnchorError,
  assertAnchorUsable,
  readPriceAnchor,
  stateViewAbi,
  viemAnchorReads,
} from "./priceAnchor";
import { DEFAULT_SLIPPAGE_BPS, RANGE_HALF_WIDTH, buildZapPlan } from "./zapPlan";
import {
  buildWithdrawFloor,
  floorNotMetMessage,
  noAnchorFloorMessage,
  type WithdrawFloor,
} from "./withdrawPlan";
// The exit floor spends the user's OWN slippage tolerance, not zapPlan's deposit-side default: it is
// their exit, and the Settings panel is where they said how much price motion they are willing to accept.
import { getSlippageBps } from "@/lib/settings/swapSettings";
import { decodeSwapFailure } from "@/lib/aggregator/errors";
import {
  DEFAULT_VAULT_CHAIN_ID,
  vaultChainFor,
  vaultChainForOrThrow,
  type VaultChainConfig,
} from "./vaultChain";

// Theoretical v3 full-range bounds. A position is flagged "full range" only if it spans essentially the
// whole tick space; the vault's maxRangeWidth means real positions never do, so this is normally
// false — but it MUST be defined: referencing it undefined threw inside getAlmPositions' per-position
// try/catch and silently emptied every wallet's position list.
const FULL_LOWER = -887272;
const FULL_UPPER = 887272;
// The vault refuses full-range; positions must sit in [minRangeWidth, maxRangeWidth].
// RANGE_HALF_WIDTH / DEFAULT_SLIPPAGE_BPS live in ./zapPlan with the arithmetic that uses them, and
// STATE_VIEW / stateViewAbi in ./priceAnchor with the rule about what spot may and may not be used for.

/**
 * The chain a call runs against when the caller names none.
 *
 * This default is Robinhood and it exists for the one legacy caller that still passes no chain (the
 * /pools positions tab). It is safe DESPITE being a default because no write acts on it blind: every
 * write re-reads the wallet's own network and refuses on a mismatch, so a stale default fails closed
 * with a message instead of aiming an approval at the wrong chain's address. A chain-aware caller
 * always passes `useWallet().chainId`.
 */
function resolve(chainId: number | undefined): VaultChainConfig {
  return vaultChainForOrThrow(chainId ?? DEFAULT_VAULT_CHAIN_ID);
}

/** A read-only client for one chain's ALM. The RPC comes from the chain registry, never from here. */
export function almPublicClient(cfg: VaultChainConfig) {
  return createPublicClient({ chain: cfg.chain as any, transport: http(cfg.rpcUrl) });
}

export interface VaultBalances {
  /** Raw units of the pool's currency0, in currency0's OWN decimals (WETH 18 on RH, USDC 6 on Arc). */
  token0: bigint;
  /** Raw units of the pool's currency1 (USDG 6 on RH, Architects 18 on Arc). */
  token1: bigint;
  /**
   * The chain's native unit, 18 decimals on both chains.
   *
   * ON ARC THIS IS THE SAME MONEY AS `token0`, not a second balance: Arc pays gas in USDC, and the
   * ERC-20 facade is a 6-decimal view of the identical 18-decimal native balance. Show one or the
   * other, never both, and never their sum.
   */
  native: bigint;
}

/**
 * Read a wallet's balance of each pool leg plus its native balance, in one shot. The deposit card needs
 * all three: the two legs are the only assets the vault can pull, and the native balance is shown so a
 * user who has *only* gas understands why a deposit would fail before they try it.
 */
export async function getVaultBalances(owner: string, chainId?: number): Promise<VaultBalances> {
  const cfg = resolve(chainId);
  const pub = almPublicClient(cfg);
  const readBal = (t: Address) =>
    pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [owner as Address] }) as Promise<bigint>;
  const [token0, token1, native] = await Promise.all([
    readBal(cfg.token0.address as Address),
    readBal(cfg.token1.address as Address),
    pub.getBalance({ address: owner as Address }),
  ]);
  return { token0, token1, native };
}

function browserEth(): any {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum ?? null;
}

/**
 * Refuse — do not "fix" — a wallet that is on a different chain than the one this call targets.
 *
 * This replaces an `ensureChain` that fired `wallet_switchEthereumChain` back to Robinhood on every
 * deposit and withdrawal, swallowing the result. Two things were wrong with that. It made Arc LP
 * unreachable while the app advertised it, and more importantly it moved a user's wallet to a network
 * they had not chosen in order to spend their money there. The check still has to exist as a check,
 * because the wallet can change chains between the page resolving its config and the user signing, and
 * a Robinhood-shaped transaction sent on Arc would target a completely different contract.
 *
 * Returns an error sentence, or null when the wallet really is where we think it is.
 */
async function walletChainMismatch(eth: any, cfg: VaultChainConfig): Promise<string | null> {
  let actual: number;
  try {
    actual = parseInt(await eth.request({ method: "eth_chainId" }), 16);
  } catch {
    // The wallet would not say. Refusing beats guessing: the alternative is signing a transaction
    // built for one chain against whatever the wallet happens to be on.
    return "Could not read your wallet's network. Nothing was submitted — reconnect and try again.";
  }
  if (actual === cfg.chainId) return null;
  const here = vaultChainFor(actual)?.meta.name ?? `chain ${String(actual)}`;
  return `Your wallet is on ${here}, but this position lives on ${cfg.meta.name}. Switch networks and try again — nothing was submitted.`;
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

/** Read every ALM position a wallet owns (positions with liquidity > 0) on one chain. */
export async function getAlmPositions(owner: string, chainId?: number): Promise<AlmPosition[]> {
  const cfg = resolve(chainId);
  const pub = almPublicClient(cfg);
  const ids = (await pub.readContract({
    address: cfg.positions,
    abi: molePositionsAbi,
    functionName: "positionsOf",
    args: [owner as Address],
  })) as bigint[];

  const out: AlmPosition[] = [];
  for (const id of ids) {
    try {
      const p = (await pub.readContract({
        address: cfg.positions,
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

/**
 * Build the zapOpen argument for a single-token deposit of `amountIn` of `token` on `cfg`'s chain.
 *
 * Reads the TWAP (the anchor), spot (only to judge it), and the vault's own deviation band — all three
 * from THIS chain's hook and vault — then hands them to the pure builder in ./zapPlan. THROWS on a pool
 * whose spot has walked outside that band: see the header — a bound is not the answer when the price the
 * swap executes at is the price we distrust, and the caller turns the throw into a message rather than a
 * transaction.
 */
export async function buildZap(
  pub: ReturnType<typeof almPublicClient>,
  token: Address,
  amountIn: bigint,
  cfg: VaultChainConfig,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
) {
  // Which leg is being deposited decides the swap DIRECTION, so a token that is neither leg cannot be
  // allowed to fall through to `false` and swap the wrong way. The legs differ by chain — WETH is
  // currency0 on Robinhood, USDC is currency0 on Arc — which is precisely why this is a comparison
  // against the resolved pool key and not against a constant.
  const c0 = (cfg.poolKey.currency0 as string).toLowerCase();
  const c1 = (cfg.poolKey.currency1 as string).toLowerCase();
  const t = token.toLowerCase();
  if (t !== c0 && t !== c1) {
    throw new Error(
      `${token} is not one of this pool's two tokens (${cfg.token0.symbol}/${cfg.token1.symbol} on ${cfg.meta.name}). Nothing was submitted.`,
    );
  }
  const isToken0 = t === c0;
  const anchor = await readPriceAnchor(
    viemAnchorReads(pub, cfg.poolId, { moleHook: cfg.hook, molePositions: cfg.positions }),
  );
  const plan = buildZapPlan({
    anchor,
    zeroForOne: isToken0,
    amountIn,
    tickSpacing: cfg.tickSpacing,
    slippageBps,
    rangeHalfWidthTicks: RANGE_HALF_WIDTH,
  });

  return {
    key: {
      currency0: cfg.poolKey.currency0,
      currency1: cfg.poolKey.currency1,
      fee: cfg.poolKey.fee,
      tickSpacing: cfg.poolKey.tickSpacing,
      hooks: cfg.poolKey.hooks,
    },
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
export async function getPoolState(chainId?: number): Promise<{ tick: number; sqrtPriceX96: bigint } | null> {
  try {
    const cfg = resolve(chainId);
    const pub = almPublicClient(cfg);
    const slot0 = (await pub.readContract({
      address: cfg.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [cfg.poolId],
    })) as readonly [bigint, number, number, number];
    return { sqrtPriceX96: slot0[0], tick: Number(slot0[1]) };
  } catch {
    return null;
  }
}

export interface DepositResult {
  success: boolean;
  txHash?: string;
  error?: string;
  positionId?: string;
  /**
   * Set ONLY when a floored exit was refused by ITS OWN floor — never for any other failure.
   *
   * The caller needs to tell those two apart, because they call for opposite responses. A floor that
   * is too high does not cost the owner slippage, it TRAPS them, so the UI offers the unfloored exit
   * in this one case. Every other revert is the protocol saying no for a reason of its own and must
   * be reported as itself, not retried without a bound.
   */
  floorNotMet?: boolean;
}

/**
 * Turn a reverted vault call into words a depositor can act on.
 *
 * WHY THIS EXISTS. Every failure path here used to end in
 * `err?.shortMessage || err?.message?.split("\n")[0]`, which for a custom error is the raw selector —
 * a user who tripped `PoolTooLarge`, `SpotTooFarFromTwap` or a size-band bound saw eight bytes of hex
 * and no idea whether the app was broken or a guard had just protected them. Several of those reverts
 * are protections working exactly as designed, and reading a working guard as a crash is its own kind
 * of harm: it teaches people the product is unreliable at the moment it is being careful.
 *
 * `decodeSwapFailure` already carries the MolePositions, ZapLogic and MoleQueue registries — the
 * decoder knew these errors before anything called it with one. This just hands them over.
 *
 * The fallback chain is deliberate: a decoded protocol message first, then viem's own short message
 * (which is right for the everyday cases — user rejected, insufficient funds), then `fallback`. A
 * decoded message is never discarded in favour of a shorter one.
 */
function vaultFailure(err: any, fallback: string): string {
  try {
    const decoded = decodeSwapFailure(err);
    if (decoded?.message) return decoded.title ? `${decoded.title}: ${decoded.message}` : decoded.message;
  } catch {
    // The decoder must never be the reason a failure is unreportable — fall through to the raw text.
  }
  return err?.shortMessage || err?.message?.split("\n")[0] || fallback;
}


const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

function deadline(): bigint {
  // 20 minutes from a server-supplied-ish clock. Date.now is fine in the browser.
  return BigInt(Math.floor(Date.now() / 1000) + 1200);
}

/**
 * Deposit the chain's NATIVE unit: wrap it into the pool's wrapped-native leg first (WETH.deposit is a
 * proxy predeploy, verified live on Robinhood), then run the normal single-sided zap. The pool's WETH leg
 * IS wrapped ETH, and there is no ETH/WETH pool because ETH↔WETH is a 1:1 wrap, not a trade — so this is
 * the correct path for a user who holds only ETH. (The vault mints the position to msg.sender and has no
 * `openFor`, so the wrap can't be folded into the same transaction as the zap — it's wrap → deposit.)
 *
 * ROBINHOOD ONLY, and the refusal is explicit rather than a hidden button. Arc has no wrapped-native
 * token at all: `contractsFor(5042).WETH` is the zero address on purpose, MoleRouter's weth slot is
 * pinned to the USDC ERC-20 so native paths fail closed, and a transfer to address(0) reverts on Arc
 * anyway. A "wrap" there would be a call to nothing, so this path says why instead of trying.
 */
export async function almDepositNative(
  amountIn: bigint,
  onStep?: (s: string) => void,
  chainId?: number,
): Promise<DepositResult> {
  try {
    const cfg = resolve(chainId);
    if (cfg.nativeDepositUnavailable) return { success: false, error: cfg.nativeDepositUnavailable };
    const native = cfg.depositTokens.find((d) => d.native);
    if (!native) return { success: false, error: `${cfg.meta.name} has no native deposit path.` };

    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    const wrongChain = await walletChainMismatch(eth, cfg);
    if (wrongChain) return { success: false, error: wrongChain };
    const wallet = createWalletClient({ chain: cfg.chain as any, transport: custom(eth) });
    const pub = almPublicClient(cfg);
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };

    // THE REFUSAL COMES BEFORE THE IRREVERSIBLE STEP. Wrapping is a one-way trip for a user who only
    // holds ETH, so a pool that is going to be refused must be refused here — not after they are left
    // holding WETH they never asked for. Same read the deposit itself will do a moment later.
    await readPriceAnchor(
      viemAnchorReads(pub, cfg.poolId, { moleHook: cfg.hook, molePositions: cfg.positions }),
    ).then((a) => assertAnchorUsable(a));

    onStep?.("Wrapping ETH → WETH…");
    const wrapHash = await wallet.writeContract({
      address: native.address as Address, abi: wethAbi, functionName: "deposit", value: amountIn, account, chain: cfg.chain as any,
    });
    const wr = await pub.waitForTransactionReceipt({ hash: wrapHash });
    if (wr.status !== "success") return { success: false, txHash: wrapHash, error: "Wrap reverted" };

    onStep?.("Depositing WETH…");
    return await almDeposit(native.address as Address, amountIn, cfg.chainId);
  } catch (err: any) {
    return { success: false, error: vaultFailure(err, "Deposit failed") };
  }
}

/**
 * Deposit `amountIn` RAW UNITS of `token` — one of the pool's two legs on `chainId` — into the ALM as a
 * bounded-range position. Simulates against the live vault first; only sends if the simulation succeeds.
 *
 * `amountIn` is in the TOKEN's decimals, which is not the same number on both chains and not the same
 * on both legs: 18 for WETH and Architects, 6 for USDG and Arc's USDC. Callers take decimals from the
 * token, never from a constant — a 6-for-18 substitution here is a 1e12 error.
 */
export async function almDeposit(token: Address, amountIn: bigint, chainId?: number): Promise<DepositResult> {
  try {
    const cfg = resolve(chainId);
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    const wrongChain = await walletChainMismatch(eth, cfg);
    if (wrongChain) return { success: false, error: wrongChain };
    const wallet = createWalletClient({ chain: cfg.chain as any, transport: custom(eth) });
    const pub = almPublicClient(cfg);
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };
    if (amountIn <= 0n) return { success: false, error: "Enter an amount" };

    // 1) the bounds, FIRST. buildZap reads the TWAP, judges spot against the vault's own band and
    //    throws on a pool that looks manipulated. Doing it before the approval means a refused deposit
    //    leaves nothing behind — no standing allowance granted for a transaction we then declined to
    //    build. The range and both bounds are anchored to the TWAP; see the file header.
    const z = await buildZap(pub, token, amountIn, cfg);

    // 2) allowance → vault
    const allowance = (await pub.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account, cfg.positions],
    })) as bigint;
    if (allowance < amountIn) {
      const ah = await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [cfg.positions, amountIn],
        account,
        chain: cfg.chain as any,
      });
      await pub.waitForTransactionReceipt({ hash: ah });
    }

    // 3) simulate zapOpen against the live vault, then send
    const sim = await pub.simulateContract({
      address: cfg.positions,
      abi: molePositionsAbi,
      functionName: "zapOpen",
      args: [z as any, deadline()],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: cfg.chain as any });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash, positionId: sim.result?.toString() };
  } catch (err: any) {
    return { success: false, error: vaultFailure(err, "Deposit failed") };
  }
}

/**
 * Exit a position fully via the verified-safe withdrawAll(id), on the position's own chain — WITHOUT a
 * floor, and it must stay that way.
 *
 * THIS IS THE ESCAPE HATCH, and it is what lets the floored exit below be strict. A floor is a promise
 * the pool has to keep, so every floor is also a condition under which the exit refuses to happen — and
 * an exit that can refuse must always sit beside one that cannot, or this app has built the thing
 * `MolePositions.withdraw` documents itself as refusing to be: something standing between an owner and
 * their own position. A user who has decided to leave at any price gets to, in one call, with no price
 * read involved and nothing that can fail closed.
 *
 * It also keeps the stale-liquidity race out of the default path: `withdrawAll` reads `p.liquidity`
 * INSIDE the call, so a keeper rebalance landing in the same block cannot leave a remainder behind.
 * `almWithdrawWithFloor` has to echo a liquidity number back and therefore cannot have that property —
 * one more reason this is the exit the UI reaches for when the user simply wants out.
 */
export async function almWithdraw(id: string | bigint, chainId?: number): Promise<DepositResult> {
  try {
    const cfg = resolve(chainId);
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    const wrongChain = await walletChainMismatch(eth, cfg);
    if (wrongChain) return { success: false, error: wrongChain };
    const wallet = createWalletClient({ chain: cfg.chain as any, transport: custom(eth) });
    const pub = almPublicClient(cfg);
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const sim = await pub.simulateContract({
      address: cfg.positions,
      abi: molePositionsAbi,
      functionName: "withdrawAll",
      args: [BigInt(id)],
      account,
    });
    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: cfg.chain as any });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash };
  } catch (err: any) {
    return { success: false, error: vaultFailure(err, "Withdraw failed") };
  }
}

/* ============================================================== the exit WITH a floor */

/**
 * `WithdrawBelowMinimum()`, the one revert this path may translate into "your floor was not met".
 *
 * Every other revert from `withdrawWithMinimums` means something else entirely — `NotOwner()`,
 * `InsufficientLiquidity()` from a liquidity number a rebalance moved, a dead RPC — and reporting those
 * as a price problem sends the user to fix the wrong thing. General decoding of the vault's error set
 * lives in lib/aggregator/errors.ts; this selector is here because it selects BEHAVIOUR, not copy.
 */
const WITHDRAW_BELOW_MINIMUM_SELECTOR = "0x0fdbcf37";

export interface FlooredExitOptions {
  /** Burn only part of the position. Defaults to all of it, read fresh immediately before the call. */
  liquidityToRemove?: bigint;
  /** Overrides the user's Max Slippage setting. For a caller that has its own tolerance to spend. */
  slippageBps?: number;
}

/** The fields of a position this exit needs, read fresh — a liquidity number is never cached here. */
async function readPositionForExit(pub: ReturnType<typeof almPublicClient>, cfg: VaultChainConfig, id: bigint) {
  const p = (await pub.readContract({
    address: cfg.positions,
    abi: molePositionsAbi,
    functionName: "getPosition",
    args: [id],
  })) as any;
  return {
    owner: p.owner as Address,
    poolId: p.poolId as `0x${string}`,
    tickLower: Number(p.tickLower),
    tickUpper: Number(p.tickUpper),
    liquidity: BigInt(p.liquidity ?? 0n),
  };
}

/**
 * What a floored exit of `id` would promise, sending nothing — the numbers a confirm screen shows before
 * the user commits to them.
 *
 * Throws rather than returning a floorless plan when the TWAP cannot be read (`NoHonestAnchorError`):
 * there is no honest price to build a floor from, and a floor of zero dressed up as a floor is worse
 * than none because the user would believe it. The answer to that throw is the unfloored `almWithdraw`,
 * chosen by the user, not a minimum this file invented.
 */
export async function previewWithdrawFloor(
  id: string | bigint,
  opts: FlooredExitOptions = {},
  chainId?: number,
): Promise<WithdrawFloor> {
  const cfg = resolve(chainId);
  const pub = almPublicClient(cfg);
  const p = await readPositionForExit(pub, cfg, BigInt(id));
  // Anchored on the price of the pool THIS position lives in — `p.poolId` from storage, not the chain's
  // headline pool — so a vault holding more than one pool cannot floor an exit against the wrong market.
  const anchor = await readPriceAnchor(
    viemAnchorReads(pub, p.poolId, { moleHook: cfg.hook, molePositions: cfg.positions }),
  );
  return buildWithdrawFloor({
    anchor,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
    liquidityToRemove: opts.liquidityToRemove ?? p.liquidity,
    slippageBps: opts.slippageBps ?? getSlippageBps(),
  });
}

/**
 * Exit a position through `withdrawWithMinimums`, with a TWAP-derived floor under both legs.
 *
 * The floor is built by ./withdrawPlan from the position's OWN liquidity and range at the hook's
 * time-averaged price, widened by the user's Max Slippage setting. Nothing here is derived from `slot0`:
 * a minimum computed from the instantaneous price and then enforced against a burn settling at that same
 * instantaneous price agrees with a manipulated pool by construction — the defect the deposit side was
 * rebuilt to remove, and worse on the way OUT, because the user is leaving.
 *
 * FAILS CLOSED, AND THE USER KEEPS THE POSITION. `simulateContract` runs the floor against the live vault
 * first, so a pool that cannot meet it costs nothing at all — no gas, no signature, no state change — and
 * the message says so and names the exit that carries no floor. The one thing this function must never do
 * is quietly retry without the floor: a floor the app drops when it becomes inconvenient is not a floor,
 * and the choice to leave at any price belongs to the user, who has `almWithdraw` for exactly that.
 *
 * THE STALE-LIQUIDITY RACE IS REAL AND BOUNDED. `withdrawWithMinimums` takes a liquidity number, so
 * unlike `withdrawAll` it cannot read one inside the call. A keeper rebalance between this read and
 * inclusion rewrites both the number and the range (a rebalance conserves token amounts, not liquidity).
 * Too high reverts on `InsufficientLiquidity`; too low leaves a remainder the user can withdraw again; a
 * moved range misses the floor and reverts. All three land on "you still own it", none of them loses
 * funds, and reading immediately before the simulation keeps the window down to the send itself.
 */
export async function almWithdrawWithFloor(
  id: string | bigint,
  opts: FlooredExitOptions = {},
  chainId?: number,
): Promise<DepositResult> {
  try {
    const cfg = resolve(chainId);
    const eth = browserEth();
    if (!eth) return { success: false, error: "No wallet found" };
    const wrongChain = await walletChainMismatch(eth, cfg);
    if (wrongChain) return { success: false, error: wrongChain };
    const wallet = createWalletClient({ chain: cfg.chain as any, transport: custom(eth) });
    const pub = almPublicClient(cfg);
    const [account] = await wallet.getAddresses();
    if (!account) return { success: false, error: "Wallet not connected" };

    const pid = BigInt(id);
    const p = await readPositionForExit(pub, cfg, pid);
    const liquidityToRemove = opts.liquidityToRemove ?? p.liquidity;
    if (liquidityToRemove <= 0n) return { success: false, error: "This position holds no liquidity" };
    if (liquidityToRemove > p.liquidity) {
      return { success: false, error: "That is more liquidity than this position holds" };
    }

    // A MISSING ANCHOR REFUSES THIS EXIT, AND THE REFUSAL CARRIES THE WAY OUT WITH IT. `readPriceAnchor`
    // throws rather than reaching for the instantaneous price, which is right — there is nothing honest
    // to floor against — but its own sentence ends at "try again in a few minutes", and that is a
    // deposit's sentence. Read by an owner who is trying to leave, a refusal with no alternative inside
    // it is indistinguishable from trapped funds. Same refusal, different words, and the words name the
    // exit that reads no price at all. Anything else thrown here is a different problem and stays itself.
    let anchor;
    try {
      anchor = await readPriceAnchor(
        viemAnchorReads(pub, p.poolId, { moleHook: cfg.hook, molePositions: cfg.positions }),
      );
    } catch (err: any) {
      if (err instanceof NoHonestAnchorError || err?.name === "NoHonestAnchorError") {
        return { success: false, error: noAnchorFloorMessage() };
      }
      throw err;
    }
    const floor = buildWithdrawFloor({
      anchor,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidityToRemove,
      slippageBps: opts.slippageBps ?? getSlippageBps(),
    });

    let sim;
    try {
      sim = await pub.simulateContract({
        address: cfg.positions,
        abi: molePositionsAbi,
        functionName: "withdrawWithMinimums",
        args: [pid, floor.liquidityToRemove, floor.amount0Min, floor.amount1Min],
        account,
      });
    } catch (err: any) {
      // ONLY the floor's own revert becomes the floor's message. Anything else is reported as itself.
      const raw = `${err?.shortMessage ?? ""} ${err?.message ?? ""} ${err?.details ?? ""}`;
      if (raw.includes(WITHDRAW_BELOW_MINIMUM_SELECTOR) || raw.includes("WithdrawBelowMinimum")) {
        return { success: false, error: floorNotMetMessage(floor), floorNotMet: true };
      }
      throw err;
    }

    const hash = await wallet.writeContract({ ...(sim.request as any), account, chain: cfg.chain as any });
    await pub.waitForTransactionReceipt({ hash });
    return { success: true, txHash: hash };
  } catch (err: any) {
    return { success: false, error: vaultFailure(err, "Withdraw failed") };
  }
}
