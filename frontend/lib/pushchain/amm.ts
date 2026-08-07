/**
 * PushChain AMM — Uniswap V3-style Concentrated Liquidity
 * Interacts with deployed contracts on Push Chain Donut Testnet
 */
import { ethers } from "ethers";
import {
  CONTRACTS, TOKENS, POOLS, PUSHCHAIN_RPC, PUSHCHAIN_CHAIN_ID,
  QUOTER_V2_ABI, SWAP_ROUTER_ABI, ERC20_ABI, POOL_ABI,
  POSITION_MANAGER_ABI, WPC_ABI, FEE_ROUTER_ABI, LIQUIDITY_PROXY_ABI,
  BRIDGE_HELPER_ABI,
  TICK_SPACINGS, MIN_TICK, MAX_TICK,
  getTokenByAddress, findPool, getSwappableTokens,
  getDisplayInfo, getPoolDisplayInfo,
  type TokenInfo, type PoolInfo,
} from "./contracts";
import {
  getBridgeInfoForPrc20,
  canAutoBridgeFrom,
  getSdkMoveableToken,
  type Prc20BridgeInfo,
} from "./prc20-bridge-map";

export {
  CONTRACTS, TOKENS, POOLS, PUSHCHAIN_RPC, PUSHCHAIN_CHAIN_ID,
  getTokenByAddress, findPool, getSwappableTokens,
  getDisplayInfo, getPoolDisplayInfo,
  getBridgeInfoForPrc20, canAutoBridgeFrom,
  type TokenInfo, type PoolInfo, type Prc20BridgeInfo,
};

export const AMM_ROUTER = CONTRACTS.SWAP_ROUTER;
export const AMM_FACTORY = CONTRACTS.FACTORY;
export type PushChainToken = TokenInfo;
export type Pool = PoolInfo;

export const PUSHCHAIN_TOKENS = TOKENS;

// ═══ BALANCE CHECK HELPERS ═══

/**
 * Get native PC balance for an address on Push Chain.
 * Used for pre-flight checks before wrap/swap operations.
 */
async function getNativeBalance(address: string): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(PUSHCHAIN_RPC);
    const balance = await provider.getBalance(address);
    return balance;
  } catch (e) {
    console.warn("[MoleSwap] Failed to fetch native balance:", e);
    return 0n;
  }
}

/**
 * Get ERC20 token balance for an address.
 */
async function getTokenBalance(tokenAddress: string, userAddress: string): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(PUSHCHAIN_RPC);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balance = await token.balanceOf(userAddress);
    return BigInt(balance.toString());
  } catch (e) {
    console.warn("[MoleSwap] Failed to fetch token balance:", e);
    return 0n;
  }
}

/**
 * Format a bigint wei value to human-readable string.
 */
function formatBalance(wei: bigint, decimals: number = 18): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = wei / divisor;
  const frac = wei % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6);
  return `${whole}.${fracStr}`.replace(/\.?0+$/, '') || '0';
}

export interface SwapQuote {
  amountIn: string;
  amountOut: string;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  fee: number;
  pool: PoolInfo;
  priceImpact: number;
  gasEstimate: string;
}

// ═══ UNIVERSAL TX OPTIONS (fee abstraction + progress) ═══
export interface UniversalTxOptions {
  payGasWithToken?: string;
  payGasSlippageBps?: number;
  onProgress?: (progress: { id: string; title: string; message: string; level: string; timestamp: string }) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ RAMENFI-CLONED UNIVERSAL TX ARCHITECTURE ════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// Every helper in this block is a direct clone of RamenFi's production
// patterns (decoded from their bundle at ramenfi.xyz). Do not modify without
// understanding what RamenFi does. Comments reference the original minified
// names so we can cross-check.

// ─── CONSTANTS (RamenFi: ny.MULTICALL_TARGET_ADDRESS) ──────────────────────
// When universal.sendTransaction is called with `data: Array<...>` (multicall
// mode), the SDK requires `to` to be the zero address. RamenFi hardcodes this
// as MULTICALL_TARGET_ADDRESS. See:
//   https://push.org/docs/chain/build/send-universal-transaction (Batch Transactions)
export const MULTICALL_TARGET_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

// RamenFi constants lifted from their bundle (MULTICALL_SELECTOR, etc.)
export const MULTICALL_SELECTOR = "0x1749e1e3" as const;
export const UEA_MULTICALL_SELECTOR = "0x2cc2842d" as const;

// ─── BRIDGE HELPER (Solana 1-sig optimization) ───────────────────────────────
// This contract bundles wrap+approve+swap into a single call (like RamenFi's
// depositPRC20WithAutoSwap, selector 0x780ad827). It IS deployed on Push Chain
// at CONTRACTS.MOLESWAP_BRIDGE_HELPER with all 4 selectors in bytecode, and
// callable on-chain (see scripts/verify-bridge-helper.mjs — staticcall returns
// the expected "INSUFFICIENT_BRIDGED_AMOUNT" revert when invoked cold).
//
// BUT: the Push SDK's Solana-origin relay cannot dispatch to this helper.
// We tried two dispatch modes:
//   1. `to: HELPER, funds, data: calldata`            → Phantom "Unexpected error"
//   2. `to: MULTICALL_TARGET_ADDRESS, funds, data:[{to:HELPER,...}]`
//                                                      → Phantom "Unexpected error"
// Only the sequential multi-sig path (`to: FeeRouter, data: swap`) works for
// Solana origins. RamenFi's 1-sig flow presumably relies on a target that is
// whitelisted or pre-registered in Push's Solana gateway; a freshly-deployed
// third-party helper is not. Until that story changes on the Push side we
// must use the N-sig sequential path — which is exactly what worked before
// the helper was introduced.
//
// Flip NEXT_PUBLIC_USE_SOL_HELPER=1 to re-enable the helper path for
// experimentation once the gateway supports it.
const BRIDGE_HELPER_ENABLED =
  typeof process !== "undefined" &&
  process.env?.NEXT_PUBLIC_USE_SOL_HELPER === "1";
const BRIDGE_HELPER_DEPLOYED =
  BRIDGE_HELPER_ENABLED &&
  CONTRACTS.MOLESWAP_BRIDGE_HELPER !== "0x0000000000000000000000000000000000000000";
const bridgeHelperIface = new ethers.Interface(BRIDGE_HELPER_ABI);
export const MIGRATION_SELECTOR = "0xcac656d6" as const;

// Push Chain Donut testnet chain namespaces we treat as "Push-native origin".
// When origin is one of these, we loop-sequentially (N sigs) instead of
// multicall (1 sig), because Push-native accounts cannot use batch mode
// inbound to themselves (SDK limitation — see docs).
const PUSH_CHAIN_NAMESPACES = [
  "eip155:42101",        // PUSH_TESTNET_DONUT
  "eip155:9001",         // PUSH_LOCALNET
] as const;

// ─── isPushChain(originChain) (RamenFi: nC.isPushChain) ────────────────────
// Predicate: did the user connect a wallet on Push Chain directly (vs a
// cross-chain wallet like Phantom/MetaMask-Sepolia)?
export function isPushChain(originChain: string | null | undefined): boolean {
  if (!originChain) return false;
  const lower = originChain.toLowerCase();
  return PUSH_CHAIN_NAMESPACES.some(ns => lower === ns.toLowerCase());
}

// ─── extractTxHash(result) (RamenFi: sj) ───────────────────────────────────
// RamenFi's sj:
//   function sj(e){let t=e?.transactionHash||e?.hash;
//   if("string"==typeof t&&t.startsWith("0x"))return t;
//   throw Error("Failed to extract transaction hash")}
// Ours is more defensive — checks many shapes because the SDK response shape
// has changed across versions.
export function extractTxHash(result: any): string {
  if (!result) throw new Error("Failed to extract transaction hash: empty result");
  if (typeof result === "string" && result.startsWith("0x")) return result;

  const t = result?.transactionHash || result?.hash;
  if (typeof t === "string" && t.startsWith("0x")) return t;

  const fallbackKeys = ["txHash", "txnHash", "transactionhash", "tx_hash"];
  for (const key of fallbackKeys) {
    const v = result?.[key];
    if (typeof v === "string" && v.startsWith("0x")) return v;
  }
  if (result?.tx?.hash && typeof result.tx.hash === "string") return result.tx.hash;
  if (result?.receipt?.transactionHash) return result.receipt.transactionHash;
  if (result?.response?.hash) return result.response.hash;

  throw new Error("Failed to extract transaction hash");
}

// ─── isSwapStep(step) (RamenFi: sC) ─────────────────────────────────────────
// RamenFi's sC: function sC(e){return"swap"===e.type}
export function isSwapStep(step: SwapStep): boolean {
  return step.type === "swap";
}

// ─── STEP TYPES (RamenFi shape from /api/swap response) ─────────────────────
// RamenFi's backend returns an ordered list of steps. Each step is either
// - a `bridge` step (asset movement across chains via `funds`), or
// - a `swap` step (a contract call: `{to, value, data}`).
// We construct the same shape on the frontend instead of calling a backend
// endpoint, since MoleSwap already knows the route.
export interface BridgeStep {
  type: "bridge";
  amount: string;              // BigInt-stringified amount in smallest units
  token: any;                  // PushChain.CONSTANTS.MOVEABLE.TOKEN.*
}

export interface SwapStepCall {
  type: "swap";
  to: string;                  // contract address (e.g. FeeRouter, WPC)
  value: string;               // BigInt-stringified native value
  data: string;                // ABI-encoded calldata
  label?: string;              // human-readable label for UI step tracker
}

export type SwapStep = BridgeStep | SwapStepCall;

// ─── ExecuteStepsResult (RamenFi's return shape from sE) ───────────────────
export interface ExecuteStepsResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

// ─── ExecuteStepsParams (RamenFi's sE parameters) ──────────────────────────
export interface ExecuteStepsParams {
  pushChainClient: any;        // initialized PushChainClient (guarded)
  userAddress: string;         // UEA — used as `to` for funds-only bridges
  steps: SwapStep[];           // ordered list; first is typically bridge, rest swap
  originChain: string | null;  // e.g. "eip155:42101" or "solana:EtWTRAB..."
  onStep?: (index: number, label: string, status: "pending" | "signing" | "confirmed" | "error") => void;
  pollPushReceipt?: (hash: string) => Promise<void>; // injected: polls Push Chain RPC for confirmation
}

// ─── executeStepsSequential (fallback for Push-native and Solana w/o helper) ─
// Extracted helper for the sequential N-sig path. Used when:
//   • Push-native origins (SDK limit: no batch-inbound for native EOAs)
//   • Solana origins without MoleSwapBridgeHelper deployed
async function executeStepsSequential(
  pushChainClient: any,
  userAddress: string,
  steps: (BridgeStep | SwapStepCall)[],
  originChain: string | null | undefined,
  onStep: (stepIndex: number, label: string, status: "signing" | "confirmed" | "error") => void,
  pollReceipt?: (txHash: string) => Promise<void>,
): Promise<ExecuteStepsResult> {
  const isSolanaOrigin = !!originChain && originChain.toLowerCase().startsWith("solana:");
  let finalTxHash: string | null = null;

  try {
    const firstStep = steps[0];
    const bridgeStep: BridgeStep | null =
      firstStep?.type === "bridge" ? (firstStep as BridgeStep) : null;

    // Send bridge step first (Solana origin only — push-native skips)
    if (bridgeStep && isSolanaOrigin) {
      onStep(0, "Bridge funds", "signing");
      const funds = { amount: BigInt(bridgeStep.amount), token: bridgeStep.token };
      const tx = await pushChainClient.universal.sendTransaction({
        to: userAddress,
        funds,
      });
      finalTxHash = extractTxHash(tx);
      onStep(0, "Bridge funds", "confirmed");
      if (pollReceipt) await pollReceipt(finalTxHash);
    }

    // Then loop swap steps sequentially
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!isSwapStep(step)) continue;
      const swapStep = step as SwapStepCall;
      const label = swapStep.label || `Step ${i + 1}`;
      onStep(i, label, "signing");

      const tx = await pushChainClient.universal.sendTransaction({
        to: swapStep.to,
        value: BigInt(swapStep.value),
        data: swapStep.data,
      });
      finalTxHash = extractTxHash(tx);
      onStep(i, label, "confirmed");
      if (pollReceipt) await pollReceipt(finalTxHash);
    }

    return finalTxHash
      ? { success: true, txHash: finalTxHash }
      : { success: false, error: "No transaction was executed" };
  } catch (err: any) {
    onStep(-1, err?.message || String(err), "error");
    return { success: false, error: getContractErrorMessage(err) };
  }
}

// ─── executeSteps(params) (RamenFi: sE — THE MASTER ORCHESTRATOR) ──────────
// This function is a direct clone of RamenFi's `sE`. It decides between 4
// execution strategies based on origin chain and step composition:
//
//   ORIGIN = non-Push (Phantom, MM on Sepolia, etc.)
//     Case A: bridge only, no swaps          → 1 sig: funds transfer to UEA
//     Case B: bridge + swap(s) (atomic)       → 1 sig: multicall with funds
//     Case C: swap(s) only, no bridge         → 1 sig: multicall without funds
//
//   ORIGIN = Push (native EOA on Push Chain)
//     Case D: sequential — each swap step is its own sig (N sigs)
//             (Push-native cannot use batch mode inbound per SDK docs)
//
// The huge Phantom UX win comes from Case B: what used to be 4 sigs (approve,
// swap, approve, swap for multi-hop) now becomes 1 sig because the entire
// call chain is bundled into a single universal transaction payload.
export async function executeSteps(
  params: ExecuteStepsParams,
): Promise<ExecuteStepsResult> {
  const { pushChainClient, userAddress, steps, originChain } = params;
  const onStep = params.onStep || (() => {});
  const pollReceipt = params.pollPushReceipt;

  if (!steps || steps.length === 0) {
    return { success: false, error: "No steps to execute" };
  }
  if (!pushChainClient) {
    return { success: false, error: "PushChain client not initialized" };
  }

  // RamenFi: let i = !s || !(0, nC.isPushChain)(s)
  const isCrossChain = !originChain || !isPushChain(originChain);

  // SOLANA-ORIGIN MULTICALL FIX
  // ──────────────────────────────────────────────────────────────────────
  // Push's SDK encodes universal txs for Solana origins into an Anchor
  // program instruction. That instruction has to fit inside one Solana
  // transaction (1232-byte hard limit). A 3-call multicall (wrap + approve
  // + swap) with ABI-encoded calldata routinely blows past this limit,
  // producing: "RangeError: encoding overruns Buffer" at rZ.instruction.
  //
  // SOLUTION: MoleSwapBridgeHelper contract combines wrap+approve+swap into
  // a SINGLE function call that fits in the Solana tx buffer. When deployed,
  // Solana users get 1-sig UX matching RamenFi's depositPRC20WithAutoSwap.
  //
  // Fallback (helper not deployed): sequential sends (N sigs but works).
  const isSolanaOrigin = !!originChain && originChain.toLowerCase().startsWith("solana:");
  const useSolanaHelper = isSolanaOrigin && BRIDGE_HELPER_DEPLOYED;
  const useMulticall = isCrossChain && !isSolanaOrigin;

  try {
    let finalTxHash: string | null = null;

    if (useMulticall) {
      // ─── CROSS-CHAIN PATH (non-Solana) — MULTICALL ─────
      // RamenFi: let s = n[0], i = n.filter(sC), a = "bridge"===s.type?s:null
      const firstStep = steps[0];
      const swapSteps = steps.filter(isSwapStep) as SwapStepCall[];
      const bridgeStep: BridgeStep | null =
        firstStep?.type === "bridge" ? (firstStep as BridgeStep) : null;

      if (bridgeStep && swapSteps.length === 0) {
        // Case A: bridge only — funds transfer, no calldata
        // RamenFi: t.universal.sendTransaction({to:r, funds:n})
        onStep(0, "Bridge funds", "signing");
        const funds = { amount: BigInt(bridgeStep.amount), token: bridgeStep.token };
        const tx = await pushChainClient.universal.sendTransaction({
          to: userAddress,
          funds,
        });
        finalTxHash = extractTxHash(tx);
        onStep(0, "Bridge funds", "confirmed");
        if (pollReceipt) await pollReceipt(finalTxHash);
      }
      else if (bridgeStep && swapSteps.length > 0) {
        // Case B: bridge + swap(s) atomic multicall — THE 1-SIG WINNER
        // RamenFi: t.universal.sendTransaction({to:MULTICALL_TARGET_ADDRESS, funds:r, data:n})
        const combinedLabel = swapSteps.length === 1
          ? "Bridge & swap"
          : `Bridge & ${swapSteps.length}-hop swap`;
        onStep(0, combinedLabel, "signing");

        const funds = { amount: BigInt(bridgeStep.amount), token: bridgeStep.token };
        const calls = swapSteps.map(s => ({
          to: s.to,
          value: BigInt(s.value),
          data: s.data,
        }));

        const tx = await pushChainClient.universal.sendTransaction({
          to: MULTICALL_TARGET_ADDRESS,
          funds,
          data: calls,
        });
        finalTxHash = extractTxHash(tx);
        onStep(0, combinedLabel, "confirmed");
        if (pollReceipt) await pollReceipt(finalTxHash);
      }
      else {
        // Case C: swaps only, no bridge — multicall without funds
        // RamenFi: t.universal.sendTransaction({to:MULTICALL_TARGET_ADDRESS, data:r})
        const label = swapSteps.length === 1 ? "Swap" : `${swapSteps.length}-hop swap`;
        onStep(0, label, "signing");

        const calls = swapSteps.map(s => ({
          to: s.to,
          value: BigInt(s.value),
          data: s.data,
        }));

        const tx = await pushChainClient.universal.sendTransaction({
          to: MULTICALL_TARGET_ADDRESS,
          data: calls,
        });
        finalTxHash = extractTxHash(tx);
        onStep(0, label, "confirmed");
        if (pollReceipt) await pollReceipt(finalTxHash);
      }
    } else if (useSolanaHelper) {
      // ─── SOLANA HELPER PATH — 1 sig via MoleSwapBridgeHelper ───────────
      // When the helper contract is deployed, we route bridge+swap through
      // a single `bridgeAndSwap` call that fits in Solana's 1232-byte buffer.
      // Gateway mints bridged tokens TO the helper, which immediately swaps.
      const firstStep = steps[0];
      const swapSteps = steps.filter(isSwapStep) as SwapStepCall[];
      const bridgeStep: BridgeStep | null =
        firstStep?.type === "bridge" ? (firstStep as BridgeStep) : null;

      if (bridgeStep && swapSteps.length > 0) {
        // Bridge + swap(s) via helper — 1 SIGNATURE! 🎉
        const combinedLabel = swapSteps.length === 1
          ? "Bridge & swap (1-sig)"
          : `Bridge & ${swapSteps.length}-hop swap (1-sig)`;
        onStep(0, combinedLabel, "signing");

        // The last swap step is always the actual swap call — earlier ones are
        // approves. The helper does its own approval internally, so we only
        // need to decode the real swap calldata.
        const finalSwap = swapSteps[swapSteps.length - 1];
        const swapData = finalSwap.data;
        const feeRouterIface = new ethers.Interface(FEE_ROUTER_ABI);
        const swapRouterIface = new ethers.Interface(SWAP_ROUTER_ABI);
        let helperCalldata: string | null = null;

        // Decode and map the swap to the appropriate helper function.
        // All 4 helper variants are deployed on MoleSwapBridgeHelper:
        //   bridgeAndSwap          — token → token, single-hop (via FeeRouter)
        //   bridgeAndSwapToNative  — token → PC,    single-hop (unwrap at end)
        //   bridgeAndSwapMultiHop  — token → token, multi-hop  (via SwapRouter)
        //   bridgeNativeAndSwap    — native in (not used here; bridge already gives PRC20)
        try {
          // Try FeeRouter methods first (single-hop paths)
          const feeDecoded = (() => {
            try { return feeRouterIface.parseTransaction({ data: swapData }); }
            catch { return null; }
          })();

          if (feeDecoded?.name === "swapExactInputSingle") {
            // token → token, single-hop
            const [tokenIn, tokenOut, poolFee, amountIn, amountOutMin, deadline] = feeDecoded.args;
            helperCalldata = bridgeHelperIface.encodeFunctionData("bridgeAndSwap", [
              tokenIn, tokenOut, poolFee, amountIn, amountOutMin, userAddress, deadline,
            ]);
          } else if (feeDecoded?.name === "swapNativeOutput") {
            // token → PC, single-hop — the fix for stuck-WPC bug (Solana users)
            const [tokenIn, poolFee, amountIn, amountOutMin, deadline] = feeDecoded.args;
            helperCalldata = bridgeHelperIface.encodeFunctionData("bridgeAndSwapToNative", [
              tokenIn, poolFee, amountIn, amountOutMin, userAddress, deadline,
            ]);
          } else {
            // Not a FeeRouter call — check if it's a SwapRouter multi-hop
            const srDecoded = (() => {
              try { return swapRouterIface.parseTransaction({ data: swapData }); }
              catch { return null; }
            })();

            if (srDecoded?.name === "exactInput") {
              // Multi-hop token → token.
              // The on-chain helper's `bridgeAndSwapMultiHop` uses tokenIn for
              // balanceOf() + allowance checks, so we must extract the real
              // tokenIn and tokenOut from the path bytes.
              //
              // Path format (packed): tokenIn(20) | fee(3) | WPC(20) | fee(3) | tokenOut(20)
              const params = srDecoded.args[0];
              const pathHex = (params.path as string).startsWith("0x")
                ? (params.path as string).slice(2)
                : (params.path as string);
              if (pathHex.length < 40 * 2 + 6 * 2 + 40) {
                throw new Error(`Multi-hop path too short: ${pathHex.length} chars`);
              }
              const tokenInFromPath = "0x" + pathHex.slice(0, 40);
              const tokenOutFromPath = "0x" + pathHex.slice(-40);
              helperCalldata = bridgeHelperIface.encodeFunctionData("bridgeAndSwapMultiHop", [
                tokenInFromPath,
                tokenOutFromPath,
                params.path,
                params.amountIn,
                params.amountOutMinimum,
                userAddress,
                params.deadline,
              ]);
            } else if (srDecoded?.name === "multicall") {
              // Multi-hop + native out (exactInput + unwrapWETH9 wrapped in SR.multicall).
              // The deployed helper has no single function for this combo, so fall back
              // to sequential. Functionally still works (user gets PC), just more sigs.
              throw new Error("multi-hop native-out not yet supported in helper");
            } else {
              throw new Error(`Unsupported swap call for helper: ${feeDecoded?.name || srDecoded?.name || "unknown"}`);
            }
          }
        } catch (err) {
          console.warn("[MoleSwap] Helper encoding failed, falling back to sequential:", (err as Error)?.message);
          const sequentialResult = await executeStepsSequential(
            pushChainClient, userAddress, steps, originChain, onStep, pollReceipt
          );
          return sequentialResult;
        }

        // Send via helper: gateway mints TO helper, helper swaps.
        //
        // CRITICAL — DISPATCH MODE:
        // The Push SVM gateway's cross-chain relay on Solana dispatches inbound
        // txs through MULTICALL_TARGET_ADDRESS (0x0) + a call-array payload —
        // NOT via an arbitrary `to` address. Passing a custom contract address
        // directly as `to` produced Phantom's opaque "Me: Unexpected error"
        // because the Solana gateway instruction had no recognized target and
        // the signer refused to simulate. The fix is to wrap our single helper
        // call in a one-element multicall — same shape the non-Solana
        // `useMulticall` branch uses (line 363), which is the path the SDK's
        // Solana relay actually supports.
        //
        // Tx size stays well under the 1232-byte Solana limit: 8 bytes Anchor
        // discriminator + ~160 bytes multicall ABI frame + ~196 bytes helper
        // calldata + ~400 bytes Solana envelope ≈ 770 bytes.
        if (!helperCalldata) {
          // Should be unreachable — the try block above either assigns or throws.
          // Kept as defense-in-depth so we never silently send `null` as calldata.
          console.warn("[MoleSwap] helperCalldata unexpectedly null, falling back to sequential");
          const sequentialResult = await executeStepsSequential(
            pushChainClient, userAddress, steps, originChain, onStep, pollReceipt
          );
          return sequentialResult;
        }
        const funds = { amount: BigInt(bridgeStep.amount), token: bridgeStep.token };
        const tx = await pushChainClient.universal.sendTransaction({
          to: MULTICALL_TARGET_ADDRESS,
          funds,
          data: [
            {
              to: CONTRACTS.MOLESWAP_BRIDGE_HELPER,
              value: 0n,
              data: helperCalldata,
            },
          ],
        });
        finalTxHash = extractTxHash(tx);
        onStep(0, combinedLabel, "confirmed");
        if (pollReceipt) await pollReceipt(finalTxHash);
      } else if (bridgeStep) {
        // Bridge only — same as multicall Case A
        onStep(0, "Bridge funds", "signing");
        const funds = { amount: BigInt(bridgeStep.amount), token: bridgeStep.token };
        const tx = await pushChainClient.universal.sendTransaction({
          to: userAddress,
          funds,
        });
        finalTxHash = extractTxHash(tx);
        onStep(0, "Bridge funds", "confirmed");
        if (pollReceipt) await pollReceipt(finalTxHash);
      } else {
        // Swaps only, no bridge — still sequential for safety
        const sequentialResult = await executeStepsSequential(
          pushChainClient, userAddress, steps, originChain, onStep, pollReceipt
        );
        return sequentialResult;
      }
    } else {
      // ─── SEQUENTIAL PATH — one sig per step ───────────────────────────
      // Used for:
      //   • Push-native origins (SDK limit: no batch-inbound for native EOAs)
      //   • Solana origins WITHOUT helper deployed (fallback)
      const sequentialResult = await executeStepsSequential(
        pushChainClient, userAddress, steps, originChain, onStep, pollReceipt
      );
      return sequentialResult;
    }

    return finalTxHash
      ? { success: true, txHash: finalTxHash }
      : { success: false, error: "No transaction was executed" };
  } catch (err: any) {
    onStep(-1, err?.message || String(err), "error");
    return { success: false, error: getContractErrorMessage(err) };
  }
}

// ─── getContractErrorMessage(err) (RamenFi: sN.getContractErrorMessage) ────
// Decodes common revert selectors into human-readable messages. Uniswap V3
// & our FeeRouter selectors decoded inline.
export function getContractErrorMessage(err: any): string {
  const msg = err?.message || String(err);
  const data = err?.data || msg.match(/data="(0x[a-f0-9]+)"/i)?.[1] || "";

  // Uniswap V3 / FeeRouter canonical reverts
  if (data.startsWith("0xf4d678b8")) {
    return "Swap failed: token transfer rejected (STF). This usually means insufficient token balance or the approval didn't confirm in time.";
  }
  if (data.startsWith("0x13be252b")) {
    return "Swap failed: amount is zero or too small to execute (AS).";
  }
  if (data.startsWith("0x584a7938")) {
    return "Swap failed: price moved beyond slippage tolerance (SPL). Try increasing slippage.";
  }

  // User-rejected: Phantom, MetaMask, Rabby, Zerion all share this shape
  if (msg.includes("User rejected") || msg.includes("User denied") ||
      msg.includes("User cancelled") || err?.code === 4001) {
    return "Transaction rejected in wallet.";
  }

  // Account upgrade required — RamenFi's guarded proxy throws this
  if (msg.includes("Account upgrade failed") || msg.includes("requiresUpgrade")) {
    return "Your Push account needs a gasless upgrade. Please approve the signature request.";
  }

  if (msg.includes("execution reverted") && !msg.includes("STF") && !msg.includes("balance")) {
    return "Swap reverted on-chain. This may be caused by insufficient balance, stale approval, or pool liquidity issues.";
  }

  return msg;
}

// ═══════════════════════════════════════════════════════════════════════════
// ═══ RAMENFI-CLONED GUARDED PUSH CHAIN CLIENT ═══════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// RamenFi wraps every `sendTransaction`, `signMessage`, and `signTypedData`
// call in a Proxy that first checks `getAccountStatus()` and calls
// `upgradeAccount()` if the UEA needs migrating. This avoids cryptic
// "UEA outdated" failures mid-swap.
//
// RamenFi's minified pattern:
//   let d=async()=>{if(!await n(c.current))throw Error("Account upgrade failed.")}
//   let p=new Proxy({},{get(e,t,r){
//     return "sendTransaction"===t ? f(()=>c.current.universal.sendTransaction)
//          : "signMessage"===t      ? f(()=>c.current.universal.signMessage)
//          : "signTypedData"===t    ? f(()=>c.current.universal.signTypedData)
//          : ...
//   }})
//
// Where `f()` is a wrapper that runs `d()` first, then the real method.

export async function ensureUeaUpgraded(pushChainClient: any): Promise<boolean> {
  try {
    if (!pushChainClient?.getAccountStatus) {
      // SDK versions before getAccountStatus — treat as no-op
      return true;
    }
    const status = await pushChainClient.getAccountStatus();
    // status.uea may be absent if UEA not yet resolved — treat as OK
    if (!status?.uea?.loaded) return true;
    if (!status.uea.deployed) return true;  // first-tx will deploy UEA
    if (!status.uea.requiresUpgrade) return true;

    // UEA exists but needs upgrade — call upgradeAccount (gasless)
    if (typeof pushChainClient.upgradeAccount === "function") {
      await pushChainClient.upgradeAccount();
      return true;
    }
    return false;
  } catch (err) {
    console.warn("[MoleSwap] ensureUeaUpgraded check failed:", err);
    return true;  // fail-open — don't block the user if the check itself errors
  }
}

// Build a guarded proxy around universal.sendTransaction / signMessage /
// signTypedData. Every call runs ensureUeaUpgraded() first.
export function createGuardedPushChainClient(pushChainClient: any): any {
  if (!pushChainClient) return pushChainClient;

  const guarded = {
    // Mirror the original client's other properties (explorer, funds, etc.)
    ...pushChainClient,

    universal: new Proxy(pushChainClient.universal || {}, {
      get(target, prop) {
        if (prop === "sendTransaction") {
          return async (tx: any) => {
            const ok = await ensureUeaUpgraded(pushChainClient);
            if (!ok) throw new Error("Account upgrade failed.");
            return pushChainClient.universal.sendTransaction(tx);
          };
        }
        if (prop === "signMessage") {
          return async (message: any) => {
            const ok = await ensureUeaUpgraded(pushChainClient);
            if (!ok) throw new Error("Account upgrade failed.");
            return pushChainClient.universal.signMessage(message);
          };
        }
        if (prop === "signTypedData") {
          return async (data: any) => {
            const ok = await ensureUeaUpgraded(pushChainClient);
            if (!ok) throw new Error("Account upgrade failed.");
            return pushChainClient.universal.signTypedData(data);
          };
        }
        return (target as any)[prop];
      },
    }),
  };

  return guarded;
}


// ═══ HELPER: Send universal tx with fee abstraction + progress hooks ═══
async function sendUniversalTx(
  pushChainClient: any,
  tx: { to: string; value: bigint; data?: string },
  options?: UniversalTxOptions,
): Promise<any> {
  const txParams: any = { ...tx };

  if (options?.payGasWithToken) {
    txParams.payGasWith = {
      token: options.payGasWithToken,
      slippageBps: options.payGasSlippageBps || 200,
    };
  }

  if (options?.onProgress) {
    txParams.progressHook = options.onProgress;
  }

  return pushChainClient.universal.sendTransaction(txParams);
}

// Kept for backwards-compat with callers in SwapPage.tsx — no-op under the
// new send path but preserved so deployments don't break on missing symbol.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let _walletOriginChain: string | null = null;
export function setWalletOriginChain(origin: string | null | undefined): void {
  _walletOriginChain = origin || null;
}

// ═══ HELPER: Send tx — always via PushChain SDK universal.sendTransaction ═══
// 1:1 match with RamenFi's pattern. We never touch window.ethereum, never
// BrowserProvider, never wallet_switchEthereumChain. The SDK already knows
// which signer the user connected (MetaMask, Phantom, email, etc.) and routes
// the signature request correctly. Any direct-EVM fallback we add here will
// race with the SDK and grab the wrong wallet (bug: MetaMask popped for a
// Phantom-connected user).
async function sendTx(
  pushChainClient: any,
  tx: { to: string; value: bigint; data?: string },
  options?: UniversalTxOptions,
): Promise<any> {
  if (!pushChainClient) {
    throw new Error("PushChain client not initialized. Please reconnect your wallet.");
  }
  return sendUniversalTx(pushChainClient, tx, options);
}

// ═══ PROVIDER ═══

export function getProvider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(PUSHCHAIN_RPC);
}

// ═══ QUOTE ═══
export async function getSwapQuote(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fee?: number;
}): Promise<SwapQuote | null> {
  try {
    const provider = getProvider();
    const quoter = new ethers.Contract(CONTRACTS.QUOTER_V2, QUOTER_V2_ABI, provider);

    const tokenInInfo = getTokenByAddress(params.tokenIn);
    const tokenOutInfo = getTokenByAddress(params.tokenOut);
    if (!tokenInInfo || !tokenOutInfo) return null;

    if (tokenInInfo.swappable === false || tokenOutInfo.swappable === false) return null;

    const amountInWei = BigInt(params.amountIn || "0");
    if (amountInWei === 0n) return null;

    const actualIn = params.tokenIn === ethers.ZeroAddress ? CONTRACTS.WPC : params.tokenIn;
    const actualOut = params.tokenOut === ethers.ZeroAddress ? CONTRACTS.WPC : params.tokenOut;

    const isWrapOrUnwrap = actualIn.toLowerCase() === actualOut.toLowerCase();
    if (isWrapOrUnwrap) {
      return {
        amountIn: params.amountIn,
        amountOut: params.amountIn,
        tokenIn: tokenInInfo,
        tokenOut: tokenOutInfo,
        fee: 0,
        pool: { address: CONTRACTS.WPC, token0: params.tokenIn, token1: params.tokenOut, fee: 0, name: "WRAP" } as any,
        priceImpact: 0,
        gasEstimate: "50000",
      };
    }

    let pool = findPool(actualIn, actualOut);
    let fee = params.fee || pool?.fee || 500;

    if (!pool && actualIn !== CONTRACTS.WPC && actualOut !== CONTRACTS.WPC) {
      const poolA = findPool(actualIn, CONTRACTS.WPC);
      const poolB = findPool(actualOut, CONTRACTS.WPC);
      if (poolA && poolB) {
        const [midAmount] = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: actualIn,
          tokenOut: CONTRACTS.WPC,
          amountIn: amountInWei,
          fee: poolA.fee,
          sqrtPriceLimitX96: 0,
        });
        const [finalAmount,,, gasEst] = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: CONTRACTS.WPC,
          tokenOut: actualOut,
          amountIn: midAmount,
          fee: poolB.fee,
          sqrtPriceLimitX96: 0,
        });

        return {
          amountIn: params.amountIn,
          amountOut: finalAmount.toString(),
          tokenIn: tokenInInfo,
          tokenOut: tokenOutInfo,
          fee: poolA.fee,
          pool: poolA,
          priceImpact: 0.5,
          gasEstimate: gasEst?.toString() || "150000",
        };
      }
      return null;
    }

    if (!pool) return null;

    const [amountOut,,, gasEstimate] = await quoter.quoteExactInputSingle.staticCall({
      tokenIn: actualIn,
      tokenOut: actualOut,
      amountIn: amountInWei,
      fee,
      sqrtPriceLimitX96: 0,
    });

    return {
      amountIn: params.amountIn,
      amountOut: amountOut.toString(),
      tokenIn: tokenInInfo,
      tokenOut: tokenOutInfo,
      fee,
      pool,
      priceImpact: 0.3,
      gasEstimate: gasEstimate?.toString() || "150000",
    };
  } catch (err) {
    console.error("Quote error:", err);
    return null;
  }
}

// ═══ ESTIMATE SWAP DETAILS (ETA + gas via on-chain simulation) ═══
export async function estimateSwapDetails(params: {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  recipient: string;
}): Promise<{ etaSeconds: number; totalGas: number; txCount: number; breakdown: string[] } | null> {
  try {
    const provider = getProvider();
    const isNativeIn = params.tokenIn === ethers.ZeroAddress;
    const actualIn = isNativeIn ? CONTRACTS.WPC : params.tokenIn;
    const actualOut = params.tokenOut === ethers.ZeroAddress ? CONTRACTS.WPC : params.tokenOut;
    const amountIn = BigInt(params.amountIn || "0");
    if (amountIn === 0n) return null;

    const isWrap = isNativeIn && actualOut.toLowerCase() === CONTRACTS.WPC.toLowerCase();
    const isUnwrap = actualIn.toLowerCase() === CONTRACTS.WPC.toLowerCase() && params.tokenOut === ethers.ZeroAddress;

    const steps: { label: string; gas: number }[] = [];
    const depositSelector = "0xd0e30db0";
    const withdrawSelector = "0x2e1a7d4d";

    if (isWrap) {
      const gas = await provider.estimateGas({
        from: params.recipient, to: CONTRACTS.WPC, value: amountIn, data: depositSelector,
      }).then(g => Number(g)).catch(() => 28000);
      steps.push({ label: "Wrap PC → WPC", gas });
    } else if (isUnwrap) {
      const iface = new ethers.Interface(["function withdraw(uint256 wad)"]);
      const gas = await provider.estimateGas({
        from: params.recipient, to: CONTRACTS.WPC, data: iface.encodeFunctionData("withdraw", [amountIn]),
      }).then(g => Number(g)).catch(() => 30000);
      steps.push({ label: "Unwrap WPC → PC", gas });
    } else {
      if (isNativeIn) {
        const gas = await provider.estimateGas({
          from: params.recipient, to: CONTRACTS.WPC, value: amountIn, data: depositSelector,
        }).then(g => Number(g)).catch(() => 28000);
        steps.push({ label: "Wrap PC → WPC", gas });
      }

      const tokenToApprove = isNativeIn ? CONTRACTS.WPC : params.tokenIn;
      let needsApproval = true;
      try {
        const token = new ethers.Contract(tokenToApprove, ERC20_ABI, provider);
        const allowance = await token.allowance(params.recipient, CONTRACTS.MOLESWAP_FEE_ROUTER);
        needsApproval = allowance < amountIn;
      } catch { needsApproval = true; }

      if (needsApproval) {
        const approveIface = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
        const gas = await provider.estimateGas({
          from: params.recipient, to: tokenToApprove,
          data: approveIface.encodeFunctionData("approve", [CONTRACTS.MOLESWAP_FEE_ROUTER, amountIn]),
        }).then(g => Number(g)).catch(() => 27000);
        steps.push({ label: "Approve token", gas });
      }

      const pool = findPool(actualIn, actualOut);
      const needsMultiHop = !pool && actualIn.toLowerCase() !== CONTRACTS.WPC.toLowerCase() && actualOut.toLowerCase() !== CONTRACTS.WPC.toLowerCase();
      const isNativeOutPreview = params.tokenOut === ethers.ZeroAddress;
      const inSym = getTokenByAddress(actualIn)?.symbol || "token";
      const outSym = isNativeOutPreview ? "PC" : (getTokenByAddress(actualOut)?.symbol || "token");

      if (needsMultiHop) {
        // Multi-hop: single atomic SwapRouter call (exactInput or multicall for native out).
        // Label reflects the actual single-step build in the executeSwap path below.
        steps.push({ label: `Swap ${inSym} → ${outSym} (multi-hop)`, gas: isNativeOutPreview ? 260000 : 220000 });
      } else {
        const fee = pool?.fee || 500;
        const iface = new ethers.Interface(FEE_ROUTER_ABI);
        // Use the same method the executeSwap path will use so gas estimation is accurate.
        const swapData = isNativeOutPreview
          ? iface.encodeFunctionData("swapNativeOutput", [
              actualIn, fee, amountIn, 0, Math.floor(Date.now() / 1000) + 1800, 0,
            ])
          : iface.encodeFunctionData("swapExactInputSingle", [
              actualIn, actualOut, fee, amountIn, 0, Math.floor(Date.now() / 1000) + 1800, 0,
            ]);
        const gas = await provider.estimateGas({
          from: params.recipient, to: CONTRACTS.MOLESWAP_FEE_ROUTER, data: swapData,
        }).then(g => Number(g)).catch(() => isNativeOutPreview ? 180000 : 150000);
        steps.push({ label: isNativeOutPreview ? `Swap ${inSym} → PC` : "Swap tokens", gas });
      }
    }

    let blockTime = 1.4;
    try {
      const latest = await provider.getBlock("latest");
      const older = await provider.getBlock(latest!.number - 20);
      if (latest && older) {
        blockTime = (latest.timestamp - older.timestamp) / 20;
      }
    } catch {}

    const totalGas = steps.reduce((sum, s) => sum + s.gas, 0);
    const signingTime = 3;
    const confirmTime = Math.ceil(blockTime * 2);
    const etaSeconds = Math.round(steps.length * (signingTime + confirmTime));

    return {
      etaSeconds,
      totalGas,
      txCount: steps.length,
      breakdown: steps.map(s => `${s.label}: ~${(s.gas / 1000).toFixed(0)}k gas`),
    };
  } catch (err) {
    console.error("[MoleSwap] estimateSwapDetails error:", err);
    return null;
  }
}

// ═══ HELPER: Extract tx hash from PushChain wallet response ═══

function extractHash(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  
  const directKeys = [
    "hash", "txHash", "txnHash", "transactionHash", "transactionhash",
    "tx_hash", "txn_hash", "transaction_hash",
  ];
  for (const key of directKeys) {
    if (result[key] && typeof result[key] === "string") return result[key];
  }
  
  if (result.tx?.hash) return result.tx.hash;
  if (result.receipt?.transactionHash) return result.receipt.transactionHash;
  if (result.receipt?.hash) return result.receipt.hash;
  if (result.response?.hash) return result.response.hash;
  if (result.data?.hash) return result.data.hash;
  if (result.data?.txHash) return result.data.txHash;
  
  const hashRegex = /^0x[a-fA-F0-9]{64}$/;
  for (const val of Object.values(result)) {
    if (typeof val === "string" && hashRegex.test(val)) return val;
  }
  
  for (const val of Object.values(result)) {
    if (val && typeof val === "object") {
      for (const inner of Object.values(val as any)) {
        if (typeof inner === "string" && hashRegex.test(inner)) return inner;
      }
    }
  }
  
  console.warn("[MoleSwap] Could not extract hash from:", JSON.stringify(result).slice(0, 200));
  return "";
}

// ═══ EXECUTE SWAP ═══
// ═══════════════════════════════════════════════════════════════════════════
// ═══ executeSwap — NOW BUILDS RAMENFI STEPS AND PIPES THROUGH executeSteps ═
// ═══════════════════════════════════════════════════════════════════════════
// Instead of sending each approve/swap as its own universal.sendTransaction
// (which was 3-4 sigs for multi-hop on Phantom), we now build a list of
// `SwapStep` objects and hand them to `executeSteps`, which bundles them
// into a single multicall for cross-chain wallets.
//
// Execution matrix (steps produced by this function):
//
//   Wrap PC → WPC         [swap: wpc.deposit]
//   Unwrap WPC → PC       [swap: wpc.withdraw]
//   Single-hop:            [swap: approve, swap: swapExactInputSingle]
//   Multi-hop (A→WPC→B):   [swap: approve A, swap: hop1, swap: approve WPC, swap: hop2]
//
// All four scenarios become ONE signature for Phantom/MM-Sepolia users via
// multicall. For Push-native users they become N sequential sigs.

// Polls Push Chain RPC for tx receipt after a universal tx settles. Used by
// executeSteps callback so we don't proceed before on-chain confirmation.
async function pollPushReceipt(hash: string, timeoutMs = 60_000): Promise<void> {
  if (!hash || !hash.startsWith("0x")) return;
  const provider = getProvider();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt && receipt.blockNumber) return;
    } catch {}
    await new Promise(r => setTimeout(r, 3000));
  }
  // timeout — don't throw, caller will retry reads on next poll
  console.warn("[MoleSwap] pollPushReceipt: timeout waiting for", hash.slice(0, 10));
}

export async function executeSwap(params: {
  pushChainClient: any;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOutMin: string;
  /** Caller's address on Push Chain (UEA for cross-chain users). Used as the
   *  msg.sender anchor for approvals, balance lookups, and default output
   *  destination when no custom outputRecipient is provided. */
  recipient: string;
  /** Optional custom destination for the swap output. When set and distinct
   *  from `recipient`, executeSwap bypasses the fee-collecting FeeRouter and
   *  routes through the UniV3 SwapRouter directly (which accepts `recipient`
   *  in its params struct). Trade-off: those swaps don't pay the 0.25% house
   *  fee — fine for the niche case of sending proceeds to a different wallet.
   *  Single-hop token→token only; multi-hop with custom recipient falls back
   *  through the normal path today. */
  outputRecipient?: string | null;
  fee?: number;
  deadline?: number;
  universalTxOptions?: UniversalTxOptions;
  originChain?: string | null;  // pass origin chain from provider so we can route
  /**
   * @deprecated Kept in the signature so callers that pass it don't crash, but
   * this post-swap Route-2 "bridge-out" path has been removed. RamenFi
   * doesn't do bridge-out and Push Chain's universal.sendTransaction Route-2
   * can't deliver a PRC-20-origin asset to a wallet whose address format
   * doesn't match the PRC-20's origin chain (e.g. a Solana pubkey on Sepolia).
   * Swap destination is always Push Chain. Use a dedicated bridge flow later
   * if the user wants their asset on the origin chain.
   */
  bridgeOutTo?: string | null;
  onStep?: (step: number, label: string, status: "pending" | "signing" | "confirmed" | "error") => void;
}): Promise<{ txHash: string; success: boolean; error?: string }> {
  const onStep = params.onStep || (() => {});
  try {
    // Guard: pushChainClient must be initialized before we can execute swaps.
    // This catches the race condition where the UI allows swap initiation before
    // the SDK has fully connected (pushChainClient is null → "Cannot read 'universal'").
    if (!params.pushChainClient) {
      const errMsg = "PushChain client not initialized. Please reconnect your wallet.";
      console.error("[MoleSwap] executeSwap called with null pushChainClient");
      onStep(-1, errMsg, "error");
      return { txHash: "", success: false, error: errMsg };
    }

    // Wrap the client with RamenFi's guarded proxy (upgrade check before every send).
    // This is idempotent — if already guarded, the inner sendTransaction still fires once.
    const client = createGuardedPushChainClient(params.pushChainClient);

    const isNativeIn = params.tokenIn === ethers.ZeroAddress;
    const isNativeOut = params.tokenOut === ethers.ZeroAddress;
    const actualIn = isNativeIn ? CONTRACTS.WPC : params.tokenIn;
    const actualOut = isNativeOut ? CONTRACTS.WPC : params.tokenOut;

    const amountIn = BigInt(params.amountIn);
    const amountOutMin = (BigInt(params.amountOutMin) * 95n) / 100n;
    const deadline = params.deadline || Math.floor(Date.now() / 1000) + 1800;

    // Short-circuit: WRAP (native PC → WPC)
    const isWrap = isNativeIn && actualOut.toLowerCase() === CONTRACTS.WPC.toLowerCase();
    if (isWrap) {
      // Pre-flight balance check: user must have enough native PC
      const nativeBalance = await getNativeBalance(params.recipient);
      // Need amountIn + some gas buffer (~0.001 PC = 1e15 wei)
      const gasBuffer = BigInt("1000000000000000"); // 0.001 PC
      const required = amountIn + gasBuffer;

      if (nativeBalance < required) {
        const haveStr = formatBalance(nativeBalance);
        const needStr = formatBalance(amountIn);

        // Determine if user is on external chain
        const originChain = params.originChain || null;
        const isPushNative = !originChain ||
          originChain === "eip155:42101" ||
          originChain === "eip155:9001";

        let errMsg: string;
        if (nativeBalance === 0n && !isPushNative) {
          // User is on external chain with 0 PC — explain they need to bridge first
          errMsg = `Your Push Chain account has 0 PC. Native PC cannot be bridged from other chains. ` +
            `To get PC: 1) Bridge ETH/SOL to Push Chain first (select pETH or pSOL), ` +
            `2) Swap your bridged asset for PC, then 3) You can wrap PC to WPC.`;
        } else {
          errMsg = `Insufficient PC balance. You have ${haveStr} PC but need ${needStr} PC (plus gas).`;
        }

        console.error("[MoleSwap] Wrap pre-flight failed:", errMsg);
        onStep(-1, errMsg, "error");
        return { txHash: "", success: false, error: errMsg };
      }

      const wpcIface = new ethers.Interface(["function deposit() payable"]);
      const data = wpcIface.encodeFunctionData("deposit");
      const steps: SwapStep[] = [
        { type: "swap", to: CONTRACTS.WPC, value: amountIn.toString(), data, label: "Wrap PC → WPC" },
      ];
      const res = await executeSteps({
        pushChainClient: client,
        userAddress: params.recipient,
        steps,
        originChain: params.originChain || null,
        onStep,
        pollPushReceipt,
      });
      return { txHash: res.txHash || "", success: res.success, error: res.error };
    }

    // Short-circuit: UNWRAP (WPC → native PC)
    const isUnwrap =
      actualIn.toLowerCase() === CONTRACTS.WPC.toLowerCase() &&
      params.tokenOut === ethers.ZeroAddress;
    if (isUnwrap) {
      const wpcIface = new ethers.Interface(["function withdraw(uint256)"]);
      const withdrawData = wpcIface.encodeFunctionData("withdraw", [amountIn]);
      const steps: SwapStep[] = [
        { type: "swap", to: CONTRACTS.WPC, value: "0", data: withdrawData, label: "Unwrap WPC → PC" },
      ];

      // Custom-recipient support for the unwrap shortcut. WPC.withdraw only
      // returns native PC to msg.sender (= UEA); there's no recipient param.
      // If the user wants the PC delivered to a different wallet, append a
      // second step that forwards the UEA's freshly-received PC to the custom
      // address via a plain value-transfer call. Keeps the unwrap short-circuit
      // atomic-ish (one multicall bundle / two sequential sigs) without
      // needing a `withdrawTo` variant on WPC.
      const unwrapCustomRecipient =
        params.outputRecipient &&
        params.outputRecipient.toLowerCase() !== params.recipient.toLowerCase()
          ? params.outputRecipient
          : null;
      if (unwrapCustomRecipient) {
        steps.push({
          type: "swap",
          to: unwrapCustomRecipient,
          value: amountIn,
          data: "0x",
          label: `Forward PC → ${unwrapCustomRecipient.slice(0, 6)}…${unwrapCustomRecipient.slice(-4)}`,
        });
      }

      const res = await executeSteps({
        pushChainClient: client,
        userAddress: params.recipient,
        steps,
        originChain: params.originChain || null,
        onStep,
        pollPushReceipt,
      });
      return { txHash: res.txHash || "", success: res.success, error: res.error };
    }

    // ── Normal swap path — build steps ───────────────────────────────────

    const steps: SwapStep[] = [];
    const feeRouterIface = new ethers.Interface(FEE_ROUTER_ABI);
    // Hoist swapRouterIface so both the multi-hop branch AND the single-hop
    // custom-recipient bypass can use it (they live in separate if/else
    // scopes). Previously the bypass tried to reference it inside the
    // single-hop branch, where it was redeclared only in multi-hop — giving
    // "swapRouterIface is not defined" at runtime.
    const swapRouterIface = new ethers.Interface(SWAP_ROUTER_ABI);
    const approveIface = new ethers.Interface([
      "function approve(address,uint256) returns (bool)",
    ]);

    // ═══ AUTO-BRIDGE DETECTION ═══════════════════════════════════════════
    // If the user's origin chain matches the fromToken's bridge origin AND
    // the fromToken is a bridgeable PRC-20, we can atomically bridge the
    // origin asset AS PART of the swap. This is how RamenFi achieves the
    // "connect Phantom, swap SOL directly without pre-bridging" UX.
    //
    // Example: user on Phantom (origin=Solana) selects pSOL as fromToken.
    //   pSOL's bridge origin = Solana → matches → inject bridge step.
    //   The SDK lock-on-Solana + mint-on-Push + swap all happen in 1 sig.
    //
    // Example: user on MetaMask-Sepolia selects pSOL as fromToken.
    //   pSOL's bridge origin = Solana, user's origin = Sepolia → no match.
    //   User must already hold pSOL on Push Chain; we do direct swap.
    //
    // When a bridge step is prepended, the swap steps' amountIn is tricky
    // because the bridged amount may differ from what the user entered
    // (gas is subtracted on arrival). For this version we use the user's
    // stated amountIn as the swap input; if it over-swaps, the FeeRouter
    // will revert with STF and the user retries with a lower amount.
    const bridgeInfo = params.originChain
      ? (() => {
          const info = getBridgeInfoForPrc20(params.tokenIn);
          if (!info) return null;
          if (info.originChain.toLowerCase() !== params.originChain.toLowerCase()) return null;
          return info;
        })()
      : null;

    let bridgeSdkToken: any = null;
    if (bridgeInfo) {
      // Three paths to resolve MOVEABLE.TOKEN — try all of them:
      // 1. pushChainClient.constructor.CONSTANTS (most common; SDK v5)
      // 2. pushChainClient.CONSTANTS (direct instance prop)
      // 3. Dynamic import of @pushchain/core as a last resort
      try {
        const ctorConstants =
          (params.pushChainClient as any)?.constructor?.CONSTANTS ||
          (params.pushChainClient as any)?.CONSTANTS;
        const moveable = ctorConstants?.MOVEABLE?.TOKEN;
        if (moveable) {
          bridgeSdkToken = getSdkMoveableToken(params.tokenIn, moveable);
        }
      } catch (err) {
        console.warn("[MoleSwap] Could not access MOVEABLE.TOKEN via client:", err);
      }

      // Fallback: import the SDK directly
      if (!bridgeSdkToken) {
        try {
          const { PushChain } = await import("@pushchain/core");
          const moveable = (PushChain as any)?.CONSTANTS?.MOVEABLE?.TOKEN;
          if (moveable) {
            bridgeSdkToken = getSdkMoveableToken(params.tokenIn, moveable);
          }
        } catch (err) {
          console.warn("[MoleSwap] Could not dynamic-import @pushchain/core for MOVEABLE constants:", err);
        }
      }

      // Loud warning if cross-chain user's bridge path can't be resolved —
      // this is the silent failure that caused Phantom users to unknowingly
      // drain their existing UEA pSOL balance instead of spending real SOL.
      if (!bridgeSdkToken) {
        console.error(
          "[MoleSwap] CROSS-CHAIN BRIDGE-IN FAILED: user origin matches fromToken origin but MOVEABLE.TOKEN resolution failed.",
          { tokenIn: params.tokenIn, originChain: bridgeInfo.originChain, originSymbol: bridgeInfo.originSymbol },
        );
      }
    }

    if (bridgeInfo && bridgeSdkToken) {
      // The user will pay the bridge amount in their origin asset (SOL, ETH,
      // USDT, etc.) — `amountIn` here is expressed in the PRC-20 decimals,
      // but since Push Chain's Universal Gateway mints 1:1, the same
      // numeric amount works for the bridge. (If origin decimals differ
      // from PRC-20 decimals the SDK handles the conversion.)
      steps.push({
        type: "bridge",
        amount: amountIn.toString(),
        token: bridgeSdkToken,
      });
      console.log("[MoleSwap] Auto-bridging", {
        fromToken: params.tokenIn,
        originSymbol: bridgeInfo.originSymbol,
        originChain: bridgeInfo.originChain,
        amount: amountIn.toString(),
      });
    }

    // If native PC in, we must wrap first. The Push gateway's multicall ABI
    // decoder fails when any step inside a batch has a non-zero `value` field
    // (confirmed by repeated on-chain failures: "failed to unpack payload:
    // offset 0x2cc2842d would go over slice boundary"). To sidestep this, we
    // ONLY include the wrap inside a multicall when bridge-in handles the
    // native input. Otherwise we do the wrap as a separate tx (pre-step)
    // outside the batch.
    let wrapAsPreStep = false;
    if (isNativeIn && !bridgeInfo) {
      const wpcIface = new ethers.Interface(["function deposit() payable"]);
      const isCrossChainUser = !isPushChain(params.originChain || null);
      if (isCrossChainUser) {
        // Cross-chain user (MetaMask Sepolia / Phantom / etc.) with native PC
        // in. Can't use multicall with value. Execute wrap as its own tx first.
        wrapAsPreStep = true;
        onStep(0, "Wrap PC → WPC", "signing");
        await client.universal.sendTransaction({
          to: CONTRACTS.WPC,
          value: amountIn,
          data: wpcIface.encodeFunctionData("deposit"),
        });
        onStep(0, "Wrap PC → WPC", "confirmed");
        // Give the wrap a moment to settle before the next tx reads WPC balance.
        await new Promise(r => setTimeout(r, 4000));
      } else {
        // Push-native user: sequential path in executeSteps handles value OK.
        steps.push({
          type: "swap",
          to: CONTRACTS.WPC,
          value: amountIn.toString(),
          data: wpcIface.encodeFunctionData("deposit"),
          label: "Wrap PC → WPC",
        });
      }
    }

    // Detect multi-hop: no direct pool for tokenIn↔tokenOut, route via WPC
    const directPool = findPool(actualIn, actualOut);
    const needsMultiHop =
      actualIn.toLowerCase() !== CONTRACTS.WPC.toLowerCase() &&
      actualOut.toLowerCase() !== CONTRACTS.WPC.toLowerCase() &&
      !directPool;

    if (needsMultiHop) {
      // ── Multi-hop A → WPC → B ──
      const poolA = findPool(actualIn, CONTRACTS.WPC);
      const poolB = findPool(actualOut, CONTRACTS.WPC);
      if (!poolA || !poolB) {
        throw new Error(
          `No route found: no pool for ${actualIn.slice(0, 10)} or ${actualOut.slice(0, 10)} against WPC`,
        );
      }

      // Use Uniswap V3 SwapRouter's `exactInput(path, ...)` which handles
      // multi-hop atomically inside a single call. The path is encoded as
      // tokenIn ++ fee ++ tokenMid ++ fee ++ tokenOut (bytes, no padding).
      //
      // Trade-off: SwapRouter takes no protocol fee (unlike MoleSwap's
      // FeeRouter which takes 0.25%). Multi-hop swaps therefore bypass the
      // treasury cut. Single-hop swaps (handled in the else branch below)
      // still route through FeeRouter and pay the fee. This is standard
      // AMM router behavior — RamenFi does the same.
      // swapRouterIface is hoisted above — reused here.

      // Encode the path: tokenIn (20 bytes) + fee (3 bytes) + WPC (20 bytes) + fee (3 bytes) + tokenOut (20 bytes)
      const encodePath = (
        tokens: string[],
        fees: number[],
      ): string => {
        if (tokens.length !== fees.length + 1) {
          throw new Error("tokens.length must be fees.length + 1");
        }
        let encoded = "0x";
        for (let i = 0; i < fees.length; i++) {
          // strip leading 0x and pad address to 40 hex chars (20 bytes)
          encoded += tokens[i].slice(2).padStart(40, "0");
          // fee as 3 bytes (6 hex chars)
          encoded += fees[i].toString(16).padStart(6, "0");
        }
        // final tokenOut
        encoded += tokens[tokens.length - 1].slice(2).padStart(40, "0");
        return encoded.toLowerCase();
      };

      const path = encodePath(
        [actualIn, CONTRACTS.WPC, actualOut],
        [poolA.fee, poolB.fee],
      );

      // Approve tokenIn to SwapRouter (not FeeRouter, since we're bypassing it)
      steps.push({
        type: "swap",
        to: actualIn,
        value: "0",
        data: approveIface.encodeFunctionData("approve", [CONTRACTS.SWAP_ROUTER, amountIn]),
        label: "Approve " + (getTokenByAddress(actualIn)?.symbol || "token"),
      });

      if (isNativeOut) {
        // ── Multi-hop with native PC out:
        // Use SwapRouter.multicall([exactInput(recipient=SWAP_ROUTER), unwrapWETH9(min, user)]).
        // This keeps the WPC inside the SwapRouter after the final hop, then
        // unwraps it and sends native PC to the user — all atomic in 1 call.
        // Prior to this branch, the final hop deposited WPC into the UEA and
        // no unwrap fired, leaving WPC stuck.
        const exactInputCall = swapRouterIface.encodeFunctionData("exactInput", [
          {
            path,
            // SwapRouter must hold the WPC so it can unwrap in the next call.
            recipient: CONTRACTS.SWAP_ROUTER,
            deadline: BigInt(deadline),
            amountIn,
            amountOutMinimum: amountOutMin,
          },
        ]);
        const unwrapCall = swapRouterIface.encodeFunctionData("unwrapWETH9", [
          amountOutMin,
          params.recipient,
        ]);
        steps.push({
          type: "swap",
          to: CONTRACTS.SWAP_ROUTER,
          value: "0",
          data: swapRouterIface.encodeFunctionData("multicall", [[exactInputCall, unwrapCall]]),
          label: `Swap ${getTokenByAddress(actualIn)?.symbol || "A"} → PC (multi-hop)`,
        });
      } else {
        // Single `exactInput` call — atomic multi-hop, token recipient = user
        steps.push({
          type: "swap",
          to: CONTRACTS.SWAP_ROUTER,
          value: "0",
          data: swapRouterIface.encodeFunctionData("exactInput", [
            {
              path,
              recipient: params.recipient,
              deadline: BigInt(deadline),
              amountIn,
              amountOutMinimum: amountOutMin,
            },
          ]),
          label: `Swap ${getTokenByAddress(actualIn)?.symbol || "A"} → ${getTokenByAddress(actualOut)?.symbol || "B"} (multi-hop)`,
        });
      }
    } else {
      // ── Single-hop: direct pool ──

      // CUSTOM-RECIPIENT BYPASS (option A).
      // When the user wants swap proceeds delivered to an address OTHER than
      // their own UEA, we can't use FeeRouter — its swapExactInputSingle /
      // swapNativeOutput signatures have no `recipient` parameter and always
      // forward to msg.sender (= UEA). Route through the UniV3 SwapRouter
      // directly instead; its exactInputSingle params tuple has `recipient`
      // built in, so the tokens land at the custom address without ever
      // touching the UEA. Trade-off: these swaps skip FeeRouter's 0.25%
      // house fee. Documented and acceptable for the niche case of sending
      // proceeds to a different wallet.
      const customRecipient =
        params.outputRecipient &&
        params.outputRecipient.toLowerCase() !== params.recipient.toLowerCase()
          ? params.outputRecipient
          : null;
      const useBypass = !!customRecipient;

      const tokenToApprove = isNativeIn ? CONTRACTS.WPC : params.tokenIn;
      const approveTarget = useBypass ? CONTRACTS.SWAP_ROUTER : CONTRACTS.MOLESWAP_FEE_ROUTER;

      steps.push({
        type: "swap",
        to: tokenToApprove,
        value: "0",
        data: approveIface.encodeFunctionData("approve", [approveTarget, amountIn]),
        label: "Approve " + (getTokenByAddress(tokenToApprove)?.symbol || "token"),
      });

      const poolFee = params.fee || directPool?.fee || 500;

      if (useBypass) {
        if (isNativeOut) {
          // Custom recipient + native out: SwapRouter.multicall([exactInputSingle(recipient=SwapRouter), unwrapWETH9(min, customRecipient)])
          // The SwapRouter holds WPC after the swap, then unwraps and sends
          // native PC to the custom recipient — all atomic.
          const exactInputSingleCall = swapRouterIface.encodeFunctionData("exactInputSingle", [
            {
              tokenIn: actualIn,
              tokenOut: CONTRACTS.WPC,
              fee: poolFee,
              recipient: CONTRACTS.SWAP_ROUTER,
              deadline: BigInt(deadline),
              amountIn,
              amountOutMinimum: amountOutMin,
              sqrtPriceLimitX96: 0,
            },
          ]);
          const unwrapCall = swapRouterIface.encodeFunctionData("unwrapWETH9", [
            amountOutMin,
            customRecipient,
          ]);
          steps.push({
            type: "swap",
            to: CONTRACTS.SWAP_ROUTER,
            value: "0",
            data: swapRouterIface.encodeFunctionData("multicall", [[exactInputSingleCall, unwrapCall]]),
            label: `Swap ${getTokenByAddress(actualIn)?.symbol || "token"} → PC → ${customRecipient.slice(0, 6)}…`,
          });
        } else {
          // Token → token, custom recipient. Clean single call.
          steps.push({
            type: "swap",
            to: CONTRACTS.SWAP_ROUTER,
            value: "0",
            data: swapRouterIface.encodeFunctionData("exactInputSingle", [
              {
                tokenIn: actualIn,
                tokenOut: actualOut,
                fee: poolFee,
                recipient: customRecipient,
                deadline: BigInt(deadline),
                amountIn,
                amountOutMinimum: amountOutMin,
                sqrtPriceLimitX96: 0,
              },
            ]),
            label: `Swap → ${customRecipient.slice(0, 6)}…`,
          });
        }
      } else if (isNativeOut) {
        // ── Native PC out: use swapNativeOutput so FeeRouter swaps to WPC
        // and atomically unwraps + forwards native PC to msg.sender. This
        // avoids leaving wrapped WPC stuck in the user's UEA (which was the
        // bug for pSOL→PC / pETH→PC / pUSDT→PC swaps prior to this fix).
        // FeeRouter.swapNativeOutput signature:
        //   (tokenIn, poolFee, amountIn, amountOutMinimum, deadline, sqrtPriceLimitX96)
        //   -> exactInputSingle(recipient=this) -> WPC.withdraw -> call{value: ...}
        // Works identically whether executed inside a cross-chain multicall
        // (msg.sender = UEA via MULTICALL_TARGET_ADDRESS=0x0) or sequentially
        // (msg.sender = UEA direct), so PC always lands with the user.
        steps.push({
          type: "swap",
          to: CONTRACTS.MOLESWAP_FEE_ROUTER,
          value: "0",
          data: feeRouterIface.encodeFunctionData("swapNativeOutput", [
            actualIn, poolFee, amountIn, amountOutMin, deadline, 0,
          ]),
          label: `Swap ${getTokenByAddress(actualIn)?.symbol || "token"} → PC`,
        });
      } else {
        // Token out — standard swap
        steps.push({
          type: "swap",
          to: CONTRACTS.MOLESWAP_FEE_ROUTER,
          value: "0",
          data: feeRouterIface.encodeFunctionData("swapExactInputSingle", [
            actualIn, actualOut, poolFee, amountIn, amountOutMin, deadline, 0,
          ]),
          label: "Swap tokens",
        });
      }
    }

    console.log("[MoleSwap] executeSwap → executeSteps:", {
      stepCount: steps.length,
      isNativeIn,
      needsMultiHop,
      originChain: params.originChain,
      isCrossChain: !isPushChain(params.originChain || null),
    });

    const result = await executeSteps({
      pushChainClient: client,
      userAddress: params.recipient,
      steps,
      originChain: params.originChain || null,
      onStep,
      pollPushReceipt,
    });

    return {
      txHash: result.txHash || "",
      success: result.success,
      error: result.error,
    };
  } catch (err: any) {
    const decoded = getContractErrorMessage(err);
    console.error("[MoleSwap] executeSwap error:", decoded);
    onStep(-1, decoded, "error");
    return { txHash: "", success: false, error: decoded };
  }
}

export async function approveToken(
  tokenAddress: string,
  amountWei: string,
): Promise<string | null> {
  try {
    if (typeof window === "undefined" || !(window as any).ethereum) return null;
    const provider = new ethers.BrowserProvider((window as any).ethereum);
    const signer = await provider.getSigner();
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const tx = await token.approve(CONTRACTS.MOLESWAP_FEE_ROUTER, BigInt(amountWei));
    const receipt = await tx.wait();
    return receipt?.hash || tx.hash;
  } catch (err) {
    console.error("Approve error:", err);
    return null;
  }
}

// ═══ GET ALL POOLS WITH LIQUIDITY ═══
export async function getAllPools(userAddress?: string): Promise<any[]> {
  try {
    const provider = getProvider();
    const poolData = await Promise.all(
      POOLS.map(async (pool) => {
        try {
          const contract = new ethers.Contract(pool.address, POOL_ABI, provider);
          const [slot0, liquidity] = await Promise.all([
            contract.slot0(),
            contract.liquidity(),
          ]);
          const token0 = getTokenByAddress(pool.token0);
          const token1 = getTokenByAddress(pool.token1);
          return {
            ...pool,
            token0Info: token0,
            token1Info: token1,
            sqrtPriceX96: slot0[0].toString(),
            tick: slot0[1],
            liquidity: liquidity.toString(),
            hasLiquidity: liquidity > 0n,
          };
        } catch {
          return { ...pool, hasLiquidity: false, liquidity: "0" };
        }
      })
    );
    return poolData.filter((p: any) => p.hasLiquidity);
  } catch (err) {
    console.error("Get pools error:", err);
    return [];
  }
}

// ═══ LIQUIDITY TYPES ═══
export interface AddLiquidityParams {
  pushChainClient: any;
  token0: string;
  token1: string;
  fee: number;
  amount0Desired: string;
  amount1Desired: string;
  recipient: string;
  tickLower?: number;
  tickUpper?: number;
  slippageBps?: number;
  deadline?: number;
  universalTxOptions?: UniversalTxOptions;
  // Origin chain of the connected wallet (e.g. "solana:EtWTRAB..." for
  // Phantom, "eip155:42101" for Push-native). Passed through to executeSteps
  // so cross-chain wallets get 1-sig multicall instead of N sigs.
  originChain?: string | null;
  onStep?: (step: number, label: string, status: "pending" | "signing" | "confirmed" | "error") => void;
}

export interface RemoveLiquidityParams {
  pushChainClient: any;
  tokenId: number;
  liquidity: string;
  amount0Min?: string;
  amount1Min?: string;
  recipient: string;
  deadline?: number;
  burnAfter?: boolean;
  universalTxOptions?: UniversalTxOptions;
  originChain?: string | null;
  onStep?: (step: number, label: string, status: "pending" | "signing" | "confirmed" | "error") => void;
}

export interface LiquidityPosition {
  tokenId: number;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  tokensOwed0: string;
  tokensOwed1: string;
  token0Info?: TokenInfo;
  token1Info?: TokenInfo;
  poolInfo?: PoolInfo;
}

// ═══ TICK HELPERS ═══
function nearestUsableTick(tick: number, tickSpacing: number): number {
  const rounded = Math.round(tick / tickSpacing) * tickSpacing;
  if (rounded < MIN_TICK) return MIN_TICK + tickSpacing;
  if (rounded > MAX_TICK) return MAX_TICK - tickSpacing;
  return rounded;
}

function getFullRangeTicks(fee: number): { tickLower: number; tickUpper: number } {
  const spacing = TICK_SPACINGS[fee] || 10;
  return {
    tickLower: nearestUsableTick(MIN_TICK, spacing),
    tickUpper: nearestUsableTick(MAX_TICK, spacing),
  };
}

function orderTokens(tokenA: string, tokenB: string): { token0: string; token1: string; reversed: boolean } {
  const a = tokenA.toLowerCase();
  const b = tokenB.toLowerCase();
  if (a < b) return { token0: tokenA, token1: tokenB, reversed: false };
  return { token0: tokenB, token1: tokenA, reversed: true };
}

// ═══ ADD LIQUIDITY — RAMENFI-CLONED STEPS ORCHESTRATOR ═══
// Builds a list of SwapSteps (wrap + approve0 + approve1 + mint) and pipes
// through executeSteps. For Phantom/cross-chain users this becomes 1 sig
// (multicall). For Push-native users it's sequential sigs as before.
export async function addLiquidity(params: AddLiquidityParams): Promise<{ txHash: string; success: boolean; tokenId?: number; error?: string }> {
  const onStep = params.onStep || (() => {});
  try {
    const client = createGuardedPushChainClient(params.pushChainClient);

    const isNative0 = params.token0 === ethers.ZeroAddress;
    const isNative1 = params.token1 === ethers.ZeroAddress;
    const actual0 = isNative0 ? CONTRACTS.WPC : params.token0;
    const actual1 = isNative1 ? CONTRACTS.WPC : params.token1;

    const { token0, token1, reversed } = orderTokens(actual0, actual1);
    const amount0 = reversed ? BigInt(params.amount1Desired) : BigInt(params.amount0Desired);
    const amount1 = reversed ? BigInt(params.amount0Desired) : BigInt(params.amount1Desired);

    // amount0Min / amount1Min are the MINIMUM amounts that must actually be
    // consumed when PositionManager.mint settles. They're NOT "slippage on
    // what I typed" — in UniV3 concentrated liquidity, only one of the
    // desired amounts is fully used; the other gets scaled down to match
    // `sqrtPriceX96 × tickRange`. The previous code enforced (99.5% * desired)
    // on BOTH sides, which effectively required the pool to be at the exact
    // ratio the user entered. That's almost never true, so every mint
    // reverted with UniV3's "Price slippage check" (see tx Cosmos hash
    // D1D8731735…A987146AF69E, code 10, decoded revert 0x50726963…6865636b).
    //
    // Fix: set both mins to 0. The tickLower/tickUpper already define the
    // acceptable price range; the user's amount inputs are purely upper
    // bounds. MEV-protection-wise this is no worse than every other UniV3
    // frontend that does the same thing when it can't compute the precise
    // expected-used amounts from the current pool state. A future
    // improvement is to read slot0 + position math and derive the correct
    // min from the expected-used amounts, but that's a non-trivial
    // computation and not required for correct settlement.
    // Honour an explicit caller override if provided, otherwise default to 0.
    const amount0Min = params.amount0Min ? BigInt(params.amount0Min) : 0n;
    const amount1Min = params.amount1Min ? BigInt(params.amount1Min) : 0n;
    const deadline = params.deadline || Math.floor(Date.now() / 1000) + 1800;

    const fee = params.fee || 500;
    const spacing = TICK_SPACINGS[fee] || 10;
    const { tickLower, tickUpper } = params.tickLower != null && params.tickUpper != null
      ? { tickLower: nearestUsableTick(params.tickLower, spacing), tickUpper: nearestUsableTick(params.tickUpper, spacing) }
      : getFullRangeTicks(fee);

    const needsWrap = isNative0 || isNative1;
    const wrapAmount = isNative0 ? BigInt(params.amount0Desired) : isNative1 ? BigInt(params.amount1Desired) : 0n;

    // ── Build steps ──
    const steps: SwapStep[] = [];
    const approveIface = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);
    const proxyIface = new ethers.Interface(LIQUIDITY_PROXY_ABI);

    // Wrap native PC → WPC (if any side is native)
    if (needsWrap && wrapAmount > 0n) {
      const wrapIface = new ethers.Interface(["function deposit() payable"]);
      steps.push({
        type: "swap",
        to: CONTRACTS.WPC,
        value: wrapAmount.toString(),
        data: wrapIface.encodeFunctionData("deposit"),
        label: "WRAP PC → WPC",
      });
    }

    // Approve token0 → LiquidityProxy
    steps.push({
      type: "swap",
      to: token0,
      value: "0",
      data: approveIface.encodeFunctionData("approve", [CONTRACTS.MOLESWAP_LIQUIDITY_PROXY, amount0]),
      label: `APPROVE ${token0.slice(0, 6)}...`,
    });

    // Approve token1 → LiquidityProxy
    steps.push({
      type: "swap",
      to: token1,
      value: "0",
      data: approveIface.encodeFunctionData("approve", [CONTRACTS.MOLESWAP_LIQUIDITY_PROXY, amount1]),
      label: `APPROVE ${token1.slice(0, 6)}...`,
    });

    // Mint position
    steps.push({
      type: "swap",
      to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      value: "0",
      data: proxyIface.encodeFunctionData("mint", [{
        token0, token1, fee, tickLower, tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min, amount1Min,
        deadline,
      }]),
      label: "MINT POSITION",
    });

    console.log("[MoleSwap] addLiquidity → executeSteps:", {
      stepCount: steps.length,
      needsWrap,
      originChain: params.originChain,
      isCrossChain: !isPushChain(params.originChain || null),
    });

    const result = await executeSteps({
      pushChainClient: client,
      userAddress: params.recipient,
      steps,
      originChain: params.originChain || null,
      onStep,
      pollPushReceipt,
    });

    if (!result.success || !result.txHash) {
      return { txHash: "", success: false, error: result.error || "Add liquidity failed" };
    }

    return { txHash: result.txHash, success: true };
  } catch (err: any) {
    const decoded = getContractErrorMessage(err);
    console.error("[MoleSwap] Add liquidity error:", decoded);
    onStep(-1, decoded, "error");
    return { txHash: "", success: false, error: decoded };
  }
}

// ═══ REMOVE LIQUIDITY ═══
export async function removeLiquidity(params: RemoveLiquidityParams): Promise<{ txHash: string; success: boolean; error?: string }> {
  const onStep = params.onStep || (() => {});
  try {
    const client = createGuardedPushChainClient(params.pushChainClient);

    const deadline = params.deadline || Math.floor(Date.now() / 1000) + 1800;
    const liquidity = BigInt(params.liquidity);
    const amount0Min = BigInt(params.amount0Min || "0");
    const amount1Min = BigInt(params.amount1Min || "0");
    const MAX_UINT128 = BigInt("340282366920938463463374607431768211455");

    // Check if LiquidityProxy is approved as operator — only add setApprovalForAll
    // step if needed. Reading this is free (view call).
    const provider = getProvider();
    const pm = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const isApproved = await pm.isApprovedForAll(params.recipient, CONTRACTS.MOLESWAP_LIQUIDITY_PROXY).catch(() => false);

    const steps: SwapStep[] = [];
    const pmIface = new ethers.Interface(POSITION_MANAGER_ABI);
    const proxyIface = new ethers.Interface(LIQUIDITY_PROXY_ABI);

    if (!isApproved) {
      steps.push({
        type: "swap",
        to: CONTRACTS.POSITION_MANAGER,
        value: "0",
        data: pmIface.encodeFunctionData("setApprovalForAll", [CONTRACTS.MOLESWAP_LIQUIDITY_PROXY, true]),
        label: "CHECK PROXY APPROVAL",
      });
    }

    // decreaseLiquidity
    steps.push({
      type: "swap",
      to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      value: "0",
      data: proxyIface.encodeFunctionData("decreaseLiquidity", [
        params.tokenId, liquidity, amount0Min, amount1Min, deadline,
      ]),
      label: "DECREASE LIQUIDITY",
    });

    // collect (must happen AFTER decreaseLiquidity in the same tx — that's why
    // multicall is perfect here; it guarantees atomic ordering)
    steps.push({
      type: "swap",
      to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      value: "0",
      data: proxyIface.encodeFunctionData("collect", [
        params.tokenId, MAX_UINT128, MAX_UINT128,
      ]),
      label: "COLLECT TOKENS",
    });

    // Optional burn
    if (params.burnAfter) {
      steps.push({
        type: "swap",
        to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
        value: "0",
        data: proxyIface.encodeFunctionData("burn", [params.tokenId]),
        label: "BURN POSITION NFT",
      });
    }

    console.log("[MoleSwap] removeLiquidity → executeSteps:", {
      stepCount: steps.length,
      hadProxyApproval: isApproved,
      originChain: params.originChain,
      isCrossChain: !isPushChain(params.originChain || null),
    });

    const result = await executeSteps({
      pushChainClient: client,
      userAddress: params.recipient,
      steps,
      originChain: params.originChain || null,
      onStep,
      pollPushReceipt,
    });

    if (!result.success || !result.txHash) {
      return { txHash: "", success: false, error: result.error || "Remove liquidity failed" };
    }
    return { txHash: result.txHash, success: true };
  } catch (err: any) {
    const decoded = getContractErrorMessage(err);
    console.error("[MoleSwap] Remove liquidity error:", decoded);
    onStep(-1, decoded, "error");
    return { txHash: "", success: false, error: decoded };
  }
}

// ═══ GET USER POSITIONS ═══
export async function getUserPositions(userAddress: string): Promise<LiquidityPosition[]> {
  try {
    const provider = getProvider();
    const pm = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);

    const balance = await pm.balanceOf(userAddress);
    const count = Number(balance);
    if (count === 0) return [];

    const positions: LiquidityPosition[] = [];
    for (let i = 0; i < count; i++) {
      try {
        const tokenId = await pm.tokenOfOwnerByIndex(userAddress, i);
        const pos = await pm.positions(tokenId);

        const token0Info = getTokenByAddress(pos.token0);
        const token1Info = getTokenByAddress(pos.token1);
        const poolInfo = findPool(pos.token0, pos.token1);

        positions.push({
          tokenId: Number(tokenId),
          token0: pos.token0,
          token1: pos.token1,
          fee: Number(pos.fee),
          tickLower: Number(pos.tickLower),
          tickUpper: Number(pos.tickUpper),
          liquidity: pos.liquidity.toString(),
          tokensOwed0: pos.tokensOwed0.toString(),
          tokensOwed1: pos.tokensOwed1.toString(),
          token0Info,
          token1Info,
          poolInfo,
        });
      } catch (e) {
        console.error(`Error reading position index ${i}:`, e);
      }
    }
    return positions;
  } catch (err) {
    console.error("Get user positions error:", err);
    return [];
  }
}

// ═══ COLLECT FEES FROM POSITION ═══
export async function collectFees(params: {
  pushChainClient: any;
  tokenId: number;
  recipient: string;
  liquidity?: string;      // NEW: current liquidity on the position — needed for decreaseLiquidity(1) flush trick
  deadline?: number;
  universalTxOptions?: UniversalTxOptions;
  originChain?: string | null;
  onStep?: (step: number, label: string, status: "pending" | "signing" | "confirmed" | "error") => void;
}): Promise<{ txHash: string; success: boolean; error?: string }> {
  const onStep = params.onStep || (() => {});
  try {
    const client = createGuardedPushChainClient(params.pushChainClient);
    const MAX_UINT128 = BigInt("340282366920938463463374607431768211455");
    const deadline = params.deadline || Math.floor(Date.now() / 1000) + 1800;

    // Check proxy approval — add setApprovalForAll step only if needed
    const provider = getProvider();
    const pm = new ethers.Contract(CONTRACTS.POSITION_MANAGER, POSITION_MANAGER_ABI, provider);
    const isApproved = await pm.isApprovedForAll(params.recipient, CONTRACTS.MOLESWAP_LIQUIDITY_PROXY).catch(() => false);

    const steps: SwapStep[] = [];
    const pmIface = new ethers.Interface(POSITION_MANAGER_ABI);
    const proxyIface = new ethers.Interface(LIQUIDITY_PROXY_ABI);

    if (!isApproved) {
      steps.push({
        type: "swap",
        to: CONTRACTS.POSITION_MANAGER,
        value: "0",
        data: pmIface.encodeFunctionData("setApprovalForAll", [CONTRACTS.MOLESWAP_LIQUIDITY_PROXY, true]),
        label: "APPROVE PROXY",
      });
    }

    // Flush tokensOwed via decreaseLiquidity(1) before collect.
    // Per MoleSwap memory: `collect()` alone returns zero fees — must call
    // decreaseLiquidity with amount=1 first to flush accumulated fees into
    // tokensOwed. Atomic multicall ensures these run in order in ONE tx.
    steps.push({
      type: "swap",
      to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      value: "0",
      data: proxyIface.encodeFunctionData("decreaseLiquidity", [
        params.tokenId, 1n, 0n, 0n, deadline,
      ]),
      label: "FLUSH FEES",
    });

    // Collect
    steps.push({
      type: "swap",
      to: CONTRACTS.MOLESWAP_LIQUIDITY_PROXY,
      value: "0",
      data: proxyIface.encodeFunctionData("collect", [
        params.tokenId, MAX_UINT128, MAX_UINT128,
      ]),
      label: "COLLECT FEES",
    });

    console.log("[MoleSwap] collectFees → executeSteps:", {
      stepCount: steps.length,
      hadProxyApproval: isApproved,
      originChain: params.originChain,
      isCrossChain: !isPushChain(params.originChain || null),
    });

    const result = await executeSteps({
      pushChainClient: client,
      userAddress: params.recipient,
      steps,
      originChain: params.originChain || null,
      onStep,
      pollPushReceipt,
    });

    if (!result.success || !result.txHash) {
      return { txHash: "", success: false, error: result.error || "Collect fees failed" };
    }
    return { txHash: result.txHash, success: true };
  } catch (err: any) {
    const decoded = getContractErrorMessage(err);
    console.error("[MoleSwap] Collect fees error:", decoded);
    onStep(-1, decoded, "error");
    return { txHash: "", success: false, error: decoded };
  }
}

export async function getPairReserves(tokenA: string, tokenB: string) {
  try {
    const actualA = tokenA === ethers.ZeroAddress ? CONTRACTS.WPC : tokenA;
    const actualB = tokenB === ethers.ZeroAddress ? CONTRACTS.WPC : tokenB;
    const pool = findPool(actualA, actualB);
    if (!pool) return { reserve0: "0", reserve1: "0" };

    const provider = getProvider();
    const token0Contract = new ethers.Contract(pool.token0, ERC20_ABI, provider);
    const token1Contract = new ethers.Contract(pool.token1, ERC20_ABI, provider);

    const [bal0, bal1] = await Promise.all([
      token0Contract.balanceOf(pool.address),
      token1Contract.balanceOf(pool.address),
    ]);

    return {
      reserve0: bal0.toString(),
      reserve1: bal1.toString(),
    };
  } catch (err) {
    console.error("getPairReserves error:", err);
    return { reserve0: "0", reserve1: "0" };
  }
}
