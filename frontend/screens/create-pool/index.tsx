"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, type Address } from "viem";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/lib/chain/provider";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { ROBINHOOD_RPC_URL, MOLE_ADDRESSES } from "@/lib/mole/chain";
import {
  POOL_CREATOR, createMolePool, poolIdOf, priceToSqrtPriceX96, orderCurrencies,
} from "@/lib/mole/createPool";

const ZERO = "0x0000000000000000000000000000000000000000";
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

const tokenMetaAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export default function CreatePoolPage() {
  const { address, isConnected, onRH } = useWallet();
  const isOperator = !!address && address.toLowerCase() === POOL_CREATOR;

  const [tokenA, setTokenA] = useState("");
  const [tokenB, setTokenB] = useState("");
  const [priceBperA, setPriceBperA] = useState("");
  const [tickSpacing, setTickSpacing] = useState("60");
  const [metaA, setMetaA] = useState<{ symbol: string; decimals: number } | null>(null);
  const [metaB, setMetaB] = useState<{ symbol: string; decimals: number } | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const loadMeta = async (addr: string, set: (m: { symbol: string; decimals: number } | null) => void) => {
    if (!isAddr(addr)) { set(null); return; }
    if (addr.toLowerCase() === ZERO) { set({ symbol: "ETH", decimals: 18 }); return; }
    try {
      const pub = createPublicClient({ chain: robinhoodChain, transport: http(ROBINHOOD_RPC_URL) });
      const [symbol, decimals] = await Promise.all([
        pub.readContract({ address: addr as Address, abi: tokenMetaAbi, functionName: "symbol" }) as Promise<string>,
        pub.readContract({ address: addr as Address, abi: tokenMetaAbi, functionName: "decimals" }) as Promise<number>,
      ]);
      set({ symbol, decimals: Number(decimals) });
    } catch {
      set(null);
    }
  };

  // Sorted preview: currency0/currency1, price in currency1-per-currency0, poolId, sqrtPriceX96.
  const preview = useMemo(() => {
    if (!isAddr(tokenA) || !isAddr(tokenB) || !metaA || !metaB) return null;
    if (tokenA.toLowerCase() === tokenB.toLowerCase()) return { error: "The two tokens must be different" };
    const price = Number(priceBperA);
    if (!(price > 0)) return { error: "" };
    const ord = orderCurrencies(tokenA as Address, metaA.decimals, tokenB as Address, metaB.decimals);
    // price0to1 = currency1 per currency0. User gave B-per-A; invert if sorting put B as currency0.
    const price0to1 = ord.currency0.toLowerCase() === tokenA.toLowerCase() ? price : 1 / price;
    const spacing = Math.max(1, parseInt(tickSpacing) || 60);
    try {
      const sqrtPriceX96 = priceToSqrtPriceX96(price0to1, ord.dec0, ord.dec1);
      const key = { currency0: ord.currency0, currency1: ord.currency1, fee: 0x800000, tickSpacing: spacing, hooks: MOLE_ADDRESSES.moleHook as Address };
      const sym0 = ord.currency0.toLowerCase() === tokenA.toLowerCase() ? metaA.symbol : metaB.symbol;
      const sym1 = ord.currency0.toLowerCase() === tokenA.toLowerCase() ? metaB.symbol : metaA.symbol;
      return { ord, price0to1, sqrtPriceX96, poolId: poolIdOf(key), spacing, sym0, sym1 };
    } catch (e: any) {
      return { error: e?.message || "Invalid price" };
    }
  }, [tokenA, tokenB, priceBperA, tickSpacing, metaA, metaB]);

  const onCreate = async () => {
    if (!preview || (preview as any).error || busy) return;
    const p = preview as any;
    setBusy(true);
    setResult(null);
    setStatus("Creating pool (initialize + whitelist)…");
    const r = await createMolePool({
      currency0: p.ord.currency0, currency1: p.ord.currency1, tickSpacing: p.spacing, sqrtPriceX96: p.sqrtPriceX96,
    });
    if (!r.success) { setStatus(r.error || "Create failed"); setBusy(false); return; }

    setStatus("Registering pool with the aggregator…");
    let registered = false;
    try {
      const res = await fetch("/api/admin/register-pool", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ currency0: p.ord.currency0, currency1: p.ord.currency1, tickSpacing: p.spacing }),
      });
      const j = await res.json();
      registered = !!j?.data?.registered;
    } catch { /* registration best-effort */ }

    setResult({ ...r, registered });
    setStatus(registered ? "Pool created, whitelisted, and routing." : "Pool created + whitelisted. Registry write pending (configure MP_WRITE_SECRET or register out-of-band).");
    setBusy(false);
  };

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-2 sm:gap-4">
      <BackgroundImage isLoading={false} />
      <div className="relative z-50 mx-auto mt-2 flex w-full flex-col-reverse gap-2 px-2 sm:mt-4 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="flex-1"><NavBar /></div>
        <div className="bg-peach-500 font-family-ThaleahFat shrink-0 rounded-lg border-3 border-[#523525] px-3 py-2 text-base tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] sm:py-3 sm:text-2xl">
          <ConnectWalletButton />
        </div>
      </div>

      <div className="relative z-20 mt-4 mb-[10%] flex w-full max-w-xl flex-1 flex-col items-center gap-4 px-3 sm:mt-10">
        <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-3xl font-bold tracking-widest uppercase sm:text-5xl">
          CREATE POOL
        </h1>
        <p className="font-family-ThaleahFat text-center text-sm tracking-wider text-gray-200">
          OPERATOR ONLY — MINT A NEW MOLEHOOK v4 POOL AND ADMIT IT TO THE VAULT
        </p>

        {!isConnected ? (
          <div className="bg-ground w-full rounded-2xl border-3 border-[#523525] p-6 text-center">
            <p className="font-family-ThaleahFat tracking-wider text-gray-200">Connect the poolCreator wallet to create a pool.</p>
          </div>
        ) : !isOperator ? (
          <div className="bg-ground w-full rounded-2xl border-3 border-[#7a2f2f] p-6 text-center">
            <p className="font-family-ThaleahFat tracking-wider text-red-300">
              This wallet is not the poolCreator. Pool creation is gated on-chain to {POOL_CREATOR.slice(0, 10)}… — connect that key.
            </p>
          </div>
        ) : (
          <div className="bg-ground w-full rounded-2xl border-3 border-[#523525] p-5 shadow-[6px_6px_0_#000]">
            {[
              { label: "TOKEN A (address)", val: tokenA, set: (v: string) => { setTokenA(v); loadMeta(v, setMetaA); }, meta: metaA },
              { label: "TOKEN B (address)", val: tokenB, set: (v: string) => { setTokenB(v); loadMeta(v, setMetaB); }, meta: metaB },
            ].map((f) => (
              <div key={f.label} className="mb-3">
                <div className="mb-1 flex justify-between">
                  <span className="font-family-ThaleahFat text-xs tracking-wider text-peach-300">{f.label}</span>
                  {f.meta && <span className="font-family-ThaleahFat text-xs tracking-wider text-yellow-200">{f.meta.symbol} · {f.meta.decimals} dec</span>}
                </div>
                <input value={f.val} onChange={(e) => f.set(e.target.value.trim())} placeholder="0x…"
                  className="font-family-ThaleahFat w-full rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-3 py-2 font-mono text-sm text-white outline-none" />
              </div>
            ))}
            <div className="mb-3 grid grid-cols-2 gap-3">
              <div>
                <div className="font-family-ThaleahFat mb-1 text-xs tracking-wider text-peach-300">INITIAL PRICE (B per A)</div>
                <input value={priceBperA} onChange={(e) => setPriceBperA(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" inputMode="decimal"
                  className="font-family-ThaleahFat w-full rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-3 py-2 text-lg text-white outline-none" />
              </div>
              <div>
                <div className="font-family-ThaleahFat mb-1 text-xs tracking-wider text-peach-300">TICK SPACING</div>
                <input value={tickSpacing} onChange={(e) => setTickSpacing(e.target.value.replace(/[^0-9]/g, ""))}
                  className="font-family-ThaleahFat w-full rounded-xl border-2 border-[#523525] bg-[#2a1c12] px-3 py-2 text-lg text-white outline-none" />
              </div>
            </div>

            {preview && !(preview as any).error && (
              <div className="mb-3 rounded-xl border-2 border-[#5a4a2a] bg-[#2a2213] px-4 py-3 font-mono text-xs text-gray-200">
                <div>currency0: {(preview as any).sym0} ({(preview as any).ord.currency0.slice(0, 10)}…)</div>
                <div>currency1: {(preview as any).sym1} ({(preview as any).ord.currency1.slice(0, 10)}…)</div>
                <div>price c1/c0: {(preview as any).price0to1}</div>
                <div className="break-all">poolId: {(preview as any).poolId}</div>
              </div>
            )}
            {preview && (preview as any).error && (preview as any).error.length > 0 && (
              <p className="font-family-ThaleahFat mb-3 text-sm tracking-wider text-red-300">{(preview as any).error}</p>
            )}

            <button onClick={onCreate} disabled={busy || !preview || !!(preview as any)?.error || !onRH}
              className="font-family-ThaleahFat w-full cursor-pointer rounded-xl border-3 border-[#3f7d20] bg-[#4e9d2a] px-4 py-3 text-xl font-bold tracking-wider text-white shadow-[0px_4px_0px_#2f6318] transition-all hover:brightness-110 active:translate-y-0.5 disabled:opacity-60">
              {!onRH ? "SWITCH TO ROBINHOOD" : busy ? "WORKING…" : "CREATE + WHITELIST POOL"}
            </button>

            {status && <div className="font-family-ThaleahFat mt-3 text-center text-sm tracking-wider break-all text-peach-300">{status}</div>}
            {result?.success && (
              <div className="mt-3 rounded-xl border-2 border-[#3f7d20] bg-[#1e2a13] px-4 py-3 text-xs text-gray-200">
                <div className="break-all">pool: {result.poolId}</div>
                <div>initialize: {result.txInit?.slice(0, 14)}… · whitelist: {result.txWhitelist?.slice(0, 14)}…</div>
                <div>registered for routing: {result.registered ? "yes" : "no (see status)"}</div>
                <Link href="/vault" className="font-family-ThaleahFat mt-2 inline-block cursor-pointer rounded-lg border-2 border-[#C97E00] bg-[#523525] px-4 py-2 text-sm tracking-wider text-yellow-200">
                  SEED LIQUIDITY IN VAULT →
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
