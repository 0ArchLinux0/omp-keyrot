#!/usr/bin/env bash
# Install xot-lite onto this machine. Does not copy API keys or edit config.yml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN="${XOT_LITE_BIN:-$HOME/.local/bin}"
XOT_HOME="${XOT_HOME:-$HOME/.local/daemon/xot}"
EXT="${XOT_LITE_EXT:-$HOME/.omp/agent/extensions}"

DOCS="${XOT_LITE_DOCS:-$HOME/.local/share/docs}"

mkdir -p "$BIN" "$XOT_HOME/locks" "$EXT" "$DOCS"
install -m 0755 "$ROOT/bin/xot-rotate" "$BIN/xot-rotate"
install -m 0755 "$ROOT/lib/xot-lock.py" "$XOT_HOME/xot-lock.py"
install -m 0644 "$ROOT/extensions/key-rotate-lite.ts" "$EXT/key-rotate-lite.ts"
install -m 0644 "$ROOT/extensions/advisor-manager.ts" "$EXT/advisor-manager.ts"
install -m 0644 "$ROOT/docs/USAGE.md" "$DOCS/xot-rotation.md"
install -m 0644 "$ROOT/docs/INCIDENT-2026-09-13.md" "$DOCS/xot-incident-2026-09-13.md"
install -m 0644 "$ROOT/README.md" "$DOCS/xot-lite-README.md"
install -m 0644 "$ROOT/docs/RESTORE.md" "$DOCS/xot-lite-RESTORE.md"
install -m 0644 "$ROOT/docs/CHANGELOG.md" "$DOCS/xot-lite-CHANGELOG.md"
install -m 0644 "$ROOT/docs/ROADMAP.md" "$DOCS/xot-lite-ROADMAP.md"
echo "xot-lite installed:"
echo "  $BIN/xot-rotate"
echo "  $XOT_HOME/xot-lock.py"
echo "  $EXT/key-rotate-lite.ts"
echo "  $EXT/advisor-manager.ts"
echo "  $DOCS/xot-lite-RESTORE.md"
echo
echo "Next:"
echo "  1. Ensure ~/.local/daemon/xot/keys exists (one key per line)."
echo "  2. Point ~/.omp/agent/config.yml extensions at key-rotate-lite.ts + advisor-manager.ts"
echo "  3. Restart OMP sessions (extensions load at startup)."
echo "  4. In each session: /key-status"
echo "  5. If this tree is broken later: $HOME/.local/share/docs/xot-lite-RESTORE.md"
