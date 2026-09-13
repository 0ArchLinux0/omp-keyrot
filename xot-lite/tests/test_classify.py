#!/usr/bin/env python3
"""Sanity tests for 429 classification and rotate-on-cap policy (no live API).

Covers the 2026-09-14 failure: empty-body 429 + retry.maxDelayMs abort did not
cool/bump, then /retry reused a cooled env key.
"""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROT = ROOT / "bin" / "xot-rotate"
EXT = ROOT / "extensions" / "key-rotate-lite.ts"

MAXDELAY = (
    "Retry failed after 1 attempts: Provider requested 13265929ms wait, "
    "exceeds retry.maxDelayMs (300000ms). Original error: 429 Rate limit "
    "exceeded: free-models-per-day. Add 10 credits to unlock 1000 free "
    "model requests per day retry-after-ms=13265929"
)


def classify(text: str) -> str:
    env = os.environ.copy()
    env["XOT_HOME"] = tempfile.mkdtemp()
    out = subprocess.check_output([str(ROT), "classify", text], text=True, env=env)
    return out.strip()


class TestXotRotateClassify(unittest.TestCase):
    def test_empty_429_is_daily(self):
        self.assertEqual(classify("429"), "daily")

    def test_http_429_is_daily(self):
        self.assertEqual(classify("HTTP 429"), "daily")

    def test_high_balance_is_daily(self):
        self.assertEqual(
            classify("429 Rate limit exceeded: free-models-per-day-high-balance"),
            "daily",
        )

    def test_add_10_credits_is_daily(self):
        self.assertEqual(
            classify("Add 10 credits to unlock 1000 free model requests per day"),
            "daily",
        )

    def test_maxdelay_composite_is_daily(self):
        self.assertEqual(classify(MAXDELAY), "daily")

    def test_shared_pool_not_daily(self):
        self.assertEqual(classify("upstream provider shared pool exhausted"), "shared")

    def test_unrelated_is_other(self):
        self.assertEqual(classify("socket hang up"), "other")

    def test_openrouter_free_router_same_counter(self):
        """openrouter/openrouter:free is a router, not a second quota pool."""
        self.assertEqual(
            classify(
                "429 Rate limit exceeded: free-models-per-day "
                "(model=openrouter/openrouter:free)"
            ),
            "daily",
        )


class TestKeyRotateLiteSourceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = EXT.read_text()

    def test_empty_429_classified_daily(self):
        self.assertIn('if (status === 429 || HTTP_429_RE.test(b)) return "daily"', self.src)

    def test_maxdelay_classified_daily(self):
        self.assertIn("MAX_DELAY_RE", self.src)
        self.assertRegex(self.src, r'MAX_DELAY_RE\.test\(b\).*return "daily"', re.S)

    def test_add_10_credits_in_daily_regex(self):
        self.assertIn("add 10 credits", self.src.lower())

    def test_acquire_does_not_reuse_env_on_failure(self):
        m = re.search(
            r"function acquireKey\(sessionId: string\): string \| null \{.*?^\}\n",
            self.src,
            re.S | re.M,
        )
        self.assertIsNotNone(m)
        body = m.group(0)
        catch = body[body.find("catch") :]
        self.assertIn("return null", catch)
        self.assertNotIn("OPENROUTER_API_KEY", catch)

    def test_hooks_rotate_after_omp_retry_abort(self):
        for hook in (
            '"turn_end"',
            '"agent_end"',
            '"agent_settled"',
            '"after_provider_response"',
        ):
            self.assertIn(hook, self.src, f"missing hook {hook}")
        self.assertIn("sendUserMessage", self.src)
        self.assertIn("dropStaleKey", self.src)
        self.assertIn("bumpKey", self.src)

    def test_rotate_alias_registered(self):
        self.assertIn('pi.registerCommand("rotate"', self.src)

    def test_after_provider_has_no_body_comment(self):
        self.assertIn("after_provider_response has status+headers only", self.src)


if __name__ == "__main__":
    unittest.main()
