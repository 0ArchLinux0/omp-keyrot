---
name: xot
description: Key rotation daemon slash command. Use /xot [pick|key|status|init|clear|keys] to manage sticky OpenRouter keys, mirror lease state across machines, and display right-aligned middle banners. Now also includes automatic retry/continue when a turn fails due to key exhaustion.
---

# xot

## Commands

```
/xot pick     # rotate + export ANTHROPIC_API_KEY=...
/xot key      # raw active key only
/xot status   # counts + active index
/xot init     # add new keys
/xot keys     # list indices
/xxot clear   # wipe keyring + state
```

## Mesh of Pi windows (per-PID sticky identity)

When you run multiple Pi windows at the same time (same machine or across
machines), the `xot.ts` extension automatically passes
`XOT_PID=<process.pid>` to every `xot` invocation. Each Pi window then
owns its **own** lease in the shared `leases` file, so N windows on one
Mac get N distinct keys instead of all collapsing to one.

Mechanism:

- `OWNER = "<hostname>.pid-<pid>"` per process.
- `claim_set` only drops a prior claim when the same OWNER + same fp —
  peers with different PIDs keep their claims untouched.
- If a new window arrives and all keys are claimed, the oldest claim is
  preempted (lowest `ts`); the pre-empted window re-picks and rebalances
  on its next request.
- A 0..1500 ms random jitter (configurable via `XOT_PEER_BACKOFF_MS`)
  breaks lockstep when N windows all hit the "all cooling" path at once.
- Cross-machine sticky still works: set `XOT_OWNER` explicitly to keep
  a single window's identity independent of its PID (e.g. on
  cron-only usage where the PID changes every run).

You can see the active ownership at any time with `/xot status` or by
reading `~/.local/daemon/xot/leases` directly.

## Continue after key exhaustion

When a turn fails because of key exhaustion, the extension saves the last
user prompt and offers to re-send it. **Default action: continue.**

```
/xot continue           # re-submit the saved prompt
/xot retry-status       # show whether a retry is pending
/xot retry-cancel       # clear the pending retry
/xot simulate-broken-turn  # DEBUG: simulate a broken turn
```

The user can also:
- Type `continue` (or `c`) as a chat message — magic word, intercepts
- Press `Ctrl+Shift+C` for the keyboard shortcut
- Just press `Enter` on the post-turn confirm dialog (default = yes)

State is persisted to `~/.pi/agent/xot-retry.json` (atomic write).
Config in `~/.pi/agent/xot-retry-config.json`.

## Resume / Interruption

Press **Esc** or **Ctrl+C** to interrupt. Lock releases safely. Restart picks up `ACTIVE_IDX` from disk (`state`).
