import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";

const IS_WIN = process.platform === "win32";
const XOT_BASH = "$HOME/bin/xot";
const XOT_PS1 = "~/bin/xot.ps1";
const KEYS_PY = "$HOME/Downloads/Work/code_repo/ox-alpha/scripts/keys.py";
const PROBED_KEY = "$HOME/Downloads/Work/code_repo/ox-alpha/scripts/pi_key_probe.py";

function runXot(args: string[]): string | null {
  try {
    if (IS_WIN) {
      return execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", XOT_PS1, ...args], { encoding: "utf8", timeout: 30_000 });
    }
    return execFileSync(XOT_BASH, args, { encoding: "utf8", timeout: 30_000 });
  } catch {
    return null;
  }
}

function pickKey(): string | null {
  try {
    const out = runXot(["key"]);
    if (!out) return null;
    const k = out.trim();
    if (!k || k.startsWith("export ANTHROPIC_API_KEY=")) return null;
    return k;
  } catch {
    return null;
  }
}

// Try OpenRouter /api/v1/key for limit_remaining
async function checkBalance(key: string): Promise<{ ok: boolean; balance: number | null }> {
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) {
      const j: any = await r.json();
      const data = j?.data ?? j;
      // Common fields
      const bal = Number(data?.limit_remaining ?? data?.limit_remaining ?? data?.balance ?? data?.limit ?? 0);
      return { ok: true, balance: Number.isFinite(bal) && bal > 0 ? bal : null };
    }
  } catch {}
  // fallback: python script that reads local usage/accounts.json
  try {
    const out = execFileSync("python3", [KEYS_PY, "list-usage"], { encoding: "utf8", timeout: 30_000 });
    return { ok: true, balance: null };
  } catch {
    return { ok: false, balance: null };
  }
}

export default function (pi: ExtensionAPI) {
  // Custom tool: balance-aware key pick (callable by LLM)
  pi.registerTool({
    name: "oxt_pick_balance",
    label: "Pick OpenRouter key with balance",
    description: "Select first key with remaining tokens via API, fallback to local usage",
    parameters: Type.Object({}),
    async execute() {
      const keysOut = runXot(["keys"]);
      if (!keysOut) return { content: [{ type: "text", text: "oxt pick-balance: no keyring" }] };
      const aliases = keysOut.trim().split("\n").map(s => s.replace(/^\s*\d+[\.:\-]?\s*/, "").trim()).filter(Boolean);
      for (const alias of aliases) {
        runXot(["key", alias]);
        const k = pickKey();
        if (!k) continue;
        const { ok, balance } = await checkBalance(k);
        if (ok && balance !== null && balance > 0) {
          return { content: [{ type: "text", text: `oxt pick-balance → ${alias}: ${k.slice(0, 6)}…${k.slice(-4)} balance=${balance}` }] };
        }
      }
      try {
        const out = execFileSync("python3", [KEYS_PY, "first-usable"], { encoding: "utf8", timeout: 30_000 });
        return { content: [{ type: "text", text: `oxt pick-balance (local): ${out.trim().slice(0, 6)}…` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `oxt pick-balance: ${e?.message ?? e}` }], isError: true };
      }
    },
  });

  // /reset: one-time context-0 request hint
  pi.registerCommand("reset", {
    description: "One-time request with context 0 (use --no-session --no-context-files -p '...')",
    handler: async (_, ctx) => {
      ctx.ui.notify("Run: pi --no-session --no-context-files --no-extensions --no-skills -p 'prompt'", "info");
    },
  });

  // /oxt with subcommands
  pi.registerCommand("oxt", {
    description: "Key rotation: /oxt [list|pick|pick-balance|init]",
    getArgumentCompletions: (prefix) => {
      const opts = ["list", "pick", "pick-balance", "accounts", "init"];
      const filtered = opts.filter((o) => o.startsWith(prefix));
      return filtered.length ? filtered.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "list";

      if (sub === "list") {
        const out = runXot(["keys"]);
        ctx.ui.notify(out ? out.trim().split("\n").slice(0, 10).join(" · ") : "xot keys: no output", "info");
        return;
      }

      if (sub === "pick") {
        // SOLID: first working key, no balance check
        const k = pickKey();
        ctx.ui.notify(k ? `oxt pick → ${k.slice(0, 6)}…${k.slice(-4)} exported` : "oxt pick: no key", "info");
        return;
      }

      if (sub === "pick-balance") {
        // BALANCE-AWARE: find first key with tokens remaining
        const keysOut = runXot(["keys"]);
        if (!keysOut) { ctx.ui.notify("oxt pick-balance: no keyring", "error"); return; }
        const aliases = keysOut.trim().split("\n").map(s => s.replace(/^\s*\d+[\.:\\-]?\s*/, "").trim()).filter(Boolean);
        for (const alias of aliases) {
          // THRESHOLD FILTER: skip blocked + very low usage / no balance
          try {
            const ledger = execFileSync("python3", ["-c", `
import json, sys
with open('$HOME/.config/openrouter/key_ledger.json') as f: l=json.load(f)
with open('$HOME/.config/openrouter/usage/snapshots.json') as f: s=json.load(f)['aliases']
alias = sys.argv[1]
status = l.get(alias,{}).get('status','')
usage = s.get(alias,{}).get('usage',999)
daily = s.get(alias,{}).get('usage_daily',999)
limit_rem = s.get(alias,{}).get('limit_remaining')
if status == 'blocked' or (limit_rem is not None and limit_rem < 1000) or (daily < 0.01 and usage > 0.15):
    sys.exit(1)
sys.exit(0)
`, alias], { encoding: "utf8" }).trim();
          } catch {
            // Skip this alias (blocked or very low token / high usage exhaustion)
            continue;
          }
          // use xot to pick this specific alias
          runXot(["key", alias]);
          const k = pickKey();
          if (!k) continue;
          const { ok, balance } = await checkBalance(k);
          if (ok && balance !== null && balance > 0) {
            ctx.ui.notify(`oxt pick-balance → ${alias}: ${k.slice(0, 6)}…${k.slice(-4)} balance=${balance}`, "info");
            return;
          }
        }
        // All keys had 0 or API failed — fallback to local usage python
        ctx.ui.notify("oxt pick-balance: all keys at 0/API fail, using local usage fallback", "warning");
        try {
          const out = execFileSync("python3", [KEYS_PY, "first-usable"], { encoding: "utf8", timeout: 30_000 });
          ctx.ui.notify(`oxt pick-balance (local): ${out.trim().slice(0, 6)}…`, "info");
        } catch (e: any) {
          ctx.ui.notify(`oxt pick-balance: ${e?.message ?? e}`, "error");
        }
        return;
      }

      if (sub === "accounts") {
        // Show all account info + usage + status (threshold-aware)
        try {
          const accts = execFileSync("python3", ["-c", `
import json
with open('$HOME/.config/openrouter/usage/accounts.json') as f: a=json.load(f)['aliases']
with open('$HOME/.config/openrouter/usage/snapshots.json') as f: s=json.load(f)['aliases']
with open('$HOME/.config/openrouter/key_ledger.json') as f: l=json.load(f)
for alias in sorted(a):
    meta=a[alias]; snap=s.get(alias,{}); led=l.get(alias,{})
    note=meta.get('note','-')
    tier=meta.get('tier','free')
    status=led.get('status','-')
    usage=snap.get('usage',0)
    daily=snap.get('usage_daily',0)
    label=snap.get('label','-')
    rem=snap.get('limit_remaining')
    is_free=snap.get('is_free_tier',True)
    print(f"{{alias:<14}} {{tier:<8}} {{note:<30}} usage={{$usage:.4f}} daily={{$daily:.4f}} status={{status}} limit_rem={{rem if rem else 'N/A'}} label={{label[:20]}}")
`], { encoding: "utf8", timeout: 10000 }).trim();
          ctx.ui.notify("=== ACCOUNT STATUS (threshold filter applied: skip blocked + usage>0.15 daily) ===\n" + accts, "info");
          ctx.ui.notify("BEST FREE-TIER CODING MODEL: Qwen 2.5 Coder (128k context) or DeepSeek R1 (128k). GLM-5.3 is ~8k only — too small for large agent tasks. Use /model to switch.", "info");
        } catch (e: any) {
          ctx.ui.notify("oxt accounts: " + (e?.message ?? e), "error");
        }
        return;
      }

      if (sub === "init") {
        const out = runXot(["init"]);
        ctx.ui.notify(out ? out.trim().split("\n").slice(0, 5).join(" · ") : "xot init: no output", "info");
        return;
      }

      ctx.ui.notify("Unknown oxt command: " + sub, "warn");
    },
  });
}