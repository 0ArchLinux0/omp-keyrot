#!/usr/bin/env bash
# Install customized omp key-rotation overlay on Linux or macOS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME="${HOME:-/home/$(id -un)}"

echo "==> omp-keyrot install into $HOME"

mkdir -p "$HOME/.local/bin" "$HOME/.local/daemon/xot" "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/skills/xot"

install -m 0755 "$ROOT/bin/xot-rotate" "$HOME/.local/bin/xot-rotate"
ln -sfn "$HOME/.local/bin/xot-rotate" "$HOME/.local/bin/xot"
if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == CYGWIN* || "$(uname -s)" == MSYS* ]]; then
  cp "$ROOT/bin/xot-rotate.ps1" "$HOME/.local/bin/xot-rotate.ps1"
fi

# pi extensions (overlay; does not replace omp binary)
for f in "$ROOT/pi-extensions"/*.ts; do
  cp "$f" "$HOME/.pi/agent/extensions/$(basename "$f")"
done
cp "$ROOT/skills/xot/SKILL.md" "$HOME/.pi/agent/skills/xot/SKILL.md"

# systemd user units (Linux)
if command -v systemctl >/dev/null 2>&1 && [ -d "$HOME/.config" ]; then
  mkdir -p "$HOME/.config/systemd/user"
  cp "$ROOT/deploy/systemd/"*.service "$HOME/.config/systemd/user/" 2>/dev/null || true
  systemctl --user daemon-reload || true
fi

# Never overwrite an existing keyring or rotation state.
if [ ! -f "$HOME/.local/daemon/xot/keys" ]; then
  cp "$ROOT/xot/keys.example" "$HOME/.local/daemon/xot/keys"
  chmod 600 "$HOME/.local/daemon/xot/keys"
  echo "Put OpenRouter keys (one per line) in: $HOME/.local/daemon/xot/keys"
else
  echo "Keeping existing $HOME/.local/daemon/xot/keys (not overwritten)"
fi

# PATH
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) echo "Add to PATH: export PATH=\"$HOME/.local/bin:\$PATH\"" ;;
esac

echo "Done. Next:"
echo "  1. Fill $HOME/.local/daemon/xot/keys"
echo "  2. xot status"
echo "  3. cp llm-orchestrator/.env.example llm-orchestrator/.env && npm install && npm start"
echo "  4. Restart omp / pi so extensions reload"
