"use client";

import React, { useState, useEffect } from "react";
import Image from "next/image";

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
    setGameTime(60);
    setGameActive(true);
    setMoles((prev) => prev.map((m) => ({ ...m, visible: false, hit: false })));
  };

  return (
    <div
      ref={gameContainerRef}
      className="game-container relative flex h-full w-full cursor-none flex-col overflow-hidden bg-[url(/wack/bg.png)] bg-cover bg-center p-3 sm:p-4 md:p-5 lg:p-6"
    >
      {/* Background images */}
      <div className="pointer-events-none absolute inset-0">
        <Image
          src="/wack/tree-top-left.png"
          alt=""
          width={300}
          height={300}
          className="absolute top-0 left-0 w-[50px] object-cover select-none sm:w-[100px]"
          priority
        />
        <Image
          src="/wack/tree-top-right.png"
          alt=""
          width={300}
          height={300}
          className="absolute top-0 right-0 w-[50px] object-cover select-none sm:w-[100px]"
          priority
        />
        <Image
          src="/wack/left-bottom.png"
          alt=""
          width={175}
          height={175}
          className="absolute bottom-0 left-0 w-[50px] object-cover select-none sm:w-[100px]"
        />
        <div className="absolute right-0 bottom-0 flex items-end max-sm:hidden">
          <Image
            src="/wack/right-bottom-2.png"
            alt=""
            width={150}
            height={150}
            className="relative w-[50px] object-cover select-none"
          />
          <Image
            src="/wack/right-bottom.png"
            alt=""
            width={150}
            height={150}
            className="relative w-[50px] object-cover select-none"
          />
        </div>
      </div>

      {/* Score board */}
      <div className="relative z-10 mx-auto flex w-full items-center justify-center gap-3 sm:gap-4 md:gap-5 lg:gap-6">
        {[
          { icon: "/wack/stopwatch.png", value: gameTime },
          { icon: "/wack/xp.png", value: xp.toString().padStart(3, "0") },
        ].map(({ icon, value }, i) => (
          <div
            key={i}
            className="relative flex h-[70px] w-[120px] items-center justify-center p-3"
          >
            <Image
              src="/wack/score.png"
              alt=""
              fill
              className="pointer-events-none object-contain select-none"
            />
            <Image
              src={icon}
              alt=""
              width={40}
              height={40}
              className="absolute -top-2 -left-2 z-10 h-8 w-8 select-none sm:h-9 sm:w-9 md:h-10 md:w-10"
            />
            <span className="font-family-ThaleahFat relative z-20 text-center text-2xl font-bold text-amber-200 drop-shadow-[2px_2px_0_#000] sm:text-2xl md:text-3xl">
              {value}
            </span>
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
              <Image
                src="/wack/holes.png"
                alt=""
                width={200}
                height={200}
                className="pointer-events-none absolute inset-0 h-full w-full object-contain select-none"
              />

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
                  <Image
                    src="/wack/mole-popping.png"
                    alt=""
                    width={50}
                    height={50}
                    className="size-[60px] object-contain select-none sm:size-[70px] md:size-[75px] lg:size-[85px]"
                  />
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div
            className="relative rounded-lg border-4 border-[#5D2C28] bg-[#784834] p-6 text-center sm:p-8"
            style={{
              boxShadow:
                "8px 8px 0px 0px #5D2C28, 4px 4px 0px 0px #8A4836, inset 0px 0px 0px 1px rgba(255, 255, 255, 0.1)",
            }}
          >
            <h2 className="font-family-ThaleahFat text-peach-300 mb-6 text-3xl font-bold sm:text-4xl">
              GAME OVER!
            </h2>
            <div className="mb-4 flex items-center justify-center gap-3">
              <Image
                src="/wack/xp.png"
                alt="XP"
                width={40}
                height={40}
                className="h-10 w-10 sm:h-12 sm:w-12"
              />
              <div className="flex flex-col">
                <p className="font-family-ThaleahFat text-peach-300 text-2xl font-thin sm:text-3xl">
                  {xp} XP
                </p>
                <p className="font-family-ThaleahFat text-peach-300/80 text-sm sm:text-base">
                  EARNED
                </p>
              </div>
            </div>
            <p className="font-family-ThaleahFat text-peach-300/80 mb-6 text-lg sm:text-xl">
              MOLES HIT: {score}
            </p>
            <button
              onClick={resetGame}
              className="font-family-ThaleahFat relative rounded-lg border-2 border-black bg-green-600 px-6 py-3 text-lg font-thin text-white transition-all hover:scale-105 hover:bg-green-700 sm:px-8 sm:py-4 sm:text-xl"
              style={{
                boxShadow:
                  "4px 4px 0px 0px #000000, 2px 2px 0px 0px #8A4836, inset 0px 0px 0px 1px rgba(255, 255, 255, 0.1)",
              }}
            >
              PLAY AGAIN
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
        <Image
          src="/wack/hammer.svg"
          alt="hammer"
          width={80}
          height={80}
          className="object-contain"
        />
      </div>
    </div>
  );
}
