"use client";
import React from "react";
import { NavBar, BackgroundImage, MoleMascot } from "./shared";

/* page-scoped Burrow styles — lifted from the daily.html prototype */
const PAGE_CSS = `
.stage-wrap { margin-top: 6px; }
.wheel-stage { position: relative; width: min(340px, 80vw); margin: 18px auto 0; }
.wheel-svg { width: 100%; height: auto; display: block; }
.mole-spot { position: absolute; left: -96px; top: 12%; width: 150px; height: 150px; }
.mole-spot .mole { position: static; right: auto; top: auto; display: block; width: 100%; height: 100%; transform: rotate(7deg); }
.arm { position: absolute; right: -20px; top: 84px; width: 64px; height: 44px; }
@media (max-width: 700px) {
  .mole-spot { left: -30px; width: 104px; height: 104px; top: auto; bottom: -6px; }
  .arm { right: -14px; top: 54px; width: 46px; height: 32px; }
}
.wheel-note { max-width: 460px; margin: 28px auto 0; text-align: center; }
.wheel-note p { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--p-card-ink-2); }
`;

/* ---- drawn prize wheel (static art; the original wheel has no spin handler) ---- */
const WEDGES = [
  { t: "+50 XP", f: "#f0a03c", ink: "#3d2410" },
  { t: "+100 XP", f: "#fdf4e6", ink: "#3d2410" },
  { t: "SPIN AGAIN", f: "#2f7d4f", ink: "#fdf4e6" },
  { t: "+250 XP", f: "#f4e6cf", ink: "#3d2410" },
  { t: "+25 XP", f: "#cd5f2a", ink: "#fff0d6" },
  { t: "+500 XP", f: "#fdf4e6", ink: "#3d2410" },
  { t: "SPIN AGAIN", f: "#5c9440", ink: "#fdf4e6" },
  { t: "+150 XP", f: "#f4e6cf", ink: "#3d2410" },
];

const CX = 170;
const CY = 196;
const R = 148;
const D = Math.PI / 180;
const pt = (deg: number, r: number): [number, number] => [
  CX + r * Math.cos(deg * D),
  CY + r * Math.sin(deg * D),
];

const WheelSVG = () => (
  <svg
    className="wheel-svg"
    viewBox="0 0 340 372"
    role="img"
    aria-label="Daily prize wheel — eight XP wedges, decorative until Season 2"
  >
    <defs>
      <radialGradient id="hubg" cx="35%" cy="30%" r="80%">
        <stop offset="0%" stopColor="#b8794a" />
        <stop offset="100%" stopColor="#6b4423" />
      </radialGradient>
    </defs>
    <ellipse cx="170" cy="362" rx="118" ry="9" fill="rgba(42,24,10,.28)" />
    <circle cx="170" cy="196" r="154" fill="#5c3719" stroke="#3E2410" strokeWidth="10" />
    {WEDGES.map((w, i) => {
      const a0 = -90 + i * 45;
      const [x0, y0] = pt(a0, R);
      const [x1, y1] = pt(a0 + 45, R);
      return (
        <path
          key={i}
          d={`M${CX} ${CY} L${x0.toFixed(1)} ${y0.toFixed(1)} A${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z`}
          fill={w.f}
          stroke="#3E2410"
          strokeWidth="3"
          strokeLinejoin="round"
        />
      );
    })}
    {WEDGES.map((w, i) => {
      const mid = -90 + (i + 0.5) * 45;
      const [tx, ty] = pt(mid, 99);
      let deg = mid;
      const n = ((mid % 360) + 360) % 360;
      if (n > 90 && n < 270) deg += 180; /* keep left-side labels right side up */
      return (
        <text
          key={i}
          x={tx.toFixed(1)}
          y={ty.toFixed(1)}
          transform={`rotate(${deg.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)})`}
          textAnchor="middle"
          dominantBaseline="middle"
          fontSize={w.t.length > 7 ? 11 : 14.5}
          fontWeight={800}
          letterSpacing=".05em"
          fill={w.ink}
        >
          {w.t}
        </text>
      );
    })}
    {WEDGES.map((_, i) => {
      const [sx, sy] = pt(-90 + i * 45, 154);
      return (
        <circle
          key={i}
          cx={sx.toFixed(1)}
          cy={sy.toFixed(1)}
          r="4"
          fill="#ffd66b"
          stroke="#3E2410"
          strokeWidth="1.5"
        />
      );
    })}
    <circle cx="170" cy="196" r="34" fill="url(#hubg)" stroke="#3E2410" strokeWidth="3" />
    <g
      transform="translate(146,172) scale(2)"
      fill="none"
      stroke="#ffd9a8"
      strokeWidth="2.2"
      strokeLinecap="round"
    >
      <path d="M3.5 17.5c0-4.7 3.8-8.5 8.5-8.5s8.5 3.8 8.5 8.5" />
      <circle cx="9" cy="14" r="1.2" fill="#ffd9a8" stroke="none" />
      <circle cx="15" cy="14" r="1.2" fill="#ffd9a8" stroke="none" />
      <path d="M12 16.5v1.4" />
    </g>
    <path d="M150 8 L190 8 L170 50 Z" fill="#b8371f" stroke="#3E2410" strokeWidth="3" strokeLinejoin="round" />
    <circle cx="170" cy="16" r="4.5" fill="#ffd66b" stroke="#3E2410" strokeWidth="1.5" />
  </svg>
);

const DailyPage = () => {
  return (
    <>
      <BackgroundImage />
      <NavBar />
      <QuestCardComponent />
    </>
  );
};

export default DailyPage;

export const QuestCardComponent = () => {
  return (
    <div className="w-full">
      <style>{PAGE_CSS}</style>

      {/* Hero */}
      <header className="hero">
        <h1>Daily wheel.</h1>
        <p className="sub">
          Spin once a day for bonus XP — +50 to +500 a pop, with the odd
          spin-again mercy wedge. The mole is guarding the crank until launch.
        </p>
      </header>

      {/* The original page keeps a commented-out header ("Welcome to Daily Wheel")
          and ships the wheel with no click handler — faithfully static here too. */}
      <section className="stage-wrap">
        <div className="wheel-stage">
          <WheelSVG />
          <div className="mole-spot" aria-hidden="true">
            <MoleMascot />
            <svg className="arm" viewBox="0 0 64 44">
              <path d="M6 36 Q30 30 50 14" stroke="#6b4423" strokeWidth="10" strokeLinecap="round" fill="none" />
              <circle cx="53" cy="12" r="7.5" fill="#8a5c33" />
            </svg>
          </div>
        </div>
        <div className="p-card tight wheel-note">
          <p>The daily wheel is warming up. Spins land with Season 2.</p>
        </div>
      </section>
    </div>
  );
};
