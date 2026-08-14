import { NextRequest } from "next/server";
import { ethers } from "ethers";
import { apiResponse, apiError, withRateLimit, corsPreflightResponse } from "@/lib/api/helpers";
import { CONTRACTS, RH_CHAIN_ID, RH_RPC_URL, RH_PUBLIC_RPC_URL } from "@/lib/chain/contracts";
import {
  LIVE_POOL_KEY,
  LIVE_POOL_ID,
  DYNAMIC_FEE_FLAG,
  WETH,
  USDG,
  type TokenMeta,
} from "@/lib/mole/chain";
import {
  assertValidDecimals,
  applySlippageFloor,
  formatUnitsDisplay,
} from "@/lib/mole/format";
import { getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from "@/lib/aggregator/math/tickMath";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/tx/add-liquidity — build the calldata that adds TWO-SIDED liquidity to the live pool.
 *
 * There is no user-facing v3 NonfungiblePositionManager on Robinhood Chain, so there is no `mint` to
 * encode. The two-sided entry point that IS deployed is `MolePositions.open(key, tickLower, tickUpper,
 * liquidity, amount0Max, amount1Max, deadline)` — the same call the create-pool seeding path uses
 * (lib/mole/seedLiquidity.ts, which is client-only; the liquidity math is re-derived here so this
 * server route pulls in no client module). This handler therefore returns real, executable steps:
 * wrap (native input only) → approve × 2 → open.
 *
 * WHAT THE PUBLISHED PARAMETER TABLE PROMISES THAT THE DEPLOYED CONTRACT CANNOT DO — reported back to
 * the caller in `parameterNotes`, never silently ignored:
 *   - `recipient`: `open` has NO owner/recipient argument. The position owner is `msg.sender`, by
 *     design ("so a phished approval cannot be used to open a position that pays elsewhere",
 *     MolePositions.sol:674). `recipient` is therefore validated and echoed as the address the
 *     transactions MUST be sent from; it cannot redirect ownership.
 *   - `tickLower`/`tickUpper` "Default: full range": the vault REJECTS full range — `_validateRange`
 *     enforces minRangeWidth/maxRangeWidth (read live below). The default is a bounded range centred
 *     on the current tick instead, matching the vault UI's own deposit range.
 *   - `fee`: the live pool's key carries the v4 dynamic-fee sentinel (0x800000), not a static tier;
 *     MoleHook drives the LP fee. A static tier is accepted only if it cannot mean a different pool.
 *
 * DECIMALS: every amount echoed back is formatted through lib/mole/format.ts with the decimals pinned
 * in lib/mole/chain.ts (WETH 18, USDG 6). No `|| 18` fallback exists anywhere in this file.
 */

const VAULT = CONTRACTS.MOLE_POSITIONS;

// v4 StateView — the read-only window onto the PoolManager's slot0 (same address the vault UI reads).
const STATE_VIEW = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";
const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

const VAULT_ABI = [
  "function open((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 amount0Max, uint256 amount1Max, uint256 deadline) payable returns (uint256 id)",
  "function isWhitelisted(bytes32 poolId) view returns (bool)",
  "function minRangeWidth() view returns (int24)",
  "function maxRangeWidth() view returns (int24)",
  "function minPositionLiquidity() view returns (uint128)",
  "function maxPositionLiquidity() view returns (uint128)",
];

const ERC20_APPROVE_ABI = ["function approve(address spender, uint256 amount) returns (bool)"];
const WETH_DEPOSIT_ABI = ["function deposit() payable"];

const ZERO = ethers.ZeroAddress.toLowerCase();
const TICK_SPACING = LIVE_POOL_KEY.tickSpacing;
/** Half-width of the default deposit range, in ticks — the same 15 000 the vault deposit card uses. */
const DEFAULT_RANGE_HALF_WIDTH = 15_000;
/** Fallbacks used only if the on-chain bound read fails; the live values are 120 / 60000. */
const FALLBACK_MIN_RANGE_WIDTH = 120;
const FALLBACK_MAX_RANGE_WIDTH = 60_000;

const Q96 = BigInt(1) << BigInt(96);

/**
 * Liquidity obtainable from a pair of maximum amounts over [tickLower, tickUpper] at the current price.
 * Integer-only port of Uniswap's LiquidityAmounts; inside the range the BINDING (minimum) leg wins,
 * because a liquidity number the wallet cannot fund would revert against `open`'s amountMax caps.
 * Mirrors lib/mole/seedLiquidity.ts:getLiquidityForAmounts (that module is "use client").
 */
function getLiquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0: bigint,
  amount1: bigint,
): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const liq0 = (sa: bigint, sb: bigint, amt: bigint) =>
    sb <= sa ? BigInt(0) : (amt * ((sa * sb) / Q96)) / (sb - sa);
  const liq1 = (sa: bigint, sb: bigint, amt: bigint) =>
    sb <= sa ? BigInt(0) : (amt * Q96) / (sb - sa);

  if (sqrtP <= sqrtA) return liq0(sqrtA, sqrtB, amount0);
  if (sqrtP >= sqrtB) return liq1(sqrtA, sqrtB, amount1);
  const l0 = liq0(sqrtP, sqrtB, amount0);
  const l1 = liq1(sqrtA, sqrtP, amount1);
  return l0 < l1 ? l0 : l1;
}

/** Snap to the pool's tick spacing, staying strictly inside the representable tick range. */
function snapToSpacing(tick: number): number {
  const rounded = Math.round(tick / TICK_SPACING) * TICK_SPACING;
  const floor = Math.ceil(MIN_TICK / TICK_SPACING) * TICK_SPACING;
  const ceil = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;
  if (rounded < floor) return floor;
  if (rounded > ceil) return ceil;
  return rounded;
}

/** Parse a wei amount. Strings only in, bigint out — no float ever touches a raw amount. */
function parseWei(label: string, raw: unknown): { value?: bigint; error?: string } {
  if (raw === null || raw === undefined || raw === "") {
    return { error: `${label} is required (integer string, in the token's smallest unit)` };
  }
  if (typeof raw === "number") {
    return { error: `${label} must be a STRING in wei — a JS number cannot hold a wei amount exactly` };
  }
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return { error: `${label} must be an unsigned integer string in wei, got "${s}"` };
  return { value: BigInt(s) };
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export async function OPTIONS() {
  return corsPreflightResponse();
}

export async function POST(req: NextRequest) {
  const blocked = withRateLimit(req, "write");
  if (blocked) return blocked;

  try {
    const body = await req.json().catch(() => ({}));
    const {
      token0,
      token1,
      amount0Desired,
      amount1Desired,
      recipient,
      fee = 500,
      tickLower: tickLowerIn,
      tickUpper: tickUpperIn,
      slippageBps = 50,
      deadline,
    } = body ?? {};

    /* ─────────── deterministic validation (no RPC below this line until it passes) ─────────── */

    if (!token0 || !token1 || !amount0Desired || !amount1Desired || !recipient) {
      return apiError(
        "Missing required fields: token0, token1, amount0Desired (wei), amount1Desired (wei), recipient. " +
          "Optional: fee, tickLower, tickUpper, slippageBps, deadline",
        400,
      );
    }
    for (const [label, addr] of [["token0", token0], ["token1", token1]] as const) {
      if (!ethers.isAddress(addr)) return apiError(`Invalid ${label} address`, 400);
    }
    if (!ethers.isAddress(recipient)) return apiError("Invalid recipient address", 400);

    const amt0 = parseWei("amount0Desired", amount0Desired);
    if (amt0.error) return apiError(amt0.error, 400);
    const amt1 = parseWei("amount1Desired", amount1Desired);
    if (amt1.error) return apiError(amt1.error, 400);
    if (amt0.value === BigInt(0) || amt1.value === BigInt(0)) {
      return apiError(
        "Both amount0Desired and amount1Desired must be > 0. A bounded range around the current price " +
          "needs both legs; for a ONE-sided deposit use MolePositions.zapOpen (the /vault UI), which " +
          "swaps half of a single token for you.",
        400,
      );
    }

    if (!isInt(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
      return apiError("slippageBps must be an integer between 0 and 10000", 400);
    }
    if (tickLowerIn !== undefined && !isInt(tickLowerIn)) return apiError("tickLower must be an integer", 400);
    if (tickUpperIn !== undefined && !isInt(tickUpperIn)) return apiError("tickUpper must be an integer", 400);
    if (deadline !== undefined && (!isInt(deadline) || deadline <= 0)) {
      return apiError("deadline must be a positive integer unix timestamp (seconds)", 400);
    }

    // Fee tier. The live pool key carries the v4 dynamic-fee sentinel; a static tier is accepted only
    // as a label, and only when it cannot be mistaken for a request for a DIFFERENT (non-existent) pool.
    const feeNum = Number(fee);
    const acceptedFeeLabels = [500, DYNAMIC_FEE_FLAG];
    if (!acceptedFeeLabels.includes(feeNum)) {
      return apiError(
        `Fee tier ${String(fee)} does not exist on Robinhood Chain. The only whitelisted pool is the ` +
          `Uniswap-v4 WETH/USDG pool whose key carries the dynamic-fee flag 0x800000 (${DYNAMIC_FEE_FLAG}) ` +
          "— MoleHook sets the LP fee per swap. Omit `fee`, or pass 500 (the documented default) or 8388608.",
        400,
      );
    }

    // Native ETH is not a currency of this pool (currency0 is WETH), so a native leg is wrapped first.
    const nativeAsToken0 = token0.toLowerCase() === ZERO;
    const nativeAsToken1 = token1.toLowerCase() === ZERO;
    const addr0 = nativeAsToken0 ? WETH.address : ethers.getAddress(token0);
    const addr1 = nativeAsToken1 ? WETH.address : ethers.getAddress(token1);

    if (addr0.toLowerCase() === addr1.toLowerCase()) {
      return apiError("token0 and token1 must be different tokens", 400);
    }

    // Map the caller's (token, amount) pairs onto the pool's currency order. The caller may pass them
    // in either order; getting this backwards would size the position with the wrong leg's decimals.
    const legs = [
      { address: addr0, amount: amt0.value as bigint, wasNative: nativeAsToken0, field: "amount0Desired" },
      { address: addr1, amount: amt1.value as bigint, wasNative: nativeAsToken1, field: "amount1Desired" },
    ];
    const currency0 = LIVE_POOL_KEY.currency0.toLowerCase();
    const currency1 = LIVE_POOL_KEY.currency1.toLowerCase();
    const leg0 = legs.find((l) => l.address.toLowerCase() === currency0);
    const leg1 = legs.find((l) => l.address.toLowerCase() === currency1);
    if (!leg0 || !leg1) {
      return apiError(
        `Unsupported pair. The only pool whitelisted by the MoleSwap vault (${VAULT}) is ` +
          `WETH ${WETH.address} / USDG ${USDG.address} on Uniswap v4. Native ETH (0x0) is accepted for the ` +
          "WETH leg and wrapped for you.",
        400,
      );
    }

    // Decimals come from the pinned registry and are asserted — never defaulted to 18.
    const meta0: TokenMeta = WETH;
    const meta1: TokenMeta = USDG;
    assertValidDecimals(meta0.decimals);
    assertValidDecimals(meta1.decimals);

    const amount0Max = leg0.amount;
    const amount1Max = leg1.amount;
    const txDeadline = deadline ?? Math.floor(Date.now() / 1000) + 3600;

    /* ───────────────────────────────── live chain state ───────────────────────────────── */

    const provider = new ethers.JsonRpcProvider(RH_RPC_URL);
    const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);
    const stateView = new ethers.Contract(STATE_VIEW, STATE_VIEW_ABI, provider);

    let sqrtPriceX96: bigint;
    let currentTick: number;
    try {
      const slot0 = await stateView.getSlot0(LIVE_POOL_ID);
      sqrtPriceX96 = BigInt(slot0[0]);
      currentTick = Number(slot0[1]);
    } catch (e: any) {
      return apiError(
        `Could not read the live pool price from the v4 StateView (${STATE_VIEW}): ${e?.message || "RPC error"}`,
        503,
      );
    }
    if (sqrtPriceX96 === BigInt(0)) {
      return apiError("The live pool is not initialized — no price to size a position against.", 409);
    }

    const [whitelisted, minRangeWidth, maxRangeWidth, minPosLiq, maxPosLiq] = await Promise.all([
      vault.isWhitelisted(LIVE_POOL_ID).then((v: boolean) => v).catch(() => true),
      vault.minRangeWidth().then((v: bigint) => Number(v)).catch(() => FALLBACK_MIN_RANGE_WIDTH),
      vault.maxRangeWidth().then((v: bigint) => Number(v)).catch(() => FALLBACK_MAX_RANGE_WIDTH),
      vault.minPositionLiquidity().then((v: bigint) => BigInt(v)).catch(() => BigInt(0)),
      vault.maxPositionLiquidity().then((v: bigint) => BigInt(v)).catch(() => BigInt(0)),
    ]);

    if (!whitelisted) {
      return apiError(
        `The WETH/USDG v4 pool (${LIVE_POOL_ID}) is not whitelisted by the vault right now — open() would revert.`,
        409,
      );
    }

    /* ──────────────────────────────────── the range ──────────────────────────────────── */

    const center = snapToSpacing(currentTick);
    const halfDefault = Math.round(DEFAULT_RANGE_HALF_WIDTH / TICK_SPACING) * TICK_SPACING;
    const requestedLower = isInt(tickLowerIn) ? tickLowerIn : center - halfDefault;
    const requestedUpper = isInt(tickUpperIn) ? tickUpperIn : center + halfDefault;
    const tickLower = snapToSpacing(requestedLower);
    const tickUpper = snapToSpacing(requestedUpper);
    const snapped = tickLower !== requestedLower || tickUpper !== requestedUpper;

    if (tickLower >= tickUpper) return apiError("tickLower must be strictly below tickUpper", 400);
    const width = tickUpper - tickLower;
    if (width < minRangeWidth || width > maxRangeWidth) {
      return apiError(
        `Range width ${width} ticks is outside the vault's bounds [${minRangeWidth}, ${maxRangeWidth}] and ` +
          "open() would revert with RangeWidthOutOfBounds. Full-range positions are rejected by design — " +
          `omit tickLower/tickUpper to get a bounded range centred on the current tick (${currentTick}).`,
        400,
      );
    }

    /* ─────────────────────────────────── the liquidity ────────────────────────────────── */

    const sqrtLower = getSqrtRatioAtTick(tickLower);
    const sqrtUpper = getSqrtRatioAtTick(tickUpper);
    const liquidityAtQuote = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, amount0Max, amount1Max);
    if (liquidityAtQuote <= BigInt(0)) {
      return apiError(
        "The supplied amounts mint zero liquidity over this range — increase amount0Desired / amount1Desired.",
        400,
      );
    }
    // `open` takes a DECLARED liquidity plus a hard cap on each leg. Between building this calldata and
    // it landing, the tick can move and the same liquidity can cost more of one leg — so the declared
    // liquidity is shaved by slippageBps, leaving headroom under the caps instead of reverting.
    const liquidity = applySlippageFloor(liquidityAtQuote, slippageBps);
    if (liquidity <= BigInt(0)) {
      return apiError(`slippageBps ${slippageBps} shaves the position to zero liquidity.`, 400);
    }
    if (minPosLiq !== BigInt(0) && liquidity < minPosLiq) {
      return apiError(
        `Position too small: ${liquidity.toString()} liquidity is below the vault's minPositionLiquidity ` +
          `(${minPosLiq.toString()}). Increase the deposit amounts or narrow the range.`,
        400,
      );
    }
    if (maxPosLiq !== BigInt(0) && liquidity > maxPosLiq) {
      return apiError(
        `Position too large: ${liquidity.toString()} liquidity exceeds the vault's maxPositionLiquidity ` +
          `(${maxPosLiq.toString()}). Reduce the deposit amounts or widen the range.`,
        400,
      );
    }

    /* ───────────────────────────────── the transactions ───────────────────────────────── */

    const transactions: any[] = [];
    const wethIface = new ethers.Interface(WETH_DEPOSIT_ABI);
    const erc20Iface = new ethers.Interface(ERC20_APPROVE_ABI);
    const vaultIface = new ethers.Interface(VAULT_ABI);

    // 1. wrap — only when a leg was handed to us as native ETH.
    const nativeLeg = [leg0, leg1].find((l) => l.wasNative);
    if (nativeLeg) {
      transactions.push({
        to: WETH.address,
        value: nativeLeg.amount.toString(),
        data: wethIface.encodeFunctionData("deposit"),
        description: `Wrap ${formatUnitsDisplay(nativeLeg.amount, meta0.decimals, 6)} ETH → WETH (1:1)`,
      });
    }

    // 2. approve — `open` pulls both legs with transferFrom, capped by amount{0,1}Max. Approve exactly
    //    the cap, not MAX_UINT: the caps are the only thing standing between a phished approval and the
    //    caller's whole balance, so there is no reason to hand the vault more than this deposit needs.
    transactions.push({
      to: meta0.address,
      value: "0",
      data: erc20Iface.encodeFunctionData("approve", [VAULT, amount0Max]),
      description: `Approve ${formatUnitsDisplay(amount0Max, meta0.decimals, 6)} ${meta0.symbol} to MolePositions`,
    });
    transactions.push({
      to: meta1.address,
      value: "0",
      data: erc20Iface.encodeFunctionData("approve", [VAULT, amount1Max]),
      description: `Approve ${formatUnitsDisplay(amount1Max, meta1.decimals, 6)} ${meta1.symbol} to MolePositions`,
    });

    // 3. open — the two-sided mint. This is what `NonfungiblePositionManager.mint` would have been.
    const key = [
      LIVE_POOL_KEY.currency0,
      LIVE_POOL_KEY.currency1,
      LIVE_POOL_KEY.fee,
      LIVE_POOL_KEY.tickSpacing,
      LIVE_POOL_KEY.hooks,
    ];
    transactions.push({
      to: VAULT,
      value: "0",
      data: vaultIface.encodeFunctionData("open", [
        key,
        tickLower,
        tickUpper,
        liquidity,
        amount0Max,
        amount1Max,
        txDeadline,
      ]),
      description: `MolePositions.open — mint ${liquidity.toString()} liquidity over ticks [${tickLower}, ${tickUpper}]`,
      note: `MUST be sent from ${recipient} — open() credits the position to msg.sender and has no recipient argument.`,
    });

    const parameterNotes = [
      {
        parameter: "recipient",
        supported: false,
        detail:
          "MolePositions.open has no owner/recipient argument — the position owner is msg.sender, so a " +
          "phished approval cannot open a position that pays elsewhere. Send every transaction below " +
          `from ${recipient}; ownership cannot be redirected to another address.`,
      },
      {
        parameter: "fee",
        supported: true,
        detail:
          `The live pool key carries the v4 dynamic-fee flag 0x800000 (${DYNAMIC_FEE_FLAG}), not a static ` +
          `tier; MoleHook sets the LP fee per swap. fee=${feeNum} was accepted as a label for this pool.`,
      },
      {
        parameter: "tickLower / tickUpper",
        supported: true,
        detail:
          `The documented "full range" default is impossible here — the vault enforces a range width in ` +
          `[${minRangeWidth}, ${maxRangeWidth}] ticks. Default used: a ${halfDefault * 2}-tick range centred on the ` +
          `current tick (${currentTick}).` +
          (snapped ? " Supplied ticks were snapped to the pool's 60-tick spacing." : ""),
      },
      {
        parameter: "slippageBps",
        supported: true,
        detail:
          "Applied as a haircut on the DECLARED liquidity (amount0Max/amount1Max stay at the amounts you " +
          "asked for), which is what protects an open() against the tick moving before it lands.",
      },
    ];

    return apiResponse({
      type: "add_liquidity",
      description: `Add two-sided liquidity to the WETH/USDG v4 pool via MolePositions.open`,
      venue: {
        protocol: "Uniswap v4 (MoleSwap ALM)",
        vault: VAULT,
        poolManager: CONTRACTS.POOL_MANAGER,
        hook: LIVE_POOL_KEY.hooks,
        poolId: LIVE_POOL_ID,
        positionManager: null,
        positionManagerNote:
          "No NonfungiblePositionManager is deployed on Robinhood Chain. The position is vault-custodied " +
          "(not an ERC-721) and is read back with positionsOf(owner) / getPosition(id).",
      },
      positionOwner: recipient,
      token0: {
        address: meta0.address,
        symbol: meta0.symbol,
        decimals: meta0.decimals,
        amountDesired: amount0Max.toString(),
        amountDisplay: formatUnitsDisplay(amount0Max, meta0.decimals, meta0.decimals),
      },
      token1: {
        address: meta1.address,
        symbol: meta1.symbol,
        decimals: meta1.decimals,
        amountDesired: amount1Max.toString(),
        amountDisplay: formatUnitsDisplay(amount1Max, meta1.decimals, meta1.decimals),
      },
      fee: LIVE_POOL_KEY.fee,
      feeTier: "dynamic (MoleHook)",
      tickLower,
      tickUpper,
      currentTick,
      rangeWidthTicks: width,
      vaultRangeBounds: { minRangeWidth, maxRangeWidth },
      liquidity: liquidity.toString(),
      liquidityAtQuote: liquidityAtQuote.toString(),
      amount0Max: amount0Max.toString(),
      amount1Max: amount1Max.toString(),
      slippageBps,
      deadline: txDeadline,
      parameterNotes,
      transactions,
      chainId: RH_CHAIN_ID,
      rpc: RH_PUBLIC_RPC_URL,
      note:
        "Send the transactions sequentially from the recipient address, waiting for each to confirm. " +
        "Skip an approval if the existing allowance to MolePositions already covers the cap. " +
        "For a ONE-sided deposit (deposit a single token, the vault swaps half), use zapOpen — see /vault.",
    });
  } catch (err: any) {
    return apiError(err?.message || "Failed to build add-liquidity transaction", 500);
  }
}
