/**
 * Origin-chain balance lookup for bridgeable PRC-20 tokens.
 *
 * In the swap UI we show the user their origin-chain asset (e.g. native SOL on
 * Solana Devnet, or USDT SPL on Solana, or ETH on Sepolia) — NOT the Push
 * Chain PRC-20 balance — because that's what they actually hold and what gets
 * bridged in during a swap. This module centralizes the per-chain RPC calls
 * so ExchangePage's fetchOriginContext effect, its token-picker modal, and
 * SwapPage's preflight all agree on one source of truth.
 *
 * Returns a decimal string (e.g. "0.934521") to match the shape
 * getTokenBalance() returns — null if we can't determine the balance or the
 * token isn't bridgeable from this origin.
 */
import { getBridgeInfoForPrc20 } from "@/lib/pushchain/prc20-bridge-map";

const SOLANA_DEVNET_RPC = "https://api.devnet.solana.com";

const EVM_RPC: Record<string, string> = {
  "eip155:11155111": "https://ethereum-sepolia-rpc.publicnode.com",
  "eip155:421614":   "https://arbitrum-sepolia-rpc.publicnode.com",
  "eip155:84532":    "https://base-sepolia-rpc.publicnode.com",
  "eip155:97":       "https://bsc-testnet-rpc.publicnode.com",
};

async function rpcPost(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

/**
 * Fetch the user's origin-chain balance for a PRC-20 token on Push Chain.
 *
 * @param prc20Address  The Push Chain PRC-20 token address (e.g. pSOL = 0x5D5...).
 * @param originPubkey  The user's address on the origin chain (Phantom pubkey,
 *                      or EVM address on Sepolia/Arbitrum/etc.).
 * @param userOriginChain The CAIP chain ID of the user's connected wallet
 *                      (e.g. "solana:EtWTR…xqa1", "eip155:11155111"). If this
 *                      doesn't match the token's bridge origin, returns null.
 * @returns Decimal balance string, or null if not applicable / probe fails.
 */
export async function fetchOriginBalance(
  prc20Address: string,
  originPubkey: string | null | undefined,
  userOriginChain: string | null | undefined,
): Promise<string | null> {
  if (!originPubkey || !userOriginChain) return null;
  const bridge = getBridgeInfoForPrc20(prc20Address);
  if (!bridge) return null;
  // Only show origin balance when the user's connected origin chain actually
  // matches the token's origin chain. A Phantom-connected user shouldn't see
  // their Sepolia ETH balance listed under a Solana token.
  if (bridge.originChain.toLowerCase() !== userOriginChain.toLowerCase()) {
    return null;
  }

  try {
    // ─ Solana origin ─────────────────────────────────────────────────────
    if (bridge.originChain.startsWith("solana:")) {
      if (bridge.originSymbol === "SOL") {
        // Native SOL lamports
        const json = await rpcPost(SOLANA_DEVNET_RPC, {
          jsonrpc: "2.0", id: 1, method: "getBalance", params: [originPubkey],
        });
        const lamports = json?.result?.value;
        if (typeof lamports !== "number") return null;
        return (lamports / 1e9).toFixed(6);
      }
      // SPL token — sum token accounts owned by pubkey for the given mint.
      const json = await rpcPost(SOLANA_DEVNET_RPC, {
        jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
        params: [
          originPubkey,
          { mint: bridge.originAddress },
          { encoding: "jsonParsed" },
        ],
      });
      const accounts = json?.result?.value || [];
      let total = 0;
      for (const acc of accounts) {
        const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === "number") total += amt;
      }
      return total.toFixed(6);
    }

    // ─ EVM origin ────────────────────────────────────────────────────────
    if (bridge.originChain.startsWith("eip155:")) {
      const rpcUrl = EVM_RPC[bridge.originChain.toLowerCase()];
      if (!rpcUrl) return null;
      const decimals = (bridge as any).originDecimals ?? 18;

      if (bridge.originSymbol === "ETH") {
        const json = await rpcPost(rpcUrl, {
          jsonrpc: "2.0", id: 1, method: "eth_getBalance",
          params: [originPubkey, "latest"],
        });
        if (!json?.result) return null;
        const wei = BigInt(json.result);
        return (Number(wei) / 10 ** decimals).toFixed(6);
      }

      // ERC-20 balanceOf(address)
      const selector = "0x70a08231"; // balanceOf(address)
      const addrPadded = originPubkey.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      const json = await rpcPost(rpcUrl, {
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: bridge.originAddress, data: selector + addrPadded }, "latest"],
      });
      if (!json?.result || json.result === "0x") return "0";
      const raw = BigInt(json.result);
      return (Number(raw) / 10 ** decimals).toFixed(6);
    }
  } catch (err) {
    // Best-effort only — never throw into UI code.
    console.warn("[originBalance] fetch failed:", err);
    return null;
  }
  return null;
}
