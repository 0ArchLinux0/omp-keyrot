// src/router.js -- decide whether a request should go to LOCAL or MAC.
//
// Routing rules (in order):
//   1. Explicit override via header `X-Target: local|mac` wins.
//   2. Embedding requests always go local. Embeddings of 768d vectors
//      are tiny and have no reason to round-trip to a Mac.
//   3. Vision/image requests go local (RTX 5070 is enough for 7B-VL
//      and small SD models). These are "expensive" because they may
//      need to evict the chat LLM to make room.
//   4. Model name matches a "local" pattern -> local.
//   5. Mac URL is configured -> mac.
//   6. fallbackToLocal=true -> local (current state).
//   7. else -> 503 "MAC_UNAVAILABLE".

import { config } from "./config.js";

function isLocalModel(name) {
  if (!name) return false;
  return config.localModelPatterns.some((p) => name === p || name.startsWith(p + ":"));
}

// "expensive" means: this model is large enough to potentially evict
// the always-on LLM. The server will run ensureRoom() before forwarding.
function isExpensiveModel(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return (
    n.includes("vl") ||
    n.includes("vision") ||
    n.includes("llava") ||
    n.includes("sdxl") ||
    n.includes("flux") ||
    n.includes("stable-diffusion") ||
    n.includes("whisper")
  );
}

export function pickTarget(req) {
  // 1. explicit header override
  const hdr = (req.headers["x-target"] || "").toString().toLowerCase();
  if (hdr === "local") return { target: "local", reason: "X-Target header", expensive: isExpensiveModel(req.body?.model) };
  if (hdr === "mac") return { target: "mac", reason: "X-Target header", expensive: false };

  const body = req.body || {};
  const path = req.path || "";

  // 2. embeddings -> always local
  if (path.startsWith("/v1/embeddings") || body.embed !== undefined) {
    return { target: "local", reason: "embedding request", expensive: false };
  }

  // 3. vision/image content in messages -> local (also: "expensive" — may evict LLM)
  const messages = body.messages || [];
  const hasImage = messages.some((m) => {
    if (Array.isArray(m.content)) {
      return m.content.some((p) => p && (p.type === "image_url" || p.type === "image"));
    }
    return false;
  });
  if (hasImage) {
    return {
      target: "local",
      reason: "image input detected (vision model)",
      expensive: true,
    };
  }

  // 4. small model name -> local
  const model = body.model || "";
  if (isLocalModel(model)) {
    return { target: "local", reason: `model "${model}" in local allowlist`, expensive: isExpensiveModel(model) };
  }

  // 5. mac configured
  if (config.mac.baseUrl) {
    return { target: "mac", reason: `model "${model}" routed to Mac`, expensive: false };
  }

  // 6. mac not configured: fall back or error
  if (config.fallbackToLocal) {
    return {
      target: "local",
      reason: `Mac not yet configured; fallback to local (model "${model}")`,
      expensive: isExpensiveModel(model),
    };
  }
  return null; // signal 503
}

export function isMacConfigured() {
  return Boolean(config.mac.baseUrl);
}
