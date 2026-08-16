import type React from "react";
import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { ConditionalFooter } from "@/components/ConditionalFooter";
import { WalletProvider } from "@/lib/chain/provider";

// Analytics is opt-in via env so this deploy never reports to a foreign GA property.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.moleswap.com";

// Without this, mobile browsers use a ~980px layout viewport and render the DESKTOP layout shrunk down
// (with horizontal overflow) — which is exactly why the dapp looked broken on phones. width=device-width
// makes every responsive breakpoint apply at the real device width.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#3E2410",
};

export const metadata: Metadata = {
  title: "MoleSwap - Dex Aggregator & AMM Protocol",
  description:
    "DEX aggregator & AMM on Robinhood Chain. Swap tokens, earn XP, climb the leaderboard.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
    // The square mark, for anything that wants a profile picture rather than a wide card.
    shortcut: "/mole-logo.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "MoleSwap - Dex Aggregator & AMM Protocol",
    description: "DEX aggregator & AMM on Robinhood Chain. Swap tokens, earn XP, climb the leaderboard.",
    siteName: "MoleSwap",
    images: [
      {
        // PNG, not the old .webp: X/Twitter has historically been unreliable at rendering webp cards,
        // and every other scraper handles PNG. Cache-busted because social platforms cache the
        // previous artwork against this URL for a long time.
        url: `${siteUrl}/mole-card.png?v=2`,
        width: 1200,
        height: 630,
        alt: "MoleSwap - DEX aggregator & AMM on Robinhood Chain",
      },
      {
        // The square mark, which is what Discord/Slack and profile-style embeds prefer.
        url: `${siteUrl}/android-chrome-512x512.png?v=2`,
        width: 512,
        height: 512,
        alt: "MoleSwap",
      },
    ],
    type: "website",
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
    title: "MoleSwap - Dex Aggregator & AMM Protocol",
    description: "DEX aggregator & AMM on Robinhood Chain. Swap tokens, earn XP, climb the leaderboard.",
    images: [`${siteUrl}/mole-card.png?v=2`],
    creator: "@moleswapcom",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {GA_ID && (
          <>
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
              strategy="afterInteractive"
            />
            <Script id="gtag-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('js', new Date());
                gtag('config', '${GA_ID}');
              `}
            </Script>
          </>
        )}
      </head>
      <body className="custom-scrollbar">
        <WalletProvider>
          <div className="flex min-h-screen flex-col">
            <main className="flex-1">{children}</main>
            <ConditionalFooter />
          </div>
        </WalletProvider>
      </body>
    </html>
  );
}
