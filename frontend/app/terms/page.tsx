import { BackgroundImage, NavBar, MoleMascot } from "@/screens/shared";

export default function TermsPage() {
  return (
    <>
      <BackgroundImage />
      <NavBar />

      <header className="hero">
        <span className="badge">
          <span className="dot" />
          Legal · MoleSwap
        </span>
        <h1>Terms of Use.</h1>
        <p className="sub dateline">Last updated: 2/27/2026</p>
        <MoleMascot />
      </header>

      <section className="legal">
        <div className="p-card">
          <h3>1. Acceptance of terms</h3>
          <p className="d">
            By accessing or using MoleSwap (&ldquo;the Platform&rdquo;), you
            agree to be bound by these Terms of Use. If you do not agree, do
            not use the Platform.
          </p>
        </div>

        <div className="p-card">
          <h3>2. Eligibility</h3>
          <p className="d">
            You must be of legal age in your jurisdiction and not prohibited
            from using decentralized finance or swap services. You are
            responsible for compliance with local laws.
          </p>
        </div>

        <div className="p-card">
          <h3>3. Use of the platform</h3>
          <p className="d">
            MoleSwap provides a decentralized exchange interface. You use the
            Platform at your own risk. We do not custody your funds; you retain
            control of your wallet and assets. Transactions are final and
            irreversible once confirmed on-chain.
          </p>
        </div>

        <div className="p-card">
          <h3>4. No financial advice</h3>
          <p className="d">
            Nothing on the Platform constitutes financial, legal, or tax
            advice. You are solely responsible for your trading and investment
            decisions.
          </p>
        </div>

        <div className="p-card">
          <h3>5. Disclaimer of warranties</h3>
          <p className="d">
            The Platform is provided &ldquo;as is&rdquo; without warranties of
            any kind. We do not guarantee uninterrupted access, accuracy of
            data, or fitness for a particular purpose.
          </p>
        </div>

        <div className="p-card">
          <h3>6. Limitation of liability</h3>
          <p className="d">
            To the fullest extent permitted by law, MoleSwap and its affiliates
            shall not be liable for any indirect, incidental, special, or
            consequential damages arising from your use of the Platform or any
            transactions conducted through it.
          </p>
        </div>

        <div className="p-card closing">
          <p className="d">
            For questions about these terms, contact us via our official
            channels. By continuing to use MoleSwap, you acknowledge that you
            have read and agree to these Terms of Use.
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
