"use client";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ArrowRight, SquareArrowOutUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import React, { useState, useEffect } from "react";
import { NavBar } from "../shared";
import { getLeaderboard } from "@/lib/supabase/api";

const EXPLORER_URL = "https://robinhoodchain.blockscout.com/address/";
const PLAYERS_PER_PAGE = 25;

const LeaderboardPage = () => {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-2 sm:gap-4">
      <BackgroundImage />
      <div className="relative z-50 mx-auto mt-2 block w-full px-2 sm:mt-4 sm:px-4">
        <NavBar />
      </div>
      <div className="relative z-20 flex w-full flex-1">
        <QuestCardComponent />
      </div>
    </div>
  );
};

export default LeaderboardPage;

const BackgroundImage = () => {
  return (
    <>
      <div className="fixed inset-0 flex h-full flex-col">
        <Image
          src="/leaderboard/bricks.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute top-0 z-10 h-full w-full max-lg:object-cover"
        />
      </div>
      <Image
        src="/leaderboard/soil.png"
        alt="Profile"
        width={200}
        height={200}
        className="fixed bottom-0 h-full max-h-[30vh] w-full object-fill"
      />
    </>
  );
};

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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-2 sm:px-6">
      {/* Header */}
      <div className="relative top-[40px] z-10 mx-auto w-[85%] rounded-lg px-4 py-3 text-center sm:w-[75%] sm:px-6 sm:py-4">
        <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">
          leaderboard
        </h1>
        <Image
          src="/quest/header-quest-bg.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 left-0 z-[-1] h-full w-full"
        />
      </div>

      {/* Main Leaderboard Section */}
      <div className="relative mb-6 flex h-full px-1 sm:px-4">
        <Image
          src="/leaderboard/list-board.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 z-0 h-full w-full object-fill"
        />
        {/* Leaderboard List */}
        <div className="bg-leaderboard relative m-2 mx-auto flex w-full flex-1 flex-col items-center gap-2 p-2 pt-6 sm:m-6 sm:gap-2 sm:p-4 sm:pt-8">
          {loading ? (
            <div className="font-family-ThaleahFat py-12 text-center text-xl text-[#FFD47A]">
              Loading...
            </div>
          ) : currentPlayers.length === 0 ? (
            <div className="font-family-ThaleahFat py-12 text-center text-xl text-[#FFD47A]">
              No players yet
            </div>
          ) : (
            currentPlayers.map((player) => {
              const globalIndex = player.id - 1;
              const bgImage =
                globalIndex === 0
                  ? "/leaderboard/player-info-board-1.png"
                  : globalIndex === 1
                    ? "/leaderboard/player-info-board-2.png"
                    : globalIndex === 2
                      ? "/leaderboard/player-info-board-3.png"
                      : "/leaderboard/player-info-board.png";

              return (
                <div
                  key={player.id}
                  className="relative flex w-full max-w-3xl justify-between px-2 py-2 text-white shadow-md max-sm:flex-col sm:items-center sm:px-4 sm:py-3"
                >
                  <Image
                    src={bgImage}
                    alt={`Player ${player.id} background`}
                    width={200}
                    height={200}
                    className="absolute inset-0 z-[0] h-full w-full object-fill"
                  />

                  {/* Left side */}
                  <div className="z-10 flex items-center gap-3 overflow-hidden">
                    {player.trophy ? (
                      <div className="relative w-10">
                        <Image
                          src={`/leaderboard/${globalIndex + 1}.png`}
                          alt="Trophy"
                          width={60}
                          height={60}
                          className="absolute -top-5 left-0"
                        />
                      </div>
                    ) : (
                      <div className="font-family-ThaleahFat text-leaderboard-rank relative flex h-[28px] w-[28px] items-center justify-center text-base sm:h-[40px] sm:w-[40px] sm:text-2xl">
                        {player.id}
                        <Image
                          src="/leaderboard/rest.png"
                          alt="Rank background"
                          fill
                          className="absolute inset-0 z-[-1] object-cover"
                        />
                      </div>
                    )}
                    <div className="flex flex-col">
                      <span className="font-family-ThaleahFat text-base leading-5 sm:text-2xl sm:leading-7">
                        {player.name}
                      </span>
                      <span className="font-family-ThaleahFat text-sm text-[#FFD47A] sm:hidden">
                        {player.score.toLocaleString()}
                      </span>
                      <a
                        href={`${EXPLORER_URL}${player.wallet}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-leaderboard-text font-mono text-[10px] break-all transition-colors hover:text-[#FFD47A] sm:text-sm"
                      >
                        {player.displayAddr}{" "}
                        <SquareArrowOutUpRight
                          size={14}
                          className="inline text-sm"
                        />
                      </a>
                    </div>
                  </div>

                  {/* Divider lines */}
                  <div className="bg-leaderboard before:bg-leaderboard relative mr-auto ml-6 hidden h-full w-[4px] before:absolute before:top-0 before:left-0 before:h-[1px] before:w-full before:content-[''] sm:block" />
                  <div className="bg-leaderboard before:bg-leaderboard relative mr-6 ml-auto hidden h-full w-[4px] before:absolute before:top-0 before:left-0 before:h-[1px] before:w-full before:content-[''] sm:block" />

                  {/* Right side */}
                  <span className="font-family-ThaleahFat z-10 text-xl max-sm:hidden sm:text-3xl">
                    {player.score.toLocaleString()}
                  </span>
                </div>
              );
            })
          )}

          {/* Pagination */}
          {allPlayers.length > PLAYERS_PER_PAGE && (
            <div className="z-30 mt-4 mb-2 flex flex-col items-center gap-3">
              <span className="text-peach-400 bg-ground-button font-family-ThaleahFat rounded px-3 py-1 text-lg font-bold tracking-wider">
                {currentPage} of {totalPages}
              </span>
              <div className="flex gap-3">
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="bg-ground-button border-ground-button-border flex h-10 w-10 cursor-pointer items-center justify-center rounded border-2 transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
                >
                  <ArrowLeft className="text-peach-400 h-5 w-5" />
                </button>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="bg-ground-button border-ground-button-border flex h-10 w-10 cursor-pointer items-center justify-center rounded border-2 transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
                >
                  <ArrowRight className="text-peach-400 h-5 w-5" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
