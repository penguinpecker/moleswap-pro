"use client";

import type React from "react";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { BackgroundImage, NavBar } from "../shared";

interface Diamond {
  id: number;
  x: number;
  y: number;
  type: "diamond" | "rock";
}

export default function DiamondMiner() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [score, setScore] = useState(0);
  const [gameActive, setGameActive] = useState(true);
  const [gameTime, setGameTime] = useState(30);
  const [playerX, setPlayerX] = useState(175);
  const [diamonds, setDiamonds] = useState<Diamond[]>([]);
  const diamondIdRef = useRef(0);

  // Initialize diamonds
  useEffect(() => {
    const initialDiamonds: Diamond[] = [];
    for (let i = 0; i < 15; i++) {
      initialDiamonds.push({
        id: i,
        x: Math.random() * 350,
        y: Math.random() * 300 + 100,
        type: Math.random() > 0.7 ? "rock" : "diamond",
      });
    }
    setDiamonds(initialDiamonds);
    diamondIdRef.current = 15;
  }, []);

  // Game timer
  useEffect(() => {
    if (!gameActive) return;
    const timer = setInterval(() => {
      setGameTime((prev) => {
        if (prev <= 1) {
          setGameActive(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [gameActive]);

  // Spawn new diamonds
  useEffect(() => {
    if (!gameActive) return;
    const spawnInterval = setInterval(() => {
      setDiamonds((prev) => [
        ...prev,
        {
          id: diamondIdRef.current++,
          x: Math.random() * 350,
          y: 50,
          type: Math.random() > 0.7 ? "rock" : "diamond",
        },
      ]);
    }, 800);
    return () => clearInterval(spawnInterval);
  }, [gameActive]);

  // Move diamonds down
  useEffect(() => {
    if (!gameActive) return;
    const moveInterval = setInterval(() => {
      setDiamonds((prev) =>
        prev.map((d) => ({ ...d, y: d.y + 3 })).filter((d) => d.y < 500),
      );
    }, 50);
    return () => clearInterval(moveInterval);
  }, [gameActive]);

  // Mouse movement
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!canvasRef.current) return;
      const rect = canvasRef.current.getBoundingClientRect();
      setPlayerX(e.clientX - rect.left - 25);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Click to collect
  const handleCanvasClick = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    setDiamonds((prev) => {
      const newDiamonds = [...prev];
      for (let i = newDiamonds.length - 1; i >= 0; i--) {
        const d = newDiamonds[i];
        const distance = Math.sqrt((clickX - d.x) ** 2 + (clickY - d.y) ** 2);
        if (distance < 20) {
          if (d.type === "diamond") {
            setScore((s) => s + 10);
          } else {
            setScore((s) => Math.max(0, s - 5));
          }
          newDiamonds.splice(i, 1);
          break;
        }
      }
      return newDiamonds;
    });
  };

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear canvas with dark underground background
    ctx.fillStyle = "#2a2416";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw wooden mine structures at top
    ctx.fillStyle = "#8b6f47";
    ctx.fillRect(0, 0, canvas.width, 40);
    ctx.fillStyle = "#6b5535";
    for (let i = 0; i < canvas.width; i += 40) {
      ctx.fillRect(i, 35, 30, 8);
    }

    // Draw mine cart rails
    ctx.strokeStyle = "#a0826d";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 95);
    ctx.lineTo(canvas.width, 95);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 105);
    ctx.lineTo(canvas.width, 105);
    ctx.stroke();

    // Draw mine cart
    const cartX = playerX + 10;
    ctx.fillStyle = "#8b6f47";
    ctx.fillRect(cartX - 30, 70, 60, 25);
    ctx.fillStyle = "#6b5535";
    ctx.fillRect(cartX - 28, 68, 56, 3);

    // Draw cart wheels
    ctx.fillStyle = "#4a4a4a";
    ctx.beginPath();
    ctx.arc(cartX - 20, 100, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cartX + 20, 100, 8, 0, Math.PI * 2);
    ctx.fill();

    // Draw miner character in cart
    // Head with hard hat
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.arc(cartX, 65, 10, 0, Math.PI * 2);
    ctx.fill();

    // Hard hat
    ctx.fillStyle = "#ffed4e";
    ctx.beginPath();
    ctx.arc(cartX, 60, 12, Math.PI, 0, true);
    ctx.fill();
    ctx.fillStyle = "#ff9800";
    ctx.fillRect(cartX - 3, 58, 6, 4);

    // Body
    ctx.fillStyle = "#ffd700";
    ctx.fillRect(cartX - 8, 75, 16, 12);

    // Arms
    ctx.fillStyle = "#ffb347";
    ctx.fillRect(cartX - 12, 76, 4, 10);
    ctx.fillRect(cartX + 8, 76, 4, 10);

    // Draw underground background texture
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    for (let i = 0; i < 20; i++) {
      const x = Math.random() * canvas.width;
      const y = Math.random() * (canvas.height - 120) + 120;
      ctx.fillRect(x, y, Math.random() * 20 + 10, Math.random() * 20 + 10);
    }

    // Draw diamonds and rocks
    diamonds.forEach((d) => {
      if (d.type === "diamond") {
        // Draw diamond with blue shine
        ctx.fillStyle = "#4da6ff";
        ctx.beginPath();
        ctx.moveTo(d.x, d.y - 12);
        ctx.lineTo(d.x + 12, d.y);
        ctx.lineTo(d.x, d.y + 12);
        ctx.lineTo(d.x - 12, d.y);
        ctx.closePath();
        ctx.fill();

        // Diamond shine
        ctx.fillStyle = "#87ceeb";
        ctx.beginPath();
        ctx.moveTo(d.x - 4, d.y - 4);
        ctx.lineTo(d.x + 4, d.y);
        ctx.lineTo(d.x, d.y + 4);
        ctx.lineTo(d.x - 4, d.y);
        ctx.closePath();
        ctx.fill();
      } else {
        // Draw rock
        ctx.fillStyle = "#a9a9a9";
        ctx.beginPath();
        ctx.arc(d.x, d.y, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#808080";
        ctx.beginPath();
        ctx.arc(d.x - 3, d.y - 3, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }, [playerX, diamonds]);

  return (
    <>
      <BackgroundImage />
      <NavBar />
      <main>
        <header className="hero">
          <span className="badge">
            <span className="dot" />
            Mini-game · work in progress
          </span>
          <h1>Diamond Miner.</h1>
          <p className="sub">
            The mole&apos;s next dig. The cave is carved — the game inside is
            still being built.
          </p>
        </header>

        <section className="dm-cave" aria-label="Diamond Miner">
          {/* static score board: hardcoded '0000', exactly like the original */}
          <div className="dm-tile">
            <div className="lbl">XP</div>
            <div className="val">0000</div>
          </div>

          {/* mascot: the Burrow mole holding a cane — drawn, no image assets */}
          <svg
            className="dm-mascot"
            viewBox="0 0 120 120"
            role="img"
            aria-label="Diamond Miner"
          >
            <ellipse cx="60" cy="106" rx="46" ry="10" fill="rgba(0,0,0,.4)" />
            <path d="M22 106c0-24 17-42 38-42s38 18 38 42Z" fill="#6b4423" />
            <path d="M30 106c0-20 13-34 30-34s30 14 30 34Z" fill="#8a5c33" />
            <circle cx="49" cy="88" r="4.2" fill="#2a180a" />
            <circle cx="71" cy="88" r="4.2" fill="#2a180a" />
            <circle cx="50.4" cy="86.6" r="1.4" fill="#fff" opacity=".85" />
            <circle cx="72.4" cy="86.6" r="1.4" fill="#fff" opacity=".85" />
            <ellipse cx="60" cy="97" rx="6" ry="4.4" fill="#e88f8f" />
            <path
              d="M34 98c-6 2-10 5-12 8"
              stroke="#5c3a1e"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M86 98c5 1 8 3 10 6"
              stroke="#5c3a1e"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M99 108V72q0-11-11-11"
              fill="none"
              stroke="#d9a13c"
              strokeWidth="4.5"
              strokeLinecap="round"
            />
            <ellipse cx="99" cy="90" rx="5.5" ry="4.5" fill="#a06a3b" />
          </svg>

          {/* 2×3 grid, alternating rock | diamond per row, like the original */}
          <div className="dm-grid">
            {[0, 1, 2, 3, 4, 5].map((i) =>
              i % 2 === 0 ? (
                <svg
                  key={i}
                  viewBox="0 0 50 50"
                  role="img"
                  aria-label="Diamond Miner"
                >
                  <path
                    d="M25 6l13 5 6 12-5 14-14 6-13-7-4-13 6-12Z"
                    fill="#a9a9a9"
                    stroke="#6f6f6f"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M25 6l4 15 14 2M12 36l17-15"
                    stroke="#808080"
                    strokeWidth="1.6"
                    fill="none"
                  />
                  <ellipse
                    cx="19"
                    cy="16"
                    rx="6"
                    ry="4"
                    fill="rgba(255,255,255,.32)"
                  />
                </svg>
              ) : (
                <svg
                  key={i}
                  viewBox="0 0 50 50"
                  role="img"
                  aria-label="Diamond Miner"
                >
                  <polygon
                    points="25,5 45,25 25,45 5,25"
                    fill="#4da6ff"
                    stroke="#2a7fd4"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M25 5v40M5 25h40"
                    stroke="rgba(255,255,255,.25)"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M14 16l8-8"
                    stroke="#87ceeb"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              ),
            )}
          </div>
        </section>
      </main>

      <style jsx global>{`
        .dm-cave {
          max-width: 640px;
          margin: 6px auto 0;
          padding: 34px 20px 44px;
          border-radius: var(--r-xl);
          background:
            radial-gradient(
              circle at 18% 22%,
              rgba(255, 214, 150, 0.05) 0 60px,
              transparent 61px
            ),
            radial-gradient(
              circle at 84% 68%,
              rgba(255, 214, 150, 0.04) 0 46px,
              transparent 47px
            ),
            linear-gradient(
              180deg,
              #3a2110 0,
              var(--loam-4) 34%,
              #1d1006 70%,
              #140b04 100%
            );
          border: 1px solid rgba(255, 214, 150, 0.14);
          box-shadow:
            var(--sh-2),
            inset 0 1px 0 rgba(255, 214, 150, 0.1);
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 28px;
        }
        .dm-tile {
          min-width: 96px;
          padding: 9px 18px 10px;
          border-radius: 14px;
          text-align: center;
          background: linear-gradient(180deg, var(--cream), var(--cream-2));
          border: 1px solid rgba(255, 255, 255, 0.6);
          color: var(--ink);
          box-shadow:
            0 2px 0 rgba(42, 24, 10, 0.28),
            0 8px 22px rgba(42, 24, 10, 0.3),
            var(--sh-in);
        }
        .dm-tile .lbl {
          font-size: 9.5px;
          font-weight: 800;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--ink-3);
        }
        .dm-tile .val {
          margin-top: 2px;
          font-family: var(--font-num);
          font-variant-numeric: tabular-nums;
          font-size: 1.35rem;
          font-weight: 700;
          letter-spacing: -0.02em;
          line-height: 1;
        }
        .dm-mascot {
          width: 150px;
          height: 150px;
        }
        .dm-grid {
          display: grid;
          grid-template-columns: repeat(2, 50px);
          gap: 10px;
          place-items: center;
        }
        .dm-grid svg {
          width: 50px;
          height: 50px;
          display: block;
        }
      `}</style>
    </>
  );
}
{
  /* <div className="mx-auto max-w-2xl">
        <canvas
          ref={canvasRef}
          width={400}
          height={500}
          onClick={handleCanvasClick}
          className="mx-auto cursor-crosshair rounded-lg border-4 border-blue-500 bg-slate-900"
        />

        {!gameActive && (
          <div className="mt-4 rounded-lg bg-slate-800 p-6 text-center">
            <h2 className="mb-2 text-2xl font-bold text-white">Game Over!</h2>
            <p className="mb-4 text-xl text-yellow-400">Final Score: {score}</p>
            <Link href="/games/diamond-miner">
              <Button className="bg-blue-500 hover:bg-blue-600">
                Play Again
              </Button>
            </Link>
          </div>
        )}

        <p className="mt-4 text-center text-gray-400">
          Click on diamonds to collect them! Avoid rocks!
        </p>
      </div> */
}
