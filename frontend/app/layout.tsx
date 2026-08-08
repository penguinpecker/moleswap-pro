import type React from "react";
import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://moleswap-pro.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "MoleSwap Pro — DEX Aggregator on Robinhood Chain",
  description:
    "Swap any token at the best price on Robinhood Chain. MoleSwap Pro routes across every venue and settles through an immutable executor that guarantees your minimum output on-chain.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "MoleSwap Pro — DEX Aggregator on Robinhood Chain",
    description: "Swap any token at the best price on Robinhood Chain, with your minimum output guaranteed on-chain.",
    images: [{ url: "/android-chrome-512x512.png", width: 1200, height: 630, alt: "MoleSwap Pro" }],
    type: "website",
    url: siteUrl,
  },
  twitter: {
    card: "summary_large_image",
    title: "MoleSwap Pro — DEX Aggregator on Robinhood Chain",
    description: "Swap any token at the best price on Robinhood Chain, with your minimum output guaranteed on-chain.",
    images: ["/android-chrome-512x512.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
