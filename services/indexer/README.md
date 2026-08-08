# MoleSwap Indexer (Railway)

A small always-on service that keeps the aggregator's pool registry current. Every `REFRESH_MINUTES`
it enumerates PancakeSwap V3 `PoolCreated` events on Robinhood Chain, measures each pool's in-range
liquidity, and upserts the live ones into Supabase `mp_pools` (marking drained pools inactive). The swap
frontend reads that registry to know which pools exist; the executor's on-chain `minAmountOut` remains the
only safety guarantee, so a stale registry can at worst miss a route, never mis-settle a swap.

## Deploy on Railway
1. New project → Deploy from the `services/indexer` directory of this repo (set the root directory).
2. Set environment variables (below). Railway auto-detects Node via nixpacks and runs `npm start`.

## Environment
| var | purpose |
|---|---|
| `RH_RPC_URL` | Robinhood Chain RPC (default: the public endpoint) |
| `SUPABASE_URL` | `https://pgraqmnsabnatyzmlycx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** — write access to `mp_pools`; never commit it |
| `REFRESH_MINUTES` | refresh cadence (default 10) |
| `PORT` | health-check port (Railway injects this) |
