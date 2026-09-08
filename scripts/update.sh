#!/usr/bin/env bash
# Pull latest overlay and reinstall (Linux/macOS). Secrets are never overwritten.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -d .git ]; then
  git pull --ff-only
else
  echo "Not a git clone. Re-clone: git clone https://github.com/0ArchLinux0/omp-keyrot.git"
  exit 1
fi

exec bash "$ROOT/scripts/install.sh"
