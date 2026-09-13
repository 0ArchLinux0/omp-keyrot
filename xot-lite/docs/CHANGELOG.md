# xot-lite changelog

## 1.0.2-20260914

**Tag:** `xot-lite-1.0.2-20260914`

Empty-body 429 and OMP `retry.maxDelayMs` abort did not rotate. `/retry` reused a cooled env key ("No free key showing but runs"). Two sessions holding keys made the pool look empty.

- Classify HTTP 429 with empty body as **daily** (`after_provider_response` has no body).
- Classify `Add 10 credits` and `retry.maxDelayMs` + nested 429 as **daily**.
- On daily/auth: cool this session's key, bump **this session only**, auto-continue (`sendUserMessage`).
- `acquire()` catch returns `null` — never fall back to `OPENROUTER_API_KEY`.
- `/rotate` alias for `/key-rotate`.
- Isolated tests: `test_classify.py` + extra `test_xot_lite.sh` cases.

`openrouter/openrouter:free` is a **router**, same per-account `:free` counter as other `:free` models.

**Requires OMP restart.**

## 1.0.1-20260914

Session isolation.

- `/key N` refuses if locked; `/key N steal` is explicit.
- `/key-rotate` bumps this session only.
- Live PID keeps the lock (no 5-minute idle prune).
- `sync_quota` skips keys locked by other sessions.
- `pick` fails rather than returning a locked key.

## 1.0.0-20260914

First portable module.

- Disable legacy `xot.ts` / `auto-rotate.ts` / paid provider.
- `xot-rotate` + `key-rotate-lite.ts` + `xot-lock.py`.
- Primary-first, sticky backup, UTC-midnight cool.
- Advisor on `openrouter-free-auto/best-reason` only.
