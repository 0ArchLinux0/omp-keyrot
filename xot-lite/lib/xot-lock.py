#!/usr/bin/env python3
"""XOT session key locks — one OpenRouter key per OMP session (auto-assign)."""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

XOT_HOME = Path(os.environ.get("XOT_HOME", Path.home() / ".local/daemon/xot"))
REGISTRY = Path(os.environ.get("XOT_LOCK_REGISTRY", XOT_HOME / "locks/registry.json"))
KEY_FILE = Path(os.environ.get("XOT_KEY_FILE", XOT_HOME / "keys"))
STATE_FILE = Path(os.environ.get("XOT_STATE_FILE", XOT_HOME / "state"))
PRIMARY_IDX = int(os.environ.get("PRIMARY_IDX", "0"))
STALE_SECS = int(os.environ.get("XOT_LOCK_STALE_SECS", "300"))


def _load_keys() -> list[str]:
    if not KEY_FILE.is_file():
        return []
    return [
        line.strip()
        for line in KEY_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def _key_fp(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def _cooling(idx: int, keys: list[str], now: int) -> bool:
    if idx < 0 or idx >= len(keys):
        return True
    fp = _key_fp(keys[idx])
    if not STATE_FILE.is_file():
        return False
    for line in STATE_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"COOL_{fp}="):
            try:
                until = int(line.split("=", 1)[1])
            except ValueError:
                continue
            if until > now:
                return True
    return False


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _load_registry() -> dict:
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    if not REGISTRY.is_file():
        return {"version": 1, "sessions": {}}
    try:
        data = json.loads(REGISTRY.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        data = {"version": 1, "sessions": {}}
    if "sessions" not in data:
        data["sessions"] = {}
    return data


def _save_registry(data: dict) -> None:
    REGISTRY.parent.mkdir(parents=True, exist_ok=True)
    tmp = REGISTRY.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(REGISTRY)


def _label(idx: int) -> str:
    return f"KEY_{idx + 1:02d}"


def prune(data: dict | None = None, persist: bool = False) -> dict:
    data = data if data is not None else _load_registry()
    now = int(time.time())
    sessions = data.get("sessions", {})
    kept: dict = {}
    for sid, entry in sessions.items():
        pid = int(entry.get("pid", 0))
        hb = int(entry.get("heartbeat", entry.get("acquired_at", 0)))
        if _pid_alive(pid) and (now - hb) <= STALE_SECS:
            kept[sid] = entry
    data["sessions"] = kept
    if persist:
        _save_registry(data)
    return data


def _owner_of_idx(data: dict, idx: int, except_sid: str | None = None) -> str | None:
    now = int(time.time())
    for sid, entry in data.get("sessions", {}).items():
        if except_sid and sid == except_sid:
            continue
        if int(entry.get("key_idx", -1)) != idx:
            continue
        pid = int(entry.get("pid", 0))
        hb = int(entry.get("heartbeat", entry.get("acquired_at", 0)))
        if _pid_alive(pid) and (now - hb) <= STALE_SECS:
            return sid
    return None


def _assign(data: dict, session_id: str, idx: int, pid: int, forced: bool = False) -> int:
    now = int(time.time())
    data.setdefault("sessions", {})[session_id] = {
        "key_idx": idx,
        "pid": pid,
        "acquired_at": now,
        "heartbeat": now,
        "label": _label(idx),
        **({"forced": True} if forced else {}),
    }
    _save_registry(data)
    return idx


def acquire(session_id: str, pid: int, skip_idx: int | None = None) -> int:
    keys = _load_keys()
    if not keys:
        return -1
    data = prune()
    now = int(time.time())
    sessions = data["sessions"]

    cur = sessions.get(session_id)
    if cur is not None:
        idx = int(cur.get("key_idx", -1))
        if (
            0 <= idx < len(keys)
            and not _cooling(idx, keys, now)
            and (skip_idx is None or idx != skip_idx)
        ):
            cur["pid"] = pid
            cur["heartbeat"] = now
            sessions[session_id] = cur
            _save_registry(data)
            return idx

    order = [PRIMARY_IDX] + [i for i in range(len(keys)) if i != PRIMARY_IDX]
    for idx in order:
        if skip_idx is not None and idx == skip_idx:
            continue
        if _cooling(idx, keys, now):
            continue
        if _owner_of_idx(data, idx, except_sid=session_id):
            continue
        return _assign(data, session_id, idx, pid)
    return -1


def bump(session_id: str, pid: int) -> int:
    data = prune()
    cur = data.get("sessions", {}).get(session_id)
    skip = int(cur.get("key_idx", -1)) if cur else None
    return acquire(session_id, pid, skip_idx=skip)


def force(session_id: str, key_idx: int, pid: int) -> int:
    keys = _load_keys()
    if key_idx < 0 or key_idx >= len(keys):
        return -1
    data = prune()
    for sid, entry in list(data["sessions"].items()):
        if sid != session_id and int(entry.get("key_idx", -1)) == key_idx:
            del data["sessions"][sid]
    return _assign(data, session_id, key_idx, pid, forced=True)


def release(session_id: str) -> bool:
    data = _load_registry()
    if session_id in data.get("sessions", {}):
        del data["sessions"][session_id]
        _save_registry(data)
        return True
    return False


def heartbeat(session_id: str, pid: int) -> bool:
    data = _load_registry()
    entry = data.get("sessions", {}).get(session_id)
    if not entry:
        return False
    entry["heartbeat"] = int(time.time())
    entry["pid"] = pid
    data["sessions"][session_id] = entry
    _save_registry(data)
    return True


def locked_indices() -> list[int]:
    data = prune()
    out: list[int] = []
    for entry in data.get("sessions", {}).values():
        try:
            out.append(int(entry.get("key_idx", -1)))
        except (TypeError, ValueError):
            continue
    return [i for i in out if i >= 0]


def status_text() -> str:
    data = prune(persist=True)
    keys = _load_keys()
    now = int(time.time())
    lines = ["SESSION_LOCKS:"]
    if not data["sessions"]:
        lines.append("  (none)")
    for sid, entry in sorted(data["sessions"].items()):
        idx = int(entry.get("key_idx", -1))
        pid = int(entry.get("pid", 0))
        hb = int(entry.get("heartbeat", 0))
        age = now - hb
        suffix = keys[idx][-4:] if 0 <= idx < len(keys) and len(keys[idx]) >= 4 else "?"
        alive = _pid_alive(pid)
        sid_show = sid if len(sid) <= 16 else sid[:12] + "…"
        lines.append(
            f"  {sid_show} -> {_label(idx)} ...{suffix} pid={pid} "
            f"{'alive' if alive else 'dead'} hb={age}s ago"
        )
    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: xot-lock.py {acquire|release|force|bump|heartbeat|prune|status|locked} ...",
            file=sys.stderr,
        )
        return 1
    cmd = sys.argv[1]
    if cmd == "acquire":
        if len(sys.argv) < 4:
            print("usage: xot-lock.py acquire <session_id> <pid>", file=sys.stderr)
            return 1
        idx = acquire(sys.argv[2], int(sys.argv[3]))
        print(idx)
        return 0 if idx >= 0 else 2
    if cmd == "bump":
        if len(sys.argv) < 4:
            print("usage: xot-lock.py bump <session_id> <pid>", file=sys.stderr)
            return 1
        idx = bump(sys.argv[2], int(sys.argv[3]))
        print(idx)
        return 0 if idx >= 0 else 2
    if cmd == "release":
        if len(sys.argv) < 3:
            print("usage: xot-lock.py release <session_id>", file=sys.stderr)
            return 1
        release(sys.argv[2])
        return 0
    if cmd == "force":
        if len(sys.argv) < 5:
            print("usage: xot-lock.py force <session_id> <key_idx> <pid>", file=sys.stderr)
            return 1
        idx = force(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
        print(idx)
        return 0 if idx >= 0 else 2
    if cmd == "heartbeat":
        if len(sys.argv) < 4:
            print("usage: xot-lock.py heartbeat <session_id> <pid>", file=sys.stderr)
            return 1
        ok = heartbeat(sys.argv[2], int(sys.argv[3]))
        return 0 if ok else 1
    if cmd == "prune":
        prune(persist=True)
        return 0
    if cmd == "status":
        print(status_text())
        return 0
    if cmd == "locked":
        print(" ".join(str(i) for i in locked_indices()))
        return 0
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
