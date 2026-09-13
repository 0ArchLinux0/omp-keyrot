#!/usr/bin/env python3
"""Unit tests for xot-lock.py isolation (no network)."""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCK_PATH = ROOT / "lib" / "xot-lock.py"


def load_lock(tmp: Path):
    os.environ["XOT_HOME"] = str(tmp)
    os.environ["XOT_KEY_FILE"] = str(tmp / "keys")
    os.environ["XOT_STATE_FILE"] = str(tmp / "state")
    os.environ["XOT_LOCK_REGISTRY"] = str(tmp / "locks" / "registry.json")
    spec = importlib.util.spec_from_file_location("xot_lock", LOCK_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["xot_lock"] = mod
    spec.loader.exec_module(mod)
    return mod


class TestXotLock(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "locks").mkdir()
        keys = "\n".join(f"sk-or-v1-fake{i:02d}{'x'*52}{i:04d}" for i in range(1, 6))
        (self.tmp / "keys").write_text(keys + "\n")
        self.mod = load_lock(self.tmp)
        self.alive = {os.getpid()}
        self.mod._pid_alive = lambda pid: pid in self.alive  # type: ignore

    def test_acquire_distinct_and_sticky(self):
        a = self.mod.acquire("s-a", os.getpid())
        b = self.mod.acquire("s-b", os.getpid())
        c = self.mod.acquire("s-c", os.getpid())
        self.assertEqual(len({a, b, c}), 3)
        self.assertEqual(self.mod.acquire("s-a", os.getpid()), a)

    def test_bump_does_not_move_other_session(self):
        a = self.mod.acquire("s-a", os.getpid())
        b = self.mod.acquire("s-b", os.getpid())
        n = self.mod.bump("s-b", os.getpid())
        self.assertNotEqual(n, b)
        self.assertEqual(self.mod.get_session("s-a"), a)
        self.assertEqual(self.mod.get_session("s-b"), n)

    def test_force_refuses_other_sessions_key(self):
        a = self.mod.acquire("s-a", os.getpid())
        rc = self.mod.force("s-b", a, os.getpid(), steal=False)
        self.assertEqual(rc, -2)
        self.assertEqual(self.mod.get_session("s-a"), a)
        self.assertEqual(self.mod.owner_of(a), "s-a")

    def test_force_own_key_idempotent(self):
        a = self.mod.acquire("s-a", os.getpid())
        rc = self.mod.force("s-a", a, os.getpid(), steal=False)
        self.assertEqual(rc, a)

    def test_force_free_key_does_not_touch_other(self):
        a = self.mod.acquire("s-a", os.getpid())
        b = self.mod.acquire("s-b", os.getpid())
        rc = self.mod.force("s-b", 4, os.getpid())
        self.assertEqual(rc, 4)
        self.assertEqual(self.mod.get_session("s-a"), a)
        self.assertNotEqual(self.mod.get_session("s-a"), b)

    def test_force_steal_flag_evicts(self):
        a = self.mod.acquire("s-a", os.getpid())
        rc = self.mod.force("s-b", a, os.getpid(), steal=True)
        self.assertEqual(rc, a)
        self.assertEqual(self.mod.owner_of(a), "s-b")
        self.assertEqual(self.mod.get_session("s-a"), -1)

    def test_cool_skips_primary(self):
        keys = self.mod._load_keys()
        fp = self.mod._key_fp(keys[0])
        (self.tmp / "state").write_text(f"ACTIVE_IDX=0\nCOOL_{fp}={2**31}\n")
        idx = self.mod.acquire("s-a", os.getpid())
        self.assertNotEqual(idx, 0)

    def test_dead_pid_pruned(self):
        self.mod.force("ghost", 2, 999001, steal=False)
        self.alive.discard(999001)
        data = self.mod.prune(persist=True)
        self.assertNotIn("ghost", data["sessions"])

    def test_idle_live_pid_not_pruned(self):
        a = self.mod.acquire("s-a", os.getpid())
        data = self.mod._load_registry()
        data["sessions"]["s-a"]["heartbeat"] = 0
        self.mod._save_registry(data)
        pruned = self.mod.prune(persist=True)
        self.assertIn("s-a", pruned["sessions"])
        self.assertEqual(pruned["sessions"]["s-a"]["key_idx"], a)


if __name__ == "__main__":
    unittest.main()
