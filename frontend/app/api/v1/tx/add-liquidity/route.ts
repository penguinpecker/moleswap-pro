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
// One-sided deposits share ONE math module with the browser (lib/mole/singleSided) so the range the
// UI previews and the range this route encodes can never drift apart. Only the PURE functions are
// used here — the module's RPC reader is viem-based and this route reads slot0 with ethers itself.
import {
  computeOneSidedRange,
  liquidityForOneSidedAmount,
  buildOneSidedOpenArgs,
  assertStrictlyOneSided,
  type OneSidedPreset,
  type OneSidedSide,
} from "@/lib/mole/singleSided";
// The spot-vs-TWAP rule is shared with the browser deposit card, so the two cannot disagree about what
// "this pool looks manipulated" means. priceAnchor imports neither viem nor ethers nor a client
// component — only the rule crosses; the wire below stays ethers, as the rest of this route is.
import {
  FALLBACK_MAX_TWAP_DEVIATION_TICKS,
  FALLBACK_TWAP_WINDOW_SECONDS,
  judgeAnchor,
  manipulatedMessage,
} from "@/lib/mole/priceAnchor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/tx/add-liquidity — build the calldata that adds liquidity to the live pool.
 *
 * There is no user-facing v3 NonfungiblePositionManager on Robinhood Chain, so there is no `mint` to
 * encode. The two-sided entry point that IS deployed is `MolePositions.open(key, tickLower, tickUpper,
 * liquidity, amount0Max, amount1Max, deadline)` — the same call the create-pool seeding path uses
 * (lib/mole/seedLiquidity.ts, which is client-only; the liquidity math is re-derived here so this
 * server route pulls in no client module). This handler therefore returns real, executable steps:
 * wrap (native input only) → approve × 2 → open.
 *
 * ONE-SIDED DEPOSITS. A request with EXACTLY ONE zero amount plus a range — explicit tickLower AND
 * tickUpper, or a `preset` ("launch" = widest legal 60000-tick width, "tight" ≈ 300 ticks, or
 * { widthTicks: N }) — is a VALID single-token deposit: the range is placed strictly beyond the
 * current tick on the deposit token's side (nonzero amount0 → range ABOVE spot, funded by token0
 * only; nonzero amount1 → range BELOW spot, funded by token1 only — Uniswap v4 semantics), and the
 * response is ONE approval plus the open(), with the off side's amountMax hard-coded to 0 so a
 * range that straddles spot REVERTS instead of pulling both tokens. A zero leg WITHOUT a range is
 * still a 400 — the route will not guess which side of spot you meant. Requests with both legs > 0
 * behave exactly as before.
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
 *
 * THE PRICE THIS ROUTE TRUSTS. Every number here used to come from `slot0`. That is the pool's
 * instantaneous price — the one number an ordering-privileged party moves for free, and on a chain
 * whose deepest pool is a few tens of thousands of dollars, holding a skew for a block costs almost
 * nothing. A caller who hit this route inside such a window received calldata that minted their funds
 * at a price someone else had just chosen, with every bound in the response agreeing with the
 * manipulation because it had been computed FROM it. The anchor is now MoleHook's time-averaged tick,
 * which a swap in the same transaction cannot move; spot is still read, but only to be judged against
 * it, and a pool whose spot has walked past the vault's own `maxTwapDeviationTicks` gets a 409 instead
 * of calldata. Same rule, same copy, same constants as the browser deposit card — see
 * lib/mole/priceAnchor.ts.
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
  "function maxTwapDeviationTicks() view returns (int24)",
  "function twapWindow() view returns (uint32)",
];

/** MoleHook is the pool's hook AND its first-party TWAP oracle. `consult` is the anchor read. */
const HOOK_ORACLE_ABI = ["function consult(bytes32 id, uint32 secondsAgo) view returns (int24)"];

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

/**
 * Parse the optional one-sided `preset` body field. Accepted shapes:
 *   "launch" | "tight" | { widthTicks: <positive int> } | <positive int> (shorthand for widthTicks).
 */
function parsePreset(raw: unknown): { value?: OneSidedPreset; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (raw === "launch" || raw === "tight") return { value: raw };
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return { value: { widthTicks: raw } };
  if (
    typeof raw === "object" &&
    Number.isInteger((raw as any).widthTicks) &&
    (raw as any).widthTicks > 0
  ) {
    return { value: { widthTicks: (raw as any).widthTicks as number } };
  }
  return { error: `preset must be "launch", "tight", or { widthTicks: <positive integer> }` };
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
    // Zero legs. Exactly ONE zero amount + a range (explicit ticks or a preset) is a valid ONE-SIDED
    // deposit, handled below. A zero leg with no range, or two zero legs, is still a 400.
    const zero0 = amt0.value === BigInt(0);
    const zero1 = amt1.value === BigInt(0);
    const oneSidedRequest = zero0 !== zero1;
    if (zero0 && zero1) {
      return apiError(
        "Both amount0Desired and amount1Desired are zero — nothing to deposit. Pass both legs for a " +
          "two-sided open, or exactly one leg plus a range (tickLower + tickUpper, or `preset`) for a " +
          "one-sided open.",
        400,
      );
    }
    const preset: { value?: OneSidedPreset; error?: string } = oneSidedRequest
      ? parsePreset(body?.preset)
      : {};
    if (preset.error) return apiError(preset.error, 400);
    const hasExplicitRange = isInt(tickLowerIn) && isInt(tickUpperIn);
    if (oneSidedRequest && !hasExplicitRange && preset.value === undefined) {
      return apiError(
        "One amount is zero — that is a valid ONE-SIDED deposit, but it needs a range. Pass BOTH " +
          "tickLower and tickUpper (a range entirely beyond the current tick on the deposit token's " +
          `side), or a \`preset\`: "launch" (widest allowed width), "tight" (~300 ticks just beyond ` +
          "spot), or { widthTicks: N }. The deposit token is the one with the nonzero amount: " +
          "amount0 → the range sits ABOVE the current price, amount1 → BELOW it. With both amounts " +
          "> 0 this endpoint builds the usual two-sided open.",
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

    const [whitelisted, minRangeWidth, maxRangeWidth, minPosLiq, maxPosLiq, maxDevTicks, twapWindow] =
      await Promise.all([
        vault.isWhitelisted(LIVE_POOL_ID).then((v: boolean) => v).catch(() => true),
        vault.minRangeWidth().then((v: bigint) => Number(v)).catch(() => FALLBACK_MIN_RANGE_WIDTH),
        vault.maxRangeWidth().then((v: bigint) => Number(v)).catch(() => FALLBACK_MAX_RANGE_WIDTH),
        vault.minPositionLiquidity().then((v: bigint) => BigInt(v)).catch(() => BigInt(0)),
        vault.maxPositionLiquidity().then((v: bigint) => BigInt(v)).catch(() => BigInt(0)),
        // A vault that reports ZERO has its own gate switched off. On this side of the wire zero must
        // NOT read as "no limit" — a disabled on-chain gate is exactly when the client one has to bind.
        vault
          .maxTwapDeviationTicks()
          .then((v: bigint) => Number(v))
          .catch(() => FALLBACK_MAX_TWAP_DEVIATION_TICKS),
        vault.twapWindow().then((v: bigint) => Number(v)).catch(() => FALLBACK_TWAP_WINDOW_SECONDS),
      ]);

    if (!whitelisted) {
      return apiError(
        `The WETH/USDG v4 pool (${LIVE_POOL_ID}) is not whitelisted by the vault right now — open() would revert.`,
        409,
      );
    }

    /* ─────────────────────────── the anchor, and the refusal ─────────────────────────── */

    // EVERY NUMBER BELOW USED TO BE DERIVED FROM slot0 ALONE: the default range was centred on the
    // instantaneous tick and the declared liquidity was priced at it. slot0 is the one price an
    // ordering-privileged party sets for free — on a chain where the deepest pool is a few tens of
    // thousands of dollars, holding a skew for a block is cheap — so a caller who hit this route inside
    // that window got calldata that minted their funds at a price someone else chose, and every bound in
    // the response agreed with the manipulation because it was computed from it.
    //
    // The anchor is MoleHook's time-averaged tick, which a swap in the same transaction cannot move
    // (`_write` advances the cumulative by `elapsed * lastTick`, and `elapsed` is zero for a
    // same-timestamp swap). Spot is still read — as the thing being JUDGED. If the two disagree by more
    // than the vault's own `maxTwapDeviationTicks`, this route refuses to build anything at all: handing
    // back correctly-bounded calldata for a pool we distrust just means the caller pays gas to revert.
    let twapTick: number;
    try {
      const hookOracle = new ethers.Contract(LIVE_POOL_KEY.hooks, HOOK_ORACLE_ABI, provider);
      twapTick = Number(await hookOracle.consult(LIVE_POOL_ID, twapWindow));
      if (!Number.isInteger(twapTick)) throw new Error(`consult returned ${String(twapTick)}`);
    } catch (e: any) {
      // NO FALLBACK TO SPOT. A missing anchor is the one case where reaching for slot0 would rebuild
      // exactly the defect this block removes.
      return apiError(
        `Could not read the pool's time-averaged price from MoleHook (${LIVE_POOL_KEY.hooks}): ` +
          `${e?.message || "consult reverted"}. There is nothing honest to price a deposit against, so no ` +
          "calldata was built.",
        503,
      );
    }
    const anchorVerdict = judgeAnchor(currentTick, twapTick, maxDevTicks);
    if (anchorVerdict.manipulated) {
      return apiError(manipulatedMessage(anchorVerdict), 409);
    }
    const twapSqrtPriceX96 = getSqrtRatioAtTick(twapTick);

    /* ─────────────────────────────── one-sided deposit path ─────────────────────────────── */

    if (oneSidedRequest) {
      // The deposit token is the leg with the nonzero amount, in the POOL's currency order
      // (the caller may have passed token0/token1 in either order; legs are already mapped).
      const side: OneSidedSide = leg0.amount > BigInt(0) ? "token0" : "token1";
      const onLeg = side === "token0" ? leg0 : leg1;
      const onMeta = side === "token0" ? meta0 : meta1;
      const offMeta = side === "token0" ? meta1 : meta0;

      // The range: from the preset (computed strictly beyond the live tick, snapped, clamped into
      // the vault's width band), or the caller's explicit ticks (snapped, then REQUIRED to be
      // strictly one-sided for this side at the live tick — never silently nudged across spot).
      //
      // THIS ONE STAYS SPOT-RELATIVE, and it is the one place in this route where that is correct.
      // "One-sided" is not a price opinion, it is a v4 fact: a range funded by token0 alone is one that
      // lies strictly above the CURRENT tick, and placing it relative to the TWAP instead would produce
      // a range that straddles spot and pulls both tokens — the exact bug the off-side cap of 0 exists
      // to make impossible. The protection against a walked spot is the deviation gate above, which has
      // already refused this request if spot and the TWAP disagree.
      let osTickLower: number;
      let osTickUpper: number;
      try {
        if (preset.value !== undefined) {
          const r = computeOneSidedRange({
            side,
            currentTick,
            tickSpacing: TICK_SPACING,
            preset: preset.value,
          });
          osTickLower = r.tickLower;
          osTickUpper = r.tickUpper;
        } else {
          osTickLower = snapToSpacing(tickLowerIn as number);
          osTickUpper = snapToSpacing(tickUpperIn as number);
          if (osTickLower >= osTickUpper) return apiError("tickLower must be strictly below tickUpper", 400);
          const w = osTickUpper - osTickLower;
          if (w < minRangeWidth || w > maxRangeWidth) {
            return apiError(
              `Range width ${w} ticks is outside the vault's bounds [${minRangeWidth}, ${maxRangeWidth}] and ` +
                "open() would revert with RangeWidthOutOfBounds.",
              400,
            );
          }
          assertStrictlyOneSided(side, currentTick, { tickLower: osTickLower, tickUpper: osTickUpper });
        }
      } catch (e: any) {
        return apiError(
          `Not a valid one-sided range for a ${onMeta.symbol} deposit: ${e?.message || "range error"}. ` +
            (side === "token0"
              ? `A ${onMeta.symbol} (token0) deposit needs its whole range STRICTLY ABOVE the current tick (${currentTick}).`
              : `A ${onMeta.symbol} (token1) deposit needs its whole range at or BELOW the current tick (${currentTick}).`) +
            " Omit tickLower/tickUpper and pass a `preset` to have the range placed for you.",
          400,
        );
      }

      // Liquidity from the single amount — floored, so the pool can never pull more than stated (+1
      // wei of v4 round-up headroom, which the on-side cap includes).
      let osLiquidity: bigint;
      try {
        osLiquidity = liquidityForOneSidedAmount({
          side,
          tickLower: osTickLower,
          tickUpper: osTickUpper,
          amount: onLeg.amount,
        });
      } catch (e: any) {
        return apiError(
          `${e?.message || "liquidity error"} — increase ${onLeg.field} or narrow the range.`,
          400,
        );
      }
      if (minPosLiq !== BigInt(0) && osLiquidity < minPosLiq) {
        return apiError(
          `Position too small: ${osLiquidity.toString()} liquidity is below the vault's minPositionLiquidity ` +
            `(${minPosLiq.toString()}). Increase the deposit amount or narrow the range.`,
          400,
        );
      }
      if (maxPosLiq !== BigInt(0) && osLiquidity > maxPosLiq) {
        return apiError(
          `Position too large: ${osLiquidity.toString()} liquidity exceeds the vault's maxPositionLiquidity ` +
            `(${maxPosLiq.toString()}). Reduce the deposit amount or widen the range.`,
          400,
        );
      }

      // The exact open() argument tuple, from the shared module: on-side cap = amount + 1 wei of
      // round-up headroom, OFF-SIDE CAP = 0 — the construction that makes a straddle revert.
      const osArgs = buildOneSidedOpenArgs({
        key: LIVE_POOL_KEY,
        side,
        range: { tickLower: osTickLower, tickUpper: osTickUpper },
        liquidity: osLiquidity,
        amount: onLeg.amount,
        deadline: BigInt(txDeadline),
      });
      const osAmount0Max = osArgs[4];
      const osAmount1Max = osArgs[5];
      const onSideMax = side === "token0" ? osAmount0Max : osAmount1Max;

      const osTxs: any[] = [];
      const osWethIface = new ethers.Interface(WETH_DEPOSIT_ABI);
      const osErc20Iface = new ethers.Interface(ERC20_APPROVE_ABI);
      const osVaultIface = new ethers.Interface(VAULT_ABI);

      // 1. wrap — only when the deposit leg was handed to us as native ETH. Wrap the CAP, not the
      //    stated amount, so the +1 wei of round-up headroom is funded too.
      if (onLeg.wasNative) {
        osTxs.push({
          to: WETH.address,
          value: onSideMax.toString(),
          data: osWethIface.encodeFunctionData("deposit"),
          description: `Wrap ${formatUnitsDisplay(onSideMax, WETH.decimals, 6)} ETH → WETH (1:1)`,
        });
      }

      // 2. approve — ONE token only. The off side needs no approval: its cap is 0.
      osTxs.push({
        to: onMeta.address,
        value: "0",
        data: osErc20Iface.encodeFunctionData("approve", [VAULT, onSideMax]),
        description: `Approve ${formatUnitsDisplay(onSideMax, onMeta.decimals, 6)} ${onMeta.symbol} to MolePositions`,
      });

      // 3. open — the one-sided mint.
      const osKey = [
        LIVE_POOL_KEY.currency0,
        LIVE_POOL_KEY.currency1,
        LIVE_POOL_KEY.fee,
        LIVE_POOL_KEY.tickSpacing,
        LIVE_POOL_KEY.hooks,
      ];
      osTxs.push({
        to: VAULT,
        value: "0",
        data: osVaultIface.encodeFunctionData("open", [
          osKey,
          osTickLower,
          osTickUpper,
          osLiquidity,
          osAmount0Max,
          osAmount1Max,
          txDeadline,
        ]),
        description:
          `MolePositions.open — mint ${osLiquidity.toString()} liquidity over ticks ` +
          `[${osTickLower}, ${osTickUpper}] funded by ${onMeta.symbol} only`,
        note: `MUST be sent from ${recipient} — open() credits the position to msg.sender and has no recipient argument.`,
      });

      const osParameterNotes = [
        {
          parameter: "recipient",
          supported: false,
          detail:
            "MolePositions.open has no owner/recipient argument — the position owner is msg.sender, so a " +
            "phished approval cannot open a position that pays elsewhere. Send every transaction below " +
            `from ${recipient}; ownership cannot be redirected to another address.`,
        },
        {
          parameter: side === "token0" ? "amount1Desired" : "amount0Desired",
          supported: true,
          detail:
            `Zero — this is a ONE-SIDED ${onMeta.symbol} deposit. ${offMeta.symbol}'s amountMax in the ` +
            "open() calldata is 0, so if the price moved into the range before the transaction landed, " +
            `the open would need ${offMeta.symbol} and REVERTS instead of pulling it.`,
        },
        {
          parameter: "tickLower / tickUpper / preset",
          supported: true,
          detail:
            (preset.value !== undefined
              ? `Range placed from the preset: ticks [${osTickLower}, ${osTickUpper}], `
              : `Supplied ticks snapped to the pool's ${TICK_SPACING}-tick spacing: [${osTickLower}, ${osTickUpper}], `) +
            (side === "token0"
              ? `entirely ABOVE the current tick (${currentTick}) — funded by ${onMeta.symbol} (token0) only. `
              : `entirely at or BELOW the current tick (${currentTick}) — funded by ${onMeta.symbol} (token1) only. `) +
            `Width ${osTickUpper - osTickLower} ticks, inside the vault's [${minRangeWidth}, ${maxRangeWidth}] band.`,
        },
        {
          parameter: "slippageBps",
          supported: false,
          detail:
            "Not applied to a one-sided open: the amount a fully out-of-range position needs is " +
            "price-independent, and the zero off-side cap already makes any straddle revert.",
        },
      ];

      return apiResponse({
        type: "add_liquidity",
        depositMode: "one-sided",
        side,
        description: `Add ONE-SIDED ${onMeta.symbol} liquidity to the WETH/USDG v4 pool via MolePositions.open`,
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
        depositToken: {
          address: onMeta.address,
          symbol: onMeta.symbol,
          decimals: onMeta.decimals,
          amountDesired: onLeg.amount.toString(),
          amountDisplay: formatUnitsDisplay(onLeg.amount, onMeta.decimals, onMeta.decimals),
        },
        fee: LIVE_POOL_KEY.fee,
        feeTier: "dynamic (MoleHook)",
        tickLower: osTickLower,
        tickUpper: osTickUpper,
        currentTick,
        twapTick,
        twapWindowSeconds: twapWindow,
        twapDeviationTicks: anchorVerdict.deviationTicks,
        maxTwapDeviationTicks: anchorVerdict.maxDeviationTicks,
        rangeWidthTicks: osTickUpper - osTickLower,
        vaultRangeBounds: { minRangeWidth, maxRangeWidth },
        liquidity: osLiquidity.toString(),
        amount0Max: osAmount0Max.toString(),
        amount1Max: osAmount1Max.toString(),
        preset: preset.value ?? null,
        deadline: txDeadline,
        parameterNotes: osParameterNotes,
        transactions: osTxs,
        chainId: RH_CHAIN_ID,
        rpc: RH_PUBLIC_RPC_URL,
        note:
          "Send the transactions sequentially from the recipient address, waiting for each to confirm. " +
          "Skip the approval if the existing allowance to MolePositions already covers the cap. " +
          `This position sits entirely ${side === "token0" ? "ABOVE" : "BELOW"} the current price and ` +
          `earns nothing until the price ${side === "token0" ? "rises" : "falls"} into its range; it is ` +
          `funded by ${onMeta.symbol} alone and can never pull ${offMeta.symbol}.`,
      });
    }

    /* ──────────────────────────────────── the range ──────────────────────────────────── */

    // CENTRED ON THE TWAP, NOT SPOT. The range decides which side of the market the deposit lands on;
    // centring it on a walked tick hands that choice to whoever walked it. Spot is within
    // `maxTwapDeviationTicks` of the TWAP by now (the gate above), so a 30 000-tick range still
    // straddles the live price comfortably.
    const center = snapToSpacing(twapTick);
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
    // THE BINDING PRICE, not the convenient one. The mint executes at spot, so the declared liquidity
    // has to be fundable there; but a spot the caller distrusts must never be able to INFLATE what they
    // declare. Taking the smaller of the two valuations means the number is fundable at whichever of
    // spot and the TWAP is worse for the caller, and a walked spot can only ever shrink the position,
    // never enlarge it. Inside the deviation gate the two are within 6.18% of each other anyway.
    const liquidityAtSpot = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, amount0Max, amount1Max);
    const liquidityAtTwap = getLiquidityForAmounts(twapSqrtPriceX96, sqrtLower, sqrtUpper, amount0Max, amount1Max);
    const liquidityAtQuote = liquidityAtSpot < liquidityAtTwap ? liquidityAtSpot : liquidityAtTwap;
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
          `pool's TIME-AVERAGED tick (${twapTick}), not on spot (${currentTick}) — spot is the number an ` +
          `ordering-privileged party sets for free, so it is judged here, never used to place a range.` +
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
      // The anchor, echoed: the tick every bound above was derived from, spot's distance from it, and
      // the band that would have refused the request.
      twapTick,
      twapWindowSeconds: twapWindow,
      twapDeviationTicks: anchorVerdict.deviationTicks,
      maxTwapDeviationTicks: anchorVerdict.maxDeviationTicks,
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
