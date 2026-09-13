# xot-lite

Portable OpenRouter **`:free` key rotator** for OMP/pi-coding-agent.

- **15 independent accounts** (not one shared balance)
- **KEY_01 first** ($10+ credits → 1000 `:free`/day); backups ~50/day
- **One key per OMP session** (`flock` + JSON registry); `/key N` and `/key-rotate` do not move other sessions
- **`/key N` refuses** if that key is locked (optional `/key N steal`)
- **No paid provider**, no legacy `xot.ts` stack

This module is the 2026-09-13 incident fix: KEY_01 was actually 0/1000, `/uncool` did not refill quota, and concurrent sessions burned the same key.

## GitHub

| | |
|---|---|
| Branch | https://github.com/0ArchLinux0/omp-keyrot/tree/xot-lite-session-locks |
| Issue | https://github.com/0ArchLinux0/omp-keyrot/issues/1 |
| PR | https://github.com/0ArchLinux0/omp-keyrot/pull/2 |
| Release | https://github.com/0ArchLinux0/omp-keyrot/releases/tag/xot-lite-1.0.2-20260914 |
| Notion incident | https://www.notion.so/3da7b981c5148105815cec39ddc802bf |
| Notion usage | https://www.notion.so/3da7b981c51481e4bc95f0e60bb5e39d |

## Layout

```
xot-lite/
  bin/xot-rotate              # CLI
  lib/xot-lock.py             # session lock registry
  extensions/key-rotate-lite.ts
  extensions/advisor-manager.ts
  docs/USAGE.md
  docs/INCIDENT-2026-09-13.md
  tests/test_xot_lite.sh      # isolated, no live API
  tests/test_xot_lock.py
  tests/test_classify.py      # 429 empty-body + maxDelayMs → daily
  install.sh
  VERSION
```

**Does not vendor API keys.** Keys stay on the machine: `~/.local/daemon/xot/keys`.

## Install

```bash
./xot-lite/install.sh
# then restart OMP sessions
```

`install.sh` copies:

| Source | Destination |
|--------|-------------|
| `bin/xot-rotate` | `~/.local/bin/xot-rotate` |
| `lib/xot-lock.py` | `~/.local/daemon/xot/xot-lock.py` |
| `extensions/*.ts` | `~/.omp/agent/extensions/` |

It does **not** overwrite `keys` or `config.yml`. Wire extensions in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/agent/extensions/advisor-manager.ts
  - ~/.omp/agent/extensions/key-rotate-lite.ts
modelRoles:
  advisor: openrouter-free-auto/best-reason
# do not load xot.ts / auto-rotate.ts / openrouter-paid
```

## Tests

```bash
./xot-lite/tests/test_xot_lite.sh
python3 -m unittest xot-lite/tests/test_xot_lock.py
python3 -m unittest xot-lite/tests/test_classify.py
```

No live OpenRouter calls (does not burn quota).

## Snapshot

```bash
VER=$(cat xot-lite/VERSION)
OUT="${HOME}/.local/share/snapshots/xot-lite-${VER}.tar.gz"
mkdir -p "$(dirname "$OUT")"
tar -czf "$OUT" \
  --exclude keys --exclude state --exclude locks \
  --exclude __pycache__ --exclude '*.pyc' \
  -C "$(dirname xot-lite)" xot-lite
sha256sum "$OUT"
```

Current snapshot (no secrets): `~/.local/share/snapshots/xot-lite-1.0.2-20260914.tar.gz`

Restore on another machine:

```bash
tar -xzf xot-lite-1.0.2-20260914.tar.gz
cd xot-lite && ./install.sh
# put keys at ~/.local/daemon/xot/keys (never in the tarball)
# then restart OMP
```

## Runtime state (machine-local, not in git)

```
~/.local/daemon/xot/keys
~/.local/daemon/xot/state          # ACTIVE_IDX + COOL_<fp>
~/.local/daemon/xot/locks/registry.json
~/.local/daemon/xot/locks/.flock
```
