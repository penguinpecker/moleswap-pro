/**
 * connectedWallet.test.ts — the signer must be the wallet the user CONNECTED, not `window.ethereum`.
 *
 * The failure this pins: a user connects with WalletConnect (or a second injected wallet via EIP-6963),
 * the review card shows THAT address, and the approval + swap are then signed by whichever extension
 * owns `window.ethereum` — or refused with "No wallet found" on a phone with no injected provider.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const WAGMI_ACCOUNT = "0x00000000000000000000000000000000000000c1";
const INJECTED_ACCOUNT = "0x00000000000000000000000000000000000000e1";

const wagmiState: { status: string; chainId?: number; address?: string; connector?: object } = { status: "disconnected" };

vi.mock("wagmi/actions", () => ({
  getAccount: () => ({ ...wagmiState }),
  getWalletClient: async () => ({
    account: { address: WAGMI_ACCOUNT },
    writeContract: vi.fn(),
    getAddresses: async () => [WAGMI_ACCOUNT],
  }),
}));
vi.mock("@/lib/chain/wagmi-config", () => ({ wagmiConfig: {} }));

const chain = { id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://localhost"] } } } as any;

describe("connectedWallet", () => {
  const originalEth = (window as any).ethereum;
  beforeEach(() => {
    wagmiState.status = "disconnected";
    delete wagmiState.chainId;
    delete wagmiState.address;
    delete wagmiState.connector;
    (window as any).ethereum = {
      request: async ({ method }: { method: string }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [INJECTED_ACCOUNT];
        if (method === "eth_chainId") return "0x1237"; // 4663
        throw new Error(`unexpected ${method}`);
      },
    };
  });
  afterEach(() => {
    (window as any).ethereum = originalEth;
  });

  it("signs with wagmi's connector when one is connected — even with a different injected wallet present", async () => {
    wagmiState.status = "connected";
    wagmiState.chainId = 5042;
    wagmiState.address = WAGMI_ACCOUNT;
    wagmiState.connector = { id: "walletConnect" };
    const { connectedWallet } = await import("../../lib/wallet/connectedWallet");
    const cw = await connectedWallet(chain);
    expect(cw?.source).toBe("wagmi");
    expect(cw?.account).toBe(WAGMI_ACCOUNT);
    // the chain is the WALLET's, read from the connection, not assumed from the page
    expect(cw?.chainId).toBe(5042);
  });

  it("falls back to the injected provider when wagmi holds no connection", async () => {
    const { connectedWallet } = await import("../../lib/wallet/connectedWallet");
    const cw = await connectedWallet(chain);
    expect(cw?.source).toBe("injected");
    expect(cw?.account).toBe(INJECTED_ACCOUNT);
    expect(cw?.chainId).toBe(4663);
  });

  it("answers null when there is neither a connection nor an injected provider", async () => {
    (window as any).ethereum = undefined;
    const { connectedWallet } = await import("../../lib/wallet/connectedWallet");
    expect(await connectedWallet(chain)).toBeNull();
  });
});
