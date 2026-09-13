# xot-lite — caveats that remain, and what to improve

Status after 1.0.2. These are **not** blockers for daily use if you restart OMP.

---

## Known limits (do not "fix" by re-enabling xot.ts)

1. **Extensions do not hot-reload.** Every lite install needs `/exit` + `omp --resume`. A wrapper that prints the loaded VERSION on `session_start` would catch stale sessions.
2. **Auto-continue uses `pi.sendUserMessage(lastUserPrompt)`.** If that API is missing on a given OMP build, the user still `/retry` — but 1.0.2 will have already bumped the key, so `/retry` is safe. Confirm on the next 429.
3. **`after_provider_response` still has no body.** Classification of shared-pool vs daily depends on later `turn_end` / `agent_end` text, or on treating bare 429 as daily. A true shared-pool 429 with empty body will cool a key (false daily). Rare; watch `last_429.json`.
4. **Advisor quota pause is OMP-side.** Lite toggles advisor off/on after a bump. If the banner persists, it is not a key bug.
5. **Backup keys are 50/day.** Two concurrent sessions + advisor can empty them fast. Do not `probe all` during the day.
6. **`steal` is unsafe by design.** The victim session keeps the key in memory until restart.
7. **No paid path.** Intentional. Do not add `openrouter-paid-auto`.
8. **UTC midnight reset**, not local midnight (KST = UTC+9 → 09:00 KST).

---

## Improvements (priority order)

### P1 — operational

- Print `xot-lite 1.0.2` + key suffix on `session_start` / `/key-status` so stale sessions are obvious.
- Persist last-rotate reason in `last_429.json` **and** surface it on `/key-status`.
- Heartbeat + `acquire` already exist; add a `/key-who` that prints PID + session id + key index without probing.

### P2 — rotation quality

- If `sendUserMessage` is absent, schedule `agent.continue` the way full `xot.ts` did (after the turn ends).
- Distinguish shared-pool 429 when headers include `X-RateLimit-Remaining > 0` (do not cool).
- Optional: cool until `X-RateLimit-Reset` even when the header is ms vs seconds (already parsed; add a test).

### P3 — pool hygiene

- Mark KEY_01 as high-balance from a one-shot `/api/v1/auth/key` credits read (USD only) so `Add 10 credits` is never attributed to KEY_01.
- Per-key daily remaining cache from the last 429 headers (not a live probe loop).
- Warn when ≥3 OMP PIDs hold locks ("you are multiplying burn").

### P4 — packaging

- `install.sh` should refuse if `config.yml` still lists `xot.ts`.
- Chezmoi/dotfiles sync for `config.yml` + extensions (optional).
- Merge `xot-lite/` onto `main` so restore is `git checkout main` not a long-lived branch. (1.0.2 lives on `xot-lite-session-locks` today; `main` still has the old `xot.ts` stack.)

### Do not do

- Per-request round-robin across 15 keys (burns 50/day backups).
- Re-enable paid auto for advisor.
- Treat 15 keys as one shared balance.
- `probe all` on a cron.

---

## Tests that must stay green (no live API)

```bash
./xot-lite/tests/test_xot_lite.sh
python3 -m unittest xot-lite.tests.test_xot_lock xot-lite.tests.test_classify
```
