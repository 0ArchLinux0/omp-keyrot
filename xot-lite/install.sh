#!/usr/bin/env bash
# Install xot-lite onto this machine. Does not copy API keys or edit config.yml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="${XOT_LITE_BIN:-$HOME/.local/bin}"
XOT_HOME="${XOT_HOME:-$HOME/.local/daemon/xot}"
EXT="${XOT_LITE_EXT:-$HOME/.omp/agent/extensions}"

mkdir -p "$BIN" "$XOT_HOME/locks" "$EXT"
install -m 0755 "$ROOT/bin/xot-rotate" "$BIN/xot-rotate"
install -m 0755 "$ROOT/lib/xot-lock.py" "$XOT_HOME/xot-lock.py"
install -m 0644 "$ROOT/extensions/key-rotate-lite.ts" "$EXT/key-rotate-lite.ts"
install -m 0644 "$ROOT/extensions/advisor-manager.ts" "$EXT/advisor-manager.ts"

echo "xot-lite installed:"
echo "  $BIN/xot-rotate"
echo "  $XOT_HOME/xot-lock.py"
echo "  $EXT/key-rotate-lite.ts"
echo "  $EXT/advisor-manager.ts"
echo
echo "Next:"
echo "  1. Ensure ~/.local/daemon/xot/keys exists (one key per line)."
echo "  2. Point ~/.omp/agent/config.yml extensions at key-rotate-lite.ts + advisor-manager.ts"
echo "  3. Restart OMP sessions (extensions load at startup)."
echo "  4. In each session: /key-status"
