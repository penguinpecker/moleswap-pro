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
| `PRICE_USDG_PER_ETH` | no | *(unset — price is read live)* | **pin** the USDG/WETH price. Leave unset in production: the price is read from `PRICE_POOL`'s `slot0` every `PRICE_TTL_SECONDS`. Setting it freezes the number that decides `verified`. |
| `PRICE_POOL` | no | `0x88a8e96e…7061e` | the WETH/USDG pool the live price is read from; the orientation is checked against `token0()`/`token1()` and a non-WETH/USDG pool is refused |
| `PRICE_TTL_SECONDS` | no | `300` | how long a live price read is cached |
| `PRICE_USDG_PER_ETH_FALLBACK` | no | `1900` | used only if the very first live read fails; a failure is logged, never silent |
| `VOLUME_POOLS` | no | live MoleSwap v4 PoolId + 3 V3 addresses | pools tracked for 24h volume, **as their `mp_pools.id`** — a 42-char V3 address or a 66-char v4 PoolId. The id is also the storage key, because that is what the pools page joins on. |
| `ORACLE_POOLS` | no | *(none)* | extra v4 PoolIds to include in the oracle liveness check (the live pool + every `mole_v4` registry row are always checked) |
| `PORT` | no | `8080` | health endpoint |

`GET /health` → `{ ok, stale, lastRun, cursor, latest, newTokens, refreshed, verified, error, oracle }`.

`oracle` is the **observation-liveness signal** for every MoleSwap (mole_v4) pool — its own flag, not part
of `ok`/503 (a quiet pool is not a wedged process, and a restart cannot un-stale a ring nobody has swapped
on; alert on it separately):

```
oracle: {
  checkedAt, checkStale,      // when the last liveness pass completed; true = none recently (or ever)
  thresholdSec,               // 1800 — MIRRORS frontend/lib/mole/oracle.ts ORACLE_STALE_SECONDS
  stale,                      // any pool stale, a pass that checked no pool, or a pass too old to vouch for anything
  pools: { [poolId]: { observedAt, ageSec, stale, mid, lastTick, initialized, error } },
  crossCheck: { ourUsd, chainlinkUsd, chainlinkUpdatedAt, chainlinkAgeSec, deviationBps, warn, error },
  error
}
```

`pools[id].observedAt` is the hook ring's newest write (`poolStates(id).lastObsTimestamp`); `mid` is
`consult(id, 1800)`, the TWAP the queue crosses at (null when the ring cannot answer). `crossCheck` compares
that mid (as USDG/WETH) with Chainlink ETH/USD on RH (`0x78F3…d3A9`) and warns above 200 bps — display/alert
only, never a trade input; the reference's own age is reported (`chainlinkAgeSec` — the RH feed has been
seen 1.5–2 h old) but not thresholded. The live WETH/USDG pool and every `mp_pools` row with `venue = 'mole_v4'` are
checked; `ORACLE_POOLS` (comma-separated bytes32 ids) adds more. `npm test` runs the module's node tests.

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
