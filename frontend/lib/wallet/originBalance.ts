/**
 * Origin-chain balances — not applicable on a single chain (Robinhood Chain).
 *
 * The original fetched the user's asset balance on the ORIGIN chain (e.g. SOL on Solana) for the
 * cross-chain bridge-in preview. MoleSwap runs on one chain, so there is no separate origin balance;
 * this returns null and the UI simply hides the origin-balance line.
 */
export interface OriginBalance {
  raw: string;
  formatted: string;
  symbol: string;
  chainName: string;
}

export async function fetchOriginBalance(
  _token: string,
  _origin: string | null,
  _originChain: string | null,
): Promise<OriginBalance | null> {
  return null;
}
