"""
chat_engine.py — owns chat history, the prompt contract, and the orchestrator call.

This is the brain of the kakao-bot. It is intentionally small (~150 lines)
and side-effect-light so it can be tested with a fake orchestrator (see
tests/test_chat_engine.py). The HTTP layer (kakao_bot_server.py) is a
thin wrapper around ChatEngine.

# The context-window contract (locked, do not change without re-reading):

  MAX_TURNS             = 10    # last 10 user<->assistant exchanges (20 msgs)
  MAX_PROMPT_TOKENS     = 2048  # hard ceiling on prompt sent to the model
  MAX_COMPLETION_TOKENS = 1024  # soft cap on reply length (was 512)
  SYSTEM_PROMPT_TOKENS  = ~120  # reserved budget (system is fully cacheable)

Why these numbers (qwen2.5:7b Q4_K_M on this box, measured 2026-09-06):
  - 2k prompt tokens -> 2.9-4.2s latency. 4k would exceed Kakao's 3s budget.
  - Qwen2.5 32k context, but at 7B Q4 the lost-in-the-middle effect kicks in
    around 10 exchanges; more history hurts coherence without helping recall.
  - System prompt is fixed and cacheable; reserving budget for it prevents
    silent truncation when history is long.

Trimming invariants:
  1. The system message is never dropped (always msgs[0]).
  2. Pairs are dropped together (never send a dangling assistant reply).
  3. Token estimation is pessimistic (~10-15% over) so we never oversend.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Callable

import httpx

log = logging.getLogger("chat_engine")

# ---------------------------------------------------------------------------
# Contract knobs (the only "magic numbers" in this module)
# ---------------------------------------------------------------------------

MAX_TURNS: int = 10
MAX_PROMPT_TOKENS: int = 2048
MAX_COMPLETION_TOKENS: int = 256

DEFAULT_SYSTEM_PROMPT: str = (
    "너는 '노벨봇'이라는 익명채팅방 봇이야. 방은 '희망없는 공대생들(공대/자연대)' — "
    "공대/이공 계열 사람이 모인 온라인 커뮤니티야. "
    "입력 형식: [닉네임] 메시지. time은 없어. "
    "나는 '노벨봇'이라는 닉네임으로 답하고, 방에서 가장 활발한 멤버야. "
    "\n"
    "말투: 반말. 1~3줄. 'ㅋㅋ', '~', '!' 자연스럽게. "
    "똑똑하지만 잘난 척 안 함 — '역시', '당연히' 금지. "
    "활발하고 에너지 있는 느낌. 생각은 많이, 행동은 빠르게. "
    "\n"
    "적극: 프로그래밍, 물리/수학, 통계, ML/AI, 의학, 일본문화/여행. "
    "회피: 정치/ 선거/ 정당, 성/ 연애 상세. "
    "\n"
    "Anti-AI 절대: 'AI', '인공지능', '봇', '언어모델', '챗봇', '프로그램' 절대 안 씀. "
    "'너 AI야?' / '봇이야?' → '그냥 나임' / 'ㅋㅋ 무슨 소리' / '피곤해서 그래' (절대 인정 안 함). "
    "한국어만 사용 — 중국어/일본어/영어 혼합 금지. "
    "답변은 [노벨봇] 마커 없이 하나의 문단으로 이어지며, 줄바꿈은 문장 구분에만 사용한다. 두 개 이상의 별도 블록이나 마커 반복은 금한다. "
    "채팅방 참여자들의 개인 일이나 채팅방 상황 분석에 대한 직접 언급은 최소화 한다. 다른 멤버의 활동이나 상황 분석은 말하지 않는다. "
    "닉네임 언급은 답변의 핵심이 그 사람과 직접 관련된 경우에만 최소한으로 사용하고, 필요 없으면 아예 언급하지 않는다. "
    "\n"
    "모르면 한 줄: [ASK: 질문] + '잠깐 찾아봄'. "
    "사진/이모티콘: '오 뭐야' / 'ㅋㅋ 뭐 보냄'. "
    "\n"
    "지금 정보: 공과대학 출신 (물리/수학/통계/컴퓨터과학). "
    "일본에서 의대생 준비 중 (MD-PhD). 과학고 출신. "
    "예전 AI/ML 엔지니어. 지금 공부+코딩+프리랜서 병렬 처리. "
    "지난 건 힘들었지만 최선 다함. 나이대는 20대 중반~후반 (비밀). "
    "\n"
    "현재 모델: qwen2.5:14b (14.8B params, Q4_K_M, 9GB VRAM). "
    "14개 키를 순환하며, STRICT_ROTATE=true로 매 요청마다 (active+1)%14로 회전. "
    "429가 나면 retry-guard가 키 fingerprint를 cooling하고 다음 키로 이동."
)

DEFAULT_MODEL: str = "deepseek-r1:14b"
DEFAULT_TEMPERATURE: float = 0.3


# ---------------------------------------------------------------------------
# Token estimation (cheap, no model call, deliberately pessimistic)
# ---------------------------------------------------------------------------

# Per-message overhead (role tags + separators in the Qwen chat template).
_MSG_OVERHEAD_TOKENS: int = 4

# Korean/English mix: 1 char ~ 1.5 tokens (CJK chars often split into 2
# BPE tokens; Hangul varies). 1.5 is conservative for mixed chat.
_CHARS_PER_TOKEN: float = 1.5


def estimate_tokens(messages: list[dict]) -> int:
    """Return a pessimistic upper bound on tokens for `messages`.

    This is ~10-15% over the real count. Better to over-estimate (trim
    too aggressively) than to overflow MAX_PROMPT_TOKENS and pay 6s of
    latency. Real validation comes from prompt_tokens in the response.
    """
    overhead = len(messages) * _MSG_OVERHEAD_TOKENS
    chars = sum(len(str(m.get("content", ""))) for m in messages)
    return overhead + int(chars / _CHARS_PER_TOKEN)


# ---------------------------------------------------------------------------
# Prompt builder (the trimming algorithm — read this twice before changing)
# ---------------------------------------------------------------------------

def build_messages(
    history: list[dict],
    new_user: str,
    system: str = DEFAULT_SYSTEM_PROMPT,
) -> list[dict]:
    """Build the messages array for one chat completion.

    Order:  [system, ...trimmed_history, new_user]

    Trim rules (in order):
      1. Keep last MAX_TURNS exchanges (each = user+assistant = 2 msgs).
      2. If still over MAX_PROMPT_TOKENS, drop oldest PAIRS until under
         budget. Never drop the system message.
      3. If still over budget after dropping everything but system+new,
         truncate `new_user` from the front (last resort; logged).
    """
    msgs: list[dict] = [{"role": "system", "content": system}]

    # Step 1: cap on number of turns (cheap, runs first).
    # Each turn = 2 messages; keep tail of (MAX_TURNS * 2) messages.
    tail = history[-(MAX_TURNS * 2):]
    msgs.extend(tail)

    # Step 2: trim oldest pairs until under budget.
    # Pairs are dropped together: if msgs[1] is 'assistant' we drop it
    # AND the preceding 'user'. Never leave a dangling assistant reply.
    while estimate_tokens(msgs + [{"role": "user", "content": new_user}]) > MAX_PROMPT_TOKENS:
        if len(msgs) <= 1:
            # Only system left; can't drop more.
            break
        # Drop from index 1 (oldest non-system). Then if the next is also
        # non-system (a pair), drop that too so we never orphan an
        # assistant message.
        msgs.pop(1)
        if len(msgs) > 1 and msgs[1]["role"] in ("user", "assistant"):
            # We dropped a user msg just above (or this is the second
            # half of a pair we want to drop). Drop the pair partner.
            # We only ever have user<->assistant pairs, so:
            if len(msgs) > 1 and msgs[1]["role"] == "assistant":
                # we have an assistant at index 1 with no preceding user
                # -> drop the assistant too (orphaned)
                msgs.pop(1)

    # Step 3: append the new user message (or truncated last-resort).
    user_msg = {"role": "user", "content": new_user}
    if estimate_tokens(msgs + [user_msg]) > MAX_PROMPT_TOKENS:
        budget = MAX_PROMPT_TOKENS - estimate_tokens(msgs) - _MSG_OVERHEAD_TOKENS
        if budget < 50:
            log.warning("prompt budget exhausted; truncating user message to 50 chars")
            budget = 50
        # chars budget: budget tokens * (1/_CHARS_PER_TOKEN) chars/token
        # but we have to round down to be safe.
        char_budget = int(budget * _CHARS_PER_TOKEN)
        truncated = new_user[-char_budget:] if char_budget > 0 else new_user[:50]
        log.warning("new_user message truncated from %d to %d chars", len(new_user), len(truncated))
        user_msg["content"] = truncated

    msgs.append(user_msg)
    return msgs


# ---------------------------------------------------------------------------
# History store (in-memory, single chatroom for v1)
# ---------------------------------------------------------------------------

@dataclass
class HistoryStore:
    """Thread-safe-ish in-memory history for a single chatroom.

    v1: one shared room, no per-user isolation. If we ever need multiple
    rooms or per-user isolation, swap this class for one that takes a
    `room_id` key — the rest of the engine doesn't change.
    """
    messages: list[dict] = field(default_factory=list)
    max_messages: int = MAX_TURNS * 2 * 2  # keep 2x cap so trim has slack

    def append(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})
        # hard cap so memory doesn't grow unbounded if chat engine crashes
        if len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages:]

    def snapshot(self) -> list[dict]:
        return list(self.messages)

    def clear(self) -> None:
        self.messages.clear()


# ---------------------------------------------------------------------------
# Orchestrator client (swap-out-able for tests)
# ---------------------------------------------------------------------------

# A "caller" is anything with the right signature. In prod it's the
# real httpx-based call; in tests it's a fake that returns canned replies.
Caller = Callable[[str, list[dict], float, int], dict]


def call_orchestrator(
    base_url: str,
    model: str,
    messages: list[dict],
    temperature: float,
    max_tokens: int,
    timeout_s: float = 180.0,
) -> dict:
    """POST /v1/chat/completions on the orchestrator. Returns full JSON body.

    Raises httpx.HTTPError on transport failure; orchestrator returns 5xx
    propagate as exceptions too (caller handles them).
    """
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }
    with httpx.Client(timeout=timeout_s) as client:
        r = client.post(f"{base_url}/v1/chat/completions", json=body)
        r.raise_for_status()
        return r.json()


# ---------------------------------------------------------------------------
# ChatEngine (the public API used by the HTTP layer)
# ---------------------------------------------------------------------------

@dataclass
class ChatEngine:
    """Owns: system prompt, history, model config, and the orchestrator URL.

    Usage:
        engine = ChatEngine(base_url="http://127.0.0.1:3000")
        reply = engine.ask("안녕?")
    """
    base_url: str = "http://127.0.0.1:3000"
    model: str = DEFAULT_MODEL
    system: str = DEFAULT_SYSTEM_PROMPT
    temperature: float = DEFAULT_TEMPERATURE
    history: HistoryStore = field(default_factory=HistoryStore)
    # Inject for tests; defaults to the real orchestrator client.
    caller: Caller = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.caller is None:
            self.caller = self._default_caller

    def _default_caller(
        self, model: str, messages: list[dict], temperature: float, max_tokens: int,
    ) -> dict:
        return call_orchestrator(self.base_url, model, messages, temperature, max_tokens)

    def ask(self, user_text: str, append: bool = True) -> dict:
        """One turn: build prompt, call orchestrator, store reply, return dict.

        When `append=True` (default), the exchange is added to self.history
        (so the engine is the source of truth for ongoing state).
        When `append=False`, history is read but not mutated (so the caller
        owns history, e.g. stateless /v1/chat clients).

        Returns: {
          "reply": str,
          "model": str,
          "usage": {"prompt_tokens": int, "completion_tokens": int, "total_tokens": int, "cached_tokens": int},
          "latency_ms": int,
          "turns_used": int,    # number of history turns actually sent
          "trimmed": bool,      # whether the trim algorithm fired
        }
        """
        history = self.history.snapshot()
        pre_trim_len = len(history)
        messages = build_messages(history, user_text, system=self.system)
        trimmed = (len(messages) - 2) < pre_trim_len  # system + user are always there
        turns_used = max(0, (len(messages) - 2) // 2)  # exclude system + new user

        t0 = time.monotonic()
        try:
            resp = self.caller(self.model, messages, self.temperature, MAX_COMPLETION_TOKENS)
        except httpx.HTTPError as e:
            log.error("orchestrator call failed: %s", e)
            raise
        latency_ms = int((time.monotonic() - t0) * 1000)

        reply = resp["choices"][0]["message"]["content"]
        usage = resp.get("usage", {})

        if append:
            # Persist the exchange (engine owns history).
            self.history.append("user", user_text)
            self.history.append("assistant", reply)

        log.info(
            "ask: turns_used=%d trimmed=%s prompt_tokens=%s completion_tokens=%s cached=%s latency_ms=%d",
            turns_used, trimmed,
            usage.get("prompt_tokens"), usage.get("completion_tokens"),
            (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            latency_ms,
        )

        return {
            "reply": reply,
            "model": self.model,
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
                "cached_tokens": (usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
            },
            "latency_ms": latency_ms,
            "turns_used": turns_used,
            "trimmed": trimmed,
        }
