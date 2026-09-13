/**
 * advisor-manager — route advisor through free-auto provider.
 * Key auth injected by key-rotate-lite.ts (session lock per OMP session).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ADVISOR_MODEL = "openrouter-free-auto/best-reason";

let appliedModel: string | null = null;

export function getAdvisorModel(): string | null {
  return appliedModel;
}

function resetAdvisorIfQuotaPaused(ctx: unknown): void {
  try {
    const session = (ctx as {
      session?: {
        getAdvisorStats?: () => { advisors?: Array<{ status?: string }> };
        setAdvisorEnabled?: (enabled: boolean) => void;
      };
    })?.session;
    if (!session?.getAdvisorStats || !session?.setAdvisorEnabled) return;
    const status = session.getAdvisorStats()?.advisors?.[0]?.status;
    if (status === "quota_exhausted") {
      session.setAdvisorEnabled(false);
      session.setAdvisorEnabled(true);
    }
  } catch {
    /* ignore */
  }
}

export default function (pi: ExtensionAPI) {
  appliedModel = ADVISOR_MODEL;

  pi.on("session_start", async (_e: unknown, ctx: unknown) => {
    const c = ctx as {
      settings?: {
        getModelRoles?: () => Record<string, string>;
        setModelRoles?: (roles: Record<string, string>) => void;
      };
    };
    if (c?.settings?.setModelRoles) {
      try {
        const roles = c.settings.getModelRoles?.() ?? {};
        if (roles.advisor !== ADVISOR_MODEL) {
          c.settings.setModelRoles({ ...roles, advisor: ADVISOR_MODEL });
        }
      } catch {
        /* config read-only */
      }
    }
    resetAdvisorIfQuotaPaused(ctx);
  });

  pi.registerCommand("advisor-model", {
    description: "Show current advisor model",
    handler: async (_a: unknown, ctx: unknown) => {
      const m = appliedModel ?? "not set";
      (ctx as { ui?: { notify: (msg: string, level: string) => void } }).ui?.notify(
        `Advisor model: ${m}`,
        "info",
      );
    },
  });
}
