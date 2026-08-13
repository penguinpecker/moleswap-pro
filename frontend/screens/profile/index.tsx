"use client";
import Link from "next/link";
import React, { useEffect, useState } from "react";
import { NavBar, BackgroundImage, MoleMascot } from "../shared";
import { Check, Copy, Share2, Wallet } from "lucide-react";
import { FaXTwitter } from "react-icons/fa6";
import { useWallet } from "@/lib/chain/provider";
import { getOrCreateUser, getUserRank } from "@/lib/supabase/api";

/* page-scoped Burrow styles — lifted from the profile.html prototype */
const PAGE_CSS = `
.pf-wrap { max-width: 560px; margin: 6px auto 0; position: relative; isolation: isolate; }
.pf-peek {
  position: absolute; left: -34px; top: 22%; width: 74px; height: 74px; z-index: -1;
  animation: peeksway 6s ease-in-out infinite;
}
.pf-peek .mole { display: block; position: static; width: 100%; height: 100%; }
@keyframes peeksway {
  0%, 100% { transform: rotate(-24deg) translateY(0); }
  50%      { transform: rotate(-21deg) translateY(-6px); }
}
@media (max-width: 720px) { .pf-peek { display: none; } }
.pf-card { padding: 24px; animation: cardin .45s ease backwards; }
@keyframes cardin { from { opacity: 0; transform: translateY(12px); } }
.pf-head { display: flex; gap: 16px; align-items: stretch; }
.pf-avatar {
  width: 96px; height: 96px; flex: none; border-radius: var(--r-md);
  background: linear-gradient(180deg, #fff, var(--cream-2));
  border: 3px solid rgba(44,26,12,.22); box-shadow: var(--sh-in);
  display: grid; place-items: center; overflow: hidden;
}
.pf-avatar .mole { display: block; position: static; width: 86%; height: 86%; }
@media (max-width: 460px) { .pf-avatar { width: 76px; height: 76px; } }
.pf-id { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 10px; }
.pf-name {
  padding: 9px 12px; border-radius: 10px;
  background: linear-gradient(180deg, #5b3119, #4a2712); color: #ffe6c4;
  border: 1px solid rgba(20,9,1,.55);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.12), 0 2px 0 rgba(42,24,10,.25);
  font-family: var(--font-num); font-size: 14px; font-weight: 700; letter-spacing: .02em;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pf-xpbar {
  position: relative; height: 26px; border-radius: 99px; overflow: hidden;
  background: var(--cream-2); border: 1px solid rgba(44,26,12,.18);
  box-shadow: inset 0 2px 4px rgba(44,26,12,.14);
}
.pf-xpbar i {
  display: block; height: 100%; width: 5%; border-radius: 99px;
  background: linear-gradient(180deg, #ffcd7d, var(--amber));
  box-shadow: inset 0 2px 0 rgba(255,255,255,.55);
  transition: width 500ms ease;
}
.pf-xpbar .xl {
  position: absolute; inset: 0; display: grid; place-items: center;
  font-family: var(--font-num); font-size: 12px; font-weight: 800; color: var(--ink);
  text-shadow: 0 1px 0 rgba(255,255,255,.5); letter-spacing: .02em;
}
.pf-wallet {
  margin-top: 18px; border-radius: var(--r-md); padding: 14px 15px;
  background: rgba(205,95,42,.10); border: 1px solid rgba(205,95,42,.28);
}
.pw-top {
  display: flex; align-items: center; gap: 8px;
  font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3);
}
.pw-top svg { color: var(--clay); flex: none; }
.pw-body { display: flex; align-items: center; gap: 12px; margin-top: 9px; }
.pw-addr {
  flex: 1; min-width: 0; font-family: var(--font-num); font-size: 12.5px; font-weight: 700;
  letter-spacing: .01em; word-break: break-all; user-select: all;
}
.pw-copy {
  flex: none; width: 40px; height: 40px; border-radius: 12px; cursor: pointer;
  display: grid; place-items: center;
  background: var(--p-chip); border: 1px solid var(--p-card-line); color: var(--p-card-ink-2);
  box-shadow: var(--p-card-sh);
}
.pw-copy:disabled { opacity: .4; cursor: default; }
.pw-copy:not(:disabled):active { transform: scale(.93); }
.pf-ranklbl { margin-top: 20px; font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.pf-plaques { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 9px; }
.plq {
  padding: 14px 15px; border-radius: var(--r-md); text-align: center;
  background: rgba(255,255,255,.62); border: 1px solid rgba(44,26,12,.09);
  box-shadow: inset 0 -2px 0 rgba(44,26,12,.05);
}
.plq .k { font-size: 10.5px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.plq .v { margin-top: 7px; font-family: var(--font-num); font-size: 1.35rem; font-weight: 700; letter-spacing: -.02em; }
.pf-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }
.pf-sq {
  width: 42px; height: 42px; border-radius: 12px; cursor: pointer;
  display: grid; place-items: center;
  background: var(--p-chip); border: 1px solid var(--p-card-line); color: var(--p-card-ink-2);
  box-shadow: var(--p-card-sh); text-decoration: none; font-size: 16px; font-weight: 800;
}
.pf-sq:active { transform: scale(.93); }
`;

const ProfilePage = () => {
  return (
    <>
      <BackgroundImage />
      <NavBar />
      <div className="w-full">
        <style>{PAGE_CSS}</style>

        {/* Hero */}
        <header className="hero">
          <span className="badge"><span className="dot" />Your digger card</span>
          <h1>Profile.</h1>
          <p className="sub">
            Your standing underground — XP, wallet address and where you rank
            among the diggers.
          </p>
          <MoleMascot />
        </header>

        <section className="pf-wrap">
          <span className="pf-peek" aria-hidden="true">
            <MoleMascot />
          </span>
          <ProfileCard />
        </section>
      </div>
    </>
  );
};

export default ProfilePage;

const ProfileCard = () => {
  const { address, isConnected } = useWallet();
  const [profile, setProfile] = useState<any>(null);
  const [rank, setRank] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isConnected && address) {
      setLoading(true);
      Promise.all([
        getOrCreateUser(address),
        getUserRank(address),
      ]).then(([user, rankData]) => {
        if (user) setProfile(user);
        if (rankData) setRank(rankData);
      }).catch(console.error).finally(() => setLoading(false));
    }
  }, [isConnected, address]);

  const displayName = profile?.username || (address ? address.slice(0, 16).toUpperCase() : "—");
  const displayXP = profile?.total_xp ?? 0;
  const maxXP = 1000; // XP bar max for visual fill
  const xpPct = Math.min((displayXP / maxXP) * 100, 100);
  const displayAddress = address?.toUpperCase() || "NOT CONNECTED";
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const shareProfile = () => {
    const text = `I'm ranked ${displayRank} on MoleSwap 🦫 — swap, provide liquidity, earn XP. https://moleswap.com`;
    if (typeof navigator !== "undefined" && (navigator as any).share) {
      (navigator as any).share({ title: "MoleSwap", text }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const displayRank = rank?.current_rank ? `#${rank.current_rank}` : (profile?.current_rank ? `#${profile.current_rank}` : "—");
  const displayBestRank = rank?.best_rank ? `#${rank.best_rank}` : (profile?.best_rank ? `#${profile.best_rank}` : "—");

  return (
    <div className="p-card pf-card">
      {/* Player Profile Header */}
      <div className="pf-head">
        {/* Avatar */}
        <div className="pf-avatar" aria-hidden="true">
          <MoleMascot />
        </div>

        {/* Name and XP Panel */}
        <div className="pf-id">
          {/* Player Name */}
          <div className="pf-name">{displayName}</div>

          {/* XP Bar */}
          <div className="pf-xpbar" aria-label="XP progress">
            {/* XP Bar Fill */}
            <i style={{ width: `${Math.max(xpPct, 5)}%` }} />
            {/* XP Text */}
            <span className="xl">XP - {displayXP}</span>
          </div>
        </div>
      </div>

      {/* Wallet Address Section */}
      <div className="pf-wallet">
        {/* Wallet Icon and Title */}
        <div className="pw-top">
          <Wallet size={14} />
          <span>Wallet address</span>
        </div>

        {/* Address with Copy Button */}
        <div className="pw-body">
          <div className="pw-addr">{displayAddress}</div>
          <button
            className="pw-copy"
            onClick={copyAddress}
            disabled={!address}
            title={copied ? "Copied!" : "Copy address"}
            aria-label="Copy address"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        </div>
      </div>

      {/* Leaderboard Rank */}
      <div className="pf-ranklbl">Leaderboard rank:</div>
      <div className="pf-plaques">
        <div className="plq">
          <div className="k">Current rank</div>
          <div className="v">{displayRank}</div>
        </div>
        <div className="plq">
          <div className="k">All time best</div>
          <div className="v">{displayBestRank}</div>
        </div>
      </div>

      <div className="pf-foot">
        <button
          type="button"
          className="pf-sq"
          onClick={shareProfile}
          title="Share your profile"
          aria-label="Share your profile"
        >
          <Share2 size={16} />
        </button>
        <Link
          className="pf-sq"
          href="https://x.com/moleswapcom"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="MoleSwap on X"
        >
          <FaXTwitter />
        </Link>
      </div>
    </div>
  );
};
