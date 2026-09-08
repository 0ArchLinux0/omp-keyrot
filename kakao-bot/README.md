# kakao-bot

A hosting server that turns a KakaoTalk channel webhook into a chatroom
backed by a **local Qwen 2.5 7B** model via the existing orchestrator on
`:3000`. Single room, in-memory history, OpenAI-shaped `/v1/chat` API for
any caller (curl, another agent on the LAN, future Kakao channel).

Last verified: 2026-09-07.

## What this is

- A FastAPI server on `:7862` that exposes two surfaces:
  - `POST /v1/chat` — clean, JSON-in / JSON-out, stateless (caller owns history)
  - `POST /kakao/skill` — Kakao Skill Server webhook adapter (uses persistent
    in-memory history = the chatroom state)
- Owns the **prompt contract** (see chat_engine.py header): max 10 turns,
  ≤2048 prompt tokens, ≤512 completion tokens, system prompt reserved,
  pairs trimmed together.

## What this is NOT (v1)

- Not multi-room. One history, one room.
- Not multi-user-isolated. Anyone hitting `/kakao/skill` shares history.
- Not Kakao-authenticated. The `/kakao/skill` route accepts any well-formed
  Kakao envelope; no signature check yet.
- Not persisted. Restart the process and history is gone.

## How to run

```bash
# from anywhere on the LAN:
curl -s http://100.102.134.39:7862/health

# start it (foreground; for a daemon use systemd or nohup):
cd /home/physics-lab/code_repo/kakao-bot
/home/physics-lab/code_repo/ai-services/venv/bin/python kakao_bot_server.py

# smoke test (uses real Qwen via orchestrator):
curl -s -X POST http://127.0.0.1:7862/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"user_id":"x","messages":[{"role":"user","content":"한국어 한 문장으로 자기소개."}]}'
```

Expected first-turn latency: **~1.8s** (1 system + 1 user = ~80 prompt
tokens). After warm-up the orchestrator KV-caches the system prompt,
so subsequent first-tokens drop to ~700ms.

## The two API surfaces

### `POST /v1/chat` (clean API — preferred for other agents)

Request:
```json
{
  "user_id": "minjun",
  "messages": [
    {"role": "user", "content": "안녕?"}
  ]
}
```

Optional fields: `model`, `system`, `temperature` (per-request override).

Response:
```json
{
  "reply": "안녕하세요! ...",
  "model": "qwen2.5:7b",
  "usage": {
    "prompt_tokens": 82,
    "completion_tokens": 21,
    "total_tokens": 103,
    "cached_tokens": 4
  },
  "latency_ms": 1828,
  "turns_used": 0,
  "trimmed": false,
  "user_id": "minjun"
}
```

`/v1/chat` is **stateless** — it does NOT mutate the server's persistent
history. The caller passes full history (or just the new turn) each time.
Use `/kakao/skill` if you want the server to remember.

### `POST /kakao/skill` (Kakao webhook adapter)

Accepts any Kakao Skill 2.0 envelope; extracts `userRequest.utterance`;
uses the server's **persistent** in-memory history; replies in the
required `template.outputs` shape. One history for the whole process.

Useful endpoints:
- `GET /v1/chat/history` — snapshot of the persistent history
- `DELETE /v1/chat/history` — wipe it

## How the prompt is built (the contract)

See `chat_engine.py` header docstring — it's the source of truth.

In one paragraph: the engine takes `[system] + last-N-turns-of-history +
new-user`, where N is capped by both `MAX_TURNS=10` and
`MAX_PROMPT_TOKENS=2048`. If the total exceeds the token budget, oldest
pairs are dropped (never the system, never orphan an assistant reply).
Token count is estimated pessimistically (~10-15% over) using a chars/1.5
heuristic; actual `prompt_tokens` from the orchestrator is logged so we
can detect if the heuristic drifts.

## Tests

```bash
/home/physics-lab/code_repo/kakao-bot/tests/run_tests.sh
```

13 stdlib-unittest tests, all green, no pytest dependency. Uses a fake
orchestrator caller so no real Qwen calls happen during tests.

## Files

```
kakao-bot/
├── chat_engine.py           # prompt contract + orchestrator client (the brain)
├── kakao_bot_server.py      # FastAPI server, both API surfaces (the body)
├── tests/
│   ├── test_chat_engine.py  # 13 unit tests
│   └── run_tests.sh
├── README.md                # this file
└── AGENTS.md                # cold-start recipe for AI agents
```

## Tunables (env vars on the server)

- `KAKAO_BOT_HOST` (default `0.0.0.0`)
- `KAKAO_BOT_PORT` (default `7862`)
- `ORCHESTRATOR_URL` (default `http://127.0.0.1:3000`)
- `KAKAO_BOT_SYSTEM_PROMPT` (default in chat_engine.py)

The token-budget knobs (`MAX_TURNS`, `MAX_PROMPT_TOKENS`,
`MAX_COMPLETION_TOKENS`) are module-level constants in `chat_engine.py`.
Edit them there with the rationale comments; do not edit via env.
