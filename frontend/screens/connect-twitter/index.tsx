"use client";

import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useSupabaseAuth } from "@/hooks/use-supabase-auth";
import { BackgroundImage } from "../shared";
import { FaXTwitter } from "react-icons/fa6";
import { Gamepad2, Check, Loader2, Wallet } from "lucide-react";
import Image from "next/image";
import WhackAMoleModal from "@/components/WhackAMoleModal";
import { authAPI, waitlistAPI, xpAPI, referralAPI } from "@/lib/api/client";
import {
  getStoredInviteCode,
  getStoredReferrer,
  storeInviteCode,
  clearStoredInviteCode,
  getReferrerFromURL,
  storeReferrer,
} from "@/lib/utils/referral";

declare global {
  interface Window {
    ethereum?: any;
  }
}

type Step = "loading" | "twitter" | "waitlist" | "tasks";

export default function ConnectTwitterPage() {
  const searchParams = useSearchParams();
  const { user: supabaseUser, loading: authLoading, signInWithTwitter, signInWithWeb3 } = useSupabaseAuth();
  
  // Step management
  const [currentStep, setCurrentStep] = useState<Step>("loading");
  const [isInitializing, setIsInitializing] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  
  // User state
  const [user, setUser] = useState<any>(null);
  const [xpStats, setXpStats] = useState<any>(null);
  const [referralLink, setReferralLink] = useState<string>("");
  
  // Waitlist state
  const [code, setCode] = useState<string[]>(Array(8).fill(""));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [waitlistSuccess, setWaitlistSuccess] = useState(false);
  
  // Task state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [followSuccess, setFollowSuccess] = useState(false);
  const [xpClaimed, setXpClaimed] = useState(false);
  
  // Wallet state
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletConnecting, setWalletConnecting] = useState(false);

  // Initialize - check auth status and determine step
  useEffect(() => {
    const initialize = async () => {
      // Wait for auth loading to complete
      if (authLoading) return;

      // Capture referrer from URL if present
      const referrer = getReferrerFromURL();
      if (referrer) {
        storeReferrer(referrer);
      }

      // Check for OAuth callback errors
      const error = searchParams.get("error");
      if (error) {
        switch (error) {
          case "OAuthCallback":
            setAuthError("Twitter authentication failed. Please try again.");
            setCurrentStep("twitter");
            setIsInitializing(false);
            return;
          default:
            setAuthError("An error occurred. Please try again.");
            setCurrentStep("twitter");
            setIsInitializing(false);
            return;
        }
      }

      if (supabaseUser) {
        // User is logged in via Supabase
        try {
          // Get user data from backend using Twitter ID
          const userResponse = await authAPI.getCurrentUser();

          if (userResponse.data?.user) {
            setUser(userResponse.data.user);

            // User is authenticated and has backend data
            setCurrentStep("tasks");

            // Fetch XP stats and referral link
            const statsResponse = await xpAPI.getXPStats();
            if (statsResponse.data) {
              setXpStats(statsResponse.data);
              setXpClaimed(statsResponse.data.stats.gameXP >= 1500);
            }

            const linkResponse = await referralAPI.getReferralLink();
            if (linkResponse.data) {
              setReferralLink(linkResponse.data.referralLink);
            }

            // Clear stored invite code after successful login
            clearStoredInviteCode();
          } else {
            // Supabase session exists but no backend user data
            // This might happen if user just signed up
            setCurrentStep("tasks");
          }
        } catch (error) {
          console.error("Backend user fetch error:", error);
          // Still show tasks since Supabase session exists
          setCurrentStep("tasks");
        }
      } else {
        // Not logged in - check if they have a stored invite code
        const storedCode = getStoredInviteCode();
        if (storedCode) {
          // They have a code, show twitter login
          setCurrentStep("twitter");
        } else {
          // No code stored, show waitlist first
          setCurrentStep("waitlist");
        }
      }

      setIsInitializing(false);
    };

    initialize();
  }, [supabaseUser, authLoading, searchParams]);

  // Handle Twitter connect with Supabase
  const handleTwitterConnect = async () => {
    const { error } = await signInWithTwitter(`${window.location.origin}/auth/callback`);
    if (error) {
      setAuthError("Failed to connect Twitter. Please try again.");
    }
  };

  // Handle Wallet connect using Supabase Web3 auth
  const handleWalletConnect = async () => {
    setWalletConnecting(true);
    setAuthError(null);
    try {
      const { error } = await signInWithWeb3();
      if (error) {
        setAuthError(error.message || "Failed to connect wallet. Please try again.");
      }
      // On success, Supabase will create the session and the auth state change listener will update the user
    } catch (error) {
      console.error("Wallet connection error:", error);
      setAuthError("Failed to connect wallet. Please try again.");
    } finally {
      setWalletConnecting(false);
    }
  };

  // Waitlist handlers
  const handleInputChange = (index: number, value: string) => {
    if (value.length > 1) return;
    const newCode = [...code];
    newCode[index] = value;
    setCode(newCode);
    if (value && index < 7) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData("text").slice(0, 8);
    const newCode = [...code];
    pastedData.split("").forEach((char, i) => {
      if (i < 8 && /^\d$/.test(char)) {
        newCode[i] = char;
      }
    });
    setCode(newCode);
    const nextEmptyIndex = newCode.findIndex((val) => !val);
    const focusIndex = nextEmptyIndex === -1 ? 7 : nextEmptyIndex;
    inputRefs.current[focusIndex]?.focus();
  };

  const handleWaitlistSubmit = async () => {
    const fullCode = code.join("");
    if (fullCode.length !== 8) {
      setWaitlistError("Please enter a complete 8-digit code");
      return;
    }

    setWaitlistLoading(true);
    setWaitlistError(null);

    try {
      const response = await waitlistAPI.verifyInviteCode(fullCode);
      
      if (response.error) {
        setWaitlistError(response.error);
      } else if (response.data?.valid) {
        storeInviteCode(fullCode);
        setWaitlistSuccess(true);
        
        // Move to Twitter step after brief delay
        setTimeout(() => {
          setCurrentStep("twitter");
        }, 1000);
      }
    } catch (err) {
      setWaitlistError("Failed to verify code. Please try again.");
    } finally {
      setWaitlistLoading(false);
    }
  };

  // Task handlers
  const handleXpClaimed = () => {
    setXpClaimed(true);
    xpAPI.getXPStats().then((response) => {
      if (response.data) {
        setXpStats(response.data);
      }
    });
    authAPI.getCurrentUser().then((response) => {
      if (response.data) {
        setUser(response.data.user);
      }
    });
  };

  const handleFollow = () => {
    window.open("https://twitter.com/moleswap", "_blank", "noopener,noreferrer");
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

  // Loading state
  if (isInitializing || currentStep === "loading") {
    return (
      <div className="relative flex min-h-screen w-full flex-col items-center justify-center gap-4">
        <BackgroundImage />
        <div className="relative z-20 flex flex-col items-center gap-4">
          <Loader2 className="text-peach-300 h-12 w-12 animate-spin" />
          <p className="font-family-ThaleahFat text-peach-300 text-xl">Loading...</p>
        </div>
      </div>
    );
  }

  // Get header title and step indicator based on current step
  const getHeaderTitle = () => {
    switch (currentStep) {
      case "twitter":
        return "CONNECT TWITTER";
      case "waitlist":
        return "ENTER INVITE CODE";
      case "tasks":
        return "EARN XP";
      default:
        return "MOLESWAP";
    }
  };

  const getStepNumber = () => {
    switch (currentStep) {
      case "waitlist":
        return 1;
      case "twitter":
        return 2;
      case "tasks":
        return 3;
      default:
        return 1;
    }
  };

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center gap-4">
      <BackgroundImage />

      <div className="relative z-20 flex w-full max-w-3xl flex-1 flex-col px-1 sm:p-6 sm:px-2">
        {/* Header */}
        <div className="relative top-[20px] z-10 mx-auto flex w-[95%] flex-col items-center justify-center rounded-lg px-2 py-2 text-center sm:top-[40px] sm:w-[85%] sm:px-6 sm:py-4">
          {/* Step indicator */}
          {currentStep !== "tasks" && (
            <div className="mb-2 flex items-center gap-2">
              {[1, 2].map((step) => (
                <div
                  key={step}
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold sm:h-8 sm:w-8 sm:text-sm ${
                    step === getStepNumber()
                      ? "bg-yellow-500 text-black"
                      : step < getStepNumber()
                        ? "bg-green-500 text-white"
                        : "bg-gray-600 text-gray-400"
                  }`}
                >
                  {step < getStepNumber() ? "✓" : step}
                </div>
              ))}
            </div>
          )}
          
          <h1 className="text-peach-300 font-family-ThaleahFat text-shadow-header text-lg font-bold tracking-widest uppercase sm:text-3xl md:text-5xl">
            {getHeaderTitle()}
          </h1>
          
          {currentStep === "tasks" && user && (
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

          {/* Step Content */}
          <div className="relative z-50 mx-auto mt-6 mb-6 flex w-full flex-col items-center justify-center p-2 sm:mt-12 sm:w-[85%] sm:p-4">
            
            {/* STEP 1: WAITLIST */}
            {currentStep === "waitlist" && (
              <div className="grid w-full grid-cols-1 gap-2 sm:gap-4">
                {authError && (
                  <div className="font-family-ThaleahFat mb-2 text-center text-sm text-red-400 sm:text-base">
                    {authError}
                  </div>
                )}
                <div className="relative z-10 mx-auto w-full rounded-lg px-2 py-2 text-center sm:w-[90%] sm:px-6 sm:py-4">
                  <div className="mb-2 flex justify-center gap-1 sm:mb-4 sm:gap-2 md:mb-6 md:gap-3">
                    {code.map((digit, index) => (
                      <input
                        key={index}
                        ref={(el) => {
                          inputRefs.current[index] = el;
                        }}
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        maxLength={1}
                        value={digit}
                        onChange={(e) => handleInputChange(index, e.target.value)}
                        onKeyDown={(e) => handleKeyDown(index, e)}
                        onPaste={handlePaste}
                        className="font-family-ThaleahFat h-8 w-8 rounded border-2 border-[#140901] bg-white text-center text-sm font-bold text-black focus:border-[#5D2C28] focus:outline-none sm:h-10 sm:w-10 sm:text-lg md:h-12 md:w-12 md:text-xl"
                        style={{ imageRendering: "pixelated" }}
                      />
                    ))}
                  </div>
                  <Image
                    src="/quest/header-quest-bg.png"
                    alt="BG"
                    width={200}
                    height={200}
                    className="absolute inset-0 left-0 z-[-1] h-full w-full"
                  />
                </div>

                <button
                  onClick={handleWaitlistSubmit}
                  disabled={code.join("").length !== 8 || waitlistLoading || waitlistSuccess}
                  className="relative w-full cursor-pointer rounded py-2 text-base font-bold text-white transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60 sm:py-4 sm:text-xl"
                >
                  <div className="font-family-ThaleahFat flex items-center justify-center gap-1 text-base font-thin sm:gap-2 sm:text-xl md:text-2xl">
                    {waitlistLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin sm:h-5 sm:w-5 md:h-6 md:w-6" />
                    ) : (
                      <Check className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                    )}
                    <span>
                      {waitlistLoading ? "VERIFYING..." : waitlistSuccess ? "VERIFIED!" : "VERIFY CODE"}
                    </span>
                  </div>
                  <Image
                    src="/dapp/connect-wallet.png"
                    alt="Submit"
                    width={200}
                    height={200}
                    className="absolute inset-0 z-[-1] h-full w-full object-fill"
                  />
                </button>

                {waitlistError && (
                  <div className="font-family-ThaleahFat text-center text-sm text-red-400 sm:text-base">
                    {waitlistError}
                  </div>
                )}

                {waitlistSuccess && (
                  <div className="font-family-ThaleahFat text-center text-sm text-green-400 sm:text-base">
                    Code verified! Proceeding to Twitter login...
                  </div>
                )}

                <div className="relative z-10 mx-auto w-full rounded-lg px-2 text-center sm:w-[90%] sm:px-6">
                  <p className="font-family-ThaleahFat text-center text-xs text-[#B0B0B0] uppercase sm:text-2xl">
                    Find invite code on Twitter or from your Community!
                  </p>
                </div>
              </div>
            )}

            {/* STEP 2: TWITTER CONNECT */}
            {currentStep === "twitter" && (
              <div className="relative z-10 w-full max-w-md">
                <div className="relative p-2 sm:p-4 md:p-6">
                  {authError && (
                    <div className="font-family-ThaleahFat mb-4 text-center text-sm text-red-400 sm:text-base">
                      {authError}
                    </div>
                  )}
                  <div className="mb-2 sm:mb-4 md:mb-6">
                    <button
                      onClick={handleTwitterConnect}
                      className="relative w-full cursor-pointer rounded py-2 text-base font-bold text-white transition-all hover:scale-105 sm:py-4 sm:text-xl"
                    >
                      <div className="font-family-ThaleahFat flex items-center justify-center gap-1 text-base font-thin sm:gap-2 sm:text-xl md:text-2xl">
                        <FaXTwitter className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        <span className="text-xs sm:text-base">CONNECT WITH X</span>
                      </div>
                      <Image
                        src="/dapp/connect-wallet.png"
                        alt="Connect"
                        width={200}
                        height={200}
                        className="absolute inset-0 z-[-1] h-full w-full object-fill"
                      />
                    </button>
                  </div>
                  
                  {/* Divider */}
                  <div className="flex items-center gap-3 my-3 sm:my-4">
                    <div className="flex-1 h-[1px] bg-[#B0B0B0]/30"></div>
                    <span className="font-family-ThaleahFat text-xs text-[#B0B0B0] uppercase sm:text-base">OR</span>
                    <div className="flex-1 h-[1px] bg-[#B0B0B0]/30"></div>
                  </div>
                  
                  {/* Wallet Connect Button */}
                  <div className="mb-2 sm:mb-4 md:mb-6">
                    <button
                      onClick={handleWalletConnect}
                      disabled={walletConnecting}
                      className="relative w-full cursor-pointer rounded py-2 text-base font-bold text-white transition-all hover:scale-105 disabled:opacity-60 sm:py-4 sm:text-xl"
                    >
                      <div className="font-family-ThaleahFat flex items-center justify-center gap-1 text-base font-thin sm:gap-2 sm:text-xl md:text-2xl">
                        {walletConnecting ? (
                          <Loader2 className="h-4 w-4 animate-spin sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        ) : (
                          <Wallet className="h-4 w-4 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        )}
                        <span className="text-xs sm:text-base">
                          {walletConnecting ? "CONNECTING..." : "CONNECT WALLET"}
                        </span>
                      </div>
                      <Image
                        src="/dapp/connect-wallet.png"
                        alt="Connect Wallet"
                        width={200}
                        height={200}
                        className="absolute inset-0 z-[-1] h-full w-full object-fill"
                      />
                    </button>
                  </div>
                  
                  <p className="font-family-ThaleahFat text-center text-xs text-[#B0B0B0] uppercase sm:text-2xl">
                    Connect to prove you are a hooman!
                  </p>
                </div>
              </div>
            )}

            {/* STEP 3: TASKS */}
            {currentStep === "tasks" && (
              <div className="grid w-full grid-cols-1 gap-2 sm:gap-4">
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
                          <span className="z-[1] text-xs sm:text-base">COMPLETED</span>
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
                        <span className="z-[1] text-xs text-white sm:text-base">SHARE TWEET</span>
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
                      onClick={() => setIsModalOpen(true)}
                      className="relative flex-1 cursor-pointer rounded py-2 text-sm font-bold text-white transition-all hover:scale-105 sm:py-4 sm:text-xl"
                    >
                      <div className="font-family-ThaleahFat z-[1] flex items-center justify-center gap-1 text-sm font-thin sm:gap-2 sm:text-xl md:text-2xl">
                        <Gamepad2 className="z-[1] h-3 w-3 sm:h-5 sm:w-5 md:h-6 md:w-6" />
                        <span className="z-[1] text-xs text-white sm:text-base">PLAY GAME</span>
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

                {/* User info */}
                {user && (
                  <div className="relative z-10 mx-auto mt-4 w-full rounded-lg px-2 py-2 text-center sm:w-[90%] sm:px-6 sm:py-4">
                    <p className="font-family-ThaleahFat text-xs text-[#B0B0B0] sm:text-base">
                      Logged in as @{user.username}
                    </p>
                    {referralLink && (
                      <p className="font-family-ThaleahFat mt-1 text-xs text-yellow-300 sm:text-sm">
                        Your referral link: {referralLink}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
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
