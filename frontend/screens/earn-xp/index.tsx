"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { BackgroundImage, NavBar } from "../shared";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { FaXTwitter } from "react-icons/fa6";
import { ChevronLeft, ChevronRight, Gamepad2, Check } from "lucide-react";
import Image from "next/image";
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
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
      <BackgroundImage />

      <div className="relative z-20 flex w-full max-w-3xl flex-1 flex-col px-1 sm:p-6 sm:px-2">
        {/* Header */}
        <div className="relative top-[20px] z-10 mx-auto flex w-[95%] flex-col items-center justify-center rounded-lg px-2 py-2 text-center sm:top-[40px] sm:w-[85%] sm:px-6 sm:py-4">
          <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-lg font-bold tracking-widest uppercase sm:text-3xl md:text-5xl">
            EARN XP
          </h1>
          {user && (
            <p className="font-family-ThaleahFat mt-2 text-sm text-yellow-300 sm:text-xl md:text-2xl">
              Total XP: {user.totalXP || 0}
            </p>
          )}

          <Image
            src="/quest/header-quest-bg.png"
            alt="Header BG"
            width={200}
            height={200}
            className="absolute inset-0 left-0 z-[-1] h-full w-full"
          />
        </div>

        {/* Body */}
        <div className="relative mb-6 block h-full">
          <Image
            src="/quest/Quest-BG.png"
            alt="BG"
            width={200}
            height={200}
            className="absolute inset-0 z-0 h-full w-full object-fill"
          />

          {/* Earn XP Form */}
          <div className="relative z-50 mx-auto mt-6 mb-6 grid w-full grid-cols-1 gap-2 p-2 sm:mt-12 sm:w-[85%] sm:gap-4 sm:p-4">
            <div className="grid grid-cols-1 gap-2 sm:gap-4">
              {/* Section 1: FOLLOW US ON TWITTER */}
              <div className="relative z-10 mx-auto w-full rounded-lg px-2 py-2 text-center sm:w-[90%] sm:px-6 sm:py-4">
                <h2 className="font-family-ThaleahFat mb-2 text-center text-sm text-white sm:mb-3 sm:text-2xl md:text-4xl">
                  FOLLOW US ON TWITTER
                </h2>
                <div className="flex items-center gap-1 sm:gap-3 md:gap-4">
                  {!xpStats?.stats?.hasFollowed ? (
                    <>
                      <button
                        onClick={handleFollow}
                        className="relative flex-1 cursor-pointer rounded py-2 text-sm font-bold text-white transition-all hover:scale-105 sm:py-4 sm:text-xl"
                      >
                        <div className="font-family-ThaleahFat z-[1] flex items-center justify-center gap-1 text-sm font-thin sm:gap-2 sm:text-xl md:text-2xl">
                          <FaXTwitter className="z-[1] h-3 w-3 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                          <span className="z-[1] text-xs text-white sm:text-base">
                            FOLLOW @MOLESWAP
                          </span>
                        </div>
                        <Image
                          src="/dapp/connect-wallet.png"
                          alt="Follow"
                          width={200}
                          height={200}
                          className="absolute inset-0 z-[0] h-full w-full object-fill"
                        />
                      </button>
                      <button
                        onClick={handleVerifyFollow}
                        disabled={followLoading || followSuccess}
                        className="relative flex-1 cursor-pointer rounded py-2 text-sm font-bold text-white transition-all hover:scale-105 disabled:opacity-60 sm:py-4 sm:text-xl"
                      >
                        <div className="font-family-ThaleahFat z-[1] flex items-center justify-center gap-1 text-sm font-thin sm:gap-2 sm:text-xl md:text-2xl">
                          <Check className="z-[1] h-3 w-3 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                          <span className="z-[1] text-xs text-white sm:text-base">
                            {followLoading ? "VERIFYING..." : followSuccess ? "VERIFIED!" : "VERIFY"}
                          </span>
                        </div>
                        <Image
                          src="/dapp/connect-wallet.png"
                          alt="Verify"
                          width={200}
                          height={200}
                          className="absolute inset-0 z-[0] h-full w-full object-fill"
                        />
                      </button>
                    </>
                  ) : (
                    <div className="relative flex-1 rounded py-2 text-sm sm:py-4 sm:text-xl">
                      <div className="font-family-ThaleahFat z-[1] flex items-center justify-center gap-1 text-sm font-thin text-green-300 sm:gap-2 sm:text-xl md:text-2xl">
                        <Check className="z-[1] h-3 w-3 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        <span className="z-[1] text-xs sm:text-base">
                          COMPLETED
                        </span>
                      </div>
                    </div>
                  )}
                  <div className="font-family-ThaleahFat shrink-0 text-xs text-white sm:text-xl md:text-3xl">
                    +500 XP
                  </div>
                </div>
                {followError && (
                  <p className="font-family-ThaleahFat mt-2 text-xs text-red-400 sm:text-sm">
                    {followError}
                  </p>
                )}
                {followSuccess && (
                  <p className="font-family-ThaleahFat mt-2 text-xs text-green-400 sm:text-sm">
                    +500 XP earned!
                  </p>
                )}
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Section 2: SHARE ON TWITTER */}
              <div className="relative z-10 mx-auto w-full rounded-lg px-2 py-2 text-center sm:w-[90%] sm:px-6 sm:py-4">
                <h2 className="font-family-ThaleahFat mb-2 text-center text-sm text-white sm:mb-3 sm:text-2xl md:text-4xl">
                  SHARE ON TWITTER
                </h2>
                <div className="flex items-center gap-1 sm:gap-3 md:gap-4">
                  <button
                    onClick={handleShare}
                    className="relative flex-1 cursor-pointer rounded py-2 text-sm font-bold text-white transition-all hover:scale-105 sm:py-4 sm:text-xl"
                  >
                    <div className="font-family-ThaleahFat z-[1] flex items-center justify-center gap-1 text-sm font-thin sm:gap-2 sm:text-xl md:text-2xl">
                      <FaXTwitter className="z-[1] h-3 w-3 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                      <span className="z-[1] text-xs text-white sm:text-base">
                        SHARE TWEET
                      </span>
                    </div>
                    <Image
                      src="/dapp/connect-wallet.png"
                      alt="Share"
                      width={200}
                      height={200}
                      className="absolute inset-0 z-[0] h-full w-full object-fill"
                    />
                  </button>
                  <div className="font-family-ThaleahFat shrink-0 text-xs text-white sm:text-xl md:text-3xl">
                    +1000 XP
                  </div>
                </div>
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>

              {/* Section 3: PLAY WHACK-A-MOLE */}
              <div className="relative z-10 mx-auto w-full rounded-lg px-2 py-2 text-center sm:w-[90%] sm:px-6 sm:py-4">
                <h2 className="font-family-ThaleahFat mb-2 text-center text-sm text-white sm:mb-3 sm:text-2xl md:text-4xl">
                  PLAY WHACK-A-MOLE
                </h2>
                <div className="flex items-center gap-1 sm:gap-3 md:gap-4">
                  <button
                    onClick={handlePlayWhackAMole}
                    className="relative flex-1 cursor-pointer rounded py-2 text-sm font-bold text-white transition-all hover:scale-105 sm:py-4 sm:text-xl"
                  >
                    <div className="font-family-ThaleahFat z-[1] flex items-center justify-center gap-1 text-sm font-thin sm:gap-2 sm:text-xl md:text-2xl">
                      <Gamepad2 className="z-[1] h-3 w-3 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                      <span className="z-[1] text-xs text-white sm:text-base">
                        PLAY GAME
                      </span>
                    </div>
                    <Image
                      src="/dapp/connect-wallet.png"
                      alt="Play"
                      width={200}
                      height={200}
                      className="absolute inset-0 z-[0] h-full w-full object-fill"
                    />
                  </button>
                  <div className="font-family-ThaleahFat relative flex shrink-0 items-center gap-2 text-xs text-white sm:text-xl md:text-3xl">
                    {xpStats?.stats?.gameXP >= 1500 ? (
                      <Image
                        src="/dapp/Check-mark.svg"
                        alt="XP"
                        width={50}
                        height={50}
                      />
                    ) : (
                      `+${xpStats?.stats?.gameXPRemaining || 1500} XP`
                    )}
                  </div>
                </div>
                <Image
                  src="/quest/header-quest-bg.png"
                  alt="BG"
                  width={200}
                  height={200}
                  className="absolute inset-0 left-0 z-[-1] h-full w-full"
                />
              </div>
            </div>
          </div>

          {/* // NAVIGATION ARROWS  */}
          <button
            onClick={() => router.push("/waitlist")}
            className="group absolute bottom-0 left-2 z-50 flex h-6 w-6 cursor-pointer items-center justify-center transition-all hover:scale-110 sm:top-1/2 sm:bottom-auto sm:left-4 sm:h-10 sm:w-10 sm:-translate-y-1/2 md:h-12 md:w-12"
          >
            <Image
              src="/profile/footer-image.svg"
              alt="Previous"
              fill
              className="absolute inset-0 object-contain"
            />
            <ChevronLeft className="text-peach-300 group-hover:text-peach-400 relative z-10 h-3 w-3 transition-colors sm:h-5 sm:w-5 md:h-6 md:w-6" />
          </button>
          <button
            onClick={() => router.push("/connect-twitter")}
            className="group absolute right-2 bottom-0 z-50 flex h-6 w-6 cursor-pointer items-center justify-center transition-all hover:scale-110 sm:top-1/2 sm:right-4 sm:bottom-auto sm:h-10 sm:w-10 sm:-translate-y-1/2 md:h-12 md:w-12"
          >
            <Image
              src="/profile/footer-image.svg"
              alt="Next"
              fill
              className="absolute inset-0 object-contain"
            />
            <ChevronRight className="text-peach-300 group-hover:text-peach-400 relative z-10 h-3 w-3 transition-colors sm:h-5 sm:w-5 md:h-6 md:w-6" />
          </button>
        </div>
      </div>

      {/* Whack-a-Mole Modal */}
      <WhackAMoleModal
        open={isModalOpen}
        onOpenChange={setIsModalOpen}
        onXpClaimed={handleXpClaimed}
        xpClaimed={xpClaimed}
      />
    </div>
  );
}
