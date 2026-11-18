// D5 drift test 2 (decision first-try 2026-11-18): every shell example a role's
// agent file teaches must pass that role's own confinement hook, with its
// placeholders filled. A verifier or reviewer example goes through judge
// confinement, an implementer example through implementer confinement. An
// example the hook still refuses sits in role-example-drift.baseline.json,
// which only shrinks: the fixing slice drops its line. No command is run;
// the hook is only dispatched.
import "@/test/shared/state-isolation";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { fixture } from "../workit-core/hooks/hook-fixtures";

setDefaultTimeout(60_000);

const REPO = path.resolve(import.meta.dir, "..", "..");
const AGENTS = path.join(REPO, "packages", "workit-claude-code", "agents");
const BASELINE = path.join(import.meta.dir, "role-example-drift.baseline.json");

const ROLES = {
  verifier: { file: "verifier.md", type: "workit:verifier" },
  reviewer: { file: "reviewer.md", type: "workit:reviewer" },
  implementer: { file: "implementer.md", type: "workit:implementer" },
} as const;
type Role = keyof typeof ROLES;

/** The first word of a shell example worth judging: a command a role runs itself. */
const COMMAND = /^(?:git|workit|node|python3|bun|sed|cat|ls|grep|mkdir|rg|[A-Z]\w*=)\b/u;

/** A bare interpreter flag (`node -e`, `python3 -c`) names a kind of call, not one to run. */
const FRAGMENT = /^(?:node|python3|bun) -\w$/u;

/**
 * Commands an agent file names as another role's (the lead makes the
 * worktree an implementer works in): mentions, not examples for this role.
 */
const OTHER_ROLE = /^workit fanout worktree create\b/u;

/** Every inline code span of `text` that is a runnable shell example (no `…` elision). */
export const shellExamples = (text: string): string[] => [
  ...new Set(
    [...text.matchAll(/`([^`\n]+)`/gu)]
      .map((match) => match[1].trim())
      .filter(
        (span) =>
          COMMAND.test(span) &&
          !span.includes("…") &&
          span.includes(" ") &&
          !FRAGMENT.test(span) &&
          !OTHER_ROLE.test(span),
      ),
  ),
];

let configHome: ConfigHome;
let root: string;
let lead: string;
let wt: string;
const stateBefore = process.env.WORKIT_STATE_DIR;

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/** The placeholders an example names, filled with this world's values. */
const fill = (example: string): string =>
  example
    .replaceAll(/\b([\w-]+)(?:\|[\w-]+)+\b/gu, "$1")
    .replaceAll("<candidate worktree>", wt)
    .replaceAll("<worktree>", wt)
    .replaceAll("<checkout>", lead)
    .replaceAll("<branch>", "feature/a")
    .replaceAll("<b>", "feature/a")
    .replaceAll("<base>", "main")
    .replaceAll("<slice>", "a")
    .replaceAll("<name>", "test")
    .replaceAll("<cmd>", "true")
    .replaceAll("<email>", "t@t")
    .replaceAll("<id>", "s1")
    .replaceAll("<token>", "t0")
    .replaceAll(/<paths?(?: in scope)?>/gu, "a.ts")
    .replaceAll(/<[^>]+>/gu, "x");

beforeAll(async () => {
  configHome = useConfigHome("wk-role-drift-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-role-drift-"));
  process.env.WORKIT_STATE_DIR = path.join(root, "state");
  lead = path.join(root, "app");
  mkdirSync(lead, { recursive: true });
  git(lead, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "t"],
    ["user.email", "t@t"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", path.join(root, "no-hooks")],
  ])
    git(lead, "config", key, value);
  writeFileSync(path.join(lead, "a.ts"), "export const a = 1;\n");
  git(lead, "add", "-A");
  git(lead, "commit", "-qm", "chore: base");
  const plan = path.join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({
      name: "wave",
      trunk: "main",
      slices: [
        {
          id: "a",
          branch: "feature/a",
          tier: "standard",
          reason: "parallel",
          scope: ["a.ts"],
          goal: "ship a",
          acceptance: ["Given the app, When a runs, Then it works"],
          verify: ["workit check test"],
          forbidden: ["no edits outside SCOPE"],
        },
      ],
    }),
  );
  const cli = async (argv: string[]) => {
    let stdout = "";
    const code = await main(argv, {
      cwd: lead,
      env: { ...process.env, WORKIT_SESSION_ID: "lead-drift" },
      stdout: (text) => void (stdout += text),
      stderr: () => undefined,
    });
    if (code !== 0) throw new Error(`workit ${argv.join(" ")}: ${stdout}`);
    return JSON.parse(stdout).data;
  };
  await cli(["fanout", "plan", plan, "--json"]);
  wt = (await cli(["fanout", "worktree", "create", "a", "--json"])).path;
});

afterAll(() => {
  if (stateBefore === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = stateBefore;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});

type Specific = {
  hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
};

/** The deny reason the role's hook gives `command`, or null when it runs. */
const refusal = (role: Role, command: string): string | null => {
  // A judge works from the lead's checkout; an implementer from its own worktree.
  const payload = fixture("claude-code", "pre-tool-use-write", role === "implementer" ? wt : lead, {
    tool_name: "Bash",
    tool_input: { command },
  });
  payload.agent_id = `${role}-drift`;
  payload.agent_type = ROLES[role].type;
  const out = (dispatchHook(claudeCodeAdapter, payload, {}).json as Specific).hookSpecificOutput;
  return out?.permissionDecision === "deny" ? (out.permissionDecisionReason ?? "denied") : null;
};

/** `<file>: <example as written>` for every example its role's hook refuses. */
const hits = (): string[] =>
  (Object.keys(ROLES) as Role[]).flatMap((role) =>
    shellExamples(readFileSync(path.join(AGENTS, ROLES[role].file), "utf8"))
      .filter((example) => refusal(role, fill(example)) !== null)
      .map((example) => `${ROLES[role].file}: ${example}`),
  );

test("Given an agent file's text, When its shell examples are read, Then each runnable inline example is listed once", () => {
  expect(
    shellExamples(
      "run `git -C <worktree> status --short`, then `git -C <worktree> status --short`; not `workit git …` or `node -e`",
    ),
  ).toEqual(["git -C <worktree> status --short"]);
});

test("Given the role agent files, When each shell example runs through its role's confinement hook, Then only the baselined ones are refused (the baseline only shrinks)", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as string[];
  const found = hits();
  const fresh = found.filter((hit) => !baseline.includes(hit));
  const fixed = baseline.filter((hit) => !found.includes(hit));
  expect(fresh, "an agent file teaches a command its own hook refuses").toEqual([]);
  expect(fixed, `fixed: drop these lines from ${path.basename(BASELINE)}`).toEqual([]);
});
