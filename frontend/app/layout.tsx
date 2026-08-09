import type React from "react";
import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { ConditionalFooter } from "@/components/ConditionalFooter";
import { PushChainWalletProvider } from "@/lib/pushchain/provider";

// Analytics is opt-in via env so this deploy never reports to a foreign GA property.
const GA_ID = process.env.NEXT_PUBLIC_GA_ID;

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.moleswap.com";

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
  },
  openGraph: {
    title: "MoleSwap - Dex Aggregator & AMM Protocol",
    description: "DEX aggregator & AMM on Robinhood Chain. Swap tokens, earn XP, climb the leaderboard.",
    images: [
      {
        url: `${siteUrl}/mole-card.webp`,
        width: 1200,
        height: 630,
        alt: "MoleSwap - Dex Aggregator & AMM Protocol",
      },
    ],
    type: "website",
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
    title: "MoleSwap - Dex Aggregator & AMM Protocol",
    description: "DEX aggregator & AMM on Robinhood Chain. Swap tokens, earn XP, climb the leaderboard.",
    images: [`${siteUrl}/mole-card.webp`],
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
        <PushChainWalletProvider network="testnet">
          <div className="flex min-h-screen flex-col">
            <main className="flex-1">{children}</main>
            <ConditionalFooter />
          </div>
        </PushChainWalletProvider>
      </body>
    </html>
  );
}
