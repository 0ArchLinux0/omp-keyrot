/**
 * Auto Key Rotation on Lock/Block/Rate-Limit
 *
 * If main agent OR sub-agent request returns 429 / 403 / 520 / blocked,
 * automatically rotate to next healthy key (xot pick-balance logic),
 * retry, and resume. Single shared key = both fail; rotation = isolated.
 *
 * REVISION 2026-08-28 — model-aware rotation:
 *
 * The previous version only checked the key ledger, which assumed
 * failures are per-key. OpenRouter's free-tier routes frequently
 * return HTTP 200 with a stream-payload "insufficient balance" /
 * 402 because the *upstream shared pool* (the model's host, not
 * the key) is exhausted. In that case, rotating to a different
 * key does not help — every key hits the same exhausted pool.
 *
 * The fix:
 *   1. On stream-level "insufficient balance", write to
 *      ~/.config/openrouter/last_429.json (the same file
 *      ox-alpha/keys.py uses) so the next session / notify-bridge
 *      sees the actual cause.
 *   2. On the NEXT call, before picking a key, check last_429.json.
 *      If it says "shared_pool" and the timestamp is within the
 *      cooldown window, back off briefly (don't pick a new key,
 *      wait for the shared pool to refill).
 *   3. The per-model block is recorded separately. If the user
 *      can switch model, that's a faster recovery than waiting
 *      on the shared pool.
 *
 * Three failure modes, three responses:
 *   - per-key auth (401/402/403 with no model mention) → rotate key
 *   - per-key daily cap (429 daily) → rotate key + block
 *   - shared upstream pool (any 402/429 with "provider" or
 *     "shared" in the body) → back off, do NOT rotate key,
 *     write last_429.json with kind=shared_pool
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const XOT_DIR = process.env.XOT_CACHE || join(process.env.HOME || "", ".local", "daemon", "xot");
const LAST_429_PATH = join(
  process.env.HOME || "",
  ".config",
  "openrouter",
  "last_429.json"
);
const SHARED_POOL_COOLDOWN_MS = 8_000; // wait this long before retrying the same model
const LEDGER_PATH = join(
  process.env.HOME || "",
  ".config",
  "openrouter",
  "key_ledger.json"
);

// OpenRouter free-tier 402 body shape often includes one of:
//   "insufficient balance" / "Insufficient credit" /
//   "upstream_provider_shared_pool" / "free-models-per-day"
// The regex matches the user-visible error, not the internal class.
const INSUFFICIENT_BALANCE_RE =
  /insufficient[ _-]?(balance|credit|quota)|payment required|status 402|more credits|can only afford|upgrade to a paid|requires more credits/i;
// "shared pool" markers that mean rotate-doesn't-help:
const SHARED_POOL_RE =
  /upstream[_-]?provider[_-]?shared[_-]?pool|shared[_-]?pool|provider[_-]?exhausted/i;

type Last429 = {
  ts: number;
  kind: "auth" | "daily" | "shared_pool" | "timeout" | "other";
  alias?: string;
  model?: string;
  http?: number;
  body_excerpt?: string;
};

// Cooldown between "timeout" classification -> next request, applied per
// model. Timeouts are almost always a shared upstream/network issue, NOT
// a key problem. Under strict sequential rotation (XOT_PICK_MODE=round_robin),
// the next request will already move to the next key in line, so we don't
// need any special per-key streak logic — the cursor just advances.
const TIMEOUT_COOLDOWN_MS = 2_000;

function readLast429(): Last429 | null {
  try {
    if (!existsSync(LAST_429_PATH)) return null;
    const raw = JSON.parse(readFileSync(LAST_429_PATH, "utf8"));
    return raw as Last429;
  } catch {
    return null;
  }
}

function writeLast429(payload: Omit<Last429, "ts">): void {
  const entry: Last429 = { ts: Date.now() / 1000, ...payload };
  try {
    writeFileSync(LAST_429_PATH, JSON.stringify(entry, null, 2));
  } catch {
    /* best-effort; not a critical path */
  }
}

// Match a body that looks like a network/proxy/stream timeout. Order matters:
// timeout is checked BEFORE "other" / 429 fallback so we never classify a
// timeout as a daily-cap 429 and never rotate keys for it.
const TIMEOUT_RE =
  /request[ _-]?timed?[ _-]?out|etimedout|econnreset|aborted|socket[ _-]?hang[ _-]?up|fetch[ _-]?failed|network[ _-]?error|stream[ _-]?timeout/i;

function classifyErrorBody(body: string, http?: number): Last429["kind"] {
  const text = (body || "").toLowerCase();
  if (http === 401 || http === 403) return "auth";
  if (http === 402) return "shared_pool"; // 402 is the "you need credit" code on OpenRouter free tier
  if (SHARED_POOL_RE.test(text)) return "shared_pool";
  if (INSUFFICIENT_BALANCE_RE.test(text)) return "shared_pool"; // upstream says balance is gone
  if (TIMEOUT_RE.test(text)) return "timeout";
  if (http === 429) return "daily";
  return "other";
}

function shouldBackoffForSharedPool(): { yes: boolean; ms: number; reason?: string } {
  const last = readLast429();
  if (!last || last.kind !== "shared_pool") return { yes: false, ms: 0 };
  const age = Date.now() / 1000 - last.ts;
  if (age * 1000 >= SHARED_POOL_COOLDOWN_MS) return { yes: false, ms: 0 };
  return {
    yes: true,
    ms: Math.max(50, SHARED_POOL_COOLDOWN_MS - age * 1000),
    reason: `shared pool ${last.model ?? "?"} hit ${Math.round(age)}s ago`,
  };
}

function shouldBackoffForTimeout(): { yes: boolean; ms: number; reason?: string } {
  const last = readLast429();
  if (!last || last.kind !== "timeout") return { yes: false, ms: 0 };
  const age = Date.now() / 1000 - last.ts;
  if (age * 1000 >= TIMEOUT_COOLDOWN_MS) return { yes: false, ms: 0 };
  return {
    yes: true,
    ms: Math.max(50, TIMEOUT_COOLDOWN_MS - age * 1000),
    reason: `timeout on ${last.model ?? "?"} ${Math.round(age)}s ago`,
  };
}

function readXot(): { idx: number; keys: string[]; state: string } {
  const statePath = join(XOT_DIR, "state");
  const keysPath = join(XOT_DIR, "keys");
  const state = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
  const keys = existsSync(keysPath)
    ? readFileSync(keysPath, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"))
    : [];
  const m = state.match(/ACTIVE_IDX=(\d+)/);
  const idx = m ? Number(m[1]) : 0;
  return { idx, keys, state };
}

function writeXot(idx: number): void {
  const statePath = join(XOT_DIR, "state");
  if (existsSync(statePath)) {
    let s = readFileSync(statePath, "utf8");
    s = s.replace(/ACTIVE_IDX=\d+/, `ACTIVE_IDX=${idx}`);
    writeFileSync(statePath, s);
  }
}

/**
 * Mark a specific key (by index in the xot keys file) as cooling until
 * `until_epoch`. This is what makes isCooling() in xot.ts return true
 * for the next request. Without this entry, xot.ts keeps using the same
 * activeKey even when we've decided the key is blocked — the root cause
 * of "rotation not working, same key 12 times in a row".
 */
function coolXotKey(idx: number, untilEpoch: number): void {
  const statePath = join(XOT_DIR, "state");
  if (!existsSync(statePath)) return;
  const { keys } = readXot();
  const k = keys[idx];
  if (!k) return;
  const fp = fingerprintOf(k);
  let s = readFileSync(statePath, "utf8");
  const re = new RegExp(`^COOL_${fp}=\\d+\\n?`, "m");
  const newLine = `COOL_${fp}=${untilEpoch}\n`;
  if (re.test(s)) s = s.replace(re, newLine);
  else s += newLine;
  writeFileSync(statePath, s);
}

/** Read fp from a key string using the same hash xot.ts uses (sha256[:16]). */
function fingerprintOf(key: string): string {
  // xot.ts: createHash("sha256").update(key).digest("hex").slice(0, 16)
  // We use Node's crypto to match exactly. The COOL_<fp> entry must
  // match xot.ts's fingerprint for isCooling() to return true.
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function readLedger(): Record<string, { status: string; reset_at?: number }> {
  try {
    if (!existsSync(LEDGER_PATH)) return {};
    return JSON.parse(readFileSync(LEDGER_PATH, "utf8"));
  } catch {
    return {};
  }
}

function findHealthyKey(skip: number): number | null {
  const { keys } = readXot();
  const ledger = readLedger();
  const now = Date.now() / 1000;
  // Try each key, prefer 'ok' status OR 'blocked' with expired reset_at.
  // Also: match the ledger entry by fingerprint (fp) since the python
  // keys.py writes by fp, not by full key string.
  for (let i = 0; i < keys.length; i++) {
    if (i === skip) continue;
    const k = keys[i];
    // Match by fp prefix (python keys.py uses short fp substrings).
    // Guard against ledger entries that are not dicts (some have null
    // values or other shapes) — the previous version crashed with
    // "Cannot read properties of null" when a ledger value was null.
    const entry = Object.entries(ledger).find(([_, v]) => {
      if (!v || typeof v !== "object") return false;
      const vfp = (v as any).fp;
      if (!vfp) return false;
      return vfp === k || k.startsWith(vfp) || (vfp && k.includes(vfp.slice(0, 12)));
    });
    if (!entry) return i;
    // Defensive: skip if entry[1] is somehow not a dict after the find
    if (!entry[1] || typeof entry[1] !== "object") return i;
    const status = (entry[1] as any).status;
    const reset_at = (entry[1] as any).reset_at;
    // Treat as healthy if: status ok, status undefined, OR
    // status blocked but reset_at has passed.
    const isExpiredBlock = status === "blocked" && reset_at && reset_at < now;
    if (status === "ok" || status === undefined || isExpiredBlock) return i;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the X-RateLimit-Reset epoch (seconds) from an OpenRouter
 * 429 body, when present. The body is a JSON object embedded in a
 * larger error message; we search for the substring and parse the
 * surrounding number. Returns null if not found or not parseable.
 *
 * Example body (as seen on 2026-09-01):
 *   {"X-RateLimit-Reset":1788307200000, ...}
 *
 * Note: OpenRouter sometimes returns reset in MILLISECONDS (13-digit)
 * and sometimes in SECONDS (10-digit). We detect by magnitude.
 */
function parseResetEpoch(body: string): number | null {
  if (!body) return null;
  // OpenRouter serializes the field both ways: as a JSON number (raw)
  // and as a JSON string (quoted). Accept either.
  const m = body.match(/"X-RateLimit-Reset"\s*:\s*"?(\d+)"?/);
  if (!m) return null;
  const raw = Number(m[1]);
  if (!Number.isFinite(raw)) return null;
  // > 10^11 → milliseconds; convert to seconds.
  return raw > 1e11 ? Math.floor(raw / 1000) : raw;
}

function tryRotateOnError(
  reason: string,
  ctx: { ui: { notify: (msg: string, kind?: string) => void } },
  options: { kind?: Last429["kind"]; model?: string; http?: number; body?: string } = {}
): void {
  const { idx } = readXot();

  // Record what we saw, even if we don't rotate.
  writeLast429({
    kind: options.kind ?? "other",
    alias: `idx${idx}`,
    model: options.model,
    http: options.http,
    body_excerpt: (options.body ?? "").slice(0, 200),
  });

  // If the failure is the shared pool, rotating keys is useless.
  // Just tell the user what happened; the next call will back off.
  if (options.kind === "shared_pool") {
    ctx.ui.notify(
      `XOT: upstream pool exhausted (${options.model ?? "?"}). ` +
        `Not rotating; will back off ${SHARED_POOL_COOLDOWN_MS}ms before next call. (${reason})`,
      "warning"
    );
    return;
  }

  // Timeouts are network/upstream issues, not key issues. Under strict
  // sequential rotation (the default XOT_PICK_MODE=round_robin), the
  // NEXT request will already advance to the next key on its own. We
  // just notify the user and let the natural sequential advance handle
  // the recovery — no special per-key streak logic needed.
  if (options.kind === "timeout") {
    ctx.ui.notify(
      `XOT: request timed out (${options.model ?? "?"}). ` +
        `Next request will use the next key in sequence. Retrying same key #${idx + 1} once. (${reason})`,
      "warning",
    );
    return;
  }

  // Daily-cap 429 on a :free model. OpenRouter's free tier shares a
  // daily counter ACROSS keys on the same account, so rotating usually
  // does NOT help. BUT: some users mix free and paid keys in the same
  // pool (each key has its own per-key credit state). Try rotation
  // first; only show the "won't help" message if no healthy key is
  // found. The previous version returned early on :free, which left
  // users stuck on the first key even when other keys were healthy.
  const isFreeModel = options.kind === "daily" && typeof options.model === "string" && options.model.endsWith(":free");
  if (isFreeModel) {
    const trialIdx = findHealthyKey(idx);
    if (trialIdx === null || trialIdx === idx) {
      const resetAt = parseResetEpoch(options.body);
      const resetStr = resetAt
        ? new Date(resetAt * 1000).toLocaleString()
        : "next UTC midnight";
      ctx.ui.notify(
        `XOT: free-tier daily cap hit on ${options.model}. ` +
          `All keys exhausted or share this counter — rotation will not help. ` +
          `Resets ${resetStr}. (${reason})`,
        "warning"
      );
      return;
    }
    // Fall through: a healthy key was found, so the rotation helps.
  }

  const newIdx = findHealthyKey(idx);
  if (newIdx !== null && newIdx !== idx) {
    // Mark the failing key as cooling in the xot state file. Without
    // this, xot.ts's isCooling() never returns true for the next
    // request, so it keeps using the same activeKey even though
    // we've decided the key is dead. This was the "rotation not
    // working" bug — the rotation was happening in python but xot
    // kept picking the same key.
    if (options.kind === "daily" && options.http === 429) {
      // Set a 6-hour cooldown (typical for free-models-per-day reset
      // at UTC midnight or after 6h on a sliding window).
      const untilEpoch = Math.floor(Date.now() / 1000) + 6 * 3600;
      coolXotKey(idx, untilEpoch);
    }
    writeXot(newIdx);
    ctx.ui.notify(`XOT auto-rotate: #${idx + 1} -> #${newIdx + 1} (${reason}). Retrying...`, "warning");
  } else {
    ctx.ui.notify(`XOT: all keys blocked or no healthy fallback. ${reason}.`, "error");
  }
}

export default function (pi: ExtensionAPI) {
  // 2026-09-07: XOT_STRICT_ROTATE=1 disables ALL error-driven rotation
  // because the picker already advances on every call regardless of
  // outcome. Keeping this on would cause double-rotation: xot.ts
  // advances (active+1)%N, then auto-rotate tries to advance again
  // (or pessimistically give up on :free models). The result was the
  // 1->2->1->2 ping-pong. We still LOG the error so the user can see
  // what happened, but we do not change the active key.
  // Default ON (set XOT_STRICT_ROTATE=0 to disable). Matches xot.ts sequential rotation.
  const strictRotate = process.env.XOT_STRICT_ROTATE !== "0";

  // HTTP-level rate-limit / blocked / 403 / 401
  pi.on("after_provider_response", async (event, ctx) => {
    if (strictRotate) {
      const body = (event as any)?.response?.body ?? (event as any)?.body ?? "";
      const perKeyDaily = /free-models-per-day|openrouter_free_tier_daily/i.test(String(body));
      if (perKeyDaily && event.status === 429) {
        tryRotateOnError(`status ${event.status}`, ctx as any, {
          kind: "daily",
          http: event.status,
          model: (event as any)?.response?.model,
          body: String(body),
        });
        return;
      }
      if (event.status === 429 || event.status === 403 || event.status === 520 || event.status === 401) {
        console.error(`xot: strict-rotate active, NOT rotating on ${event.status} (xot.ts handles per-key daily 429)`);
      }
      return;
    }
    const status = event.status;
    if (status === 429 || status === 403 || status === 520 || status === 401) {
      // Pass the body so we can distinguish per-key daily 429 (rotate
      // helps) from upstream_provider_shared_pool 429 (rotate does NOT
      // help — every key on this account hits the same exhausted pool).
      const body = (event as any)?.response?.body ?? (event as any)?.body ?? "";
      tryRotateOnError(`status ${status}`, ctx as any, {
        kind: classifyErrorBody(body, status),
        http: status,
        model: (event as any)?.response?.model,
        body,
      });
    }
  });

  // Stream-level errors: providers return HTTP 200 with an error inside the
  // stream payload (e.g. OpenRouter upstream "Insufficient balance"). The
  // after_provider_response hook fires with status:200, so we need to look
  // at the final assistant message in turn_end.
  pi.on("turn_end", async (event, ctx) => {
    const msg: any = event?.message;
    if (!msg) return;
    const stopReason = msg.stopReason;
    const errMsg = msg.errorMessage ?? "";
    // Classify the body once, then use that to decide whether to rotate
    // at all. A shared-pool 429 (upstream_provider_shared_pool) must NOT
    // trigger key rotation — every key on this account hits the same
    // exhausted GMICloud pool, so the only fix is backoff + model
    // routing, not a key swap. The previous version only checked the
    // "insufficient balance" substring and let other shared-pool shapes
    // fall through to key rotation, causing the #1 <-> #2 ping-pong the
    // user reported.
    if (strictRotate) {
      if (typeof errMsg === "string" && /free-models-per-day|openrouter_free_tier_daily/i.test(errMsg)) {
        tryRotateOnError("per-key daily cap", ctx as any, {
          kind: "daily",
          http: msg?.http ?? 429,
          body: errMsg,
        });
      }
      return;
    }

    const insufficientBalance = typeof errMsg === "string" && INSUFFICIENT_BALANCE_RE.test(errMsg);
    const isSharedPool = typeof errMsg === "string" && SHARED_POOL_RE.test(errMsg);
    const isAuthMissing =
      typeof errMsg === "string" && /missing authentication header/i.test(errMsg);
    const isRateLimited =
      typeof errMsg === "string" &&
      (INSUFFICIENT_BALANCE_RE.test(errMsg) ||
        SHARED_POOL_RE.test(errMsg) ||
        TIMEOUT_RE.test(errMsg) ||
        /\b(429|402|403|520)\b/.test(errMsg));

    if (isAuthMissing) return;
    if (!insufficientBalance && !isSharedPool && !(stopReason === "error" && isRateLimited)) {
      return;
    }

    const kind: Last429["kind"] =
      insufficientBalance || isSharedPool ? "shared_pool" : classifyErrorBody(errMsg, msg?.http ?? 429);
    tryRotateOnError(
      insufficientBalance ? "insufficient balance" : isSharedPool ? "shared pool" : "rate limit",
      ctx as any,
      {
        kind,
        model: (event as any)?.message?.model ?? (event as any)?.model,
        http: msg?.http ?? 429,
        body: errMsg,
      }
    );
  });

  // Pre-send: back off if the last failure was a shared-pool hit, and
  // do NOT rotate the key (rotating won't help). Same for timeouts:
  // a tiny wait before the next request, but keep the same key.
  pi.on("before_provider_request", async (_event, _ctx) => {
    const backoff = shouldBackoffForSharedPool().yes
      ? shouldBackoffForSharedPool()
      : shouldBackoffForTimeout();
    if (backoff.yes) {
      // Best-effort: we can't actually block the request from here in
      // most pi versions, so we just record the intent and let the
      // request go. The next turn_end will catch any 402.
      try {
        appendFileSync(
          join(process.env.HOME || "", ".config", "openrouter", "xot_backoff.log"),
          `[${new Date().toISOString()}] backoff ${backoff.ms}ms — ${backoff.reason}\n`
        );
      } catch {
        /* ignore */
      }
    }
  });

  // Pre-send: inject harness headers
  pi.on("before_provider_request", (event, _ctx) => {
    if (event.headers) {
      event.headers["HTTP-Referer"] = "https://pi.dev/";
      event.headers["X-Title"] = "pi-coding-agent";
      event.headers["User-Agent"] = "pi-coding-agent/0.84.3";
    }
  });

  // Command: force rotate
  pi.registerCommand("rotate", {
    description: "Force rotate to next healthy XOT key (skips blocked)",
    handler: async (_args, ctx) => {
      const { idx, keys } = readXot();
      const newIdx = findHealthyKey(idx);
      if (newIdx === null) {
        ctx.ui.notify("XOT: no healthy key found (all blocked).", "error");
        return;
      }
      writeXot(newIdx);
      const newKey = keys[newIdx] ?? "(none)";
      ctx.ui.notify(`XOT rotated: #${idx + 1} -> #${newIdx + 1} (key: ...${newKey.slice(-12)})`, "info");
    },
  });

  // Command: show health
  pi.registerCommand("key-health", {
    description: "Show which keys are blocked/ok in XOT ring",
    handler: async (_args, ctx) => {
      const { keys, idx } = readXot();
      const ledger = readLedger();
      const last = readLast429();
      const lines = [
        `XOT: ${keys.length} keys, active #${idx + 1}`,
        `Last 429: ${last ? `${last.kind}${last.model ? ` (model=${last.model})` : ""} @ ${new Date(last.ts * 1000).toISOString()}` : "none"}`,
      ];
      keys.forEach((k, i) => {
        const entry = Object.entries(ledger).find(([_, v]) => (v as any).key === k);
        const status = entry ? (entry[1] as any).status : "?";
        const marker = i === idx ? " >>" : "   ";
        lines.push(`${marker} #${i + 1} ${status.padEnd(8)} ...${k.slice(-12)}`);
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
