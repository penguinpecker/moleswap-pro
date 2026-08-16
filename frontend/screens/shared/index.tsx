"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { FaXTwitter } from "react-icons/fa6";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";

/** The drawn Burrow mole glyph — the brand mark, no image assets. */
export const MoleGlyph = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3.5 17.5c0-4.7 3.8-8.5 8.5-8.5s8.5 3.8 8.5 8.5" />
    <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" />
    <path d="M12 16.5v1.4" />
  </svg>
);

/** The hero mascot — a full drawn mole, replaces the pixel sprites. */
export const MoleMascot = ({ className }: { className?: string }) => (
  <svg className={className ?? "mole"} viewBox="0 0 120 120" aria-hidden="true">
    <ellipse cx="60" cy="104" rx="46" ry="11" fill="rgba(42,24,10,.28)" />
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
);

export const NavBar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const currentPath = usePathname();

  // DEX destinations on the left, game/profile on the right. QUEUE lives only
  // in the expanded menu — the original app's deliberate asymmetry, preserved.
  const LEFT = [
    { href: "/dapp", label: "Swap" },
    { href: "/pools", label: "Pools" },
    { href: "/vault", label: "Vault" },
    { href: "/dca", label: "DCA" },
    { href: "/limit", label: "Limit" },
  ];
  const RIGHT = [
    { href: "/quests", label: "Quests" },
    { href: "/profile", label: "Profile" },
    { href: "/leaderboard", label: "Leaderboard" },
  ];
  const ALL = [...LEFT, ...RIGHT, { href: "/queue", label: "Queue" }];

  const current = (path: string) =>
    currentPath === path ? { "aria-current": "page" as const } : {};

  return (
    <div className="chrome" id="chrome">
      <div className="chrome-in">
        <Link className="brand" href="/" aria-label="MoleSwap home">
          {/* The mole mark. A real asset rather than the drawn MoleGlyph, which stays exported and is
              still used elsewhere. Sized 2x the 32px slot so it stays crisp on retina. */}
          <img className="glyph" src="/mole-logo.png" alt="" width={64} height={64} aria-hidden="true" />
          <div className="name">MoleSwap</div>
        </Link>

        <nav className="tabs" aria-label="Primary">
          {LEFT.map((l) => (
            <Link key={l.href} href={l.href} {...current(l.href)}>
              {l.label}
            </Link>
          ))}
          <span className="nav-gap" aria-hidden="true" />
          {RIGHT.map((l) => (
            <Link key={l.href} href={l.href} {...current(l.href)}>
              {l.label}
            </Link>
          ))}
        </nav>

        <div id="walletSlot">
          <ConnectWalletButton />
        </div>

        <button
          className="burger"
          onClick={() => setIsOpen(!isOpen)}
          aria-label="Menu"
        >
          {isOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {/* Expanded menu — the only place QUEUE appears, like the original. */}
      <div className="menu-panel" hidden={!isOpen}>
        {ALL.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            {...current(l.href)}
            onClick={() => setIsOpen(false)}
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  );
};

export const BackgroundImage = ({
  isLoading, // kept for call-site compatibility — the Burrow ground is static
  getMolePosition,
  ref,
}: {
  isLoading?: boolean;
  getMolePosition?: any;
  ref?: any;
}) => {
  return (
    <>
      {/* Soil strata + grit + grass horizon — the Burrow backdrop, all CSS/SVG. */}
      <div className="ground" aria-hidden="true" />
      <div className="grit" aria-hidden="true" />
      <div className="horizon" aria-hidden="true">
        <svg viewBox="0 0 1200 26" preserveAspectRatio="none">
          <path
            d="M0 26 V10 Q30 2 60 10 T120 10 T180 9 T240 11 T300 8 T360 11 T420 9 T480 10 T540 8 T600 11 T660 9 T720 10 T780 8 T840 11 T900 9 T960 10 T1020 8 T1080 11 T1140 9 T1200 10 V26 Z"
            fill="#5c9440"
          />
          <path
            d="M0 26 V17 Q40 12 80 17 T160 17 T240 16 T320 18 T400 16 T480 17 T560 16 T640 18 T720 16 T800 17 T880 16 T960 18 T1040 16 T1120 17 T1200 17 V26 Z"
            fill="#3f6f2b"
          />
        </svg>
      </div>
    </>
  );
};

export const Footer = () => {
  const currentPath = usePathname();
  const active = (path: string) =>
    currentPath === path ? { color: "#ffe6c4" } : undefined;

  return (
    <footer className="relative z-50 w-full">
      <div className="foot-in">
        <strong>MoleSwap</strong>
        <span>
          DEX aggregator &amp; AMM on Robinhood Chain — swap tokens, earn XP,
          climb the leaderboard.
        </span>
        <nav className="foot-links">
          <Link href="/about" style={active("/about")}>
            About
          </Link>
          <Link href="/terms" style={active("/terms")}>
            Terms
          </Link>
          <Link href="/privacy" style={active("/privacy")}>
            Privacy
          </Link>
          <span className="foot-follow">follow us on</span>
          <Link
            href="https://x.com/moleswapcom"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="MoleSwap on X (Twitter)"
            className="inline-flex items-center"
          >
            <FaXTwitter className="h-4 w-4" />
          </Link>
        </nav>
      </div>
    </footer>
  );
};
