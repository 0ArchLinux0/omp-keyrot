#!/usr/bin/env bash
# Isolated xot-lite tests — fake keys, no OpenRouter network.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROT="$ROOT/bin/xot-rotate"
LOCK="$ROOT/lib/xot-lock.py"
TMP=$(mktemp -d)
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

export XOT_HOME="$TMP"
export XOT_KEY_FILE="$TMP/keys"
export XOT_STATE_FILE="$TMP/state"
export XOT_LOCK_PY="$LOCK"
export PRIMARY_IDX=0
mkdir -p "$TMP/locks"

for i in 1 2 3 4 5; do
  printf 'sk-or-v1-fake%02dxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx%04d\n' "$i" "$i" >> "$TMP/keys"
done

fail=0
check() {
  local name="$1"
  if eval "$2"; then echo "PASS $name"; else echo "FAIL $name"; fail=1; fi
}

c1=$("$ROT" classify "429 Rate limit exceeded: free-models-per-day-high-balance")
c2=$("$ROT" classify "upstream provider shared pool")
c3=$("$ROT" classify "free-models-per-day. Add 10 credits")
check classify-high '[ "$c1" = daily ]'
check classify-shared '[ "$c2" = shared ]'
check classify-add10 '[ "$c3" = daily ]'

out=$("$ROT" set 3 2>/dev/null)
suf=$(echo "$out" | grep OPENROUTER_API_KEY | sed -n "s/.*'\(.*\)'/\1/p" | tail -c 5 | tr -d "'")
check set3-suffix '[ "$suf" = "0003" ]'

PID=$$
ka=$("$ROT" acquire sess-a "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
kb=$("$ROT" acquire sess-b "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
kc=$("$ROT" acquire sess-c "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
check acquire-distinct '[ "$ka" != "$kb" ] && [ "$kb" != "$kc" ] && [ "$ka" != "$kc" ]'
ka2=$("$ROT" acquire sess-a "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
check acquire-sticky '[ "$ka" = "$ka2" ]'

fp=$(head -1 "$TMP/keys" | sha256sum | awk '{print $1}' | cut -c1-16)
"$ROT" cool "$fp" "$(( $(date +%s) + 3600 ))" >/dev/null
pk=$("$ROT" pick 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
k1=$(head -1 "$TMP/keys")
check pick-skips-cool '[ "$pk" != "$k1" ]'

bump=$("$ROT" bump sess-a "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
check bump-changes '[ "$bump" != "$ka" ]'

f=$("$ROT" set 5 sess-b "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
k5=$(sed -n '5p' "$TMP/keys")
check force-key5 '[ "$f" = "$k5" ]'

python3 "$LOCK" force dead-sess 0 999999 >/dev/null || true
python3 "$LOCK" prune
st=$(python3 "$LOCK" status)
check prune-dead '! echo "$st" | grep -q dead-sess'

lk=$("$ROT" locks)
check locks-has-sess 'echo "$lk" | grep -q sess-a'

"$ROT" release sess-a >/dev/null
"$ROT" release sess-b >/dev/null
"$ROT" release sess-c >/dev/null

echo "FAIL=$fail"
exit "$fail"
