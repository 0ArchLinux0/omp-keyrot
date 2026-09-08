/**
 * Model Rotation Extension
 *
 * Handles the case where the user's primary model (M3) is rate-limited
 * at the upstream provider (GMICloud shared pool). 12 keys from 12
 * different accounts all hit the same GMICloud pool, so key rotation
 * does NOT help — model rotation does.
 *
 * Strategy:
 * 1. Track per-model health in xot state (MODEL_BACKOFF_<model>)
 * 2. On 429 shared_pool for the current model, add model to backoff
 * 3. On next request, if the current model is in backoff, switch to
 *    the next model in the fallback chain (different upstream provider)
 * 4. Models with DIFFERENT upstream providers have INDEPENDENT rate
 *    limits, so this is the right strategy
 *
 * Fallback chain (verified working in earlier session):
 *   1. minimax/minimax-m3:free        (GMICloud, fast, 1M ctx)
 *   2. nvidia/nemotron-3-ultra-550b-a55b:free (NVIDIA, 1M ctx)
 *   3. nvidia/nemotron-3-super-120b-a12b:free (NVIDIA, 262k ctx)
 *   4. poolside/laguna-s-2.1:free      (Poolside, 262k ctx)
 *
 * The chain prefers different upstream providers first, so if M3's
 * GMICloud pool is exhausted, we go to Nemotron's NVIDIA pool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const XOT_DIR = process.env.XOT_CACHE || join(process.env.HOME || "", ".local", "daemon", "xot");
// Use a separate file from the main `state` (which the xot daemon
// `rm -f`s every 300s as part of its probe-cache invalidation). The
// model-backoff state needs to survive daemon cycles.
const STATE_PATH = join(XOT_DIR, "model_backoff");

// Fallback chain — verified working. Order matters: try different
// upstream providers before same-provider models.
const FALLBACK_CHAIN = [
  "minimax/minimax-m3:free",                   // GMICloud
  "nvidia/nemotron-3-ultra-550b-a55b:free",    // NVIDIA
  "nvidia/nemotron-3-super-120b-a12b:free",    // NVIDIA
  "poolside/laguna-s-2.1:free",                // Poolside
];

// Per-model max_tokens override. Some free models charge per output
// token; OpenRouter's auto-routing then refuses requests that ask
// for more than the user can afford. The default pi agent asks for
// the model's full context window as max_tokens, which is way over
// budget for the larger-context models (Kimi-K2, Nemotron-Ultra).
// We cap each model's max_tokens to a sensible chat-completion value.
const MODEL_MAX_TOKENS: Record<string, number> = {
  "minimax/minimax-m3:free": 8192,
  "nvidia/nemotron-3-ultra-550b-a55b:free": 4096,
  "nvidia/nemotron-3-super-120b-a12b:free": 4096,
  "poolside/laguna-s-2.1:free": 4096,
  "moonshotai/kimi-k2.6": 1500,  // 2026-09-03: lowered from 4096 because key 15 only affords 1198
  "z-ai/glm-3-flash": 4096,
  "z-ai/glm-5.3-flash": 4096,
  "openrouter/z-ai/glm-5.3-flash": 4096,
  "openrouter/z-ai/glm-3-flash": 4096,
  "openrouter/z-ai/glm-5.3": 4096,
};

const DEFAULT_MAX_TOKENS = 4096;

// How long to back off a model after a shared_pool 429 (seconds).
// Tunable via env: `MODEL_ROTATION_BACKOFF_S`.
//
// Default 30s is a balance: long enough to let the upstream pool
// drain a few of the user's other concurrent requests, short enough
// that the next session retry doesn't sit on a cold model.
// Per upstream: GMICloud's retry-after was 60s; NVIDIA's typical
// 429 retry-after is 5-10s.
const SHARED_POOL_BACKOFF_S = Number(
  process.env.MODEL_ROTATION_BACKOFF_S || 30,
);

type ModelBackoff = { model: string; until_epoch: number; count: number };

function readState(): Record<string, string> {
  if (!existsSync(STATE_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(STATE_PATH, "utf8").split("\n")) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function writeStateKey(key: string, value: string): void {
  if (!existsSync(STATE_PATH)) return;
  let s = readFileSync(STATE_PATH, "utf8");
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(s)) s = s.replace(re, `${key}=${value}`);
  else s += `${key}=${value}\n`;
  writeFileSync(STATE_PATH, s);
}

function isModelInBackoff(model: string): boolean {
  const state = readState();
  const key = `MODEL_BACKOFF_UNTIL_${model.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const until = Number(state[key] || 0);
  return until > Date.now() / 1000;
}

function backoffModel(model: string, seconds: number): void {
  const until = Math.floor(Date.now() / 1000) + seconds;
  const key = `MODEL_BACKOFF_UNTIL_${model.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  writeStateKey(key, String(until));
  // Also bump the count (matches xot's existing counter)
  const countKey = `MODEL_BACKOFF_COUNT_${model.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  const state = readState();
  const count = Number(state[countKey] || 0) + 1;
  writeStateKey(countKey, String(count));
}

function pickFallbackModel(currentModel: string): string | null {
  for (const m of FALLBACK_CHAIN) {
    if (m === currentModel) continue;
    if (!isModelInBackoff(m)) return m;
  }
  return null; // all in backoff
}

export default function (pi: ExtensionAPI) {
  // 2026-09-07: XOT_STRICT_ROTATE=1 disables model-rotation entirely.
  // The user wants pure (active+1)%N key rotation with no model
  // fallback. If we let this extension run, it would switch models on
  // 429, which is exactly the opposite of what the user asked for.
  // (Reasoning-required 400 is the one exception: that error means the
  // model itself is incompatible, not a transient rate limit. We still
  // want to switch off that model so the request can succeed.)
  const strictRotate = process.env.XOT_STRICT_ROTATE === "1";

  // When a request fails with shared_pool 429, back off the model and
  // remember to switch next time.
  // Also handles 400 "Reasoning is mandatory" — that error means the
  // model requires reasoning, the SDK sent reasoning=false, and retrying
  // with the same model hits the same wall. Switch to a model that
  // doesn't have the constraint.
  pi.on("after_provider_response", async (event: any, _ctx: any) => {
    const status = event?.status;
    const body: string =
      (event?.response?.body ?? event?.body ?? "").toString().toLowerCase();

    // Handle 400 "Reasoning is mandatory" — switch to non-reasoning model.
    // This is the one error we still handle under strict-rotate: the model
    // is structurally incompatible (not just rate-limited), and no key
    // rotation will fix it. We must fall back to a model that accepts the
    // current reasoning config.
    if (status === 400 && body.includes("reasoning is mandatory")) {
      const model = event?.response?.model ?? event?.model;
      if (!model) return;
      // Long backoff: this model is incompatible with current config
      backoffModel(model, 3600);
      const consecutiveKey = `MODEL_429_STREAK_${model.replace(/[^a-zA-Z0-9_]/g, "_")}`;
      const stateNow = readState();
      const streak = Number(stateNow[consecutiveKey] || 0) + 1;
      writeStateKey(consecutiveKey, String(streak));
      console.error(
        `model-rotation: ${model} requires reasoning (400); backoff 1h, will fallback next turn`,
      );
      return;
    }

    if (status !== 429 && status !== 402) return;
    // Under strict-rotate, we still log the error but do NOT back off the
    // model. The user wants pure key rotation; model fallback is out of
    // scope. This is the deliberate contract: errors that key rotation
    // cannot fix (shared pool, daily cap that hits the whole account) are
    // accepted as-is, and the next call simply advances the key.
    if (strictRotate) {
      console.error(`model-rotation: strict-rotate active, NOT backing off ${event?.response?.model ?? event?.model} on ${status} (next pick advances key automatically)`);
      return;
    }
    // Detect OpenRouter's daily free-tier cap. It hits ALL free
    // models at once, so we back off the entire fallback chain for
    // the duration of the reset window (typically next UTC midnight).
    if (
      body.includes("openrouter_free_tier_daily") ||
      body.includes("free-models-per-day") ||
      body.includes("openrouter_credits") ||
      body.includes("requires more credits")
    ) {
      // Long backoff: 12h is a safe upper bound; daily cap usually
      // resets sooner but we don't have a precise clock here. For
      // openrouter_credits (per-account credits exhausted) the
      // recovery action is the same: don't hammer an exhausted
      // account, wait or pay.
      const DAILY_BACKOFF_S = 12 * 3600;
      for (const m of FALLBACK_CHAIN) {
        backoffModel(m, DAILY_BACKOFF_S);
      }
      console.error(
        `model-rotation: openrouter quota hit (free-tier daily cap or credits exhausted); backing off ALL free models for 12h`,
      );
      return;
    }
    if (
      !body.includes("upstream_provider_shared_pool") &&
      !body.includes("shared pool") &&
      !body.includes("provider")
    ) {
      return;
    }
    const model = event?.response?.model ?? event?.model;
    if (!model) return;
    // Back off the model
    backoffModel(model, SHARED_POOL_BACKOFF_S);
    // Pick a fallback
    const fallback = pickFallbackModel(model);

    // Count-based escalation: after N consecutive 429s on the same
    // model, give it a much longer backoff (the rest of the session
    // in practice). This prevents thrashing between base and fallback
    // when both pools are warm.
    const consecutiveKey = `MODEL_429_STREAK_${model.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const stateNow = readState();
    const streak = Number(stateNow[consecutiveKey] || 0) + 1;
    writeStateKey(consecutiveKey, String(streak));
    const STREAK_THRESHOLD = Number(
      process.env.MODEL_ROTATION_STREAK_THRESHOLD || 2,
    );
    if (streak >= STREAK_THRESHOLD) {
      // Long backoff: 1 hour. Counts as "this model is dead for the
      // rest of the session" without changing the FALLBACK_CHAIN
      // order. To re-enable, run `/xot init` or `model-clear`.
      const LONG_BACKOFF_S = 3600;
      backoffModel(model, LONG_BACKOFF_S);
      console.error(
        `model-rotation: ${model} hit ${streak} consecutive 429s; LONG backoff (1h) until manual reset`,
      );
    }

    if (fallback) {
      console.error(
        `model-rotation: ${model} shared_pool exhausted; will switch to ${fallback} next turn (streak=${streak})`,
      );
    } else {
      console.error(
        `model-rotation: ${model} shared_pool exhausted; ALL models in backoff (waiting) (streak=${streak})`,
      );
    }
  });

  // On a successful response, reset the streak counter for the model
  // that answered. This lets a model recover after the upstream
  // pool drains.
  pi.on("after_provider_response", async (event: any, _ctx: any) => {
    const status = event?.status;
    if (status !== 200 && status !== 201) return;
    const model = event?.response?.model ?? event?.model;
    if (!model) return;
    const key = `MODEL_429_STREAK_${model.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    const stateNow = readState();
    if (stateNow[key]) {
      writeStateKey(key, "0");
      console.error(`model-rotation: ${model} succeeded; streak reset`);
    }
  });

  // Before each provider request, ALWAYS clamp max_tokens to a sane
  // value for the active model. (Independent of the backoff check.)
  // Without this, pi's default behavior is to ask for the model's full
  // context window as max_tokens, which OpenRouter's free tier rejects
  // with 402 ("not enough credits").
  //
  // Note: pi's `BeforeProviderRequestEvent` is `{ type, payload }`;
  // the actual request lives at `event.payload`.
  pi.on("before_provider_request", async (event: any, _ctx: any) => {
    const payload = event?.payload ?? event;
    const model = payload?.model ?? payload?.request?.model;
    if (!model) return;
    // Under strict-rotate we don't swap models — the user wants
    // pure key rotation, not model fallback. Skip the backoff check
    // entirely so a stale backoff entry from a previous run can't
    // change the model silently.
    if (strictRotate) {
      // Still clamp max_tokens (independent of model swap), see below.
    } else if (isModelInBackoff(model)) {
      const fallback = pickFallbackModel(model);
      if (fallback && payload?.request) {
        payload.request.model = fallback;
        console.error(
          `model-rotation: ${model} in backoff; switched request to ${fallback}`,
        );
      }
    }
    // Always clamp max_tokens (regardless of swap). Pi's request
    // object uses `maxTokens` (camelCase) per the model-config schema.
    const activeModel = payload?.request?.model ?? model;
    const cap = MODEL_MAX_TOKENS[activeModel] ?? DEFAULT_MAX_TOKENS;
    const req = payload?.request ?? payload;
    if (req) {
      const current = req.maxTokens ?? req.max_tokens ?? 0;
      if (current > cap) {
        console.error(
          `model-rotation: clamping max_tokens ${current} -> ${cap} for ${activeModel}`,
        );
        if (req.maxTokens !== undefined) req.maxTokens = cap;
        if (req.max_tokens !== undefined) req.max_tokens = cap;
        // Set whichever isn't set yet
        if (req.maxTokens === undefined) req.maxTokens = cap;
        if (req.max_tokens === undefined) req.max_tokens = cap;
      }
    }
  });

  // On each new agent start, ALWAYS clamp the session's max_tokens
  // (independent of backoff) so the rest of the turn uses the
  // model-appropriate cap.
  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    const model = event?.model;
    if (!model) return;
    if (!strictRotate && isModelInBackoff(model)) {
      const fallback = pickFallbackModel(model);
      if (fallback) {
        event.model = fallback;
        console.error(
          `model-rotation: ${model} in backoff; switched SESSION model to ${fallback}`,
        );
      }
    }
    const cap = MODEL_MAX_TOKENS[event.model] ?? DEFAULT_MAX_TOKENS;
    if (event.max_tokens === undefined || event.max_tokens > cap) {
      event.max_tokens = cap;
    }
    if (event.maxTokens === undefined || event.maxTokens > cap) {
      event.maxTokens = cap;
    }
  });

  // before_provider_headers: same as before_provider_request but
  // fires earlier in the chain (before HTTP body is built).
  pi.on("before_provider_headers", async (event: any, _ctx: any) => {
    const model = event?.model;
    if (!model) return;
    if (!strictRotate && isModelInBackoff(model)) {
      const fallback = pickFallbackModel(model);
      if (fallback) {
        event.model = fallback;
        console.error(
          `model-rotation: ${model} in backoff; switched headers model to ${fallback}`,
        );
      }
    }
    const cap = MODEL_MAX_TOKENS[event.model] ?? DEFAULT_MAX_TOKENS;
    if (event.max_tokens === undefined || event.max_tokens > cap) {
      event.max_tokens = cap;
    }
  });

  // /model-status command: show which models are in backoff
  pi.registerCommand("model-status", {
    description: "Show per-model backoff status (shared pool / 429 state)",
    handler: async (_args: string, ctx: any) => {
      const state = readState();
      const lines: string[] = ["Model backoff status:"];
      for (const m of FALLBACK_CHAIN) {
        const key = `MODEL_BACKOFF_UNTIL_${m.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const until = Number(state[key] || 0);
        const count = Number(
          state[`MODEL_BACKOFF_COUNT_${m.replace(/[^a-zA-Z0-9_]/g, "_")}`] || 0,
        );
        if (until > Date.now() / 1000) {
          const remaining = Math.round(until - Date.now() / 1000);
          lines.push(`  ❄ ${m}  backoff ${remaining}s (count=${count})`);
        } else {
          lines.push(`  ✓ ${m}  ok (count=${count})`);
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /model-reset command: clear all model backoffs
  pi.registerCommand("model-reset", {
    description: "Clear all per-model backoff state (incl. consecutive-429 streaks)",
    handler: async (_args: string, ctx: any) => {
      const state = readState();
      let cleared = 0;
      for (const k of Object.keys(state)) {
        if (
          k.startsWith("MODEL_BACKOFF_UNTIL_") ||
          k.startsWith("MODEL_BACKOFF_COUNT_") ||
          k.startsWith("MODEL_429_STREAK_")
        ) {
          if (k.includes("test")) continue; // skip test entries
          // remove from state
          let s = readFileSync(STATE_PATH, "utf8");
          s = s.replace(new RegExp(`^${k}=.*$\\n?`, "m"), "");
          writeFileSync(STATE_PATH, s);
          cleared++;
        }
      }
      ctx.ui.notify(`Cleared ${cleared} model backoff entries`, "info");
    },
  });
}
