// A repository with one fanout plan whose lead records standing orders, for
// the standing-delta suites (#320).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearStanding,
  liftStop,
  recordStanding,
  type RecordContext,
} from "@/packages/workit-core/src/ledger";

export const LEAD = "11111111-aaaa-bbbb-cccc-000000000001";
const FANOUT = "wave";
const SLICE_BRANCH = "feature/slice-a";

const dirs: string[] = [];
export const cleanup = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
};

/** A repo on `main` with a fanout plan led by LEAD, and a worktree on the slice branch. */
export const standingRepo = (): { root: string; slice: string } => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wk-standing-")));
  dirs.push(root);
  git(root, "init", "-q", "-b", "main");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  const fanouts = path.join(root, ".git", "workit", "fanouts");
  mkdirSync(fanouts, { recursive: true });
  writeFileSync(
    path.join(fanouts, `${FANOUT}.json`),
    JSON.stringify({
      v: 1,
      name: FANOUT,
      trunk: "main",
      slices: [{ id: "a", branch: SLICE_BRANCH, base: "main", scope: ["src/**"] }],
      leadSession: LEAD,
      formerLeads: [],
    }),
  );
  const slice = path.join(root, ".claude", "worktrees", "slice-a");
  git(root, "worktree", "add", "-q", "-b", SLICE_BRANCH, slice, "main");
  return { root, slice };
};

const lead = (root: string): RecordContext => ({
  cwd: root,
  actor: { host: "claude_code", session: LEAD, agentId: null },
});

export const addOrder = (root: string, what: string, stop = false): string => {
  const row = recordStanding(lead(root), { fanout: FANOUT, lead: LEAD, what, stop });
  if (!row.ok) throw new Error(row.error);
  return row.value.id;
};

export const clearOrder = (root: string, id: string): void => {
  const row = clearStanding(lead(root), { fanout: FANOUT, lead: LEAD, leads: [LEAD], target: id });
  if (!row.ok) throw new Error(row.error);
};

export const liftStopLine = (root: string): void => {
  const rows = liftStop(lead(root), { fanout: FANOUT, lead: LEAD, leads: [LEAD] });
  if (!rows.ok) throw new Error(rows.error);
};
