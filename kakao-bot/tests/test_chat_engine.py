"""
test_chat_engine.py — unit tests for chat_engine.py.

Uses a fake orchestrator caller (no real Qwen calls). Run with:
    /home/physics-lab/code_repo/ai-services/venv/bin/python -m unittest \
        /home/physics-lab/code_repo/kakao-bot/tests/test_chat_engine.py

Or via the helper:
    ./tests/run_tests.sh
"""

import json
import unittest
import sys
from pathlib import Path

# Make the parent package importable when running as a script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chat_engine import (
    build_messages,
    estimate_tokens,
    ChatEngine,
    HistoryStore,
    MAX_PROMPT_TOKENS,
    MAX_TURNS,
    DEFAULT_SYSTEM_PROMPT,
)


def make_fake_caller(reply: str = "테스트 응답입니다.", tokens: int = 5):
    """Return a fake orchestrator caller that always replies with `reply`."""
    def caller(model, messages, temperature, max_tokens):
        return {
            "choices": [{"message": {"role": "assistant", "content": reply}}],
            "usage": {
                "prompt_tokens": sum(estimate_tokens([m]) for m in messages),
                "completion_tokens": tokens,
                "total_tokens": sum(estimate_tokens([m]) for m in messages) + tokens,
                "prompt_tokens_details": {"cached_tokens": 0},
            },
            "model": model,
        }
    return caller


class EstimateTokensTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(estimate_tokens([]), 0)

    def test_overhead_only(self):
        # 1 message with empty content: just the 4-token overhead.
        self.assertEqual(estimate_tokens([{"role": "user", "content": ""}]), 4)

    def test_korean_pessimistic(self):
        # 12 Korean chars -> ~12/1.5 = 8 tokens + 4 overhead = 12
        # (off by 1 due to int() rounding; just check it's in the right ballpark)
        msgs = [{"role": "user", "content": "가나다라마바사아자차카"}]
        est = estimate_tokens(msgs)
        self.assertGreaterEqual(est, 11)
        self.assertLessEqual(est, 14)


class BuildMessagesTests(unittest.TestCase):
    def test_single_turn_no_history(self):
        msgs = build_messages([], "안녕?")
        self.assertEqual(len(msgs), 2)  # system + user
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[1]["role"], "user")
        self.assertEqual(msgs[1]["content"], "안녕?")

    def test_system_always_first_and_never_dropped(self):
        # Build a giant history that forces trimming.
        history = [
            {"role": "user", "content": "x" * 1000},
            {"role": "assistant", "content": "y" * 1000},
        ] * 50  # 200 messages, ~30k chars
        msgs = build_messages(history, "새 질문")
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[0]["content"], DEFAULT_SYSTEM_PROMPT)

    def test_pairs_dropped_together(self):
        """Invariant: never leave an orphan assistant reply."""
        history = [
            {"role": "user", "content": "u" * 500},
            {"role": "assistant", "content": "a" * 500},
        ] * 20  # 40 messages, way over budget
        msgs = build_messages(history, "new")
        # Walk through and ensure no assistant immediately follows another assistant,
        # and no user immediately follows another user (except system).
        for i in range(1, len(msgs) - 1):
            self.assertNotEqual(msgs[i]["role"], msgs[i + 1]["role"],
                                f"two {msgs[i]['role']} in a row at index {i}")

    def test_max_turns_cap(self):
        history = []
        for i in range(100):
            history.append({"role": "user", "content": str(i)})
            history.append({"role": "assistant", "content": str(i)})
        msgs = build_messages(history, "new")
        # system + (MAX_TURNS * 2) history + new user
        self.assertEqual(len(msgs), 1 + MAX_TURNS * 2 + 1)

    def test_truncates_user_message_as_last_resort(self):
        # system prompt is huge; history is empty; user msg alone is huge.
        big_system = "S" * (MAX_PROMPT_TOKENS * 2)  # chars; ~ tokens
        msgs = build_messages([], "U" * 1000, system=big_system)
        self.assertEqual(msgs[-1]["role"], "user")
        # Last user message should be shorter than 1000 chars (truncated).
        self.assertLess(len(msgs[-1]["content"]), 1000)


class ChatEngineTests(unittest.TestCase):
    def test_ask_stores_history(self):
        engine = ChatEngine(caller=make_fake_caller())
        engine.ask("첫 질문")
        engine.ask("둘째 질문")
        h = engine.history.snapshot()
        self.assertEqual(len(h), 4)
        self.assertEqual(h[0], {"role": "user", "content": "첫 질문"})
        self.assertEqual(h[1]["role"], "assistant")
        self.assertEqual(h[2], {"role": "user", "content": "둘째 질문"})

    def test_ask_returns_expected_shape(self):
        engine = ChatEngine(caller=make_fake_caller(reply="pong", tokens=2))
        result = engine.ask("ping")
        self.assertEqual(result["reply"], "pong")
        self.assertIn("model", result)
        self.assertIn("usage", result)
        self.assertIn("latency_ms", result)
        self.assertIn("turns_used", result)
        self.assertIn("trimmed", result)
        self.assertGreaterEqual(result["latency_ms"], 0)

    def test_ask_propagates_orchestrator_errors(self):
        def bad_caller(model, messages, temperature, max_tokens):
            raise RuntimeError("orchestrator down")
        engine = ChatEngine(caller=bad_caller)
        with self.assertRaises(RuntimeError):
            engine.ask("hi")
        # And critically: history was NOT mutated on failure.
        self.assertEqual(len(engine.history.snapshot()), 0)


class HistoryStoreTests(unittest.TestCase):
    def test_cap(self):
        h = HistoryStore(max_messages=4)
        for i in range(10):
            h.append("user", str(i))
        self.assertEqual(len(h.messages), 4)
        self.assertEqual(h.messages[0]["content"], "6")

    def test_clear(self):
        h = HistoryStore()
        h.append("user", "x")
        h.clear()
        self.assertEqual(h.messages, [])


if __name__ == "__main__":
    unittest.main()
