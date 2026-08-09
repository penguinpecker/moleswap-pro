# MoleSwap indexer

Always-on service that keeps the Robinhood Chain token list and pool registry fresh for the aggregator.
It runs **incrementally every `REFRESH_SECONDS` (default 60)**:

1. **Discover** — reads `PoolCreated` logs from a persisted block cursor forward across every executable
   V3 factory, upserts new pools into `mp_pools`, and registers brand-new tokens (symbol / name /
   decimals) into `mp_tokens`.
2. **Refresh liquidity** — re-measures the hub-pool (WETH/USDG) reserve behind every **verified** token
   each cycle, plus a rotating slice of the unverified long tail, and writes `liquidity` / `verified`
   back. This is what keeps the verified list current: a token that loses liquidity de-verifies, one that
   gains it verifies.

A full 258k-pool rescan can't run in 60s, so the cursor makes discovery `O(new blocks)` and the refresh
is bounded per cycle. All writes go through secret-gated `SECURITY DEFINER` RPCs — no service-role key
lives on the box. The on-chain `minAmountOut` in the executor stays the only fund-safety guarantee, so a
stale registry can at worst miss a route, never mis-settle.

## Environment

| var | required | default | notes |
|-----|----------|---------|-------|
| `SUPABASE_URL` | yes | — | project URL |
| `SUPABASE_ANON_KEY` | yes | — | anon key (writes go through the secret-gated RPCs) |
| `INDEXER_SECRET` | yes | — | `mp_private.indexer_config.write_secret` |
| `RH_RPC_URL` | recommended | public RPC | **use the Alchemy RH endpoint** — the public RPC rate-limits the per-cycle balanceOf reads |
| `REFRESH_SECONDS` | no | `60` | cycle interval |
| `MAX_BLOCKS_PER_CYCLE` | no | `300000` | caps discovery work per cycle; a backlog drains over several cycles |
| `UNVERIFIED_REFRESH_BATCH` | no | `4000` | rotating unverified tokens re-measured per cycle |
| `PRICE_USDG_PER_ETH` | no | `1900` | for converting USDG reserves to WETH-equivalent |
| `PORT` | no | `8080` | health endpoint |

`GET /health` → `{ ok, lastRun, cursor, latest, newTokens, refreshed, verified, error }`.

## Deploy (Railway)

The service already exists as **moleswap-indexer**. To ship this version:

```bash
# from services/indexer, with the Railway CLI linked to the moleswap-indexer service:
railway variables set REFRESH_SECONDS=60
railway variables set RH_RPC_URL=<alchemy-rh-endpoint>   # if not already set
railway up
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `INDEXER_SECRET` should already be set from the previous deploy.

## Run locally

```bash
SUPABASE_URL=… SUPABASE_ANON_KEY=… INDEXER_SECRET=… RH_RPC_URL=… node src/index.mjs
```
