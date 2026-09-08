// src/vram.js -- live VRAM state + directed model swap.
//
// Ollama's auto-eviction is "least recently used" which is the wrong
// policy for us: a long chat session has a hot LLM, and an image
// request shouldn't silently kick it out. So we manage eviction
// ourselves via keep_alive=0, in priority order:
//
//   priority 1 (most evictable)  : embeddings, utility models
//   priority 2                  : vision models
//   priority 3                  : image generation
//   priority 4 (sticky)         : chat LLMs (only evict on explicit
//                                 request or when a *bigger* model
//                                 needs the room)

import { config } from "./config.js";

const NATIVE = () => config.local.baseUrl.replace(/\/v1$/, "");

// 12 GB total on RTX 5070. Reserve room for KV cache + CUDA context.
// 800 MB is a conservative headroom; for qwen2.5:7b at 4k context
// the KV cache is ~250 MB so 800 MB leaves slack for two parallel
// requests on OLLAMA_NUM_PARALLEL=2. Both are overridable in .env.
const TOTAL_VRAM_BYTES = config.vramTotalMiB * 1024 * 1024;
const HEADROOM_BYTES = config.vramHeadroomMiB * 1024 * 1024;

// ---- state cache ----------------------------------------------------

let cached = null; // { at, totalBytes, usedBytes, freeBytes, models: [...] }
const CACHE_MS = 500;

function emptyState() {
  return {
    at: 0,
    totalBytes: TOTAL_VRAM_BYTES,
    usedBytes: 0,
    freeBytes: TOTAL_VRAM_BYTES,
    models: [],
  };
}

export async function getVramState({ bypassCache = false } = {}) {
  const now = Date.now();
  if (!bypassCache && cached && now - cached.at < CACHE_MS) return cached;

  // 1. Ask Ollama for its loaded models.
  let ollamaModels = [];
  let ollamaError = null;
  try {
    const r = await fetch(`${NATIVE()}/api/ps`);
    if (!r.ok) throw new Error(`/api/ps HTTP ${r.status}`);
    const data = await r.json();
    ollamaModels = (data.models || []).map((m) => ({
      name: m.name,
      sizeVram: m.size_vram || 0,
      sizeTotal: m.size || 0,
      expiresAt: m.expires_at,
      family: (m.details && m.details.families && m.details.families[0]) || "",
      parameterSize: (m.details && m.details.parameter_size) || "",
      contextLength: (m.details && m.details.context_length) || 0,
    }));
  } catch (e) {
    ollamaError = e.message;
  }

  // 2. Ask the image service for its VRAM (separate process, separate
  //    weights — must be added to the used total so swap planning is
  //    correct). Only register the image model as "loaded" if the
  //    service reports non-zero VRAM, otherwise a freshly-started
  //    service (model not yet loaded) would falsely reserve 6.8 GB.
  let imageBytes = 0;
  let imageModel = null;
  try {
    const r = await fetch(`${config.local.imageUrl}/vram`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      const data = await r.json();
      // Distinguish "key missing" (use config estimate) from
      // "explicit 0" (model truly not loaded).
      if (typeof data.vram_mib === "number") {
        imageBytes = data.vram_mib * 1024 * 1024;
      } else if (data.vram_total_mib) {
        // service up but didn't report a number -> use estimate
        imageBytes = config.local.imageModelVramMiB * 1024 * 1024;
      }
      if (imageBytes > 0) {
        imageModel = "image:sdxl-turbo";
      }
    }
  } catch {
    // image service down or timing out; assume it has no VRAM
  }

  const externalModels = imageBytes > 0
    ? [{
        name: imageModel,
        sizeVram: imageBytes,
        sizeTotal: imageBytes,
        expiresAt: "2099-01-01T00:00:00Z",
        family: "image-gen",
        parameterSize: "external",
        contextLength: 0,
      }]
    : [];

  const allModels = [...ollamaModels, ...externalModels];
  const usedBytes = allModels.reduce((s, m) => s + m.sizeVram, 0);
  const totalBytes = TOTAL_VRAM_BYTES;
  const freeBytes = totalBytes - usedBytes;
  cached = { at: now, totalBytes, usedBytes, freeBytes, models: allModels, ollamaError };
  return cached;
}

export function invalidateVramCache() {
  cached = null;
}

// ---- size lookup ----------------------------------------------------
// We don't have a model loaded until we run it, so we estimate from
// the on-disk size (size_total from ollama show). For models not yet
// pulled we return null and the caller decides whether to fall back.

const sizeCache = new Map(); // name -> bytes (estimated VRAM cost)
const SIZE_CACHE_MS = 60_000;
const sizeCacheAt = new Map();

export async function estimateModelVramBytes(modelName) {
  const now = Date.now();
  if (
    sizeCache.has(modelName) &&
    now - (sizeCacheAt.get(modelName) || 0) < SIZE_CACHE_MS
  ) {
    return sizeCache.get(modelName);
  }
  // Primary: ask Ollama for the model size.
  try {
    const r = await fetch(`${NATIVE()}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    if (r.ok) {
      const data = await r.json();
      if (data.size) {
        sizeCache.set(modelName, data.size);
        sizeCacheAt.set(modelName, now);
        return data.size;
      }
    }
  } catch {
    // fall through
  }
  // Fallback: if the model is currently loaded, use its measured VRAM.
  const state = await getVramState({ bypassCache: true });
  const loaded = state.models.find((m) => m.name === modelName);
  if (loaded) {
    sizeCache.set(modelName, loaded.sizeVram);
    sizeCacheAt.set(modelName, now);
    return loaded.sizeVram;
  }
  // Unknown and not loaded: conservative heuristic.
  // - Embedding models: ~0.5 GB
  // - 7B chat: ~5 GB
  // - 7B vision: ~5.5 GB
  // - 13B: ~8 GB
  // - 70B: ~40 GB (won't fit anyway)
  const n = modelName.toLowerCase();
  if (n.includes("embed")) return 500 * 1024 * 1024;
  if (n.includes("vl") || n.includes("vision") || n.includes("llava")) {
    return 5.5 * 1024 * 1024 * 1024;
  }
  if (n.includes("70b") || n.includes("72b")) return 40 * 1024 * 1024 * 1024;
  if (n.includes("13b")) return 8 * 1024 * 1024 * 1024;
  return 5 * 1024 * 1024 * 1024; // default 7B
}

// ---- fit check ------------------------------------------------------

export async function wouldFit(modelName) {
  const [state, needed] = await Promise.all([
    getVramState(),
    estimateModelVramBytes(modelName),
  ]);
  if (needed == null) {
    // Unknown model; assume it fits (caller will discover at load time).
    return { fits: true, needed: null, freeAfter: null, deficit: 0, state };
  }
  const freeAfter = state.freeBytes - needed;
  const fits = freeAfter >= HEADROOM_BYTES;
  return {
    fits,
    needed,
    freeAfter,
    deficit: fits ? 0 : Math.abs(freeAfter) + HEADROOM_BYTES,
    state,
  };
}

// Same as wouldFit but takes an explicit byte cost (used for virtual
// models like image gen where the cost is fixed in config).
export function wouldFitBytes(state, bytes) {
  const freeAfter = state.freeBytes - bytes;
  const fits = freeAfter >= HEADROOM_BYTES;
  return {
    fits,
    needed: bytes,
    freeAfter,
    deficit: fits ? 0 : Math.abs(freeAfter) + HEADROOM_BYTES,
    state,
  };
}

// ---- priority / eviction -------------------------------------------

const PRIORITY = {
  embed: 1, // small, fast to reload, never blocks human-facing tasks
  vision: 2, // infrequent, large, can be reloaded on demand
  image: 3, // infrequent, large
  llm: 4, // sticky: only evict when explicitly required
};

// Virtual models (managed by external services, not Ollama).
// The orchestrator treats them as if they were loaded so the swap
// planner knows to evict Ollama models to make room.
const VIRTUAL = {
  "image:sdxl-turbo": {
    name: "image:sdxl-turbo",
    sizeVram: config.local.imageModelVramMiB * 1024 * 1024,
    family: "image-gen",
    parameterSize: "external",
    priority: PRIORITY.image,
  },
  "stt:whisper": {
    name: "stt:whisper",
    sizeVram: 0, // CPU-only; doesn't take VRAM
    family: "audio",
    parameterSize: "external",
    priority: PRIORITY.embed, // never evict anyone for this; it's free
  },
};

export function priorityForModel(model) {
  const n = (model.name || "").toLowerCase();
  const fam = (model.family || "").toLowerCase();
  if (n.includes("embed") || fam.includes("nomic-bert") || fam.includes("bert")) {
    return PRIORITY.embed;
  }
  if (
    n.includes("vl") ||
    n.includes("vision") ||
    n.includes("llava") ||
    fam.includes("clip")
  ) {
    return PRIORITY.vision;
  }
  if (n.includes("sdxl") || n.includes("sd-") || n.includes("flux") || n.includes("stable-diffusion") || n.startsWith("image:")) {
    return PRIORITY.image;
  }
  if (n.includes("whisper") || n.startsWith("stt:")) {
    return PRIORITY.embed; // STT doesn't need VRAM, treat as free
  }
  return PRIORITY.llm;
}

export function pickEvictionPlan(state, deficit, exceptName = null) {
  // Pick the lowest-priority, currently-loaded models whose total
  // VRAM is >= deficit. Skip `exceptName` (the model we're about to load).
  const candidates = state.models
    .filter((m) => m.name !== exceptName)
    .map((m) => ({ ...m, priority: priorityForModel(m) }))
    .sort((a, b) => a.priority - b.priority || a.sizeVram - b.sizeVram);

  const plan = [];
  let sum = 0;
  for (const c of candidates) {
    if (sum >= deficit) break;
    plan.push(c);
    sum += c.sizeVram;
  }
  return { plan, freedBytes: sum, meetsDeficit: sum >= deficit };
}

// ---- unload --------------------------------------------------------

async function unloadOne(name) {
  // External services: the image server manages its own weights.
  if (name.startsWith("image:")) {
    return unloadImageService();
  }
  if (name.startsWith("stt:")) {
    return unloadSttService();
  }
  // Ollama: /api/generate with keep_alive:0 unloads the model.
  const r = await fetch(`${NATIVE()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: name, keep_alive: 0 }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`unload ${name} failed: HTTP ${r.status} ${text}`);
  }
  return r.json();
}

// Image service: ask it to drop its model. We add a /release endpoint
// the service implements; for now we just hit it and the service is
// free to interpret. A real impl: free torch GPU memory.
async function unloadImageService() {
  try {
    await fetch(`${config.local.imageUrl}/release`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    // best-effort; the next request will see whatever VRAM the service
    // actually still has and act accordingly
  }
  return { released: "image" };
}

async function unloadSttService() {
  // STT is CPU-only; nothing to unload.
  return { released: "stt" };
}

export async function unloadModels(names) {
  invalidateVramCache();
  // Run unloads in parallel; image unload may take longer (torch.empty_cache).
  const results = await Promise.allSettled(names.map(unloadOne));
  // Wait for VRAM to actually free; poll /api/ps AND image /vram.
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    const state = await getVramState({ bypassCache: true });
    const stillLoaded = names.filter((n) =>
      state.models.some((m) => m.name === n)
    );
    if (stillLoaded.length === 0) {
      invalidateVramCache();
      return { ok: true, ms: Date.now() - t0, unloaded: names };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  invalidateVramCache();
  // Final state may still show some VRAM not yet freed. That's OK;
  // the caller will see it on the next request and re-plan.
  return { ok: false, ms: Date.now() - t0, unloaded: names, results: results.map(r => r.status === "fulfilled" ? "ok" : r.reason?.message) };
}

// ---- make-room-and-load --------------------------------------------
// High-level: given a model name, ensure there's room for it. If not,
// pick an eviction plan, unload, then return. Returns a record the
// caller can put in a response header so the user sees what happened.

export async function ensureRoom(modelName) {
  const check = await wouldFit(modelName);
  if (check.fits) {
    return { action: "noop", needed: check.needed, deficit: 0, freedBytes: 0, evicted: [] };
  }
  const plan = pickEvictionPlan(check.state, check.deficit, modelName);
  if (!plan.meetsDeficit) {
    return {
      action: "impossible",
      needed: check.needed,
      deficit: check.deficit,
      freedBytes: 0,
      evicted: [],
      reason: `cannot make room: would free ${plan.freedBytes} of ${check.deficit} needed`,
    };
  }
  const names = plan.plan.map((m) => m.name);
  const r = await unloadModels(names);
  return {
    action: r.ok ? "evicted" : "evicted-partial",
    needed: check.needed,
    deficit: check.deficit,
    freedBytes: plan.freedBytes,
    evicted: names,
    ms: r.ms,
  };
}

// For virtual models where the cost is known up front (image gen).
// `virtualName` is the key into VIRTUAL (e.g. "image:sdxl-turbo").
export async function ensureRoomForVirtual(virtualName) {
  const v = VIRTUAL[virtualName];
  if (!v) throw new Error(`unknown virtual model: ${virtualName}`);
  if (v.sizeVram === 0) {
    return { action: "noop", needed: 0, deficit: 0, freedBytes: 0, evicted: [] };
  }

  // We may already have this virtual model loaded (e.g. image service
  // still has SDXL-Turbo in VRAM from a previous call). If so, we
  // only need room for the *additional* working memory beyond what
  // is already reserved, not the full model cost. The orchestrator
  // measures the image service's current VRAM via getVramState.
  const state = await getVramState();
  const alreadyLoaded = state.models.find((m) => m.name === v.name);
  const currentlyHeld = alreadyLoaded ? alreadyLoaded.sizeVram : 0;
  const additionalNeeded = Math.max(0, v.sizeVram - currentlyHeld);

  // Build a "post-load" view: assume the image model is at peak
  // VRAM, and see how much of OTHER models we'd need to evict.
  // `otherUsedBytes` = everything except what image service already
  // holds of itself; plus the image peak cost.
  const otherUsedBytes = state.usedBytes - currentlyHeld;
  const postLoadUsed = otherUsedBytes + v.sizeVram;
  const postLoadFree = state.totalBytes - postLoadUsed;
  const fits = postLoadFree >= HEADROOM_BYTES;
  const deficit = fits ? 0 : (postLoadFree < 0 ? -postLoadFree : HEADROOM_BYTES - postLoadFree) + 0;

  if (fits) {
    return { action: "noop", needed: v.sizeVram, deficit: 0, freedBytes: 0, evicted: [] };
  }

  // Plan eviction from the OTHER loaded models (not the image one).
  const plan = pickEvictionPlan(state, deficit, v.name);
  if (!plan.meetsDeficit) {
    return {
      action: "impossible",
      needed: v.sizeVram,
      deficit,
      freedBytes: 0,
      evicted: [],
      reason: `cannot make room: would free ${plan.freedBytes} of ${deficit} bytes needed (image peak ${v.sizeVram}, currently held ${currentlyHeld}, other models ${otherUsedBytes})`,
    };
  }
  const names = plan.plan.map((m) => m.name);
  const r = await unloadModels(names);
  return {
    action: r.ok ? "evicted" : "evicted-partial",
    needed: v.sizeVram,
    deficit,
    freedBytes: plan.freedBytes,
    evicted: names,
    ms: r.ms,
  };
}

// ---- virtual model lookups (image gen, STT) -----------------------

export function virtualModel(name) {
  return VIRTUAL[name] || null;
}

export function isVirtual(name) {
  return Object.prototype.hasOwnProperty.call(VIRTUAL, name);
}

// When we're about to serve an image request, pretend the image model
// is loaded so the eviction planner reserves room for it.
export function getVramStateWithVirtual({ extra = [] } = {}) {
  return getVramState().then((state) => {
    if (extra.length === 0) return state;
    const vModels = extra.map((n) => VIRTUAL[n]).filter(Boolean).map((v) => ({
      name: v.name,
      sizeVram: v.sizeVram,
      sizeTotal: v.sizeVram,
      family: v.family,
      parameterSize: v.parameterSize,
      expiresAt: "2099-01-01T00:00:00Z", // never expires (it's not a real model)
      priority: v.priority,
    }));
    const usedBytes = state.usedBytes + vModels.reduce((s, m) => s + m.sizeVram, 0);
    return { ...state, usedBytes, freeBytes: state.totalBytes - usedBytes, models: [...state.models, ...vModels] };
  });
}

// ---- mutex (one swap at a time, per model name) -------------------

const locks = new Map(); // name -> Promise
export async function withModelLock(name, fn) {
  const prev = locks.get(name) || Promise.resolve();
  let release;
  const next = new Promise((r) => (release = r));
  locks.set(name, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Clean up so the map doesn't grow forever.
    if (locks.get(name) === next) locks.delete(name);
  }
}
