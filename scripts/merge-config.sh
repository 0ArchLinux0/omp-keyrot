#!/usr/bin/env bash
# Ensure keyrot extensions are registered in ~/.pi/agent/config.yml
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME="${HOME:-/home/$(id -un)}"
CFG="$HOME/.pi/agent/config.yml"
FRAG="$ROOT/pi-agent/config.fragment.yml"
TEMPLATE="$ROOT/pi-agent/config.example.yml"

mkdir -p "$(dirname "$CFG")"

if [ ! -f "$CFG" ]; then
  sed "s|@HOME@|$HOME|g" "$TEMPLATE" > "$CFG"
  echo "Created $CFG from config.example.yml"
  exit 0
fi

if [ ! -f "$FRAG" ]; then
  exit 0
fi

# Remove legacy duplicate extensions block from older install.sh runs
if grep -q '# omp-keyrot extensions (added by install.sh)' "$CFG" 2>/dev/null; then
  awk '
    /^# omp-keyrot extensions \(added by install\.sh\)/ { skip=1; next }
    skip && /^extensions:/ { next }
    skip && /^  - / { next }
    skip && /^[^ ]/ { skip=0 }
    { print }
  ' "$CFG" > "$CFG.tmp" && mv "$CFG.tmp" "$CFG"
fi

added=0
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${line// }" ]] && continue
  [[ "$line" =~ ^extensions: ]] && continue
  path="${line#- }"
  path="${path//@HOME@/$HOME}"
  if grep -Fq "$path" "$CFG" 2>/dev/null; then
    continue
  fi
  esc="${path//\\/\\\\}"
  esc="${esc//|/\\|}"
  sed -i "0,/^tools:/{s|^tools:|  - ${esc}\n&|}" "$CFG"
  added=1
  echo "Added extension: $path"
done < <(tac "$FRAG")

if [ "$added" -eq 1 ]; then
  echo "Merged extension entries into $CFG"
else
  echo "Config already has omp-keyrot extensions: $CFG"
fi
