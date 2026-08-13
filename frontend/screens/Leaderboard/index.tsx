"use client";
import { ChevronLeft, ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import React, { useState, useEffect } from "react";
import { NavBar, BackgroundImage, MoleMascot } from "../shared";
import { getLeaderboard } from "@/lib/supabase/api";

const EXPLORER_URL = "https://robinhoodchain.blockscout.com/address/";
const PLAYERS_PER_PAGE = 25;

/* page-scoped Burrow styles — lifted from the leaderboard.html prototype */
const PAGE_CSS = `
.lb-head {
  display: grid; grid-template-columns: 56px minmax(0,1fr) auto; gap: 14px; align-items: center;
  padding: 0 20px; height: 46px;
  background: linear-gradient(180deg, #40270f, #331d0b);
  color: rgba(255,230,196,.72);
  font-size: 11px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase;
}
.lb-head .r { text-align: right; }
.lb-row {
  position: relative; display: grid; grid-template-columns: 56px minmax(0,1fr) auto; gap: 14px;
  align-items: center; padding: 11px 20px; min-height: 66px;
  border-bottom: 1px solid rgba(44,26,12,.07);
  animation: rowin .38s ease backwards;
}
@keyframes rowin { from { opacity: 0; transform: translateY(9px); } }
.lb-row:last-child { border-bottom: 0; }
.lb-row.top1 { background: linear-gradient(90deg, rgba(233,181,52,.20), rgba(233,181,52,.04)); }
.lb-row.top2 { background: linear-gradient(90deg, rgba(148,155,170,.22), rgba(148,155,170,.04)); }
.lb-row.top3 { background: linear-gradient(90deg, rgba(200,118,54,.18), rgba(200,118,54,.04)); }
.lb-row > * { position: relative; }
.lb-tile {
  width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center;
  font-family: var(--font-num); font-size: 14px; font-weight: 700; color: var(--ink-2);
  background: rgba(44,26,12,.08); border: 1px solid rgba(44,26,12,.10);
}
.lb-tile.t1 { font-size: 19px; background: linear-gradient(180deg,#ffe08a,#e8ad2e); border-color: #c8901f; box-shadow: 0 2px 0 rgba(140,90,10,.45), inset 0 1px 0 rgba(255,255,255,.6); }
.lb-tile.t2 { font-size: 19px; background: linear-gradient(180deg,#eceef2,#b9bdc9); border-color: #9aa0af; box-shadow: 0 2px 0 rgba(90,95,110,.4), inset 0 1px 0 rgba(255,255,255,.7); }
.lb-tile.t3 { font-size: 19px; background: linear-gradient(180deg,#eab887,#c07a3e); border-color: #a2622d; box-shadow: 0 2px 0 rgba(120,70,25,.45), inset 0 1px 0 rgba(255,255,255,.5); }
.lb-who { display: flex; align-items: center; gap: 12px; min-width: 0; }
.lb-av {
  width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center;
  font-size: 16px; font-weight: 800; color: var(--ink-2);
  background: rgba(255,255,255,.75); border: 1px solid rgba(44,26,12,.14);
  box-shadow: inset 0 -2px 3px rgba(44,26,12,.08);
}
.lb-nm { font-size: 14.5px; font-weight: 750; letter-spacing: -.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb-addr {
  display: inline-flex; align-items: center; gap: 5px; margin-top: 2px;
  font-family: var(--font-num); font-size: 11.5px; color: var(--ink-3); text-decoration: none;
}
.lb-addr:hover { color: var(--clay); text-decoration: underline; }
.lb-addr svg { flex: none; opacity: .75; }
.lb-xp { justify-self: end; text-align: right; font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 15.5px; font-weight: 800; letter-spacing: -.02em; }
.lb-xp small { display: block; font-family: var(--font-ui); font-size: 10px; font-weight: 700; letter-spacing: .09em; color: var(--ink-3); margin-top: 2px; }
.lb-xp-m { display: none; }
@media (max-width: 560px) {
  .lb-xp { display: none; }
  .lb-head, .lb-row { grid-template-columns: 56px minmax(0,1fr); }
  .lb-head .r { display: none; }
  .lb-xp-m { display: block; margin-top: 2px; font-family: var(--font-num); font-size: 11.5px; font-weight: 700; color: #a8722c; }
}
`;

const LeaderboardPage = () => {
  return (
    <>
      <BackgroundImage />
      <NavBar />
      <QuestCardComponent />
    </>
  );
};

export default LeaderboardPage;

export const QuestCardComponent = () => {
  const [allPlayers, setAllPlayers] = useState<any[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getLeaderboard(200).then((data) => {
      if (data && data.length > 0 && data.some((u: any) => (u.total_xp || 0) > 0)) {
        const mapped = data
          .filter((u: any) => (u.total_xp || 0) > 0)
          .sort((a: any, b: any) => (b.total_xp || 0) - (a.total_xp || 0))
          .map((u: any, i: number) => ({
            id: i + 1,
            name: u.username || `Player ${i + 1}`,
            score: u.total_xp || 0,
            trophy: i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : undefined,
            wallet: u.wallet_address || "",
            displayAddr: u.wallet_address
              ? `${u.wallet_address.slice(0, 6)}...${u.wallet_address.slice(-4)}`
              : "0x0000...0000",
          }));
        setAllPlayers(mapped);
      }
      setLoading(false);
    }).catch((e) => { console.error(e); setLoading(false); });
  }, []);

  const totalPages = Math.max(1, Math.ceil(allPlayers.length / PLAYERS_PER_PAGE));
  const startIdx = (currentPage - 1) * PLAYERS_PER_PAGE;
  const currentPlayers = allPlayers.slice(startIdx, startIdx + PLAYERS_PER_PAGE);

  return (
    <div className="w-full">
      <style>{PAGE_CSS}</style>

      {/* Hero */}
      <header className="hero">
        <h1>Leaderboard.</h1>
        <p className="sub">
          The deepest diggers on Robinhood Chain. Swap, provide liquidity and finish
          quests to earn XP — every point moves you up the tunnel.
        </p>
        <MoleMascot />
      </header>

      {/* Leaderboard List */}
      <div className="panel">
        <div className="lb-head">
          <span>Rank</span>
          <span>Digger</span>
          <span className="r">XP</span>
        </div>
        <div>
          {loading ? (
            <div className="p-empty">Loading...</div>
          ) : currentPlayers.length === 0 ? (
            <div className="p-empty">No players yet</div>
          ) : (
            currentPlayers.map((player, i) => {
              const globalIndex = player.id - 1;
              const top = globalIndex < 3 ? globalIndex + 1 : 0;

              return (
                <div
                  key={player.id}
                  className={`lb-row${top ? ` top${top}` : ""}`}
                  style={{ animationDelay: `${i * 22}ms` }}
                >
                  <div className={`lb-tile${top ? ` t${top}` : ""}`}>
                    {player.trophy ? player.trophy : player.id}
                  </div>
                  <div className="lb-who">
                    <span className="lb-av" aria-hidden="true">
                      {(player.name || "?").charAt(0).toUpperCase()}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div className="lb-nm">{player.name}</div>
                      <span className="lb-xp-m">{player.score.toLocaleString()} XP</span>
                      <a
                        className="lb-addr"
                        href={`${EXPLORER_URL}${player.wallet}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {player.displayAddr}
                        <SquareArrowOutUpRight size={11} />
                      </a>
                    </div>
                  </div>
                  <div className="lb-xp">
                    {player.score.toLocaleString()}
                    <small>XP</small>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Pagination */}
      {allPlayers.length > PLAYERS_PER_PAGE && (
        <div className="pagi">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            aria-label="Previous page"
          >
            <ChevronLeft size={15} />
          </button>
          <span className="pg">
            {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            aria-label="Next page"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
};
