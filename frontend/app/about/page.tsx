import { BackgroundImage, NavBar, MoleMascot } from "@/screens/shared";

export default function AboutPage() {
  return (
    <>
      <BackgroundImage />
      <NavBar />

      <header className="hero">
        <span className="badge">
          <span className="dot" />
          DEX aggregator &amp; AMM · Robinhood Chain
        </span>
        <h1>About MoleSwap.</h1>
        <p className="sub">
          DEX aggregator &amp; AMM on Robinhood Chain — swap tokens, earn XP,
          climb the leaderboard.
        </p>
      </header>

      <section className="legal">
        <div className="p-card intro">
          <MoleMascot />
          <h2>The underground DEX built on Robinhood Chain</h2>
          <p className="tagline">
            Where seamless trading meets a vibrant SocialFi experience.
          </p>
        </div>

        <div className="p-card">
          <h3>What is MoleSwap?</h3>
          <p className="d">
            MoleSwap is a next-generation ecosystem designed for traders who
            demand efficiency, community, and a fresh take on decentralized
            finance. Every swap is a strategic move, every connection
            strengthens the network, and every interaction brings a new layer
            of value to the community.
          </p>
        </div>

        <div className="p-card">
          <h3>DEX aggregator &amp; AMM</h3>
          <p className="d">
            MoleSwap is a DEX aggregator and automated liquidity manager on
            Robinhood Chain. It routes every trade across all live venues and
            settles through an immutable executor that guarantees your minimum
            output on-chain. One swap, best price, on-chain guarantee.
          </p>
        </div>

        <div className="p-card">
          <h3>Community &amp; SocialFi</h3>
          <p className="d">
            Beyond trading, MoleSwap is built around its community. Members
            earn rewards, climb leaderboards, build on-chain reputation, and
            engage with fellow participants in a community-first ecosystem. The
            mission is to transform DeFi from a solitary experience into a
            social movement.
          </p>
        </div>

        <div className="p-card closing">
          <p className="d">
            Whether for seasoned traders or newcomers exploring decentralized
            finance for the first time, MoleSwap offers a tunnel into the
            future of trading. <b>Time to dig in.</b>
          </p>
        </div>
      </section>

      <style>{`
        .legal { max-width: 760px; margin: 4px auto 0; display: grid; gap: 14px; }
        .legal .p-card .d { font-size: 13.5px; color: var(--p-card-ink-2); line-height: 1.62; }
        .legal .p-card.closing { text-align: center; }
        .intro { text-align: center; padding: 32px 26px 28px; }
        .intro .mole { position: static; display: block; width: 112px; height: 112px; margin: 0 auto; }
        .intro h2 { margin: 14px 0 0; font-size: clamp(1.35rem, 3.6vw, 1.7rem); font-weight: 800; letter-spacing: -.024em; line-height: 1.15; }
        .intro .tagline { margin: 9px 0 0; font-size: 14px; color: var(--p-card-ink-2); }
      `}</style>
    </>
  );
}
