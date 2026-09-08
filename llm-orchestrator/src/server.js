// src/server.js -- OpenAI-compatible HTTP API on :3000 + ops endpoints.
//   /v1/chat/completions, /v1/embeddings, /v1/images/generations,
//   /v1/audio/transcriptions, /v1/models
//   /health, /vram, /admin/unload
//   /dashboard, /api/dashboard, /api/requests
//
// All requests are logged in-memory (ring buffer) for the dashboard.

import express from "express";
import { config } from "./config.js";
import { pickTarget, isMacConfigured } from "./router.js";
import {
  getVramState,
  ensureRoom,
  ensureRoomForVirtual,
  withModelLock,
  unloadModels,
} from "./vram.js";
import { logRequest, listRequests, clearRequests } from "./requests.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_HTML = readFileSync(join(__dirname, "dashboard.html"), "utf8");

const app = express();
app.use(express.json({ limit: "20mb" }));

function rawBodyIfNotJson(req, _res, next) {
  const ct = req.headers["content-type"] || "";
  if (ct.startsWith("application/json")) return next();
  next();
}
app.use(rawBodyIfNotJson);

// ---- helpers --------------------------------------------------------

function backendFor(target) {
  if (target === "mac") {
    return { baseUrl: config.mac.baseUrl, apiKey: config.mac.apiKey };
  }
  return { baseUrl: config.local.baseUrl, apiKey: config.local.apiKey };
}

async function forward(backend, path, body, extraHeaders = {}) {
  const res = await fetch(`${backend.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${backend.apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    contentType: res.headers.get("content-type") || "",
  };
}

function setSwapHeaders(res, swap) {
  res.set("X-Swap-Action", swap.action);
  if (swap.evicted?.length) res.set("X-Swap-Evicted", swap.evicted.join(","));
  if (swap.ms != null) res.set("X-Swap-Ms", String(swap.ms));
  if (swap.action === "impossible") res.set("X-Swap-Reason", swap.reason || "insufficient VRAM");
}

async function probeImageService() {
  try {
    const r = await fetch(`${config.local.imageUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, ...(await r.json()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function probeSttService() {
  try {
    const r = await fetch(`${config.local.sttUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, ...(await r.json()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Wrap a route handler so we time it, log it, and capture its outcome.
function wrap({ kind, modelFn }) {
  return async (req, res, next) => {
    const t0 = Date.now();
    const model = modelFn ? modelFn(req) : null;
    let capturedStatus = 200;
    let capturedError = null;
    let capturedBytes = null;
    let capturedSwap = null;
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    res.json = (body) => {
      if (body && body.error) capturedError = String(body.error);
      return origJson(body);
    };
    res.send = (body) => {
      capturedBytes = body ? Buffer.byteLength(body) : 0;
      return origSend(body);
    };
    res.on("finish", () => {
      capturedStatus = res.statusCode;
      capturedSwap = res.get("X-Swap-Action") || null;
      logRequest({
        method: req.method,
        path: req.path,
        status: capturedStatus,
        tookMs: Date.now() - t0,
        model,
        swap: capturedSwap,
        bytes: capturedBytes,
        error: capturedError,
      });
    });
    try {
      await next();
    } catch (e) {
      logRequest({
        method: req.method,
        path: req.path,
        status: 500,
        tookMs: Date.now() - t0,
        model,
        error: e.message,
      });
      throw e;
    }
  };
}

// ---- routes ---------------------------------------------------------

app.get("/health", async (_req, res) => {
  const [vram, image, stt] = await Promise.all([
    getVramState({ bypassCache: true }),
    probeImageService(),
    probeSttService(),
  ]);
  res.json({
    ok: true,
    local: config.local.baseUrl,
    mac: config.mac.baseUrl || null,
    macConfigured: isMacConfigured(),
    fallbackToLocal: config.fallbackToLocal,
    services: {
      llm: { ok: true, baseUrl: config.local.baseUrl },
      image: { ok: image.ok, ...(image.ok ? {} : { error: image.error }) },
      stt: { ok: stt.ok, ...(stt.ok ? {} : { error: stt.error }) },
    },
    vram: {
      totalGiB: +(vram.totalBytes / 1024 / 1024 / 1024).toFixed(2),
      usedGiB: +(vram.usedBytes / 1024 / 1024 / 1024).toFixed(2),
      freeGiB: +(vram.freeBytes / 1024 / 1024 / 1024).toFixed(2),
      models: vram.models.map((m) => m.name),
    },
  });
});

app.get("/vram", async (_req, res) => {
  const state = await getVramState({ bypassCache: true });
  res.json({
    totalBytes: state.totalBytes,
    usedBytes: state.usedBytes,
    freeBytes: state.freeBytes,
    usedGiB: +(state.usedBytes / 1024 / 1024 / 1024).toFixed(2),
    freeGiB: +(state.freeBytes / 1024 / 1024 / 1024).toFixed(2),
    totalGiB: +(state.totalBytes / 1024 / 1024 / 1024).toFixed(2),
    models: state.models.map((m) => ({
      name: m.name,
      vramMiB: +(m.sizeVram / 1024 / 1024).toFixed(0),
      family: m.family,
      parameterSize: m.parameterSize,
      expiresAt: m.expiresAt,
    })),
  });
});

app.post("/admin/unload", async (req, res) => {
  const names = req.body?.models;
  if (!Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: "pass { models: [name, ...] }" });
  }
  const r = await unloadModels(names);
  res.json(r);
});

app.get("/v1/models", async (_req, res) => {
  const nativeBase = config.local.baseUrl.replace(/\/v1$/, "");
  try {
    const r = await fetch(`${nativeBase}/api/tags`, {
      headers: { Authorization: `Bearer ${config.local.apiKey}` },
    });
    const data = await r.json();
    res.json({
      object: "list",
      data: (data.models || []).map((m) => ({
        id: m.name,
        object: "model",
        owned_by: "ollama",
      })),
    });
  } catch (e) {
    res.status(502).json({ error: `failed to list models: ${e.message}` });
  }
});

app.post(
  "/v1/chat/completions",
  wrap({ kind: "chat", modelFn: (req) => req.body?.model }),
  async (req, res) => {
    const decision = pickTarget(req);
    if (!decision) {
      return res.status(503).json({ error: "MAC_UNAVAILABLE: big-LLM backend not configured" });
    }
    const backend = backendFor(decision.target);
    if (decision.target === "local" && (!req.body.model || req.body.model === "auto")) {
      req.body.model = config.local.chatModel;
    }
    if (decision.target === "mac" && (!req.body.model || req.body.model === "auto")) {
      req.body.model = config.mac.chatModel || req.body.model;
    }
    res.set("X-Routed-To", decision.target);
    res.set("X-Route-Reason", decision.reason);
    if (decision.target === "local" && decision.expensive) {
      const lockKey = `swap:${req.body.model}`;
      try {
        const swap = await withModelLock(lockKey, async () => ensureRoom(req.body.model));
        setSwapHeaders(res, swap);
        if (swap.action === "impossible") {
          return res.status(507).json({ error: swap.reason, needed: swap.needed, deficit: swap.deficit });
        }
      } catch (e) {
        return res.status(500).json({ error: `swap failed: ${e.message}` });
      }
    }
    try {
      const out = await forward(backend, "/chat/completions", req.body);
      res.status(out.status).type(out.contentType).send(out.text);
    } catch (e) {
      res.status(502).json({ error: `backend error: ${e.message}` });
    }
  }
);

app.post(
  "/v1/embeddings",
  wrap({ kind: "embedding", modelFn: (req) => req.body?.model }),
  async (req, res) => {
    if (!req.body.model) req.body.model = config.local.embedModel;
    const backend = backendFor("local");
    res.set("X-Routed-To", "local");
    res.set("X-Route-Reason", "embedding always local");
    try {
      const out = await forward(backend, "/embeddings", req.body);
      res.status(out.status).type(out.contentType).send(out.text);
    } catch (e) {
      res.status(502).json({ error: `backend error: ${e.message}` });
    }
  }
);

app.post(
  "/v1/images/generations",
  wrap({ kind: "image", modelFn: (req) => req.body?.model || "sdxl-turbo" }),
  async (req, res) => {
    res.set("X-Routed-To", "local");
    res.set("X-Route-Reason", "image generation always local");
    const body = req.body || {};
    if (!body.prompt || !body.prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }
    let width = config.local.imageDefaultWidth;
    let height = config.local.imageDefaultHeight;
    if (typeof body.size === "string") {
      const m = body.size.match(/^(\d+)x(\d+)$/);
      if (m) {
        width = parseInt(m[1], 10);
        height = parseInt(m[2], 10);
      }
    }
    const probe = await probeImageService();
    if (!probe.ok) {
      return res.status(503).json({ error: `image service unavailable: ${probe.error || "HTTP " + probe.status}` });
    }
    const lockKey = `swap:image:sdxl-turbo`;
    try {
      const swap = await withModelLock(lockKey, async () => ensureRoomForVirtual("image:sdxl-turbo"));
      setSwapHeaders(res, swap);
      if (swap.action === "impossible") {
        return res.status(507).json({ error: swap.reason, needed: swap.needed, deficit: swap.deficit });
      }
    } catch (e) {
      return res.status(500).json({ error: `swap failed: ${e.message}` });
    }
    const steps = body.steps || config.local.imageDefaultSteps;
    const upstreamBody = {
      prompt: body.prompt,
      negative_prompt: body.negative_prompt || "",
      width,
      height,
      steps,
      seed: body.seed ?? null,
    };
    const t0 = Date.now();
    try {
      const r = await fetch(`${config.local.imageUrl}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(upstreamBody),
      });
      const text = await r.text();
      if (!r.ok) {
        res.status(r.status).type("application/json").send(text);
        return;
      }
      const data = JSON.parse(text);
      const out = {
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: data.image_b64 }],
        model: body.model || config.local.imageDefaultModel,
      };
      res.set("X-Image-Took-Ms", String(data.took_ms || (Date.now() - t0)));
      res.set("X-Image-Width", String(data.width));
      res.set("X-Image-Height", String(data.height));
      res.set("X-Image-Seed", String(data.seed));
      res.json(out);
    } catch (e) {
      res.status(502).json({ error: `image backend error: ${e.message}` });
    }
  }
);

app.post(
  "/v1/audio/transcriptions",
  wrap({ kind: "stt", modelFn: (req) => req.body?.model || config.local.sttDefaultModel }),
  async (req, res) => {
    res.set("X-Routed-To", "local");
    res.set("X-Route-Reason", "STT always local (CPU)");
    if (!req.headers["content-type"]?.startsWith("multipart/form-data")) {
      return res.status(400).json({ error: "expected multipart/form-data with `file` field" });
    }
    const probe = await probeSttService();
    if (!probe.ok) {
      return res.status(503).json({ error: `STT service unavailable: ${probe.error || "HTTP " + probe.status}` });
    }
    try {
      const r = await fetch(`${config.local.sttUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { "Content-Type": req.headers["content-type"] },
        body: req,
        duplex: "half",
      });
      const text = await r.text();
      res.status(r.status).type(r.headers.get("content-type") || "application/json").send(text);
    } catch (e) {
      res.status(502).json({ error: `STT backend error: ${e.message}` });
    }
  }
);

// ---- dashboard ------------------------------------------------------

app.get("/dashboard", (_req, res) => {
  res.type("text/html").send(DASHBOARD_HTML);
});

app.get("/api/dashboard", async (_req, res) => {
  const [vram, image, stt, ollamaTags, requests] = await Promise.all([
    getVramState({ bypassCache: true }),
    probeImageService(),
    probeSttService(),
    (async () => {
      try {
        const nativeBase = config.local.baseUrl.replace(/\/v1$/, "");
        const r = await fetch(`${nativeBase}/api/tags`);
        const d = await r.json();
        return (d.models || []).map((m) => ({
          name: m.name,
          size: m.size,
          parameterSize: m.details?.parameter_size,
          family: m.details?.families?.[0],
        }));
      } catch {
        return [];
      }
    })(),
    Promise.resolve(listRequests({ limit: 30 })),
  ]);

  // nvidia-smi via shell would be nice but slow; just show what we know
  res.json({
    now: new Date().toISOString(),
    hostname: process.env.HOSTNAME || "ai-node",
    services: {
      llm: { ok: true, baseUrl: config.local.baseUrl },
      image: { ok: image.ok, ...(image.ok ? { model: image.model, vram_mib: image.vram_mib } : { error: image.error }) },
      stt: { ok: stt.ok, ...(stt.ok ? { current_model: stt.current_model, default_model: stt.default_model } : { error: stt.error }) },
    },
    vram: {
      totalGiB: +(vram.totalBytes / 1024 / 1024 / 1024).toFixed(2),
      usedGiB: +(vram.usedBytes / 1024 / 1024 / 1024).toFixed(2),
      freeGiB: +(vram.freeBytes / 1024 / 1024 / 1024).toFixed(2),
      headroomMiB: config.vramHeadroomMiB,
      models: vram.models.map((m) => ({
        name: m.name,
        vramMiB: +(m.sizeVram / 1024 / 1024).toFixed(0),
        family: m.family,
        parameterSize: m.parameterSize,
      })),
    },
    ollamaModels: ollamaTags,
    config: {
      macConfigured: isMacConfigured(),
      macBaseUrl: config.mac.baseUrl || null,
      fallbackToLocal: config.fallbackToLocal,
      imageDefault: config.local.imageDefaultModel,
      sttDefault: config.local.sttDefaultModel,
    },
    requests,
  });
});

app.post("/api/requests/clear", (_req, res) => {
  clearRequests();
  res.json({ ok: true });
});

// ---- start ----------------------------------------------------------

app.listen(config.port, () => {
  console.log(
    `[llm-orchestrator] listening on :${config.port}\n` +
      `  local llm:     ${config.local.baseUrl}  (chat=${config.local.chatModel})\n` +
      `  local image:   ${config.local.imageUrl}  (sdxl-turbo ~${config.local.imageModelVramMiB} MiB)\n` +
      `  local stt:     ${config.local.sttUrl}  (whisper ${config.local.sttDefaultModel})\n` +
      `  mac:           ${config.mac.baseUrl || "<not configured>"}\n` +
      `  dashboard:     http://${process.env.HOSTNAME || "localhost"}:${config.port}/dashboard\n` +
      `  VRAM budget:   ${config.vramTotalMiB} MiB total, ${config.vramHeadroomMiB} MiB headroom`
  );
});
