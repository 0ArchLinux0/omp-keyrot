#!/usr/bin/env bash
# Build a secret-free tarball + copy docs next to it for offline restore.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VER="$(tr -d ' \n' < "$ROOT/VERSION")"
SNAP_DIR="${XOT_LITE_SNAP:-$HOME/.local/share/snapshots}"
DOC_DIR="${XOT_LITE_DOCS:-$HOME/.local/share/docs}"
OUT="$SNAP_DIR/xot-lite-${VER}.tar.gz"

mkdir -p "$SNAP_DIR" "$DOC_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/xot-lite"
# copy tree without keys/state/locks/caches
tar -C "$ROOT" --exclude keys --exclude state --exclude locks \
  --exclude __pycache__ --exclude '*.pyc' --exclude '.git' \
  -cf - . | tar -C "$tmp/xot-lite" -xf -

{
  echo "name=xot-lite"
  echo "version=$VER"
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(hostname)"
  echo "git=$(git -C "$ROOT/.." rev-parse --short HEAD 2>/dev/null || echo unknown)"
} > "$tmp/xot-lite/SNAPSHOT.txt"

tar -C "$tmp" -czf "$OUT" xot-lite
sha=$(sha256sum "$OUT" | awk '{print $1}')
echo "$sha  $OUT" | tee "$SNAP_DIR/xot-lite-${VER}.sha256"

install -m 0644 "$ROOT/docs/USAGE.md" "$DOC_DIR/xot-rotation.md"
install -m 0644 "$ROOT/docs/INCIDENT-2026-09-13.md" "$DOC_DIR/xot-incident-2026-09-13.md"
install -m 0644 "$ROOT/README.md" "$DOC_DIR/xot-lite-README.md"
install -m 0644 "$ROOT/docs/RESTORE.md" "$DOC_DIR/xot-lite-RESTORE.md"
install -m 0644 "$ROOT/docs/CHANGELOG.md" "$DOC_DIR/xot-lite-CHANGELOG.md"
install -m 0644 "$ROOT/docs/ROADMAP.md" "$DOC_DIR/xot-lite-ROADMAP.md"

echo "snapshot: $OUT"
echo "sha256:   $sha"
echo "docs:     $DOC_DIR/xot-lite-RESTORE.md"
