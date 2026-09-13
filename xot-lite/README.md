# xot-lite

Portable OpenRouter **`:free` key rotator** for OMP/pi-coding-agent.

- **15 independent accounts** (not one shared balance)
- **KEY_01 first** ($10+ credits → 1000 `:free`/day); backups ~50/day
- **One key per OMP session** (`flock` + JSON registry)
- **Manual override** `/key N`
- **No paid provider**, no legacy `xot.ts` stack

This module is the 2026-09-13 incident fix: KEY_01 was actually 0/1000, `/uncool` did not refill quota, and concurrent sessions burned the same key.

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
```

No live OpenRouter calls (does not burn quota).

## Snapshot

```bash
tar -czf xot-lite-$(cat xot-lite/VERSION).tar.gz \
  --exclude keys --exclude state xot-lite
```

## Runtime state (machine-local, not in git)

```
~/.local/daemon/xot/keys
~/.local/daemon/xot/state          # ACTIVE_IDX + COOL_<fp>
~/.local/daemon/xot/locks/registry.json
~/.local/daemon/xot/locks/.flock
```
