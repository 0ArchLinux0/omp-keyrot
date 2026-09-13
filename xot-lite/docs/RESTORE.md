# xot-lite restore (when local is broken)

**Version:** 1.0.2-20260914
**Secrets:** never in the tarball, never in git. Keys stay in `~/.local/daemon/xot/keys`.

This is the procedure to bring rotation back after a bad edit, a truncated extension, or a wiped `~/.omp`.

---

## 0. What "broken" looks like

| Symptom | Likely cause |
|---------|----------------|
| `Failed to parse extension` / `key-rotate-lite.ts` | File truncated mid-write |
| `Warning: xot:` / same `sk-or-…9f89` × 15 | Legacy `xot.ts` still loaded |
| `No free key` but `/retry` still 429s | Pre-1.0.2: cooled env key reused |
| `retry.maxDelayMs` abort, no rotate | Pre-1.0.2 empty-body 429 treated as transient |
| All sessions on KEY_01 | Locks missing or old extension |

---

## 1. Fast restore from this machine's snapshot

```bash
SNAP="${HOME}/.local/share/snapshots/xot-lite-1.0.2-20260914.tar.gz"
sha256sum -c "${HOME}/.local/share/snapshots/xot-lite-1.0.2-20260914.sha256"

tmpdir=$(mktemp -d)
tar -xzf "$SNAP" -C "$tmpdir"
cd "$tmpdir/xot-lite"
./install.sh
# keys file is NOT overwritten
# restart every OMP session
```

`install.sh` copies:

| Source | Destination |
|--------|-------------|
| `bin/xot-rotate` | `~/.local/bin/xot-rotate` |
| `lib/xot-lock.py` | `~/.local/daemon/xot/xot-lock.py` |
| `extensions/*.ts` | `~/.omp/agent/extensions/` |
| `docs/*.md` | `~/.local/share/docs/` (offline reading) |

It does **not** touch `keys`, `state`, or `config.yml`.

---

## 2. Restore from git

```bash
cd ~/code_repo/omp-keyrot
git fetch origin
git checkout xot-lite-session-locks
# or: git checkout xot-lite-1.0.2-20260914
cd xot-lite && ./install.sh
```

GitHub:

- Branch: https://github.com/0ArchLinux0/omp-keyrot/tree/xot-lite-session-locks
- Tag: https://github.com/0ArchLinux0/omp-keyrot/releases/tag/xot-lite-1.0.2-20260914

---

## 3. Keys (required, not in snapshot)

```bash
# must exist, one sk-or-v1-... per line, 15 lines typical
ls -l ~/.local/daemon/xot/keys
wc -l ~/.local/daemon/xot/keys
# never commit this file
```

If keys are gone, restore from your private backup. Nothing in git can recreate them.

---

## 4. Config that must stay true

`~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/.omp/agent/extensions/advisor-manager.ts
  - ~/.omp/agent/extensions/key-rotate-lite.ts
modelRoles:
  advisor: openrouter-free-auto/best-reason
# DISABLED:
# xot.ts, auto-rotate.ts, model-rotation.ts, xot-router.ts
# openrouter-paid / openrouter-paid-auto
```

`defaultModel` must be a `:free` slug (e.g. `openrouter/inclusionai/ling-3.0-flash-vl:free`).

---

## 5. Verify (no live OpenRouter if you want zero quota burn)

```bash
cd ~/code_repo/omp-keyrot
./xot-lite/tests/test_xot_lite.sh
python3 -m unittest xot-lite.tests.test_xot_lock xot-lite.tests.test_classify
xot-rotate classify "429"
# daily
xot-rotate status
```

Live probe (burns quota):

```bash
xot-rotate probe 0     # KEY_01 only
```

In a **new** OMP session:

```
/key-status
```

A daily 429 should notify `key-rotate: daily on sk-or-… -> sk-or-…` and continue. You must **not** see `Warning: xot:`.

---

## 6. Nuclear option (state only)

If locks/cooldowns are nonsense but keys are fine:

```bash
# stop OMP sessions first
mv ~/.local/daemon/xot/state ~/.local/daemon/xot/state.bak.$(date +%s)
mv ~/.local/daemon/xot/locks ~/.local/daemon/xot/locks.bak.$(date +%s)
mkdir -p ~/.local/daemon/xot/locks
# do not touch keys
# restart OMP
```

Do **not** delete `keys`.

---

## 7. Local doc copies (offline)

After `install.sh` / `scripts/snapshot.sh`:

```
~/.local/share/docs/xot-rotation.md
~/.local/share/docs/xot-incident-2026-09-13.md
~/.local/share/docs/xot-lite-README.md
~/.local/share/docs/xot-lite-RESTORE.md
~/.local/share/docs/xot-lite-CHANGELOG.md
~/.local/share/docs/xot-lite-ROADMAP.md
~/.local/share/snapshots/xot-lite-1.0.2-20260914.tar.gz
```

---

## 8. Recreate a snapshot

```bash
cd ~/code_repo/omp-keyrot/xot-lite
./scripts/snapshot.sh
```
