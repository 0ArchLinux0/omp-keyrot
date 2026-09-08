/**
 * xot-router — v1 PROTOTYPE for fallback-model routing.
 *
 * What this does:
 *   On every `before_agent_start`, inspect the goal/task description
 *   the agent is about to run. If it matches a "low-stakes" pattern
 *   (lint/format/typo/comment/test-only/simple), swap the model the
 *   agent will call to a fallback from `xot-router.settings.json`.
 *
 *   The swap is done by rewriting the event's `model` field (or
 *   request body `model` field) BEFORE xot.ts picks the key. This
 *   means xot's key rotation still works, just on a different model.
 *
 * Why v1 (not a real classifier):
 *   The hard version — model classification, cost-vs-quality scoring,
 *   context-window-aware routing — is a real ML problem and brittle to
 *   implement ad-hoc. The easy version here is a single regex + a
 *   static fallback array. Good enough to validate the architecture.
 *   If this proves useful, replace `isLowStakes()` with a proper
 *   classifier later.
 *
 * Atomic default:
 *   If the agent never sets a `taskProfile` hint (we read it from the
 *   first user message), we route to the strongest model. No swap.
 *
 * Storage:
 *   Settings at `~/.pi/agent/xot-router.json`. Schema:
 *   {
 *     "fallbackModels": ["z-ai/glm-5.3-flash:free", "minimax/minimax-m3:free"],
 *     "lowStakesRegex": "/lint|format|typo|comment|docstring|test-only|simple/i",
 *     "lowStakesSuffix": ":simple",
 *     "enabled": true
 *   }
 *
 * Companion test: tests/xot-router.test.cjs
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME ?? homedir();
const SETTINGS_PATH = join(HOME, ".pi", "agent", "xot-router.json");

interface RouterSettings {
  fallbackModels: string[];
  lowStakesRegex: string;
  lowStakesSuffix: string;
  enabled: boolean;
}

const DEFAULTS: RouterSettings = {
  fallbackModels: ["z-ai/glm-5.3-flash:free", "minimax/minimax-m3:free"],
  // Note: lowStakesRegex is a JS source regex, not a JSON pattern.
  // Compiled at load time. Keep it simple — single alternation.
  lowStakesRegex: "/lint|format|typo|comment|docstring|test-only|simple/i",
  lowStakesSuffix: ":simple",
  enabled: true,
};

function loadSettings(): RouterSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return { ...DEFAULTS };
    const t = readFileSync(SETTINGS_PATH, "utf8");
    if (!t.trim()) return { ...DEFAULTS };
    const parsed = JSON.parse(t);
    return {
      fallbackModels: Array.isArray(parsed.fallbackModels) ? parsed.fallbackModels : DEFAULTS.fallbackModels,
      lowStakesRegex: typeof parsed.lowStakesRegex === "string" ? parsed.lowStakesRegex : DEFAULTS.lowStakesRegex,
      lowStakesSuffix: typeof parsed.lowStakesSuffix === "string" ? parsed.lowStakesSuffix : DEFAULTS.lowStakesSuffix,
      enabled: parsed.enabled !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function compileRegex(src: string): RegExp {
  // Convert "/pat/flags" to RegExp. If src is already a regex source (no /…/), wrap it.
  const m = /^\/(.*)\/([gimsuy]*)$/.exec(src);
  if (m) {
    try { return new RegExp(m[1], m[2]); } catch { return /never/i; }
  }
  try { return new RegExp(src, "i"); } catch { return /never/i; }
}

let _settings: RouterSettings | null = null;
let _lowStakesRe: RegExp | null = null;
function settings(): RouterSettings {
  if (!_settings) {
    _settings = loadSettings();
    _lowStakesRe = compileRegex(_settings.lowStakesRegex);
  }
  return _settings;
}
function re(): RegExp {
  if (!_lowStakesRe) settings();
  return _lowStakesRe!;
}

function isLowStakes(text: string): boolean {
  const s = settings();
  if (!text) return false;
  if (text.endsWith(s.lowStakesSuffix)) return true;
  return re().test(text);
}

function pickFallback(): string | null {
  const s = settings();
  if (s.fallbackModels.length === 0) return null;
  // For v1: pick the first one. Future: round-robin or health-based.
  return s.fallbackModels[0];
}

export default function (pi: ExtensionAPI): void {
  let lastTaskHint: string | null = null;
  let lastOriginalModel: string | null = null;
  let lastSwappedTo: string | null = null;

  // 1. Capture the user task on agent_start so we can classify it.
  pi.on("before_agent_start", async (event: any) => {
    const s = settings();
    if (!s.enabled) return;
    // The "task" is the first user message text. Pull it from the event
    // shape that pi uses (varies slightly by version).
    let text = "";
    if (typeof event?.message === "string") text = event.message;
    else if (Array.isArray(event?.message?.content)) {
      text = event.message.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text ?? "")
        .join(" ");
    } else if (typeof event?.prompt === "string") text = event.prompt;
    lastTaskHint = text;
  });

  // 2. On every provider request, decide if we should swap.
  pi.on("before_provider_request", async (event: any) => {
    const s = settings();
    if (!s.enabled) return;
    if (!lastTaskHint) return;
    if (!isLowStakes(lastTaskHint)) return;

    const target = pickFallback();
    if (!target) return;

    // Rewrite the model in the event so xot/auto-rotate pick the
    // fallback instead of the original.
    let mutated = false;
    if (event && typeof event === "object") {
      if (typeof event.model === "string") {
        lastOriginalModel = event.model;
        event.model = target;
        mutated = true;
      }
      if (event.request && typeof event.request === "object" && typeof event.request.model === "string") {
        lastOriginalModel = event.request.model;
        event.request.model = target;
        mutated = true;
      }
    }
    if (mutated) {
      lastSwappedTo = target;
      console.error(`xot-router: low-stakes task -> swap model to ${target} (hint: ${lastTaskHint.slice(0, 60)}…)`);
    }
  });

  // 3. Slash command to view settings + force reload.
  pi.registerCommand("router-status", {
    description: "show xot-router settings + last swap",
    handler: async (_args, ctx) => {
      const s = settings();
      const lines: string[] = [];
      lines.push(`xot-router:`);
      lines.push(`  enabled: ${s.enabled}`);
      lines.push(`  fallbackModels: ${JSON.stringify(s.fallbackModels)}`);
      lines.push(`  lowStakesRegex: ${s.lowStakesRegex}`);
      lines.push(`  lowStakesSuffix: "${s.lowStakesSuffix}"`);
      lines.push(`  last task hint: ${lastTaskHint ? lastTaskHint.slice(0, 80) : "(none)"}`);
      lines.push(`  last original model: ${lastOriginalModel ?? "(none)"}`);
      lines.push(`  last swapped to: ${lastSwappedTo ?? "(none)"}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("router-reload", {
    description: "force reload of xot-router settings from disk",
    handler: async (_args, ctx) => {
      _settings = null;
      _lowStakesRe = null;
      const s = settings();
      ctx.ui.notify(`xot-router: reloaded; enabled=${s.enabled} fallbackModels=${s.fallbackModels.length}`, "info");
    },
  });
}

export const __testing = {
  loadSettings,
  compileRegex,
  isLowStakes,
  pickFallback,
  DEFAULTS,
  SETTINGS_PATH,
};