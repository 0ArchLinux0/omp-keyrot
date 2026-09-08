/**
 * Floating Status Widget
 *
 * Shows live status under the input box (above input, below messages).
 * Tracks: model, context %, tokens, reasoning level, suggested level, XOT key.
 *
 * Place under input: ctx.ui.setWidget("status", [...])  (default is above input)
 * Footer: ctx.ui.setStatus("key", "value")
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function getCtxInfo(ctx: any): { tokens: number; window: number; pct: number; short: string; winShort: string } {
  const usage = ctx.getContextUsage?.();
  const tokens = usage?.tokens ?? 0;
  const window = usage?.contextWindow ?? 128000;
  const pct = (tokens / window) * 100;
  const short = tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
  const winShort = window >= 1000 ? `${Math.round(window / 1000)}k` : String(window);
  return { tokens, window, pct, short, winShort };
}

function getModelInfo(ctx: any): { model: string; provider: string; thinking: string } {
  const m = ctx.model;
  return {
    model: m?.id ?? "unknown",
    provider: m?.provider ?? "?",
    thinking: ctx.thinkingLevel ?? "medium",
  };
}

function suggestLevel(pct: number, current: string): string {
  if (pct > 80) return "low";
  if (pct > 50) return "medium";
  if (pct === 0) return "medium";
  return "high";
}

function getXotKeyInfo(): { idx: number; total: number; last: string; status: string; source: string; alias: string } {
  // Read rotation state from BOTH the python ledger and the xot state
  // file. As of 2026-09-06 the daemon's ACTIVE_IDX is the authoritative
  // source: xot.ts now syncs the ledger on every pick, so both should
  // agree, but the daemon state is the one the actual HTTP request uses.
  // We display the daemon's view, falling back to the ledger only when
  // ACTIVE_IDX is unavailable (e.g. fresh install before first pick).
  //
  // 2026-08-30: We show the ALIAS from the env file (PRIMARY, FIFTH, ...)
  // instead of the daemon's internal index, because the daemon's keys
  // list and the env have the same secrets in the same order now, but
  // the alias is the human-stable identifier.
  const fs = require("node:fs") as typeof import("node:fs");
  const p = require("node:path") as typeof import("node:path");
  const home = process.env.HOME || "";
  const xotDir = process.env.XOT_CACHE || p.join(home, ".local", "daemon", "xot");

  // Source 1 (authoritative): xot daemon state — ACTIVE_IDX is what the
  // in-process picker / bash daemon wrote when picking the actual key.
  const keys = fs.existsSync(p.join(xotDir, "keys"))
    ? fs.readFileSync(p.join(xotDir, "keys"), "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#"))
    : [];
  const state = fs.existsSync(p.join(xotDir, "state"))
    ? fs.readFileSync(p.join(xotDir, "state"), "utf8")
    : "";
  const m = state.match(/ACTIVE_IDX=(\d+)/);
  const xotIdx = m ? Number(m[1]) : -1;
  const xotKey = xotIdx >= 0 ? (keys[xotIdx] ?? "").trim() : "";

  // Source 2 (fallback): python ledger last_used alias — for the case
  // where ACTIVE_IDX is missing or out of range.
  const ledgerPath = p.join(home, ".config", "openrouter", "key_ledger.json");
  const envPath = p.join(home, ".config", "openrouter", "env");
  let pyAlias: string | null = null;
  let pyStatus: "ok" | "blocked" | "?" = "?";
  try {
    if (fs.existsSync(ledgerPath)) {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      pyAlias = ledger.last_used ?? null;
      if (pyAlias) {
        const row = ledger.keys?.[pyAlias];
        if (row) pyStatus = row.status === "blocked" ? "blocked" : "ok";
      }
    }
  } catch { /* fall through */ }

  // Build env lookup table: secret -> alias name
  const secretToAlias = new Map<string, string>();
  try {
    const envText = fs.readFileSync(envPath, "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^OPENROUTER_API_KEY_([A-Z_0-9]+)=(sk-or-v1-[A-Za-z0-9]+)/);
      if (m) secretToAlias.set(m[2], m[1]);
    }
  } catch { /* fall back to xot-only display */ }

  let displayIdx = xotIdx >= 0 ? xotIdx : 0;
  let displayKey = xotKey;
  let displayAlias: string = "?";
  let source = "xot";

  if (xotKey) {
    // Authoritative path: use the daemon's ACTIVE_IDX
    displayAlias = secretToAlias.get(xotKey) ?? "(unmapped)";
    source = "xot";
  } else if (pyAlias) {
    // Fallback: use the ledger
    displayAlias = pyAlias;
    source = "ledger";
    try {
      const aliasLine = fs.readFileSync(envPath, "utf8").split("\n").find(l => l.startsWith(`OPENROUTER_API_KEY_${pyAlias}=`));
      if (aliasLine) {
        const secret = aliasLine.split("=")[1]?.trim();
        if (secret) {
          displayKey = secret;
          const matchIdx = keys.findIndex(k => k.trim() === secret);
          if (matchIdx >= 0) displayIdx = matchIdx;
        }
      }
    } catch {}
  }

  const displayMasked = displayKey.length > 12
    ? displayKey.slice(0, 6) + "\u2026" + displayKey.slice(-4)
    : (displayKey || "(no key)");

  return { idx: displayIdx + 1, total: keys.length, last: displayMasked, status: pyStatus, source, alias: displayAlias };
}

function colorEmoji(pct: number, status: string): string {
  if (status === "cooling") return "🟠";
  if (pct > 90) return "🔴";
  if (pct > 70) return "🟡";
  if (pct > 30) return "🟢";
  return "🟢";
}

function statusIcon(status: string): string {
  if (status === "ok") return "✓";
  if (status === "cooling") return "❄";
  return "?";
}

function xotFooter(): string {
  const xot = getXotKeyInfo();
  return `🔑 XOT: ${xot.alias} ${statusIcon(xot.status)} ${xot.last}`;
}

function clearCustomChrome(ctx: any) {
  // undefined (not []) actually removes widgets; see extensions.md
  try { ctx.ui.setWidget?.("live-status", undefined); } catch {}
  try { ctx.ui.setWidget?.("behind", undefined); } catch {}
  try { ctx.ui.setWidget?.("status", undefined); } catch {}
  for (const key of ["behind", "ctx-monitor", "alias", "ratelimit", "reason-opt", "xot", "pre-send-guard", "prt"]) {
    try { ctx.ui.setStatus?.(key, ""); } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  function applyFooter(ctx: any) {
    clearCustomChrome(ctx);
    ctx.ui.setStatus?.("xot-key", xotFooter());
  }

  pi.on("turn_start", async (_event, ctx) => { applyFooter(ctx); });
  pi.on("agent_end", async (_event, ctx) => { applyFooter(ctx); });
  pi.on("agent_settled", async (_event, ctx) => { applyFooter(ctx); });
  pi.on("turn_end", async (_event, ctx) => { applyFooter(ctx); });
  pi.on("session_start", async (_event, ctx) => { applyFooter(ctx); });

  pi.registerCommand("status", {
    description: "Show XOT key in the official footer (and dump details via notify)",
    handler: async (_args, ctx) => {
      applyFooter(ctx);
      ctx.ui.notify(xotFooter(), "info");
    },
  });

  pi.registerCommand("live", {
    description: "Alias for /status",
    handler: async (_args, ctx) => {
      applyFooter(ctx);
      ctx.ui.notify(xotFooter(), "info");
    },
  });

  // omp's /reload-plugins does not reload ~/.pi/agent/extensions.
  // This command reloads pi extensions from disk (same as /behind reload).
  pi.registerCommand("reload-plugin", {
    description: "Reload pi extensions from disk, then keep only XOT on the official footer",
    handler: async (_args, ctx) => {
      applyFooter(ctx);
      ctx.ui.notify("Reloading pi extensions… then status bar = official + XOT only", "info");
      if (typeof ctx.reload === "function") {
        await ctx.reload();
      } else {
        ctx.ui.notify("ctx.reload() missing — run /behind reload, or quit and resume this session", "warning");
      }
    },
  });
}
