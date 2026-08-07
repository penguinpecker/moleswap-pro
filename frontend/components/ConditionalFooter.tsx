"use client";

import { usePathname } from "next/navigation";
import { Footer } from "@/screens/shared";

const HIDE_FOOTER_PATHS = ["/waitlist", "/earn-xp", "/connect-twitter"];

export function ConditionalFooter() {
  const pathname = usePathname();

  if (HIDE_FOOTER_PATHS.includes(pathname)) {
    return null;
  }

  return <Footer />;
}
