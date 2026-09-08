#!/usr/bin/env bash
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
if [ -f "$FRAG" ]; then
  missing=0
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "${line// }" ]] && continue
    path="${line#- }"
    path="${path//@HOME@/$HOME}"
    if ! grep -Fq "$path" "$CFG" 2>/dev/null; then
      missing=1
      break
    fi
  done < <(grep -E '^\s*-\s' "$FRAG" || true)
  if [ "$missing" -eq 1 ]; then
    echo "" >> "$CFG"
    echo "# omp-keyrot extensions (added by install.sh)" >> "$CFG"
    sed "s|@HOME@|$HOME|g" "$FRAG" >> "$CFG"
    echo "Merged extension entries into $CFG"
  else
    echo "Config already has omp-keyrot extensions: $CFG"
  fi
fi
