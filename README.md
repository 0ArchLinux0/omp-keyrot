# omp-keyrot

Portable overlay for **custom omp key rotation** (OpenRouter round-robin + 429 cooling) plus the Linux **llm-orchestrator** and **kakao-bot** that use it.

Does **not** vendor the `omp` binary (200MB). Install omp yourself, then overlay these scripts and pi extensions.

## Architecture

```
  omp / pi  --xot pick-->  ~/.local/daemon/xot/keys (STRICT_ROTATE)
        |
        |  429 daily limit -> cool fingerprint, pick next key
        v
  kakao-bot :7862  -->  llm-orchestrator :3000  -->  Ollama :11434
```

```
┌──────────────┐     ┌──────────────────┐    ┌────────────┐
│  Client      │────▶│  llm-orchestrator │───▶│  Ollama    │
│  (kakao-bot) │     │  (port 3000)     │    │  (11434)   │
└──────────────┘     └────────┬─────────┘    └────────────┘
                              │
                              ▼
                    ┌──────────────────────┐
                    │  xot (xot-rotate)    │
                    │  ~/.local/daemon/xot │
                    └──────────────────────┘
```

## Clone install

```bash
git clone git@github.com:0ArchLinux0/omp-keyrot.git
cd omp-keyrot
bash scripts/install.sh
# edit ~/.local/daemon/xot/keys   (one sk-or-v1-... per line)
xot status
```

Windows:

```powershell
git clone git@github.com:0ArchLinux0/omp-keyrot.git
cd omp-keyrot
powershell -File scripts/install.ps1
```

## What gets installed

| Path | Role |
|------|------|
| `~/.local/bin/xot` | Round-robin key picker. `(idx+1)%N`. Cool on daily 429. |
| `~/.pi/agent/extensions/{xot,auto-rotate,retry-guard,...}.ts` | omp/pi hooks |
| `llm-orchestrator/` | Local OpenAI-compatible router (`:3000`) |
| `kakao-bot/` | Kakao-style `/v1/chat` (`:7862`) |

**Not committed:** OpenRouter keys, `.env`, xot `state` / `leases`.

## Orchestrator + kakao-bot

```bash
cp llm-orchestrator/.env.example llm-orchestrator/.env
cd llm-orchestrator && npm install && npm start   # :3000

cd ../kakao-bot && pip install -r requirements.txt
python3 kakao_bot_server.py                       # :7862
```

Linux user services: `deploy/systemd/*.service`

```bash
systemctl --user enable --now omp-orchestrator omp-kakao-bot
```

## xot CLI

```bash
xot pick              # next key; prints: export OPENROUTER_API_KEY='...'
xot status            # ACTIVE_IDX + cooling fingerprints
xot cool <fp>         # mark a key cooling (8h default)
```

`STRICT_ROTATE` behaviour: every pick is `(active+1) % N`, skip keys with `COOL_<fp>` until expiry.

## Secrets

Put keys only in `~/.local/daemon/xot/keys` (mode 600). Never commit them.
