/**
 * xot key rotation for pi — no daemon, zero idle cost.
 *
 * Features:
 * - **Resume last session** (`resume-recent` / `Ctrl+Shift+R`): Continues the most recent session file without creating a new branch. Zero background tasks, minimal CPU.
 * - **Preemptive key rotation**: Monitors the shared `leases` file for `COOL_<fp>` entries and switches to a fresh key before the current one exhausts its quota.
 * - **Lightweight cooling cache**: Only reads the 2KB `state` file periodically (configurable TTL via `XOT_COOL_CACHE_MS`) to avoid constant disk I/O.
 * - **Sticky per-machine ownership**: Each machine claims its own key via `leases` file; the system prefers the same key across restarts.
 * - **Continue-after-exhaustion** (`continue` / `Ctrl+Shift+C`): When a turn fails because of key exhaustion, the system remembers the last user prompt and offers to re-send it. Default = continue.
 *
 * Usage:
 * - `pi -c` — open session picker (shows most recent session first)
 * - `Ctrl+Shift+R` — resume the last session instantly
 * - `Ctrl+Shift+C` — continue (re-submit the last failed prompt with the rotated key)
 * - `xot resume-recent` — same as above via the xot command
 * - `xot status` — view active key and cooldown info
 * - `xot rotate` — force rotate to a new key
 * - `xot reload` — clear cooling cache and refresh active key
 * - `xot continue` — re-submit the last failed prompt (same as `continue` chat shortcut)
 * - `xot model-backoff <model> [N]` — back off a model (default = double prev, cap 1h)
 * - `xot model-backoff-status <model>` — show how long the model is in backoff
 * - `xot clear-model-backoff <model>` — clear the backoff manually
 * - `xot retry-cancel` — clear the pending retry marker
 * - `xot retry-status` — show whether a retry is pending
 * - `xot simulate-broken-turn` — DEBUG: mark the last turn as broken (for testing)
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const IS_WIN = process.platform === "win32";
// 2026-09-06 fix: XOT_BASH / XOT_PS1 / PROBED_KEY used to be hardcoded to
// Mac-only paths. On Linux/Windows, runXot() would silently fail and
// pickKey() would fall through to OPENROUTER_API_KEY env var — the same
// key on every turn. We now resolve to ~/bin/xot (and ~/bin/xot.ps1) with
// XOT_BIN override, falling back to in-process rotation if the binary is
// missing. PROBED_KEY is also conditional on the file actually existing.
const XOT_BIN_OVERRIDE = process.env.XOT_BIN; // explicit override wins
const XOT_BASH_CANDIDATES = [
  XOT_BIN_OVERRIDE,
  join(homedir(), "bin", "xot"),
  "/usr/local/bin/xot",
].filter((p): p is string => !!p);
const XOT_PS1_CANDIDATES = [
  join(process.env.USERPROFILE ?? "", "bin", "xot.ps1"),
  join(homedir(), "bin", "xot.ps1"),
].filter((p): p is string => !!p);
function resolveXotBin(): { cmd: string; argsPrefix: string[] } | null {
  if (IS_WIN) {
    for (const p of XOT_PS1_CANDIDATES) {
      if (existsSync(p)) return { cmd: "powershell.exe", argsPrefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", p] };
    }
    return null;
  }
  for (const p of XOT_BASH_CANDIDATES) {
    if (existsSync(p)) return { cmd: p, argsPrefix: [] };
  }
  return null;
}
// Pi_key_probe.py is only present on the Mac dev box. We only consult it
// if the file exists; otherwise we go straight to the xot daemon (or the
// in-process fallback below).
const PROBED_KEY_CANDIDATES = [
  process.env.PI_KEY_PROBE,
  "/Users/minjunyeah/Downloads/Work/code_repo/ox-alpha/scripts/pi_key_probe.py",
  join(homedir(), "code_repo", "ox-alpha", "scripts", "pi_key_probe.py"),
].filter((p): p is string => !!p);
function resolveProbedKey(): string | null {
  for (const p of PROBED_KEY_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return null;
}
const THRESHOLD = Number(process.env.XOT_LIMIT_THRESHOLD ?? 2);
// Re-check the cooling state file at most every N ms. Set 0 to disable caching.
const COOL_CACHE_MS = Number(process.env.XOT_COOL_CACHE_MS ?? 5_000);

const XOT_DIR = process.env.XOT_CACHE ?? join(homedir(), ".local", "daemon", "xot");
const XOT_STATE_FILE = join(XOT_DIR, "state");
const XOT_RETRY_FILE = join(process.env.XOT_RETRY_FILE ?? join(homedir(), ".pi", "agent", "xot-retry.json"));
const XOT_RETRY_CONFIG = join(process.env.XOT_RETRY_CONFIG ?? join(homedir(), ".pi", "agent", "xot-retry-config.json"));

// Model fallback chain. When the current model's transport-level retries
// are exhausted (timeout, network error), the live status widget will
// suggest the next model in the chain. We don't auto-switch silently
// because the user may have specific reasons for the current model
// (e.g., a 1M-context model for long conversations).
//
// Override via XOT_FALLBACKS env var (JSON object: {"primary":"fallback1","fallback1":"fallback2"}).
const DEFAULT_MODEL_FALLBACKS: Record<string, string> = {
  "minimax/minimax-m3:free": "minimax/minimax-m2.7:free",
  "minimax/minimax-m2.7:free": "z-ai/glm-5.2:free",
  "z-ai/glm-5.2:free": "ollama/qwen2.5:7b",           // final local Qwen fallback
  "ollama/qwen2.5:7b": "minimax/minimax-m3:free",     // cycle back to start
};
let MODEL_FALLBACKS: Record<string, string> = DEFAULT_MODEL_FALLBACKS;
try {
  if (process.env.XOT_FALLBACKS) {
    const parsed = JSON.parse(process.env.XOT_FALLBACKS);
    if (parsed && typeof parsed === "object") {
      MODEL_FALLBACKS = { ...DEFAULT_MODEL_FALLBACKS, ...parsed };
    }
  }
} catch {}

// ---- retry / continue state ------------------------------------------------
type RetryState = {
  needsRetry: boolean;
  prompt: string;          // last user message text
  reason: string;          // human-readable: "insufficient balance", "key rotated mid-turn", etc.
  sessionFile?: string;    // optional, for cross-session memory
  timestamp: number;
};

type RetryConfig = {
  autoPromptOnBrokenTurn: boolean;  // show confirm dialog after broken turn (default false = fully auto)
  autoRetryOnConfirm: boolean;     // if true, re-submit on confirm
  maxPromptLength: number;          // truncate saved prompt if too long
  stickyForMinutes: number;         // forget retry after this many minutes
  autoContinueDelayMs: number;      // how long to wait after settle before auto-continuing
};

const DEFAULT_CONFIG: RetryConfig = {
  autoPromptOnBrokenTurn: false,    // fully automatic: no dialog, just re-send
  autoRetryOnConfirm: true,
  maxPromptLength: 4000,
  stickyForMinutes: 30,
  autoContinueDelayMs: 1500,        // 1.5s is enough for state to settle
};

function loadRetryConfig(): RetryConfig {
  try {
    if (existsSync(XOT_RETRY_CONFIG)) {
      const txt = readFileSync(XOT_RETRY_CONFIG, "utf8");
      const parsed = JSON.parse(txt);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {}
  return DEFAULT_CONFIG;
}

function loadRetryState(): RetryState | null {
  try {
    if (!existsSync(XOT_RETRY_FILE)) return null;
    const txt = readFileSync(XOT_RETRY_FILE, "utf8");
    const parsed = JSON.parse(txt) as RetryState;
    if (!parsed || !parsed.needsRetry) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveRetryState(state: RetryState | null): void {
  try {
    if (state === null) {
      if (existsSync(XOT_RETRY_FILE)) {
        // Atomic delete: write empty + rename
        const tmp = XOT_RETRY_FILE + ".tmp";
        writeFileSync(tmp, "null");
        renameSync(tmp, XOT_RETRY_FILE);
      }
      return;
    }
    mkdirSync(dirname(XOT_RETRY_FILE), { recursive: true });
    const tmp = XOT_RETRY_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, XOT_RETRY_FILE);
  } catch (e) {
    // Best-effort; we never block the agent on retry-state IO.
  }
}

function clearRetryState(): void {
  saveRetryState(null);
}

function runXot(args: string[], extraEnv?: Record<string, string>): string | null {
  // Always pass our process pid so each Pi window gets its own sticky
  // key (per-PID lease ownership). Without this, N Pi windows on the
  // same machine all collide on a single key.
  const env: Record<string, string> = {
    ...(extraEnv ?? (process.env as Record<string, string>)),
    XOT_PID: String(process.pid),
  };
  const opts: import("node:child_process").ExecFileSyncOptions = {
    encoding: "utf8" as const,
    timeout: 30_000,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  const resolved = resolveXotBin();
  if (!resolved) {
    // No daemon binary on this machine. Caller (pickKey) will fall
    // through to the in-process fallback. We deliberately don't throw
    // here because pickKey handles the null result.
    return null;
  }
  try {
    return execFileSync(resolved.cmd, [...resolved.argsPrefix, ...args], opts);
  } catch (e: any) {
    // 2026-09-06 fix: surface stderr so future "rotation stopped" bugs
    // are debuggable. Previously the catch silently swallowed everything,
    // which is why the user's Linux box kept using the env-var key for
    // days without any signal that the daemon was missing.
    const stderr = e?.stderr ? String(e.stderr).trim().split("\n").slice(-3).join(" | ") : "";
    const msg = e?.message ?? String(e);
    console.error(`xot: ${resolved.cmd} ${[...resolved.argsPrefix, ...args].join(" ")} failed: ${msg}${stderr ? " | stderr: " + stderr : ""}`);
    return null;
  }
}

// ---- cross-session cooldown awareness ---------------------------------
function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

// Tiny cached check: stats the file first; only reads if mtime advanced.
// Returns the parsed COOL_<fp> until-epoch (or 0) plus the file's mtime.
const COOL_RE = /^COOL_([0-9a-f]{16})=(\d+)$/;
let coolCache: { mtimeMs: number; size: number; map: Map<string, number> } = { mtimeMs: 0, size: 0, map: new Map() };
let coolLastCheck = 0;
function getCoolMap(): Map<string, number> {
  if (COOL_CACHE_MS > 0 && Date.now() - coolLastCheck < COOL_CACHE_MS && coolCache.map.size) {
    return coolCache.map;
  }
  coolLastCheck = Date.now();
  try {
    const st = statSync(XOT_STATE_FILE);
    if (st.mtimeMs === coolCache.mtimeMs && st.size === coolCache.size) return coolCache.map;
    const text = readFileSync(XOT_STATE_FILE, "utf8");
    const m = new Map<string, number>();
    const now = Date.now() / 1000;
    for (const line of text.split("\n")) {
      const mt = COOL_RE.exec(line);
      if (mt && Number(mt[2]) > now) m.set(mt[1], Number(mt[2]));
    }
    coolCache = { mtimeMs: st.mtimeMs, size: st.size, map: m };
  } catch {
    coolCache = { mtimeMs: 0, size: 0, map: new Map() };
  }
  return coolCache.map;
}
function isCooling(key: string): boolean {
  return getCoolMap().has(fingerprint(key));
}
function clearCoolCache() { coolCache = { mtimeMs: 0, size: 0, map: new Map() }; coolLastCheck = 0; }

function coolKey(key: string, untilEpoch: number): void {
  try {
    const fp = fingerprint(key);
    let state = existsSync(XOT_STATE_FILE) ? readFileSync(XOT_STATE_FILE, "utf8") : "";
    const re = new RegExp(`^COOL_${fp}=\\d+\\n?`, "m");
    const newLine = `COOL_${fp}=${untilEpoch}\n`;
    state = re.test(state) ? state.replace(re, newLine) : state + newLine;
    const tmp = XOT_STATE_FILE + ".tmp";
    writeFileSync(tmp, state);
    renameSync(tmp, XOT_STATE_FILE);
    clearCoolCache();
  } catch {}
}

let limitedCount = 0;

const PER_KEY_DAILY_RE = /free-models-per-day|openrouter_free_tier_daily/i;

function extractErrorBody(event: any): string {
  const raw = event?.response?.body ?? event?.body ?? event?.error ?? "";
  if (typeof raw === "string") return raw;
  try { return JSON.stringify(raw ?? ""); } catch { return ""; }
}

function isPerKeyDaily429(event: any, extraBody?: string): boolean {
  const body = (extraBody ?? extractErrorBody(event)).toLowerCase();
  return PER_KEY_DAILY_RE.test(body);
}

function parseRetryAfter(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : null;
}

// isModelInBackoff: returns the number of seconds left for the model's
// backoff, or 0 if the model is currently usable. Reads the same state
// file the bash `xot` script writes (MODEL_BACKOFF_<safe_model>=<epoch>).
function isModelInBackoff(model: string): number {
  try {
    const safe = model.replace(/[\/: ]/g, "_");
    const txt = readFileSync(XOT_STATE_FILE, "utf8");
    const re = new RegExp(`^MODEL_BACKOFF_${safe}=(\\d+)$`, "m");
    const m = re.exec(txt);
    if (!m) return 0;
    const until = Number(m[1]);
    const left = Math.round(until - Date.now() / 1000);
    return left > 0 ? left : 0;
  } catch {
    return 0;
  }
}

// getPoolSize: how many keys are in the rotation pool. Used by the
// full-cycle policy to decide when to fall back to a different model
// (after we've tried this many keys on the current model).
function getPoolSize(): number {
  try {
    const keysPath = join(XOT_DIR, "keys");
    if (!existsSync(keysPath)) return 1;
    const keys = readFileSync(keysPath, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && /^[A-Za-z0-9_\-\.:=+]+$/.test(l));
    return Math.max(1, keys.length);
  } catch {
    return 1;
  }
}

// resolveModelRef: turn "provider/model" into a {provider, id} object that
// pi's modelRegistry understands. Returns null if the string is malformed.
// resolveModelRef: turn "provider/model-id" into a {provider, id} object
// that pi's modelRegistry understands. The model id may itself contain
// '/' (e.g. "minimax/minimax-m3:free" via OpenRouter), so we accept the
// full ref and split on the first '/' only.
function resolveModelRef(ref: string): { provider: string; id: string } | null {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash >= ref.length - 1) return null;
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

// In the model registry, OpenRouter-hosted models have id = "minimax/minimax-m3:free"
// (the upstream name) and provider = "openrouter". So when our
// MODEL_FALLBACKS keys are full refs like "minimax/minimax-m3:free", we
// need to look up by provider=openrouter, id=full-string. But the
// registry may also have a more specific id like
// "minimax/minimax-m3:free" vs the bare ref — try the full id first
// and fall back to a heuristic.
function findModelInRegistry(ctx: any, ref: string): any {
  if (!ctx?.modelRegistry?.find) return null;
  // Direct lookup if registry exposes find
  const parsed = resolveModelRef(ref);
  if (!parsed) return null;
  const direct = ctx.modelRegistry.find(parsed.provider, parsed.id);
  if (direct) return direct;
  // OpenRouter-style: full ref is the id, provider is "openrouter"
  const viaOpenRouter = ctx.modelRegistry.find("openrouter", ref);
  if (viaOpenRouter) return viaOpenRouter;
  // Last resort: scan all models
  const all = ctx.modelRegistry.getAvailable?.() ?? [];
  return all.find((m: any) => `${m.provider}/${m.id}` === ref || m.id === ref) ?? null;
}

// extractModel: pull the model name out of a before_provider_headers event.
// Tries multiple paths because the shape varies across providers.
function extractModel(event: any): string | null {
  if (!event || typeof event !== "object") return null;
  // Direct field
  if (typeof event.model === "string" && event.model) return event.model;
  // request body (Anthropic / OpenAI chat completions style)
  const req = event.request;
  if (req && typeof req === "object") {
    if (typeof req.model === "string" && req.model) return req.model;
    if (Array.isArray(req.messages) && req.model) return req.model;
  }
  // URL path can contain the model: /v1/chat/completions doesn't, but
  // /v1/models/<model>/... does. We try to match the last path segment.
  const url = event.url ?? event.request?.url ?? "";
  if (typeof url === "string" && url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      // Look for a segment that looks like a model id (has a slash, e.g.
      // anthropic/claude-3.5-sonnet, or a known provider prefix)
      for (const p of parts) {
        if (p.includes("/") || /^(gpt-|claude-|gemini-|meta-|mistral-|openai\/|anthropic\/|google\/|meta-llama\/)/i.test(p)) {
          return decodeURIComponent(p);
        }
      }
    } catch {}
  }
  return null;
}

function pickKey(extraEnv?: Record<string, string>): string | null {
  // Simple sequential rotator: 1->2->...->14->1 on every request, no sticky, no cooling, no daemon.
  // Final fallback chain handled by model-fallback (minimax-m3 -> openrouter/minimax-m2.7 -> qwen2.5:7b).
  return pickKeyInProcess();
}

// ---- in-process pick fallback (no external daemon) --------------------
// XOT_PICK_MODE controls rotation strategy:
//   "round_robin"  (default) — STRICT sequential advance. Every pick moves
//                              to (active+1) % N, regardless of whether the
//                              previous request succeeded or failed. The
//                              failure handling (auto-rotate.ts) also walks
//                              the pool in order, so the result is a fixed
//                              key order: 0, 1, 2, ..., N-1, 0, 1, 2, ...
//                              Cooling is respected (cooled keys are skipped
//                              and the loop continues to find the next).
//                              Best when keys are independent accounts —
//                              each gets equal traffic.
//   "sticky"                 — prefer current ACTIVE_IDX, only advance on
//                              failure. Maximizes cache reuse on a known-good
//                              key; best when one key is significantly better.
const PICK_MODE = (process.env.XOT_PICK_MODE ?? "round_robin").toLowerCase();
// 2026-09-07: XOT_STRICT_ROTATE=1 forces pure (active+1)%N on every pick.
// Bypasses cooling, leases, model-backoff, and health probes entirely.
// Use this when keys are independent accounts (e.g. 14 separate OpenRouter
// accounts on the same :free model) and you want EVEN traffic distribution
// instead of "skip cooled keys then pick the next healthy one." This is
// the user's preferred mode as of 2026-09-07; the previous logic was
// causing 1->2->1->2 ping-pong because the cool-check + free-tier
// pessimization in auto-rotate.ts kept marking alternating keys as
// "all keys exhausted" without actually cooling them in xot's state.
const STRICT_ROTATE = process.env.XOT_STRICT_ROTATE !== "0";
function pickKeyInProcess(): string | null {
  const keysPath = join(XOT_DIR, "keys");
  if (!existsSync(keysPath)) return null;
  let keys: string[];
  try {
    keys = readFileSync(keysPath, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l && !l.startsWith("#") && /^[A-Za-z0-9_\-\.:=+]+$/.test(l));
  } catch {
    return null;
  }
  if (keys.length === 0) return null;

  // Read current ACTIVE_IDX.
  let active = 0;
  try {
    const state = readFileSync(XOT_STATE_FILE, "utf8");
    const m = /ACTIVE_IDX=(\d+)/.exec(state);
    if (m) active = Math.min(keys.length - 1, Math.max(0, Number(m[1])));
  } catch {}

  // Strict mode: advance by exactly 1, ignore cooling/leases, no probe.
  if (STRICT_ROTATE) {
    const next = (active + 1) % keys.length;
    const k = keys[next];
    if (!k) return null;
    // Write back synchronously so the next call sees the new index.
    try {
      let state = "";
      if (existsSync(XOT_STATE_FILE)) {
        state = readFileSync(XOT_STATE_FILE, "utf8");
      }
      const now = Math.floor(Date.now() / 1000);
      const newLine = `ACTIVE_IDX=${next}`;
      const rotLine = `ROTATED_AT=${now}`;
      if (/^ACTIVE_IDX=\d+$/m.test(state)) {
        state = state.replace(/^ACTIVE_IDX=\d+$/m, newLine);
      } else {
        state = state.trimEnd() + "\n" + newLine + "\n";
      }
      if (/^ROTATED_AT=\d+$/m.test(state)) {
        state = state.replace(/^ROTATED_AT=\d+$/m, rotLine);
      } else {
        state = state.trimEnd() + "\n" + rotLine + "\n";
      }
      const tmp = XOT_STATE_FILE + ".tmp";
      writeFileSync(tmp, state);
      renameSync(tmp, XOT_STATE_FILE);
    } catch {}
    return k;
  }

  const coolMap = getCoolMap();
  const now = Date.now() / 1000;
  const tryKey = (i: number): string | null => {
    const k = keys[i];
    if (!k) return null;
    const fp = fingerprint(k);
    const until = coolMap.get(fp);
    if (until && until > now) return null; // cooling
    return k;
  };

  let picked: string | null = null;
  if (PICK_MODE === "sticky") {
    // 1. Try the sticky index first.
    picked = tryKey(active);
    // 2. Round-robin from active+1 through all keys.
    if (!picked) {
      for (let off = 1; off <= keys.length; off++) {
        const k = tryKey((active + off) % keys.length);
        if (k) { picked = k; active = (active + off) % keys.length; break; }
      }
    }
  } else {
    // round_robin (default): always start the search at (active+1) so each
    // pick advances by one. If every key ahead is cooling, fall back to
    // the sticky index — that way a fully-cooled pool still returns
    // SOMETHING rather than null. This balances two goals:
    //   - even distribution across keys when all are healthy
    //   - graceful degradation when most keys are cooling
    for (let off = 1; off <= keys.length; off++) {
      const k = tryKey((active + off) % keys.length);
      if (k) { picked = k; active = (active + off) % keys.length; break; }
    }
    if (!picked) picked = tryKey(active);
  }
  if (!picked) return null;

  // Write ACTIVE_IDX back (atomic: temp + rename).
  try {
    let state = "";
    if (existsSync(XOT_STATE_FILE)) {
      state = readFileSync(XOT_STATE_FILE, "utf8");
    }
    const line = `ACTIVE_IDX=${active}`;
    if (/^ACTIVE_IDX=\d+$/m.test(state)) {
      state = state.replace(/^ACTIVE_IDX=\d+$/m, line);
    } else {
      state = state.trimEnd() + "\n" + line + "\n";
    }
    // Preserve ROTATED_AT for parity with the bash daemon.
    if (!/^ROTATED_AT=\d+$/m.test(state)) {
      state = state.trimEnd() + "\nROTATED_AT=" + Math.floor(now) + "\n";
    }
    const tmp = XOT_STATE_FILE + ".tmp";
    writeFileSync(tmp, state);
    renameSync(tmp, XOT_STATE_FILE);
  } catch {}

  // Sync the python ledger (~/.../key_ledger.json) so widgets that read
  // ledger.last_used get the right answer. Without this sync, the
  // live-status widget would show stale data (e.g. FIFTEENTH when the
  // daemon is actually on SIXTH) because only keys.py writes the
  // ledger. Mirror the keys.py write: update last_used to the alias
  // for the picked secret, keep existing entry if present.
  try {
    const ledgerPath = join(homedir(), ".config", "openrouter", "key_ledger.json");
    const envPath = join(homedir(), ".config", "openrouter", "env");
    if (existsSync(ledgerPath) && existsSync(envPath)) {
      // Map secret -> alias from env
      let alias: string | null = null;
      const envText = readFileSync(envPath, "utf8");
      for (const line of envText.split("\n")) {
        const m = line.match(/^OPENROUTER_API_KEY_([A-Z_0-9]+)=(sk-or-v1-[A-Za-z0-9]+)/);
        if (m && m[2] === picked) { alias = m[1]; break; }
      }
      if (alias) {
        const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
        const before = ledger.last_used;
        ledger.last_used = alias;
        // Keep the keys.* entry as-is; keys.py manages per-key fields.
        // Only update last_used_pos if missing or wildly out of range
        // (so the widget display stays consistent).
        const n = Object.keys(ledger.keys || {}).length;
        if (typeof ledger.last_used_pos !== "number" || (n > 0 && (ledger.last_used_pos >= n || ledger.last_used_pos < 0))) {
          ledger.last_used_pos = active;
        }
        if (before !== alias) {
          const tmp = ledgerPath + ".tmp";
          writeFileSync(tmp, JSON.stringify(ledger, null, 2));
          renameSync(tmp, ledgerPath);
        }
      }
    }
  } catch {}

  return picked;
}

function refreshLiveStatus(ctx?: any): void {
  try {
    (globalThis as any)[Symbol.for("live-status.bridge")]?.refresh?.(ctx);
  } catch {}
}

export default function (pi: any) {
  // Safe wrappers: xot's event handlers may be called in tests with
  // a stub ctx, or in some real-pi versions with ctx being optional.
  // Wrap so handlers don't throw on undefined ctx.
  const safeNotify = (ctx: any, msg: string, type: string) => {
    try { if (ctx && ctx.ui && typeof ctx.ui.notify === "function") ctx.ui.notify(msg, type); } catch {}
  };
  const safeSetStatus = (_ctx: any, _key: string, _text: string) => {
    // Footer reserved for XOT key identity (live-status). Alerts use notify.
  };
  const safeSendUserMessage = async (ctx: any, text: string): Promise<boolean> => {
    if (ctx && typeof ctx.sendUserMessage === "function") {
      try { await ctx.sendUserMessage(text); return true; } catch {}
    }
    if ((pi as any).sendUserMessage && typeof (pi as any).sendUserMessage === "function") {
      try { await (pi as any).sendUserMessage(text); return true; } catch {}
    }
    return false;
  };
  // safeSetModel: ctx doesn't expose `pi`, so we can't call pi.setModel
  // from an event handler the way the docs suggest. The factory captures
  // the real `pi` here and exposes a thin bridge on globalThis so the
  // event handlers can reach it. We use a per-session bridge keyed by
  // our `pi` identity so multiple loaded instances don't cross-talk.
  const bridgeKey = Symbol.for("xot.bridge");
  const existingBridge: any = (globalThis as any)[bridgeKey];
  const bridge = existingBridge ?? {
    setModel: (m: any) => (pi as any).setModel?.(m),
    sendUserMessage: (s: string) => safeSendUserMessage(undefined, s),
  };
  (globalThis as any)[bridgeKey] = bridge;
  // lastModel must be declared BEFORE pickKey() runs (which is
  // initialized to activeKey on the next line), because pickKey
  // now checks the model-backoff state. Using `var` so the
  // declaration is hoisted; semantically equivalent to `let null`.
  var lastModel: string | null = null;             // most recent model the agent asked for
  let activeKey: string | null = pickKey();

  function isOpenRouterProvider(event: any): boolean {
    const provider =
      event?.provider ??
      event?.request?.provider ??
      event?.model?.provider ??
      "";
    if (typeof provider === "string" && /openrouter/i.test(provider)) return true;
    const url = String(event?.url ?? event?.request?.url ?? "");
    return /openrouter\.ai/i.test(url);
  }

  // omp 18.x dropped before_provider_headers; inject auth via registerProvider instead.
  function applyOpenRouterKey(key: string): void {
    process.env.OPENROUTER_API_KEY = key;
    try {
      if (typeof pi?.registerProvider === "function") {
        pi.registerProvider("openrouter", { apiKey: key, authHeader: true });
      }
    } catch {}
  }

  function ensureActiveKeyForRequest(): string | null {
    if (STRICT_ROTATE) {
      activeKey = pickKey();
    } else if (!activeKey) {
      activeKey = pickKey();
    }
    return activeKey;
  }

  if (activeKey) applyOpenRouterKey(activeKey);

  // Auto-fallback state: when a model hits 402 (insufficient balance),
  // we switch to the next model in MODEL_FALLBACKS. To honour the
  // user's chosen model, we remember their original choice and revert
  // to it on the next user prompt — *unless* the user manually picked
  // a different model in the meantime (in which case we leave their
  // choice alone).
  //
  //   originalDefaultModel: the model the user picked before we did
  //                         any auto-fallback. Cleared after a revert
  //                         so we don't keep flipping back-and-forth.
  //   manualModelOverride:  set true if the user (or pi's internal UI)
  //                         called setModel while we were on the
  //                         fallback. If true, do not auto-revert.
  let originalDefaultModel: string | null = null;
  let manualModelOverride = false;

  let switching = false;

  // Full-cycle policy: before falling back to a different model, try the
  // entire key pool on the current model. Each turn on the same model
  // counts as one cycle attempt; once we've tried N keys (one full pool)
  // and the model is still failing, switch to the fallback model.
  // cycleAttempts counts how many turns we've spent on the current model
  // during the current cycle. Resets on: (a) successful response on the
  // current model, (b) before_agent_start (new user prompt = fresh cycle),
  // (c) after we switch models.
  let cycleAttempts = 0;
  let cycleModel: string | null = null;
  let dailyRotateAttempts = 0;
  let scheduledContinueTimer: ReturnType<typeof setTimeout> | null = null;

  // Retry / continue state (in-memory mirror of the file)
  let lastUserPrompt: string | null = null;        // most recent user text
  let retryState: RetryState | null = loadRetryState();
  const retryConfig: RetryConfig = loadRetryConfig();

  // Per-message key rotation: the previous version locked the same
  // activeKey for the entire session, so two concurrent sessions saw
  // only 2 keys total. We now call pickKey() on each new user prompt
  // (before_agent_start), so each prompt can use a different key.
  // The rotation respects the existing sticky-on-success behaviour
  // (no pre-emptive rotation) but advances on the boundary of user
  // turns, which is what the user expects to see in the live status
  // bar: a fresh key alias per turn.
  pi.on("session_start", async (_event: any, _ctx: any) => {
    const state = loadRetryState();
    if (state && state.needsRetry) {
      const ageMin = Math.round((Date.now() - state.timestamp) / 60_000);
      if (ageMin >= retryConfig.stickyForMinutes) {
        clearRetryState();
      } else {
        safeNotify(
          _ctx,
          `xot: a retry is pending from ${ageMin}m ago. /xot retry-status to inspect, /xot continue to replay, /xot retry-cancel to drop.`,
          "warning",
        );
      }
    }
  });

  pi.on("before_agent_start", async (_event: any, ctx: any) => {
    cycleAttempts = 0;
    cycleModel = null;
    dailyRotateAttempts = 0;
    const next = pickKey();
    if (next && next !== activeKey) {
      const oldShort = mask(activeKey);
      activeKey = next;
      const newShort = mask(activeKey);
      console.error(`xot: rotated for new turn — ${oldShort}… → ${newShort}…`);
    }
    if (activeKey) applyOpenRouterKey(activeKey);
    refreshLiveStatus(ctx);
    if (originalDefaultModel && !manualModelOverride && (ctx as any)?.modelRegistry?.find) {
      const cur = (ctx as any).model;
      const curName = cur ? `${cur.provider}/${cur.id}` : null;
      if (curName && curName !== originalDefaultModel) {
        if (isModelInBackoff(originalDefaultModel) === 0) {
          const origObj = findModelInRegistry(ctx, originalDefaultModel);
          if (origObj && bridge.setModel) {
            const ok = await bridge.setModel(origObj);
            if (ok) {
              safeNotify(
                ctx,
                `xot: reverted to ${originalDefaultModel} (your default)`,
                "info",
              );
              originalDefaultModel = null;
              manualModelOverride = false;
            }
          }
        }
      }
    }
  });

  pi.on("before_provider_request", (event: any) => {
    if (!isOpenRouterProvider(event)) return;
    const key = ensureActiveKeyForRequest();
    if (!key) return;
    applyOpenRouterKey(key);
    const model = extractModel(event);
    if (model) {
      lastModel = model;
      try { runXot(["set-model", model]); } catch {}
    }
  });


  // Detect manual model changes so we don't auto-revert over them.
  // When the user (or the built-in /model selector) sets a model
  // explicitly, pi emits `model_select`. If we have an auto-fallback
  // in flight, mark it as manual so before_agent_start's revert
  // logic skips it.
  pi.on("model_select", (event: any) => {
    const m = event?.model;
    if (!m) return;
    const newName = `${m.provider}/${m.id}`;
    // If the new model equals our auto-fallback target, the change
    // was made by US, not the user — leave manualModelOverride false.
    if (originalDefaultModel && newName !== originalDefaultModel) {
      manualModelOverride = true;
    }
  });



  pi.on("before_provider_headers", (event: any) => {
    if (!isOpenRouterProvider(event)) return;

    const key = ensureActiveKeyForRequest();
    if (!key) return;
    applyOpenRouterKey(key);

    if (!STRICT_ROTATE && !switching && isCooling(key)) {
      switching = true;
      try {
        const next = pickKey();
        if (next && next !== key) {
          const oldShort = mask(key);
          activeKey = next;
          limitedCount = 0;
          applyOpenRouterKey(next);
          console.error(`xot: key ${oldShort}… cooling elsewhere — switched pre-emptively`);
        }
      } finally { switching = false; }
    }

    event.headers = event.headers ?? {};
    event.headers["x-api-key"] = activeKey;
    event.headers["authorization"] = `Bearer ${activeKey}`;

    const model = extractModel(event);
    if (model) {
      lastModel = model;
      try {
        runXot(["set-model", model]);
      } catch {}
    }
  });

  pi.on("after_provider_response", (event: any, ctx: any) => {
    const h = event.headers ?? {};
    if (event.status === 429) {
      const body = extractErrorBody(event);
      let ra = parseRetryAfter(h["retry-after"]);
      // OpenRouter puts the daily reset epoch in X-RateLimit-Reset when
      // the failure is a daily-quota exhaustion. Treat that as a much
      // longer backoff than the per-minute Retry-After.
      const dailyResetSec = parseRetryAfter(h["x-ratelimit-reset"]);

      if (isPerKeyDaily429(event, body)) {
        limitedCount++;
        handlePerKeyDaily429(ctx, ra ?? dailyResetSec);
        return;
      }

      if (dailyResetSec && dailyResetSec > 3600 && (!ra || dailyResetSec > ra)) {
        // Daily pool exhausted. Don't rotate keys; just back off the
        // model until the daily reset. The user must wait or switch
        // models manually.
        ra = dailyResetSec;
        ctx.ui.notify(
          `xot: daily pool exhausted — reset in ${(dailyResetSec / 3600).toFixed(1)}h. Stopping key rotation.`,
          "warning",
        );
        if (lastModel) {
          runXot(["model-backoff", lastModel, String(dailyResetSec)]);
        }
        // Surface a clear status so the user knows what's happening
        // setStatus disabled: daily pool exhausted (see notify above)
        limitedCount = 0;
        return;
      }
      // Look for upstream-pool marker in the response. We don't get the
      // body in this event, but OpenRouter echoes it in `x-request-id` and
      // sometimes in rate-limit headers. The strongest signal is a large
      // retry-after (>= 30s), which means "shared pool is exhausted" and
      // rotating between keys is futile — we must back off the model.
      const isUpstreamPool = ra != null && ra >= 30;
      limitedCount++;
      // setStatus disabled: limit hit counter
      if (isUpstreamPool && lastModel) {
        // Upstream pool is shared across all our keys. Don't burn the
        // remaining retry budget on the same dead model. Set a model
        // backoff equal to the server's retry hint (capped at 10 min).
        const backoff = Math.min(600, Math.max(60, ra));
        try { runXot(["model-backoff", lastModel, String(backoff)]); } catch {}
        ctx.ui.notify(
          `xot: upstream shared pool exhausted for ${lastModel} — backing off ${backoff}s`,
          "warning",
        );
        // Force a model rotation too, since the user should be told to
        // pick a different model. We don't auto-switch (that would break
        // the user's chosen model), but we set a status so it's visible.
        // setStatus disabled: upstream 429 (see notify above)
        // Don't trigger key rotation here; the issue is the model.
        // Reset the local counter so the next non-429 response starts fresh.
        limitedCount = 0;
        return;
      }
      if (limitedCount >= THRESHOLD)
        rotate(ctx, `limit reached${ra != null ? ` (server said retry in ${ra}s)` : ""}`, ra);
    } else if (event.status && event.status < 500) {
      limitedCount = 0;
      // pi 0.84.4's footer has a bug: if a status value is null/undefined, the
      // sanitizer throws `Cannot read properties of null (reading 'replace')`
      // and pi exits with uncaughtException. Workaround: use "" to clear
      // instead of undefined, which the sanitizer handles fine.
      // setStatus disabled: success clear
      // Full-cycle policy: a successful response on the current model
      // means the model is healthy. Reset the cycle counter so the next
      // failure on this model starts a fresh cycle from 0 attempts.
      cycleAttempts = 0;
      cycleModel = null;
    }
  });

  // Capture every user prompt so we can re-send on continue.
  pi.on("message_end", (event: any) => {
    const m: any = event?.message;
    if (!m) return;
    if (m.role !== "user") return;
    // The user message content can be a string OR an array of content parts.
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (typeof part === "string") text += part;
        else if (part?.type === "text" && typeof part.text === "string") text += part.text;
      }
    }
    text = text.trim();
    if (!text) return;
    // Magic word: "continue" (or "c") alone triggers retry if one is pending.
    // Any other content becomes the new "last user prompt" for future retries.
    if (text === "continue" || text === "c") {
      // Don't update lastUserPrompt; the real prompt is the saved one.
      return;
    }
    if (text.length > retryConfig.maxPromptLength) {
      text = text.slice(0, retryConfig.maxPromptLength) + "…[truncated]";
    }
    lastUserPrompt = text;
  });

  // Stream-level errors (HTTP 200 with error in the SSE stream, e.g. OpenRouter
  // "Insufficient balance" from upstream GMICloud): the after_provider_response
  // hook only sees status:200. We need to inspect the final assistant message
  // in turn_end and rotate immediately.
  pi.on("turn_end", async (event: any, ctx: any) => {
    const msg: any = event?.message;
    if (!msg) return;
    const errMsg: string = msg.errorMessage ?? "";
    const perKeyDailyCap =
      typeof errMsg === "string" && PER_KEY_DAILY_RE.test(errMsg);
    const insufficientBalance = typeof errMsg === "string" &&
      /insufficient[ _-]?(balance|credit|quota)|payment required|status 402/i.test(errMsg);

    if (perKeyDailyCap && msg.stopReason === "error") {
      if (!recentlyRotated()) {
        handlePerKeyDaily429(ctx, null);
      } else if (loadRetryState()?.needsRetry) {
        scheduleAutoContinue(ctx, 400);
      }
      return;
    }

    // Detect "broken turn": empty content (no text and no tool calls) AND
    // a rotation just happened. The rotation is signalled by limitedCount
    // being reset to 0 within the last few seconds.
    const assistantText = extractAssistantText(msg);
    const hadToolCalls = !!(msg?.content && Array.isArray(msg.content) &&
      msg.content.some((p: any) => p?.type === "toolCall" || p?.type === "tool_use"));
    const wasEmpty = !assistantText && !hadToolCalls;

    if (insufficientBalance) {
      // Three-tier response with FULL-CYCLE policy:
      //   Tier 1: rotate key (the per-key fix attempts in the same pool)
      //   Tier 2: back off the model itself (the per-model fix that
      //            stops wasting API calls on a shared-pool exhaustion)
      //   Tier 3: auto-switch to the fallback model — but ONLY after the
      //            full key pool has been tried on the current model.
      //            We track cycleAttempts: each turn on the current model
      //            is one attempt. When cycleAttempts reaches the pool
      //            size (N keys), the model is definitively dead and we
      //            fall back. Reset on successful response or new user
      //            prompt.
      const failedModel = lastModel;
      const mbBefore = failedModel ? isModelInBackoff(failedModel) : 0;
      rotate(ctx, `402 Payment Required — switching key + backing off model`);
      // Increment the cycle counter (track per-model attempts)
      if (cycleModel !== failedModel) {
        cycleModel = failedModel;
        cycleAttempts = 0;
      }
      cycleAttempts++;
      if (failedModel) {
        const newBackoff = Math.max(120, mbBefore > 0 ? mbBefore * 2 : 120);
        const ok = runXot(["model-backoff", failedModel, String(newBackoff)]);
        if (ok !== null) {
          ctx.ui.notify(
            `xot: Tier-2 backoff set for ${failedModel} (${newBackoff}s). ` +
              `Cycle attempt ${cycleAttempts}/${getPoolSize()} — will fall back after full pool.`,
            "info",
          );
        } else {
          ctx.ui.notify(
            `xot: WARN — could not set model backoff for ${failedModel} (script error). ` +
              `Run \`xot model-backoff ${failedModel} ${newBackoff}\` to debug.`,
            "warning",
          );
        }
        // Tier 3: auto-switch to fallback ONLY if we've exhausted the
        // full key pool on this model. Before that, keep rotating keys.
        const fallback = MODEL_FALLBACKS[failedModel];
        if (!fallback) {
          ctx.ui.notify(
            `xot: no fallback model for ${failedModel} — switch model manually with /model`,
            "warning",
          );
        }
        const poolSize = getPoolSize();
        const cycleComplete = cycleAttempts >= poolSize;
        if (fallback && bridge.setModel && cycleComplete) {
          const fbBackoff = isModelInBackoff(fallback);
          if (fbBackoff === 0) {
            const modelObj = findModelInRegistry(ctx, fallback);
            if (modelObj) {
              // Remember the user's original model so we can revert on
              // the next user prompt. Only save if this is the FIRST
              // auto-fallback in this session (don't overwrite a deeper
              // fallback chain entry with the previous-hop model).
              if (originalDefaultModel == null) {
                originalDefaultModel = failedModel;
              }
              manualModelOverride = false;
              const switched = await bridge.setModel(modelObj);
              if (switched) {
                ctx.ui.notify(
                  `xot: full cycle on ${failedModel} exhausted (${cycleAttempts} attempts). ` +
                    `Auto-switched to ${fallback} (will revert on next prompt).`,
                  "info",
                );
                // Reset the cycle counter for the new model.
                cycleAttempts = 0;
                cycleModel = fallback;
                // The revert on next prompt checks isModelInBackoff
                // before switching back.
              }
            }
          }
        }
      }
      // Save retry marker so user can continue.
      if (lastUserPrompt) {
        saveRetryMarker("insufficient balance (402 Payment Required, rotated + model backed off)", lastUserPrompt, ctx);
      }
    } else if (wasEmpty && recentlyRotated()) {
      // Empty response right after we rotated the key — almost certainly
      // a side effect of the rotation, not a real empty answer.
      if (lastUserPrompt) {
        saveRetryMarker("empty response after key rotation", lastUserPrompt, ctx);
      }
    }
  });

  // When pi's built-in transport retry exhausts (3 attempts of baseDelayMs*2^n
  // each, default 2s/4s/8s), back off the model for a few minutes so the
  // next session — including the same session if it does /xot pick — sees
  // this model as cooled and picks a different one. Without this hook, a
  // stream of three timeouts leaves the model "available" and the next
  // session hammers the same dead upstream. Trigger fires only on
  // *non-recoverable* retry exhaustion: not on 429 (handled by
  // after_provider_response), not on 4xx (rate limit, etc.), only on
  // transport-level timeouts and aborts after maxRetries.
  //
  // backoff: 5 minutes (300s). Same as the model-level backoff formula
  // for 402 (insufficient balance) — 5 min is enough for the upstream
  // to recover from a transient blip but short enough that the next
  // legitimate request can succeed.
  pi.on("auto_retry_end", (event: any, ctx: any) => {
    if (!event || event.success) return;
    const errMsg: string = (event.finalError ?? "") as string;
    if (PER_KEY_DAILY_RE.test(errMsg)) {
      if (!recentlyRotated()) {
        handlePerKeyDaily429(ctx, null);
      } else if (loadRetryState()?.needsRetry) {
        scheduleAutoContinue(ctx, 400);
      }
      return;
    }
    // Only act on transport-level failures. 4xx errors are already
    // handled by after_provider_response. 5xx are typically transient
    // and the server will recover on its own; we don't want to mark
    // the model as down for them.
    const isTransport =
      /request timed out|request timeout|connection timeout|aborted|network|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|getaddrinfo/i.test(errMsg);
    if (!isTransport) return;
    if (!lastModel) return;
    const backoffSec = 300;
    try {
      runXot(["model-backoff", lastModel, String(backoffSec)]);
    } catch {}
    // Surface a clear "switch to model X" hint in the live status so
    // the user can swap models. The actual model swap is manual because
    // the user may prefer the current model for context reasons.
    const fallback = MODEL_FALLBACKS[lastModel];
    const hint = fallback
      ? ` → try ${fallback}`
      : " → try a different model";
    // Both notify and setStatus must be wrapped — pi's UI throws on
    // sanitizer bugs (see the "" vs undefined workaround in
    // after_provider_response), and we don't want a UI hiccup to
    // crash the entire event loop.
    safeNotify(
      ctx,
      `xot: retry exhausted on ${lastModel} (${errMsg.slice(0, 60)}). Backing off ${backoffSec}s${hint}`,
      "warning",
    );
    // Set status so it's visible in the widget too (not just a transient toast)
    safeSetStatus(ctx, "xot", `model down${hint}`);
    // Reset local counters so the next non-error response starts fresh.
    limitedCount = 0;
  });

  // When the agent settles, if there's a pending retry marker and config
  // allows, prompt the user (default = continue).
  pi.on("agent_settled", async (_event: any, ctx: any) => {
    const state = loadRetryState();
    if (!state || !state.needsRetry) return;
    // Forget stale markers.
    if (Date.now() - state.timestamp > retryConfig.stickyForMinutes * 60_000) {
      clearRetryState();
      return;
    }
    if (!retryConfig.autoPromptOnBrokenTurn) {
      // Fully automatic recovery: re-send the last prompt immediately
      // (after a tiny delay so the editor is unfocused and the user's
      // own follow-up — if any — is not stomped). The user can cancel
      // with `/xot retry-cancel` if they want.
      const preview = state.prompt.length > 60
        ? state.prompt.slice(0, 60) + "…"
        : state.prompt;
      ctx.ui.notify(
        `xot: auto-resuming "${preview}" (use /xot retry-cancel to abort)`,
        "warning",
      );
      scheduleAutoContinue(ctx, retryConfig.autoContinueDelayMs);
      return;
    }
    const preview = state.prompt.length > 60
      ? state.prompt.slice(0, 60) + "…"
      : state.prompt;
    const ok = await ctx.ui.confirm(
      "xot: last turn was interrupted",
      `Reason: ${state.reason}\n\nLast prompt:\n  ${preview}\n\nRe-send this prompt? (default: yes)`,
    );
    if (ok) {
      await doContinue(ctx);
    } else {
      ctx.ui.notify("xot: retry cancelled. Type `continue` later to retry.", "info");
    }
  });

  function scheduleAutoContinue(ctx: any, delayMs?: number): void {
    const delay = delayMs ?? retryConfig.autoContinueDelayMs;
    const state = loadRetryState();
    if (!state?.needsRetry && !lastUserPrompt) return;
    if (scheduledContinueTimer) return;
    scheduledContinueTimer = setTimeout(async () => {
      scheduledContinueTimer = null;
      const cur = loadRetryState();
      if (!cur?.needsRetry) return;
      if (activeKey) applyOpenRouterKey(activeKey);
      await doContinue(ctx);
    }, delay);
  }

  async function doContinue(ctx: any): Promise<boolean> {
    const state = loadRetryState();
    if (!state || !state.needsRetry) {
      ctx.ui.notify("xot: no pending retry", "info");
      return false;
    }
    if (Date.now() - state.timestamp > retryConfig.stickyForMinutes * 60_000) {
      clearRetryState();
      ctx.ui.notify("xot: pending retry expired", "warning");
      return false;
    }
    const prompt = state.prompt;
    clearRetryState();
    ctx.ui.notify(`xot: continuing with rotated key…`, "info");
    // pi 0.84.x: sendUserMessage lives on the captured `pi` (which
    // delegates to the runtime), not on the per-call `ctx`. Try both.
    if (typeof (pi as any).sendUserMessage === "function") {
      await (pi as any).sendUserMessage(prompt);
      return true;
    }
    if (typeof ctx.sendUserMessage === "function") {
      await ctx.sendUserMessage(prompt);
      return true;
    }
    ctx.ui.notify("xot: cannot re-send (sendUserMessage unavailable on both pi and ctx)", "error");
    return false;
  }

  function saveRetryMarker(reason: string, prompt: string, ctx: any): void {
    if (!prompt) return;
    const state: RetryState = {
      needsRetry: true,
      prompt,
      reason,
      timestamp: Date.now(),
    };
    saveRetryState(state);
    ctx.ui.notify(
      `xot: last turn interrupted (${reason}). Press Enter on the next prompt to re-send, or type \`continue\`.`,
      "warning",
    );
    lastRotationTime = Date.now(); // mark for empty-turn detection
  }

  let lastRotationTime = 0;

  function recentlyRotated(): boolean {
    return Date.now() - lastRotationTime < 30_000;
  }

  function handlePerKeyDaily429(ctx: any, cooldownSec: number | null | undefined): void {
    const poolSize = getPoolSize();
    dailyRotateAttempts++;
    if (dailyRotateAttempts > poolSize) {
      safeNotify(
        ctx,
        `xot: all ${poolSize} keys hit daily free-model cap — wait for UTC reset or add credits`,
        "error",
      );
      return;
    }
    const prev = activeKey;
    if (prev) {
      const until = Math.floor(Date.now() / 1000) +
        (cooldownSec && cooldownSec > 0 ? cooldownSec : 6 * 3600);
      coolKey(prev, until);
    }
    const next = pickKey();
    if (next) {
      activeKey = next;
      applyOpenRouterKey(next);
      clearCoolCache();
      lastRotationTime = Date.now();
      const from = prev ? mask(prev) : "?";
      safeNotify(
        ctx,
        `xot: daily cap on ${from} → trying ${mask(next)} (${dailyRotateAttempts}/${poolSize})`,
        "warning",
      );
      refreshLiveStatus(ctx);
    } else {
      safeNotify(ctx, "xot: no next key available after daily cap", "error");
      return;
    }
    limitedCount = 0;
    if (lastUserPrompt) {
      saveRetryMarker("per-key daily cap (free-models-per-day)", lastUserPrompt, ctx);
      scheduleAutoContinue(ctx, 400);
    }
  }

  function extractAssistantText(msg: any): string {
    if (!msg) return "";
    if (typeof msg.content === "string") return msg.content.trim();
    if (Array.isArray(msg.content)) {
      let out = "";
      for (const p of msg.content) {
        if (typeof p === "string") out += p;
        else if (p?.type === "text" && typeof p.text === "string") out += p.text;
      }
      return out.trim();
    }
    return "";
  }

  async function rotate(ctx: any, reason: string, cooldownHint?: number | null) {
    // 1) notify ONCE at the start ("probing next key...")
    ctx.ui.notify(`xot: ${reason} — probing next key...`, "info");
    let extraEnv: Record<string, string> | undefined;
    if (cooldownHint != null && Number.isFinite(cooldownHint) && cooldownHint > 0)
      extraEnv = { ...process.env, XOT_COOLDOWN: String(Math.max(30, Math.ceil(cooldownHint))) } as Record<string, string>;
    const next = pickKey(extraEnv);
    // 2) if pickKey returned null, the LAST_MODEL is in Tier-2 backoff;
    //    surface a single clear message naming the model + fallback.
    if (!next) {
      if (lastModel) {
        const fallback = MODEL_FALLBACKS[lastModel];
        const fbNote = fallback
          ? ` Switching to fallback: ${fallback}.`
          : " No fallback configured — pick a different model manually.";
        ctx.ui.notify(
          `xot: ${lastModel} is in Tier-2 backoff (shared-pool exhausted).${fbNote}`,
          "warning",
        );
      } else {
        ctx.ui.notify("xot: all keys exhausted", "error");
      }
      return;
    }
    // 3) pickKey returned a real key. If it changed, ONE clear message.
    if (next !== activeKey) {
      activeKey = next;
      applyOpenRouterKey(next);
      clearCoolCache();
      lastRotationTime = Date.now();
      refreshLiveStatus(ctx);
      const oldShort = mask(activeKey);
      ctx.ui.notify(`xot: rotated — key switched, continuing`, "info");
      // setStatus disabled: rotated
    } else {
      // 4) pickKey returned the same key it already had. This means
      //    all the other keys are in cooldown (or in Tier-2 backoff
      //    for the same model). Don't keep notifying the same "rotated"
      //    message; instead, surface a *different* state: "stuck on
      //    this key" so the user knows the rotation didn't actually
      //    free us.
      ctx.ui.notify(
        `xot: all other keys are cooling or model is backed off — ` +
          `continuing with current key ${mask(activeKey)}…`,
        "warning",
      );
      // setStatus disabled: stuck
    }
    limitedCount = 0;
  }

  // ---- debug / test hooks -----------------------------------------------

  function debugSimulateBrokenTurn(ctx: any): void {
    if (!lastUserPrompt) {
      ctx.ui.notify("xot: no last user prompt to save; send a real message first", "warning");
      return;
    }
    saveRetryMarker("simulated broken turn (debug)", lastUserPrompt, ctx);
  }

  function debugSimulateInsufficientBalance(ctx: any): void {
    if (!lastUserPrompt) {
      ctx.ui.notify("xot: no last user prompt to save; send a real message first", "warning");
      return;
    }
    saveRetryMarker("simulated insufficient balance (debug)", lastUserPrompt, ctx);
  }

  // ---- commands ---------------------------------------------------------

  pi.registerCommand("resume-recent", {
    description: "continue the most recent session (same file, no new branch)",
    handler: async (_args: string, ctx: any) => {
      try {
        const fs = require("node:fs"); const pth = require("node:path");
        const dir = pth.join(process.env.HOME ?? "", ".pi", "agent", "sessions");
        if (!fs.existsSync(dir)) { ctx.ui.notify("no session dir", "warning"); return; }
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(".jsonl"))
          .map((f: string) => ({ n: f, s: fs.statSync(pth.join(dir, f)) }))
          .sort((a: any, b: any) => b.s.mtimeMs - a.s.mtimeMs);
        if (!files.length) { ctx.ui.notify("no session to resume", "warning"); return; }
        const path = pth.join(dir, files[0].n);
        ctx.ui.notify(`resuming ${files[0].n} (same file — no new branch)`, "info");
        (ctx as any).switchSession?.(path, { restorePosition: true }) ?? ctx.ui.notify("switchSession unavailable", "error");
      } catch (e: any) { ctx.ui.notify("resume failed: " + (e?.message ?? e), "error"); }
    },
  });
  pi.registerShortcut("ctrl+shift+r", {
    description: "resume most recent session (same file, no new branch, no bg tasks)",
    handler: async (ctx: any) => {
      (pi as any).registerCommand("resume-recent")?.handler?.("", ctx);
    },
  });

  // Ctrl+Shift+C = continue (re-submit last failed prompt)
  pi.registerShortcut("ctrl+shift+c", {
    description: "continue: re-submit the last failed prompt (after key rotation)",
    handler: async (ctx: any) => {
      await doContinue(ctx);
    },
  });

  pi.registerCommand("continue", {
    description: "re-submit the last user prompt (after a broken turn / key rotation), or inject the most recent saved context if no retry is pending",
    handler: async (_args: string, ctx: any) => {
      // First try: pending retry state (existing behavior).
      const state = loadRetryState();
      if (state && state.needsRetry) {
        await doContinue(ctx);
        return;
      }
      // Second try: most recent saved context from the context-inject
      // extension. The previous version of /continue did nothing if
      // there was no retry, which made it useless in a fresh session.
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        const home = process.env.HOME || "";
        const indexPath = path.join(home, ".pi", "agent", "context-inject", "index.json");
        if (fs.existsSync(indexPath)) {
          const idx = JSON.parse(fs.readFileSync(indexPath, "utf8"));
          const entries = Object.values(idx).sort(
            (a: any, b: any) => b.ts - a.ts,
          );
          if (entries.length > 0) {
            const e = entries[0] as any;
            const blockPath = path.join(
              home,
              ".pi",
              "agent",
              "context-inject",
              "blocks",
              `${e.id}.md`,
            );
            if (fs.existsSync(blockPath)) {
              const body = fs.readFileSync(blockPath, "utf8");
              const prompt = `[Continuing with saved context: ${e.name}]\n\n${body}`;
              if (typeof (pi as any).sendUserMessage === "function") {
                ctx.ui.notify(`xot: continuing with saved context "${e.name}" (no retry was pending)`, "info");
                await (pi as any).sendUserMessage(prompt);
                return;
              }
              if (typeof ctx.sendUserMessage === "function") {
                ctx.ui.notify(`xot: continuing with saved context "${e.name}" (no retry was pending)`, "info");
                await ctx.sendUserMessage(prompt);
                return;
              }
            }
          }
        }
      } catch { /* fall through */ }
      // Third try: nothing to do.
      await doContinue(ctx);
    },
  });

  pi.registerCommand("xot", {
    description: "key ring: status | rotate | reload | init | pick | key | keys | clear | continue | retry-cancel | retry-status | simulate-broken-turn",
    handler: async (args: string, ctx: any) => {
      const sub = (args ?? "").trim().split(/\s+/)[0] || "status";
      switch (sub) {
        case "rotate":
          await rotate(ctx, "manual rotate");
          break;
        case "reload":
          clearCoolCache();
          activeKey = pickKey();
          ctx.ui.notify(activeKey ? `xot: reloaded — now on ${mask(activeKey)}` : "xot: reload failed (no key)", "info");
          break;
        case "continue":
          await doContinue(ctx);
          break;
        case "retry-cancel":
          clearRetryState();
          ctx.ui.notify("xot: retry cleared", "info");
          break;
        case "retry-status": {
          const s = loadRetryState();
          if (!s || !s.needsRetry) {
            ctx.ui.notify("xot: no pending retry", "info");
          } else {
            const ageMin = Math.round((Date.now() - s.timestamp) / 60_000);
            const preview = s.prompt.length > 80 ? s.prompt.slice(0, 80) + "…" : s.prompt;
            ctx.ui.notify(
              `xot: pending retry (${ageMin}m ago) — ${s.reason}\n  prompt: ${preview}`,
              "info",
            );
          }
          break;
        }
        case "model-backoff": {
          // /xot model-backoff <model> [seconds]
          const model = args.replace(/^\S+\s+/, "").trim().split(/\s+/)[0];
          if (!model) {
            ctx.ui.notify("usage: /xot model-backoff <model> [seconds]", "warning");
            break;
          }
          const out = runXot(["model-backoff", ...args.replace(/^\S+\s+/, "").trim().split(/\s+/)]);
          ctx.ui.notify(out?.trim() || `xot: model-backoff set for ${model}`, "info");
          break;
        }
        case "model-backoff-status": {
          const out = runXot(["model-backoff-status", ...args.trim().split(/\s+/)]);
          ctx.ui.notify(out?.trim() || "(no output)", "info");
          break;
        }
        case "clear-model-backoff": {
          const model = args.trim().split(/\s+/)[0];
          if (!model) {
            ctx.ui.notify("usage: /xot clear-model-backoff <model>", "warning");
            break;
          }
          runXot(["clear-model-backoff", model]);
          ctx.ui.notify(`xot: cleared model backoff for ${model}`, "info");
          break;
        }
        case "simulate-broken-turn":
          debugSimulateBrokenTurn(ctx);
          break;
        case "simulate-insufficient-balance":
          debugSimulateInsufficientBalance(ctx);
          break;
        case "status":
        default: {
          const out = runXot([sub === "status" ? "status" : "status"]);
          ctx.ui.notify(
            (out ? out.trim().replace(/\n/g, " · ") : "") +
            (activeKey ? ` · active ${mask(activeKey)}` : " · no key") +
            ` · consecutive limit hits ${limitedCount} · cooldown ${process.env.XOT_COOLDOWN ?? "60"}s`,
            "info",
          );
          if (sub === "init" || sub === "pick" || sub === "key" || sub === "keys" || sub === "clear") {
            const out2 = runXot([sub]);
            if (out2) ctx.ui.notify(out2.trim().split("\n").slice(0, 5).join(" · "), "info");
          }
          break;
        }
      }
    },
  });
}

function mask(key: string): string {
  if (!key) return "(empty)";
  if (key.length <= 12) return key.slice(0, 2) + "…";
  return key.slice(0, 6) + "…" + key.slice(-4);
}
