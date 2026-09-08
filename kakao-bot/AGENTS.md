# AGENTS.md — cold-start recipe for an AI agent on this project

Last verified: 2026-09-07.

## What this project is (one sentence)

**kakao-bot — a FastAPI hosting server on `:7862` that turns a KakaoTalk
Skill webhook into a single chatroom backed by local Qwen 2.5 7B via the
orchestrator on `:3000`.**

If you can't read the first paragraph of `README.md` and the header
docstring of `chat_engine.py` in under 60 seconds, stop and read them
before touching code.

## The 60-second cold start

1. **Read first:**
   - `README.md` (this dir) — what it is, what it isn't, how to run.
   - `chat_engine.py` top docstring — the prompt contract (the load-bearing
     design choice). If you change anything here, re-read the whole thing.

2. **Check the live state:**
   ```bash
   curl -s http://127.0.0.1:7862/health        # is the bot up?
   curl -s http://127.0.0.1:3000/health        # is the orchestrator up?
   ollama list                                 # is qwen2.5:7b installed?
   ```

3. **Run tests:**
   ```bash
   /home/physics-lab/code_repo/kakao-bot/tests/run_tests.sh
   ```
   13 tests, all green. If any are red, that's a bug, not a flake.

4. **Smoke test (real Qwen, real latency):**
   ```bash
   curl -s -X POST http://127.0.0.1:7862/v1/chat \
     -H "Content-Type: application/json" \
     -d '{"user_id":"agent","messages":[{"role":"user","content":"한국어로 한 문장."}]}'
   ```
   Expect ~1.8s latency, ~80 prompt tokens, a sensible Korean reply.

## The contract you must preserve

The prompt budget is **load-bearing**. If you change one of these three
numbers without re-deriving the others, latency will explode or Kakao
will time out. The numbers and their rationale:

| Constant | Value | Why (re-derive before changing) |
|---|---|---|
| `MAX_TURNS` | 10 | Beyond ~10 exchanges, 7B loses focus (lost-in-the-middle). |
| `MAX_PROMPT_TOKENS` | 2048 | Measured: 2k → ~3s. 4k → 6s+. Kakao requires <3s. |
| `MAX_COMPLETION_TOKENS` | 512 | ~200 Korean chars; cap reply time at ~10s worst case. |

The three trimming invariants in `build_messages()` are also load-bearing:
1. System prompt never dropped (it's `msgs[0]`).
2. Pairs dropped together (never orphan an assistant reply).
3. Token estimator is pessimistic (better to over-trim than to oversend).

If a change breaks any of these, the prompt gets garbled and the model
hallucinates or refuses to answer.

## Architectural facts you need

- **Two API surfaces in one process** (`kakao_bot_server.py`):
  - `/v1/chat` — stateless, caller owns history, used by other agents
  - `/kakao/skill` — stateful, persistent in-memory history, used by Kakao
- **One chatroom, one history.** v1 has no multi-room or per-user isolation.
- **History is in-process memory.** Restart = lose. Acceptable for v1.
- **Orchestrator URL is a constructor arg** on `ChatEngine` — for tests,
  the engine accepts a `caller` callable that bypasses httpx entirely.
- **The venv is shared** at `/home/physics-lab/code_repo/ai-services/venv`
  (Python 3.14, fastapi 0.141, pydantic 2.13, httpx 0.28, uvicorn 0.52).
  No pytest there — tests use stdlib `unittest`.

## Common mistakes to avoid

- **Don't call `/v1/chat` and expect persistent state.** It doesn't write
  to the engine's history. Use `/kakao/skill` (or build your own history
  on the caller side and pass it in `/v1/chat`).
- **Don't edit `MAX_*` constants in chat_engine.py without updating the
  header docstring** and re-running the stress test in
  `tests/test_chat_engine.py::BuildMessagesTests::test_pairs_dropped_together`.
- **Don't add a Kakao signature check** until the Kakao channel is real
  — the test envelope in the README doesn't have one.
- **Don't add Redis / SQLite / disk persistence in v1.** The user explicitly
  scoped v1 to in-memory single-room.
- **Don't import from `code_repo/ai-services`** (no shared modules there).
  If you need fastapi/uvicorn, use the existing venv.

## When something breaks

| Symptom | First check |
|---|---|
| `curl /health` fails | is the process running? `pgrep -fa kakao_bot_server` |
| Bot replies "I don't know" to things it should | check `/v1/chat/history` — is the history getting through? check the log `/tmp/kakao-bot.log` |
| Latency >5s | check orchestrator `/vram` — qwen got evicted? warm it: `ai chat "hi"` |
| 503 from orchestrator | orchestrator can't reach ollama; check `curl http://127.0.0.1:11434/api/tags` |
| Korean garbled in tests | the unit tests assert on token counts, not decoded bytes. Don't read raw response body as text. |
| Tests fail after a chat_engine.py edit | the trim algorithm is the most-likely regression site. Re-read `build_messages` and the three invariants. |

## Where to look for what

| You want to... | Look in... |
|---|---|
| Change the system prompt | `DEFAULT_SYSTEM_PROMPT` in chat_engine.py, or `KAKAO_BOT_SYSTEM_PROMPT` env var |
| Change token budgets | `MAX_*` constants at top of chat_engine.py |
| Add a route | `kakao_bot_server.py` — keep the existing two as the model |
| Add a test | `tests/test_chat_engine.py` — follow the `make_fake_caller` pattern |
| Add a new orchestrator model | `ChatEngine.model` is per-request overridable via `/v1/chat` |
| Wire up real Kakao | replace the placeholder envelope parsing in `/kakao/skill`; add Kakao signature check from their docs |

## Provenance

Built 2026-09-07 in response to user request: "set up kakao-bot using
local qwen bot". v1 deliberately scoped to:
- single room, in-memory history
- OpenAI-shaped `/v1/chat` for other agents
- Kakao envelope adapter (placeholder extraction; works for common shapes)
- contract-driven prompt trimming (the design choice that took the
  longest to nail down — see chat_engine.py header)
