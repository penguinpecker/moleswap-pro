"use client";

import type React from "react";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Image from "next/image";

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
    <div className="relative min-h-screen bg-[url(/diamond-miner/cave-bg.png)] bg-cover p-8">
      {/* Header and score */}
      <div className="mx-auto flex w-full items-center justify-center gap-6">
        {[{ icon: "/wack/xp.png", value: "0000" }].map(({ icon, value }, i) => (
          <div
            key={i}
            className="relative flex h-[70px] w-[120px] items-center justify-center p-4 md:h-[60px] md:w-[100px]"
          >
            {/* Background */}
            <Image
              src="/wack/score.png"
              alt="Background board"
              fill
              className="pointer-events-none object-contain select-none"
            />

            {/* Icon */}
            <Image
              src={icon}
              alt="Icon"
              width={40}
              height={40}
              className="absolute -top-3 -left-3 z-10"
            />

            {/* Text */}
            <span className="font-family-ThaleahFat relative z-20 text-center text-3xl text-amber-200 drop-shadow-[2px_2px_0_#000]">
              {value}
            </span>
          </div>
        ))}
      </div>
      <div className="flex w-full items-center justify-center">
        <Image
          src="/diamond-miner/mole-cane.svg"
          alt="Diamond Miner"
          width={150}
          height={150}
          className=""
        />
      </div>
      <div className="grid w-full grid-cols-2 place-items-center gap-2">
        <Image
          src="/diamond-miner/rock.svg"
          alt="Diamond Miner"
          width={50}
          height={50}
        />
        <Image
          src="/diamond-miner/diamond.svg"
          alt="Diamond Miner"
          width={50}
          height={50}
        />
        <Image
          src="/diamond-miner/rock.svg"
          alt="Diamond Miner"
          width={50}
          height={50}
        />
        <Image
          src="/diamond-miner/diamond.svg"
          alt="Diamond Miner"
          width={50}
          height={50}
        />
        <Image
          src="/diamond-miner/rock.svg"
          alt="Diamond Miner"
          width={50}
          height={50}
        />
        <Image
          src="/diamond-miner/diamond.svg"
          alt="Diamond Miner"
          width={50}
          height={50}
        />
      </div>
    </div>
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
