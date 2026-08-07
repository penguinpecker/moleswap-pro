# Wallet Adapters

This directory contains wallet adapters that enable fetching balances across all chain types (EVM, Solana, Bitcoin, etc.) using the AdaptedWallet pattern from Relay SDK.

## Architecture

The adapter system follows the Relay SDK's AdaptedWallet pattern:

1. **WalletAdapter Interface** (`types.ts`): Defines the contract for all wallet adapters
2. **EVM Adapter** (`evm.ts`): Implements balance fetching for EVM-compatible chains
3. **Factory** (`factory.ts`): Manages adapter registration and retrieval

## Usage

### Basic Usage

```typescript
import { getTokenBalance } from "@/lib/wallet/walletClient";

// Fetch balance - automatically uses the correct adapter based on chain VM type
const balance = await getTokenBalance(
  walletAddress,
  tokenAddress,
  chainId,
  decimals,
  vmType // Optional: "evm" | "svm" | "bvm" | "tvm" | "suivm" | "hypevm"
);
```

### Adding New Chain Support

To add support for a new chain type (e.g., Solana):

1. Create a new adapter file (e.g., `svm.ts` for Solana):

```typescript
import type { WalletAdapter } from "./types";

export class SolanaWalletAdapter implements WalletAdapter {
  vmType: "svm" = "svm";

  supportsChain(chainId: number): boolean {
    // Check if this is a Solana chain
    return chainId === 101 || chainId === 102; // Mainnet/Testnet
  }

  async getBalance(
    chainId: number,
    walletAddress: string,
    tokenAddress?: string
  ): Promise<bigint | undefined> {
    // Implement Solana balance fetching using @solana/web3.js
    // ...
  }
}
```

2. Register it in `factory.ts`:

```typescript
import { SolanaWalletAdapter } from "./svm";

const solanaAdapter = new SolanaWalletAdapter();
adapterRegistry.set("svm", solanaAdapter);
```

## How It Works

1. When `getTokenBalance` is called, it uses `getAdapterForChain()` to find the appropriate adapter
2. The adapter is selected based on the `vmType` from the Relay API chain data
3. The adapter's `getBalance()` method is called with the chain ID, wallet address, and optional token address
4. The balance is returned as a `bigint` in the smallest unit, then formatted using `formatUnits`

## Supported Chains

Currently implemented:
- ✅ **EVM**: All EVM-compatible chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, etc.)

Future support (ready for implementation):
- 🔲 **SVM**: Solana chains
- 🔲 **BVM**: Bitcoin chains
- 🔲 **TVM**: Tron chains
- 🔲 **Suivm**: Sui chains
- 🔲 **Hypevm**: Hyperliquid chains

## Integration with Relay SDK

The adapter system integrates seamlessly with Relay SDK:
- Chain `vmType` is fetched from the Relay API (`/chains` endpoint)
- The `vmType` is passed to `getTokenBalance()` to select the correct adapter
- This allows the same code to work across all supported chain types

