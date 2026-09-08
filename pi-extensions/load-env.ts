/**
 * load-env — auto-load ~/.pi/agent/.env into every new pi session.
 *
 * The .env file holds NOTION_API_KEY, NOTION_PARENT_PAGE, and any other
 * per-machine secrets the harness needs. Without this extension, those
 * vars are only present when a previous shell happened to export them,
 * which makes Notion pushes flaky.
 *
 * The extension does 3 things on session_start:
 *   1. Reads ~/.pi/agent/.env (if it exists)
 *   2. Sets each KEY=VALUE into the process env (does NOT override
 *      vars that are already set in the parent shell, so ad-hoc
 *      testing in this session still wins)
 *   3. Logs a one-time notification: "loaded N vars from .env"
 *      (silent if everything is already set or .env is missing)
 *
 * Format: same KEY=VALUE, # comments, blank lines. No shell quoting.
 * (Matches the format ~/.pi/agent/.env is already in.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type ExtensionAPI = {
  on(event: "session_start", handler: (event: any, ctx: any) => void): void;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const envPath = path.join(os.homedir(), ".pi", "agent", ".env");
    if (!fs.existsSync(envPath)) {
      return; // nothing to do
    }

    let content: string;
    try {
      content = fs.readFileSync(envPath, "utf8");
    } catch (e) {
      return; // can't read, skip silently
    }

    const loaded: string[] = [];
    const skipped: string[] = [];

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const eq = line.indexOf("=");
      if (eq <= 0) continue;

      const key = line.slice(0, eq).trim();
      // Strip surrounding quotes (single or double) if present
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Strip trailing inline comments (only if not in quotes)
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();

      // Don't override what the parent shell already set
      if (process.env[key] !== undefined) {
        skipped.push(key);
        continue;
      }

      process.env[key] = value;
      loaded.push(key);
    }

    if (loaded.length > 0 && ctx?.ui?.notify) {
      ctx.ui.notify(
        `load-env: loaded ${loaded.length} vars from .env (${loaded.join(", ")})`,
        "info",
      );
    }
  });
}
