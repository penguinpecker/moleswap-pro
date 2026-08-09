/**
 * Swap Client — uses PushChain V3 AMM (QuoterV2 + SwapRouter)
 */
import { getSwapQuote, executeSwap as pushExecuteSwap } from "@/lib/pushchain/amm";

export const relayClient = {
  actions: {
    getQuote: async (params: any) => {
      const quote = await getSwapQuote({
        tokenIn: params.currency || params.fromToken,
        tokenOut: params.toCurrency || params.toToken,
        amountIn: params.amount || "0",
        fee: params.fee,
      });
      return quote || {};
    },
    execute: async (params: any) => {
      console.log("Use pushChainClient.universal.sendTransaction for swaps");
      return {};
    },
  },
};

export type RelayClient = typeof relayClient;
