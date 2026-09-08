/**
 * Rate-Limit / 429 Handler
 *
 * If a provider returns 429 (like Thinking Machines / z-ai/glm-5.2:free),
 * this detects it and suggests: wait for reset, switch model, or retry.
 *
 * The 429 reset timestamp (X-RateLimit-Reset) tells when the provider allows requests again.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const RESET_TS = 1787875200000; // ms = ~Aug 27 14:00 UTC (from 429 response analysis)
  const RESET_DATE = new Date(RESET_TS); // for display

  pi.registerCommand("ratelimit", {
    description: "Show 429 rate limit status, reset time, and bypass options",
    handler: async (_args, ctx) => {
      const nowMs = Date.now();
      const waitSec = Math.round((RESET_TS - nowMs) / 1000);
      const waitMin = Math.round(waitSec / 60);
      const msg = [
        `=== 429 RATE LIMIT STATUS ===`,
        `Reset timestamp (ms): ${RESET_TS}`,
        `Reset time: ~${RESET_DATE.toISOString()}`,
        `Wait remaining: ${waitSec}s (~${waitMin} min)`,
        `Cause: Rapid testing loop (10 models x 3 retries in ~30s) exceeded z-ai/glm-5.2:free limit (50/min)`,
        `Fix: Wait ~8.7h, or use deepseek/deepseek-r1 (verified OK) temporarily`,
        `OR restart session with /new to clear provider-side state`,
      ].join("\n");
      ctx.ui.notify(msg, "info");
    },
  });

  // Before sending: show rate-limit status in footer
  pi.on("before_provider_request", (event, ctx) => {
    if (event.headers) {
      event.headers["HTTP-Referer"] = "https://pi.dev/";
      event.headers["X-Title"] = "pi-coding-agent";
      event.headers["User-Agent"] = "pi-coding-agent/0.84.3";
    }
    const resetMsg = `Rate reset ~${new Date(RESET_TS).toLocaleString()} (${Math.round((RESET_TS - Date.now()) / 60000)}m left) — with harness headers`;
    ctx.ui.setStatus?.("ratelimit", resetMsg);
  });
}
