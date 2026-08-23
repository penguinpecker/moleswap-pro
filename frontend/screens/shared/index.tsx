"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { FaXTwitter } from "react-icons/fa6";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { ChainSwitcher } from "@/components/ChainSwitcher";

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

/**
 * The site mascot — the brand mark, used at ~25 call sites from a 92px avatar to the 132px hero peek.
 *
 * Swapped from a drawn SVG to the real asset on 2026-08-16, keeping the export name, the `className`
 * contract and the default `.mole` class byte-for-byte — so every existing sizing rule (`.mole`,
 * `.mole2`, `.suc-mole`, `.pf-avatar .mole`, `.mole-spot .mole`) keeps applying untouched and no call
 * site changed. `object-fit: contain` is what makes that safe: those rules set width AND height
 * independently, and an <img> would otherwise stretch where the SVG's viewBox used to preserve ratio.
 *
 * The drawn version carried its own shadow ellipse; the artwork has none, so the shadow moves to a CSS
 * filter (see `.mole` in burrow.css) and stays proportional at every size.
 */
export const MoleMascot = ({ className }: { className?: string }) => (
  // eslint-disable-next-line @next/next/no-img-element
  <img className={className ?? "mole"} src="/mole-logo.png" alt="" aria-hidden="true" />
);

export const NavBar = () => {
  const [isOpen, setIsOpen] = useState(false);
  const currentPath = usePathname();

  // THE CHROME OFFERS THE PRODUCT, AND THE PRODUCT IS THREE THINGS: the DEX
  // aggregator, LP pools, and the lending/borrowing market. Nothing else is linked
  // from here.
  //
  // UNLINKED, NOT DELETED (2026-08-23 product call). Quests, Profile, Leaderboard,
  // Queue — and earlier Vault, DCA and Limit — still have working routes and are
  // still reachable by URL; they are simply no longer offered from the navigation.
  // Deleting them is a separate decision and has not been taken, so nothing here
  // should be read as those features being gone.
  //
  // ONE THING THAT IS DELIBERATELY STILL LINKED: /vault, from the Pools page's
  // "+ Liquidity" button. That route is the LP product's deposit UI, not the
  // batch-auction vault, and it is the only way into providing liquidity.
  const LEFT = [
    { href: "/dapp", label: "Swap" },
    { href: "/pools", label: "Pools" },
  ];
  const ALL = [...LEFT];

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
        </nav>

        <div id="walletSlot">
          {/* Network first, then wallet: you pick where you are before you pick who you are. */}
          <ChainSwitcher />
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
          DEX aggregator, LP pools and lending on Robinhood Chain and Arc.
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
