# llm-orchestrator

OpenAI-compatible HTTP API on `:3000` that routes requests to **local Ollama (RTX 5070)** or a **remote Mac (MLX, future)**. Includes a Python **image generation** service (SDXL-Turbo) and a Python **STT** service (faster-whisper large-v3), all fronted by a **swap-aware VRAM manager** that evicts lower-priority models to make room for vision/image jobs on demand.

## Why this exists
- This box (Linux + RTX 5070 12GB) is good at: small LLMs (≤7B), embeddings, vision (7B-VL), small image gen.
- A future Mac will host the big brain (70B+ via MLX) over Tailscale.
- `llm-orchestrator` is the **single endpoint** that picks the right backend and **swaps models in/out of VRAM** in priority order. No client code changes when the Mac comes online — just fill in `MAC_LLM_BASE_URL` and restart.

## The services

| Service | Port | What | VRAM |
|---|---|---|---|
| **Ollama** (LLM/vision/embed) | 11434 | qwen2.5:7b, qwen2.5vl:7b, nomic-embed-text | 5.6 GB / 0.3 GB |
| **image-server** (Diffusers/SDXL-Turbo) | 7860 | image gen | ~6.8 GB peak |
| **stt-server** (faster-whisper) | 7861 | speech-to-text (CPU) | 0 |
| **llm-orchestrator** (this) | 3000 | unified OpenAI-compatible API | 0 |

## Endpoints (all OpenAI-compatible)

| Endpoint | Use |
|---|---|
| `GET  /health` | all-service status + VRAM snapshot |
| `GET  /vram` | live VRAM: total/used/free, loaded models |
| `GET  /v1/models` | list models (Ollama) |
| `POST /v1/chat/completions` | chat; auto-routes local/mac; auto-swap if vision |
| `POST /v1/embeddings` | embeddings (always local) |
| `POST /v1/images/generations` | image gen (always local; swap-aware) |
| `POST /v1/audio/transcriptions` | STT (always local; CPU) |
| `POST /admin/unload` | body `{models:["name1",...]}` — directed eviction |

## Response headers (debug)

| Header | Meaning |
|---|---|
| `X-Routed-To` | `local` or `mac` |
| `X-Route-Reason` | why the router chose this target |
| `X-Swap-Action` | `noop` / `evicted` / `evicted-partial` / `impossible` |
| `X-Swap-Evicted` | models the orchestrator kicked out |
| `X-Swap-Ms` | how long the swap took |
| `X-Image-Took-Ms`, `X-Image-Seed` | image-specific |
| `X-Swap-Reason` | if `impossible`, what went wrong |

## Routing rules (in order)
1. `X-Target: local\|mac` header wins.
2. `/v1/embeddings` → always **local**.
3. `/v1/images/generations` → always **local**.
4. `/v1/audio/transcriptions` → always **local** (CPU).
5. Image content in chat messages → **local** (vision, marked *expensive*).
6. Model name in `LOCAL_MODEL_PATTERNS` → **local**.
7. `MAC_LLM_BASE_URL` is set → **mac**.
8. `FALLBACK_TO_LOCAL=true` (default) → **local**.
9. else → `503 MAC_UNAVAILABLE`.

## Swap logic (vision / image requests)

When a request is marked **expensive** (vision, image gen):

1. The orchestrator asks Ollama (`/api/ps`) and the image service (`/vram`) for the current VRAM state.
2. It computes the "post-load" state assuming the target model is at peak VRAM.
3. If the projected state is below the headroom budget → **noop** (request proceeds).
4. Otherwise, the orchestrator evicts loaded models in **priority order**:
   - **Priority 1** (most evictable): embeddings
   - **Priority 2**: vision models
   - **Priority 3**: image models
   - **Priority 4** (sticky): chat LLMs — only evicted if nothing else can free enough room
5. For virtual models (image gen), if the model is *already* loaded in the image service, the orchestrator only needs to reserve room for the *additional* working memory (activations), not the full weight cost.
6. If the deficit can't be met → `507 INSUFFICIENT_VRAM`.

The orchestrator unloads external services via their own `/release` endpoint (the image service does `torch.cuda.empty_cache()`).

## Try it

```bash
# all-service health
curl -s http://127.0.0.1:3000/health | python3 -m json.tool

# VRAM
curl -s http://127.0.0.1:3000/vram | python3 -m json.tool

# chat
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5:7b","messages":[{"role":"user","content":"hi"}]}'

# embeddings
curl -s http://127.0.0.1:3000/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input":"hello world"}'

# image gen
curl -s http://127.0.0.1:3000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red apple on a white table","size":"512x512","seed":42}' \
  | python3 -c "import sys,json,base64; d=json.load(sys.stdin); open('out.png','wb').write(base64.b64decode(d['data'][0]['b64_json']))"

# STT
curl -s -X POST http://127.0.0.1:3000/v1/audio/transcriptions \
  -F "file=@/path/to/audio.wav" \
  -F "model=large-v3"

# vision
curl -s http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"qwen2.5vl:7b",
    "messages":[{
      "role":"user",
      "content":[
        {"type":"text","text":"Describe this image"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,iVBOR..."}}
      ]
    }]
  }'

# manual unload
curl -s -X POST http://127.0.0.1:3000/admin/unload \
  -H "Content-Type: application/json" \
  -d '{"models":["qwen2.5:7b","image:sdxl-turbo"]}'
```

## Tuning (`.env`)

| Var | Default | What |
|---|---|---|
| `VRAM_TOTAL_MIB` | `12288` | GPU VRAM budget for fit-checks. |
| `VRAM_HEADROOM_MIB` | `1200` | Reserved for KV cache + activations. |
| `LOCAL_IMAGE_MODEL_VRAM_MIB` | `6800` | SDXL-Turbo peak VRAM cost. |
| `LOCAL_IMAGE_DEFAULT_STEPS` | `4` | SDXL-Turbo works in 1-4 steps. |
| `LOCAL_STT_DEFAULT_MODEL` | `large-v3` | faster-whisper model name. |
| `FALLBACK_TO_LOCAL` | `true` | When Mac absent, route "big" requests here. |
| `LOCAL_MODEL_PATTERNS` | (see file) | Comma-separated model names that count as "local". |

## When the Mac arrives

1. Set up MLX-Ollama (or LM Studio) on the Mac and bind to Tailscale.
2. Edit `.env`:
   ```
   MAC_LLM_BASE_URL=http://<tailscale-ip>:11434/v1
   MAC_LLM_API_KEY=ollama-mac
   MAC_CHAT_MODEL=qwen2.5:72b
   ```
3. `sudo systemctl restart llm-orchestrator`. Done.

## File map

```
~/code_repo/
├── llm-orchestrator/            # the JS orchestrator (this)
│   ├── src/
│   │   ├── config.js            # .env loader
│   │   ├── router.js            # pickTarget(req)
│   │   ├── vram.js              # getVramState, ensureRoom, virtual models, eviction
│   │   └── server.js            # Express, OpenAI-compatible routes
│   ├── .env                     # tunables
│   └── package.json
└── ai-services/                 # the Python backends
    ├── venv/                    # shared venv (torch, diffusers, fastapi, faster-whisper)
    ├── image_server.py          # SDXL-Turbo via Diffusers, :7860
    └── stt_server.py            # faster-whisper large-v3, :7861

/etc/systemd/system/
├── ollama.service               # (installed by ollama installer)
├── ssh.service                  # (installed by Ubuntu)
├── docker.service               # (installed)
├── llm-orchestrator.service     # enabled; After=ollama.service
├── image-server.service         # enabled
└── stt-server.service           # enabled
```
