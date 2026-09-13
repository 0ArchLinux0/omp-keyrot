#!/usr/bin/env bash
# Restore xot-lite from the local snapshot onto this machine.
set -euo pipefail
VER="${1:-}"
if [[ -z "$VER" ]]; then
  if [[ -f "$(dirname "$0")/../VERSION" ]]; then
    VER="$(tr -d ' \n' < "$(dirname "$0")/../VERSION")"
  else
    VER="1.0.2-20260914"
  fi
fi
SNAP="${XOT_LITE_SNAP:-$HOME/.local/share/snapshots}/xot-lite-${VER}.tar.gz"
SUM="${SNAP%.tar.gz}.sha256"
if [[ ! -f "$SNAP" ]]; then
  echo "snapshot not found: $SNAP" >&2
  echo "usage: $0 [VERSION]" >&2
  exit 1
fi
if [[ -f "$SUM" ]]; then
  sha256sum -c "$SUM"
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$SNAP" -C "$tmp"
if [[ ! -x "$tmp/xot-lite/install.sh" ]]; then
  echo "tarball missing install.sh" >&2
  exit 1
fi
"$tmp/xot-lite/install.sh"
echo
echo "Restored $VER. Next:"
echo "  1. Confirm ~/.local/daemon/xot/keys still exists (not in tarball)."
echo "  2. Confirm config.yml loads key-rotate-lite.ts (not xot.ts)."
echo "  3. Restart every OMP session."
echo "  4. /key-status"
