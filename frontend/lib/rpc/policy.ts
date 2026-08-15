/**
 * policy.ts — the two judgement calls a JSON-RPC proxy has to get right.
 *
 *   1. WHICH METHODS DO WE FORWARD?  (methodPolicy)
 *   2. WHEN IS AN UPSTREAM'S REPLY A FAILURE RATHER THAN AN ANSWER?  (classify)
 *
 * (2) is the one that quietly breaks DEXes. A reverted `eth_call` and an exhausted
 * provider quota both arrive as `{"error":{...}}`. Retry the revert and you burn three
 * upstreams to re-learn the same true fact; pass the quota error through and the user
 * sees "no route" on a chain that is working perfectly. The rule this file encodes:
 *
 *      IF THE CHAIN SPOKE, IT IS AN ANSWER — FORWARD IT UNTOUCHED.
 *      IF THE INFRASTRUCTURE SPOKE, IT IS A FAILURE — TRY THE NEXT UPSTREAM.
 *
 * Every branch below is a case that was observed against live Arc endpoints on
 * 2026-08-16, not a guess about what providers might do.
 */

import { ARC_CHAIN_ID, ARC_CHAIN_ID_HEX } from "./arc-chain";

/* ------------------------------------------------------------------ shapes */

export interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

/* ----------------------------------------------------------- method policy */

/**
 * Namespaces a public endpoint must never expose. These control or introspect the NODE
 * rather than read the chain: they can unlock accounts, mutate peering, or dump the
 * mempool. Upstream providers block them too — this is defence in depth, so that
 * pointing ARC_RPC_UPSTREAMS at a permissive or self-hosted node cannot silently turn
 * MoleSwap's public URL into an admin console.
 */
const BLOCKED_PREFIXES = [
  "admin_",
  "personal_",
  "miner_",
  "txpool_",
  "engine_",
  "db_",
  "clique_",
  "les_",
  "parity_",
  "shh_",
] as const;

/**
 * Tracing works, but a single call can cost more upstream credits than a thousand
 * ordinary reads, and no wallet issues one. Blocking it keeps a public URL from being
 * used to drain the quota that our users' swaps depend on.
 *
 * This is a cost decision, not a safety one — flip it if MoleSwap ever wants to offer
 * a tracing tier.
 */
const BLOCKED_EXPENSIVE_PREFIXES = ["debug_", "trace_", "arbtrace_", "ots_"] as const;

/**
 * Methods that belong to a WALLET, not to a node. A public RPC has no keys, so these
 * can only ever fail — and `eth_sendTransaction` reaching a node at all means something
 * upstream of us thinks we hold the user's key. Refuse loudly instead of proxying.
 */
const BLOCKED_METHODS = new Set([
  "eth_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "eth_signTransaction",
  "eth_sendTransaction",
  "personal_sign",
  "personal_unlockAccount",
  "wallet_addEthereumChain",
  "wallet_switchEthereumChain",
  "wallet_requestPermissions",
]);

/**
 * Answered here without touching an upstream. A public node holds no accounts, so the
 * honest answer is the empty one, and asking a provider to confirm that costs a request
 * MetaMask makes on a timer.
 */
const LOCAL_ANSWERS: Record<string, unknown> = {
  eth_accounts: [],
  eth_coinbase: null,
  eth_mining: false,
  eth_hashrate: "0x0",
};

/**
 * Protocol constants of the Arc network itself.
 *
 * These are NOT served from here in the normal path — they are forwarded like anything
 * else, so a misconfigured upstream gets caught by the chain-ID pin below. They are the
 * LAST RESORT only: when every upstream is unreachable, answering these from a constant
 * lets MetaMask's "add network" check succeed instead of showing the user a chain-ID
 * mismatch error for a chain that has not changed its id since genesis.
 */
export const LAST_RESORT_CONSTANTS: Record<string, unknown> = {
  eth_chainId: ARC_CHAIN_ID_HEX,
  net_version: String(ARC_CHAIN_ID),
};

export type MethodVerdict =
  | { kind: "forward" }
  | { kind: "local"; result: unknown }
  | { kind: "blocked"; code: number; message: string };

export function methodPolicy(method: unknown): MethodVerdict {
  if (typeof method !== "string" || method.length === 0) {
    return { kind: "blocked", code: -32600, message: "Invalid Request: `method` must be a string" };
  }

  // Length cap before any scanning: `method` is attacker-controlled and lands in logs.
  if (method.length > 128) {
    return { kind: "blocked", code: -32601, message: "Method not found" };
  }

  if (Object.prototype.hasOwnProperty.call(LOCAL_ANSWERS, method)) {
    return { kind: "local", result: LOCAL_ANSWERS[method] };
  }

  if (BLOCKED_METHODS.has(method)) {
    return {
      kind: "blocked",
      code: -32601,
      message: `${method} is a wallet method; this endpoint is a node and holds no keys`,
    };
  }

  for (const prefix of BLOCKED_PREFIXES) {
    if (method.startsWith(prefix)) {
      return { kind: "blocked", code: -32601, message: `The ${prefix}* namespace is not exposed` };
    }
  }

  for (const prefix of BLOCKED_EXPENSIVE_PREFIXES) {
    if (method.startsWith(prefix)) {
      return {
        kind: "blocked",
        code: -32601,
        message: `The ${prefix}* namespace is not available on the public endpoint`,
      };
    }
  }

  return { kind: "forward" };
}

/* --------------------------------------------------- failure classification */

export type Classification =
  | { verdict: "answer" }
  | { verdict: "retry"; reason: string };

const ANSWER: Classification = { verdict: "answer" };
const retry = (reason: string): Classification => ({ verdict: "retry", reason });

/**
 * HTTP statuses that mean "this upstream did not process your request", as opposed to
 * "the chain says no". 402/403 is a dead or referrer-locked key; 429 is a rate limit;
 * 5xx is the provider. All of them are somebody else's outage, and the next upstream
 * may well be fine.
 */
function httpIsInfraFailure(status: number): boolean {
  if (status === 0) return true; // synthesised for network errors / timeouts
  if (status === 401 || status === 402 || status === 403 || status === 407) return true;
  if (status === 404 || status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

/**
 * Provider-speak for "not now". Deliberately matched on MESSAGE as well as code,
 * because the codes are not standardised across providers and the most damaging
 * real-world case we measured used a code that normally means the opposite:
 *
 *   Infura returns  -32600 "project ID exceeded quota"
 *
 * -32600 is INVALID REQUEST in the JSON-RPC spec. Trusting the code alone would file a
 * dead provider key as "the client sent a malformed request" and hand that straight to
 * the user, forever, without ever trying the healthy upstream sitting behind it.
 */
const INFRA_MESSAGE = new RegExp(
  [
    "quota",
    "rate.?limit",
    "too many requests",
    "capacity",
    "over.?loaded",
    "unavailable",
    "temporarily",
    "try again",
    "internal error",
    "internal server",
    "timeout",
    "timed out",
    "upstream",
    "bad gateway",
    "no backend",
    "not able to process",
    "exceeded",
    "forbidden",
    "unauthorized",
    "invalid api key",
    "invalid project",
  ].join("|"),
  "i",
);

/**
 * JSON-RPC codes that always mean the infrastructure, never the chain.
 *
 * -32601 (method not found) IS in this list, which is not obvious. It belongs because
 * upstreams genuinely disagree about their surface — measured the same day:
 * rpc.arc-scan.org refuses `net_listening` while Infura and labsapis both answer it.
 * A method one provider declines may be perfectly ordinary at the next, so a
 * method-not-found is a property of the UPSTREAM, not of the chain.
 */
const INFRA_CODES = new Set([-32601, -32603, -32005, -32002, -32046, -32097]);

/**
 * Codes that are the chain speaking, whatever their message happens to contain.
 * Checked BEFORE the message regex so that a revert reason which merely mentions a
 * blocked word ("execution reverted: quota exceeded" from a staking contract) is not
 * mistaken for a provider outage and retried across every upstream.
 */
const CHAIN_CODES = new Set([
  3, // execution reverted, with ABI-encoded reason in `data` (Geth/Reth convention)
  -32000, // generic "server error": nonce too low, insufficient funds, already known…
  -32602, // invalid params — the client's fault, identical everywhere
  -32700, // parse error
  -32614, // eth_getLogs range cap: a real, deterministic limit of this network
]);

/**
 * Decide what a single JSON-RPC error means.
 *
 * The `data` field is the strongest signal available and is checked first: only a node
 * that actually EXECUTED something attaches ABI-encoded revert data. A provider
 * refusing on quota has nothing to attach.
 */
export function classifyRpcError(error: RpcErrorObject | undefined | null): Classification {
  if (!error || typeof error !== "object") return ANSWER;

  // Revert data present ⇒ the EVM ran. This is an answer, and losing it would break
  // every custom-error decode in the app.
  if (error.data !== undefined && error.data !== null) return ANSWER;

  const code = typeof error.code === "number" ? error.code : 0;
  const message = typeof error.message === "string" ? error.message : "";

  if (CHAIN_CODES.has(code) && !INFRA_MESSAGE.test(message)) return ANSWER;
  if (INFRA_CODES.has(code)) return retry(`upstream error ${code}: ${message.slice(0, 120)}`);
  if (INFRA_MESSAGE.test(message)) return retry(`upstream said: ${message.slice(0, 120)}`);

  return ANSWER;
}

/**
 * THE CHAIN-ID PIN.
 *
 * If an upstream claims to be a different network, nothing it says about state is
 * usable — balances, nonces and quotes would all be from the wrong chain while MetaMask
 * displays "Arc". Refusing the response and failing over is the only safe move, and it
 * is why eth_chainId is forwarded rather than answered from a constant: a constant
 * would paper over exactly the misconfiguration this catches.
 */
export function chainIdMismatch(method: string, result: unknown): string | null {
  if (method === "eth_chainId") {
    if (typeof result !== "string") return null;
    const got = result.toLowerCase();
    if (got !== ARC_CHAIN_ID_HEX) {
      // Compare numerically too: "0x13B2" and "0x013b2" are the same chain.
      const n = Number.parseInt(got, 16);
      if (!Number.isFinite(n) || n !== ARC_CHAIN_ID) {
        return `upstream reports chain ${result}, expected ${ARC_CHAIN_ID_HEX} (Arc ${ARC_CHAIN_ID})`;
      }
    }
    return null;
  }

  if (method === "net_version") {
    if (typeof result !== "string") return null;
    if (Number.parseInt(result, 10) !== ARC_CHAIN_ID) {
      return `upstream reports network ${result}, expected ${ARC_CHAIN_ID}`;
    }
  }

  return null;
}

/**
 * Classify a whole upstream reply: HTTP layer first, then each JSON-RPC entry.
 *
 * A batch is judged as a unit. If ANY entry failed at the infrastructure level the
 * whole batch is retried on the next upstream, because a client that batched twelve
 * calls needs twelve answers — handing back eleven results and one quota error is the
 * same broken page as handing back none.
 */
export function classifyUpstreamReply(args: {
  status: number;
  parsed: unknown;
  /** Method by request id, so a chain-ID pin can be applied to the right entry. */
  methodById: Map<string, string>;
}): Classification {
  const { status, parsed, methodById } = args;

  if (httpIsInfraFailure(status)) return retry(`http ${status}`);

  // A 2xx that is not JSON is a captive portal, a WAF interstitial, or an HTML error
  // page. `parsed === undefined` is how the caller reports "this did not parse".
  if (parsed === undefined) return retry("upstream returned a non-JSON body");

  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (Array.isArray(parsed) && parsed.length === 0) return retry("upstream returned an empty batch");

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") return retry("upstream returned a malformed entry");

    const e = entry as { error?: RpcErrorObject; result?: unknown; id?: unknown };

    if (e.error) {
      const c = classifyRpcError(e.error);
      if (c.verdict === "retry") return c;
      continue;
    }

    const method = methodById.get(idKey(e.id));
    if (method) {
      const mismatch = chainIdMismatch(method, e.result);
      if (mismatch) return retry(mismatch);
    }
  }

  return ANSWER;
}

/**
 * Stable key for a JSON-RPC id, which may legally be a string, a number, or null.
 * `null` and the string "null" are different ids and must not collide.
 */
export function idKey(id: unknown): string {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number") return `n:${id}`;
  if (id === null) return "null";
  return "undefined";
}
