#!/usr/bin/env bash
# run_tests.sh — run the kakao-bot test suite with stdlib unittest.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
VENV_PY="/home/physics-lab/code_repo/ai-services/venv/bin/python"
cd "$ROOT"
exec "$VENV_PY" -m unittest "$HERE/test_chat_engine.py" -v
