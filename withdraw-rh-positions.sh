#!/usr/bin/env bash
# MoleSwap — withdraw the four open RH liquidity positions.
#
# Run from ~/Projects/moleswap-pro:   bash withdraw-rh-positions.sh
#
# Positions #3, #4, #7 (WETH/USDG) and #11 (CASHCAT/WETH), all owned by the deployer, holding
# ~$13.06 between them. Withdrawing frees that capital to seed $1 display pools across the newly
# listed assets.
#
# Each withdrawal is SIMULATED before it is sent: `withdrawAll` moves real funds through the v4
# PoolManager, and a revert observed for free is worth more than a revert paid for.
set -euo pipefail

cd "$(dirname "$0")"
set -a; . ~/Projects/moleswap-pro/.env; set +a
RPC="${RH_RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"

KEY="0x${PRIVATE_KEY#0x}"
D=0xe4563270a72a9418f97dbb631E1696eDCC8bC8C8
MP=0x674625B6E6a2614ef6e247aF099BEA2e65e1536A
WETH=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
USDG=0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168

CHAIN=$(cast chain-id --rpc-url "$RPC")
[ "$CHAIN" = "4663" ] || { echo "ABORT: chain $CHAIN, expected 4663"; exit 1; }

bal(){ cast call "$1" 'balanceOf(address)(uint256)' "$D" --rpc-url "$RPC" | awk '{print $1}'; }

echo "before:"
echo "  ETH  $(cast balance $D --rpc-url "$RPC" --ether)"
echo "  WETH $(bal $WETH)"
echo "  USDG $(bal $USDG)"

for id in 3 4 7 11; do
  echo
  echo "=== position #$id ==="
  RAW=$(cast call "$MP" 'getPosition(uint256)((address,bytes32,int24,int24,uint128,uint64,uint64))' "$id" --rpc-url "$RPC")
  LIQ=$(echo "$RAW" | awk -F', ' '{print $5}' | awk '{print $1}')
  if [ "${LIQ:-0}" = "0" ]; then echo "  already empty, skipping"; continue; fi
  echo "  liquidity $LIQ"

  set +e
  SIM=$(cast call "$MP" 'withdrawAll(uint256)' "$id" --from "$D" --rpc-url "$RPC" 2>&1)
  RC=$?
  set -e
  if [ $RC -ne 0 ]; then
    SEL=$(echo "$SIM" | grep -oE '0x[0-9a-f]{8}' | tail -1)
    echo "  SIMULATION REVERTED ${SEL:-}: $(echo "$SIM" | head -c 140)"
    echo "  skipping this one rather than paying for a known failure"
    continue
  fi
  cast send "$MP" 'withdrawAll(uint256)' "$id" \
    --rpc-url "$RPC" --private-key "$KEY" --gas-limit 3000000 | grep -E '^status|^gasUsed'
done

echo
echo "after:"
echo "  ETH  $(cast balance $D --rpc-url "$RPC" --ether)"
echo "  WETH $(bal $WETH)"
echo "  USDG $(bal $USDG)"
echo "  CASHCAT $(bal 0x020bfC650A365f8BB26819deAAbF3E21291018b4)"
echo
echo "remaining open positions:"
for id in $(seq 1 12); do
  RAW=$(cast call "$MP" 'getPosition(uint256)((address,bytes32,int24,int24,uint128,uint64,uint64))' "$id" --rpc-url "$RPC" 2>/dev/null)
  L=$(echo "$RAW" | awk -F', ' '{print $5}' | awk '{print $1}')
  [ "${L:-0}" != "0" ] && echo "  #$id still holds $L"
done
echo "  (none listed above = all closed)"
