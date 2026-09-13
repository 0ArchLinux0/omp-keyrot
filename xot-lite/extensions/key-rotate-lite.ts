/**
 * key-rotate-lite — OpenRouter key rotation via xot-rotate (no full XOT stack).
 *
 * Multi-session: each OMP session auto-acquires an exclusive key via flock+registry.
 * Manual override: /key N still works (steals lock for this session).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const XOT_ROTATE = join(homedir(), ".local", "bin", "xot-rotate");
const LAST_429 = join(homedir(), ".config", "openrouter", "last_429.json");
const OPENROUTER_PROVIDERS = ["openrouter", "openrouter-free-auto"];
const HEARTBEAT_SECS = 60;

const PER_KEY_DAILY_RE =
  /free-models-per-day|openrouter_free_tier_daily|limit_rpd|high-balance/i;
const SHARED_POOL_RE =
  /shared[_-]?pool|upstream[_-]?provider[_-]?shared|provider[_-]?exhausted/i;
const AUTH_RE = /401|403|unauthorized|invalid api[_ -]?key|authentication required/i;

function fingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function maskKey(key: string): string {
  return key.length > 12 ? `sk-or-…${key.slice(-4)}` : "sk-or-…";
}

function runXot(args: string[]): string {
  return execFileSync(XOT_ROTATE, args, { encoding: "utf8", timeout: 30_000 });
}

function parseExportKey(out: string): string | null {
  const m = out.match(/export OPENROUTER_API_KEY='([^']+)'/);
  const key = m?.[1]?.trim() ?? null;
  if (key) process.env.OPENROUTER_API_KEY = key;
  return key;
}

function sessionIdFromCtx(ctx?: any, event?: any): string {
  const raw =
    ctx?.sessionId ??
    ctx?.session?.sessionId ??
    event?.sessionId ??
    (typeof ctx?.sessionManager?.getSessionFile === "function"
      ? ctx.sessionManager.getSessionFile()
      : "") ??
    process.env.XOT_SESSION_ID ??
    process.env.OMP_SESSION_ID ??
    "";
  const s = String(raw || "");
  const uuid = s.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  if (uuid) return uuid[0];
  if (s) return s;
  return `omp-pid-${process.pid}`;
}

function acquireKey(sessionId: string): string | null {
  if (!existsSync(XOT_ROTATE) || !sessionId) {
    return process.env.OPENROUTER_API_KEY?.trim() || null;
  }
  try {
    const out = runXot(["acquire", sessionId, String(process.pid)]);
    process.env.XOT_SESSION_ID = sessionId;
    return parseExportKey(out);
  } catch {
    return process.env.OPENROUTER_API_KEY?.trim() || null;
  }
}

function releaseKey(sessionId: string): void {
  if (!existsSync(XOT_ROTATE) || !sessionId) return;
  try {
    runXot(["release", sessionId]);
  } catch {
    /* best effort */
  }
}

function heartbeatKey(sessionId: string): void {
  if (!existsSync(XOT_ROTATE) || !sessionId) return;
  try {
    runXot(["heartbeat", sessionId, String(process.pid)]);
  } catch {
    /* best effort */
  }
}

function bumpKey(sessionId: string): string | null {
  if (!existsSync(XOT_ROTATE) || !sessionId) return null;
  try {
    return parseExportKey(runXot(["bump", sessionId, String(process.pid)]));
  } catch {
    return null;
  }
}

function setKeyByNumber(oneBased: number, sessionId?: string): string | null {
  if (!existsSync(XOT_ROTATE)) return null;
  try {
    const args = sessionId
      ? ["set", String(oneBased), sessionId, String(process.pid)]
      : ["set", String(oneBased)];
    return parseExportKey(runXot(args));
  } catch {
    return null;
  }
}

function coolKey(key: string, untilEpoch = 0): void {
  if (!existsSync(XOT_ROTATE)) return;
  try {
    const fp = fingerprint(key);
    const args = untilEpoch > 0 ? ["cool", fp, String(untilEpoch)] : ["cool", fp];
    runXot(args);
  } catch {
    /* best effort */
  }
}

function syncQuota(): string | null {
  if (!existsSync(XOT_ROTATE)) return process.env.OPENROUTER_API_KEY?.trim() || null;
  try {
    return parseExportKey(runXot(["sync_quota"]));
  } catch {
    return null;
  }
}

function resetAdvisor(ctx: any): boolean {
  try {
    const session = ctx?.session;
    if (!session?.setAdvisorEnabled) return false;
    session.setAdvisorEnabled(false);
    session.setAdvisorEnabled(true);
    return true;
  } catch {
    return false;
  }
}

function isOpenRouterProvider(provider: string): boolean {
  return OPENROUTER_PROVIDERS.includes(provider);
}

function providerFromEvent(event: any, ctx?: any): string {
  return String(
    ctx?.model?.provider ??
      event?.provider ??
      event?.payload?.provider ??
      event?.request?.provider ??
      "",
  );
}

function extractBody(event: any): string {
  const raw = event?.body ?? event?.text ?? event?.response?.body ?? event?.error ?? "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return "";
  }
}

function extractHeaders(event: any): Record<string, string> {
  const h = event?.headers ?? event?.response?.headers ?? {};
  if (h && typeof h === "object" && !Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      out[k.toLowerCase()] = String(v);
    }
    return out;
  }
  return {};
}

function parseResetEpoch(headers: Record<string, string>, body: string): number {
  const resetHdr = headers["x-ratelimit-reset"];
  if (resetHdr && /^\d+$/.test(resetHdr)) {
    const n = Number(resetHdr);
    return n > 1e10 ? Math.floor(n / 1000) : n;
  }
  const m = body.match(/retry-after-ms[=:\s]+(\d+)/i);
  if (m) {
    const ms = Number(m[1]);
    if (ms > 0) return Math.floor(Date.now() / 1000) + Math.ceil(ms / 1000);
  }
  const ra = headers["retry-after"];
  if (ra && /^\d+$/.test(ra)) {
    const sec = Number(ra);
    return Math.floor(Date.now() / 1000) + (sec > 86400 ? Math.ceil(sec / 1000) : sec);
  }
  return 0;
}

type ErrorClass = "daily" | "shared" | "auth" | "transient" | "other";

function classifyError(status: number | undefined, body: string): ErrorClass {
  const b = body.toLowerCase();
  if (status === 401 || status === 403 || AUTH_RE.test(b)) return "auth";
  if (SHARED_POOL_RE.test(b)) return "shared";
  if (PER_KEY_DAILY_RE.test(b)) return "daily";
  if (status === 429) return "transient";
  return "other";
}

function log429(event: any, kind: ErrorClass, key: string | null): void {
  try {
    const dir = join(homedir(), ".config", "openrouter");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      LAST_429,
      JSON.stringify(
        {
          ts: Date.now() / 1000,
          kind,
          key: key ? maskKey(key) : null,
          status: event?.status ?? event?.response?.status,
          body_excerpt: extractBody(event).slice(0, 300),
        },
        null,
        2,
      ),
    );
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  let activeKey: string | null = null;
  let sessionId: string | null = null;
  let lastHeartbeat = 0;

  function applyKey(key: string): void {
    process.env.OPENROUTER_API_KEY = key;
    activeKey = key;
    try {
      if (typeof (pi as any).registerProvider === "function") {
        for (const name of OPENROUTER_PROVIDERS) {
          (pi as any).registerProvider(name, { apiKey: key, authHeader: true });
        }
      }
    } catch {
      /* provider may not exist yet */
    }
  }

  function ensureKey(ctx?: any): string | null {
    const sid = sessionId ?? sessionIdFromCtx(ctx);
    sessionId = sid;
    const key = acquireKey(sid);
    if (key) applyKey(key);
    return key;
  }

  function maybeHeartbeat(): void {
    if (!sessionId) return;
    const now = Date.now();
    if (now - lastHeartbeat < HEARTBEAT_SECS * 1000) return;
    lastHeartbeat = now;
    heartbeatKey(sessionId);
  }

  pi.on("session_start", async (event: unknown, ctx: unknown) => {
    sessionId = sessionIdFromCtx(ctx, event);
    const key = acquireKey(sessionId);
    if (key) {
      applyKey(key);
      lastHeartbeat = Date.now();
    }
  });

  pi.on("session_shutdown", async () => {
    if (sessionId) releaseKey(sessionId);
    sessionId = null;
    activeKey = null;
  });

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const provider = providerFromEvent(event, ctx);
    if (!isOpenRouterProvider(provider)) return;
    maybeHeartbeat();
    const key = activeKey ?? ensureKey(ctx);
    if (!key) {
      console.error("key-rotate: no OPENROUTER_API_KEY available");
      return;
    }
    applyKey(key);
    const payload = event?.payload ?? event;
    const req = payload?.request ?? payload;
    if (req?.headers) {
      req.headers.Authorization = `Bearer ${key}`;
      req.headers.authorization = `Bearer ${key}`;
    }
  });

  pi.on("before_provider_headers", async (event: any, ctx: any) => {
    const provider = providerFromEvent(event, ctx);
    if (!isOpenRouterProvider(provider)) return;
    maybeHeartbeat();
    const key = activeKey ?? ensureKey(ctx);
    if (!key) return;
    event.headers = event.headers ?? {};
    event.headers.Authorization = `Bearer ${key}`;
    event.headers.authorization = `Bearer ${key}`;
  });

  pi.on("after_provider_response", async (event: any, ctx: any) => {
    const provider = providerFromEvent(event, ctx);
    if (!isOpenRouterProvider(provider)) return;

    const status = event.status ?? event.response?.status;
    const body = extractBody(event);
    const headers = extractHeaders(event);
    const kind = classifyError(status, body);

    if (kind === "shared" || kind === "transient" || kind === "other") return;

    if (kind === "daily" || kind === "auth") {
      const prev = activeKey ?? process.env.OPENROUTER_API_KEY ?? null;
      const sid = sessionId ?? sessionIdFromCtx(ctx, event);
      log429(event, kind, prev);
      if (prev) {
        const until = kind === "daily" ? parseResetEpoch(headers, body) : 0;
        coolKey(prev, until);
      }
      const next = acquireKey(sid);
      if (next && next !== prev) {
        applyKey(next);
        resetAdvisor(ctx);
        ctx.ui?.notify?.(
          `key-rotate: ${kind} on ${maskKey(prev ?? "?")} -> ${maskKey(next)} (session lock)`,
          "warning",
        );
      } else if (kind === "daily" && !next) {
        ctx.ui?.notify?.(
          `key-rotate: all keys daily-capped or locked — try /key-probe all or wait for UTC reset`,
          "error",
        );
      }
    }
  });

  pi.registerCommand("key", {
    description: "Force KEY_N (e.g. /key 2 -> KEY_02)",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const n = Number.parseInt(raw, 10);
      if (!raw || !Number.isFinite(n) || n < 1) {
        ctx.ui.notify("Usage: /key <N>  (1=KEY_01, 2=KEY_02, ...)", "warning");
        return;
      }
      const sid = sessionId ?? sessionIdFromCtx(ctx);
      sessionId = sid;
      const key = setKeyByNumber(n, sid);
      if (key) applyKey(key);
      const label = `KEY_${String(n).padStart(2, "0")}`;
      ctx.ui.notify(
        key
          ? `Forced ${label}: ${maskKey(key)} (session lock)`
          : `Failed to set ${label} — out of range or missing keys file`,
        key ? "success" : "error",
      );
    },
  });

  pi.registerCommand("key-rotate", {
    description: "Move this session to the next free key (keeps lock)",
    handler: async (_args, ctx) => {
      const prev = activeKey;
      const sid = sessionId ?? sessionIdFromCtx(ctx);
      sessionId = sid;
      const next = bumpKey(sid);
      if (next) applyKey(next);
      const msg = next
        ? `Bumped ${prev ? maskKey(prev) : "?"} -> ${maskKey(next)} (session lock)`
        : "No free key — all locked or cooling";
      ctx.ui.notify(msg, next ? "info" : "error");
    },
  });

  pi.registerCommand("key-status", {
    description: "Show xot-rotate key pool + session locks",
    handler: async (_args, ctx) => {
      if (!existsSync(XOT_ROTATE)) {
        ctx.ui.notify("xot-rotate not found", "error");
        return;
      }
      try {
        const out = runXot(["status"]);
        const cur = activeKey ? `\nsession: ${maskKey(activeKey)}` : "";
        const sid = sessionId ? `\nlock: ${sessionId.slice(0, 12)}...` : "";
        ctx.ui.notify((out.trim() + cur + sid).slice(0, 2500), "info");
      } catch (e) {
        ctx.ui.notify(`key-status error: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("key-probe", {
    description: "Probe :free quota (key-probe [idx|all])",
    handler: async (args, ctx) => {
      if (!existsSync(XOT_ROTATE)) {
        ctx.ui.notify("xot-rotate not found", "error");
        return;
      }
      try {
        const arg = args.trim() || "active";
        const out = runXot(["probe", arg]);
        ctx.ui.notify(out.trim().slice(0, 2500), "info");
      } catch (e) {
        ctx.ui.notify(`key-probe error: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("uncool", {
    description: "Sync quota, re-acquire session key, reset advisor",
    handler: async (_args, ctx) => {
      syncQuota();
      const sid = sessionId ?? sessionIdFromCtx(ctx);
      sessionId = sid;
      const key = acquireKey(sid);
      if (key) applyKey(key);
      const advisorReset = resetAdvisor(ctx);
      const lines = [
        "Synced with OpenRouter (local COOL cleared).",
        key
          ? `Active: ${maskKey(key)} (auto-assigned for this session)`
          : "No working key - all daily-capped until UTC midnight",
        "Multi-session: each OMP session gets its own key automatically.",
        "Manual override: /key <N>",
        advisorReset
          ? "Advisor quota state reset."
          : "Run /advisor off then /advisor on if quota warning persists.",
      ];
      ctx.ui.notify(lines.join("\n"), key ? "success" : "warning");
    },
  });
}
