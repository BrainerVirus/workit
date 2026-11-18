// The RSS notice of a background process (#328) on the owner's next hook. The
// supervisor `workit run --bg` starts writes `<state>/procs/notices/<session>.json`
// once a process passes the memory ceiling (core/procs.ts writeRssNotice);
// the next hook of that session takes the file and says it once. A plain file
// read and rename: no SQLite or spawn on a hook path. The launchers' fast paths
// (Claude Code bin/workit-hook.mjs, the Codex launcher) keep a copy of
// `procNoticeFile` so a pending notice loads the runtime;
// test/workit-core/hooks/server-gate.test.ts holds them equal.
import fs from "node:fs";
import path from "node:path";
import { stateDir } from "../core/workit-paths.mjs";

/** `<state>/procs/notices/<session>.json`: core/procs.ts noticeFile, without its store imports. */
export const procNoticeFile = (env: NodeJS.ProcessEnv, session: string): string =>
  path.join(
    stateDir(env),
    "procs",
    "notices",
    `${session.replace(/[^A-Za-z0-9_.@+-]/gu, "-").slice(0, 120) || "none"}.json`,
  );

const mb = (bytes: unknown): string => `${Math.round(Number(bytes) / 1048576)} MB`;

/**
 * The session's pending RSS notices as one model-visible block, or null. The
 * file is renamed before it is read, so two hooks never both say it; a
 * process the supervisor already named is never named again (its row is
 * marked), so the taken file is simply removed. Never throws.
 */
export function takeProcNotice(
  session: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!session) return null;
  const file = procNoticeFile(env, session);
  const taken = `${file}.${process.pid}.taken`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return null;
  }
  try {
    const { notices } = JSON.parse(fs.readFileSync(taken, "utf8")) as { notices?: unknown };
    const lines = (Array.isArray(notices) ? notices : []).flatMap((notice) => {
      if (!notice || typeof notice !== "object") return [];
      const { id, cmd, cwd, rssBytes, ceilingBytes } = notice as Record<string, unknown>;
      if (typeof id !== "string") return [];
      return [
        `  - ${id} \`${String(cmd)}\` in ${String(cwd)}: ${mb(rssBytes)}, past the ${mb(ceilingBytes)} ceiling. Restart it: \`workit run --bg --restart ${id}\`; or stop it: \`workit stop ${id}\`.`,
      ];
    });
    return lines.length
      ? [
          "Workit: a background process you started uses more memory than this machine's heavy-check budget allows:",
          ...lines,
        ].join("\n")
      : null;
  } catch {
    return null;
  } finally {
    try {
      fs.rmSync(taken, { force: true });
    } catch {
      // A leftover taken file is never read again.
    }
  }
}
