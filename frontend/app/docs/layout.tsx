import type React from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MoleSwap API Docs — Developer Documentation",
  description:
    "Complete API reference, SDK guide, and integration tutorials for MoleSwap DEX on Robinhood Chain. Build swaps, create pools, and launch tokens.",
  openGraph: {
    title: "MoleSwap API Docs",
    description: "Developer documentation for MoleSwap DEX on Robinhood Chain.",
    type: "website",
  },
};

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
