"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createPublicClient, http, type Address } from "viem";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { useWallet } from "@/lib/chain/provider";
import { robinhoodChain } from "@/lib/chain/wagmi-config";
import { ROBINHOOD_RPC_URL, MOLE_ADDRESSES } from "@/lib/mole/chain";
import {
  POOL_CREATOR, createMolePool, poolIdOf, priceToSqrtPriceX96, orderCurrencies,
} from "@/lib/mole/createPool";
import { seedNewPool } from "@/lib/mole/seedLiquidity";
import { searchIndex, popularTokens, type IndexedToken } from "@/lib/chain/tokenSearch";
import { CONTRACTS } from "@/lib/chain/contracts";
import { getTickAtSqrtRatio } from "@/lib/aggregator/math/tickMath";

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

  // Token picker over the REAL indexed universe — the same list the swap screen searches, so every
  // entry here is a token that actually exists on this chain with a real pool behind it. Pairing
  // against WETH is the default because that is the hub almost every memecoin on Robinhood Chain
  // quotes against.
  const [picker, setPicker] = useState<null | "A" | "B">(null);
  const [query, setQuery] = useState("");
  const [choices, setChoices] = useState<IndexedToken[]>([]);
  const [seeding, setSeeding] = useState(false);
  const [seedAmt0, setSeedAmt0] = useState("");
  const [seedAmt1, setSeedAmt1] = useState("");
  const [seedResult, setSeedResult] = useState<any>(null);

  useEffect(() => {
    if (!picker) return;
    let dead = false;
    (async () => {
      const list = query.trim().length >= 1 ? await searchIndex(query.trim(), 30) : await popularTokens(30);
      if (!dead) setChoices(list);
    })().catch(() => setChoices([]));
    return () => { dead = true; };
  }, [picker, query]);

  const pick = (t: IndexedToken) => {
    const set = picker === "A" ? setTokenA : setTokenB;
    const setMeta = picker === "A" ? setMetaA : setMetaB;
    set(t.address);
    setMeta({ symbol: t.symbol, decimals: t.decimals });
    setPicker(null);
    setQuery("");
  };

  const useWeth = (side: "A" | "B") => {
    const set = side === "A" ? setTokenA : setTokenB;
    const setMeta = side === "A" ? setMetaA : setMetaB;
    set(CONTRACTS.WETH);
    setMeta({ symbol: "WETH", decimals: 18 });
  };

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

  // A pool that has been initialised but never seeded is untradeable — quotes against it return
  // nothing. Seeding is therefore part of creating, not a separate errand.
  const onSeed = async () => {
    if (!preview || (preview as any).error || seeding) return;
    const p = preview as any;
    const a0 = Number(seedAmt0), a1 = Number(seedAmt1);
    if (!(a0 > 0) || !(a1 > 0)) { setStatus("Enter an amount of each token to seed."); return; }
    setSeeding(true);
    setSeedResult(null);
    const initialTick = getTickAtSqrtRatio(p.sqrtPriceX96);
    const r = await seedNewPool({
      currency0: p.ord.currency0,
      currency1: p.ord.currency1,
      tickSpacing: p.spacing,
      initialTick,
      amount0: BigInt(Math.floor(a0 * 10 ** p.ord.dec0)),
      amount1: BigInt(Math.floor(a1 * 10 ** p.ord.dec1)),
      onStep: setStatus,
    });
    setSeedResult(r);
    setStatus(r.success ? "Pool seeded — it is now tradeable." : (r.error || "Seed failed"));
    setSeeding(false);
  };

  return (
    <>
      <BackgroundImage isLoading={false} />
      <NavBar />

      <main>
        <header className="hero">
          <h1>Create pool.</h1>
          <p className="sub">Operator only — mint a new MoleHook v4 pool and admit it to the vault.</p>
          <MoleMascot />
        </header>

        <section style={{ maxWidth: 640 }}>
          {!isConnected ? (
            /* gate 1: not connected */
            <div className="p-card">
              <h3>Operator access</h3>
              <p className="d">Connect the poolCreator wallet to create a pool.</p>
            </div>
          ) : !isOperator ? (
            /* gate 2: connected but wrong wallet */
            <div className="p-card gate-wrong">
              <h3>Wrong wallet</h3>
              <p className="d">
                This wallet is not the poolCreator. Pool creation is gated on-chain to {POOL_CREATOR.slice(0, 10)}… — connect that key.
              </p>
            </div>
          ) : (
            /* operator form */
            <div className="p-card">
              <h3>New MoleHook v4 pool</h3>
              <p className="d">Initialize the pool, whitelist it in the vault, and register it with the aggregator — one flow.</p>

              {[
                { side: "A" as const, label: "Token A", val: tokenA, set: (v: string) => { setTokenA(v); loadMeta(v, setMetaA); }, meta: metaA },
                { side: "B" as const, label: "Token B", val: tokenB, set: (v: string) => { setTokenB(v); loadMeta(v, setMetaB); }, meta: metaB },
              ].map((f, i) => (
                <div key={f.label} className="p-field" style={{ marginTop: i === 0 ? 14 : 10 }}>
                  <div className="lbl">
                    <span>{f.label}</span>
                    {f.meta && <span className="meta">{f.meta.symbol} · {f.meta.decimals} dec</span>}
                  </div>
                  <div className="amt">
                    <input
                      className="big addr-in"
                      value={f.val}
                      onChange={(e) => f.set(e.target.value.trim())}
                      placeholder="0x… or pick a token"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={f.label}
                    />
                    <button className="p-btn pick" onClick={() => { setPicker(f.side); setQuery(""); }}>
                      PICK
                    </button>
                    <button className="p-btn pick" onClick={() => useWeth(f.side)}>
                      WETH
                    </button>
                  </div>
                </div>
              ))}

              <div className="p-grid p-2" style={{ marginTop: 10 }}>
                <div className="p-field">
                  <div className="lbl"><span>Initial price (B per A)</span></div>
                  <div className="amt">
                    <input
                      className="big"
                      value={priceBperA}
                      onChange={(e) => setPriceBperA(e.target.value.replace(/[^0-9.]/g, ""))}
                      placeholder="0.0"
                      inputMode="decimal"
                      aria-label="Initial price, B per A"
                    />
                  </div>
                </div>
                <div className="p-field">
                  <div className="lbl"><span>Tick spacing</span></div>
                  <div className="amt">
                    <input
                      className="big"
                      value={tickSpacing}
                      onChange={(e) => setTickSpacing(e.target.value.replace(/[^0-9]/g, ""))}
                      inputMode="numeric"
                      aria-label="Tick spacing"
                    />
                  </div>
                </div>
              </div>

              {preview && !(preview as any).error && (
                <div className="prev mono">
                  <div>currency0: {(preview as any).sym0} ({(preview as any).ord.currency0.slice(0, 10)}…)</div>
                  <div>currency1: {(preview as any).sym1} ({(preview as any).ord.currency1.slice(0, 10)}…)</div>
                  <div>price c1/c0: {(preview as any).price0to1}</div>
                  <div style={{ wordBreak: "break-all" }}>poolId: {(preview as any).poolId}</div>
                </div>
              )}
              {preview && (preview as any).error && (preview as any).error.length > 0 && (
                <div className="statline err" style={{ textAlign: "left" }}>{(preview as any).error}</div>
              )}

              <button className="p-btn up" onClick={onCreate} disabled={busy || !preview || !!(preview as any)?.error || !onRH}>
                {!onRH ? "Switch to Robinhood" : busy ? "Working…" : "Create + whitelist pool"}
              </button>

              {status && <div className="statline">{status}</div>}
              {result?.success && (
                <div className="okbox">
                  <div style={{ wordBreak: "break-all" }}>pool: {result.poolId}</div>
                  <div style={{ marginTop: 6 }}>initialize: {result.txInit?.slice(0, 14)}… · whitelist: {result.txWhitelist?.slice(0, 14)}…</div>
                  <div style={{ marginTop: 6 }}>registered for routing: {result.registered ? "yes" : "no (see status)"}</div>
                </div>
              )}

              {result?.success && !seedResult?.success && (
                <div className="p-card seedbox">
                  <h3>Seed the first liquidity</h3>
                  <p className="d">
                    The pool exists but is empty, so nothing can trade against it yet. The vault&apos;s
                    one-tap zap can&apos;t bootstrap it — that swaps half your deposit inside this very
                    pool, and there is nothing here to swap against. Put in both sides once and it goes live.
                  </p>
                  {[
                    { label: `${(preview as any)?.sym0 ?? "currency0"} amount`, val: seedAmt0, set: setSeedAmt0 },
                    { label: `${(preview as any)?.sym1 ?? "currency1"} amount`, val: seedAmt1, set: setSeedAmt1 },
                  ].map((f, i) => (
                    <div key={f.label} className="p-field" style={{ marginTop: i === 0 ? 12 : 10 }}>
                      <div className="lbl"><span>{f.label}</span></div>
                      <div className="amt">
                        <input className="big" inputMode="decimal" value={f.val} placeholder="0.0"
                          onChange={(e) => f.set(e.target.value.replace(/[^0-9.]/g, ""))} aria-label={f.label} />
                      </div>
                    </div>
                  ))}
                  <button className="p-btn up" onClick={onSeed} disabled={seeding || !onRH}>
                    {seeding ? "Seeding…" : "Seed liquidity"}
                  </button>
                </div>
              )}

              {seedResult?.success && (
                <div className="okbox">
                  <div>seeded — position #{seedResult.positionId}, liquidity {seedResult.liquidity}</div>
                  <div style={{ marginTop: 6, wordBreak: "break-all" }}>tx: {seedResult.txHash}</div>
                  <Link href="/pools" className="seed-btn">View it in pools →</Link>
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {picker && (
        <div className="cm-scrim" onClick={() => setPicker(null)}>
          <div className="cm-panel" onClick={(e) => e.stopPropagation()}>
            <h3>Select a token</h3>
            <input
              className="big tk-search" autoFocus value={query} placeholder="Search name, symbol or paste an address"
              onChange={(e) => setQuery(e.target.value)} spellCheck={false} aria-label="Search tokens"
            />
            <div className="tk-list">
              {choices.length === 0 && <div className="tk-empty">No tokens found.</div>}
              {choices.map((t) => (
                <button key={t.address} className="tk-row" onClick={() => pick(t)}>
                  {t.logoURI
                    ? <img className="tk-logo" src={t.logoURI} alt="" />
                    : <span className="tk-logo tk-fallback">{t.symbol.slice(0, 2)}</span>}
                  <span className="tk-txt">
                    <span className="tk-sym">{t.symbol}</span>
                    <span className="tk-name">{t.name}</span>
                  </span>
                  {t.liquidity != null && t.liquidity > 0 && (
                    <span className="tk-liq">{t.liquidity.toFixed(2)} WETH</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* page: create-pool — from the Burrow prototype */}
      <style jsx global>{`
        .p-btn.pick { height: 38px; padding: 0 12px; margin-left: 8px; font-size: 11px; letter-spacing: .05em; flex: 0 0 auto; }
        .seedbox { margin-top: 14px; }
        .tk-search { width: 100%; margin-top: 10px; }
        .tk-list { margin-top: 12px; max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
        .tk-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 12px;
          background: rgba(255,255,255,.5); border: 1px solid rgba(44,26,12,.1); cursor: pointer; text-align: left; }
        .tk-row:hover { background: rgba(255,255,255,.85); }
        .tk-logo { width: 28px; height: 28px; border-radius: 50%; flex: 0 0 auto; object-fit: cover; }
        .tk-fallback { display: flex; align-items: center; justify-content: center; background: var(--amber);
          color: #3d2410; font-family: var(--font-ui); font-weight: 800; font-size: 10px; }
        .tk-txt { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
        .tk-sym { font-family: var(--font-ui); font-weight: 800; font-size: 13px; color: var(--ink); }
        .tk-name { font-size: 11px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .tk-liq { font-family: var(--font-num); font-size: 11px; color: var(--moss); flex: 0 0 auto; }
        .tk-empty { padding: 18px; text-align: center; color: var(--ink-2); font-size: 12px; }
        .addr-in { font-family: var(--font-num) !important; font-size: 15px !important; letter-spacing: 0 !important; }
        .p-field .lbl .meta { font-family: var(--font-num); color: var(--moss); font-weight: 700; letter-spacing: 0; text-transform: none; }
        .prev { margin-top: 12px; padding: 12px 14px; border-radius: var(--r-md);
          background: rgba(255,255,255,.55); border: 1px solid rgba(44,26,12,.12);
          font-size: 12px; line-height: 1.8; color: var(--ink-2); }
        .okbox { margin-top: 14px; padding: 13px 15px; border-radius: var(--r-md);
          background: rgba(47,125,79,.09); border: 1px solid rgba(47,125,79,.35);
          font-family: var(--font-num); font-size: 12px; line-height: 1.7; color: var(--ink-2); }
        .seed-btn { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 12px; height: 44px;
          border-radius: 13px; text-decoration: none; font-family: var(--font-ui); font-weight: 800; font-size: 12.5px;
          letter-spacing: .06em; text-transform: uppercase;
          background: linear-gradient(180deg, #ffcd7d, var(--amber)); color: #3d2410;
          box-shadow: 0 3px 0 #8c4a14, inset 0 1px 0 rgba(255,255,255,.5); }
        .seed-btn:active { transform: translateY(1px); box-shadow: 0 1px 0 #8c4a14, inset 0 1px 0 rgba(255,255,255,.5); }
        .p-btn:disabled { opacity: .6; cursor: default; }
        .p-btn:disabled:active { transform: none; }
        .p-btn.up { text-transform: uppercase; letter-spacing: .05em; font-size: 14px; }
        .gate-wrong { border: 1px solid rgba(184,55,31,.5); }
        .gate-wrong .d { color: var(--rust); }
      `}</style>
    </>
  );
}
