"use client";

import { useState, useEffect, useRef, KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { useSupabaseAuth } from "@/hooks/use-supabase-auth";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";
import { FaXTwitter } from "react-icons/fa6";
import { Gamepad2, Check, Loader2, Wallet } from "lucide-react";
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
      <>
        <BackgroundImage />
        <NavBar />
        <main>
          <div
            className="p-card"
            style={{
              maxWidth: 380,
              margin: "90px auto 0",
              textAlign: "center",
              padding: "38px 24px",
            }}
          >
            <Loader2 className="spin" size={40} aria-hidden="true" />
            <p style={{ margin: "14px 0 0", fontWeight: 700 }}>Loading...</p>
          </div>
        </main>
      </>
    );
  }

  // Get header title and step indicator based on current step
  const getHeaderTitle = () => {
    switch (currentStep) {
      case "twitter":
        return "Connect Twitter.";
      case "waitlist":
        return "Enter invite code.";
      case "tasks":
        return "Earn XP.";
      default:
        return "MoleSwap";
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
    <>
      <BackgroundImage />
      <NavBar />

      <main>
        {/* Hero */}
        <header className="hero">
          <span className="badge">
            <span className="dot" />
            Onboarding
          </span>

          {/* Step indicator */}
          {currentStep !== "tasks" && (
            <div className="step-dots" aria-label="Onboarding step">
              {[1, 2].map((step) => (
                <span
                  key={step}
                  className={
                    step === getStepNumber()
                      ? "cur"
                      : step < getStepNumber()
                        ? "past"
                        : "fut"
                  }
                >
                  {step < getStepNumber() ? "✓" : step}
                </span>
              ))}
            </div>
          )}

          <h1>{getHeaderTitle()}</h1>

          {currentStep === "tasks" && user && (
            <p className="sub">
              Total XP: <b className="mono">{user.totalXP || 0}</b>
            </p>
          )}

          <MoleMascot />
        </header>

        {/* Step Content */}
        <section className="onb-col">
          {/* STEP 1: WAITLIST */}
          {currentStep === "waitlist" && (
            <div className="p-card">
              {authError && (
                <div className="statline err" style={{ margin: "0 0 12px" }}>
                  {authError}
                </div>
              )}

              <div className="digits">
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
                    aria-label={`Digit ${index + 1}`}
                  />
                ))}
              </div>

              <button
                onClick={handleWaitlistSubmit}
                disabled={code.join("").length !== 8 || waitlistLoading || waitlistSuccess}
                className="p-btn onb-cta"
              >
                {waitlistLoading ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Check size={16} />
                )}
                <span>
                  {waitlistLoading ? "VERIFYING..." : waitlistSuccess ? "VERIFIED!" : "VERIFY CODE"}
                </span>
              </button>

              {waitlistError && <div className="statline err">{waitlistError}</div>}

              {waitlistSuccess && (
                <div className="statline ok">
                  Code verified! Proceeding to Twitter login...
                </div>
              )}

              <p className="onb-helper">
                Find invite code on Twitter or from your Community!
              </p>
            </div>
          )}

          {/* STEP 2: TWITTER CONNECT */}
          {currentStep === "twitter" && (
            <div className="p-card">
              {authError && (
                <div className="statline err" style={{ margin: "0 0 12px" }}>
                  {authError}
                </div>
              )}

              <button onClick={handleTwitterConnect} className="p-btn onb-cta">
                <FaXTwitter size={15} />
                <span>CONNECT WITH X</span>
              </button>

              {/* Divider */}
              <div className="or-row">
                <i />
                <span>OR</span>
                <i />
              </div>

              {/* Wallet Connect Button */}
              <button
                onClick={handleWalletConnect}
                disabled={walletConnecting}
                className="p-btn ghost onb-cta"
                style={{ marginTop: 0 }}
              >
                {walletConnecting ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Wallet size={16} />
                )}
                <span>{walletConnecting ? "CONNECTING..." : "CONNECT WALLET"}</span>
              </button>

              <p className="onb-helper">Connect to prove you are a hooman!</p>
            </div>
          )}

          {/* STEP 3: TASKS */}
          {currentStep === "tasks" && (
            <>
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
                  <button onClick={() => setIsModalOpen(true)} className="p-btn">
                    <Gamepad2 size={16} />
                    <span>PLAY GAME</span>
                  </button>
                </div>
              </div>

              {/* User info */}
              {user && (
                <div className="p-card">
                  <div className="li-line">
                    Logged in as <b>@{user.username}</b>
                  </div>
                  {referralLink && (
                    <div className="li-line ref">
                      Your referral link: <b className="mono">{referralLink}</b>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>

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
        .step-dots { display: flex; gap: 10px; margin: 18px 0 0; }
        .step-dots span {
          width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center;
          font-family: var(--font-num); font-weight: 800; font-size: 13.5px;
        }
        .step-dots .cur {
          background: var(--amber); color: #3d2410;
          box-shadow: 0 2px 0 rgba(42,24,10,.3), inset 0 1px 0 rgba(255,255,255,.4);
        }
        .step-dots .past { background: var(--moss); color: #fff; }
        .step-dots .fut { background: rgba(44,26,12,.16); color: #7a5c3e; }
        .digits { margin-top: 4px; }
        .onb-cta { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
        .onb-helper {
          margin: 18px 0 0; text-align: center; font-size: 11px; font-weight: 800;
          letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3);
        }
        .or-row { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
        .or-row i { flex: 1; height: 1px; background: rgba(44,26,12,.16); }
        .or-row span { font-size: 11px; font-weight: 800; letter-spacing: .1em; color: var(--ink-3); }
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
        .li-line { font-size: 13.5px; color: var(--ink-2); }
        .li-line b { color: var(--ink); }
        .li-line + .li-line { margin-top: 8px; }
        .li-line.ref b { color: var(--amber); word-break: break-all; font-weight: 700; }
        .p-btn:disabled { opacity: .6; cursor: not-allowed; }
      `}</style>
    </>
  );
}
