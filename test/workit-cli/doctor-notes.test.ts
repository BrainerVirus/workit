// workit doctor `workit_notes` and `--fix` (#742): a repo's `.workit/` holds only
// committed team config; notes an agent or user left there move into
// `workit dir notes` (<git-common-dir>/workit/notes), so no repo tool scans them.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fixWorkitNotes, runDoctor } from "@/packages/workit-cli/src/admin/doctor";
import { main } from "@/packages/workit-cli/src/main";

// The full doctor run spawns many probes; a loaded machine needs the room.
setDefaultTimeout(120_000);

const scratch = realpathSync.native(mkdtempSync(path.join(tmpdir(), "workit-doctor-notes-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
};

let count = 0;
/** A directory holding `files`; a git repo with `tracked` committed when `isGit`. */
const repo = (files: Record<string, string>, tracked: string[] = [], isGit = true): string => {
  const root = path.join(scratch, `repo-${count++}`);
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  if (!isGit) return root;
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "# app\n");
  git(root, "add", "README.md", ...tracked);
  git(root, "commit", "-qm", "base");
  return root;
};

const row = (cwd: string) =>
  runDoctor({
    host: "cli",
    home: scratch,
    cwd,
    configDir: path.join(scratch, "config"),
    stateDir: path.join(scratch, "state"),
    dev: path.join(scratch, "no-dev"),
    env: { HOME: scratch, PATH: emptyBin },
  }).checks.find((check) => check.id === "workit_notes")!;

const notesDir = (root: string) => path.join(root, ".git", "workit", "notes");
const CONFIG = JSON.stringify({ checks: { test: "bun test" } });

test("Given untracked notes in .workit/ beside tracked and untracked team config, When doctor runs, Then workit_notes warns with their count and the --fix command", () => {
  const root = repo(
    {
      ".workit/checks.json": CONFIG,
      ".workit/risk-paths": "src/billing/**\n",
      ".workit/plan.md": "# plan\n",
      ".workit/briefs/a.md": "brief a\n",
      ".workit/tracked-note.md": "kept in git\n",
    },
    [".workit/risk-paths", ".workit/tracked-note.md"],
  );
  const found = row(root);
  expect(found.status).toBe("warn");
  expect(found.detail).toStartWith("2 untracked files in .workit/ besides team config");
  expect(found.detail).toContain("plan.md");
  expect(found.fix).toContain("workit doctor --fix");
  expect(found.fix).toContain("workit dir notes");
});

test("Given .workit/ with team config only, or no .workit/, When doctor runs, Then workit_notes passes", () => {
  expect(row(repo({ ".workit/checks.json": CONFIG })).status).toBe("pass");
  expect(row(repo({})).status).toBe("pass");
});

test("Given notes, team config and tracked files in .workit/, When doctor --fix runs twice, Then each note moves to `workit dir notes` at its relative path, a taken name gets a numbered one, nothing else is touched, and the second run moves nothing", async () => {
  const root = repo(
    {
      ".workit/checks.json": CONFIG,
      ".workit/risk-paths": "src/billing/**\n",
      ".workit/plan.md": "# new plan\n",
      ".workit/briefs/a.md": "brief a\n",
      ".workit/tracked-note.md": "kept in git\n",
    },
    [".workit/risk-paths", ".workit/tracked-note.md"],
  );
  // A note of that name is already in the notes dir: it is never overwritten.
  mkdirSync(notesDir(root), { recursive: true });
  writeFileSync(path.join(notesDir(root), "plan.md"), "# old plan\n");
  const trackedBefore = git(root, "ls-files", "-s");

  let stdout = "";
  const code = await main(["doctor", "--fix"], {
    cwd: root,
    env: { ...process.env, WORKIT_WORKSPACE_ROOT: "" },
    stdout: (text) => void (stdout += text),
    stderr: () => undefined,
  });
  expect([0, 1]).toContain(code);
  const plan2 = path.join(notesDir(root), "plan-2.md");
  const brief = path.join(notesDir(root), "briefs", "a.md");
  expect(stdout).toContain(`fix: moved note .workit/plan.md -> ${plan2}\n`);
  expect(stdout).toContain(`fix: moved note .workit/briefs/a.md -> ${brief}\n`);
  expect(readFileSync(path.join(notesDir(root), "plan.md"), "utf8")).toBe("# old plan\n");
  expect(readFileSync(plan2, "utf8")).toBe("# new plan\n");
  expect(readFileSync(brief, "utf8")).toBe("brief a\n");
  expect(existsSync(path.join(root, ".workit", "plan.md"))).toBe(false);
  expect(existsSync(path.join(root, ".workit", "briefs"))).toBe(false);
  // Team config and tracked files stay where they were, unchanged.
  expect(readFileSync(path.join(root, ".workit", "checks.json"), "utf8")).toBe(CONFIG);
  expect(readFileSync(path.join(root, ".workit", "risk-paths"), "utf8")).toBe("src/billing/**\n");
  expect(readFileSync(path.join(root, ".workit", "tracked-note.md"), "utf8")).toBe("kept in git\n");
  expect(git(root, "ls-files", "-s")).toBe(trackedBefore);
  expect(git(root, "status", "--porcelain", "-uall")).toBe("?? .workit/checks.json\n");
  expect(row(root).status).toBe("pass");

  expect(fixWorkitNotes({ cwd: root })).toEqual({
    action: "none",
    moves: [],
    detail: "no notes in .workit/",
  });
});

test("Given .workit/ holding the task store's legacy leftovers (ledger/, tasks/, workspace.json, metadata.lock) and one note, When doctor and --fix run, Then the row counts 1 and only the note moves; the store's leftovers stay for its own backup", () => {
  const leftovers = {
    ".workit/ledger/x.jsonl": "{}\n",
    ".workit/tasks/a.json": "{}\n",
    ".workit/workspace.json": "{}\n",
    ".workit/metadata.lock": "pid 1\n",
  };
  const root = repo({ ...leftovers, ".workit/note.md": "mine\n" });
  const found = row(root);
  expect(found.status).toBe("warn");
  expect(found.detail).toBe(
    "1 untracked file in .workit/ besides team config (checks.json, risk-paths): note.md",
  );
  expect(fixWorkitNotes({ cwd: root })).toEqual({
    action: "moved",
    moves: [{ from: ".workit/note.md", to: path.join(notesDir(root), "note.md") }],
    detail: `moved 1 into ${notesDir(root)}`,
  });
  for (const [file, text] of Object.entries(leftovers))
    expect(readFileSync(path.join(root, file), "utf8")).toBe(text);
  expect(row(root).status).toBe("pass");
});

test("Given a linked worktree with notes in its .workit/, When --fix runs there, Then they go to the clone's one notes dir, the same `workit dir notes` prints", async () => {
  const root = repo({});
  const wt = path.join(scratch, `wt-${count++}`);
  git(root, "worktree", "add", "-q", "-b", "feature/x", wt);
  mkdirSync(path.join(wt, ".workit"));
  writeFileSync(path.join(wt, ".workit", "todo.md"), "todo\n");
  const fixed = fixWorkitNotes({ cwd: wt });
  expect(fixed).toMatchObject({
    action: "moved",
    moves: [{ from: ".workit/todo.md", to: path.join(notesDir(root), "todo.md") }],
  });
  let printed = "";
  await main(["dir", "notes"], {
    cwd: wt,
    env: { ...process.env, WORKIT_WORKSPACE_ROOT: "" },
    stdout: (text) => void (printed += text),
    stderr: () => undefined,
  });
  expect(printed).toBe(`${notesDir(root)}\n`);
  expect(existsSync(path.join(wt, ".workit"))).toBe(false);
});

test("Given a directory outside git with files in .workit/, When doctor and --fix run, Then nothing is reported or moved", () => {
  const root = repo({ ".workit/plan.md": "# plan\n" }, [], false);
  expect(row(root)).toMatchObject({ status: "pass", detail: "not a git checkout" });
  expect(fixWorkitNotes({ cwd: root })).toMatchObject({ action: "none", moves: [] });
  expect(readFileSync(path.join(root, ".workit", "plan.md"), "utf8")).toBe("# plan\n");
});
