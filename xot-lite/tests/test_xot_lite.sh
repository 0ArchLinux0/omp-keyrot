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
c4=$("$ROT" classify "429")
c5=$("$ROT" classify "Retry failed after 1 attempts: Provider requested 13265929ms wait, exceeds retry.maxDelayMs (300000ms). Original error: 429 Rate limit exceeded: free-models-per-day. Add 10 credits")
c6=$("$ROT" classify "Add 10 credits to unlock 1000 free model requests per day")
c7=$("$ROT" classify "HTTP 429")
c8=$("$ROT" classify "some unrelated timeout")
check classify-high '[ "$c1" = daily ]'
check classify-shared '[ "$c2" = shared ]'
check classify-add10 '[ "$c3" = daily ]'
check classify-empty-429 '[ "$c4" = daily ]'
check classify-maxdelay-composite '[ "$c5" = daily ]'
check classify-add10-only '[ "$c6" = daily ]'
check classify-http-429 '[ "$c7" = daily ]'
check classify-other '[ "$c8" = other ]'

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

# /key-rotate on B must not move A
ia=$(python3 "$LOCK" get sess-a)
ib=$(python3 "$LOCK" get sess-b)
bump=$("$ROT" bump sess-b "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
ia_after=$(python3 "$LOCK" get sess-a)
ib_after=$(python3 "$LOCK" get sess-b)
check bump-changes-b '[ "$ib_after" != "$ib" ]'
check bump-leaves-a '[ "$ia_after" = "$ia" ]'
check bump-key-changed '[ "$bump" != "$kb" ]'

# /key N on a free key: B moves, A stays
f=$("$ROT" set 5 sess-b "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
k5=$(sed -n '5p' "$TMP/keys")
check force-free-key5 '[ "$f" = "$k5" ]'
check force-free-leaves-a '[ "$(python3 "$LOCK" get sess-a)" = "$ia" ]'

# /key N on A's key: refuse, A still owns it, B still on KEY_05
set +e
refuse_err=$("$ROT" set $((ia + 1)) sess-b "$PID" 2>&1 >/dev/null)
refuse_rc=$?
set -e
check refuse-locked '[ "$refuse_rc" -ne 0 ]'
check refuse-msg 'echo "$refuse_err" | grep -qi "locked by session"'
check refuse-a-keeps '[ "$(python3 "$LOCK" get sess-a)" = "$ia" ]'
check refuse-b-keeps-5 '[ "$(python3 "$LOCK" get sess-b)" = "4" ]'

# explicit steal
set +e
steal_out=$("$ROT" set $((ia + 1)) sess-b "$PID" --steal 2>/dev/null)
steal_rc=$?
set -e
check steal-ok '[ "$steal_rc" -eq 0 ]'
check steal-owner-b '[ "$(python3 "$LOCK" owner "$ia")" = "sess-b" ]'

# pick must not emit a cooled key
fp=$(head -1 "$TMP/keys" | sha256sum | awk '{print $1}' | cut -c1-16)
"$ROT" cool "$fp" "$(( $(date +%s) + 3600 ))" >/dev/null
set +e
pk=$("$ROT" pick 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
pick_cool_rc=$?
set -e
k1=$(head -1 "$TMP/keys")
if [ "$pick_cool_rc" -eq 0 ]; then
  check pick-skips-cool '[ "$pk" != "$k1" ] && [ -n "$pk" ]'
else
  check pick-fails-rather-than-cooled 'true'
fi

# pick must not drop existing session locks
ib_before=$(python3 "$LOCK" get sess-b || echo -1)
set +e
"$ROT" pick >/dev/null 2>&1
set -e
ib_after=$(python3 "$LOCK" get sess-b || echo -1)
check pick-leaves-locks '[ "$ib_before" = "$ib_after" ]'

python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ["XOT_HOME"]) / "locks" / "registry.json"
data = json.loads(p.read_text())
data.setdefault("sessions", {})["dead-sess"] = {
    "key_idx": 2, "pid": 999999, "acquired_at": 0, "heartbeat": 0, "label": "KEY_03"
}
p.write_text(json.dumps(data, indent=2) + "\n")
PY
python3 "$LOCK" prune
st=$(python3 "$LOCK" status)
check prune-dead '! echo "$st" | grep -q dead-sess'

lk=$("$ROT" locks)
check locks-has-sess 'echo "$lk" | grep -q sess-b'

# Cooling this session's key must skip it on next acquire (429 rotate path)
"$ROT" acquire sess-d "$PID" >/dev/null 2>&1 || true
kd=$("$ROT" acquire sess-d "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
fpd=$(printf '%s' "$kd" | sha256sum | awk '{print $1}' | cut -c1-16)
"$ROT" cool "$fpd" "$(( $(date +%s) + 3600 ))" >/dev/null
kd2=$("$ROT" acquire sess-d "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p")
check acquire-skips-own-cool '[ -n "$kd2" ] && [ "$kd2" != "$kd" ]'
id_d=$(python3 "$LOCK" get sess-d)
id_a=$(python3 "$LOCK" get sess-a || echo -1)
check acquire-skip-cool-leaves-a '[ "$id_a" != "$id_d" ]'

# bump after cool must not steal another live session
ia_pre=$(python3 "$LOCK" get sess-a || echo -1)
ib_pre=$(python3 "$LOCK" get sess-b || echo -1)
bump_d=$("$ROT" bump sess-d "$PID" 2>/dev/null | grep OPENROUTER | sed -n "s/.*'\(.*\)'/\1/p" || true)
ia_post=$(python3 "$LOCK" get sess-a || echo -1)
ib_post=$(python3 "$LOCK" get sess-b || echo -1)
check bump-after-cool-leaves-a '[ "$ia_pre" = "$ia_post" ]'
check bump-after-cool-leaves-b '[ "$ib_pre" = "$ib_post" ]'
check bump-after-cool-changed '[ -z "$bump_d" ] || [ "$bump_d" != "$kd" ]'

"$ROT" release sess-a >/dev/null
"$ROT" release sess-b >/dev/null
"$ROT" release sess-c >/dev/null
"$ROT" release sess-d >/dev/null 2>/dev/null || true

echo "FAIL=$fail"
exit "$fail"
