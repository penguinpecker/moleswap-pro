#!/usr/bin/env bash
# MoleSwap — put $1 into each display pool once its oracle has warmed up.
#
# Run from ~/Projects/moleswap-pro:   bash fund-display-pools.sh [SYMBOL ...]
#
# WHY A SECOND PASS. `MolePositions.open` consults the hook's TWAP before accepting a deposit, and a pool
# initialised moments ago cannot answer over a 1800s window — it reverts InsufficientObservations()
# (0xaad0df1d). This is NOT a bug. It is deliberate, and it is pinned by
# test/attack/AttackArrakisAndNativeValue.t.sol:
#     test_holds_aPoolYoungerThanTheWindowRefusesDepositsAndThenAcceptsThem
# which asserts the refusal AND that the same deposit succeeds after `_advance(WINDOW + 1)`. No swaps are
# needed; only time. So a new pool is created in one pass and funded in another, thirty minutes later.
#
# (An earlier read of this called it a contract bug and drafted a fix that made the TWAP bound swallow
# every oracle failure. That would have made the guard fail OPEN against a dead or manipulated hook, and
# it turned 14 existing tests red. The bound is meant to fail CLOSED. Nothing in the contract changed.)
#
# WHY SPOT COMES FROM THE POOL. The range is placed relative to the pool's OWN tick, read from StateView —
# not from Chainlink. The pool's price was fixed by Chainlink at initialize; the feed has moved since, and
# a range computed from the feed can land on the wrong side of pool spot and demand a token we do not hold.
set -euo pipefail

cd "$(dirname "$0")"
set -a; . ./.env; set +a
RPC="${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
KEY="0x${PRIVATE_KEY#0x}"

D=0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8
HOOK=0xb2c9A0af48dF8858F3765385E733Cd8776a138C4
VAULT=0x674625B6E6a2614ef6e247aF099BEA2e65e1536A
STATEVIEW=0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
SP=60
WINDOW=1800
BUDGET=1000000          # $1.00, USDG is 6dp

addr_of() { case "$1" in
  NVDA) echo 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC ;; SPY) echo 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C ;;
  TSLA) echo 0x322F0929c4625eD5bAd873c95208D54E1c003b2d ;; AAPL) echo 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 ;;
  MSFT) echo 0xe93237C50D904957Cf27E7B1133b510C669c2e74 ;; USDe) echo 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34 ;;
  *) echo "" ;; esac; }

[ "$(cast chain-id --rpc-url "$RPC")" = "4663" ] || { echo "ABORT: wrong chain"; exit 1; }
[ $# -eq 0 ] && set -- SPY TSLA AAPL MSFT USDe

cast send "$USDG" 'approve(address,uint256)' "$VAULT" 100000000 \
  --rpc-url "$RPC" --private-key "$KEY" --gas-limit 200000 >/dev/null 2>&1 || true

PENDING="$*"
for round in $(seq 1 40); do
  [ -z "$PENDING" ] && break
  STILL=""
  for SYM in $PENDING; do
    A=$(addr_of "$SYM"); [ -n "$A" ] || continue
    al=$(echo "$A" | tr 'A-Z' 'a-z'); ul=$(echo "$USDG" | tr 'A-Z' 'a-z')
    if [ "$al" \< "$ul" ]; then C0=$A; C1=$USDG; USDG_C0=0; else C0=$USDG; C1=$A; USDG_C0=1; fi
    KT="($C0,$C1,8388608,$SP,$HOOK)"
    PID=$(cast keccak "$(cast abi-encode 'f((address,address,uint24,int24,address))' "$KT")")

    if ! cast call "$HOOK" 'consult(bytes32,uint32)(int24)' "$PID" "$WINDOW" --rpc-url "$RPC" >/dev/null 2>&1; then
      STILL="$STILL $SYM"; continue
    fi

    PLAN=$(python3 - "$STATEVIEW" "$PID" "$SP" "$BUDGET" "$USDG_C0" "$RPC" <<'PY'
import sys, subprocess
sv, pid, sp, budget, usdg_c0, rpc = sys.argv[1:7]
out = subprocess.run(["cast","call",sv,"getSlot0(bytes32)(uint160,int24,uint24,uint24)",pid,"--rpc-url",rpc],
                     capture_output=True,text=True).stdout.split("\n")
tick = int(out[1].split()[0]); sp = int(sp); budget = int(budget)
# Range entirely ABOVE spot consumes currency0 only; entirely BELOW consumes currency1 only.
# Put it on whichever side makes USDG — the only token we hold — the one that is required.
if usdg_c0 == "1":
    lo = ((tick // sp) + 2) * sp; hi = lo + 3*sp
else:
    hi = ((tick // sp) - 1) * sp; lo = hi - 3*sp
sa, sb = 1.0001**(lo/2), 1.0001**(hi/2)
L = int(budget / ((1/sa - 1/sb) if usdg_c0 == "1" else (sb - sa)))
print(f"{tick} {lo} {hi} {L}")
PY
)
    read -r TICK LO HI LIQ <<< "$PLAN"
    [ "${LIQ:-0}" -gt 0 ] 2>/dev/null || { echo "$SYM: zero liquidity computed, skipping"; continue; }
    MAX0=$([ "$USDG_C0" = "1" ] && echo $((BUDGET*3)) || echo 0)
    MAX1=$([ "$USDG_C0" = "1" ] && echo 0 || echo $((BUDGET*3)))
    DL=$(( $(date +%s) + 1800 ))

    set +e
    SIM=$(cast call "$VAULT" 'open((address,address,uint24,int24,address),int24,int24,uint128,uint256,uint256,uint256)(uint256)' \
      "$KT" "$LO" "$HI" "$LIQ" "$MAX0" "$MAX1" "$DL" --from "$D" --rpc-url "$RPC" 2>&1); RC=$?
    set -e
    if [ $RC -ne 0 ]; then
      echo "$SYM: open sim reverted $(echo "$SIM" | grep -oE '0x[0-9a-f]{8}' | tail -1)"
      STILL="$STILL $SYM"; continue
    fi
    ST=$(cast send "$VAULT" 'open((address,address,uint24,int24,address),int24,int24,uint128,uint256,uint256,uint256)' \
      "$KT" "$LO" "$HI" "$LIQ" "$MAX0" "$MAX1" "$DL" \
      --rpc-url "$RPC" --private-key "$KEY" --gas-limit 3000000 | awk '/^status/{print $2}')
    echo "$SYM: tick $TICK range [$LO,$HI] L=$LIQ -> status $ST"
    [ "$ST" = "1" ] || STILL="$STILL $SYM"
  done
  PENDING=$(echo "$STILL" | xargs || true)
  [ -z "$PENDING" ] && break
  echo "round $round: still warming ->$PENDING  (sleeping 120s)"
  sleep 120
done

echo
echo "unfunded: ${PENDING:-none}"
echo "USDG left: $(cast call "$USDG" 'balanceOf(address)(uint256)' "$D" --rpc-url "$RPC" | awk '{print $1}')"
echo "ETH  left: $(cast balance "$D" --rpc-url "$RPC" --ether)"
