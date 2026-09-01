/**
 * ammChainTargeting.test.ts — the swap engine talks to the chain the WALLET is on, and never moves it.
 *
 * TWO THINGS ARE PINNED HERE, both of which used to be false:
 *
 *   1. THE APPROVAL TARGET. `approveToken` always spent to `CONTRACTS.MOLE_ROUTER` — Robinhood's
 *      router — whatever chain the wallet was on. A standing ERC-20 allowance granted to the wrong
 *      chain's address is a fund-loss bug, not a display bug, which is why the router is asserted
 *      here from the CALLDATA the wallet was actually asked to sign rather than from a constant.
 *
 *   2. NO SILENT NETWORK SWITCH. Every write path began with `ensureChain()`, which issued
 *      `wallet_switchEthereumChain` (and `wallet_addEthereumChain`) to drag the user back to
 *      Robinhood. That is what made the chrome's chain switcher look broken: pick Arc, press a
 *      button, and the app put you back on Robinhood without a word. The engine may REFUSE and name
 *      the chain to move to; it may not move it.
 *
 * The Arc router address below was read from the live deployment (chain 5042) and is the same one
 * `lib/chain/chains.ts` records: 0xe419…f3e3.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { decodeFunctionData, parseAbi } from "viem";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const ARC_ID = 5042;
const RH_ID = 4663;
const ARC_HEX = "0x13b2"; // 5042
const RH_HEX = "0x1237"; // 4663
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_ROUTER = "0xe4192c72574e6e387d4c29eb89feceada105f3e3";
const RH_ROUTER = "0xbd9b841d690e31b61aa3858eb145ea8bbe71122c";
const HASH = `0x${"cd".repeat(32)}`;

const erc20 = parseAbi(["function approve(address spender, uint256 value) returns (bool)"]);

let walletRequests: { method: string; params?: any }[] = [];
let walletChainHex = ARC_HEX;
let sentTx: any = null;

function installWallet() {
  walletRequests = [];
  sentTx = null;
  (window as any).ethereum = {
    isMetaMask: true,
    on: vi.fn(),
    removeListener: vi.fn(),
    request: vi.fn(async ({ method, params }: any) => {
      walletRequests.push({ method, params });
      switch (method) {
        case "eth_chainId":
          return walletChainHex;
        case "eth_accounts":
        case "eth_requestAccounts":
          return [ACCOUNT];
        case "eth_sendTransaction":
          sentTx = params?.[0];
          return HASH;
        default:
          return null;
      }
    }),
  };
}

function installRpc() {
  const receipt = {
    transactionHash: HASH, blockHash: `0x${"22".repeat(32)}`, blockNumber: "0x10", transactionIndex: "0x0",
    from: ACCOUNT, to: ARC_ROUTER, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1",
    contractAddress: null, logs: [], logsBloom: `0x${"00".repeat(256)}`, status: "0x1", type: "0x2",
  };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const answer = (req: any) => {
      switch (req.method) {
        case "eth_blockNumber": return "0x10";
        case "eth_call": return `0x${"ff".repeat(32)}`;
        case "eth_getTransactionReceipt": return receipt;
        case "eth_getTransactionByHash": return { hash: HASH, blockNumber: "0x10", blockHash: receipt.blockHash, from: ACCOUNT, to: ARC_ROUTER, nonce: "0x1", value: "0x0", input: "0x", gas: "0x5208", gasPrice: "0x1", transactionIndex: "0x0", type: "0x2", chainId: "0x13b2" };
        case "eth_getBlockByNumber": return { number: "0x10", hash: receipt.blockHash, transactions: [HASH], timestamp: "0x1", baseFeePerGas: "0x1" };
        case "eth_estimateGas": return "0x5208";
        case "eth_gasPrice": return "0x1";
        case "eth_getTransactionCount": return "0x1";
        default: return null;
      }
    };
    const payload = Array.isArray(body)
      ? body.map((r) => ({ jsonrpc: "2.0", id: r.id, result: answer(r) }))
      : { jsonrpc: "2.0", id: body.id, result: answer(body) };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload), headers: new Headers({ "content-type": "application/json" }) } as any;
  }));
}

beforeEach(() => {
  walletChainHex = ARC_HEX;
  installWallet();
  installRpc();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const switchAttempts = () =>
  walletRequests.filter(
    (r) => r.method === "wallet_switchEthereumChain" || r.method === "wallet_addEthereumChain",
  );

describe("approveToken aims at the chain it was asked for", () => {
  it("spends to ARC'S router when the wallet is on Arc — never Robinhood's", async () => {
    const { approveToken } = await import("@/lib/chain/amm");
    const res = await approveToken(null, ARC_USDC, "1000000", undefined, ARC_ID);
    expect(res.success, res.error).toBe(true);

    // Read the spender back out of the bytes the wallet was handed. Asserting the constant would
    // prove nothing about what was signed.
    expect(sentTx).toBeTruthy();
    expect((sentTx.to as string).toLowerCase()).toBe(ARC_USDC);
    const { functionName, args } = decodeFunctionData({ abi: erc20, data: sentTx.data });
    expect(functionName).toBe("approve");
    expect((args![0] as string).toLowerCase()).toBe(ARC_ROUTER);
    expect((args![0] as string).toLowerCase()).not.toBe(RH_ROUTER);
    expect(args![1]).toBe(1000000n);
  });

  it("spends to Robinhood's router on Robinhood — the pre-multichain behaviour is unchanged", async () => {
    walletChainHex = RH_HEX;
    const { approveToken } = await import("@/lib/chain/amm");
    const res = await approveToken(null, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "5", undefined, RH_ID);
    expect(res.success, res.error).toBe(true);
    const { args } = decodeFunctionData({ abi: erc20, data: sentTx.data });
    expect((args![0] as string).toLowerCase()).toBe(RH_ROUTER);
  });

  it("REFUSES when the wallet is on the other chain, and does not switch it", async () => {
    walletChainHex = RH_HEX; // wallet on Robinhood...
    const { approveToken } = await import("@/lib/chain/amm");
    const res = await approveToken(null, ARC_USDC, "1000000", undefined, ARC_ID); // ...approval for Arc
    expect(res.success).toBe(false);
    // The refusal has to be actionable: it names where to go, because "wrong network" alone leaves
    // the user with nothing to do.
    expect(res.error).toContain("Arc");
    expect(res.error).toMatch(/switch/i);
    // Nothing was signed, and — the whole point — nothing was switched.
    expect(sentTx).toBeNull();
    expect(switchAttempts()).toEqual([]);
  });

  it("refuses a wallet on a network we have no deployment on, naming the ones we do", async () => {
    walletChainHex = "0x1"; // Ethereum mainnet
    const { approveToken } = await import("@/lib/chain/amm");
    const res = await approveToken(null, ARC_USDC, "1", undefined, ARC_ID);
    expect(res.success).toBe(false);
    expect(res.error).toContain("Robinhood Chain");
    expect(res.error).toContain("Arc");
    expect(switchAttempts()).toEqual([]);
  });
});

describe("executeSwap never moves the user's network", () => {
  it("refuses a Robinhood-built swap while the wallet sits on Arc, instead of switching it back", async () => {
    walletChainHex = ARC_HEX;
    const { executeSwap } = await import("@/lib/chain/amm");
    // No chainId given, so this is a Robinhood swap — exactly what the confirm screen builds today.
    const res = await executeSwap({
      tokenIn: "0x0000000000000000000000000000000000000000",
      tokenOut: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      amountIn: "1000000000000000",
      recipient: ACCOUNT,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Robinhood Chain/);
    // It used to call wallet_switchEthereumChain here and then execute on Robinhood's router with
    // the user believing they were on Arc.
    expect(switchAttempts()).toEqual([]);
    expect(sentTx).toBeNull();
  });
});
