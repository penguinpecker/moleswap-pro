# Deploying MoleSwapBridgeHelper

## Why This Contract Matters

MoleSwapBridgeHelper enables **1-signature swaps for Solana/Phantom users** by combining wrap+approve+swap into a single atomic function. Without it, Solana users require N signatures (one per step) due to Solana's 1232-byte transaction buffer limit.

This matches RamenFi's `depositPRC20WithAutoSwap` pattern (selector `0x780ad827`).

## Prerequisites

- Node.js 18+
- Private key with PC (Push Chain native token) for gas

## Quick Deploy with Remix

1. Open [Remix IDE](https://remix.ethereum.org)
2. Create new file: `MoleSwapBridgeHelper.sol`
3. Copy contents from `contracts/MoleSwapBridgeHelper.sol`
4. Compile with Solidity 0.8.20+
5. Deploy tab:
   - Environment: **Injected Provider** (MetaMask)
   - Add Push Chain Donut Testnet to MetaMask:
     - RPC: `https://evm.donut.rpc.push.org/`
     - Chain ID: `42101`
     - Symbol: `PC`
   - Constructor args:
     ```
     _swapRouter: 0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037
     _feeRouter:  0x2845d303d9C367bF9ad555b0de81945E02861adD
     _wpc:        0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9
     ```
6. Deploy!

## Quick Deploy with Foundry

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash
foundryup

# Deploy
forge create contracts/MoleSwapBridgeHelper.sol:MoleSwapBridgeHelper \
  --rpc-url https://evm.donut.rpc.push.org/ \
  --private-key $PRIVATE_KEY \
  --constructor-args \
    0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037 \
    0x2845d303d9C367bF9ad555b0de81945E02861adD \
    0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9
```

## After Deployment

Update `lib/pushchain/contracts.ts`:

```typescript
MOLESWAP_BRIDGE_HELPER: "0xYOUR_DEPLOYED_ADDRESS",
```

That's it! The AMM code will automatically detect the helper and route Solana users through it for 1-sig swaps.

## Contract Addresses Reference

| Contract | Address |
|----------|---------|
| SwapRouter | 0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037 |
| FeeRouter | 0x2845d303d9C367bF9ad555b0de81945E02861adD |
| WPC | 0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9 |
| **BridgeHelper** | **DEPLOY ME** |

## Verify on Explorer

```bash
# If Push Chain explorer supports verification:
forge verify-contract $DEPLOYED_ADDRESS \
  contracts/MoleSwapBridgeHelper.sol:MoleSwapBridgeHelper \
  --chain-id 42101 \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" \
    0x5D548bB9E305AAe0d6dc6e6fdc3ab419f6aC0037 \
    0x2845d303d9C367bF9ad555b0de81945E02861adD \
    0xE17DD2E0509f99E9ee9469Cf6634048Ec5a3ADe9)
```
