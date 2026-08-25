#!/usr/bin/env bash
# MoleSwap — create $1 display pools on Robinhood for the newly listed assets.
#
# Run from ~/Projects/moleswap-pro:   bash make-display-pools.sh [SYMBOL ...]
#
# WHY SINGLE-SIDED. Seeding a two-sided position would mean first BUYING each equity, which is six
# extra swaps and six extra chances to get a bad fill on a token we only want $1 of. A range placed
# entirely ABOVE the current tick takes currency0 alone — so a pool can be born and funded with
# USDG only. The liquidity is real and the pool shows real TVL; it simply sits as a resting bid
# rather than straddling spot.
#
# WHY $1 IS HONEST HERE. These pools are for VISIBILITY, not execution. The aggregator already
# routes these pairs through a deep v3-style venue (NVDA holds a flat -0.60% to $2,465), and a $1
# v4 pool will never win a split against that. It exists so the pair appears on the pools page and
# can be grown later.
#
# TWO PASSES. This script creates and whitelists the pool; it CANNOT fund it in the same run, because a
# pool younger than twapWindow (1800s) refuses deposits by design. Run fund-display-pools.sh afterwards —
# it waits for each oracle to warm up and then puts the $1 in.
#
# The initial price comes from CHAINLINK, not from a guess: a pool born at the wrong price is an
# instant arbitrage donation, and at $1 that is trivial but the habit is the point.
set -euo pipefail

cd "$(dirname "$0")"
set -a; . ./.env; set +a
RPC="${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"
KEY="0x${PRIVATE_KEY#0x}"

D=0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8
HOOK=0xb2c9A0af48dF8858F3765385E733Cd8776a138C4
VAULT=0x674625B6E6a2614ef6e247aF099BEA2e65e1536A
PM=0x8366a39CC670B4001A1121B8F6A443A643e40951
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
USDG_FEED=0x61B7e5650328764B076A108EFF5fa7282a1B9aD2
TICK_SPACING=60

CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "4663" ] || { echo "ABORT: chain $CHAIN"; exit 1; }

# macOS ships bash 3.2, which has NO associative arrays. Lookup functions instead — portable, and
# the token and its Chainlink feed stay side by side where a mismatch would be visible.
addr_of() {
  case "$1" in
    NVDA) echo 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC ;;
    SPY)  echo 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C ;;
    TSLA) echo 0x322F0929c4625eD5bAd873c95208D54E1c003b2d ;;
    AAPL) echo 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9 ;;
    MSFT) echo 0xe93237C50D904957Cf27E7B1133b510C669c2e74 ;;
    USDe) echo 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34 ;;
    *) echo "" ;;
  esac
}
feed_of() {
  case "$1" in
    NVDA) echo 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 ;;
    SPY)  echo 0x319724394D3A0e3669269846abE664Cd621f9f6A ;;
    TSLA) echo 0x4A1166a659A55625345e9515b32adECea5547C38 ;;
    AAPL) echo 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0 ;;
    MSFT) echo 0x45C3C877C15E6BA2EBB19eA114Ea508d14C1Af2E ;;
    USDe) echo 0xb9fB4e65744E4178894f7C61CF80E8a48A5f224a ;;
    *) echo "" ;;
  esac
}

if [ $# -eq 0 ]; then set -- NVDA SPY TSLA AAPL MSFT USDe; fi
USDG_BUDGET=1000000   # 1.00 USDG per pool, 6dp

cast send "$USDG" 'approve(address,uint256)' "$VAULT" 100000000 \
  --rpc-url "$RPC" --private-key "$KEY" --gas-limit 200000 >/dev/null 2>&1 || true

for SYM in "$@"; do
  A=$(addr_of "$SYM"); F=$(feed_of "$SYM")
  [ -n "$A" ] || { echo "unknown symbol $SYM"; continue; }
  echo
  echo "=== $SYM/USDG ==="

  PLAN=$(python3 - "$A" "$USDG" "$F" "$USDG_FEED" "$USDG_BUDGET" "$TICK_SPACING" <<'PY'
import sys, subprocess, math
tok, usdg, feed, usdg_feed, budget, spacing = sys.argv[1:7]
rpc = subprocess.os.environ.get("RPC") or "https://rpc.mainnet.chain.robinhood.com"
def px(f):
    o = subprocess.run(["cast","call",f,"latestAnswer()(int256)","--rpc-url",rpc],
                       capture_output=True,text=True).stdout.split()[0]
    return int(o)/1e8
p_tok, p_usdg = px(feed), px(usdg_feed)
a, b = tok.lower(), usdg.lower()
c0, c1 = (a, b) if a < b else (b, a)
d0, d1 = (18, 6) if a < b else (6, 18)
usd0 = p_tok if c0 == a else p_usdg
usd1 = p_usdg if c0 == a else p_tok
raw   = (usd0/usd1) * (10**d1)/(10**d0)          # units of c1 per unit of c0, raw
sqrtP = int(math.sqrt(raw) * (2**96))
tick  = int(math.floor(math.log(raw)/math.log(1.0001)))
sp    = int(spacing)
usdg_is_c0 = (c0 == usdg.lower())

# A range ENTIRELY ABOVE spot needs only currency0; entirely BELOW needs only currency1.
# We hold USDG, so put the range on whichever side makes USDG the required token.
if usdg_is_c0:
    lo = ((tick // sp) + 2) * sp          # above spot -> currency0 only -> USDG
    hi = lo + 3*sp
else:
    hi = ((tick // sp) - 1) * sp          # below spot -> currency1 only -> USDG
    lo = hi - 3*sp

sa, sb = 1.0001**(lo/2), 1.0001**(hi/2)
budget = int(budget)
if usdg_is_c0:                             # amount0 = L*(1/sa - 1/sb)
    L = int(budget / (1/sa - 1/sb))
else:                                      # amount1 = L*(sb - sa)
    L = int(budget / (sb - sa))
print(f"{c0} {c1} {sqrtP} {tick} {lo} {hi} {L} {1 if usdg_is_c0 else 0}")
PY
)
  read -r C0 C1 SQRTP TICK LO HI LIQ USDG_IS_C0 <<< "$PLAN"
  echo "  spot tick $TICK   range [$LO, $HI]   liquidity $LIQ   usdgIsC0=$USDG_IS_C0"
  [ "$LIQ" -gt 0 ] 2>/dev/null || { echo "  computed zero liquidity, skipping"; continue; }

  KEYTUP="($C0,$C1,8388608,$TICK_SPACING,$HOOK)"

  echo "  initialising ..."
  set +e
  SIM=$(cast call "$PM" 'initialize((address,address,uint24,int24,address),uint160)(int24)' "$KEYTUP" "$SQRTP" --from "$D" --rpc-url "$RPC" 2>&1)
  RC=$?
  set -e
  if [ $RC -ne 0 ]; then
    echo "  initialize sim: $(echo "$SIM" | grep -oE '0x[0-9a-f]{8}|already|revert' | head -1) — may already exist, continuing to whitelist"
  else
    cast send "$PM" 'initialize((address,address,uint24,int24,address),uint160)' "$KEYTUP" "$SQRTP" \
      --rpc-url "$RPC" --private-key "$KEY" --gas-limit 3000000 | grep -E '^status'
  fi

  cast send "$VAULT" 'whitelistPool((address,address,uint24,int24,address))' "$KEYTUP" \
    --rpc-url "$RPC" --private-key "$KEY" --gas-limit 1000000 2>/dev/null | grep -E '^status' || echo "  whitelist: already admitted"

  DEADLINE=$(( $(date +%s) + 1800 ))
  MAX0=$([ "$USDG_IS_C0" = "1" ] && echo $((USDG_BUDGET * 3)) || echo 0)
  MAX1=$([ "$USDG_IS_C0" = "1" ] && echo 0 || echo $((USDG_BUDGET * 3)))
  echo "  opening position (max0=$MAX0 max1=$MAX1) ..."
  set +e
  OSIM=$(cast call "$VAULT" 'open((address,address,uint24,int24,address),int24,int24,uint128,uint256,uint256,uint256)(uint256)' \
    "$KEYTUP" "$LO" "$HI" "$LIQ" "$MAX0" "$MAX1" "$DEADLINE" --from "$D" --rpc-url "$RPC" 2>&1)
  ORC=$?
  set -e
  if [ $ORC -ne 0 ]; then
    echo "  open REVERTED: $(echo "$OSIM" | grep -oE '0x[0-9a-f]{8}' | tail -1)  $(echo "$OSIM" | head -c 120)"
    continue
  fi
  cast send "$VAULT" 'open((address,address,uint24,int24,address),int24,int24,uint128,uint256,uint256,uint256)' \
    "$KEYTUP" "$LO" "$HI" "$LIQ" "$MAX0" "$MAX1" "$DEADLINE" \
    --rpc-url "$RPC" --private-key "$KEY" --gas-limit 3000000 | grep -E '^status|^gasUsed'
done

echo
echo "USDG left: $(cast call "$USDG" 'balanceOf(address)(uint256)' "$D" --rpc-url "$RPC" | awk '{print $1}')"
echo "ETH  left: $(cast balance "$D" --rpc-url "$RPC" --ether)"
