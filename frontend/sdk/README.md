# @moleswap/sdk

TypeScript SDK for **MoleSwap DEX** on PushChain. Swap tokens, create pools, add liquidity — all through a simple API.

## Install

```bash
npm install @moleswap/sdk
```

## Quick Start

```typescript
import { MoleSwap } from "@moleswap/sdk";

const mole = new MoleSwap();

// Get a swap quote
const quote = await mole.getQuote({
  tokenIn: "0x0000000000000000000000000000000000000000", // native PC
  tokenOut: "0x2971824Db68229D087931155C2b8bB820B275809", // pETH
  amountIn: "1000000000000000000", // 1 PC in wei
});
console.log(quote.amountOut, quote.route);

// Build unsigned swap calldata
const { transactions } = await mole.buildSwapTx({
  tokenIn: "0x0000000000000000000000000000000000000000",
  tokenOut: "0x2971824Db68229D087931155C2b8bB820B275809",
  amountIn: "1000000000000000000",
  recipient: "0xYOUR_WALLET",
});
// Sign & send each transaction sequentially with your wallet
```

## Token Launcher

Create a pool for your new token in one call:

```typescript
const { transactions } = await mole.buildCreatePoolTx({
  tokenA: "0xYOUR_TOKEN",
  tokenB: "0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9", // WPC
  fee: 500,
  initialPrice: 0.001,
  amount0Desired: "1000000000000000000000",
  amount1Desired: "1000000000000000000",
  recipient: "0xYOUR_WALLET",
});
```

Your token is instantly swappable against all 19 tokens via automatic multi-hop routing through WPC.

## API Methods

| Method | Description |
|---|---|
| `getTokens(filters?)` | List all PRC-20 tokens |
| `getPools(includeEmpty?)` | List all pools with live on-chain data |
| `getPool(address)` | Single pool detail with balances |
| `getQuote(params)` | Real-time swap quote (direct + multi-hop) |
| `buildSwapTx(params)` | Build unsigned swap calldata |
| `buildCreatePoolTx(params)` | Build create-pool + seed liquidity calldata |
| `buildAddLiquidityTx(params)` | Build add-liquidity calldata |
| `getExplorerUrl(txHash)` | Get PushChain explorer link |

## Network

- **Chain**: PushChain Donut Testnet
- **Chain ID**: 2442
- **RPC**: `https://evm.donut.rpc.push.org/`
- **Explorer**: `https://donut.push.network`

## Docs

Full API documentation: **https://moleswap-eight.vercel.app/docs**

## License

MIT
