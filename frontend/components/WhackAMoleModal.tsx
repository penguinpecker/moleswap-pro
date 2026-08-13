"use client";

import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import { X } from "lucide-react";
import MoleWhack from "@/screens/MoleWhack";
import { xpAPI } from "@/lib/api/client";

interface WhackAMoleModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onXpClaimed: () => void;
  xpClaimed: boolean;
}

export default function WhackAMoleModal({
  open,
  onOpenChange,
  onXpClaimed,
  xpClaimed,
}: WhackAMoleModalProps) {
  const [gameStartTime, setGameStartTime] = useState<number | null>(null);
  const [hasWon, setHasWon] = useState(false);
  const [showWinMessage, setShowWinMessage] = useState(false);
  const [showXpClaimedMessage, setShowXpClaimedMessage] = useState(false);
  const [totalXp, setTotalXp] = useState(0);
  const [showMilestone, setShowMilestone] = useState(false);
  const [milestoneText, setMilestoneText] = useState("");
  const [moleCount, setMoleCount] = useState(0);
  const [submittingXP, setSubmittingXP] = useState(false);
  const [earnedXP, setEarnedXP] = useState<number | null>(null);
  const [xpSubmitted, setXpSubmitted] = useState(false);
  const [gameKey, setGameKey] = useState(0);
  const [gameEnded, setGameEnded] = useState(false);

  // Reset game state when modal opens
  useEffect(() => {
    if (open) {
      setGameStartTime(Date.now());
      setHasWon(false);
      setShowWinMessage(false);
      setShowXpClaimedMessage(xpClaimed);
      setTotalXp(0);
      setShowMilestone(false);
      setMoleCount(0);
      setSubmittingXP(false);
      setEarnedXP(null);
      setXpSubmitted(false);
      setGameEnded(false);
      setGameKey((prev) => prev + 1); // Reset game component
    }
  }, [open, xpClaimed]);

  // Milestone thresholds (only up to 1500 max)
  const milestones = [
    { xp: 500, text: "🎯 500 XP Milestone!" },
    { xp: 1000, text: "🔥 1000 XP Milestone!" },
    { xp: 1500, text: "⚡ 1500 XP Milestone!" },
  ];

  // Hide XP claimed message after 10 seconds
  useEffect(() => {
    if (showXpClaimedMessage && !showWinMessage) {
      const timer = setTimeout(() => {
        setShowXpClaimedMessage(false);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [showXpClaimedMessage, showWinMessage]);

  const handleMoleHit = async (xpGained: number) => {
    if (!gameStartTime || gameEnded) return;

    // Update mole count
    setMoleCount((prev) => prev + 1);

    // Update total XP and check for milestones and max XP condition
    setTotalXp((prev) => {
      const newXp = prev + xpGained;
      const cappedXp = Math.min(newXp, 1500); // Cap at 1500

      // Check if we reached max XP (1500)
      if (cappedXp >= 1500 && !gameEnded && !xpSubmitted) {
        setGameEnded(true);
        // Submit XP to backend immediately
        if (!xpClaimed) {
          submitGameXP(moleCount + 1, cappedXp).then(() => {
            setShowWinMessage(true);
          });
        } else {
          setEarnedXP(1500);
          setShowWinMessage(true);
        }
        return cappedXp; // Return early to prevent further updates
      }

      // Check if we hit a milestone
      const milestone = milestones.find((m) => cappedXp >= m.xp && prev < m.xp);

      if (milestone) {
        setMilestoneText(milestone.text);
        setShowMilestone(true);
        setTimeout(() => {
          setShowMilestone(false);
        }, 3000);
      }

      return cappedXp;
    });
  };

  // Handle game end (when timer runs out)
  const handleGameEnd = async () => {
    if (gameEnded || xpSubmitted) return;

    setGameEnded(true);

    // Always show the end screen, even if no XP was earned
    const finalXP = Math.min(totalXp, 1500);

    // Submit whatever XP was earned (only if not already claimed)
    if (finalXP > 0 && moleCount > 0 && !xpClaimed) {
      await submitGameXP(moleCount, finalXP);
    } else if (finalXP > 0) {
      // XP already claimed, just set the earned XP for display
      setEarnedXP(finalXP);
    } else {
      // No XP earned, still show the screen
      setEarnedXP(0);
    }

    // Always show the win message
    setShowWinMessage(true);
  };

  const submitGameXP = async (finalMoleCount: number, finalXP: number): Promise<void> => {
    if (submittingXP || xpSubmitted) return;

    setSubmittingXP(true);

    try {
      // Calculate XP earned (capped at 1500)
      const xpToSubmit = Math.min(finalXP, 1500);

      const response = await xpAPI.awardGameXP(finalMoleCount, xpToSubmit);

      if (response.data?.success) {
        console.log('Game XP submitted successfully:', response.data);
        setEarnedXP(response.data.xpEarned || xpToSubmit);
        setXpSubmitted(true);
        onXpClaimed();
      } else if (response.error) {
        console.error('Error submitting game XP:', response.error);
        // Still show earned XP even if there's an error (for display purposes)
        setEarnedXP(Math.min(finalXP, 1500));
      }
    } catch (error) {
      console.error('Failed to submit game XP:', error);
      // Still show earned XP even if there's an error (for display purposes)
      setEarnedXP(Math.min(finalXP, 1500));
    } finally {
      setSubmittingXP(false);
    }
  };

  const handlePlayAgain = () => {
    // Reset game state
    setGameStartTime(Date.now());
    setHasWon(false);
    setShowWinMessage(false);
    setTotalXp(0);
    setShowMilestone(false);
    setMoleCount(0);
    setEarnedXP(null);
    setXpSubmitted(false);
    setSubmittingXP(false);
    setGameEnded(false);
    // Force MoleWhack component to reset by changing key
    setGameKey((prev) => prev + 1);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="h-[70vh] max-h-[90vh] w-[70vw] overflow-hidden rounded-[30px] border border-[rgba(255,255,255,.6)] bg-[#fdf4e6] p-0 shadow-[0_4px_0_rgba(42,24,10,.34),0_40px_90px_rgba(42,24,10,.55)] sm:max-w-3xl"
        showCloseButton={true}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-[#f6e9d3]">
          {/* Milestone Display - Top of Modal */}
          {showMilestone && (
            <div className="absolute top-4 left-1/2 z-[10001] -translate-x-1/2 rounded-2xl border border-[rgba(255,255,255,.6)] bg-gradient-to-b from-[#fdf4e6] to-[#f4e6cf] px-6 py-3 shadow-[0_3px_0_rgba(42,24,10,.32),0_20px_48px_rgba(42,24,10,.42)]">
              <p className="text-lg font-extrabold tracking-tight whitespace-nowrap text-[#2f7d4f] sm:text-xl md:text-2xl">
                {milestoneText}
              </p>
            </div>
          )}

          <div className="relative flex h-full w-full items-center justify-center">
            {/* Close Button */}
            <DialogClose asChild>
              <button
                className="absolute top-4 right-4 z-[10001] flex h-9 w-9 cursor-pointer items-center justify-center rounded-[10px] border border-[rgba(44,26,12,.12)] bg-[#fdf4e6] text-[#6d523a] shadow-[0_2px_0_rgba(42,24,10,.2)] transition-colors hover:bg-[#f4e6cf] hover:text-[#2c1a0c] sm:h-10 sm:w-10"
                aria-label="Close game"
              >
                <X className="h-5 w-5" />
              </button>
            </DialogClose>
            <MoleWhack key={gameKey} onMoleHit={handleMoleHit} onGameEnd={handleGameEnd} xpClaimed={xpClaimed} />
            {showWinMessage && (
              <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-[rgba(20,10,4,.62)]">
                <div className="relative mx-4 w-full max-w-md rounded-[24px] border border-[rgba(255,255,255,.6)] bg-gradient-to-b from-[#fdf4e6] to-[#f6e9d3] p-6 text-center text-[#2c1a0c] shadow-[0_3px_0_rgba(42,24,10,.32),0_20px_48px_rgba(42,24,10,.42)]">
                  <h2 className="mb-3 text-2xl font-extrabold tracking-tight sm:text-3xl">
                    Game End!
                  </h2>
                  <p className="mono mb-5 text-xl font-bold text-[#2f7d4f] sm:text-2xl">
                    {submittingXP ? "Submitting..." : earnedXP !== null ? `+${earnedXP} XP earned` : "+0 XP earned"}
                  </p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={handlePlayAgain}
                      disabled={submittingXP}
                      className="cursor-pointer rounded-xl bg-gradient-to-b from-[#3f9e66] to-[#2f7d4f] px-6 py-3 text-[15px] font-bold text-white shadow-[0_3px_0_#1e5535,inset_0_1px_0_rgba(255,255,255,.35)] transition-transform active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Play Again
                    </button>
                    <button
                      onClick={() => {
                        setShowWinMessage(false);
                        onOpenChange(false);
                      }}
                      className="cursor-pointer rounded-xl border border-[rgba(44,26,12,.12)] bg-[rgba(44,26,12,.07)] px-6 py-3 text-[15px] font-bold text-[#6d523a] transition-colors hover:bg-[rgba(44,26,12,.12)]"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
            {xpClaimed && hasWon && !showWinMessage && showXpClaimedMessage && (
              <div className="absolute right-4 bottom-4 z-[10000] rounded-xl border border-[rgba(240,160,60,.5)] bg-[rgba(240,160,60,.16)] px-4 py-2">
                <p className="text-sm font-bold text-[#8a5a1c] sm:text-base">
                  ✅ XP Already Claimed
                </p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
