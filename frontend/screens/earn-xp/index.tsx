"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { FaXTwitter } from "react-icons/fa6";
import { ChevronLeft, ChevronRight, Gamepad2, Check } from "lucide-react";
import WhackAMoleModal from "@/components/WhackAMoleModal";
import { authAPI, xpAPI, referralAPI } from "@/lib/api/client";

export default function EarnXpPage() {
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [xpStats, setXpStats] = useState<any>(null);
  const [referralLink, setReferralLink] = useState<string>("");
  const [followLoading, setFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followSuccess, setFollowSuccess] = useState(false);
  const [xpClaimed, setXpClaimed] = useState(false);

  // Fetch user data and XP stats
  useEffect(() => {
    const fetchUserData = async () => {
      const userResponse = await authAPI.getCurrentUser();
      if (userResponse.data) {
        setUser(userResponse.data.user);
      }

      const statsResponse = await xpAPI.getXPStats();
      if (statsResponse.data) {
        setXpStats(statsResponse.data);
        // Set xpClaimed based on whether user reached max game XP
        setXpClaimed(statsResponse.data.stats.gameXP >= 1500);
      }

      const linkResponse = await referralAPI.getReferralLink();
      if (linkResponse.data) {
        setReferralLink(linkResponse.data.referralLink);
      }
    };

    fetchUserData();
  }, []);

  const handleXpClaimed = () => {
    setXpClaimed(true);
    // Refresh XP stats after claiming
    xpAPI.getXPStats().then((response) => {
      if (response.data) {
        setXpStats(response.data);
      }
    });
  };

  const handleFollow = () => {
    window.open(
      "https://twitter.com/moleswap",
      "_blank",
      "noopener,noreferrer",
    );
  };

  const handleVerifyFollow = async () => {
    setFollowLoading(true);
    setFollowError(null);
    setFollowSuccess(false);

    try {
      const response = await xpAPI.awardFollowXP();
      if (response.error) {
        setFollowError(response.error);
      } else if (response.data?.success) {
        setFollowSuccess(true);
        // Refresh user data
        const userResponse = await authAPI.getCurrentUser();
        if (userResponse.data) {
          setUser(userResponse.data.user);
        }
        const statsResponse = await xpAPI.getXPStats();
        if (statsResponse.data) {
          setXpStats(statsResponse.data);
        }
      }
    } catch (err) {
      setFollowError("Failed to verify follow. Please try again.");
    } finally {
      setFollowLoading(false);
    }
  };

  const handleShare = () => {
    const text = "Check out MoleSwap! 🐹 Join me and earn XP!";
    const url = referralLink || window.location.origin;
    const twitterUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(twitterUrl, "_blank", "noopener,noreferrer");
  };

  const handlePlayWhackAMole = () => {
    setIsModalOpen(true);
  };

  return (
    <>
      <BackgroundImage />
      <NavBar />

      <main>
        {/* Hero */}
        <header className="hero">
          <span className="badge">
            <span className="dot" />
            XP program
          </span>
          <h1>Earn XP.</h1>
          {user && (
            <p className="sub">
              Total XP: <b className="mono">{user.totalXP || 0}</b>
            </p>
          )}
          <MoleMascot />
        </header>

        <section className="onb-col">
          {/* Task 1: Follow us on Twitter */}
          <div className="p-card task">
            <div className="task-top">
              <h3>Follow us on Twitter</h3>
              <span className="xp">+500 XP</span>
            </div>
            <div className="task-btns">
              {!xpStats?.stats?.hasFollowed ? (
                <>
                  <button onClick={handleFollow} className="p-btn">
                    <FaXTwitter size={15} />
                    <span>FOLLOW @MOLESWAP</span>
                  </button>
                  <button
                    onClick={handleVerifyFollow}
                    disabled={followLoading || followSuccess}
                    className="p-btn ghost"
                  >
                    <Check size={16} />
                    <span>
                      {followLoading ? "VERIFYING..." : followSuccess ? "VERIFIED!" : "VERIFY"}
                    </span>
                  </button>
                </>
              ) : (
                <span className="task-done">
                  <Check size={16} />
                  <span>COMPLETED</span>
                </span>
              )}
            </div>
            {followError && (
              <p className="statline task-stat err">{followError}</p>
            )}
            {followSuccess && (
              <p className="statline task-stat ok">+500 XP earned!</p>
            )}
          </div>

          {/* Task 2: Share on Twitter */}
          <div className="p-card task">
            <div className="task-top">
              <h3>Share on Twitter</h3>
              <span className="xp">+1000 XP</span>
            </div>
            <div className="task-btns">
              <button onClick={handleShare} className="p-btn">
                <FaXTwitter size={15} />
                <span>SHARE TWEET</span>
              </button>
            </div>
          </div>

          {/* Task 3: Play Whack-a-Mole */}
          <div className="p-card task">
            <div className="task-top">
              <h3>Play Whack-a-Mole</h3>
              <span className="xp">
                {xpStats?.stats?.gameXP >= 1500 ? (
                  <span className="maxed">
                    <Check size={17} />
                  </span>
                ) : (
                  `+${xpStats?.stats?.gameXPRemaining || 1500} XP`
                )}
              </span>
            </div>
            <div className="task-btns">
              <button onClick={handlePlayWhackAMole} className="p-btn">
                <Gamepad2 size={16} />
                <span>PLAY GAME</span>
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* Side navigation arrows */}
      <button
        onClick={() => router.push("/waitlist")}
        className="side-nav left"
        aria-label="Previous"
        title="Waitlist"
      >
        <ChevronLeft size={20} />
      </button>
      <button
        onClick={() => router.push("/connect-twitter")}
        className="side-nav right"
        aria-label="Next"
        title="Connect Twitter"
      >
        <ChevronRight size={20} />
      </button>

      {/* Whack-a-Mole Modal */}
      <WhackAMoleModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onXpClaimed={handleXpClaimed}
        xpClaimed={xpClaimed}
      />

      <style jsx global>{`
        .onb-col { max-width: 620px; margin: 0 auto; display: grid; gap: 14px; }
        .hero .sub b { color: #ffcd7d; font-weight: 700; }
        .task-top { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
        .task .xp { font-family: var(--font-num); font-size: 13.5px; font-weight: 700; color: var(--p-accent); flex: none; }
        .task .xp .maxed { color: var(--moss); display: inline-flex; }
        .task-btns { display: flex; gap: 10px; margin-top: 16px; flex-wrap: wrap; }
        .task-btns .p-btn {
          flex: 1; min-width: 160px; margin-top: 0; height: 48px; font-size: 14px;
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        }
        .task-stat { text-align: left; min-height: 0; margin-top: 10px; }
        .task-done {
          display: inline-flex; align-items: center; gap: 8px; padding: 12px 2px;
          color: var(--moss); font-weight: 800; letter-spacing: .05em;
        }
        .p-btn:disabled { opacity: .6; cursor: not-allowed; }
        .side-nav {
          position: fixed; z-index: 50; top: 50%; width: 46px; height: 46px; margin-top: -23px;
          border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0; font: inherit;
          background: linear-gradient(180deg, var(--cream), var(--cream-2)); color: var(--ink-2);
          border: 1px solid rgba(255,255,255,.6); box-shadow: var(--sh-1), var(--sh-in);
          transition: transform 150ms ease, color 150ms ease;
        }
        .side-nav:hover { transform: scale(1.1); color: var(--clay); }
        .side-nav.left { left: 14px; }
        .side-nav.right { right: 14px; }
        @media (max-width: 760px) {
          .side-nav { top: auto; margin-top: 0; bottom: 16px; }
        }
      `}</style>
    </>
  );
}
