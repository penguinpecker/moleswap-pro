"use client";

import React, { useState, useEffect } from "react";
import { BackgroundImage, NavBar, MoleMascot } from "../shared";

interface Mole {
  id: number;
  visible: boolean;
  hit: boolean;
}

interface MoleWhackProps {
  onMoleHit?: (xp: number) => void;
  onGameEnd?: () => void;
  xpClaimed?: boolean;
}

export default function MoleWhack({
  onMoleHit,
  onGameEnd,
  xpClaimed = false,
}: MoleWhackProps) {
  const [score, setScore] = useState(0);
  const [xp, setXp] = useState(0);
  const [gameActive, setGameActive] = useState(true);
  const [gameTime, setGameTime] = useState(30);
  const [moles, setMoles] = useState<Mole[]>([
    { id: 0, visible: false, hit: false },
    { id: 1, visible: false, hit: false },
    { id: 2, visible: false, hit: false },
    { id: 3, visible: false, hit: false },
    { id: 4, visible: false, hit: false },
    { id: 5, visible: false, hit: false },
    { id: 6, visible: false, hit: false },
  ]);

  // 🪓 Hammer cursor state
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [isHitting, setIsHitting] = useState(false);

  // Track mouse movement relative to the game container
  const gameContainerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (gameContainerRef.current) {
        const rect = gameContainerRef.current.getBoundingClientRect();
        setMousePos({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        });
      } else {
        setMousePos({ x: e.clientX, y: e.clientY });
      }
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Handle hammer hit animation
  const handleHit = () => {
    setIsHitting(true);
    setTimeout(() => setIsHitting(false), 150);
  };

  // Game timer
  useEffect(() => {
    if (!gameActive) return;
    const timer = setInterval(() => {
      setGameTime((prev) => {
        if (prev <= 1) {
          setGameActive(false);
          // Notify parent that game ended
          if (onGameEnd) {
            onGameEnd();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [gameActive, onGameEnd]);

  // Mole pop-up logic
  useEffect(() => {
    if (!gameActive) return;

    const popInterval = setInterval(() => {
      setMoles((prev) =>
        prev.map((mole) => {
          if (!mole.visible && Math.random() > 0.7) {
            return { ...mole, visible: true, hit: false };
          }
          return mole;
        }),
      );
    }, 600);

    const hideInterval = setInterval(() => {
      setMoles((prev) =>
        prev.map((mole) => {
          if (mole.visible && !mole.hit && Math.random() > 0.5) {
            return { ...mole, visible: false };
          }
          return mole;
        }),
      );
    }, 1500);

    return () => {
      clearInterval(popInterval);
      clearInterval(hideInterval);
    };
  }, [gameActive]);

  // Handle mole click
  const handleMoleClick = (moleId: number) => {
    if (!gameActive) return;

    handleHit(); // 🪓 Trigger hammer animation
    setScore((s) => s + 1);
    setXp((x) => x + 50); // 50 XP per mole

    setMoles((prev) => {
      const mole = prev.find((m) => m.id === moleId);
      if (mole && mole.visible && !mole.hit) {
        // Call the onMoleHit callback if provided
        if (onMoleHit) {
          onMoleHit(50);
        }
        setTimeout(() => {
          setMoles((current) =>
            current.map((m) =>
              m.id === moleId ? { ...m, visible: false, hit: false } : m,
            ),
          );
        }, 50);
        return prev.map((m) => (m.id === moleId ? { ...m, hit: true } : m));
      }
      return prev;
    });
  };

  const resetGame = () => {
    setScore(0);
    setXp(0);
    setGameTime(30);
    setGameActive(true);
    setMoles((prev) => prev.map((m) => ({ ...m, visible: false, hit: false })));
  };

  // The game board — sky-to-grass gradient field, drawn pits and moles.
  // Fills its parent, so it drops into the modal / quest containers unchanged.
  const game = (
    <div
      ref={gameContainerRef}
      className="wk-area game-container relative flex h-full w-full cursor-none flex-col overflow-hidden p-3 sm:p-4 md:p-5 lg:p-6"
    >
      {/* Score board */}
      <div className="relative z-10 mx-auto flex w-full items-center justify-center gap-3 sm:gap-4 md:gap-5 lg:gap-6">
        {[
          { label: "⏱ TIME", value: gameTime },
          { label: "⚡ XP", value: xp.toString().padStart(3, "0") },
        ].map(({ label, value }, i) => (
          <div key={i} className="wk-tile">
            <span className="lb">{label}</span>
            <b>{value}</b>
          </div>
        ))}
      </div>

      {/* Game area */}
      <div className="relative mx-auto mt-3 flex w-full flex-1 items-center justify-center sm:mt-4 md:mt-5 lg:mt-6">
        {moles.map((mole, index) => {
          const positions = [
            { top: "10%", left: "15%" },
            { top: "10%", left: "85%" },
            { top: "20%", left: "50%" },
            { top: "40%", left: "20%" },
            { top: "40%", left: "80%" },
            { top: "75%", left: "35%" },
            { top: "75%", left: "75%" },
          ];

          return (
            <div
              key={mole.id}
              className="absolute flex size-[120px] items-center justify-center overflow-hidden sm:size-[140px] md:size-[160px] lg:size-[180px]"
              style={{
                top: positions[index]?.top || "50%",
                left: positions[index]?.left || "50%",
                transform: "translate(-50%, -50%)",
              }}
            >
              {/* the pit — a dark carved ellipse, no image assets */}
              <div className="wk-pit" aria-hidden="true" />

              {mole.visible && (
                <div
                  onClick={() => handleMoleClick(mole.id)}
                  className={`absolute size-12 transition-all duration-300 select-none sm:size-14 md:size-15 lg:size-16 ${
                    mole.hit ? "scale-75 opacity-50" : "animate-pop-up"
                  }`}
                  style={{
                    top: "45%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    animationPlayState: mole.hit ? "paused" : "running",
                  }}
                >
                  {/* drawn Burrow mole — same dome/eyes/nose/whiskers as the mascot */}
                  <svg
                    viewBox="16 60 88 46"
                    aria-hidden="true"
                    className="size-[60px] object-contain select-none sm:size-[70px] md:size-[75px] lg:size-[85px]"
                  >
                    <path d="M22 104c0-24 17-42 38-42s38 18 38 42Z" fill="#6b4423" />
                    <path d="M30 104c0-20 13-34 30-34s30 14 30 34Z" fill="#8a5c33" />
                    <circle cx="49" cy="86" r="4.2" fill="#2a180a" />
                    <circle cx="71" cy="86" r="4.2" fill="#2a180a" />
                    <circle cx="50.4" cy="84.6" r="1.4" fill="#fff" opacity=".85" />
                    <circle cx="72.4" cy="84.6" r="1.4" fill="#fff" opacity=".85" />
                    <ellipse cx="60" cy="95" rx="6" ry="4.4" fill="#e88f8f" />
                    <path
                      d="M34 96c-6 2-10 5-12 9M86 96c6 2 10 5 12 9"
                      stroke="#5c3a1e"
                      strokeWidth="3"
                      strokeLinecap="round"
                      fill="none"
                    />
                  </svg>
                  {mole.hit && (
                    <div className="absolute inset-0 flex animate-bounce items-center justify-center text-4xl">
                      💥
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Game over screen - hidden when onGameEnd callback is provided (modal handles it) */}
      {!gameActive && !onGameEnd && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[rgba(20,10,4,.62)]">
          <div className="wk-go-panel">
            <h3>Game over!</h3>
            <div className="wk-xpline">
              <b>{xp} XP</b>
              <span>EARNED</span>
            </div>
            <div className="wk-hits">Moles hit: {score}</div>
            <button onClick={resetGame} className="wk-again">
              Play again
            </button>
          </div>
        </div>
      )}

      {/* 🪓 Custom hammer cursor */}
      <div
        className={`pointer-events-none absolute z-[9999] transition-transform duration-75 ${
          isHitting ? "translate-y-3 rotate-[-25deg]" : "rotate-0"
        }`}
        style={{
          left: mousePos.x - 20,
          top: mousePos.y - 40,
        }}
      >
        <span className="wk-hammer" aria-hidden="true">
          🔨
        </span>
      </div>

      <style jsx global>{`
        .wk-area {
          background: linear-gradient(
            180deg,
            #ffe3b0 0%,
            #ffcf8a 14%,
            #8fbf68 27%,
            #5c9440 58%,
            #47772f 100%
          );
          touch-action: manipulation;
        }
        .wk-tile {
          min-width: 84px;
          padding: 6px 14px 7px;
          border-radius: 12px;
          text-align: center;
          background: linear-gradient(180deg, var(--cream), var(--cream-2));
          border: 1px solid rgba(255, 255, 255, 0.65);
          box-shadow:
            0 2px 0 rgba(42, 24, 10, 0.28),
            inset 0 2px 0 rgba(255, 255, 255, 0.7);
          color: var(--ink);
        }
        .wk-tile .lb {
          display: block;
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.12em;
          color: var(--ink-3);
        }
        .wk-tile b {
          display: block;
          margin-top: 1px;
          font-family: var(--font-num);
          font-size: 17px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
        }
        .wk-pit {
          position: absolute;
          left: 8%;
          right: 8%;
          top: 50%;
          height: 30%;
          border-radius: 50%;
          background: radial-gradient(ellipse at 50% 42%, #241305 0%, #170c04 70%);
          box-shadow:
            inset 0 3px 6px rgba(0, 0, 0, 0.65),
            0 1px 0 rgba(255, 255, 255, 0.14);
        }
        .wk-hammer {
          display: block;
          font-size: 42px;
          line-height: 1;
          filter: drop-shadow(2px 3px 0 rgba(42, 24, 10, 0.35));
        }
        .wk-go-panel {
          text-align: center;
          padding: 26px 36px;
          border-radius: 18px;
          color: var(--ink);
          background: linear-gradient(180deg, var(--cream), var(--cream-2));
          border: 1px solid rgba(255, 255, 255, 0.6);
          box-shadow: var(--sh-2);
        }
        .wk-go-panel h3 {
          margin: 0;
          font-size: 1.45rem;
          font-weight: 800;
          letter-spacing: -0.02em;
        }
        .wk-xpline {
          margin-top: 12px;
        }
        .wk-xpline b {
          font-family: var(--font-num);
          font-size: 1.6rem;
          font-weight: 700;
        }
        .wk-xpline span {
          display: block;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.14em;
          color: var(--ink-3);
          margin-top: 2px;
        }
        .wk-hits {
          margin-top: 10px;
          font-size: 12px;
          font-weight: 700;
          color: var(--ink-2);
        }
        .wk-again {
          margin-top: 16px;
          border: 0;
          cursor: pointer;
          font: inherit;
          font-size: 13px;
          font-weight: 800;
          letter-spacing: 0.02em;
          color: #fff;
          padding: 11px 22px;
          border-radius: 12px;
          background: linear-gradient(180deg, #3f9e66, var(--moss));
          box-shadow:
            0 3px 0 #1e5535,
            inset 0 1px 0 rgba(255, 255, 255, 0.35);
        }
        .wk-again:active {
          transform: translateY(1px);
          box-shadow: 0 1px 0 #1e5535;
        }
        .wk-wrap {
          max-width: 760px;
          margin: 6px auto 0;
        }
        .wk-shell {
          position: relative;
          aspect-ratio: 1;
          border-radius: var(--r-xl);
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.35);
          box-shadow: var(--sh-2);
        }
        @media (max-width: 560px) {
          .wk-shell {
            aspect-ratio: 4 / 5;
          }
        }
      `}</style>
    </div>
  );

  // Embedded (modal / quest): the host container sizes and frames the game.
  if (onMoleHit || onGameEnd) {
    return game;
  }

  // Standalone page: full Burrow chrome + hero, game in a framed shell.
  return (
    <>
      <BackgroundImage />
      <NavBar />
      <main>
        <header className="hero">
          <h1>Whack-a-Mole.</h1>
          <p className="sub">30 seconds. Seven holes. 50 XP a mole.</p>
          <MoleMascot />
        </header>
        <section className="wk-wrap">
          <div className="wk-shell">{game}</div>
        </section>
      </main>
    </>
  );
}
