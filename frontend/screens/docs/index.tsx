"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { MoleGlyph } from "@/screens/shared";

const BASE = typeof window !== "undefined" ? window.location.origin : "https://www.moleswap.com";

// ═══════════════════════════════════════════
// NAV STRUCTURE
// ═══════════════════════════════════════════
interface NavItem { id: string; label: string; icon?: string }
interface NavGroup { title: string; items: NavItem[] }

const NAV: NavGroup[] = [
  { title: "Getting Started", items: [
    { id: "introduction", label: "Introduction", icon: "📖" },
    { id: "quickstart", label: "Quick Start", icon: "⚡" },
    { id: "authentication", label: "Authentication", icon: "🔑" },
    { id: "concepts", label: "Core Concepts", icon: "💡" },
  ]},
  { title: "API Reference", items: [
    { id: "get-tokens", label: "GET /tokens", icon: "🪙" },
    { id: "get-pools", label: "GET /pools", icon: "🏊" },
    { id: "get-pool-detail", label: "GET /pool/:address", icon: "🔍" },
    { id: "get-quote", label: "GET /quote", icon: "💱" },
    { id: "post-swap", label: "POST /tx/swap", icon: "🔄" },
    { id: "post-create-pool", label: "POST /tx/create-pool", icon: "🏗️" },
    { id: "post-add-liquidity", label: "POST /tx/add-liquidity", icon: "💧" },
  ]},
  { title: "Guides", items: [
    { id: "token-launcher", label: "Token Launcher Guide", icon: "🚀" },
    { id: "sdk", label: "TypeScript SDK", icon: "📦" },
    { id: "contracts", label: "Contract Addresses", icon: "📜" },
  ]},
];

// ═══════════════════════════════════════════
// CODE TABS
// ═══════════════════════════════════════════
function CodeTabs({ tabs }: { tabs: { label: string; lang: string; code: string }[] }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  return (
    <div className="docs-code-block">
      <div className="docs-code-tabs">
        <div className="docs-code-tab-list">
          {tabs.map((t, i) => (
            <button key={t.label} onClick={() => setActive(i)}
              className={`docs-code-tab ${i === active ? "active" : ""}`}>{t.label}</button>
          ))}
        </div>
        <button className="docs-copy-btn" onClick={() => {
          navigator.clipboard.writeText(tabs[active].code);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}>{copied ? "Copied!" : "Copy"}</button>
      </div>
      <pre className="docs-pre"><code>{tabs[active].code}</code></pre>
    </div>
  );
}

// ═══════════════════════════════════════════
// API PLAYGROUND
// ═══════════════════════════════════════════
function Playground({ method, path, defaultParams, defaultBody }: {
  method: "GET" | "POST"; path: string;
  defaultParams?: Record<string, string>;
  defaultBody?: Record<string, any>;
}) {
  const [result, setResult] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<number | null>(null);
  const [params, setParams] = useState(defaultParams || {});
  const [body, setBody] = useState(defaultBody ? JSON.stringify(defaultBody, null, 2) : "");

  async function run() {
    setLoading(true);
    setResult("");
    setStatus(null);
    try {
      let url = `${BASE}${path}`;
      if (method === "GET" && Object.keys(params).length) {
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
        url += `?${qs.toString()}`;
      }
      const res = await fetch(url, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" && body ? body : undefined,
      });
      setStatus(res.status);
      const json = await res.json();
      setResult(JSON.stringify(json, null, 2));
    } catch (err: any) {
      setResult(`Error: ${err.message}`);
    } finally { setLoading(false); }
  }

  return (
    <div className="docs-playground">
      <div className="docs-playground-header">
        <span className="docs-playground-title">API Playground</span>
        <span className="docs-playground-badge">{method === "GET" ? "🟢" : "🟠"} Live</span>
      </div>
      {method === "GET" && defaultParams && (
        <div className="docs-playground-params">
          {Object.entries(defaultParams).map(([k, v]) => (
            <div key={k} className="docs-playground-param">
              <label>{k}</label>
              <input type="text" value={params[k] || ""} placeholder={v}
                onChange={e => setParams(p => ({ ...p, [k]: e.target.value }))} />
            </div>
          ))}
        </div>
      )}
      {method === "POST" && (
        <div className="docs-playground-body">
          <label>Request Body</label>
          <textarea value={body} onChange={e => setBody(e.target.value)} rows={8} spellCheck={false} />
        </div>
      )}
      <button className="docs-playground-run" onClick={run} disabled={loading}>
        {loading ? "Running..." : "Send Request →"}
      </button>
      {result && (
        <div className="docs-playground-result">
          {status && <div className={`docs-status ${status < 300 ? "ok" : "err"}`}>{status} {status < 300 ? "OK" : "Error"}</div>}
          <pre><code>{result}</code></pre>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
// PARAM TABLE
// ═══════════════════════════════════════════
function ParamTable({ params }: { params: { name: string; type: string; required: boolean; desc: string }[] }) {
  return (
    <div className="docs-param-table">
      <table>
        <thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>
          {params.map(p => (
            <tr key={p.name}>
              <td><code>{p.name}</code></td>
              <td><span className="docs-type">{p.type}</span></td>
              <td>{p.required ? <span className="docs-req">Required</span> : <span className="docs-opt">Optional</span>}</td>
              <td>{p.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MethodBadge({ method }: { method: "GET" | "POST" }) {
  return <span className={`docs-method ${method.toLowerCase()}`}>{method}</span>;
}

function EndpointHeader({ method, path }: { method: "GET" | "POST"; path: string }) {
  return (
    <div className="docs-endpoint-header">
      <MethodBadge method={method} />
      <code className="docs-endpoint-path">{path}</code>
    </div>
  );
}

function InfoCard({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="docs-info-card">
      <div className="docs-info-icon">{icon}</div>
      <div><div className="docs-info-title">{title}</div><div className="docs-info-body">{children}</div></div>
    </div>
  );
}

function StepList({ steps }: { steps: { title: string; desc: string }[] }) {
  return (
    <div className="docs-steps">
      {steps.map((s, i) => (
        <div key={i} className="docs-step">
          <div className="docs-step-num">{i + 1}</div>
          <div><div className="docs-step-title">{s.title}</div><div className="docs-step-desc">{s.desc}</div></div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════
// MAIN DOCS PAGE
// ═══════════════════════════════════════════
export default function ApiDocsPage() {
  const [activeSection, setActiveSection] = useState("introduction");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Scroll spy
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          setActiveSection(entry.target.id);
          break;
        }
      }
    }, { rootMargin: "-80px 0px -60% 0px", threshold: 0.1 });

    const sections = document.querySelectorAll("[data-section]");
    sections.forEach(s => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  // Keyboard shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setSearchOpen(true); }
      if (e.key === "Escape") setSearchOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scrollTo = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); setMobileNavOpen(false); }
  }, []);

  const allItems = NAV.flatMap(g => g.items);
  const filtered = searchQuery
    ? allItems.filter(i => i.label.toLowerCase().includes(searchQuery.toLowerCase()) || i.id.includes(searchQuery.toLowerCase()))
    : [];

  return (
    <div className="docs-root">
      {/* ═══ SEARCH MODAL ═══ */}
      {searchOpen && (
        <div className="docs-search-overlay" onClick={() => setSearchOpen(false)}>
          <div className="docs-search-modal" onClick={e => e.stopPropagation()}>
            <input autoFocus placeholder="Search documentation..." value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)} className="docs-search-input" />
            {filtered.length > 0 && (
              <div className="docs-search-results">
                {filtered.map(item => (
                  <button key={item.id} className="docs-search-result"
                    onClick={() => { scrollTo(item.id); setSearchOpen(false); setSearchQuery(""); }}>
                    <span>{item.icon}</span><span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
            {searchQuery && filtered.length === 0 && (
              <div className="docs-search-empty">No results found</div>
            )}
          </div>
        </div>
      )}

      {/* ═══ TOP BAR ═══ */}
      <header className="docs-topbar">
        <div className="docs-topbar-inner">
          <div className="docs-topbar-left">
            <button className="docs-mobile-toggle" onClick={() => setMobileNavOpen(!mobileNavOpen)}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M2 4.75A.75.75 0 012.75 4h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 4.75zm0 5A.75.75 0 012.75 9h14.5a.75.75 0 010 1.5H2.75A.75.75 0 012 9.75zm0 5a.75.75 0 01.75-.75h14.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z" clipRule="evenodd"/></svg>
            </button>
            <a href="/" className="docs-logo">
              <span className="docs-glyph" aria-hidden="true">
                <MoleGlyph size={16} />
              </span>
              <span className="docs-logo-text">MoleSwap</span>
              <span className="docs-logo-badge">Docs</span>
            </a>
          </div>
          <button className="docs-search-trigger" onClick={() => setSearchOpen(true)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" opacity={0.4}><path fillRule="evenodd" d="M9.965 11.026a5 5 0 111.06-1.06l2.755 2.754a.75.75 0 11-1.06 1.06l-2.755-2.754zM10.5 7a3.5 3.5 0 11-7 0 3.5 3.5 0 017 0z" clipRule="evenodd"/></svg>
            <span>Search docs...</span>
            <kbd>⌘K</kbd>
          </button>
          <div className="docs-topbar-right">
            <a href="https://github.com/penguinpecker/moleswap" target="_blank" rel="noopener noreferrer" className="docs-github-link">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
            </a>
          </div>
        </div>
      </header>

      <div className="docs-layout">
        {/* ═══ SIDEBAR ═══ */}
        <aside className={`docs-sidebar ${mobileNavOpen ? "open" : ""}`}>
          <nav className="docs-nav">
            {NAV.map(group => (
              <div key={group.title} className="docs-nav-group">
                <div className="docs-nav-group-title">{group.title}</div>
                {group.items.map(item => (
                  <button key={item.id} onClick={() => scrollTo(item.id)}
                    className={`docs-nav-item ${activeSection === item.id ? "active" : ""}`}>
                    <span className="docs-nav-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* ═══ CONTENT ═══ */}
        <div className="docs-content" ref={contentRef}>

          {/* ── INTRODUCTION ── */}
          <section id="introduction" data-section>
            <div className="docs-hero">
              <h1>MoleSwap API Documentation</h1>
              <p className="docs-hero-sub">
                Integrate with MoleSwap DEX on Robinhood Chain. Get swap quotes, build transactions,
                create pools, and add liquidity — all through a simple REST API.
              </p>
              <div className="docs-hero-pills">
                <span className="docs-pill">Base URL: <code>{BASE}/api/v1</code></span>
                <span className="docs-pill">Chain ID: <code>4663</code></span>
                <span className="docs-pill">Robinhood Chain</span>
              </div>
            </div>

            <div className="docs-cards-grid">
              <div className="docs-card" onClick={() => scrollTo("quickstart")}>
                <div className="docs-card-icon">⚡</div>
                <div className="docs-card-title">Quick Start</div>
                <div className="docs-card-desc">Get your first swap quote in 30 seconds</div>
              </div>
              <div className="docs-card" onClick={() => scrollTo("get-quote")}>
                <div className="docs-card-icon">💱</div>
                <div className="docs-card-title">Swap Quotes</div>
                <div className="docs-card-desc">Real-time pricing with auto multi-hop routing</div>
              </div>
              <div className="docs-card" onClick={() => scrollTo("token-launcher")}>
                <div className="docs-card-icon">🚀</div>
                <div className="docs-card-title">Launch a Token</div>
                <div className="docs-card-desc">Create a pool and go live in 5 steps</div>
              </div>
              <div className="docs-card" onClick={() => scrollTo("sdk")}>
                <div className="docs-card-icon">📦</div>
                <div className="docs-card-title">SDK Reference</div>
                <div className="docs-card-desc">TypeScript SDK for cleaner integration</div>
              </div>
            </div>
          </section>

          {/* ── QUICK START ── */}
          <section id="quickstart" data-section>
            <h2>Quick Start</h2>
            <p>Get a swap quote from the MoleSwap API in under 30 seconds. No API key needed.</p>

            <h3>1. Get a Swap Quote</h3>
            <p>Fetch a real-time quote for swapping 1 ETH (Robinhood Chain native token) to USDG:</p>
            <CodeTabs tabs={[
              { label: "cURL", lang: "bash", code: `curl "${BASE}/api/v1/quote?tokenIn=0x0000000000000000000000000000000000000000&tokenOut=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&amountIn=1000000000000000000"` },
              { label: "JavaScript", lang: "js", code: `const res = await fetch(
  "${BASE}/api/v1/quote?" + new URLSearchParams({
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    amountIn: "1000000000000000000"  // 1 ETH in wei
  })
);
const { data } = await res.json();
console.log(\`1 ETH = \${data.amountOutFormatted} USDG\`);
console.log(\`Route: \${data.route}\`);` },
              { label: "Python", lang: "python", code: `import requests

resp = requests.get(f"${BASE}/api/v1/quote", params={
    "tokenIn": "0x0000000000000000000000000000000000000000",
    "tokenOut": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "amountIn": "1000000000000000000"  # 1 ETH in wei
})
data = resp.json()["data"]
print(f"1 ETH = {data['amountOutFormatted']} USDG")
print(f"Route: {data['route']}")` },
            ]} />

            <h3>2. Build a Swap Transaction</h3>
            <p>Get unsigned calldata to execute the swap. Your backend signs and submits — we never touch private keys.</p>
            <CodeTabs tabs={[
              { label: "cURL", lang: "bash", code: `curl -X POST "${BASE}/api/v1/tx/swap" \\
  -H "Content-Type: application/json" \\
  -d '{
    "tokenIn": "0x0000000000000000000000000000000000000000",
    "tokenOut": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "amountIn": "1000000000000000000",
    "recipient": "0xYOUR_WALLET_ADDRESS",
    "slippageBps": 50
  }'` },
              { label: "JavaScript", lang: "js", code: `const res = await fetch("${BASE}/api/v1/tx/swap", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tokenIn: "0x0000000000000000000000000000000000000000",
    tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    amountIn: "1000000000000000000",
    recipient: "0xYOUR_WALLET_ADDRESS",
    slippageBps: 50
  })
});
const { data } = await res.json();

// Sign & send each transaction sequentially
for (const tx of data.transactions) {
  console.log(tx.description);
  const txHash = await signer.sendTransaction({
    to: tx.to,
    value: tx.value,
    data: tx.data,
  });
  await txHash.wait(); // Wait for confirmation
}` },
              { label: "Python", lang: "python", code: `import requests
from web3 import Web3

resp = requests.post(f"${BASE}/api/v1/tx/swap", json={
    "tokenIn": "0x0000000000000000000000000000000000000000",
    "tokenOut": "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    "amountIn": "1000000000000000000",
    "recipient": "0xYOUR_WALLET_ADDRESS",
    "slippageBps": 50
})
data = resp.json()["data"]

w3 = Web3(Web3.HTTPProvider("https://rpc.mainnet.chain.robinhood.com/"))
for tx in data["transactions"]:
    print(tx["description"])
    signed = w3.eth.account.sign_transaction({
        "to": tx["to"],
        "value": int(tx["value"]),
        "data": tx["data"],
        "gas": 300000,
        "chainId": 4663,
    }, private_key="YOUR_KEY")
    w3.eth.send_raw_transaction(signed.rawTransaction)` },
            ]} />
          </section>

          {/* ── AUTHENTICATION ── */}
          <section id="authentication" data-section>
            <h2>Authentication</h2>
            <p>The MoleSwap API is <strong>public</strong> — no API key required. All endpoints are rate-limited per IP address.</p>

            <div className="docs-rate-limit-grid">
              <div className="docs-rl-card">
                <div className="docs-rl-label">Read endpoints (GET)</div>
                <div className="docs-rl-value">60 requests / minute</div>
              </div>
              <div className="docs-rl-card">
                <div className="docs-rl-label">Write endpoints (POST)</div>
                <div className="docs-rl-value">20 requests / minute</div>
              </div>
            </div>

            <p>Rate limit info is included in response headers:</p>
            <CodeTabs tabs={[{ label: "Response Headers", lang: "http", code: `X-RateLimit-Remaining: 57
X-RateLimit-Reset: 1711234627` }]} />

            <InfoCard icon="💡" title="No private keys needed">
              The <code>POST /tx/*</code> endpoints return <strong>unsigned transaction calldata</strong>. Your backend
              signs and submits the transactions with your own wallet. MoleSwap never handles private keys.
            </InfoCard>
          </section>

          {/* ── CORE CONCEPTS ── */}
          <section id="concepts" data-section>
            <h2>Core Concepts</h2>

            <h3>Token Addresses</h3>
            <p>All tokens on Robinhood Chain are ERC-20 (ERC-20 equivalent). Use the zero address <code>0x000...000</code> for
              native ETH. The API automatically handles wrapping ETH → WETH when needed.</p>

            <h3>WETH (Wrapped Robinhood Chain)</h3>
            <p>WETH is the wrapped version of native ETH on Robinhood Chain. All AMM pools are paired
              against WETH. When you swap from native PC, the API automatically includes a wrap step.</p>

            <h3>Fee Tiers</h3>
            <p>Pools use Uniswap V3-style concentrated liquidity with these fee tiers:</p>
            <div className="docs-fee-grid">
              {[
                { fee: 100, label: "0.01%", spacing: 1, use: "Stablecoin pairs" },
                { fee: 500, label: "0.05%", spacing: 10, use: "Most common — used by majority of pools" },
                { fee: 3000, label: "0.3%", spacing: 60, use: "Volatile pairs" },
                { fee: 10000, label: "1%", spacing: 200, use: "Exotic / low-liquidity pairs" },
              ].map(f => (
                <div key={f.fee} className="docs-fee-item">
                  <code>{f.fee}</code>
                  <span className="docs-fee-pct">{f.label}</span>
                  <span className="docs-fee-use">{f.use}</span>
                </div>
              ))}
            </div>

            <h3>Multi-Hop Routing</h3>
            <InfoCard icon="🔄" title="Automatic route discovery">
              When no direct pool exists for a token pair, the API automatically routes through WETH as an intermediary.
              For example, a token→token swap routes as <code>TOKEN → WETH → TOKEN</code>. This is our custom
              routing logic — not provided by Robinhood Chain out of the box. Any new token paired with WETH is instantly
              swappable against all other tokens in the ecosystem.
            </InfoCard>

            <h3>Response Format</h3>
            <p>All responses follow this structure:</p>
            <CodeTabs tabs={[
              { label: "Success", lang: "json", code: `{
  "success": true,
  "data": { ... },
  "timestamp": 1711234567890
}` },
              { label: "Error", lang: "json", code: `{
  "success": false,
  "error": "Invalid tokenIn address",
  "timestamp": 1711234567890
}` },
            ]} />
          </section>

          {/* ══════════════════════════════
              API REFERENCE
             ══════════════════════════════ */}

          {/* ── GET /tokens ── */}
          <section id="get-tokens" data-section>
            <h2>List Tokens</h2>
            <EndpointHeader method="GET" path="/api/v1/tokens" />
            <p>Returns all supported ERC-20 tokens on Robinhood Chain, along with the core AMM contract addresses.</p>

            <h3>Query Parameters</h3>
            <ParamTable params={[
              { name: "active", type: "boolean", required: false, desc: "Only return tokens that have at least one live pool" },
              { name: "search", type: "string", required: false, desc: "Search by symbol, name, or contract address" },
            ]} />

            <h3>Examples</h3>
            <CodeTabs tabs={[
              { label: "cURL", lang: "bash", code: `# All tokens
curl "${BASE}/api/v1/tokens"

# Only tokens with a live pool
curl "${BASE}/api/v1/tokens?active=true"

# Search by symbol
curl "${BASE}/api/v1/tokens?search=USDC"` },
              { label: "JavaScript", lang: "js", code: `const res = await fetch("${BASE}/api/v1/tokens?active=true");
const { data } = await res.json();
console.log(data.tokens);       // Token list
console.log(data.contracts);    // Core contract addresses` },
            ]} />

            <h3>Try it</h3>
            <Playground method="GET" path="/api/v1/tokens" defaultParams={{ chain: "", search: "" }} />
          </section>

          {/* ── GET /pools ── */}
          <section id="get-pools" data-section>
            <h2>List Pools</h2>
            <EndpointHeader method="GET" path="/api/v1/pools" />
            <p>Returns all live AMM pools with real-time on-chain data: current price, liquidity, tick, and fee tier.</p>

            <h3>Query Parameters</h3>
            <ParamTable params={[
              { name: "includeEmpty", type: "boolean", required: false, desc: "Include pools with zero liquidity. Default: false" },
            ]} />

            <h3>Examples</h3>
            <CodeTabs tabs={[
              { label: "cURL", lang: "bash", code: `curl "${BASE}/api/v1/pools"` },
              { label: "JavaScript", lang: "js", code: `const { data } = await fetch("${BASE}/api/v1/pools").then(r => r.json());
console.log(\`\${data.count} pools with liquidity\`);
data.pools.forEach(p => console.log(\`\${p.name}: price \${p.price.toFixed(4)}\`));` },
            ]} />

            <h3>Try it</h3>
            <Playground method="GET" path="/api/v1/pools" defaultParams={{ includeEmpty: "" }} />
          </section>

          {/* ── GET /pool/:address ── */}
          <section id="get-pool-detail" data-section>
            <h2>Pool Detail</h2>
            <EndpointHeader method="GET" path="/api/v1/pool/:address" />
            <p>Get detailed data for a single pool, including token balances held by the pool contract.</p>

            <h3>Path Parameters</h3>
            <ParamTable params={[
              { name: "address", type: "address", required: true, desc: "Pool contract address" },
            ]} />

            <h3>Examples</h3>
            <CodeTabs tabs={[
              { label: "cURL", lang: "bash", code: `# WETH/USDG pool
curl "${BASE}/api/v1/pool/0x012d5C099f8AE00009f40824317a18c3A342f622"` },
              { label: "JavaScript", lang: "js", code: `const { data } = await fetch(
  "${BASE}/api/v1/pool/0x012d5C099f8AE00009f40824317a18c3A342f622"
).then(r => r.json());
console.log(\`\${data.name} — Price: \${data.price.toFixed(2)}\`);
console.log(\`Liquidity: \${data.liquidity}\`);
console.log(\`Explorer: \${data.explorer}\`);` },
            ]} />

            <h3>Try it</h3>
            <Playground method="GET" path="/api/v1/pool/0x012d5C099f8AE00009f40824317a18c3A342f622" />
          </section>

          {/* ── GET /quote ── */}
          <section id="get-quote" data-section>
            <h2>Swap Quote</h2>
            <EndpointHeader method="GET" path="/api/v1/quote" />
            <p>Get a real-time swap quote from the on-chain QuoterV2 contract. Supports direct pool swaps and
              automatic multi-hop routing through WETH for pairs without a direct pool.</p>

            <h3>Query Parameters</h3>
            <ParamTable params={[
              { name: "tokenIn", type: "address", required: true, desc: "Input token address. Use 0x000...000 for native PC." },
              { name: "tokenOut", type: "address", required: true, desc: "Output token address" },
              { name: "amountIn", type: "string", required: true, desc: "Input amount in WEI (raw BigInt string)" },
              { name: "fee", type: "number", required: false, desc: "Fee tier override: 100, 500, 3000, or 10000" },
            ]} />

            <InfoCard icon="🧠" title="Amounts are in WEI">
              All amounts use raw WEI format (no decimals). For a token with 18 decimals, 1 token = <code>1000000000000000000</code> (1e18).
              For 6-decimal tokens like USDC, 1 USDC = <code>1000000</code> (1e6).
            </InfoCard>

            <h3>Examples</h3>
            <CodeTabs tabs={[
              { label: "cURL", lang: "bash", code: `# Direct swap: 1 ETH → USDG
curl "${BASE}/api/v1/quote?tokenIn=0x0000000000000000000000000000000000000000&tokenOut=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&amountIn=1000000000000000000"

# Any token with liquidity is routable (via WETH automatically)
curl "${BASE}/api/v1/quote?tokenIn=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&tokenOut=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168&amountIn=100000000000000000"` },
              { label: "JavaScript", lang: "js", code: `const quote = await fetch("${BASE}/api/v1/quote?" + new URLSearchParams({
  tokenIn: "0x0000000000000000000000000000000000000000",
  tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  amountIn: "1000000000000000000"
})).then(r => r.json());

if (quote.data.type === "multi_hop") {
  console.log("Multi-hop route:", quote.data.route);
  console.log("Hops:", quote.data.hops);
} else {
  console.log("Direct swap via pool:", quote.data.pool);
}` },
            ]} />

            <h3>Try it</h3>
            <Playground method="GET" path="/api/v1/quote" defaultParams={{
              tokenIn: "0x0000000000000000000000000000000000000000",
              tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
              amountIn: "1000000000000000000",
            }} />
          </section>

          {/* ── POST /tx/swap ── */}
          <section id="post-swap" data-section>
            <h2>Build Swap TX</h2>
            <EndpointHeader method="POST" path="/api/v1/tx/swap" />
            <p>Returns unsigned transaction calldata for executing a swap. Includes wrap, approve, and swap steps
              as needed. Your backend signs and submits each transaction sequentially.</p>

            <h3>Request Body</h3>
            <ParamTable params={[
              { name: "tokenIn", type: "address", required: true, desc: "Input token address" },
              { name: "tokenOut", type: "address", required: true, desc: "Output token address" },
              { name: "amountIn", type: "string", required: true, desc: "Amount in WEI" },
              { name: "recipient", type: "address", required: true, desc: "Address to receive output tokens" },
              { name: "amountOutMin", type: "string", required: false, desc: "Minimum output amount. Auto-calculated from slippageBps if omitted." },
              { name: "slippageBps", type: "number", required: false, desc: "Slippage tolerance in basis points. Default: 50 (0.5%)" },
              { name: "fee", type: "number", required: false, desc: "Fee tier override" },
              { name: "deadline", type: "number", required: false, desc: "Unix timestamp deadline. Default: +30 minutes" },
            ]} />

            <InfoCard icon="⚠️" title="Sequential execution required">
              The <code>transactions</code> array must be executed in order. Wait for each transaction to confirm
              on-chain before sending the next one. Sending them simultaneously will cause failures.
            </InfoCard>

            <h3>Try it</h3>
            <Playground method="POST" path="/api/v1/tx/swap" defaultBody={{
              tokenIn: "0x0000000000000000000000000000000000000000",
              tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
              amountIn: "1000000000000000000",
              recipient: "0x0000000000000000000000000000000000000001",
              slippageBps: 50,
            }} />
          </section>

          {/* ── POST /tx/create-pool ── */}
          <section id="post-create-pool" data-section>
            <h2>Create Pool</h2>
            <EndpointHeader method="POST" path="/api/v1/tx/create-pool" />
            <p>Build calldata to create a new pool on the Uniswap V3 Factory, initialize it with a starting price,
              and optionally seed initial liquidity — all in one API call.</p>

            <h3>Request Body</h3>
            <ParamTable params={[
              { name: "tokenA", type: "address", required: true, desc: "First token address" },
              { name: "tokenB", type: "address", required: true, desc: "Second token address (typically WETH)" },
              { name: "recipient", type: "address", required: true, desc: "Address to receive the LP position NFT" },
              { name: "fee", type: "number", required: false, desc: "Fee tier: 100, 500, 3000, 10000. Default: 500" },
              { name: "initialPrice", type: "number", required: false, desc: "Starting price of token0 in terms of token1" },
              { name: "amount0Desired", type: "string", required: false, desc: "Initial liquidity for token0 (wei)" },
              { name: "amount1Desired", type: "string", required: false, desc: "Initial liquidity for token1 (wei)" },
              { name: "tickLower", type: "number", required: false, desc: "Lower tick bound. Default: full range" },
              { name: "tickUpper", type: "number", required: false, desc: "Upper tick bound. Default: full range" },
              { name: "slippageBps", type: "number", required: false, desc: "Slippage tolerance. Default: 100 (1%)" },
            ]} />

            <InfoCard icon="💡" title="Pool already exists?">
              If the pool already exists, the API skips the createPool and initialize steps and returns only the
              liquidity provision transactions. The response <code>type</code> field will be <code>add_liquidity_existing</code> instead
              of <code>create_pool</code>.
            </InfoCard>

            <h3>Try it</h3>
            <Playground method="POST" path="/api/v1/tx/create-pool" defaultBody={{
              tokenA: "0x5861f56A556c990358cc9cccd8B5baa3767982A8",
              tokenB: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9",
              fee: 500,
              initialPrice: 0.001,
              amount0Desired: "1000000000000000000000",
              amount1Desired: "1000000000000000000",
              recipient: "0x0000000000000000000000000000000000000001",
            }} />
          </section>

          {/* ── POST /tx/add-liquidity ── */}
          <section id="post-add-liquidity" data-section>
            <h2>Add Liquidity</h2>
            <EndpointHeader method="POST" path="/api/v1/tx/add-liquidity" />
            <p>Build calldata to add liquidity to an existing pool via the NonfungiblePositionManager.
              Returns wrap, approve, and mint steps.</p>

            <h3>Request Body</h3>
            <ParamTable params={[
              { name: "token0", type: "address", required: true, desc: "First token address" },
              { name: "token1", type: "address", required: true, desc: "Second token address" },
              { name: "amount0Desired", type: "string", required: true, desc: "Amount of token0 in WEI" },
              { name: "amount1Desired", type: "string", required: true, desc: "Amount of token1 in WEI" },
              { name: "recipient", type: "address", required: true, desc: "Address to receive the LP position NFT" },
              { name: "fee", type: "number", required: false, desc: "Fee tier. Default: 500" },
              { name: "tickLower", type: "number", required: false, desc: "Lower tick. Default: full range" },
              { name: "tickUpper", type: "number", required: false, desc: "Upper tick. Default: full range" },
              { name: "slippageBps", type: "number", required: false, desc: "Slippage. Default: 50 (0.5%)" },
            ]} />

            <h3>Try it</h3>
            <Playground method="POST" path="/api/v1/tx/add-liquidity" defaultBody={{
              token0: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
              token1: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9",
              amount0Desired: "500000000000000000",
              amount1Desired: "1000000000000000000",
              recipient: "0x0000000000000000000000000000000000000001",
              fee: 500,
            }} />
          </section>

          {/* ══════════════════════════════
              GUIDES
             ══════════════════════════════ */}

          {/* ── TOKEN LAUNCHER ── */}
          <section id="token-launcher" data-section>
            <h2>Token Launcher Guide</h2>
            <p>Launch your token on MoleSwap and make it instantly swappable against all 19 tokens in the ecosystem.</p>

            <StepList steps={[
              { title: "Deploy your ERC-20 token", desc: "Deploy a standard ERC-20 token contract on Robinhood Chain (RPC: https://rpc.mainnet.chain.robinhood.com/, Chain ID: 4663)." },
              { title: "Call POST /api/v1/tx/create-pool", desc: "Pair your token with WETH. Set an initial price and seed amounts. The API returns all unsigned calldata needed." },
              { title: "Sign & send the transactions", desc: "Execute sequentially: createPool → initialize → wrap (if needed) → approve × 2 → mint. Wait for each to confirm on-chain." },
              { title: "Your token is now swappable!", desc: "Users can swap via the MoleSwap UI or directly through the API. Use GET /api/v1/quote for price feeds." },
              { title: "Integrate swaps in your app", desc: "Use POST /api/v1/tx/swap to build swap calldata for your users. Your frontend signs it. Our multi-hop router automatically enables swaps between your token and every other token." },
            ]} />

            <InfoCard icon="🌐" title="Instant ecosystem access">
              By creating just <strong>one pool</strong> against WETH, your token becomes swappable against all other
              tokens in the MoleSwap ecosystem through our automatic multi-hop routing. You don&apos;t need to create
              pools against every individual token.
            </InfoCard>

            <h3>Example: Full token launch flow</h3>
            <CodeTabs tabs={[
              { label: "JavaScript", lang: "js", code: `import { ethers } from "ethers";

const MOLESWAP_API = "${BASE}/api/v1";
const YOUR_TOKEN = "0xYOUR_DEPLOYED_TOKEN_ADDRESS";
const WETH = "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9";

// 1. Build create-pool transaction
const res = await fetch(\`\${MOLESWAP_API}/tx/create-pool\`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    tokenA: YOUR_TOKEN,
    tokenB: WETH,
    fee: 500,                               // 0.05% fee tier
    initialPrice: 0.001,                    // 1 token = 0.001 WETH
    amount0Desired: "1000000000000000000000", // 1000 tokens
    amount1Desired: "1000000000000000000",    // 1 WETH
    recipient: wallet.address,
  })
});
const { data } = await res.json();
console.log(data.description); // "Create new pool and seed liquidity"

// 2. Execute each transaction sequentially
const provider = new ethers.JsonRpcProvider("https://rpc.mainnet.chain.robinhood.com/");
const signer = new ethers.Wallet("YOUR_PRIVATE_KEY", provider);

for (const tx of data.transactions) {
  console.log("→", tx.description);
  const sent = await signer.sendTransaction({
    to: tx.to,
    value: tx.value,
    data: tx.data,
  });
  await sent.wait();
  console.log("  ✅ Confirmed:", sent.hash);
}

// 3. Verify — your token is now quotable!
const quoteRes = await fetch(
  \`\${MOLESWAP_API}/quote?tokenIn=\${YOUR_TOKEN}&tokenOut=\${WETH}&amountIn=1000000000000000000\`
);
const quote = await quoteRes.json();
console.log("Quote:", quote.data);` },
            ]} />
          </section>

          {/* ── SDK ── */}
          <section id="sdk" data-section>
            <h2>TypeScript SDK</h2>
            <p>The MoleSwap SDK wraps all API calls with full TypeScript types for a cleaner integration experience.</p>

            <h3>Installation</h3>
            <CodeTabs tabs={[
              { label: "npm", lang: "bash", code: `npm install @moleswap/sdk` },
              { label: "yarn", lang: "bash", code: `yarn add @moleswap/sdk` },
              { label: "pnpm", lang: "bash", code: `pnpm add @moleswap/sdk` },
            ]} />

            <h3>Usage</h3>
            <CodeTabs tabs={[
              { label: "TypeScript", lang: "ts", code: `import { MoleSwap } from "@moleswap/sdk";

// Initialize (defaults to production URL)
const mole = new MoleSwap();

// Or with custom URL
const mole = new MoleSwap("https://your-deployment.vercel.app");

// ═══ READ DATA ═══

const { tokens } = await mole.getTokens();
const { pools } = await mole.getPools();
const pool = await mole.getPool("0x012d5C...");

// ═══ GET QUOTES ═══

const quote = await mole.getQuote({
  tokenIn: "0x0000000000000000000000000000000000000000",
  tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  amountIn: "1000000000000000000",
});
// quote.type = "direct" | "multi_hop" | "wrap_unwrap"

// ═══ BUILD TRANSACTIONS ═══

const swap = await mole.buildSwapTx({
  tokenIn: "0x000...000",
  tokenOut: "0x297...809",
  amountIn: "1000000000000000000",
  recipient: "0xYOUR_WALLET",
});
// swap.transactions = [{ to, value, data, description }]

const pool = await mole.buildCreatePoolTx({
  tokenA: "0xYOUR_TOKEN",
  tokenB: "0xE17DD2...DE9",  // WETH
  fee: 500,
  initialPrice: 0.001,
  amount0Desired: "1000000000000000000000",
  amount1Desired: "1000000000000000000",
  recipient: "0xYOUR_WALLET",
});

// ═══ HELPERS ═══

mole.getExplorerUrl("0xTX_HASH");
// → "https://robinhoodchain.blockscout.com/tx/0xTX_HASH"` },
            ]} />

            <InfoCard icon="📝" title="SDK availability">
              The TypeScript SDK will be published to npm as <code>@moleswap/sdk</code>. Until then,
              the REST endpoints above are the stable integration surface — they need no API key and
              return the same routes the app uses.
            </InfoCard>
          </section>

          {/* ── CONTRACTS ── */}
          <section id="contracts" data-section>
            <h2>Contract Addresses</h2>
            <p>All contracts are deployed on Robinhood Chain (Chain ID: 4663).</p>

            <div className="docs-contracts-table">
              <table>
                <thead><tr><th>Contract</th><th>Address</th><th>Description</th></tr></thead>
                <tbody>
                  {[
                    ["Factory", "0x81b8Bca02580C7d6b636051FDb7baAC436bFb454", "Creates new pools, stores pool registry"],
                    ["SwapRouter", "0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037", "Executes swaps (exactInputSingle, exactOutputSingle)"],
                    ["QuoterV2", "0x83316275f7C2F79BC4E26f089333e88E89093037", "Off-chain swap quotes (no gas cost)"],
                    ["PositionManager", "0xf9b3ac66aed14A2C7D9AA7696841aB6B27a6231e", "Manages liquidity positions (mint, collect, burn)"],
                    ["WETH", "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9", "Wrapped Robinhood Chain (WETH9 equivalent)"],
                    ["TickLens", "0xb64113Fc16055AfE606f25658812EE245Aa41dDC", "Read tick data for pools"],
                    ["Multicall", "0xa8c00017955c8654bfFbb6d5179c99f5aB8B7849", "Batch multiple calls in one transaction"],
                  ].map(([name, addr, desc]) => (
                    <tr key={name}>
                      <td><strong>{name}</strong></td>
                      <td><a href={`https://robinhoodchain.blockscout.com/address/${addr}`} target="_blank" rel="noopener noreferrer"><code>{addr}</code></a></td>
                      <td>{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Network Details</h3>
            <CodeTabs tabs={[
              { label: "Network Config", lang: "json", code: `{
  "chainId": 4663,
  "chainName": "Robinhood Chain",
  "rpcUrl": "https://rpc.mainnet.chain.robinhood.com/",
  "explorer": "https://robinhoodchain.blockscout.com",
  "nativeCurrency": {
    "name": "Robinhood Chain",
    "symbol": "PC",
    "decimals": 18
  }
}` },
            ]} />
          </section>

          {/* ── FOOTER ── */}
          <footer className="docs-footer">
            <div className="docs-footer-inner">
              <div className="docs-footer-brand">
                <span className="docs-glyph sm" aria-hidden="true">
                  <MoleGlyph size={14} />
                </span>
                <span>MoleSwap</span>
              </div>
              <div className="docs-footer-links">
                <a href="https://github.com/penguinpecker/moleswap" target="_blank" rel="noopener noreferrer">GitHub</a>
                <a href="/" >App</a>
                <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noopener noreferrer">Explorer</a>
                <a href="https://twitter.com/moleswap" target="_blank" rel="noopener noreferrer">Twitter</a>
              </div>
            </div>
          </footer>
        </div>
      </div>

      {/* ═══════════════════════════════════
          STYLES
         ═══════════════════════════════════ */}
      <style jsx global>{`
        /* ── Reset for docs page — Burrow loam night palette ── */
        .docs-root { min-height:100vh; background:#1c1008; color:#ecdcc4; font-family:var(--font-ui); }
        .docs-root *{box-sizing:border-box}
        .docs-root h1,.docs-root h2,.docs-root h3{color:#fdf4e6;font-weight:800;letter-spacing:-0.02em;text-shadow:none}
        .docs-root h1{font-size:2rem;line-height:1.2;margin:0 0 16px}
        .docs-root h2{font-size:1.5rem;margin:48px 0 16px;padding-top:24px;border-top:1px solid rgba(253,244,230,.08)}
        .docs-root h3{font-size:1.1rem;margin:32px 0 12px}
        .docs-root section:first-of-type h2{border-top:none;margin-top:0}
        .docs-root p{color:#9c8067;line-height:1.7;margin:0 0 16px}
        .docs-root code{font-family:var(--font-num);font-size:0.85em;background:rgba(240,160,60,.1);padding:2px 6px;border-radius:5px;color:#ffcd7d}
        .docs-root a{color:#f0a03c;text-decoration:none}
        .docs-root a:hover{color:#ffcd7d;text-decoration:underline}
        .docs-root strong{color:#ecdcc4;font-weight:700}

        /* ── Top Bar ── */
        .docs-topbar{position:sticky;top:0;z-index:50;background:rgba(28,16,8,0.85);backdrop-filter:blur(12px);border-bottom:1px solid rgba(253,244,230,.08);height:56px}
        .docs-topbar-inner{max-width:1400px;margin:0 auto;display:flex;align-items:center;height:100%;padding:0 20px;gap:16px}
        .docs-topbar-left{display:flex;align-items:center;gap:12px}
        .docs-topbar-right{display:flex;align-items:center;gap:12px;margin-left:auto}
        .docs-mobile-toggle{display:none;background:none;border:none;color:#9c8067;cursor:pointer;padding:4px}
        .docs-logo{display:flex;align-items:center;gap:8px;text-decoration:none!important}
        .docs-glyph{width:28px;height:28px;border-radius:8px;flex:none;display:grid;place-items:center;background:radial-gradient(circle at 32% 28%,#b8794a,#6b4423 70%);color:#ffd9a8}
        .docs-glyph.sm{width:24px;height:24px;border-radius:7px}
        .docs-logo-text{color:#fdf4e6;font-weight:800;font-size:15px}
        .docs-logo-badge{background:rgba(240,160,60,0.15);color:#f0a03c;font-size:11px;font-weight:800;letter-spacing:.05em;padding:2px 8px;border-radius:6px}
        .docs-search-trigger{display:flex;align-items:center;gap:8px;background:rgba(253,244,230,0.03);border:1px solid rgba(253,244,230,0.14);border-radius:8px;padding:7px 12px;color:#9c8067;font-size:13px;cursor:pointer;min-width:220px;transition:border-color 0.15s,color 0.15s;font-family:inherit}
        .docs-search-trigger:hover{border-color:rgba(253,244,230,0.25);color:#ecdcc4}
        .docs-search-trigger kbd{margin-left:auto;font-size:11px;background:rgba(253,244,230,0.06);padding:2px 6px;border-radius:5px;font-family:var(--font-num);color:#7a5c3f}
        .docs-github-link{color:#9c8067;transition:color 0.15s}
        .docs-github-link:hover{color:#fdf4e6}

        /* ── Layout ── */
        .docs-layout{display:flex;max-width:1400px;margin:0 auto}
        .docs-sidebar{width:260px;position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto;border-right:1px solid rgba(253,244,230,.08);padding:20px 0;flex-shrink:0;scrollbar-width:thin;scrollbar-color:rgba(253,244,230,.1) transparent}
        .docs-sidebar::-webkit-scrollbar{width:4px}
        .docs-sidebar::-webkit-scrollbar-thumb{background:rgba(253,244,230,.1);border-radius:4px}
        .docs-content{flex:1;min-width:0;max-width:820px;padding:40px 48px 80px;margin:0 auto}

        /* ── Nav ── */
        .docs-nav-group{margin-bottom:24px}
        .docs-nav-group-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;color:#7a5c3f;padding:0 20px;margin-bottom:6px}
        .docs-nav-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 20px;border:none;background:none;color:#b39a80;font-size:13px;cursor:pointer;text-align:left;transition:all 0.15s;border-left:2px solid transparent;font-family:inherit}
        .docs-nav-item:hover{color:#ecdcc4;background:rgba(253,244,230,0.03)}
        .docs-nav-item.active{color:#ffcd7d;background:rgba(240,160,60,0.08);border-left-color:#f0a03c}
        .docs-nav-icon{font-size:14px;width:20px;text-align:center}

        /* ── Hero ── */
        .docs-hero{margin-bottom:40px}
        .docs-hero-sub{font-size:1.1rem;color:#9c8067;max-width:600px}
        .docs-hero-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
        .docs-pill{background:rgba(253,244,230,0.02);border:1px solid rgba(253,244,230,0.14);border-radius:8px;padding:6px 12px;font-size:13px;color:#9c8067}
        .docs-pill code{background:none;padding:0;color:#f0a03c}

        /* ── Cards Grid ── */
        .docs-cards-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin:24px 0}
        .docs-card{background:rgba(253,244,230,0.03);border:1px solid rgba(253,244,230,.08);border-radius:12px;padding:20px;cursor:pointer;transition:border-color 0.2s,background 0.2s}
        .docs-card:hover{border-color:rgba(240,160,60,0.3);background:rgba(240,160,60,0.04)}
        .docs-card-icon{font-size:24px;margin-bottom:8px}
        .docs-card-title{font-weight:800;color:#fdf4e6;margin-bottom:4px}
        .docs-card-desc{font-size:13px;color:#9c8067}

        /* ── Code Block ── */
        .docs-code-block{margin:16px 0;border:1px solid rgba(253,244,230,.08);border-radius:10px;overflow:hidden;background:rgba(0,0,0,0.18)}
        .docs-code-tabs{display:flex;align-items:center;justify-content:space-between;background:rgba(253,244,230,0.03);border-bottom:1px solid rgba(253,244,230,.08);padding:0 4px}
        .docs-code-tab-list{display:flex}
        .docs-code-tab{padding:8px 14px;font-size:12px;font-weight:700;color:#9c8067;background:none;border:none;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;font-family:inherit}
        .docs-code-tab:hover{color:#ecdcc4}
        .docs-code-tab.active{color:#ffcd7d;border-bottom-color:#f0a03c}
        .docs-copy-btn{padding:4px 10px;font-size:11px;font-weight:700;color:#9c8067;background:none;border:1px solid rgba(253,244,230,0.14);border-radius:6px;cursor:pointer;margin:4px;font-family:inherit}
        .docs-copy-btn:hover{color:#ecdcc4;border-color:rgba(253,244,230,0.25)}
        .docs-pre{margin:0;padding:16px 20px;overflow-x:auto;font-family:var(--font-num);font-size:12.5px;line-height:1.6;color:#e8d9bf;background:rgba(0,0,0,0.3)}
        .docs-pre code{background:none;padding:0;color:inherit;font-size:inherit}

        /* ── Endpoint Header ── */
        .docs-endpoint-header{display:flex;align-items:center;gap:10px;margin:12px 0 16px;padding:10px 14px;background:rgba(0,0,0,0.18);border:1px solid rgba(253,244,230,.08);border-radius:10px}
        .docs-method{font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 8px;border-radius:6px;font-family:var(--font-num)}
        .docs-method.get{background:rgba(74,222,128,0.12);color:#4ade80}
        .docs-method.post{background:rgba(251,191,36,0.12);color:#fbbf24}
        .docs-endpoint-path{font-size:14px;color:#fdf4e6;background:none;padding:0;word-break:break-all}

        /* ── Param Table ── */
        .docs-param-table{margin:16px 0;border:1px solid rgba(253,244,230,.08);border-radius:10px;overflow-x:auto}
        .docs-param-table table{width:100%;border-collapse:collapse;font-size:13px;min-width:540px}
        .docs-param-table th{text-align:left;padding:10px 14px;background:rgba(253,244,230,0.02);color:#7a5c3f;font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid rgba(253,244,230,.08)}
        .docs-param-table td{padding:10px 14px;border-bottom:1px solid rgba(253,244,230,.05);color:#9c8067;vertical-align:top}
        .docs-param-table tr:last-child td{border-bottom:none}
        .docs-param-table td code{font-size:12px;white-space:nowrap}
        .docs-type{font-size:11px;color:#9c8067;font-family:var(--font-num)}
        .docs-req{font-size:12px;color:#f87171;font-weight:700}
        .docs-opt{font-size:12px;color:#7a5c3f}

        /* ── Info Card ── */
        .docs-info-card{display:flex;gap:12px;padding:16px;margin:16px 0;background:rgba(240,160,60,0.06);border:1px solid rgba(240,160,60,0.16);border-radius:10px}
        .docs-info-icon{font-size:18px;flex-shrink:0;margin-top:1px}
        .docs-info-title{font-weight:800;color:#ffcd7d;font-size:14px;margin-bottom:4px}
        .docs-info-body{color:#b39a80;font-size:13px;line-height:1.6}
        .docs-info-body code{font-size:12px}

        /* ── Steps ── */
        .docs-steps{margin:20px 0;display:flex;flex-direction:column;gap:16px}
        .docs-step{display:flex;gap:14px}
        .docs-step-num{width:28px;height:28px;background:rgba(240,160,60,0.12);border:1px solid rgba(240,160,60,0.3);border-radius:8px;display:flex;align-items:center;justify-content:center;color:#f0a03c;font-weight:700;font-size:13px;flex-shrink:0;font-family:var(--font-num)}
        .docs-step-title{font-weight:800;color:#fdf4e6;font-size:14px;margin-bottom:2px}
        .docs-step-desc{color:#9c8067;font-size:13px;line-height:1.5;word-break:break-word}

        /* ── Rate Limit Grid ── */
        .docs-rate-limit-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0}
        .docs-rl-card{background:rgba(253,244,230,0.02);border:1px solid rgba(253,244,230,.08);border-radius:10px;padding:16px 20px}
        .docs-rl-label{font-size:12px;color:#9c8067;margin-bottom:4px}
        .docs-rl-value{font-size:18px;font-weight:600;color:#fdf4e6}

        /* ── Fee Grid ── */
        .docs-fee-grid{display:flex;flex-direction:column;gap:8px;margin:12px 0}
        .docs-fee-item{display:flex;align-items:center;gap:12px;padding:8px 14px;background:rgba(253,244,230,0.02);border:1px solid rgba(253,244,230,.05);border-radius:8px;font-size:13px}
        .docs-fee-item code{font-size:12px;min-width:50px;text-align:right}
        .docs-fee-pct{color:#f0a03c;font-weight:800;min-width:50px;font-family:var(--font-num)}
        .docs-fee-use{color:#9c8067}

        /* ── Contracts Table ── */
        .docs-contracts-table{margin:16px 0;border:1px solid rgba(253,244,230,.08);border-radius:10px;overflow-x:auto}
        .docs-contracts-table table{width:100%;border-collapse:collapse;font-size:13px}
        .docs-contracts-table th{text-align:left;padding:10px 14px;background:rgba(253,244,230,0.02);color:#7a5c3f;font-weight:800;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid rgba(253,244,230,.08)}
        .docs-contracts-table td{padding:10px 14px;border-bottom:1px solid rgba(253,244,230,.05);color:#9c8067}
        .docs-contracts-table tr:last-child td{border-bottom:none}
        .docs-contracts-table td strong{color:#fdf4e6;white-space:nowrap}
        .docs-contracts-table code{font-size:11px;word-break:break-all;background:none;padding:0;color:inherit;font-family:var(--font-num)}

        /* ── Playground ── */
        .docs-playground{margin:16px 0;border:1px solid rgba(253,244,230,.08);border-radius:12px;overflow:hidden;background:rgba(253,244,230,0.02)}
        .docs-playground-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(253,244,230,0.03);border-bottom:1px solid rgba(253,244,230,.08)}
        .docs-playground-title{font-weight:800;font-size:13px;color:#fdf4e6}
        .docs-playground-badge{font-size:11px;font-weight:700;color:#4ade80}
        .docs-playground-params{padding:12px 16px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid rgba(253,244,230,.05)}
        .docs-playground-param{display:flex;align-items:center;gap:10px}
        .docs-playground-param label{font-size:12px;color:#9c8067;min-width:80px;font-family:var(--font-num)}
        .docs-playground-param input{flex:1;padding:6px 10px;background:rgba(0,0,0,0.25);border:1px solid rgba(253,244,230,0.14);border-radius:6px;color:#ecdcc4;font-size:12px;font-family:var(--font-num)}
        .docs-playground-param input:focus{outline:none;border-color:rgba(240,160,60,0.4)}
        .docs-playground-body{padding:12px 16px;border-bottom:1px solid rgba(253,244,230,.05)}
        .docs-playground-body label{display:block;font-size:12px;color:#9c8067;margin-bottom:6px}
        .docs-playground-body textarea{width:100%;padding:10px;background:rgba(0,0,0,0.25);border:1px solid rgba(253,244,230,0.14);border-radius:6px;color:#ecdcc4;font-size:12px;font-family:var(--font-num);resize:vertical;line-height:1.55}
        .docs-playground-body textarea:focus{outline:none;border-color:rgba(240,160,60,0.4)}
        .docs-playground-run{margin:12px 16px;padding:9px 20px;background:linear-gradient(180deg,#ffb85c,#cd5f2a);color:#38200c;border:none;border-radius:10px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;box-shadow:0 2px 0 #8f3f18,inset 0 1px 0 rgba(255,255,255,.4)}
        .docs-playground-run:not(:disabled):active{transform:translateY(1px);box-shadow:0 1px 0 #8f3f18,inset 0 1px 0 rgba(255,255,255,.4)}
        .docs-playground-run:disabled{opacity:0.5;cursor:not-allowed}
        .docs-playground-result{border-top:1px solid rgba(253,244,230,.08)}
        .docs-playground-result pre{margin:0;padding:16px;max-height:320px;overflow:auto;font-size:11.5px;line-height:1.5;color:#e8d9bf;background:rgba(0,0,0,0.3);font-family:var(--font-num)}
        .docs-playground-result pre code{background:none;padding:0;color:inherit;font-size:inherit}
        .docs-status{padding:6px 16px;font-size:12px;font-weight:700;border-bottom:1px solid rgba(253,244,230,.05);font-family:var(--font-num)}
        .docs-status.ok{color:#4ade80;background:rgba(74,222,128,0.06)}
        .docs-status.err{color:#f87171;background:rgba(248,113,113,0.06)}

        /* ── Search Modal ── */
        .docs-search-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);display:flex;justify-content:center;align-items:flex-start;padding-top:120px}
        .docs-search-modal{width:520px;max-height:400px;background:#2a180a;border:1px solid rgba(253,244,230,0.1);border-radius:12px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,0.6)}
        .docs-search-input{width:100%;padding:14px 18px;background:transparent;border:none;border-bottom:1px solid rgba(253,244,230,.08);color:#fdf4e6;font-size:15px;outline:none;font-family:inherit}
        .docs-search-input::placeholder{color:#7a5c3f}
        .docs-search-results{max-height:300px;overflow-y:auto;padding:6px}
        .docs-search-result{display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;border:none;background:none;color:#b39a80;font-size:14px;cursor:pointer;text-align:left;border-radius:8px;font-family:inherit}
        .docs-search-result:hover{background:rgba(240,160,60,0.08);color:#ecdcc4}
        .docs-search-empty{padding:20px;text-align:center;color:#7a5c3f;font-size:14px}

        /* ── Footer ── */
        .docs-footer{margin-top:60px;padding:30px 0;border-top:1px solid rgba(253,244,230,.08)}
        .docs-footer-inner{display:flex;align-items:center;justify-content:space-between}
        .docs-footer-brand{display:flex;align-items:center;gap:8px;color:#9c8067;font-weight:800;font-size:14px}
        .docs-footer-links{display:flex;gap:20px}
        .docs-footer-links a{color:#7a5c3f;font-size:13px;text-decoration:none}
        .docs-footer-links a:hover{color:#9c8067}

        /* ── Mobile ── */
        @media(max-width:768px){
          .docs-mobile-toggle{display:block}
          .docs-search-trigger{display:none}
          .docs-sidebar{position:fixed;left:0;top:56px;bottom:0;z-index:40;background:#1c1008;transform:translateX(-100%);transition:transform 0.2s;box-shadow:20px 0 50px rgba(0,0,0,.4)}
          .docs-sidebar.open{transform:translateX(0)}
          .docs-content{padding:24px 16px 60px}
          .docs-cards-grid{grid-template-columns:1fr}
          .docs-rate-limit-grid{grid-template-columns:1fr}
          .docs-search-modal{width:calc(100% - 32px);margin:0 16px}
          .docs-hero h1{font-size:1.5rem}
          .docs-endpoint-header{flex-wrap:wrap}
          .docs-param-table{overflow-x:auto}
          .docs-contracts-table{overflow-x:auto}
          .docs-footer-inner{flex-direction:column;gap:16px;text-align:center}
          /* The 820px content column was never capped to the screen, so the whole docs layout
             stayed 820px wide on a 390px phone and dragged the page into ~849px of horizontal
             overflow. Everything below is a floor of zero plus a real cap, so long code, wide
             tables and long addresses scroll inside their own box instead of widening the page. */
          /* main still resolves to its 1140px measure here, so the docs root is made a clip
             container: nothing inside it can widen the page, and the pieces that genuinely need
             width (code blocks, param and contract tables) already scroll inside their own boxes. */
          main{min-width:0;max-width:100%}
          .docs-root{min-width:0;max-width:100%;overflow-x:hidden}
          .docs-layout,.docs-topbar-inner,.docs-content{min-width:0;max-width:100%}
          .docs-content{padding:24px 16px 60px}
          .docs-pre,.docs-playground-result pre{max-width:100%}
          .docs-param-table table{min-width:0}
          .docs-param-table td code{white-space:normal;word-break:break-all}
          .docs-code-tabs{flex-wrap:wrap}
          .docs-playground-param{flex-direction:column;align-items:stretch;gap:4px}
          .docs-playground-param label{min-width:0}
        }
      `}</style>
    </div>
  );
}
