# XOT Key Rotation — Usage & Reference

**Last updated:** 2026-09-14  
**Stack:** `xot-rotate` (bash) + `key-rotate-lite.ts` (OMP extension)  
**Policy:** primary-first, sticky backup, reset-based cooldown  
**Models:** `:free` only — no paid provider

---

## Overview

XOT manages **15 independent OpenRouter API keys** for OMP. Each key is a separate OpenRouter account with its own daily `:free` quota. The system keeps **KEY_01** as the primary key (1000 requests/day) and falls back to backup keys only when KEY_01 hits a real daily cap.

The legacy `xot.ts` / `auto-rotate.ts` stack is **disabled** in `~/.omp/agent/config.yml`. Rotation is handled by the lightweight pair below.

| Component | Path | Role |
|-----------|------|------|
| Rotator CLI | `~/.local/bin/xot-rotate` | Pick/rotate/cool/probe keys |
| OMP extension | `~/.omp/agent/extensions/key-rotate-lite.ts` | Inject auth, handle 429, OMP commands |
| Advisor routing | `~/.omp/agent/extensions/advisor-manager.ts` | Advisor uses same KEY_01 + free-auto model |
| Keys file | `~/.local/daemon/xot/keys` | 15 API keys (one per line) |
| State file | `~/.local/daemon/xot/state` | Active index + cooldowns |
| Last 429 log | `~/.config/openrouter/last_429.json` | Debug log from extension |

---

## OpenRouter `:free` quota rules

These rules are **per OpenRouter account** (per key), not per model.

| Account credits purchased | `:free` daily limit | Error when exhausted |
|---------------------------|---------------------|----------------------|
| **≥ $10** (high-balance) | **1000 req/day** | `free-models-per-day-high-balance` |
| **< $10** | **~50 req/day** | `free-models-per-day` |

Important facts:

- All `:free` models **share one counter** per account (not 1000 per model).
- `openrouter/openrouter:free` (the free **router**) uses that **same** per-account counter. It is not a second pool and not unlimited.
- OpenRouter dashboard shows **USD usage**, not free-request count. Use `/key-probe` or 429 headers to see `X-RateLimit-Remaining`.
- Daily reset is **UTC midnight** (`X-RateLimit-Reset` header).
- **Shared-pool / upstream** 429s are **not** key exhaustion — rotating keys does not help.

### Verified example (2026-09-13)

| Key | Tier | Probe result |
|-----|------|--------------|
| KEY_01 `...9f89` | $11 credits | `remain=0/1000` — actually exhausted |
| KEY_02 `...7b5a` | backup | `HTTP 200` |
| KEY_03 `...af34` | backup | `HTTP 200` |
| KEY_06 `...14ea` | backup | `HTTP 200` |

---

## Rotation policy

### 1. Primary-first

- **KEY_01** (index 0) is used for every request until its daily cap is hit.
- Do **not** rotate on every message (old bug burned through 50/day keys).

### 2. Sticky backup

When KEY_01 is cooling:

1. If the current backup key is still OK → **keep using it** (no flip-flop).
2. Only advance when the active backup also gets a daily-cap 429 or on manual `/key-rotate`.

### 3. Cooldown rules

| Error type | Action |
|------------|--------|
| `free-models-per-day` | Cool key until `X-RateLimit-Reset` (UTC midnight) |
| `free-models-per-day-high-balance` | Same — real daily cap for $10+ accounts |
| `401` / invalid key | Cool key, pick next |
| `shared pool` / upstream 429 | **Do not cool** — model/provider issue, not key |
| HTTP 429 with **empty body** (OMP `after_provider_response`) | **Daily** — the hook has status+headers only; `:free` 429 is a per-key cap |
| `retry.maxDelayMs` abort + nested `Original error: 429` | **Daily** — OMP will not wait ~hours; cool + bump + auto-continue |

### 4. Advisor shares main key

- `key-rotate-lite` injects the same `OPENROUTER_API_KEY` into `openrouter` and `openrouter-free-auto`.
- Advisor model: `openrouter-free-auto/best-reason` (set by `advisor-manager.ts`).
- If advisor hits quota on a backup key, run `/uncool` or `/advisor off` → `/advisor on`.

---

## State file format

`~/.local/daemon/xot/state`:

```
ACTIVE_IDX=0
ROTATED_AT=1789319017
COOL_e9f0ac62ba38e1d6=1789344000
```

| Field | Meaning |
|-------|---------|
| `ACTIVE_IDX` | Current key index (0 = KEY_01) |
| `ROTATED_AT` | Epoch when index last changed |
| `COOL_<fp>` | Key fingerprint cooling until epoch (seconds) |

---

## CLI: `xot-rotate`

```bash
# Pick key (primary if available, else sticky backup)
eval "$(xot-rotate pick | grep '^export')"

# Show full pool status
xot-rotate status

# Probe :free quota (live HTTP test)
xot-rotate probe all        # all 15 keys
xot-rotate probe 0          # KEY_01 only
xot-rotate probe            # active key

# Manual backup rotation
xot-rotate rotate

# Cool / uncool
xot-rotate cool 0                    # cool KEY_01 until next UTC midnight
xot-rotate cool 0 1789344000         # cool until specific epoch
xot-rotate uncool 0                  # clear KEY_01 cooldown
xot-rotate uncool_all                # clear all COOL_* + reset to KEY_01

# Classify error text
xot-rotate classify "429 free-models-per-day-high-balance"
# → daily
xot-rotate classify "upstream provider shared pool"
# → shared
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `XOT_HOME` | `~/.local/daemon/xot` | Keys + state directory |
| `XOT_KEY_FILE` | `$XOT_HOME/keys` | Keys file path |
| `XOT_STATE_FILE` | `$XOT_HOME/state` | State file path |
| `PRIMARY_IDX` | `0` | Primary key index |
| `COOL_SECS` | `28800` | Fallback cool duration if no reset header |
| `XOT_PROBE_MODEL` | `inclusionai/ling-3.0-flash-vl:free` | Model used by `probe` |

---

## OMP commands

Run inside an OMP session (after extension reload / session restart):

| Command | Description |
|---------|-------------|
| `/key-status` | Show pool status + active session key |
| `/key-probe [idx\|all]` | Live quota probe via OpenRouter |
| `/key-rotate` / `/rotate` | Manual advance to next free key (this session only) |
| `/uncool` | Clear all cooldowns, restore KEY_01, reset advisor quota |

### Advisor recovery

If you see:

```
Warning: advisor: Advisor "default" quota exhausted — pausing until reset.
```

Steps:

```
/uncool
/key-status          # confirm KEY_01 or backup ACTIVE
/advisor off
/advisor on
```

Or start a fresh OMP session (extensions auto-pick primary on `session_start`).

---

## OMP config (required extensions)

`~/.omp/agent/config.yml`:

```yaml
extensions:
  - .../key-rotate-lite.ts      # key injection + 429 handling
  - .../advisor-manager.ts      # advisor → openrouter-free-auto + KEY_01
  - .../openrouter-free-swarm.ts

modelRoles:
  advisor: openrouter-free-auto/best-reason

# DISABLED (do not re-enable without reason):
# - xot.ts, auto-rotate.ts, model-rotation.ts, xot-router.ts
```

**Restart OMP** after changing extensions:

```bash
# /exit then
omp --resume <session-id>
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Same key suffix on every retry (`...9f89` × 15) | Old xot.ts still loaded, or KEY_01 not cooling | Restart OMP; `/key-status`; `xot-rotate probe 0` |
| KEY_01 skipped despite quota left | KEY_01 in COOL state from wrong 429 | `/uncool` or `xot-rotate uncool 0` |
| `high-balance` 429 on KEY_01 | KEY_01 actually at 0/1000 | Wait until UTC midnight or use backup: `/key-rotate` |
| Advisor quota exhausted, KEY_01 OK | Advisor stuck on exhausted backup key | `/uncool` + `/advisor off` → `/advisor on` |
| `Warning: xot:` spam | Old xot extension still in session | Remove xot.ts from config; restart all OMP sessions |
| Dashboard shows low USD but 429 | USD ≠ free-request counter | `xot-rotate probe all` |
| Shared pool 429 | Upstream model pool exhausted | Switch model — key rotation won't help |
| `retry.maxDelayMs` exceeded | Daily cap retry-after ~6–24h | Lite cools+bumps this session then auto-continues |
| "No free key" but the turn still runs | acquire failed, `/retry` reused cooled `OPENROUTER_API_KEY` | Fixed in 1.0.2 — stale env key is dropped |
| 429 on `openrouter/free` after another `:free` model | Same per-account counter | Router is not a second quota pool |

### Quick diagnostic script

```bash
echo "=== status ==="
xot-rotate status
echo "=== probe (first 6 keys) ==="
for i in 0 1 2 3 4 5; do xot-rotate probe $i; done
echo "=== last 429 ==="
cat ~/.config/openrouter/last_429.json 2>/dev/null | python3 -m json.tool
```

---

## Migration from legacy XOT

| Old (disabled) | New |
|----------------|-----|
| `/xot on` / `/xot off` | Always on via `key-rotate-lite` (no toggle needed) |
| `/xot rotation spread` | Removed — use `/key-rotate` for manual backup |
| `xot.ts` auto-rotate every message | Primary-first, rotate only on daily 429 |
| `openrouter-paid-auto` | **Removed** — `:free` only |
| `XOT_STRICT_ROTATE=1` | Not needed — policy is in `xot-rotate pick` |

---

## Architecture diagram

```
OMP request (main or advisor)
        │
        ▼
 key-rotate-lite.ts
  session_start → xot-rotate acquire (session lock)
  before_provider_request → re-acquire (sticky) → inject Bearer
  after_provider_response → classify 429
        │
        ├─ daily/auth 429 (incl. empty-body + maxDelayMs abort)
        │     → cool this key → bump THIS session → auto-continue
        ├─ /key N         → this session only; refuse if locked
        ├─ /key-rotate    → bump THIS session; others unchanged
        ├─ shared pool   → ignore (no cool)
        └─ no free key   → do **not** reuse a cooled env key
        │
        ▼
 xot-rotate (bash) + xot-lock.py
   acquire/bump/set: per-session locks (flock + registry)
   pick: fallback only (skips cooling + locked; never steals)
   state: ~/.local/daemon/xot/state
   locks: ~/.local/daemon/xot/locks/registry.json
        │
        ▼
 OpenRouter API (openrouter.ai/api/v1)
```

---

## Related files

- `~/.pi/agent/extensions/advisor-fix.ts` — recovery steps reference `/uncool`
- `~/.pi/agent/extensions/live-status.ts` — status bar shows `KEY_NN` alias
- `~/.config/openrouter/key_ledger.json` — historical key fingerprints (may not match keys file order)
- `~/.omp/agent/cache/openrouter-free-health.json` — per-model health (separate from key quota)

## Multi-session locks (automatic)

Each OMP session **auto-acquires its own key** on `session_start`. No `/key N` required.

| Component | Path |
|-----------|------|
| Lock registry | `~/.local/daemon/xot/locks/registry.json` |
| Lock helper | `~/.local/daemon/xot/xot-lock.py` |
| flock | `~/.local/daemon/xot/locks/.flock` |

```
Session A starts → KEY_01 if free
Session B starts → next free key (not A's)
Session C starts → next free
Session exits    → lock released
/key 6           → THIS session only; **refuses** if another session holds KEY_06
/key 6 steal     → explicit override (drops the other session's lock)
/key-rotate      → bump THIS session to next free key; others unchanged
```


## Session commands (`/key N`)

| Command | Scope | Effect |
|---------|-------|--------|
| `/key N` | This session | Bind KEY_N if free. **Refuses** if another live session holds it. |
| `/key N steal` | This session | Take KEY_N even if locked (drops the other session's lock). |
| `/key-rotate` / `/rotate` / `/key_rotate` | This session | Bump to the next free key. Other sessions unchanged. |
| `/key-status` | Read | Pool + this session's mask + lock id |
| `/key-probe [idx\|all]` | Live HTTP | Burns quota — do not spam `all` |
| `/uncool` | This session | `sync_quota` (skips keys locked by others) then re-acquire |

CLI equivalents (used by the extension):

```bash
xot-rotate acquire <session-id> <pid>
xot-rotate bump <session-id> <pid>
xot-rotate set <N> <session-id> <pid> [--steal]
xot-rotate release <session-id>
xot-rotate heartbeat <session-id> <pid>
xot-rotate sync_quota <session-id> <pid>
xot-rotate locks
```

---

## Caveats (read before debugging a 429)

1. **Restart OMP after every extension install.** `key-rotate-lite.ts` is loaded at `session_start`. A long-lived `omp --resume` still runs the old handler even if the file on disk is 1.0.2.
2. **`:free` is one counter per account, all models.** `ling-3.0-flash-vl:free`, `laguna-*`, and `openrouter/openrouter:free` share it. The free **router is not a second pool** and is not unlimited.
3. **Dashboard USD ≠ free-request count.** `/api/v1/auth/key` shows spend. Remaining `:free` quota appears only in 429 headers (`X-RateLimit-Remaining` / `X-RateLimit-Reset`) or `/key-probe`.
4. **`Add 10 credits` is the backup-key tier**, not "KEY_01 needs payment." KEY_01's exhausted message is `free-models-per-day-high-balance`.
5. **`/uncool` does not refill OpenRouter.** It clears local `COOL_*` and re-probes. Quota comes back at **UTC midnight**.
6. **Two sessions = two keys.** If both are cooling and the rest are capped, you will see `No free key`. Wait for UTC reset or `/key N steal` a locked key (the other session will keep sending the stolen key until it restarts).
7. **Do not `probe all` while sessions are live.** 15 probes burn 15 `:free` requests and can 429 backups that were still OK.
8. **OMP `retry.maxDelayMs` is 300000 ms.** Daily-cap `retry-after-ms` is hours. 1.0.2 classifies that abort as daily and rotates; old sessions abort and sit.
9. **Empty-body 429 is daily.** `after_provider_response` has status+headers only. Shared-pool is the only 429 that must **not** cool a key (body must contain `shared pool` / `provider exhausted`).
10. **Never reuse a cooled env key.** If acquire fails, 1.0.2 drops `OPENROUTER_API_KEY`. `/retry` on 1.0.1 still sent the dead key — that is "No free key showing but runs."
11. **Do not re-enable `xot.ts` / `auto-rotate.ts` / `openrouter-paid`.** Lite replaces them. Running both double-rotates and reprints `Warning: xot:`.
12. **Keys are never in git or the tarball.** Restore always needs `~/.local/daemon/xot/keys` from this machine (or a private backup you keep yourself).
13. **Advisor pause is separate.** After rotating, `/uncool` flips advisor off/on. If the banner stays, `/advisor off` then `/advisor on` in a **restarted** session.

---

## Version map

| Version | What it fixed |
|---------|----------------|
| 1.0.0 | Portable module; disable legacy XOT; primary-first |
| 1.0.1 | Session locks; `/key N` refuse; no idle prune; `sync_quota` skips locked keys |
| **1.0.2** | Empty-body 429 + `retry.maxDelayMs` → daily; auto-continue; no cooled-env fallback; `/rotate` alias |

Current: `xot-lite/VERSION` → `1.0.2-20260914`.

---

## Restore / local snapshot

See **[RESTORE.md](./RESTORE.md)**. Snapshot (no secrets):

`~/.local/share/snapshots/xot-lite-1.0.2-20260914.tar.gz`

---

## Related

- Incident: [INCIDENT-2026-09-13.md](./INCIDENT-2026-09-13.md)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- Improvements: [ROADMAP.md](./ROADMAP.md)
- GitHub release: https://github.com/0ArchLinux0/omp-keyrot/releases/tag/xot-lite-1.0.2-20260914
