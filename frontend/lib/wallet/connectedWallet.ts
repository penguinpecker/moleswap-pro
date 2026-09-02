/**
 * connectedWallet — the wallet the user actually connected, not whichever extension owns `window.ethereum`.
 *
 * Every write path used to build its signer from `window.ethereum`. That is the wrong wallet whenever the
 * user connected through WalletConnect, the Coinbase SDK, or picked one of several injected wallets via
 * EIP-6963: the review card showed the connected address, the pre-flight simulated AS that address, and
 * the approval + swap were then signed by a different wallet — or refused with "No wallet found" on a
 * phone that has no injected provider at all.
 *
 * wagmi already holds the connector the user chose. This asks wagmi first and falls back to the injected
 * provider only when wagmi has no connection (tests, and any page that never mounted the provider).
 * wagmi and its config are imported lazily so the server-side modules that share these code paths
 * (the tx-building API routes import the swap engine) never pull the connector bundle.
 *
 * The chain is READ, never switched: `chainId` is what the wallet reports, so the caller can refuse a
 * mismatch in words and leave the switch to an explicit click.
 */
import { createWalletClient, custom, type Address, type Chain, type WalletClient } from "viem";

export interface ConnectedWallet {
  wallet: WalletClient;
  account: Address;
  /** The chain the wallet reports itself on, or undefined if it will not say. */
  chainId: number | undefined;
  /** Which truth answered — useful in tests and in error copy, never for branching business logic. */
  source: "wagmi" | "injected";
}

function browserEth(): any {
  if (typeof window === "undefined") return null;
  return (window as any).ethereum ?? null;
}

async function injectedChainId(eth: any): Promise<number | undefined> {
  try {
    const cid = await eth.request({ method: "eth_chainId" });
    const n = typeof cid === "string" ? parseInt(cid, 16) : Number(cid);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @param chain The chain to bind the injected fallback client to. The wagmi client already carries the
 *              chain its connector is on, so this only matters when wagmi has no connection.
 */
export async function connectedWallet(chain: Chain): Promise<ConnectedWallet | null> {
  if (typeof window === "undefined") return null;

  try {
    const [{ getAccount, getWalletClient }, { wagmiConfig }] = await Promise.all([
      import("wagmi/actions"),
      import("@/lib/chain/wagmi-config"),
    ]);
    const acct = getAccount(wagmiConfig);
    if (acct.status === "connected" && acct.connector) {
      const wallet = await getWalletClient(wagmiConfig, { connector: acct.connector });
      const account = (wallet.account?.address ?? acct.address) as Address | undefined;
      if (account) {
        return { wallet: wallet as unknown as WalletClient, account, chainId: acct.chainId, source: "wagmi" };
      }
    }
  } catch {
    /* wagmi not mounted, or the connector went away — the injected provider is the next best truth */
  }

  const eth = browserEth();
  if (!eth) return null;
  const wallet = createWalletClient({ chain, transport: custom(eth) });
  const [account] = await wallet.getAddresses();
  if (!account) return null;
  return { wallet, account, chainId: await injectedChainId(eth), source: "injected" };
}
