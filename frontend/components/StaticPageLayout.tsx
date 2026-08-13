"use client";
import { BackgroundImage, NavBar, MoleMascot } from "@/screens/shared";

export default function StaticPageLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Background */}
      <BackgroundImage />

      {/* Navbar */}
      <NavBar />

      {/* Hero */}
      <header className="hero">
        <span className="badge">
          <span className="dot" />
          MoleSwap
        </span>
        <h1>{title}</h1>
        <MoleMascot />
      </header>

      {/* Content */}
      <section className="static-col">
        <div className="p-card static-card">{children}</div>
      </section>

      <style>{`
        .static-col { max-width: 760px; margin: 4px auto 0; }
        .static-card { padding: 26px 24px; }
      `}</style>
    </>
  );
}
