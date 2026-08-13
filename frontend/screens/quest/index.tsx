"use client";
import React from "react";
import { useState, useEffect } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { NavBar, BackgroundImage, MoleMascot } from "../shared";
import { getQuests } from "@/lib/supabase/api";
import { getQuestsWithProgress, progressQuestsForAction, type QuestWithProgress } from "@/lib/supabase/quests";
import { useWalletContext, useChainClient, WalletUI } from "@/lib/chain/provider";
import { useWallet } from "@/lib/chain/provider";
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

/* page-scoped Burrow styles — lifted from the quests.html prototype */
const PAGE_CSS = `
.toolbar { margin-top: 34px; }
.p-quest { position: relative; }
.q-click { cursor: pointer; transition: transform 160ms ease; }
.q-click:hover { transform: scale(1.02); }
.q-click:active { transform: scale(.99); }
.q-done {
  position: absolute; inset: 0; z-index: 2; display: grid; place-items: center;
  border-radius: var(--r-lg); background: rgba(20,10,4,.55); color: #fdf4e6;
  font-size: 14px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase;
}
.p-pill.legendary { background: rgba(213,72,236,.13); color: #b13ac5; }
.p-quest .prog .p-pill { flex: none; }
.seg button[aria-selected="true"] {
  background: linear-gradient(180deg, #ffcd7d, var(--amber));
  box-shadow: 0 2px 0 rgba(140,74,20,.6), inset 0 1px 0 rgba(255,255,255,.55);
}

/* fullscreen whack-a-mole overlay — square Burrow panel on a dark scrim */
.game-scrim {
  position: fixed; inset: 0; z-index: 300; display: grid; place-items: center; padding: 18px;
  background: rgba(20,10,4,.7);
  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
}
.game-panel {
  position: relative; width: min(90vw, 90vh, 640px); aspect-ratio: 1; overflow: hidden;
  border-radius: var(--r-xl);
  background: linear-gradient(180deg, var(--cream), #f6e9d3);
  color: var(--ink); border: 1px solid rgba(255,255,255,.6);
  box-shadow: var(--sh-3), var(--sh-in);
  will-change: transform;
}
.game-mount { position: absolute; inset: 0; }
.game-x {
  position: absolute; top: 12px; right: 12px; z-index: 10; width: 40px; height: 40px;
  border: 0; border-radius: 50%; cursor: pointer; font: inherit; font-size: 15px; font-weight: 800;
  background: rgba(44,26,12,.88); color: #ffe6c4;
  box-shadow: 0 2px 0 rgba(0,0,0,.4), inset 0 1px 0 rgba(255,255,255,.18);
  transition: transform 140ms ease;
}
.game-x:hover { transform: scale(1.1); }
`;

/* per-quest-type emoji — replaces the pixel quest-card PNGs (render-only) */
const questEmoji = (q: any) => {
  const title = (q.title || q.alt || "").toLowerCase();
  const isSocial = q.category === "social" || q.quest_type === "social";
  const isGame = q.category === "game" || q.quest_type === "game";
  if (isGame) return "🔨";
  if (isSocial) {
    if (q.action_type === "twitter_follow" || title.includes("follow")) return "🐦";
    if (q.action_type === "twitter_like_rt" || title.includes("like")) return "❤️";
    if (title.includes("referral") || title.includes("share")) return "📣";
    return "🕳️";
  }
  if (title.includes("swap")) return "🔀";
  if (title.includes("dca")) return "🔁";
  if (title.includes("limit")) return "📉";
  if (title.includes("vault") || title.includes("liquidity")) return "💧";
  if (title.includes("intent") || title.includes("queue")) return "📦";
  return "📈";
};

const DIFF_CLS: Record<string, string> = {
  easy: " pos",
  medium: "",
  hard: " neg",
  legendary: " legendary",
};

const QuestPage = () => {
  return (
    <>
      <BackgroundImage />
      <NavBar />
      <QuestCardComponent />
    </>
  );
};

export default QuestPage;

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

  const walletCtx = useWalletContext();
  const { chainClient } = useChainClient();
  const isConnected = walletCtx?.connectionStatus === WalletUI.CONSTANTS.CONNECTION.STATUS.CONNECTED;
  // Use the `useWallet` hook which resolves the UEA hex address and
  // resolves the connected EVM address
  // (quest progress keyed by wallet_address).
  const { address: walletAddress } = useWallet();

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
        description: q.description || "",
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
          description: q.description || "",
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

  return (
    <div className="w-full">
      <style>{PAGE_CSS}</style>

      {/* Hero */}
      <header className="hero">
        <span className="badge"><span className="dot" />Season 2 · quest board</span>
        <h1>Quests.</h1>
        <p className="sub">
          Social shout-outs, dapp milestones and arcade rounds — every quest pays XP
          the moment the mole sees you do it. Completed cards stay completed.
        </p>
        <MoleMascot />
      </header>

      {/* Tabs */}
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Quest categories">
          <button
            role="tab"
            aria-selected={activeTab === "social"}
            onClick={() => setActiveTab("social")}
          >
            Social
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "dapp"}
            onClick={() => setActiveTab("dapp")}
          >
            Dapp quests
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "game"}
            onClick={() => setActiveTab("game")}
          >
            Game quests
          </button>
        </div>
      </div>

      {/* Quest Grid */}
      <div className="p-grid p-2">
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
              className={`p-card p-quest${quest.is_completed ? "" : " q-click"}`}
              role="button"
              tabIndex={0}
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
              <div className="ic" aria-hidden="true">{questEmoji(quest)}</div>
              <div className="body">
                <div className="top">
                  <h3>{quest.title || quest.alt}</h3>
                  <span className="xp">+{(quest.xp_reward || 0).toLocaleString()} XP</span>
                </div>
                {quest.description ? <p className="d">{quest.description}</p> : null}
                <div className="prog">
                  <span className={`p-pill${DIFF_CLS[quest.difficulty] ?? ""}`}>
                    {quest.difficulty || "easy"}
                  </span>
                  {(quest.required_count || 1) > 1 && (
                    <>
                      <div className="p-bar">
                        <i
                          className={quest.is_completed ? "pos" : undefined}
                          style={{
                            width: `${Math.min(((quest.progress || 0) / quest.required_count) * 100, 100)}%`,
                          }}
                        />
                      </div>
                      <span className="n">
                        {quest.progress || 0} / {quest.required_count}
                      </span>
                    </>
                  )}
                </div>
              </div>
              {quest.is_completed && <div className="q-done">Completed</div>}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      <div className="pagi">
        <button
          onClick={handlePrevPage}
          disabled={currentPage === 1}
          aria-label="Previous page"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="pg">
          {currentPage} of {totalPages}
        </span>
        <button
          onClick={handleNextPage}
          disabled={currentPage === totalPages}
          aria-label="Next page"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Whack-a-Mole Game Modal */}
      {showGame && (
        <div className="game-scrim">
          <div className="game-panel" role="dialog" aria-label="Whack-a-mole">
            <button
              className="game-x"
              aria-label="Close game"
              onClick={() => {
                setShowGame(false);
                loadQuests().catch(console.error);
              }}
            >
              ✕
            </button>
            <div className="game-mount">
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
        </div>
      )}
    </div>
  );
};
