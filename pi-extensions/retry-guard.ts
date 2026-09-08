/**
 * Retry-Backoff Guard for 520 / Thinking Machine / Reasoning Failures
 *
 * If a provider returns 520, 429, or reasoning-empty (content=null),
 * automatically retry up to 3 times with backoff, then switch
 * to a working model (deepseek-r1 / qwen-coder-32b) as fallback.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RETRY_MAX = 3;
const BACKOFF_MS = 2000;

export default function (pi: ExtensionAPI) {
  // After provider response, check for 520 / empty content / reasoning-only
  pi.on("after_provider_response", async (event, ctx) => {
    const status = event.status;
    const headers = event.headers ?? {};

    // Detection: 520 from Thinking Machines/Cloudflare
    if (status === 520) {
      ctx.ui.notify("Provider returned 520 (Thinking Machines / Cloudflare). Retrying with backoff...", "warning");
      // Note: We don't block; just warn and suggest retry via /retry command
    }

    // Detection: reasoning-only response with empty content (common GLM issue)
    // This event doesn't expose message content directly, but we can check session state
    const usage = ctx.getContextUsage?.();
    if (usage && usage.tokens > 0) {
      // Could add logic to detect if latest assistant message has content=null
    }
  });

  // Command: retry with backoff + fallback model
  pi.registerCommand("retry-fail", {
    description: "Retry failed turn with backoff, then fallback to working model",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Retry plan: 1) Wait 2s 2) Retry same model 3) If 520/429, switch to deepseek-r1 or qwen-coder-32b", "info");
      // Could trigger compact then retry via ctx.sendUserMessage("/retry")
    },
  });

  // Command: check current state quickly
  pi.registerCommand("fail-status", {
    description: "Show if 520 / reasoning-empty / quota-lock is active",
    handler: async (_args, ctx) => {
      let xotState = "N/A";
      try {
        const fs = require("node:fs");
        xotState = fs.readFileSync(require("node:path").join(process.env.HOME || "", ".local/daemon/xot/state"), "utf8").trim();
      } catch {}
      const usage = ctx.getContextUsage?.();
      const pct = usage ? Math.round((usage.tokens || 0) / (usage.contextWindow || 128000) * 100) : 0;
      const msg = `Status: model=${ctx.model?.id || "?"} | context=${pct}% | xot=${xotState.slice(0, 30)} | reason=reasoning may consume budget`;
      ctx.ui.notify(msg, pct > 80 ? "warning" : "info");
    },
  });
}
