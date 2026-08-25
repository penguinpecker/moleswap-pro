#!/usr/bin/env bash
# MoleSwap — put visible liquidity back into the original WETH/USDG pool.
#
# Run from ~/Projects/moleswap-pro:   bash reseed-rh-pool.sh [USDG_AMOUNT_6DP]
#
# WHY THIS EXISTS. The four RH positions were withdrawn as asked, and the replacement $1 display pools
# could not be funded in the same pass: `MolePositions.open` consults the hook TWAP, and a pool created
# moments earlier cannot answer over a 1800s window, so it reverts InsufficientObservations().
#
# That is deliberate, not a defect — see fund-display-pools.sh, and the test that pins both halves of it,
# test/attack/AttackArrakisAndNativeValue.t.sol::
#     test_holds_aPoolYoungerThanTheWindowRefusesDepositsAndThenAcceptsThem
# A new pool simply has to age past twapWindow before it will take a deposit. No swaps, just time.
#
# The original pools carry observation history, so `consult` answers and the gate passes. Leaving the pools
# page empty for that half hour is a worse outcome than re-seeding the main pair, so this restores a visible
# position there immediately.

set -euo pipefail

cd "$(dirname "$0")"
set -a; . ./.env; set +a
RPC="${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
KEY="0x${PRIVATE_KEY#0x}"

D=0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8
HOOK=0xb2c9A0af48dF8858F3765385E733Cd8776a138C4
VAULT=0x674625B6E6a2614ef6e247aF099BEA2e65e1536A
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
# slot0 is not on the PoolManager itself — it is read through the v4 StateView periphery.
STATEVIEW=0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
SPACING=60
KEYTUP="($WETH,$USDG,8388608,$SPACING,$HOOK)"
POOLID=0x9aca9d2f4bb68ef41e6928bbe080a4b076b167e2d4b7fdebf4b4fd5d6dadd029

[ "$(cast chain-id --rpc-url "$RPC")" = "4663" ] || { echo "ABORT: wrong chain"; exit 1; }

echo "pool 0x9aca9d2f (WETH/USDG, spacing 60) — the pair that held \$7.74"
echo "  consult(): $(cast call "$HOOK" 'consult(bytes32,uint32)(int24)' "$POOLID" 1800 --rpc-url "$RPC" | awk '{print $1}')  <- has history, so the gate passes"

PLAN=$(python3 - "$STATEVIEW" "$POOLID" "$SPACING" "${1:-4000000}" "$RPC" <<'PY'
import sys, subprocess, math
pm, pid, spacing, usdg_budget, rpc = sys.argv[1:6]
out = subprocess.run(["cast","call",pm,"getSlot0(bytes32)(uint160,int24,uint24,uint24)",pid,"--rpc-url",rpc],
                     capture_output=True,text=True).stdout.split("\n")
sqrtp = int(out[0].split()[0]); tick = int(out[1].split()[0])
sp = int(spacing)
# Straddle spot so the position is real two-sided liquidity, not a resting order. Width comfortably
# inside minRangeWidth 120 / maxRangeWidth 120000.
lo = ((tick // sp) - 10) * sp
hi = ((tick // sp) + 10) * sp
sa, sb = 1.0001**(lo/2), 1.0001**(hi/2)
sc = 1.0001**(tick/2)
# A range STRADDLING spot needs BOTH tokens:
#   amount0 (WETH, 18dp) = L*(1/sc - 1/sb)
#   amount1 (USDG,  6dp) = L*(sc - sa)
# Size from each budget independently and take the SMALLER L — the first attempt sized from USDG
# alone and reverted ExceedsMaxAmount because the WETH leg is what actually binds here.
weth_budget = 400000000000000          # 0.0004 WETH, inside the 0.000605 held
usdg_budget = int(usdg_budget)
L0 = int(weth_budget / (1/sc - 1/sb))
L1 = int(usdg_budget / (sc - sa))
L  = min(L0, L1)
need0 = int(L * (1/sc - 1/sb))
need1 = int(L * (sc - sa))
print(f"{tick} {lo} {hi} {L} {int(need0*1.05)} {int(need1*1.05)}")
PY
)
read -r TICK LO HI LIQ MAX0 MAX1 <<< "$PLAN"
echo "  spot tick $TICK  range [$LO, $HI]  liquidity $LIQ"
echo "  needs <= $MAX0 wei WETH and <= $MAX1 USDG (5% headroom)"

cast send "$USDG" 'approve(address,uint256)' "$VAULT" 100000000 --rpc-url "$RPC" --private-key "$KEY" --gas-limit 200000 >/dev/null
cast send "$WETH" 'approve(address,uint256)' "$VAULT" 10000000000000000 --rpc-url "$RPC" --private-key "$KEY" --gas-limit 200000 >/dev/null

DEADLINE=$(( $(date +%s) + 1800 ))
echo "  simulating open ..."
set +e
SIM=$(cast call "$VAULT" 'open((address,address,uint24,int24,address),int24,int24,uint128,uint256,uint256,uint256)(uint256)' \
  "$KEYTUP" "$LO" "$HI" "$LIQ" "$MAX0" "$MAX1" "$DEADLINE" --from "$D" --rpc-url "$RPC" 2>&1)
RC=$?
set -e
if [ $RC -ne 0 ]; then
  SEL=$(echo "$SIM" | grep -oE '0x[0-9a-f]{8}' | tail -1)
  echo "  REVERTED ${SEL:-} — $(echo "$SIM" | head -c 160)"
  exit 1
fi
cast send "$VAULT" 'open((address,address,uint24,int24,address),int24,int24,uint128,uint256,uint256,uint256)' \
  "$KEYTUP" "$LO" "$HI" "$LIQ" "$MAX0" "$MAX1" "$DEADLINE" \
  --rpc-url "$RPC" --private-key "$KEY" --gas-limit 3000000 | grep -E '^status|^gasUsed'

echo
echo "  WETH left: $(cast call "$WETH" 'balanceOf(address)(uint256)' "$D" --rpc-url "$RPC" | awk '{print $1}')"
echo "  USDG left: $(cast call "$USDG" 'balanceOf(address)(uint256)' "$D" --rpc-url "$RPC" | awk '{print $1}')"
