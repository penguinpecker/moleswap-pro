import { BackgroundImage, NavBar, MoleMascot } from "@/screens/shared";

export default function PrivacyPage() {
  return (
    <>
      <BackgroundImage />
      <NavBar />

      <header className="hero">
        <span className="badge">
          <span className="dot" />
          Legal · MoleSwap
        </span>
        <h1>Privacy Policy.</h1>
        <p className="sub dateline">Last updated: 2/27/2026</p>
        <MoleMascot />
      </header>

      <section className="legal">
        <div className="p-card">
          <h3>1. Introduction</h3>
          <p className="d">
            MoleSwap (&ldquo;we,&rdquo; &ldquo;our,&rdquo; or &ldquo;us&rdquo;)
            respects your privacy. This Privacy Policy describes how we
            collect, use, and protect information when you use our
            decentralized exchange platform and related services.
          </p>
        </div>

        <div className="p-card">
          <h3>2. Information we collect</h3>
          <p className="d">
            We may collect: (a) wallet addresses and transaction data when you
            connect and use the Platform; (b) information you provide when
            linking social accounts (e.g., Twitter) or signing messages; (c)
            usage data such as IP address and device information; (d) cookies
            and similar technologies for session and preference management.
          </p>
        </div>

        <div className="p-card">
          <h3>3. How we use your information</h3>
          <p className="d">
            We use collected information to operate and improve the Platform,
            authenticate users, prevent fraud, comply with legal obligations,
            and communicate with you about the service. We do not sell your
            personal information to third parties.
          </p>
        </div>

        <div className="p-card">
          <h3>4. Blockchain &amp; decentralization</h3>
          <p className="d">
            Transactions you conduct on-chain are public and permanent. Wallet
            addresses and related on-chain activity may be visible to anyone.
            We do not control third-party blockchains or wallets.
          </p>
        </div>

        <div className="p-card">
          <h3>5. Data retention &amp; security</h3>
          <p className="d">
            We retain information only as long as necessary to provide the
            service and fulfill legal obligations. We implement reasonable
            technical and organizational measures to protect your data;
            however, no system is completely secure.
          </p>
        </div>

        <div className="p-card">
          <h3>6. Your rights &amp; contact</h3>
          <p className="d">
            Depending on your jurisdiction, you may have rights to access,
            correct, or delete your personal data. To exercise these rights or
            ask questions about this Privacy Policy, contact us through our
            official website or social channels.
          </p>
        </div>

        <div className="p-card closing">
          <p className="d">
            By using MoleSwap, you acknowledge that you have read and
            understood this Privacy Policy.
          </p>
        </div>
      </section>

      <style>{`
        .legal { max-width: 760px; margin: 4px auto 0; display: grid; gap: 14px; }
        .legal .p-card .d { font-size: 13.5px; color: var(--p-card-ink-2); line-height: 1.62; }
        .legal .p-card.closing { text-align: center; }
        .sub.dateline { margin-top: 12px; font-family: var(--font-num); font-size: 12.5px; letter-spacing: .02em; color: rgba(255,240,214,.62); }
      `}</style>
    </>
  );
}
