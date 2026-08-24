/**
 * upstreams.ts — where MoleSwap's Arc RPC actually gets its answers.
 *
 * THE POINT OF THIS FILE: the upstream list is read from a SERVER-ONLY env var.
 * It is never prefixed NEXT_PUBLIC_, never imported by a client component, and never
 * reaches the browser bundle. That is the whole reason this proxy exists rather than
 * simply publishing a provider URL:
 *
 *   A provider URL published to users IS a published API key. RadarDEX put an Infura
 *   project id in a support FAQ; on 2026-08-16 that project answered eth_getBalance
 *   fine but returned `-32600 project ID exceeded quota` for EVERY eth_call — the one
 *   method a DEX cannot live without. Anyone can spend a public key, and the people
 *   who do are not your users.
 *
 * Behind /rpc/v1/arc we can rotate a leaked or exhausted upstream without a single user
 * touching their wallet settings, because the URL they configured is ours, not a
 * provider's.
 */

export interface Upstream {
  /** Full endpoint URL, key included. Treat as a secret. */
  readonly url: string;
  /** Host only — safe to put in a log line or a response header. */
  readonly label: string;
}

/**
 * The keyless fallback, used when ARC_RPC_UPSTREAMS is unset.
 *
 * Verified 2026-08-16: serves the full method surface a wallet needs (including
 * eth_sendRawTransaction and JSON-RPC batches), returns CORS `*`, holds archive state,
 * and agreed byte-for-byte with two independent providers on the block hash and state
 * root of a finalized block. It survived 40 concurrent and 60 sequential calls without
 * a single failure.
 *
 * It is still a default, not a recommendation: the operator is anonymous, so it can see
 * every address this endpoint asks about and could in principle lie about state. Set
 * ARC_RPC_UPSTREAMS to a keyed endpoint you control and this drops to last resort.
 */
export const DEFAULT_ARC_UPSTREAMS: readonly string[] = ["https://rpc.arc-scan.org"];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/**
 * Parse ARC_RPC_UPSTREAMS — a comma-separated, ordered preference list. The first
 * entry is tried first; later entries are only reached when an earlier one fails at
 * the INFRASTRUCTURE level (see policy.ts — a reverted eth_call is an answer, not a
 * failure, and never triggers a retry).
 *
 * Only http(s) URLs are accepted. Anything else is dropped rather than trusted: a typo
 * that silently became an upstream would be a chain-data integrity bug, and the
 * chain-ID pin downstream cannot catch a URL that was never a JSON-RPC endpoint.
 */
export function parseUpstreams(raw: string | undefined): Upstream[] {
  const source = (raw ?? "").trim() ? (raw as string) : DEFAULT_ARC_UPSTREAMS.join(",");

  const seen = new Set<string>();
  const out: Upstream[] = [];

  for (const piece of source.split(",")) {
    const url = piece.trim();
    if (!url) continue;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;

    // De-duplicate: a repeated upstream is not a second chance, it is the same
    // exhausted quota answering twice while the real fallback never gets a turn.
    if (seen.has(url)) continue;
    seen.add(url);

    out.push({ url, label: hostOf(url) });
  }

  return out.length ? out : [{ url: DEFAULT_ARC_UPSTREAMS[0], label: hostOf(DEFAULT_ARC_UPSTREAMS[0]) }];
}

/** The configured upstreams for this deployment. */
export function arcUpstreams(): Upstream[] {
  return parseUpstreams(process.env.ARC_RPC_UPSTREAMS);
}

/**
 * Robinhood Chain's public fallback. Keyless on purpose, and rate-limited by its operator — which is
 * exactly why a keyed upstream is worth having in front of it.
 */
export const DEFAULT_RH_UPSTREAMS: readonly string[] = ["https://rpc.mainnet.chain.robinhood.com"];

/**
 * The configured Robinhood upstreams. SERVER-ONLY, for the reason this whole file exists.
 *
 * This function was added on 2026-08-24 because Robinhood was doing the exact thing the header above
 * warns about. The RH endpoint was published to the browser as `NEXT_PUBLIC_RH_RPC_URL`, and anything
 * with that prefix is inlined into the client bundle at build time — so the keyed Alchemy URL was
 * readable in three of the shipped JavaScript chunks on the live site. A provider URL published to
 * users IS a published API key, and the people who spend it are not your users.
 *
 * Arc had been doing this correctly since it launched. Robinhood, the older of the two, never got the
 * same treatment, which is the ordinary way this kind of gap survives: the newer thing gets the
 * lesson and the older thing keeps the habit.
 */
export function rhUpstreams(): Upstream[] {
  const parsed = parseUpstreams(process.env.RH_RPC_UPSTREAMS);
  // parseUpstreams falls back to Arc's default when its env var is unset, which is the wrong chain
  // entirely. Detect that case by identity and substitute Robinhood's own public endpoint.
  if (parsed.length === 1 && parsed[0].url === DEFAULT_ARC_UPSTREAMS[0] && !process.env.RH_RPC_UPSTREAMS) {
    return [{ url: DEFAULT_RH_UPSTREAMS[0], label: hostOf(DEFAULT_RH_UPSTREAMS[0]) }];
  }
  return parsed;
}
