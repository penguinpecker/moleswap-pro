"use client";
import { Button } from "@/components/ui/button";
import Image from "next/image";
import React from "react";
import { useState, useEffect } from "react";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { LucideIcon } from "lucide-react";
import { NavBar } from "../shared";
import { getQuests } from "@/lib/supabase/api";
import { getQuestsWithProgress, progressQuestsForAction, type QuestWithProgress } from "@/lib/supabase/quests";
import { usePushWalletContext, usePushChainClient, PushUI } from "@/lib/pushchain/provider";
import { usePushWallet } from "@/lib/pushchain/provider";
import { getOrCreateUser } from "@/lib/supabase/api";
import MoleWhack from "@/screens/MoleWhack";

const mockQuests = [
  {
    id: "1",
    image: "/quest/main-quest-1.png",
    alt: "Main Quest 1",
  },
  {
    id: "2",
    image: "/quest/main-quest-2.png",
    alt: "Main Quest 2",
  },
  {
    id: "3",
    image: "/quest/main-quest-3.png",
    alt: "Main Quest 3",
  },
  {
    id: "4",
    image: "/quest/main-quest-4.png",
    alt: "Main Quest 4",
  },
  {
    id: "5",
    image: "/quest/main-quest-5.png",
    alt: "Main Quest 5",
  },
  {
    id: "6",
    image: "/quest/main-quest-6.png",
    alt: "Main Quest 6",
  },
  {
    id: "7",
    image: "/quest/main-quest-7.png",
    alt: "Main Quest 7",
  },
  {
    id: "8",
    image: "/quest/main-quest-8.png",
    alt: "Main Quest 8",
  },
  {
    id: "9",
    image: "/quest/main-quest-9.png",
    alt: "Main Quest 9",
  },
  {
    id: "10",
    image: "/quest/main-quest-10.png",
    alt: "Main Quest 10",
  },
];

interface QuestCardProps {
  icon: LucideIcon;
  title: string;
  xp: number;
  completed?: boolean;
  className?: string;
  onClick?: () => void;
}
const QuestPage = () => {
  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
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

export default QuestPage;

const BackgroundImage = () => {
  return (
    <>
      {/* Gradient Sky Layers */}
      <div className="fixed inset-0 flex h-[40vh] flex-col">
        <div className="h-[25%] bg-[#39BBE3]"></div>
        <div className="h-[25%] bg-[#6ED2F0]"></div>
        <div className="h-[25%] bg-[#AEE5F5]"></div>
        <div className="h-[25%] bg-[#E9F9FE]"></div>
      </div>
      <div className="fixed inset-0 z-10 max-md:hidden">
        {/* clouds right top  */}
        <Image
          src="/profile/c2.png"
          alt="Profile"
          width={200}
          height={200}
          className="animate-float-left absolute top-5 right-25 w-[120px] object-cover"
        />
        {/* clouds Center  */}
        <Image
          src="/profile/c3.png"
          alt="Profile"
          width={200}
          height={200}
          className="animate-float-right absolute top-[10%] left-[40%] w-[120px] object-cover"
        />
      </div>
      {/*   GRASS  */}
      <Image
        src="/profile/Grass.png"
        alt="Profile"
        width={200}
        height={200}
        className="fixed bottom-[32vh] z-10 h-full max-h-[15vh] w-full object-cover sm:bottom-[35vh] sm:max-h-[20vh]"
      />
      {/*   BRICK */}
      <Image
        src="/profile/profile-brick.png"
        alt="Profile"
        width={200}
        height={200}
        className="fixed bottom-0 h-full max-h-[45vh] w-full object-cover sm:max-h-[50vh]"
      />
    </>
  );
};

export const QuestCardComponent = () => {
  const [currentPage, setCurrentPage] = useState(1);
  const [activeTab, setActiveTab] = useState<"social" | "dapp" | "game">("social");
  const [allQuests, setAllQuests] = useState(mockQuests);
  const [questProgress, setQuestProgress] = useState<Map<string, QuestWithProgress>>(new Map());
  const [userId, setUserId] = useState<string | null>(null);
  const [showGame, setShowGame] = useState(false);
  const [gameXp, setGameXp] = useState(0);
  const gameQuestTriggered = React.useRef(false);
  const questsPerPage = 8;

  const walletCtx = usePushWalletContext();
  const { pushChainClient } = usePushChainClient();
  const isConnected = walletCtx?.connectionStatus === PushUI.CONSTANTS.CONNECTION.STATUS.CONNECTED;
  // Use the `usePushWallet` hook which resolves the UEA hex address and
  // filters out Solana base58 pubkeys that would otherwise corrupt DB writes
  // (quest progress keyed by wallet_address).
  const { address: walletAddress } = usePushWallet();

  const loadQuests = async () => {
    let uid: string | null = null;
    if (walletAddress) {
      const user = await getOrCreateUser(walletAddress);
      uid = user?.id || null;
      setUserId(uid);
    }

    const data = uid
      ? await getQuestsWithProgress(uid)
      : await getQuestsWithProgress();

    if (data && data.length > 0) {
      const mapped = data.map((q: any) => ({
        id: q.id,
        image: q.image_url || `/quest/main-quest-${q.sort_order}.png`,
        alt: q.title || `Quest ${q.sort_order}`,
        quest_type: q.quest_type,
        category: q.category || q.quest_type,
        progress: q.progress || 0,
        required_count: q.required_count || 1,
        is_completed: q.is_completed || false,
        is_claimed: q.is_claimed || false,
        xp_reward: q.xp_reward || 0,
        difficulty: q.difficulty || "easy",
        title: q.title,
        action_params: q.action_params || {},
        action_type: q.action_type || "manual",
      }));
      setAllQuests(mapped);

      const pMap = new Map<string, QuestWithProgress>();
      data.forEach((q: QuestWithProgress) => pMap.set(q.id, q));
      setQuestProgress(pMap);
    } else {
      const basicData = await getQuests();
      if (basicData && basicData.length > 0) {
        const mapped = basicData.map((q: any) => ({
          id: q.id,
          image: q.image_url || `/quest/main-quest-${q.sort_order}.png`,
          alt: q.title || `Quest ${q.sort_order}`,
          quest_type: q.quest_type,
        }));
        setAllQuests(mapped);
      }
    }
  };

  useEffect(() => {
    loadQuests().catch(console.error);
  }, [walletAddress]);

  useEffect(() => {
    const onFocus = () => { loadQuests().catch(console.error); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [walletAddress]);

  const verifySocialQuest = async (questId: string) => {
    if (!userId) return;
    try {
      const res = await fetch("/api/quests/verify-social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, questId }),
      });
      const data = await res.json();
      if (data.success) {
        setAllQuests(prev => prev.map(q =>
          q.id === questId ? { ...q, is_completed: true, is_claimed: true } : q
        ));
      }
    } catch (e) {
      console.error("Social quest verify error:", e);
    }
  };

  useEffect(() => { setCurrentPage(1); }, [activeTab]);

  const filteredQuests = (() => {
    const raw = allQuests.filter((q: any) => {
      if (activeTab === "social") return q.category === "social" || q.quest_type === "social";
      if (activeTab === "dapp") {
        const isDapp = q.category === "dapp" || q.quest_type === "dapp" || (!["social", "game"].includes(q.category) && !["social", "game"].includes(q.quest_type));
        if (!isDapp) return false;
        const title = (q.title || q.alt || "").toLowerCase();
        return title.includes("swap");
      }
      return q.quest_type === activeTab || q.category === activeTab;
    });
    const seenIds = new Set<string>();
    const seenKeys = new Set<string>();
    return raw.filter((q: any) => {
      if (seenIds.has(q.id)) return false;
      const titleKey = (q.title || q.alt || "").toLowerCase().trim();
      if (titleKey && seenKeys.has(titleKey)) return false;
      seenIds.add(q.id);
      if (titleKey) seenKeys.add(titleKey);
      return true;
    });
  })();

  const totalPages = Math.ceil(filteredQuests.length / questsPerPage);

  const startIndex = (currentPage - 1) * questsPerPage;
  const currentQuests = filteredQuests.slice(
    startIndex,
    startIndex + questsPerPage,
  );

  const handlePrevPage = () => {
    setCurrentPage((prev) => Math.max(1, prev - 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(totalPages, prev + 1));
  };

  const handleQuestClick = (quest: any) => {
    const isSocial = quest.category === "social" || quest.quest_type === "social";
    if (isSocial && !quest.is_completed) {
      verifySocialQuest(quest.id);
    }
  };
  const tabClass = (tab: string) =>
    `font-family-ThaleahFat text-shadow-black px-2 rounded-full text-sm sm:px-4 sm:text-3xl transition-colors duration-150 cursor-pointer ${
      activeTab === tab
        ? "bg-ground-button border-4 border-ground-button-border text-peach-400"
        : "text-gray-400 hover:text-yellow-200"
    }`;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-1 sm:px-2 md:p-6">
      {/* Header */}
      <div className="relative top-[40px] z-10 mx-auto w-[85%] rounded-lg px-4 py-3 text-center sm:w-[75%] sm:px-6 sm:py-4">
        <h1 className="text-peach-300 text-shadow-header font-family-ThaleahFat text-2xl font-bold tracking-widest uppercase sm:text-5xl">
          Quests
        </h1>
        <Image
          src="/quest/header-quest-bg.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 left-0 z-[-1] h-full w-full"
        />
      </div>

      {/* Main Quests Section */}
      <div className="relative mb-6 h-full">
        <Image
          src="/quest/Quest-BG.png"
          alt="Profile"
          width={200}
          height={200}
          className="absolute inset-0 z-0 h-full w-full object-fill"
        />
        <div className="relative z-50 mt-12 block space-x-4 px-4 pt-3 text-center">
          <button
            className={tabClass("social")}
            onClick={() => setActiveTab("social")}
          >
            SOCIAL
          </button>
          <button
            className={tabClass("dapp")}
            onClick={() => setActiveTab("dapp")}
          >
            DAPP QUESTS
          </button>
          <button
            className={tabClass("game")}
            onClick={() => setActiveTab("game")}
          >
            GAME QUESTS
          </button>
        </div>

        {/* Quest Grid */}
        <div className="relative mb-6 grid grid-cols-1 gap-2 p-2 sm:gap-4 sm:p-4 md:grid-cols-2">
          {currentQuests.map((quest: any) => {
            const isSocial = quest.category === "social" || quest.quest_type === "social";
            const isGame = quest.category === "game" || quest.quest_type === "game";
            const tweetId = quest.action_params?.tweetId;
            const getClickUrl = () => {
              if (quest.is_completed) return null;
              if (isGame) return null;
              if (quest.action_type === "twitter_follow") return quest.action_params?.url || `https://x.com/intent/follow?screen_name=${quest.action_params?.handle?.replace("@", "")}`;
              if (quest.action_type === "twitter_like_rt" && tweetId) return `https://x.com/intent/like?tweet_id=${tweetId}`;
              if (quest.action_params?.url) return quest.action_params.url;
              return null;
            };
            return (
              <div
                key={quest.id}
                className="group relative cursor-pointer"
                onClick={() => {
                  if (isGame && !quest.is_completed) {
                    setGameXp(0);
                    gameQuestTriggered.current = false;
                    setShowGame(true);
                    return;
                  }
                  const url = getClickUrl();
                  if (url) window.open(url, "_blank", "noopener,noreferrer");
                  handleQuestClick(quest);
                }}
              >
                <Image
                  src={quest.image}
                  alt={quest.alt}
                  width={403}
                  height={92}
                  className="w-full transition-all group-hover:scale-[1.02]"
                />
                {quest.is_completed && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/50">
                    <span className="font-family-ThaleahFat text-peach-300 text-lg tracking-wider sm:text-2xl">COMPLETED</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Pagination */}
        <div className="z-30 mb-4 flex flex-col items-center justify-center gap-2 sm:gap-4">
          <span className="text-peach-400 bg-ground-button z-40 rounded px-3 py-1 text-lg font-bold tracking-wider">
            {currentPage} of {totalPages}
          </span>
          <div className="z-40 flex gap-4">
            <Button
              variant="ghost"
              size="lg"
              onClick={handlePrevPage}
              disabled={currentPage === 1}
              className="text-peach-300 border-ground-button-border bg-ground-button hover:bg-amber-600 hover:text-amber-200"
            >
              <ArrowLeft size={20} className="text-2xl font-bold" />
            </Button>

            <Button
              variant="ghost"
              size="lg"
              onClick={handleNextPage}
              disabled={currentPage === totalPages}
              className="text-peach-300 border-ground-button-border bg-ground-button hover:bg-amber-600 hover:text-amber-200"
            >
              <ArrowRight size={20} className="text-2xl font-bold" />
            </Button>
          </div>
        </div>
        <Image
          src="/quest/mole.gif"
          alt="Profile"
          width={200}
          height={200}
          className="absolute bottom-[-5%] left-[-5%] w-[150px] object-cover max-sm:hidden"
        />
      </div>

      {/* Whack-a-Mole Game Modal */}
      {showGame && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/70 p-4">
          <div className="relative aspect-square w-full max-w-[min(90vw,90vh)] overflow-hidden rounded-2xl border-4 border-[#523525] shadow-[8px_8px_0px_0px_#3E2723]">
            <button
              onClick={() => {
                setShowGame(false);
                loadQuests().catch(console.error);
              }}
              className="absolute top-3 right-3 z-[1000] flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border-2 border-[#523525] bg-[#784834] text-white transition-transform hover:scale-110"
            >
              <X size={20} />
            </button>
            <MoleWhack
              onMoleHit={(xpAmount) => {
                setGameXp((prev) => prev + xpAmount);
                if (userId && !gameQuestTriggered.current) {
                  gameQuestTriggered.current = true;
                  progressQuestsForAction(userId, "game_play", { game: "whack_a_mole" }).catch(console.error);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
};
