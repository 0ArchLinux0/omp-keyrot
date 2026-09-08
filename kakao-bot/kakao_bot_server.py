"""
kakao_bot_server.py — FastAPI hosting server for the Kakao bot.

Two API surfaces in one process:

  1. POST /v1/chat         — clean, JSON-in / JSON-out API for any client
                              (curl, another agent on the LAN, etc.)
                              This is the surface the other agent on the
                              other device calls.

  2. POST /kakao/skill     — Kakao Skill Server webhook adapter.
                              Translates Kakao's envelope -> /v1/chat shape
                              and repacks the reply into Kakao's required
                              `template.outputs` envelope.

Runs on :7862 by default. Stateless across restarts (history is in memory,
process death loses it — fine for v1 single-room).

# Other-agent usage (from any LAN host):

  curl -s -X POST http://100.102.134.39:7862/v1/chat \
    -H "Content-Type: application/json" \
    -d '{"user_id":"minjun","messages":[{"role":"user","content":"안녕?"}]}'
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from chat_engine import (
    DEFAULT_MODEL,
    DEFAULT_SYSTEM_PROMPT,
    ChatEngine,
    estimate_tokens,
)

import re

def _clean_reply(raw: str) -> str:
    """One-block sanitizer: strip [노벨봇] markers, collapse newlines, and block non-Korean text.
    - Removes [노벨봇] / [Nobel Bot] markers
    - Collapses multiple newlines into single space
    - Removes CJK characters (Chinese, Japanese Hiragana/Katakana)
    - Keeps: Hangul, Korean punctuation, English, numbers, spaces
    - Use when copy-pasting chat reply to KakaoTalk or other Korean chat
    """
    if not raw:
        return ""
    raw = re.sub(r"\[노벨봇\]|\[Nobel Bot\]", "", raw)
    raw = re.sub(r"\n{2,}", " ", raw)
    raw = raw.replace("\n", " ")
    # Remove Chinese characters (CJK Unified Ideographs + Extension ranges)
    raw = re.sub(r"[\u4e00-\u9fff\u3400-\u4dbf\u20000-\u2a6df\uf900-\ufaff]", "", raw)
    # Remove Japanese Hiragana and Katakana
    raw = re.sub(r"[\u3040-\u309f\u30a0-\u30ff]", "", raw)
    raw = re.sub(r" {3,}", "  ", raw)
    return raw.strip()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("kakao_bot_server")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HOST = os.environ.get("KAKAO_BOT_HOST", "0.0.0.0")
PORT = int(os.environ.get("KAKAO_BOT_PORT", "7862"))
ORCHESTRATOR_URL = os.environ.get("ORCHESTRATOR_URL", "http://127.0.0.1:3000")
DEFAULT_SYSTEM = os.environ.get("KAKAO_BOT_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT)

# One engine, one chatroom, one history. v1.
engine = ChatEngine(
    base_url=ORCHESTRATOR_URL,
    model=DEFAULT_MODEL,
    system=DEFAULT_SYSTEM,
)

# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str = Field(..., pattern="^(system|user|assistant)$")
    content: str


class ChatRequest(BaseModel):
    user_id: Optional[str] = None      # echoed back; not used for routing in v1
    messages: list[ChatMessage]        # full history; only the LAST user msg is used
    model: Optional[str] = None        # override engine.model for this call
    system: Optional[str] = None       # override engine.system for this call
    temperature: Optional[float] = None


class ChatResponse(BaseModel):
    reply: str
    model: str
    usage: dict
    latency_ms: int
    turns_used: int
    trimmed: bool
    user_id: Optional[str] = None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="kakao-bot", version="0.1.0")


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "service": "kakao-bot",
        "orchestrator": ORCHESTRATOR_URL,
        "model": engine.model,
        "history_messages": len(engine.history.messages),
    }


@app.get("/v1/chat/history")
async def history() -> dict:
    """Read-only snapshot of current chatroom history. Useful for debugging."""
    return {
        "messages": engine.history.snapshot(),
        "count": len(engine.history.messages),
        "est_tokens": estimate_tokens(engine.history.snapshot()),
    }


@app.delete("/v1/chat/history")
async def clear_history() -> dict:
    """Wipe the chatroom history. Useful between sessions."""
    engine.history.clear()
    return {"ok": True}


@app.post("/v1/chat", response_model=ChatResponse)
async def chat(req: ChatRequest) -> ChatResponse:
    """Clean chat API.

    Input shape (matches OpenAI /v1/chat/completions):
        { "user_id": "...", "messages": [{"role":"user","content":"..."}, ...] }

    The engine uses the LAST user message as the new turn and the
    preceding messages as history (so callers can pass either
    full-history or just-new-message form).
    """
    if not req.messages:
        raise HTTPException(400, "messages must be non-empty")

    # The new turn is the LAST user-role message; everything BEFORE it
    # (any role) is treated as history. This way callers can pass the
    # full OpenAI-style messages array including past user turns.
    new_user: Optional[str] = None
    last_user_idx: int = -1
    for i, m in enumerate(req.messages):
        if m.role == "user":
            new_user = m.content
            last_user_idx = i
    if new_user is None:
        raise HTTPException(400, "messages must contain at least one user turn")
    history_msgs = [m.model_dump() for m in req.messages[:last_user_idx]]

    # Per-request overrides (cheap and useful for testing different personas).
    saved_model = engine.model
    saved_system = engine.system
    if req.model:
        engine.model = req.model
    if req.system:
        engine.system = req.system

    # Replace the engine's history with the caller's for this request.
    # This makes /v1/chat stateless from the caller's POV: they own the
    # history. The engine's persistent HistoryStore is *not* mutated here,
    # so other clients (e.g. the Kakao adapter) keep their own history.
    saved_history = engine.history
    from chat_engine import HistoryStore
    engine.history = HistoryStore(messages=history_msgs)

    try:
        # append=False: caller owns history; the engine is stateless for this call.
        result = engine.ask(new_user, append=False)
    finally:
        engine.model = saved_model
        engine.system = saved_system
        engine.history = saved_history

    return ChatResponse(
        reply=_clean_reply(result["reply"]),
        model=result["model"],
        usage=result["usage"],
        latency_ms=result["latency_ms"],
        turns_used=result["turns_used"],
        trimmed=result["trimmed"],
        user_id=req.user_id,
    )


# ---------------------------------------------------------------------------
# Kakao Skill Server adapter (placeholder shape, returns valid envelope)
# ---------------------------------------------------------------------------

@app.post("/kakao/skill")
async def kakao_skill(payload: dict) -> JSONResponse:
    """Kakao Skill Server webhook adapter.

    Kakao POSTs a JSON envelope; we don't care about the inner shape
    for v1 — we just need to return a valid `template.outputs` reply
    within 3 seconds. Real envelope parsing comes when we wire up a
    real Kakao channel.
    """
    # For now: extract user utterance from a few common Kakao shapes.
    user_text = (
        (payload.get("userRequest") or {}).get("utterance")
        or (payload.get("action") or {}).get("params", {}).get("user_text")
        or (payload.get("userRequest") or {}).get("params", {}).get("surface")
        or ""
    )
    if not user_text:
        return JSONResponse(_kakao_reply("아직 메시지를 이해하지 못했어요. 텍스트로 보내주세요."))

    # Use the engine's persistent history (this is the *real* chatroom
    # state, not the caller's). The adapter is the one client that
    # shares state with the room.
    saved = engine.history
    from chat_engine import HistoryStore
    # Use engine's persistent history directly:
    try:
        result = engine.ask(user_text)
        reply_text = _clean_reply(result["reply"])
    except Exception as e:  # never let Kakao see a 5xx; they retry forever
        log.exception("kakao skill handler failed")
        reply_text = "잠시만요, 다시 보내주세요."

    return JSONResponse(_kakao_reply(reply_text))


def _kakao_reply(text: str) -> dict:
    """Wrap `text` in the Kakao skill response envelope (version 2.0)."""
    return {
        "version": "2.0",
        "template": {
            "outputs": [
                {"simpleText": {"text": text}}
            ]
        },
    }


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    log.info("starting kakao-bot on %s:%d -> orchestrator=%s model=%s",
             HOST, PORT, ORCHESTRATOR_URL, engine.model)
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
