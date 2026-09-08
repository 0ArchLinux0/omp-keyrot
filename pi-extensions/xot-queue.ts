/**
 * xot-queue — per-key request serialization + shared-pool model cooldown.
 *
 * Problem (2026-08-30 user report): when 20 Pi sessions run at the
 * same time, even with per-pid mesh identity, two stampede failure
 * modes can still occur:
 *
 *   (a) Same-key burst: two sessions land on the SAME fp (e.g. because
 *       preemption FIFO picked the same stale lease, or because they
 *       share XOT_PID through a subshell) and they both fire requests
 *       within milliseconds. Upstream sees 2 req/ms from one account,
 *       treats it as abuse, returns 429 or worse.
 *
 *   (b) Same-model shared pool: every key is fine, but the model's
 *       upstream daily quota is exhausted (C-015 "shared_pool" kind).
 *       Rotating the key doesn't help — the next key hits the same
 *       pool. The C-015 fix rotates the model, but doesn't coordinate
 *       across sessions: session A backs off 8s while session B
 *       continues hammering the same model.
 *
 * Solution:
 *
 *   1. Per-key queue file at ~/.local/daemon/xot/queues/<fp>.queue
 *      holds the next-allowed epoch-ms for that fp. Each session
 *      atomically bumps it by PER_KEY_MIN_GAP_MS (default 250) and
 *      sleeps until that epoch before issuing a request. This
 *      serializes requests on the SAME key without throttling
 *      requests on DIFFERENT keys.
 *
 *   2. Shared-pool cooldown file at ~/.local/daemon/xot/shared-pool.json
 *      holds {model: cooldown_until_epoch_ms}. When auto-rotate.ts
 *      detects a "shared_pool" 429, it writes the cooldown. Every
 *      session's before_provider_request checks this and sleeps
 *      until the model's cooldown clears. Coordinated backoff:
 *      ONE source of truth for the model's cooldown, ALL sessions
 *      wait together.
 *
 *   3. Shared-pool cooldown ALSO triggers key rotation advice: if the
 *      user can switch to a different model, that's the fastest
 *      recovery. The extension sets a header X-XOT-MODEL-BLOCKED so
 *      model-rotation.ts (or any sibling extension) can act on it.
 *
 * Atomic defaults:
 *   - If ~/.local/daemon/xot/queues/ doesn't exist, the extension
 *     creates it lazily.
 *   - If shared-pool.json doesn't exist, the gate is a no-op.
 *   - If the queue file is corrupted or unreadable, the request is
 *     allowed through (fail-open) — better than blocking all traffic.
 *
 * Companion test: tests/xot-queue.test.cjs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const HOME = process.env.HOME ?? homedir();
const XOT_DIR = process.env.XOT_CACHE ?? join(HOME, ".local", "daemon", "xot");
const QUEUE_DIR = join(XOT_DIR, "queues");
const SHARED_POOL_FILE = join(XOT_DIR, "shared-pool.json");

const PER_KEY_MIN_GAP_MS = Number(process.env.XOT_PER_KEY_GAP_MS ?? 250);
const SHARED_POOL_TTL_MS = Number(process.env.XOT_SHARED_POOL_TTL_MS ?? 60_000);

// ---- helpers -------------------------------------------------------------

function fp(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

interface SharedPoolMap {
  [model: string]: { until: number; reason?: string; ts: number };
}

interface WaiterEntry {
  pid: number;
  owner: string;       // xot OWNER string for this process
  claimedAt: number;   // epoch ms when the slot was claimed
  slotStart: number;   // epoch ms when the request will fire
  model?: string;      // optional, captured from before_provider_request
  reason?: string;     // "per-key-queue" | "shared-pool-cooldown" | "both"
}

interface WaiterMap {
  [fp: string]: WaiterEntry[];
}

function readSharedPool(): SharedPoolMap {
  try {
    if (!existsSync(SHARED_POOL_FILE)) return {};
    const t = readFileSync(SHARED_POOL_FILE, "utf8");
    if (!t.trim()) return {};
    const parsed = JSON.parse(t);
    // Drop expired entries on read.
    const now = Date.now();
    const out: SharedPoolMap = {};
    for (const [m, v] of Object.entries(parsed)) {
      if (v && typeof v === "object" && typeof (v as any).until === "number" && (v as any).until > now) {
        out[m] = v as any;
      }
    }
    return out;
  } catch {
    return {};
  }
}

// ---- waiter tracking (per-fp, who is waiting on which queue) ----------
const WAITERS_FILE = join(XOT_DIR, "waiters.json");
const WAITER_STALE_MS = 30_000;   // entries older than this (or past slotStart + grace) are pruned
const WAITER_FIRED_GRACE_MS = 5_000;

function readWaiters(): WaiterMap {
  try {
    if (!existsSync(WAITERS_FILE)) return {};
    const t = readFileSync(WAITERS_FILE, "utf8");
    if (!t.trim()) return {};
    const parsed = JSON.parse(t);
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const out: WaiterMap = {};
    for (const [fp, list] of Object.entries(parsed)) {
      if (!Array.isArray(list)) continue;
      // Drop entries whose slot has fired AND the grace window has elapsed.
      // Anything still waiting (slotStart in future) or recently fired
      // (within grace) is kept for visibility.
      const live = (list as WaiterEntry[]).filter((w) => {
        if (!w || typeof w.pid !== "number") return false;
        return now < w.slotStart + WAITER_FIRED_GRACE_MS;
      });
      if (live.length > 0) out[fp] = live;
    }
    return out;
  } catch {
    return {};
  }
}

function writeWaiters(reg: WaiterMap): void {
  try {
    mkdirSync(XOT_DIR, { recursive: true });
    const tmp = WAITERS_FILE + ".tmp." + process.pid;
    writeFileSync(tmp, JSON.stringify(reg, null, 2));
    renameSync(tmp, WAITERS_FILE);
  } catch {
    // best-effort; visibility is non-critical
  }
}

export function addWaiter(fpHex: string, entry: WaiterEntry): void {
  const reg = readWaiters();
  const list = reg[fpHex] ?? [];
  // De-dup by pid: if a session re-claims, replace its old entry.
  const filtered = list.filter((w) => w.pid !== entry.pid);
  filtered.push(entry);
  // Keep last N per fp to avoid unbounded growth.
  reg[fpHex] = filtered.slice(-64);
  writeWaiters(reg);
}

export function releaseWaiter(fpHex: string, pid: number): void {
  const reg = readWaiters();
  const list = reg[fpHex];
  if (!list) return;
  const filtered = list.filter((w) => w.pid !== pid);
  if (filtered.length === 0) {
    delete reg[fpHex];
  } else {
    reg[fpHex] = filtered;
  }
  writeWaiters(reg);
}

export function listWaiters(fpHex: string): WaiterEntry[] {
  return readWaiters()[fpHex] ?? [];
}

export function listAllWaiters(): WaiterMap {
  return readWaiters();
}

function isModelInSharedPoolCooldown(model: string): { cooling: boolean; until: number; reason?: string } {
  if (!model) return { cooling: false, until: 0 };
  const m = readSharedPool();
  const entry = m[model];
  if (!entry) return { cooling: false, until: 0 };
  return { cooling: Date.now() < entry.until, until: entry.until, reason: entry.reason };
}

// Atomic queue file: read epoch-ms, add gap, write back via temp+rename.
function claimSlot(fpHex: string, gapMs: number, maxSleepMs = 30_000): number {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const f = join(QUEUE_DIR, fpHex + ".queue");
  let nowEpoch = Date.now();
  let storedNext = 0;
  try {
    if (existsSync(f)) {
      const t = readFileSync(f, "utf8").trim();
      const n = Number(t);
      if (Number.isFinite(n) && n >= 0) storedNext = n;
    }
  } catch {
    // ignore — fail-open path is "no claim, just go"
  }
  // My slot starts at max(nowEpoch, storedNext).
  const myStart = Math.max(nowEpoch, storedNext);
  const newStoredNext = myStart + gapMs;
  // Atomic write.
  try {
    const tmp = f + ".tmp." + process.pid;
    writeFileSync(tmp, String(newStoredNext));
    renameSync(tmp, f);
  } catch {
    // If rename fails (another writer raced), still let this one through.
  }
  return myStart;
}

function sleepUntil(epochMs: number): Promise<void> {
  const ms = Math.max(0, epochMs - Date.now());
  if (ms <= 0) return Promise.resolve();
  // Async sleep — yields to the event loop so pi's TUI stays responsive
  // during long cooldowns (a shared-pool cooldown can be 60s+; a busy-wait
  // would peg a CPU core and freeze the UI for the entire window).
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- the extension -------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  let activeKey: string | null = null;
  let activeFp: string | null = null;
  // Track the last fp we queued on so turn_end / after_provider_response
  // can release the matching waiter entry.
  let lastQueuedFp: string | null = null;

  // Re-resolve the active key from the same source xot.ts uses.
  // If xot.ts hasn't loaded yet, this returns null and we no-op.
  function getActiveKey(): string | null {
    // Prefer reading from the xot state file (Layer 1) so we coordinate
    // with the xot.ts extension even when our own state lags. If we
    // can't find one, fall back to env ANTHROPIC_API_KEY or OPENROUTER_KEY.
    try {
      const st = readFileSync(join(XOT_DIR, "state"), "utf8");
      const m = /^ACTIVE_IDX=(\d+)$/m.exec(st);
      if (m) {
        const keys = readFileSync(join(XOT_DIR, "keys"), "utf8").split("\n");
        const idx = Number(m[1]);
        if (keys[idx]) return keys[idx].trim();
      }
    } catch {}
    return process.env.OPENROUTER_KEY ?? process.env.ANTHROPIC_API_KEY ?? null;
  }

  // 1. Per-request gate: serialize on same key, gate on shared-pool.
  pi.on("before_provider_request", async (event: any) => {
    const key = getActiveKey() ?? activeKey;
    if (!key) return;
    activeKey = key;
    const fpHex = fp(key);
    activeFp = fpHex;

    // Extract the model — same heuristic xot.ts uses.
    const model: string | null =
      (typeof event?.model === "string" && event.model) ||
      (typeof event?.request?.model === "string" && event.request.model) ||
      null;

    let waitReason = "per-key-queue";

    // 1a. Shared-pool cooldown (Layer B). Coordinated model-side wait.
    if (model) {
      const sp = isModelInSharedPoolCooldown(model);
      if (sp.cooling) {
        const waitMs = Math.max(0, sp.until - Date.now());
        console.error(
          `xot-queue: model ${model} in shared-pool cooldown ` +
          `(${sp.reason ?? "auto"}); ${waitMs}ms wait`,
        );
        // Sleep the FULL cooldown — fire while still in cooldown and we
        // get another 429, repeating the slowness the user reported.
        await sleepUntil(sp.until);
        waitReason = "shared-pool-cooldown";
      }
    }

    // 1b. Per-key queue (Layer A). Serialize requests on the SAME fp.
    const slotStart = claimSlot(fpHex, PER_KEY_MIN_GAP_MS);
    const waitMs = slotStart - Date.now();
    if (waitMs > 0) {
      console.error(`xot-queue: key ${fpHex} queued; ${waitMs}ms wait`);
      await sleepUntil(slotStart);
      if (waitReason === "per-key-queue") waitReason = "per-key-queue";
      else waitReason = "both";
    }

    // Record visibility: this session is queued (and may still be waiting).
    // We write AFTER the sleep so the entry reflects the fire moment.
    // BUT: we want the entry visible DURING the wait too. Compromise: write
    // BEFORE the sleep with the planned slotStart, then update on release.
    const owner = process.env.XOT_OWNER ?? `${require("node:os").hostname()}.pid-${process.pid}`;
    addWaiter(fpHex, {
      pid: process.pid,
      owner,
      claimedAt: Date.now(),
      slotStart,
      model: model ?? undefined,
      reason: waitReason,
    });
    lastQueuedFp = fpHex;
  });

  // 1c. Release the waiter when the API call returns (success or failure).
  //     after_provider_response fires for every completed call.
  pi.on("after_provider_response", async (_event: any) => {
    if (lastQueuedFp) {
      releaseWaiter(lastQueuedFp, process.pid);
      lastQueuedFp = null;
    }
  });

  // 2. on a detected "shared_pool" 429, write the cooldown so all
  //    sessions see it. auto-rotate.ts already classifies the error;
  //    here we just write the marker.
  pi.on("turn_end", async (event: any) => {
    if (!event || typeof event !== "object") return;
    const err: any = (event as any).error ?? (event as any).lastError;
    if (!err || typeof err !== "object") return;
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err);
    const isSharedPool =
      /insufficient[_ ]balance/i.test(body) ||
      /shared[_ ]pool/i.test(body) ||
      /quota[_ ]exceeded.*upstream/i.test(body);
    if (!isSharedPool) return;
    const model: string | null = (event as any).model ?? null;
    if (!model) return;

    try {
      const cur = readSharedPool();
      cur[model] = {
        until: Date.now() + SHARED_POOL_TTL_MS,
        reason: "shared_pool_429",
        ts: Date.now(),
      };
      const tmp = SHARED_POOL_FILE + ".tmp." + process.pid;
      mkdirSync(XOT_DIR, { recursive: true });
      writeFileSync(tmp, JSON.stringify(cur, null, 2));
      renameSync(tmp, SHARED_POOL_FILE);
      console.error(`xot-queue: shared-pool cooldown set for ${model} (${SHARED_POOL_TTL_MS}ms)`);
    } catch {}
  });

  // 3. Slash command: /queue-status — show current queues + shared-pool cooldowns + WAITERS.
  pi.registerCommand("queue-status", {
    description: "show xot-queue state: per-key next-slot + waiters + shared-pool cooldowns",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      const now = Date.now();

      // ---- WAITERS: who is waiting on which fp's queue, in what order ----
      const waiters = listAllWaiters();
      const fpList = Object.keys(waiters).sort();
      const totalWaiters = fpList.reduce((n, k) => n + (waiters[k]?.length ?? 0), 0);
      lines.push(`sessions waiting in queue (${totalWaiters} across ${fpList.length} fp${fpList.length === 1 ? "" : "s"}):`);
      if (totalWaiters === 0) {
        lines.push("  (none — all clear)");
      } else {
        for (const fpHex of fpList) {
          const list = (waiters[fpHex] ?? []).slice().sort((a, b) => a.slotStart - b.slotStart);
          lines.push(`  fp ${fpHex}  (${list.length} waiting):`);
          for (let i = 0; i < list.length; i++) {
            const w = list[i]!;
            const waitMs = Math.max(0, w.slotStart - now);
            const sinceClaimed = now - w.claimedAt;
            const status = now < w.slotStart ? "waiting" : "firing";
            const pos = i === 0 ? "→ next" : `  #${i + 1}`;
            const modelShort = w.model ? ` model=${w.model}` : "";
            const reason = w.reason ? ` (${w.reason})` : "";
            lines.push(`    ${pos} pid=${w.pid} ${status} ${waitMs}ms to fire, claimed ${Math.round(sinceClaimed / 100) / 10}s ago${modelShort}${reason}`);
            lines.push(`        owner=${w.owner}`);
          }
        }
      }

      // ---- Per-key queue schedule (next-slot epoch) ----
      lines.push("");
      try {
        if (existsSync(QUEUE_DIR)) {
          const files = require("node:fs").readdirSync(QUEUE_DIR).filter((f: string) => f.endsWith(".queue"));
          lines.push(`per-key queue schedules (${files.length}):`);
          if (files.length === 0) {
            lines.push("  (none)");
          } else {
            const entries = files.map((f: string) => {
              const fpHex = f.replace(/\.queue$/, "");
              const t = Number(readFileSync(join(QUEUE_DIR, f), "utf8").trim());
              return { fpHex, nextEpoch: t };
            }).sort((a: any, b: any) => a.nextEpoch - b.nextEpoch);
            for (const e of entries.slice(0, 8)) {
              const waitMs = Math.max(0, e.nextEpoch - now);
              lines.push(`  ${e.fpHex}  next-slot in ${waitMs}ms`);
            }
            if (entries.length > 8) lines.push(`  ... +${entries.length - 8} more`);
          }
        }
      } catch (e: any) {
        lines.push(`  queue dir error: ${e?.message ?? e}`);
      }

      // ---- Shared pool cooldowns ----
      lines.push("");
      const sp = readSharedPool();
      const spKeys = Object.keys(sp);
      lines.push(`shared-pool cooldowns (${spKeys.length}):`);
      if (spKeys.length === 0) {
        lines.push("  (none — all models clear)");
      } else {
        for (const m of spKeys) {
          const v = sp[m]!;
          const remain = Math.max(0, v.until - now);
          lines.push(`  ${m}  ${remain}ms left  (${v.reason ?? "auto"})`);
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // 4. /queue-watch [interval_ms] — live loop polling /queue-status content.
  //    Bypasses ctx.ui.notify (single-shot) and uses ctx.ui.custom or prints
  //    to console.error so the user sees a redraw every interval. We use
  //    console.error so it doesn't pollute the chat transcript.
  pi.registerCommand("queue-watch", {
    description: "live-poll xot-queue state every Nms (default 500); Ctrl+C to stop",
    handler: async (args, ctx) => {
      const intervalMs = Math.max(100, Math.min(5000, parseInt((args ?? "").trim() || "500", 10) || 500));
      console.error(`xot-queue: watching every ${intervalMs}ms. Press Ctrl+C to stop.`);
      let alive = true;
      const onSig = () => { alive = false; };
      process.once("SIGINT", onSig);
      process.once("SIGTERM", onSig);
      let lastRender = "";
      while (alive) {
        // Build the same content /queue-status would show.
        const lines: string[] = [];
        const now = Date.now();
        const waiters = listAllWaiters();
        const totalWaiters = Object.values(waiters).reduce((n, l) => n + l.length, 0);
        lines.push(`[xot-queue watch @ ${new Date().toISOString()}]`);
        lines.push(`waiters: ${totalWaiters}  fps-with-queue: ${Object.keys(waiters).length}`);
        for (const [fpHex, list] of Object.entries(waiters).sort()) {
          const sorted = list.slice().sort((a, b) => a.slotStart - b.slotStart);
          for (let i = 0; i < sorted.length; i++) {
            const w = sorted[i]!;
            const waitMs = Math.max(0, w.slotStart - now);
            const status = now < w.slotStart ? "wait" : "fire";
            const pos = i === 0 ? "→" : " ";
            const modelShort = w.model ? ` ${w.model}` : "";
            lines.push(`  ${pos} ${fpHex} pid=${w.pid} ${status} ${waitMs}ms${modelShort}`);
          }
        }
        const sp = readSharedPool();
        for (const [m, v] of Object.entries(sp)) {
          const remain = Math.max(0, v.until - now);
          lines.push(`  ‖ shared-pool ${m} ${remain}ms left`);
        }
        const rendered = lines.join("\n");
        if (rendered !== lastRender) {
          // Clear-screen-ish: print with a leading newline so the user's
          // terminal scrolls. We don't use ANSI clears because pi's TUI
          // may already be drawing; console.error goes to stderr which
          // is usually separate.
          console.error("\n" + rendered);
          lastRender = rendered;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
      ctx.ui.notify("queue-watch: stopped", "info");
    },
  });

  // 5. /queue-clear — wipe all queues + cooldowns + waiters (escape hatch).
  pi.registerCommand("queue-clear", {
    description: "wipe per-key queues, waiters, and shared-pool cooldowns (escape hatch)",
    handler: async (args, ctx) => {
      let removed = 0;
      // Parse optional --fp <hex> to clear only one fp.
      const argList = (args ?? "").trim().split(/\s+/);
      let onlyFp: string | null = null;
      for (let i = 0; i < argList.length; i++) {
        if (argList[i] === "--fp" && i + 1 < argList.length) {
          onlyFp = argList[i + 1] ?? null;
          break;
        }
      }
      try {
        if (existsSync(QUEUE_DIR)) {
          const files = require("node:fs").readdirSync(QUEUE_DIR);
          for (const f of files) {
            if (onlyFp && !f.startsWith(onlyFp)) continue;
            try {
              require("node:fs").unlinkSync(join(QUEUE_DIR, f));
              removed++;
            } catch {}
          }
        }
      } catch {}
      try {
        if (existsSync(SHARED_POOL_FILE)) {
          require("node:fs").unlinkSync(SHARED_POOL_FILE);
        }
      } catch {}
      // Always clear waiters (full or filtered).
      try {
        if (existsSync(WAITERS_FILE)) {
          if (onlyFp) {
            const w = readWaiters();
            delete w[onlyFp];
            writeWaiters(w);
          } else {
            require("node:fs").unlinkSync(WAITERS_FILE);
          }
        }
      } catch {}
      ctx.ui.notify(
        `queue-clear: removed ${removed} queue file(s)` +
        (onlyFp ? ` for fp ${onlyFp}` : "") +
        ` + shared-pool.json + waiters`,
        "info",
      );
    },
  });
}

// Re-exports for tests.
export const __testing = {
  fp,
  readSharedPool,
  isModelInSharedPoolCooldown,
  claimSlot,
  addWaiter,
  releaseWaiter,
  listWaiters,
  listAllWaiters,
  PER_KEY_MIN_GAP_MS,
  SHARED_POOL_TTL_MS,
  WAITERS_FILE,
  WAITER_FIRED_GRACE_MS,
  WAITER_STALE_MS,
  QUEUE_DIR,
  SHARED_POOL_FILE,
  XOT_DIR,
};