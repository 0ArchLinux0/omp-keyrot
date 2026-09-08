// src/config.js -- load .env and export a typed config object.

import "dotenv/config";

const env = (k, fallback) =>
  process.env[k] !== undefined && process.env[k] !== ""
    ? process.env[k]
    : fallback;

export const config = {
  port: parseInt(env("PORT", "3000"), 10),

  local: {
    baseUrl: env("LOCAL_LLM_BASE_URL", "http://127.0.0.1:11434/v1"),
    apiKey: env("LOCAL_LLM_API_KEY", "ollama-local"),
    chatModel: env("LOCAL_CHAT_MODEL", "qwen2.5:7b"),
    embedModel: env("LOCAL_EMBED_MODEL", "nomic-embed-text:latest"),
    visionModel: env("LOCAL_VISION_MODEL", "qwen2.5vl:7b"),

    // Image gen (separate Python service)
    imageUrl: env("LOCAL_IMAGE_URL", "http://127.0.0.1:7860"),
    imageModelVramMiB: parseInt(env("LOCAL_IMAGE_MODEL_VRAM_MIB", "3500"), 10),
    imageDefaultModel: env("LOCAL_IMAGE_DEFAULT_MODEL", "sdxl-turbo"),
    imageDefaultSteps: parseInt(env("LOCAL_IMAGE_DEFAULT_STEPS", "4"), 10),
    imageDefaultWidth: parseInt(env("LOCAL_IMAGE_DEFAULT_WIDTH", "512"), 10),
    imageDefaultHeight: parseInt(env("LOCAL_IMAGE_DEFAULT_HEIGHT", "512"), 10),

    // STT (separate Python service)
    sttUrl: env("LOCAL_STT_URL", "http://127.0.0.1:7861"),
    sttDefaultModel: env("LOCAL_STT_DEFAULT_MODEL", "large-v3"),
  },

  mac: {
    baseUrl: env("MAC_LLM_BASE_URL", ""),
    apiKey: env("MAC_LLM_API_KEY", ""),
    chatModel: env("MAC_CHAT_MODEL", ""),
  },

  fallbackToLocal: env("FALLBACK_TO_LOCAL", "true") === "true",
  localModelPatterns: env(
    "LOCAL_MODEL_PATTERNS",
    "qwen2.5:1.5b,qwen2.5:3b,qwen2.5:7b,qwen2.5vl:7b,llama3.2:3b,llama3.2:7b,nomic-embed-text,mxbai-embed-large"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // VRAM budget the swap logic uses. Overridable for tests.
  vramTotalMiB: parseInt(env("VRAM_TOTAL_MIB", "12288"), 10),
  vramHeadroomMiB: parseInt(env("VRAM_HEADROOM_MIB", "1200"), 10),
};
