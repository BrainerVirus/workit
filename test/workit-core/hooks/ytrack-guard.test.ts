// #780: a raw `ytrack` write an agent runs asks the user first on every host.
// The shell hook denies it naming the `workit youtrack …` call that asks, or,
// for a write no verb covers, asks on Claude Code and hands it to the user
// elsewhere; reads pass, and `youtrack.writes: auto` turns the guard off.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";

const base = realpathSync(tempRoot("workit-ytrack-guard-"));
const root = path.join(base, "repo");
const config = path.join(base, "config");
mkdirSync(root, { recursive: true });
mkdirSync(config, { recursive: true });
const KEYS = ["WORKIT_CONFIG_DIR", "WORKIT_STATE_DIR"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
beforeEach(() => {
  process.env.WORKIT_CONFIG_DIR = config;
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
  rmSync(path.join(config, "workspaces.json"), { force: true });
});
afterEach(() => {
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Decision = { kind: "deny" | "ask" | "pass"; reason: string };

const claude = (command: string): Decision => {
  const out = (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-bash", root, { tool_input: { command } }),
    ).json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  const kind = out?.permissionDecision;
  return {
    kind: kind === "deny" || kind === "ask" ? kind : "pass",
    reason: out?.permissionDecisionReason ?? "",
  };
};
const codex = (command: string): Decision => {
  const out = (
    dispatchHook(
      codexAdapter,
      fixture("codex", "pre-tool-use-bash", root, { tool_input: { command } }),
    ).json as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  return {
    kind: out?.permissionDecision === "deny" ? "deny" : "pass",
    reason: out?.permissionDecisionReason ?? "",
  };
};
const cursor = (command: string): Decision => {
  const out = dispatchHook(
    cursorAdapter,
    fixture("cursor", "before-shell-execution", root, { command }),
  ).json as { permission?: string; agent_message?: string };
  return {
    kind: out.permission === "deny" ? "deny" : out.permission === "ask" ? "ask" : "pass",
    reason: out.agent_message ?? "",
  };
};
const pi = (command: string): Decision => {
  const out = enforceToolPolicy(
    { toolName: "bash", input: { command } } as never,
    {
      cwd: root,
      isProjectTrusted: () => true,
    } as never,
  ) as { block?: boolean; reason?: string } | undefined;
  return { kind: out?.block ? "deny" : "pass", reason: out?.reason ?? "" };
};
const HOSTS = { claude, codex, cursor, pi };

/** Writes with a `workit youtrack` verb: the deny names that exact call. */
const COVERED: Array<[string, string]> = [
  [
    "ytrack work-item add X-1 --duration 30m --text 'Code review'",
    "workit youtrack time X-1 --minutes 30 --text 'Code review'",
  ],
  ["ytrack work-item add X-1 --duration 1h30m", "workit youtrack time X-1 --minutes 90"],
  [
    "ytrack work-item add X-1 --duration 45m --date 2026-10-06",
    "workit youtrack time X-1 --minutes 45 --date 2026-10-06",
  ],
  [
    "ytrack issue comment X-1 --body 'Fixed in #42'",
    "workit youtrack note X-1 --markdown 'Fixed in #42'",
  ],
  ["ytrack issue comment X-1 --body-file reply.md", "workit youtrack note X-1 --file reply.md"],
  [
    "ytrack issue create --project APP --summary 'Crash on start'",
    "workit youtrack create --project APP --summary 'Crash on start'",
  ],
  ["ytrack --debug issue comment X-1 --body=hi", "workit youtrack note X-1 --markdown hi"],
  ["ytrack issue command X-1 'State Fixed'", "workit youtrack update X-1 --state Fixed"],
  ["ytrack api /issues/X-1/comments -f text=hi", "workit youtrack note X-1 --markdown hi"],
];

/** Writes no workit verb covers: Claude Code asks, the other hosts deny. */
const UNCOVERED = [
  "ytrack issue edit X-1 --summary 'New title'",
  "ytrack issue update X-1 --field State=Fixed",
  "ytrack issue delete X-1",
  "ytrack work-item edit X-1 115-3 --duration 2h",
  "ytrack work-item delete X-1 115-3 --yes",
  "ytrack api /issues/X-1/comments -X POST",
  "ytrack api /issues/X-1/comments -XPOST",
  "ytrack api /issues/X-1 --method PUT",
  "ytrack api /issues/X-1 --method=patch",
  "ytrack api /issues/X-1/comments/4-17 -X DELETE",
  "ytrack api /issues/X-1/comments -X=POST",
  "ytrack api /commands --input command.json",
];

/** The same comment, wrapped or respelled. */
const comment = "ytrack issue comment X-1 --body hi";
const WRAPPED = [
  `bash -c '${comment}'`,
  `sh -c "${comment}"`,
  `eval "${comment}"`,
  `npx ${comment}`,
  `npx -y ${comment}`,
  `bunx ${comment}`,
  `pnpm dlx ${comment}`,
  `/usr/local/bin/${comment}`,
  `~/.local/bin/${comment}`,
  `y"t"rack issue comment X-1 --body hi`,
  `timeout 30 ${comment}`,
  `nohup ${comment}`,
  `workit check --name yt -- ${comment}`,
  `workit check --name yt --shell -- '${comment}'`,
];

/** The same comment where the call is not a plain command: judged, but no workit call is named. */
const WRAPPED_UNMAPPED = [
  `cd /tmp && ${comment}`,
  `git status && ${comment}`,
  `echo start; ${comment}`,
  `false || ${comment}`,
  `YTRACK_HOST=acme ${comment}`,
  `env YTRACK_HOST=acme ${comment}`,
  `echo '${comment}' | bash`,
  `bash <<'EOF'\n${comment}\nEOF`,
  `echo $(${comment})`,
  `Y=ytrack; $Y issue comment X-1 --body hi`,
  `sudo -u me ${comment}`,
];

/** Reads and mentions: untouched. */
const READS = [
  "ytrack issue view X-1 --json summary,comments",
  "ytrack issue list -q 'project: APP #Unresolved' --json idReadable",
  "ytrack work-item list X-1 --author me --json id,duration",
  "ytrack api /users/me --fields login",
  "ytrack api /issues -X GET -f query='project: APP' --fields idReadable",
  "ytrack api /issues --method get -f query=x",
  "ytrack issue command X-1 'State Fixed' --dry-run",
  "ytrack auth status",
  "ytrack --version",
  "echo ytrack issue comment X-1 --body hi",
  "grep -n 'ytrack issue comment' notes.md",
  "cat ~/.claude/skills/ytrack/SKILL.md",
];

test("G the default ask, W raw ytrack writes a workit verb covers, T every host denies naming that exact call", () => {
  for (const [command, call] of COVERED)
    for (const [host, run] of Object.entries(HOSTS)) {
      const out = run(command);
      expect(out.kind, `${host}: ${command}`).toBe("deny");
      expect(out.reason, `${host}: ${command}`).toContain(`\`${call}\``);
      expect(out.reason, `${host}: ${command}`).toContain("workit approve <id>");
    }
});

test("G the default ask, W raw ytrack writes no workit verb covers, T Claude Code asks and the other hosts deny handing it to the user", () => {
  for (const command of UNCOVERED) {
    expect(claude(command).kind, command).toBe("ask");
    expect(claude(command).reason, command).toContain("the user decides this call");
    for (const [host, run] of Object.entries({ codex, cursor, pi })) {
      const out = run(command);
      expect(out.kind, `${host}: ${command}`).toBe("deny");
      expect(out.reason, `${host}: ${command}`).toContain("in their own terminal");
    }
  }
});

test("G the default ask, W the write is wrapped, chained, piped or respelled, T it gets the same deny", () => {
  for (const command of WRAPPED)
    for (const [host, run] of Object.entries(HOSTS)) {
      const out = run(command);
      expect(out.kind, `${host}: ${command}`).toBe("deny");
      expect(out.reason, `${host}: ${command}`).toContain(
        "`workit youtrack note X-1 --markdown hi`",
      );
    }
  // Not a plain command: Claude Code asks, the deny-only hosts hand it to the user.
  for (const command of WRAPPED_UNMAPPED) {
    expect(claude(command).kind, command).toBe("ask");
    for (const [host, run] of Object.entries({ codex, cursor, pi })) {
      const out = run(command);
      expect(out.kind, `${host}: ${command}`).toBe("deny");
      expect(out.reason, `${host}: ${command}`).toContain("in their own terminal");
      expect(out.reason, `${host}: ${command}`).not.toContain("`workit youtrack");
    }
  }
  // xargs appends its input as operands: judged, but no workit call carries them.
  for (const [host, run] of Object.entries(HOSTS))
    expect(run(`xargs ${comment} <<< x`).kind, host).not.toBe("pass");
  // Piped text: no workit call carries it, so the user decides.
  expect(claude(`echo hi | ytrack issue comment X-1 --body-file -`).reason).toContain(
    "cannot carry text read from standard input",
  );
});

test("G the default ask, W ytrack reads or a mention, T no host denies or asks", () => {
  for (const command of READS)
    for (const [host, run] of Object.entries(HOSTS))
      expect(run(command).kind, `${host}: ${command}`).toBe("pass");
});

test("G youtrack.writes auto for this workspace, W any raw ytrack write, T nothing is denied or asked", () => {
  writeFileSync(
    path.join(config, "workspaces.json"),
    `${JSON.stringify({
      workspaces: [
        {
          name: "yt",
          glob: `${root.replaceAll("\\", "/")}/**`,
          youtrack: { writes: "auto" },
        },
      ],
    })}\n`,
  );
  for (const command of [...COVERED.map(([raw]) => raw), ...UNCOVERED, ...WRAPPED.slice(0, 6)])
    for (const [host, run] of Object.entries(HOSTS))
      expect(run(command).kind, `${host}: ${command}`).toBe("pass");
});
