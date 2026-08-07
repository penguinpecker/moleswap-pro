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
        className="h-[70vh] max-h-[90vh] w-[70vw] overflow-hidden rounded-none border-4 border-black bg-white p-0 shadow-[8px_8px_0px_0px_rgba(0,0,0,0.3)] sm:max-w-3xl"
        showCloseButton={true}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden bg-white">
          {/* Milestone Display - Top of Modal */}
          {showMilestone && (
            <div className="absolute top-4 left-1/2 z-[10001] -translate-x-1/2 rounded-lg border-4 border-green-500 bg-green-900 px-6 py-4 shadow-lg">
              <p className="font-family-ThaleahFat text-xl font-bold text-green-100 sm:text-2xl md:text-3xl">
                {milestoneText}
              </p>
            </div>
          )}
          
          <div className="relative flex h-full w-full items-center justify-center">
            {/* Close Button */}
            <DialogClose asChild>
              <button
                className="absolute top-4 right-4 z-[10001] flex h-8 w-8 items-center justify-center rounded-lg border-2 border-black bg-red-500 text-white transition-all hover:scale-110 hover:bg-red-600 sm:h-12 sm:w-12"
                style={{
                  boxShadow:
                    "4px 4px 0px 0px #000000, 2px 2px 0px 0px #8A4836, inset 0px 0px 0px 1px rgba(255, 255, 255, 0.1)",
                }}
                aria-label="Close game"
              >
                <X className="h-6 w-6" />
              </button>
            </DialogClose>
            <MoleWhack key={gameKey} onMoleHit={handleMoleHit} onGameEnd={handleGameEnd} xpClaimed={xpClaimed} />
            {showWinMessage && (
              <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70">
                <div className="relative mx-4 max-w-md rounded-lg border-4 border-green-500 bg-green-900 p-6 text-center">
                  <h2 className="font-family-ThaleahFat mb-4 text-3xl font-bold text-green-100 sm:text-4xl">
                    Game End!
                  </h2>
                  <p className="font-family-ThaleahFat mb-4 text-2xl text-green-300 sm:text-3xl">
                    {submittingXP ? "Submitting..." : earnedXP !== null ? `+${earnedXP} XP earned` : "+0 XP earned"}
                  </p>
                  <div className="flex gap-3 justify-center">
                    <button
                      onClick={handlePlayAgain}
                      disabled={submittingXP}
                      className="font-family-ThaleahFat cursor-pointer rounded-lg bg-blue-600 px-6 py-3 text-lg font-bold text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Play Again
                    </button>
                    <button
                      onClick={() => {
                        setShowWinMessage(false);
                        onOpenChange(false);
                      }}
                      className="font-family-ThaleahFat cursor-pointer rounded-lg bg-green-600 px-6 py-3 text-lg font-bold text-white transition-colors hover:bg-green-700"
                    >
                      Close
                    </button>
                  </div>
                </div>
              </div>
            )}
            {xpClaimed && hasWon && !showWinMessage && showXpClaimedMessage && (
              <div className="absolute right-4 bottom-4 z-[10000] rounded-lg border-2 border-yellow-500 bg-yellow-900/90 px-4 py-2">
                <p className="font-family-ThaleahFat text-sm text-yellow-100 sm:text-base">
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
