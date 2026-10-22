// The standing-order revision signal (#320). Every standing add or clear
// writes the new row's id to `<store>/standing/rev`; each agent that a hook
// has answered since keeps the revision it last saw in
// `<store>/standing/seen/<key>.json`. A tool call whose agent already saw the
// current revision costs two small reads and never loads the Workit runtime.
// fs, path and crypto only: the Codex launcher imports this before the
// runtime, and the Claude Code launcher (bin/workit-hook.mjs) keeps a copy
// that test/workit-core/hooks/standing-signal.test.ts holds equal.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type StandingSeen = { rev: string | null; ids: string[] };

/** `<git common dir>/workit` by fs reads alone, or null outside a repository. */
export const gitStoreDir = (cwd: string): string | null => {
  try {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
      const dotGit = path.join(dir, ".git");
      if (fs.existsSync(dotGit)) {
        let gitDir = dotGit;
        if (fs.statSync(dotGit).isFile()) {
          const target = /^gitdir:\s*(.+)$/mu.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
          if (!target) return null;
          gitDir = path.resolve(dir, target);
          const common = path.join(gitDir, "commondir");
          if (fs.existsSync(common))
            gitDir = path.resolve(gitDir, fs.readFileSync(common, "utf8").trim());
        }
        return path.join(gitDir, "workit");
      }
      if (path.dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
};

export const standingRevFile = (store: string): string => path.join(store, "standing", "rev");

/** One file per agent: a host session, or one subagent of it. */
export const standingSeenFile = (store: string, session: string, agentId: string | null): string =>
  path.join(
    store,
    "standing",
    "seen",
    `${createHash("sha256")
      .update(`${session}\0${agentId ?? ""}`)
      .digest("hex")
      .slice(0, 32)}.json`,
  );

export const readStandingRev = (store: string): string | null => {
  try {
    return fs.readFileSync(standingRevFile(store), "utf8").trim() || null;
  } catch {
    return null;
  }
};

export const readStandingSeen = (file: string): StandingSeen => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as { rev?: unknown; ids?: unknown };
    return {
      rev: typeof value.rev === "string" ? value.rev : null,
      ids: Array.isArray(value.ids)
        ? value.ids.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { rev: null, ids: [] };
  }
};

/** Fails open: without the file the agent is offered the same delta again. */
export const writeStandingSeen = (file: string, seen: StandingSeen): void => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(seen));
  } catch {
    // An unwritable store only repeats the delta.
  }
};

export const bumpStandingRev = (store: string, rev: string): void => {
  try {
    fs.mkdirSync(path.join(store, "standing"), { recursive: true });
    fs.writeFileSync(standingRevFile(store), `${rev}\n`);
  } catch {
    // Running workers miss the delta; briefs rendered later still carry it.
  }
};

/** Has this agent not yet seen the store's current standing revision? */
export const standingPending = (cwd: string, session: string, agentId: string | null): boolean => {
  const store = gitStoreDir(cwd);
  const rev = store ? readStandingRev(store) : null;
  return rev !== null && readStandingSeen(standingSeenFile(store!, session, agentId)).rev !== rev;
};
