"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { parseUnits, formatUnits, type Address } from "viem";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/lib/chain/provider";
import { WETH, USDG } from "@/lib/mole/chain";
import { createOrder, cancelOrder, getOrders, type MoleOrder } from "@/lib/mole/orders";

const TOKENS = [WETH, USDG];
type Mode = "dca" | "limit";

const FREQS: { label: string; secs: number }[] = [
  { label: "HOURLY", secs: 3600 },
  { label: "EVERY 6H", secs: 21600 },
  { label: "DAILY", secs: 86400 },
  { label: "WEEKLY", secs: 604800 },
];

function metaOf(addr: string) {
  return TOKENS.find((t) => t.address.toLowerCase() === addr.toLowerCase());
}
function fmtRaw(v: bigint, addr: string) {
  const d = metaOf(addr)?.decimals ?? 18;
  const s = formatUnits(v, d);
  return s.includes(".") ? s.replace(/(\.\d{0,6})\d*$/, "$1").replace(/\.?0+$/, "") || "0" : s;
}
function symOf(addr: string) {
  return metaOf(addr)?.symbol ?? `${addr.slice(0, 6)}…`;
}

export default function OrdersScreen({ mode }: { mode: Mode }) {
  const { address, isConnected, onRH } = useWallet();
  const isDca = mode === "dca";

  // DCA: pay `payIdx` → buy the other, total over N legs at a frequency.
  // Limit: sell `payIdx` → receive the other when 1 pay >= `price` receive.
  const [payIdx, setPayIdx] = useState(1); // default: pay USDG
  const [total, setTotal] = useState("");
  const [legs, setLegs] = useState("10");
  const [freqIdx, setFreqIdx] = useState(2); // daily
  const [price, setPrice] = useState(""); // limit: receive-per-pay
  const [orders, setOrders] = useState<MoleOrder[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const payTok = TOKENS[payIdx];
  const recvTok = TOKENS[payIdx === 0 ? 1 : 0];

  const refresh = useCallback(async () => {
    if (!address) return setOrders([]);
    try {
      setOrders(await getOrders(address));
    } catch {
      setOrders([]);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const preview = useMemo(() => {
    try {
      if (isDca) {
        const n = Math.max(1, parseInt(legs) || 0);
        const totalWei = total ? parseUnits(total, payTok.decimals) : 0n;
        if (totalWei <= 0n) return null;
        const perLeg = totalWei / BigInt(n);
        if (perLeg <= 0n) return null;
        return { perLeg, totalWei, n, minOut: 1n, interval: FREQS[freqIdx].secs };
      }
      const amtWei = total ? parseUnits(total, payTok.decimals) : 0n;
      const px = Number(price);
      if (amtWei <= 0n || !(px > 0)) return null;
      // minOut (receive units) = amount(pay, human) * price
      const minOut = parseUnits((Number(total) * px).toFixed(recvTok.decimals), recvTok.decimals);
      return { perLeg: amtWei, totalWei: amtWei, n: 1, minOut, interval: 0 };
    } catch {
      return null;
    }
  }, [isDca, total, legs, freqIdx, price, payTok.decimals, recvTok.decimals]);

  const onCreate = async () => {
    if (!preview || busy || !isConnected || !onRH) return;
    setBusy(true);
    setStatus("");
    const r = await createOrder({
      tokenIn: payTok.address as Address,
      tokenOut: recvTok.address as Address,
      amountPerLeg: preview.perLeg,
      totalBudget: preview.totalWei,
      minOutPerLeg: preview.minOut < 1n ? 1n : preview.minOut,
      intervalSeconds: preview.interval,
      onStep: setStatus,
    });
    setStatus(r.success ? `Order #${r.orderId} created — the keeper will execute it.` : r.error || "Failed");
    if (r.success) {
      setTotal("");
      setPrice("");
      refresh();
    }
    setBusy(false);
  };

  const onCancel = async (id: string) => {
    setBusy(true);
    setStatus(`Cancelling #${id}…`);
    const r = await cancelOrder(id);
    setStatus(r.success ? `Cancelled #${id}.` : r.error || "Failed");
    setBusy(false);
    refresh();
  };

  const cta = !isConnected
    ? "CONNECT WALLET"
    : !onRH
      ? "SWITCH TO ROBINHOOD"
      : busy
        ? "WORKING…"
        : !preview
          ? "ENTER DETAILS"
          : isDca
            ? "START DCA"
            : "PLACE LIMIT ORDER";

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-2 sm:gap-4">
      <BackgroundImage isLoading={false} />
      <div className="relative z-50 mx-auto mt-2 flex w-full flex-col-reverse gap-2 px-2 sm:mt-4 sm:flex-row sm:items-center sm:gap-4 sm:px-4">
        <div className="flex-1">
          <NavBar />
        </div>
        <div className="bg-peach-500 font-family-ThaleahFat shrink-0 rounded-lg border-3 border-[#523525] px-3 py-2 text-base tracking-wider text-black shadow-[0px_-6px_0px_0px_#C97E00_inset,0px_7.5px_0px_0px_rgba(255,212,122,0.6)_inset] sm:py-3 sm:text-2xl">
          <ConnectWalletButton />
        </div>
      </div>

      <div className="relative z-20 mx-auto mt-2 w-full max-w-2xl px-3 sm:mt-4">
        <div className="relative rounded-lg px-4 py-4 text-center">
          <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full" />
          <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-3xl font-bold tracking-widest uppercase sm:text-5xl">
            {isDca ? "DCA" : "LIMIT ORDERS"}
          </h1>
          <p className="font-family-ThaleahFat mt-1 text-sm tracking-wider text-gray-200">
            {isDca
              ? "AUTO-BUY ON A SCHEDULE · NON-CUSTODIAL · A KEEPER EXECUTES, IT CAN'T TOUCH YOUR FUNDS"
              : "SWAP WHEN THE PRICE HITS YOUR TARGET · NON-CUSTODIAL · YOUR FLOOR IS ENFORCED ON-CHAIN"}
          </p>
        </div>
      </div>

      <div className="relative z-20 mb-[8%] flex w-full max-w-2xl flex-1 flex-col gap-3 px-3">
        {/* Create card */}
        <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
          <div className="border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
            <span className="font-family-ThaleahFat text-xl tracking-wider text-white">{isDca ? "+ NEW DCA" : "+ NEW LIMIT ORDER"}</span>
          </div>
          <div className="flex flex-col gap-3 px-4 py-3">
            {/* Pair */}
            <div className="flex items-center gap-2">
              <span className="font-family-ThaleahFat text-base text-gray-200">{isDca ? "PAY WITH" : "SELL"}</span>
              <div className="flex gap-1">
                {TOKENS.map((t, i) => (
                  <button
                    key={t.symbol}
                    onClick={() => setPayIdx(i)}
                    className={`font-family-ThaleahFat rounded-lg border-2 px-3 py-1 text-lg tracking-wider ${
                      payIdx === i ? "border-[#6DBB3E] bg-[#6DBB3E]/10 text-[#6DBB3E]" : "border-[#3A1F0E] text-gray-300"
                    }`}
                  >
                    {t.symbol}
                  </button>
                ))}
              </div>
              <span className="font-family-ThaleahFat text-base text-gray-200">→ {isDca ? "BUY" : "RECEIVE"} {recvTok.symbol}</span>
            </div>

            {/* Amount */}
            <div className="relative rounded px-3 py-2.5">
              <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
              <div className="font-family-ThaleahFat mb-1 text-sm text-gray-300">{isDca ? `TOTAL TO SPEND (${payTok.symbol})` : `AMOUNT TO SELL (${payTok.symbol})`}</div>
              <input value={total} onChange={(e) => setTotal(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" inputMode="decimal"
                className="font-family-ThaleahFat w-full bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
            </div>

            {isDca ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="relative rounded px-3 py-2.5">
                  <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
                  <div className="font-family-ThaleahFat mb-1 text-sm text-gray-300">NUMBER OF ORDERS</div>
                  <input value={legs} onChange={(e) => setLegs(e.target.value.replace(/[^0-9]/g, ""))}
                    className="font-family-ThaleahFat w-full bg-transparent text-2xl tracking-wider text-white focus:outline-none" />
                </div>
                <div className="relative rounded px-3 py-2.5">
                  <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
                  <div className="font-family-ThaleahFat mb-1 text-sm text-gray-300">FREQUENCY</div>
                  <div className="flex flex-wrap gap-1">
                    {FREQS.map((f, i) => (
                      <button key={f.label} onClick={() => setFreqIdx(i)}
                        className={`font-family-ThaleahFat rounded border px-2 py-0.5 text-sm ${freqIdx === i ? "border-[#6DBB3E] text-[#6DBB3E]" : "border-[#3A1F0E] text-gray-400"}`}>
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="relative rounded px-3 py-2.5">
                <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
                <div className="font-family-ThaleahFat mb-1 text-sm text-gray-300">TARGET PRICE — RECEIVE AT LEAST</div>
                <div className="flex items-center gap-2">
                  <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" inputMode="decimal"
                    className="font-family-ThaleahFat w-full bg-transparent text-2xl tracking-wider text-white placeholder:text-gray-600 focus:outline-none" />
                  <span className="font-family-ThaleahFat whitespace-nowrap text-base text-gray-300">{recvTok.symbol} per {payTok.symbol}</span>
                </div>
              </div>
            )}

            {/* Summary */}
            {preview && (
              <div className="relative rounded px-3 py-2">
                <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
                {(isDca
                  ? [
                      ["PER ORDER", `${fmtRaw(preview.perLeg, payTok.address)} ${payTok.symbol}`],
                      ["ORDERS", `${preview.n} × ${FREQS[freqIdx].label.toLowerCase()}`],
                      ["PRICE FLOOR", "MARKET (keeper slippage-guards each fill)"],
                      ["CUSTODY", "NON-CUSTODIAL · OUTPUT → YOU"],
                    ]
                  : [
                      ["YOU SELL", `${total} ${payTok.symbol}`],
                      ["FILLS WHEN", `≥ ${fmtRaw(preview.minOut, recvTok.address)} ${recvTok.symbol}`],
                      ["FLOOR", "ENFORCED ON-CHAIN"],
                      ["CUSTODY", "NON-CUSTODIAL · OUTPUT → YOU"],
                    ]
                ).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 py-0.5">
                    <span className="font-family-ThaleahFat text-base text-gray-200">{k}</span>
                    <span className="font-family-ThaleahFat text-base text-peach-300">{v}</span>
                  </div>
                ))}
              </div>
            )}

            <button onClick={onCreate} disabled={busy || !isConnected || !onRH || !preview}
              className="font-family-ThaleahFat w-full cursor-pointer rounded-lg bg-[#6DBB3E] px-6 py-3 text-xl tracking-wider text-white shadow-[0px_-4px_0px_0px_#4A8B29_inset,0px_4px_0px_0px_rgba(255,255,255,0.3)_inset] transition-all hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100">
              {cta}
            </button>
            {status && <div className="font-family-ThaleahFat text-center text-sm tracking-wider break-all text-peach-300">{status}</div>}
          </div>
        </div>

        {/* Orders list */}
        <div className="overflow-hidden rounded-lg border-3 border-[#3A1F0E] bg-gradient-to-b from-[#52301A] to-[#4A2C15]">
          <div className="flex items-center justify-between border-b-2 border-[#3A1F0E] bg-black/20 px-4 py-3">
            <span className="font-family-ThaleahFat text-xl tracking-wider text-white">YOUR ORDERS</span>
            <button onClick={refresh} className="font-family-ThaleahFat cursor-pointer text-sm tracking-wider text-peach-300 hover:text-white">⟳ REFRESH</button>
          </div>
          <div className="px-4 py-3">
            {!isConnected ? (
              <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">Connect a wallet to see your orders.</p>
            ) : orders.length === 0 ? (
              <p className="font-family-ThaleahFat py-4 text-center text-sm tracking-wider text-gray-400">No orders yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {orders.map((o) => {
                  const pct = o.totalBudget > 0n ? Number((o.spent * 100n) / o.totalBudget) : 0;
                  const isLimit = o.interval === 0;
                  return (
                    <div key={o.id} className="relative rounded px-4 py-3">
                      <Image src="/quest/header-quest-bg.png" alt="" width={200} height={200} className="absolute inset-0 z-[-1] h-full w-full rounded" />
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-family-ThaleahFat tracking-wider">
                          <div className="text-peach-300 text-lg">
                            #{o.id} · {symOf(o.tokenIn)} → {symOf(o.tokenOut)} · {isLimit ? "LIMIT" : "DCA"}
                          </div>
                          <div className="text-xs text-gray-400">
                            {fmtRaw(o.spent, o.tokenIn)} / {fmtRaw(o.totalBudget, o.tokenIn)} {symOf(o.tokenIn)} filled ({pct}%)
                            {isLimit ? ` · floor ${fmtRaw(o.minOutPerLeg, o.tokenOut)} ${symOf(o.tokenOut)}` : ` · every ${Math.round(o.interval / 3600)}h`}
                          </div>
                        </div>
                        <span className={`font-family-ThaleahFat text-sm ${o.active ? "text-[#6DBB3E]" : "text-gray-400"}`}>{o.active ? "ACTIVE" : "DONE"}</span>
                        {o.active && (
                          <button onClick={() => onCancel(o.id)} disabled={busy}
                            className="font-family-ThaleahFat cursor-pointer rounded-lg bg-red-600 px-3 py-1.5 text-sm tracking-wider text-white shadow-[0px_-2px_0px_0px_#991B1B_inset] disabled:opacity-60">
                            CANCEL
                          </button>
                        )}
                      </div>
                      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-black/30">
                        <div className="h-full bg-[#6DBB3E]" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
