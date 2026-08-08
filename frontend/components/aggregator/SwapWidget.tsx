"use client";

/**
 * SwapWidget — the MoleSwap Pro aggregator swap, on Robinhood Chain.
 *
 * The whole point of this component is that it TRUSTS almost nothing on the client that it cannot re-check
 * on-chain. The quote is computed off-chain (fast), but the number that protects the user is `minAmountOut`
 * carried into `MoleRouter.swap`: even if this UI, the RPC, or the pool state were wrong or stale, the
 * on-chain executor either delivers at least that much or reverts. So the UI's job is to compute a good
 * quote and set an honest floor — not to be the safety mechanism.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useAccount,
  useChainId,
  usePublicClient,
  useSwitchChain,
  useWriteContract,
  useConnect,
} from "wagmi";
import { createClient } from "@/lib/supabase/client";
import { MOLE_ADDRESSES } from "@/lib/mole/chain";
import { quoteSwap, type PoolRow, type TokenRow } from "@/lib/aggregator/client";
import { moleRouterAbi, erc20Abi, NATIVE_SENTINEL } from "@/lib/aggregator/router";

const RH_CHAIN_ID = 4663;
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

function fmtUnits(v: bigint, decimals: number, maxFrac = 6): string {
  const neg = v < 0n;
  let s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  let frac = decimals ? s.slice(s.length - decimals) : "";
  frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

function parseUnits(input: string, decimals: number): bigint {
  const [i, f = ""] = input.trim().split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((i || "0") + frac);
}

export default function SwapWidget() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { connect, connectors } = useConnect();
  const publicClient = usePublicClient({ chainId: RH_CHAIN_ID });
  const { writeContractAsync } = useWriteContract();

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [pools, setPools] = useState<PoolRow[]>([]);
  const [tokenIn, setTokenIn] = useState<string>(NATIVE_SENTINEL.toLowerCase());
  const [tokenOut, setTokenOut] = useState<string>("0x5fc5360d0400a0fd4f2af552add042d716f1d168"); // USDG
  const [amountText, setAmountText] = useState<string>("");
  const [slippageBps, setSlippageBps] = useState<number>(50);

  const [out, setOut] = useState<{ amountOut: bigint; minOut: bigint; via: string[]; encoded: unknown; value: bigint } | null>(null);
  const [status, setStatus] = useState<string>("");
  const [quoting, setQuoting] = useState(false);
  const seq = useRef(0);

  // Load the token + pool registry from Supabase once.
  useEffect(() => {
    const sb = createClient();
    (async () => {
      const [{ data: t }, { data: p }] = await Promise.all([
        sb.from("mp_tokens").select("*").order("sort_rank"),
        sb.from("mp_pools").select("*").eq("active", true),
      ]);
      if (t) setTokens(t as TokenRow[]);
      if (p) setPools(p as PoolRow[]);
    })();
  }, []);

  const tokenBy = useCallback(
    (addr: string) => tokens.find((x) => x.address.toLowerCase() === addr.toLowerCase()),
    [tokens],
  );
  const inMeta = tokenBy(tokenIn);
  const outMeta = tokenBy(tokenOut);

  // Debounced live quote whenever the inputs change.
  useEffect(() => {
    setOut(null);
    if (!inMeta || !outMeta || !amountText || tokenIn.toLowerCase() === tokenOut.toLowerCase()) return;
    let amountIn: bigint;
    try {
      amountIn = parseUnits(amountText, inMeta.decimals);
    } catch {
      return;
    }
    if (amountIn <= 0n) return;

    const id = ++seq.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      try {
        const q = await quoteSwap(pools, {
          tokenIn,
          tokenOut,
          amountIn,
          recipient: address ?? "0x000000000000000000000000000000000000dEaD",
          slippageBps,
          weth: WETH,
        });
        if (id !== seq.current) return; // a newer request superseded this one
        if (!q) {
          setOut(null);
          setStatus("No route for this pair yet.");
        } else {
          setStatus("");
          setOut({
            amountOut: q.quote.amountOut,
            minOut: q.quote.minAmountOut,
            via: q.quote.routeDescriptions,
            encoded: q.encoded,
            value: q.value,
          });
        }
      } finally {
        if (id === seq.current) setQuoting(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [tokenIn, tokenOut, amountText, slippageBps, pools, address, inMeta, outMeta]);

  const onRH = chainId === RH_CHAIN_ID;

  const doSwap = useCallback(async () => {
    if (!isConnected) {
      const inj = connectors[0];
      if (inj) connect({ connector: inj });
      return;
    }
    if (!onRH) {
      switchChain({ chainId: RH_CHAIN_ID });
      return;
    }
    if (!out || !inMeta || !address || !publicClient) return;

    try {
      const amountIn = parseUnits(amountText, inMeta.decimals);
      const isNativeIn = tokenIn.toLowerCase() === NATIVE_SENTINEL.toLowerCase();

      // ERC-20 input needs a standing allowance to the router; native does not.
      if (!isNativeIn) {
        const allowance = (await publicClient.readContract({
          address: tokenIn as `0x${string}`,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, MOLE_ADDRESSES.moleRouter],
        })) as bigint;
        if (allowance < amountIn) {
          setStatus("Approve the router…");
          const aHash = await writeContractAsync({
            address: tokenIn as `0x${string}`,
            abi: erc20Abi,
            functionName: "approve",
            args: [MOLE_ADDRESSES.moleRouter, amountIn],
            chainId: RH_CHAIN_ID,
          });
          await publicClient.waitForTransactionReceipt({ hash: aHash });
        }
      }

      setStatus("Swapping…");
      const hash = await writeContractAsync({
        address: MOLE_ADDRESSES.moleRouter,
        abi: moleRouterAbi,
        functionName: "swap",
        args: [out.encoded as never],
        value: out.value,
        chainId: RH_CHAIN_ID,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      // Swap analytics are sourced from MoleRouter's on-chain `Swapped` event by the indexer, not from a
      // client insert — a client-written analytics row is both unverifiable and (correctly) blocked by RLS,
      // so the UI does not attempt one.
      setStatus(`Swapped — ${hash.slice(0, 10)}…`);
    } catch (e) {
      setStatus(e instanceof Error ? e.message.split("\n")[0] : "Swap failed");
    }
  }, [isConnected, onRH, out, inMeta, address, publicClient, amountText, tokenIn, tokenOut, connect, connectors, switchChain, writeContractAsync]);

  const btnLabel = !isConnected
    ? "Connect wallet"
    : !onRH
      ? "Switch to Robinhood Chain"
      : quoting
        ? "Finding best route…"
        : out
          ? "Swap"
          : amountText
            ? "No route"
            : "Enter an amount";

  const priceLine = useMemo(() => {
    if (!out || !outMeta) return null;
    return `${fmtUnits(out.amountOut, outMeta.decimals)} ${outMeta.symbol}`;
  }, [out, outMeta]);

  return (
    <div style={styles.card}>
      <div style={styles.title}>Swap</div>

      <div style={styles.row}>
        <input
          style={styles.amount}
          placeholder="0.0"
          inputMode="decimal"
          value={amountText}
          onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
        />
        <select style={styles.select} value={tokenIn} onChange={(e) => setTokenIn(e.target.value)}>
          {tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>

      <div style={styles.arrow}>
        <button
          style={styles.flip}
          onClick={() => {
            setTokenIn(tokenOut);
            setTokenOut(tokenIn);
          }}
          aria-label="flip"
        >
          ↓
        </button>
      </div>

      <div style={styles.row}>
        <div style={styles.outAmount}>{priceLine ?? (quoting ? "…" : "0.0")}</div>
        <select style={styles.select} value={tokenOut} onChange={(e) => setTokenOut(e.target.value)}>
          {tokens.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>

      {out && outMeta && (
        <div style={styles.meta}>
          <div>
            Min received: {fmtUnits(out.minOut, outMeta.decimals)} {outMeta.symbol}
          </div>
          {out.via.map((v, i) => (
            <div key={i} style={styles.via}>
              via {v}
            </div>
          ))}
        </div>
      )}

      <div style={styles.slippage}>
        Slippage:
        {[10, 50, 100].map((b) => (
          <button
            key={b}
            style={{ ...styles.slipBtn, ...(slippageBps === b ? styles.slipActive : {}) }}
            onClick={() => setSlippageBps(b)}
          >
            {b / 100}%
          </button>
        ))}
      </div>

      <button style={styles.swapBtn} onClick={doSwap} disabled={quoting && isConnected && onRH}>
        {btnLabel}
      </button>

      {status && <div style={styles.status}>{status}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: { maxWidth: 420, margin: "40px auto", padding: 20, borderRadius: 20, background: "#12121a", color: "#eee", boxShadow: "0 8px 40px rgba(0,0,0,.4)", fontFamily: "system-ui, sans-serif" },
  title: { fontSize: 20, fontWeight: 700, marginBottom: 16 },
  row: { display: "flex", gap: 8, alignItems: "center", background: "#1c1c28", borderRadius: 14, padding: "12px 14px" },
  amount: { flex: 1, background: "transparent", border: "none", color: "#fff", fontSize: 26, outline: "none", width: "100%" },
  outAmount: { flex: 1, fontSize: 26, color: "#aab" },
  select: { background: "#26263a", color: "#fff", border: "none", borderRadius: 10, padding: "8px 10px", fontSize: 15, fontWeight: 600 },
  arrow: { display: "flex", justifyContent: "center", margin: "6px 0" },
  flip: { background: "#26263a", color: "#fff", border: "none", borderRadius: 10, width: 34, height: 34, cursor: "pointer" },
  meta: { marginTop: 12, fontSize: 13, color: "#99a", lineHeight: 1.6 },
  via: { color: "#7a7", fontSize: 12 },
  slippage: { display: "flex", gap: 8, alignItems: "center", margin: "14px 0", fontSize: 13, color: "#99a" },
  slipBtn: { background: "#1c1c28", color: "#ccd", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer" },
  slipActive: { background: "#3a3a5a", color: "#fff" },
  swapBtn: { width: "100%", padding: "14px", borderRadius: 14, border: "none", background: "#5b5bff", color: "#fff", fontSize: 16, fontWeight: 700, cursor: "pointer" },
  status: { marginTop: 12, fontSize: 13, color: "#bbc", wordBreak: "break-all" },
};
