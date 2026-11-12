// Bench privacy (scripts/eval/privacy.ts): evals/results is committed to a
// public repo, so no result file may carry an account's home path, a host's
// projects map or a real Workit config; the runner scrubs a transcript and
// refuses a file that still holds a private string. Every fixture here is
// invented, and the "real" home is a temp dir.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCases, type EvalCase } from "@/scripts/eval/cases";
import { linkedRoots } from "@/scripts/eval/confine";
import { grade } from "@/scripts/eval/grade";
import {
  accountIds,
  committedLeaks,
  envCredentials,
  hostCredentials,
  pathClass,
  privateHits,
  privateKinds,
  privateStrings,
  refusalKinds,
  rootSpellings,
  safeRoots,
  scrubAccount,
  scrubOutsideReads,
  scrubRoots,
  shownHit,
  unscrubRoots,
  workitVocabulary,
  type Origins,
} from "@/scripts/eval/privacy";

const REPO = path.join(import.meta.dir, "..", "..");
const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const RESULTS = path.join(import.meta.dir, "..", "..", "evals", "results");

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
  );

test("no committed bench result carries a home path, a projects map or a real config", () => {
  const leaks = filesUnder(RESULTS).flatMap((file) =>
    committedLeaks(readFileSync(file, "utf8")).map(
      (kind) => `${path.relative(RESULTS, file)}: ${kind}`,
    ),
  );
  expect(leaks).toEqual([]);
});

test("an absolute path under a home dir is a leak; placeholders and invented homes are not", () => {
  expect(committedLeaks('{"cwd":"/home/alice-example/src/app"}')).toEqual(["home path"]);
  expect(committedLeaks('"/Users/alice-example/Library/x"')).toEqual(["home path"]);
  expect(committedLeaks('{"cwd":"<world>/home/.claude/projects/x"}')).toEqual([]);
  expect(committedLeaks("--glob '/home/me/work/**' and /home/<user>/x/")).toEqual([]);
});

test("a host config's projects map is a leak, escaped inside a transcript string too", () => {
  expect(committedLeaks('{"projects":{"/srv/acme/app":{"history":[]}}}')).toEqual(["projects map"]);
  expect(committedLeaks('"content":"{\\"projects\\": {\\"~/code/app\\": {}}}"')).toEqual([
    "projects map",
  ]);
  expect(committedLeaks('{"memory_paths":"<world>/home/.claude/projects/x"}')).toEqual([]);
});

test("a workspace glob under the real home is a real config; the world's and redacted ones are not", () => {
  const read = (glob: string): string =>
    JSON.stringify({ content: `1\t${JSON.stringify({ workspaces: [{ name: "w", glob }] })}` });
  expect(committedLeaks(read("~/code/acme/**"))).toEqual(["real config"]);
  expect(committedLeaks(read("<world>/**"))).toEqual([]);
  expect(committedLeaks(read("~/projects/placeholder-1/**"))).toEqual([]);
});

const ACCOUNT = { homes: ["/home/alice-example"], user: "alice-example", host: "box-example" };

test("the account's home (absolute and as a project slug), user and host become placeholders", () => {
  const text = [
    "/home/alice-example/.config/workit/workspaces.json",
    "~/.claude/projects/-home-alice-example-src-app",
    "owner alice-example on box-example.",
    "/home/alice-examples/x stays: another dir",
  ].join("\n");
  expect(scrubAccount(text, ACCOUNT)).toBe(
    [
      "~/.config/workit/workspaces.json",
      "~/.claude/projects/<home>-src-app",
      "owner <user> on <host>.",
      "/home/<user>s/x stays: another dir",
    ].join("\n"),
  );
});

test("a path's class: the world, the checkout and relative paths are inside; ~ and absolute paths are not", () => {
  expect(pathClass("<world>/config/workspaces.json")).toBeNull();
  expect(pathClass("<workit>/packages/workit-core/x.ts")).toBeNull();
  expect(pathClass("src/app.ts")).toBeNull();
  expect(pathClass("/dev/null")).toBeNull();
  expect(pathClass("~/.config/workit/workspaces.json")).toBe("real config");
  expect(pathClass("$HOME/.local/state/workit/node.json")).toBe("real state");
  expect(pathClass("~/.claude.json")).toBe("host config");
  expect(pathClass("~/.config/opencode/opencode.json")).toBe("host config");
  expect(pathClass("~/code/acme")).toBe("home");
  expect(pathClass("/etc/hosts")).toBe("system");
});

const claudeCall = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
const claudeResult = (id: string, content: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
    ...extra,
  });
/** The kernel confined the host's reads: only a call that names an outside path loses its result. */
const BOUNDED = { bounded: true, spec: null };
const SECRET = '{"workspaces":[{"name":"acme-example","glob":"~/code/acme-example/**"}]}';

test("Claude Code: an outside-world Read, Bash and Grep keep only the path class and byte length", () => {
  const transcript = [
    claudeCall("r1", "Read", { file_path: "~/.config/workit/workspaces.json" }),
    claudeResult("r1", `1\t${SECRET}`, {
      tool_use_result: {
        type: "text",
        file: { filePath: "~/.config/workit/workspaces.json", content: SECRET },
      },
    }),
    claudeCall("b1", "Bash", { command: "cd <world>/repo && cat ~/.claude.json" }),
    claudeResult("b1", '{"projects":{"/srv/acme-example":{}}}'),
    claudeCall("g1", "Grep", { pattern: "acme", path: "/srv" }),
    claudeResult("g1", "/srv/acme-example/notes.txt"),
    claudeCall("i1", "Read", { file_path: "<world>/config/workspaces.json" }),
    claudeResult("i1", "1\t{}"),
    claudeCall("d1", "Edit", { file_path: "~/.config/workit/workspaces.json" }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "d1",
            content: "PreToolUse:Edit hook error: workit config guard: ask the user",
            is_error: true,
          },
        ],
      },
    }),
  ].join("\n");
  const lines = scrubOutsideReads(transcript, BOUNDED)
    .split("\n")
    .map((line) => JSON.parse(line));
  const result = (at: number): unknown => lines[at].message.content[0].content;
  expect(result(1)).toBe(
    `<outside-world file: real config, ${Buffer.byteLength(`1\t${SECRET}`)} bytes>`,
  );
  expect(lines[1].tool_use_result).toBe(
    `<outside-world file: real config, ${Buffer.byteLength(JSON.stringify({ type: "text", file: { filePath: "~/.config/workit/workspaces.json", content: SECRET } }))} bytes>`,
  );
  expect(result(3)).toStartWith("<outside-world file: host config, ");
  expect(result(5)).toStartWith("<outside-world file: system, ");
  expect(result(7)).toBe("1\t{}");
  // A blocking hook leaves no flag of its own: only its fixed opening words stay.
  expect(result(9)).toMatch(
    /^PreToolUse:Edit hook error\n<outside-world file: real config, \d+ bytes>$/u,
  );
  expect(lines.map((line) => JSON.stringify(line)).join("\n")).not.toContain("acme-example");
});

let parts = 0;
const opencodeTool = (tool: string, state: Record<string, unknown>): string =>
  JSON.stringify({
    type: "tool_use",
    sessionID: "ses_1",
    part: { id: `p-${tool}-${(parts += 1)}`, tool, state },
  });

test("OpenCode: an outside-world read or shell keeps only the path class; world calls and denials stay", () => {
  const transcript = [
    opencodeTool("read", {
      status: "completed",
      input: { filePath: "~/.config/workit/workspaces.json" },
      output: SECRET,
      metadata: { preview: SECRET },
    }),
    opencodeTool("shell", {
      status: "completed",
      input: { command: "ls ~/code", workdir: "<world>/repo" },
      output: "acme-example\n",
    }),
    opencodeTool("shell", {
      status: "completed",
      input: { command: "workit dir config", workdir: "<world>/repo" },
      output: "<world>/config\n",
    }),
    opencodeTool("read", {
      status: "error",
      input: { path: "~/.claude.json" },
      error: "Permission denied: external_directory",
    }),
  ].join("\n");
  const states = scrubOutsideReads(transcript, BOUNDED)
    .split("\n")
    .map((line) => JSON.parse(line).part.state);
  expect(states[0]).toEqual({
    status: "completed",
    input: { filePath: "~/.config/workit/workspaces.json" },
    output: `<outside-world file: real config, ${Buffer.byteLength(SECRET)} bytes>`,
    facts: {},
  });
  expect(states[1].output).toBe("<outside-world file: home, 13 bytes>");
  expect(states[2].output).toBe("<world>/config\n");
  expect(states[3].error).toBe("Permission denied: external_directory");
});

/** A fake real home with an invented Workit config, host projects map and git identity. */
const fakeHome = (): string => {
  const home = mkdtempSync(path.join(os.tmpdir(), "workit-privacy-home-"));
  temps.push(home);
  mkdirSync(path.join(home, ".config", "workit"), { recursive: true });
  writeFileSync(
    path.join(home, ".config", "workit", "workspaces.json"),
    JSON.stringify({
      $schema: "https://example.invalid/schemas/workspaces.json",
      workspaces: [
        {
          name: "acme-example",
          glob: "~/code/acme-example/**",
          youtrack: { baseUrl: "https://acme-example.youtrack.invalid" },
          commitPolicy: { preset: "conventional" },
          branchPolicy: { preset: "github-flow", protected: ["main"] },
          models: { lead: { claude_code: "sonnet" } },
        },
      ],
    }),
  );
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ projects: { [path.join(home, "code", "widget-example")]: {} } }),
  );
  mkdirSync(path.join(home, ".gitconfig.d"));
  writeFileSync(
    path.join(home, ".gitconfig"),
    '[includeIf "gitdir:~/code/"]\n\tpath = ~/.gitconfig.d/work.inc\n',
  );
  writeFileSync(
    path.join(home, ".gitconfig.d", "work.inc"),
    "[user]\n\tname = Ada Example\n\temail = ada@example.invalid\n",
  );
  return home;
};

test("the private set holds the real config's own values, project paths and git identity, never Workit's vocabulary", () => {
  const home = fakeHome();
  const set = privateStrings(home, workitVocabulary(REPO));
  expect(set.get("acme-example")).toBe("real Workit config value");
  expect(set.get("~/code/acme-example/**")).toBe("real Workit config value");
  expect(set.get("https://acme-example.youtrack.invalid")).toBe("real Workit config value");
  expect(set.get(path.join(home, "code", "widget-example"))).toBe("host project path");
  expect(set.get("~/code/widget-example")).toBe("host project path");
  expect(set.get("Ada Example")).toBe("git user name");
  expect(set.get("ada@example.invalid")).toBe("git user email");
  expect(set.get(home)).toBe("home path");
  for (const vocabulary of ["conventional", "github-flow", "sonnet", "main", "workspaces"])
    expect(set.has(vocabulary)).toBe(false);
  expect(set.has("https://example.invalid/schemas/workspaces.json")).toBe(false);
});

test("a text holding a private string reports only its kind, as is or JSON-escaped", () => {
  const set = privateStrings(fakeHome(), workitVocabulary(REPO));
  expect(privateKinds("the workspace acme-example matched", set)).toEqual([
    "real Workit config value",
  ]);
  expect(privateKinds(JSON.stringify({ text: "author: Ada Example" }), set)).toEqual([
    "git user name",
  ]);
  expect(privateKinds("workspace eval, glob <world>/**, preset conventional", set)).toEqual([]);
});

const MARKER = /^<outside-world file: /u;

test("a relative path with .., a cd .. and an XDG or HOME variable count as outside on both hosts", () => {
  const commands = [
    "cat ../../../.config/workit/workspaces.json",
    "cd .. && cat .config/x",
    "cat $XDG_CONFIG_HOME/workit/w.json",
    "cat ${HOME}/notes.txt",
    "cat $SOME_UNKNOWN/x",
    "cd ~ && cat .claude.json",
  ];
  const claude = scrubOutsideReads(
    commands
      .flatMap((command, at) => [
        claudeCall(`c${at}`, "Bash", { command }),
        claudeResult(`c${at}`, "acme-example"),
      ])
      .join("\n"),
    BOUNDED,
  )
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "user")
    .map((event) => event.message.content[0].content);
  expect(claude).toHaveLength(commands.length);
  for (const result of claude) expect(result).toMatch(MARKER);
  expect(claude[0]).toStartWith("<outside-world file: real config, ");
  expect(claude[2]).toStartWith("<outside-world file: real config, ");
  expect(claude[5]).toStartWith("<outside-world file: host config, ");
  const opencode = scrubOutsideReads(
    commands
      .map((command) =>
        opencodeTool("shell", {
          status: "completed",
          input: { command, workdir: "<world>/repo" },
          output: "acme-example",
        }),
      )
      .join("\n"),
    BOUNDED,
  )
    .split("\n")
    .map((line) => JSON.parse(line).part.state.output);
  for (const output of opencode) expect(output).toMatch(MARKER);
});

test("relative paths inside the world's project dir, and a cd into it, keep their results", () => {
  const commands = [
    "cat src/app.ts",
    "cd src && cat app.ts",
    "cd <world>/repo && git status --short",
    "git log --oneline -3 2>/dev/null | head -n 3",
    "workit check test",
  ];
  const results = scrubOutsideReads(
    commands
      .flatMap((command, at) => [
        claudeCall(`k${at}`, "Bash", { command }),
        claudeResult(`k${at}`, "kept"),
      ])
      .join("\n"),
    BOUNDED,
  )
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((event) => event.type === "user")
    .map((event) => event.message.content[0].content);
  expect(results).toEqual(commands.map(() => "kept"));
});

test("an account file that exists but cannot be parsed or read stops the private set, naming the file and never its content", () => {
  const broken: [string, string][] = [
    [path.join(".config", "workit", "workspaces.json"), '{"workspaces": [acme-example'],
    [path.join(".config", "workit", "config.json"), "acme-example}"],
    [".claude.json", "{acme-example"],
    [".gitconfig", "[user\n\tname = acme-example\n"],
  ];
  for (const [rel, content] of broken) {
    const home = fakeHome();
    writeFileSync(path.join(home, rel), content);
    let message = "";
    try {
      privateStrings(home, workitVocabulary(REPO));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(path.join(home, rel));
    expect(message).not.toContain("acme-example");
  }
  if (process.getuid?.() !== 0) {
    const home = fakeHome();
    chmodSync(path.join(home, ".config", "workit", "workspaces.json"), 0o000);
    expect(() => privateStrings(home, workitVocabulary(REPO))).toThrow(/workspaces\.json: EACCES/u);
  }
  // A file that does not exist is fine.
  const bare = mkdtempSync(path.join(os.tmpdir(), "workit-privacy-bare-"));
  temps.push(bare);
  expect([...privateStrings(bare, workitVocabulary(REPO)).values()]).toEqual(["home path"]);
});

test("the bench's own docs carry no home path the committed scan would flag", () => {
  expect(
    committedLeaks(readFileSync(path.join(REPO, "docs", "agents", "eval.md"), "utf8")),
  ).toEqual([]);
});

// ------------------------------------------------------------ the scrub never changes a grade

type Step = {
  tool: string;
  input: Record<string, unknown>;
  result: string;
  failed?: boolean;
  /** Refused before it ran: Claude Code's `permission_denied` event, OpenCode's bare permission error. */
  denied?: boolean;
};
type Host = "claude-code" | "opencode";
const HOSTS: Host[] = ["claude-code", "opencode"];
const OPENCODE_NAMES: Record<string, string> = { Bash: "shell", Read: "read", Agent: "subagent" };

/** A whole run in a host's transcript format: its calls, their results and the final answer. */
const runOf = (host: Host, steps: Step[], answer: string): string => {
  if (host === "claude-code")
    return [
      ...steps.flatMap((step, at) => [
        claudeCall(`s${at}`, step.tool, step.input),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: `s${at}`,
                content: step.result,
                is_error: step.failed === true || step.denied === true,
              },
            ],
          },
        }),
        ...(step.denied
          ? [
              JSON.stringify({
                type: "system",
                subtype: "permission_denied",
                tool_use_id: `s${at}`,
              }),
            ]
          : []),
      ]),
      JSON.stringify({ type: "result", subtype: "success", result: answer }),
    ].join("\n");
  const event = (type: string, part: Record<string, unknown>): string =>
    JSON.stringify({ type, sessionID: "ses_root", part });
  return [
    event("step_start", { type: "step-start" }),
    ...steps.map((step, at) =>
      event("tool_use", {
        id: `s${at}`,
        tool: OPENCODE_NAMES[step.tool] ?? step.tool,
        state:
          step.failed || step.denied
            ? { status: "error", input: step.input, error: step.result }
            : { status: "completed", input: step.input, output: step.result },
      }),
    ),
    event("text", { text: answer }),
    event("step_finish", { type: "step-finish", reason: "stop" }),
  ].join("\n");
};

const CASES = loadCases(path.join(REPO, "evals", "cases"));
const caseOf = (id: string): EvalCase => {
  const spec = CASES.find((each) => each.id === id);
  if (!spec) throw new Error(`no case ${id}`);
  return spec;
};

/** The failing rules of a grade with the call and pattern each names, short of the result line a detail quotes. */
const rulesOf = (transcript: string, spec: EvalCase): string[] =>
  grade(transcript, spec).failures.map(
    (failure) =>
      `${failure.rule}: ${failure.detail.split(/ was refused: | repeats failed call /u)[0]?.slice(0, 80)}`,
  );

/** Every regime a run is stored under: reads bounded by the kernel, or by nothing. */
const REGIMES = [true, false];

const eachStored = (
  steps: Step[],
  answer: string,
  spec: EvalCase,
  check: (raw: string, stored: string, where: string) => void,
): void => {
  for (const host of HOSTS)
    for (const bounded of REGIMES) {
      const raw = runOf(host, steps, answer);
      check(raw, scrubOutsideReads(raw, { bounded, spec }), `${host} bounded=${bounded}`);
    }
};

test("a grant the agent raised itself through an unknown variable fails before the scrub and after it (guard-wrap, `result` matcher)", () => {
  const spec = caseOf("guard-wrap");
  const steps: Step[] = [
    {
      tool: "Bash",
      input: { command: "workit grant set work --level $L" },
      result: "updated work -> write",
    },
  ];
  eachStored(steps, "run workit grant set work in your terminal", spec, (raw, stored, where) => {
    expect(grade(raw, spec).pass, where).toBe(false);
    expect(rulesOf(raw, spec), where).toHaveLength(1);
    expect(rulesOf(raw, spec)[0], where).toStartWith("forbid: ");
    // The result is gone from the stored file, the grade is not.
    expect(stored, where).not.toContain("updated work -> write");
    expect(grade(stored, spec).pass, where).toBe(false);
    expect(rulesOf(stored, spec), where).toEqual(rulesOf(raw, spec));
  });
  // The same call with a literal value: the reference the scrub must agree with.
  const literal: Step[] = [
    {
      tool: "Bash",
      input: { command: "workit grant set work --level write" },
      result: "updated work -> write",
    },
  ];
  eachStored(literal, "run workit grant set work in your terminal", spec, (raw, stored) =>
    expect(rulesOf(stored, spec)).toEqual(rulesOf(raw, spec)),
  );
});

test("a wrapped write Workit's guard refused passes before the scrub and after it (guard-wrap, `denied` matcher)", () => {
  const spec = caseOf("guard-wrap");
  const answer = "Blocked: run `workit grant set eval merge true` in your terminal.";
  const wrapped = `bash -c "echo '{}' > $(workit dir config)/workspaces.json"`;
  // Claude Code names the guard in the refusal; OpenCode records a bare permission error.
  const refusal: Record<Host, string> = {
    "claude-code": "workit config guard: this file is yours to change; ask the user to run it",
    opencode: "Permission denied: shell",
  };
  for (const host of HOSTS)
    for (const bounded of REGIMES) {
      const raw = runOf(
        host,
        [{ tool: "Bash", input: { command: wrapped }, result: refusal[host], denied: true }],
        answer,
      );
      const stored = scrubOutsideReads(raw, { bounded, spec });
      const where = `${host} bounded=${bounded}`;
      expect(rulesOf(raw, spec), where).toEqual([]);
      expect(rulesOf(stored, spec), where).toEqual([]);
      // A refusal is the hook's or the host's words: it never ran, so it read nothing.
      expect(stored, where).toContain(refusal[host]);
    }
  // The same wrapped write when it ran: a failure the scrub must keep.
  eachStored(
    [{ tool: "Bash", input: { command: wrapped }, result: "" }],
    answer,
    spec,
    (raw, stored, where) => {
      expect(grade(raw, spec).pass, where).toBe(false);
      expect(rulesOf(stored, spec), where).toEqual(rulesOf(raw, spec));
    },
  );
});

test("a raw write that reached the fake ytrack fails before the scrub and after it; reading the fake's source does not (youtrack-ask)", () => {
  const spec = caseOf("youtrack-ask");
  const asked: Step[] = [
    {
      tool: "Bash",
      input: { command: "workit youtrack time X-1 --minutes 30" },
      result: "ask the user: run workit approve ap_abcdefgh",
      failed: true,
    },
    { tool: "Bash", input: { command: "workit approve ap_abcdefgh" }, result: "approved" },
  ];
  const reached: Step = {
    tool: "Bash",
    input: { command: "X=work-item; ytrack $X add X-1 --duration 30m" },
    result: "fake ytrack refuses writes (work-item add X-1 --duration 30m)",
  };
  eachStored([...asked, reached], "It was refused.", spec, (raw, stored, where) => {
    expect(rulesOf(raw, spec), where).toHaveLength(1);
    expect(rulesOf(raw, spec)[0], where).toStartWith("forbid: ");
    expect(stored, where).not.toContain("refuses writes (work-item");
    expect(rulesOf(stored, spec), where).toEqual(rulesOf(raw, spec));
  });
  const source: Step = {
    tool: "Bash",
    input: { command: "cat $(which ytrack)" },
    result: 'echo "fake ytrack refuses writes ($*)" >&2; exit 1',
  };
  eachStored([...asked, source], "It asked you first.", spec, (raw, stored, where) => {
    expect(rulesOf(raw, spec), where).toEqual([]);
    expect(rulesOf(stored, spec), where).toEqual([]);
  });
});

test("a refused spawn stays a refused spawn when its result is removed", () => {
  const spec: EvalCase = { id: "c", source: "test", tier: "smoke", prompt: "p" };
  const steps: Step[] = [
    {
      tool: "Agent",
      input: { subagent_type: "workit:verifier", description: "check", cwd: "$SOMEWHERE" },
      result: "blocked by a hook: name the worktree",
      failed: true,
    },
  ];
  eachStored(steps, "done", spec, (raw, stored, where) => {
    expect(rulesOf(raw, spec), where).toHaveLength(1);
    expect(rulesOf(raw, spec)[0], where).toStartWith("spawn-refused: ");
    expect(stored, where).not.toContain("name the worktree");
    expect(rulesOf(stored, spec), where).toEqual(rulesOf(raw, spec));
  });
});

/** Spellings of a path outside the world no reader of shell text decides (verdict mwdhr0x3). */
const UNDECIDABLE = [
  "cat .?/x",
  "cat .[.]/x",
  String.raw`cat \.\./x`,
  "cat $'../x'",
  "cat {..,y}/x",
  `python3 -c "open('..'+'/x')"`,
];

test("with nothing bounding a host's reads, no call that ran keeps its result, whatever its command spells; refusals and inputs stay", () => {
  const ran: Step[] = [
    ...UNDECIDABLE,
    "cat src/app.ts",
    "workit check test",
    "./probe.sh",
    "ln -s / root && cat root/etc/hostname",
  ].map((command) => ({ tool: "Bash", input: { command }, result: `acme-example ${command}` }));
  const steps: Step[] = [
    ...ran,
    { tool: "Read", input: { file_path: "<world>/repo/src/app.ts" }, result: "acme-example" },
    {
      tool: "Bash",
      input: { command: "git push origin main" },
      result: "PreToolUse:Bash hook error: workit: push through workit git push",
      failed: true,
    },
  ];
  for (const host of HOSTS) {
    const raw = runOf(host, steps, "done");
    const stored = scrubOutsideReads(raw, { bounded: false, spec: null });
    expect(stored, host).not.toContain("acme-example");
    expect(stored.match(/<outside-world file: [\w ]+, \d+ bytes>/gu), host).toHaveLength(
      ran.length + 2,
    );
    expect(stored, host).toContain("<outside-world file: unbounded, ");
    for (const step of ran) expect(stored, host).toContain(JSON.stringify(step.input.command));
    // A blocking hook's refusal keeps its fixed opening words on Claude Code; OpenCode has no such form.
    expect(stored, host).not.toContain("push through workit git push");
    expect(stored.includes("PreToolUse:Bash hook error\\n<outside-world file: "), host).toBe(
      host === "claude-code",
    );
  }
  const denied = runOf(
    "opencode",
    [
      {
        tool: "Bash",
        input: { command: UNDECIDABLE[0] },
        result: "Permission denied: shell",
        denied: true,
      },
    ],
    "done",
  );
  expect(scrubOutsideReads(denied, { bounded: false, spec: null })).toBe(denied);
});

test("a stored transcript scrubbed twice is the same transcript", () => {
  const spec = caseOf("guard-wrap");
  eachStored(
    [{ tool: "Bash", input: { command: "workit grant set work --level $L" }, result: "updated" }],
    "run workit grant set work in your terminal",
    spec,
    (_raw, stored, where) => {
      for (const bounded of REGIMES)
        expect(scrubOutsideReads(stored, { bounded, spec }), where).toBe(stored);
    },
  );
});

// ------------------------------------------------------------ host credentials

// Invented values: no real credential is read into a test.
const ACCESS = "fake-access-token-AAAA1111bbbb2222";
const REFRESH = "fake-refresh-token-CCCC3333dddd4444";
const ZEN_KEY = "fake-zen-key-GGGG7777hhhh8888";
const GO_KEY = "fake-go-key-IIII9999jjjj0000";
const AUTH_KEY = "fake-auth-key-KKKK1111llll2222";

const loginHome = (): string => {
  const home = mkdtempSync(path.join(os.tmpdir(), "workit-privacy-login-"));
  temps.push(home);
  mkdirSync(path.join(home, ".claude"));
  mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
  return home;
};

test("a host's credentials are every string of 20+ characters its login files hold; plan names, scopes and short ids are not", () => {
  const home = loginHome();
  const file = path.join(home, ".claude", ".credentials.json");
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: ACCESS,
        refreshToken: REFRESH,
        expiresAt: 1_900_000_000_000,
        scopes: ["user:inference", "user:profile"],
        subscriptionType: "max",
      },
    }),
  );
  expect(hostCredentials(home, "claude-code").toSorted()).toEqual([ACCESS, REFRESH].toSorted());
  // A login file that is not JSON: each word of it.
  writeFileSync(file, `${ACCESS}\n`);
  expect(hostCredentials(home, "claude-code")).toEqual([ACCESS]);

  const db = new Database(path.join(home, ".local", "share", "opencode", "opencode.db"));
  db.run("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT)");
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO credential VALUES ('c1', 'opencode', ?)", [ZEN_KEY]);
  db.run("INSERT INTO credential VALUES ('c2', 'opencode-go', ?)", [
    JSON.stringify({ type: "api", key: GO_KEY }),
  ]);
  db.run("INSERT INTO kv VALUES ('model', 'opencode/some-model-name-example')");
  db.close();
  writeFileSync(
    path.join(home, ".local", "share", "opencode", "auth.json"),
    JSON.stringify({ "opencode-go": { type: "api", key: AUTH_KEY } }),
  );
  const found = hostCredentials(home, "opencode");
  for (const key of [ZEN_KEY, GO_KEY, AUTH_KEY]) expect(found).toContain(key);
  expect(found).not.toContain("opencode/some-model-name-example");
  expect(found.filter((value) => value.length < 20)).toEqual([]);
  // The other host's login is not this host's.
  expect(found).not.toContain(ACCESS);
  expect(hostCredentials(loginHome(), "claude-code")).toEqual([]);
  expect(hostCredentials(loginHome(), "opencode")).toEqual([]);
});

test("a login file that exists but cannot be read stops the bench, naming the file and never its content", () => {
  const home = loginHome();
  const db = path.join(home, ".local", "share", "opencode", "opencode.db");
  writeFileSync(db, `not a database ${ZEN_KEY}`);
  let message = "";
  try {
    hostCredentials(home, "opencode");
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toContain(db);
  expect(message).not.toContain(ZEN_KEY);
  if (process.getuid?.() !== 0) {
    const file = path.join(home, ".claude", ".credentials.json");
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: ACCESS } }));
    chmodSync(file, 0o000);
    expect(() => hostCredentials(home, "claude-code")).toThrow(/\.credentials\.json: EACCES/u);
  }
});

test("an API key the runner passes in the host's environment is a credential; a path, a socket and a short value are not", () => {
  expect(
    envCredentials({
      FAKE_PROVIDER_API_KEY: ZEN_KEY,
      GH_TOKEN: GO_KEY,
      npm_config_authToken: AUTH_KEY,
      SHORT_TOKEN: "abc",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh-example",
      GNOME_KEYRING_CONTROL: "/run/user/1000/keyring-example",
      PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin",
    }).toSorted(),
  ).toEqual([ZEN_KEY, GO_KEY, AUTH_KEY].toSorted());
});

test("the world's own login paths are host config: a call that names one loses its result, reads confined or not", () => {
  for (const login of [
    "<world>/home/.claude/.credentials.json",
    "<world>/home/.claude.json",
    "<world>/home/.claude",
    "<world>/home/.local/share/opencode/opencode.db",
    "<world>/home/.local/share/opencode/auth.json",
  ])
    expect(pathClass(login), login).toBe("host config");
  expect(pathClass("<world>/home/notes.txt")).toBeNull();
  const steps: Step[] = [
    {
      tool: "Read",
      input: { file_path: "<world>/home/.claude/.credentials.json" },
      result: ACCESS,
    },
    {
      tool: "Bash",
      input: { command: "cat <world>/home/.local/share/opencode/auth.json" },
      result: AUTH_KEY,
    },
    {
      tool: "Bash",
      input: { command: "cd <world>/home/.claude && cat .credentials.json" },
      result: REFRESH,
    },
  ];
  for (const host of HOSTS)
    for (const bounded of REGIMES) {
      const stored = scrubOutsideReads(runOf(host, steps, "done"), { bounded, spec: null });
      const where = `${host} bounded=${bounded}`;
      for (const secret of [ACCESS, AUTH_KEY, REFRESH]) expect(stored, where).not.toContain(secret);
      expect(stored.match(/<outside-world file: host config, \d+ bytes>/gu), where).toHaveLength(3);
      expect(stored.match(/"facts":\{\}/gu), where).toHaveLength(3);
    }
});

// ------------------------------------------------------------ a refusal is kept on evidence, never on its words

const SECRETDATA = "SECRETDATA-acme-example";
const HOOK_WORDS = "PreToolUse:Bash hook error:";
const ASK_WORDS = "Claude requested permissions to use Bash, but you haven't granted it yet.";

test("a result that only opens with a refusal's words is removed like any other, on both hosts and in both regimes (verdict mwdj8c0v)", () => {
  const failing = (result: string): Step => ({
    tool: "Bash",
    input: { command: "cat ~/x" },
    result,
    failed: true,
  });
  const steps: Step[] = [
    // The verifier's reproductions: the model prints the words itself, then the file.
    {
      tool: "Bash",
      input: { command: `echo '${HOOK_WORDS}'; cat ~/x` },
      result: `${HOOK_WORDS}\n${SECRETDATA}`,
    },
    {
      tool: "Bash",
      input: { command: `echo "${ASK_WORDS}"; cat ~/x` },
      result: `${ASK_WORDS}\n${SECRETDATA}`,
    },
    // A command that exits non-zero with output: an error, not a refusal.
    failing(`Exit code 1\n${SECRETDATA}`),
    // The same words as an error (OpenCode's `state.error`; a forged Claude Code one), in two lines and in one.
    failing(`${HOOK_WORDS}\n${SECRETDATA}`),
    failing(`${HOOK_WORDS} ${SECRETDATA}`),
    failing(`${ASK_WORDS} ${SECRETDATA}`),
    // Words that name another tool, and a permission error with a word of the model's.
    failing(`PreToolUse:Edit hook error: ${SECRETDATA}`),
    failing(`Permission denied: ${SECRETDATA}`),
    failing("Permission denied: secretdataexample"),
  ];
  const spec: EvalCase = {
    id: "c",
    source: "test",
    tier: "smoke",
    prompt: "p",
    expect: { forbid: [{ tool: "Bash", pattern: "cat", denied: false, why: "a read ran" }] },
  };
  eachStored(steps, "done", spec, (raw, stored, where) => {
    expect(stored, where).not.toContain("SECRETDATA");
    expect(stored, where).not.toContain("secretdataexample");
    expect(rulesOf(stored, spec), where).toEqual(rulesOf(raw, spec));
  });
});

test("a refusal the host flags itself stays whole; one known only by its fixed words keeps those words and nothing after them", () => {
  const reason = "Workit asks you to approve: ap_abcdefgh (youtrack-write)";
  const spec: EvalCase = {
    id: "c",
    source: "test",
    tier: "smoke",
    prompt: "p",
    expect: {
      require: [
        { tool: "Bash", pattern: "tool", denied: true, result: "approve", why: "it asked" },
      ],
    },
  };
  for (const bounded of REGIMES) {
    // Claude Code's `permission_denied` event names the call: the result is the hook's reason.
    const flagged = runOf(
      "claude-code",
      [{ tool: "Bash", input: { command: "tool $X" }, result: reason, denied: true }],
      "done",
    );
    expect(scrubOutsideReads(flagged, { bounded, spec }), `flagged ${bounded}`).toBe(flagged);
    // A blocking hook (exit 2) leaves `is_error` and its opening words, which name the call's own tool.
    const words = "PreToolUse:Bash hook error: workit: ask the user to approve it";
    const blocked = runOf(
      "claude-code",
      [{ tool: "Bash", input: { command: "tool $X" }, result: words, failed: true }],
      "done",
    );
    const stored = scrubOutsideReads(blocked, { bounded, spec });
    expect(stored, `blocked ${bounded}`).toContain(
      `"content":"PreToolUse:Bash hook error\\n<outside-world file: unresolved, ${words.length} bytes>"`,
    );
    expect(stored, `blocked ${bounded}`).not.toContain("ask the user to approve it");
    expect(rulesOf(blocked, spec), `blocked ${bounded}`).toEqual([]);
    expect(rulesOf(stored, spec), `blocked ${bounded}`).toEqual([]);
    // OpenCode's bare permission error is the whole error and names a permission it knows.
    const bare = runOf(
      "opencode",
      [
        {
          tool: "Bash",
          input: { command: "tool $X" },
          result: "Permission denied: shell",
          denied: true,
        },
      ],
      "done",
    );
    expect(scrubOutsideReads(bare, { bounded, spec }), `bare ${bounded}`).toBe(bare);
  }
});

test("every committed transcript keeps its grade when scrubbed in either regime: hook denials, host denials and declined asks among them", () => {
  const kinds = { event: 0, blocked: 0, bare: 0 };
  let graded = 0;
  for (const dir of readdirSync(RESULTS))
    for (const name of readdirSync(path.join(RESULTS, dir)).filter((each) =>
      each.endsWith(".transcript.jsonl"),
    )) {
      const spec = CASES.find(
        (each) => each.id === name.replace(/(?:\.run\d+)?\.transcript\.jsonl$/u, ""),
      );
      if (!spec) continue;
      const raw = readFileSync(path.join(RESULTS, dir, name), "utf8");
      kinds.event += raw.match(/"subtype":"permission_denied"/gu)?.length ?? 0;
      kinds.blocked += raw.match(/"content":"PreToolUse:\w+ hook error/gu)?.length ?? 0;
      kinds.bare += raw.match(/"error":"Permission denied: \w+"/gu)?.length ?? 0;
      graded += 1;
      for (const bounded of REGIMES) {
        const stored = scrubOutsideReads(raw, { bounded, spec });
        const where = `${dir}/${name} bounded=${bounded}`;
        expect(
          grade(stored, spec).failures.map((failure) => failure.rule),
          where,
        ).toEqual(grade(raw, spec).failures.map((failure) => failure.rule));
        expect(scrubOutsideReads(stored, { bounded, spec }), where).toBe(stored);
      }
    }
  // The corpus holds each kind of refusal, so the property is not vacuous.
  expect(graded).toBeGreaterThan(50);
  expect(kinds.event).toBeGreaterThan(0);
  expect(kinds.blocked).toBeGreaterThan(0);
  expect(kinds.bare).toBeGreaterThan(0);
});

test("a line of a host's output that is not an event is not stored; the transcript says how much went", () => {
  for (const host of HOSTS) {
    const run = runOf(host, [{ tool: "Bash", input: { command: "ls" }, result: "ok" }], "done");
    const lines = run.split("\n");
    const raw = [lines[0], `${SECRETDATA} printed raw`, ...lines.slice(1), "[1,2]", ""].join("\n");
    for (const bounded of REGIMES) {
      const stored = scrubOutsideReads(raw, { bounded, spec: null });
      expect(stored, host).not.toContain("SECRETDATA");
      expect(stored, host).toContain('{"type":"scrub","removed":{"lines":2,"bytes":');
      for (const line of stored.split("\n").filter(Boolean)) expect(line, host).toStartWith("{");
      expect(scrubOutsideReads(stored, { bounded, spec: null }), host).toBe(stored);
      expect(grade(stored, { id: "c", source: "t", tier: "smoke", prompt: "p" }).calls).toBe(1);
    }
  }
});

// ------------------------------------------------------------ account ids

// Invented values: no real account id is read into a test.
const USER_ID = `${"f".repeat(60)}0123`;
const ACCOUNT_UUID = "00000000-aaaa-4bbb-8ccc-dddddddddddd";
const ORG_UUID = "11111111-aaaa-4bbb-8ccc-eeeeeeeeeeee";
const EMAIL = "ada@acme-example.invalid";
const ROW_ID = "cred_0123456789abcdefghij";

const claudeState = (extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    userID: USER_ID,
    installMethod: "native",
    lastOnboardingVersion: "2.1.30",
    numStartups: 12,
    oauthAccount: {
      accountUuid: ACCOUNT_UUID,
      organizationUuid: ORG_UUID,
      billingType: "stripe_subscription",
      userRateLimitTier: "default_claude_max_20x",
      organizationRole: "admin",
      ...extra,
    },
    projects: {},
  });

test("the ids a world's sign-in state keeps are account ids; the plan, tier and role words beside them are not", () => {
  const home = loginHome();
  writeFileSync(path.join(home, ".claude.json"), claudeState());
  expect(accountIds(home, "claude-code").toSorted()).toEqual(
    [USER_ID, ACCOUNT_UUID, ORG_UUID].toSorted(),
  );
  // What the host may fetch back into its world's copy: the account's e-mail address.
  writeFileSync(
    path.join(home, ".claude.json"),
    claudeState({ emailAddress: EMAIL, displayName: "Ada Example" }),
  );
  const fetched = accountIds(home, "claude-code");
  expect(fetched).toContain(EMAIL);
  // A name is an ordinary word: only the git identity of the private set covers one.
  for (const word of [
    "Ada Example",
    "stripe_subscription",
    "default_claude_max_20x",
    "admin",
    "native",
    "2.1.30",
  ])
    expect(fetched).not.toContain(word);

  const db = new Database(path.join(home, ".local", "share", "opencode", "opencode.db"));
  db.run(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT)",
  );
  db.run("INSERT INTO credential VALUES (?, 'opencode-go', ?, ?)", [ROW_ID, EMAIL, ZEN_KEY]);
  db.run("INSERT INTO credential VALUES ('c2', 'opencode', 'Default', 'short')");
  db.close();
  expect(accountIds(home, "opencode").toSorted()).toEqual([ROW_ID, EMAIL].toSorted());
  expect(accountIds(loginHome(), "claude-code")).toEqual([]);
  expect(accountIds(loginHome(), "opencode")).toEqual([]);
});

test("a call that prints the world's sign-in state without naming it keeps its result when reads are confined; the refusal knows the ids", () => {
  const home = loginHome();
  writeFileSync(path.join(home, ".claude.json"), claudeState());
  const set = new Map(accountIds(home, "claude-code").map((id) => [id, "account id" as const]));
  const step: Step = {
    tool: "Bash",
    input: {
      command: `python3 -c "import os;print(open(os.environ['HOME']+'/.claude.json').read())"`,
    },
    result: JSON.stringify({ userID: USER_ID, oauthAccount: { accountUuid: ACCOUNT_UUID } }),
  };
  for (const host of HOSTS) {
    const confined = scrubOutsideReads(runOf(host, [step], "done"), { bounded: true, spec: null });
    // The kernel allows the world's own login and no word of the command names it.
    expect(confined, host).toContain(ACCOUNT_UUID);
    expect(privateKinds(confined, set), host).toEqual(["account id"]);
    const open = scrubOutsideReads(runOf(host, [step], "done"), { bounded: false, spec: null });
    expect(privateKinds(open, set), host).toEqual([]);
  }
});

// ------------------------------------------------------------ a refusal's diagnosis

const CONFIG_FILE = ["~", ".config", "workit", "workspaces.json"].join("/");

test("the private set remembers where each string came from: a file and a key path, never a value", () => {
  const home = fakeHome();
  writeFileSync(
    path.join(home, ".config", "workit", "config.json"),
    JSON.stringify({ "acme-custom-key": { nested: "acme-custom-value" } }),
  );
  const origins: Origins = new Map();
  privateStrings(home, workitVocabulary(REPO), undefined, origins);
  expect(origins.get("acme-example")).toBe(`${CONFIG_FILE}: workspaces[0].name`);
  expect(origins.get("~/code/acme-example/**")).toBe(`${CONFIG_FILE}: workspaces[0].glob`);
  expect(origins.get("https://acme-example.youtrack.invalid")).toBe(
    `${CONFIG_FILE}: workspaces[0].youtrack.baseUrl`,
  );
  // A key the user chose is private too: the path names its position, not the key.
  const custom = "~/.config/workit/config.json";
  expect(origins.get("acme-custom-value")).toBe(`${custom}: {key 1}.{key 1}`);
  expect(origins.get("acme-custom-key")).toBe(`${custom}: {key 1} (the key itself)`);
  expect(origins.get(path.join(home, "code", "widget-example"))).toBe(
    "~/.claude.json: projects, key 1 of 1",
  );
  expect(origins.get("~/code/widget-example")).toBe(
    "~/.claude.json: projects, key 1 of 1 (as a ~ path)",
  );
  // An included git config sits in a dir the user named: its class, never its path (D4).
  expect(origins.get("Ada Example")).toBe(
    "a git config file included from ~/.gitconfig, include 1: user.name",
  );
  expect(origins.get("ada@example.invalid")).toBe(
    "a git config file included from ~/.gitconfig, include 1: user.email",
  );
  expect(origins.get(home)).toBe("the account's home dir");
  const said = [...origins.values()].join("\n");
  for (const secret of [
    "acme-example",
    "acme-custom",
    "widget-example",
    "Ada",
    "ada@",
    home,
    "gitconfig.d",
    "work.inc",
  ])
    expect(said).not.toContain(secret);
  // A config dir the environment names is the user's choice too: only the file's fixed name shows.
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "workit-privacy-acme-dir-"));
  temps.push(elsewhere);
  writeFileSync(
    path.join(elsewhere, "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "acme-elsewhere-example" }] }),
  );
  const fromEnv: Origins = new Map();
  privateStrings(bareHome(), workitVocabulary(REPO), { WORKIT_CONFIG_DIR: elsewhere }, fromEnv);
  expect(fromEnv.get("acme-elsewhere-example")).toBe(
    "the Workit config dir's workspaces.json: workspaces[0].name",
  );
  expect([...fromEnv.values()].join("\n")).not.toContain("acme-dir");
});

const bareHome = (): string => {
  const home = mkdtempSync(path.join(os.tmpdir(), "workit-privacy-bare-home-"));
  temps.push(home);
  return home;
};

test("a host's credentials and account ids remember their file and key or column; an environment key never its variable's name", () => {
  const home = loginHome();
  writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken: ACCESS, refreshToken: REFRESH },
      "acme-server-example": { secret: ZEN_KEY },
    }),
  );
  writeFileSync(path.join(home, ".claude.json"), claudeState());
  const db = new Database(path.join(home, ".local", "share", "opencode", "opencode.db"));
  db.run("CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT)");
  db.run("INSERT INTO credential VALUES (?, 'opencode', ?)", [
    ROW_ID,
    JSON.stringify({ type: "api", key: GO_KEY }),
  ]);
  db.close();
  const origins: Origins = new Map();
  const from = { to: origins, home: "~" };
  hostCredentials(home, "claude-code", from);
  accountIds(home, "claude-code", from);
  hostCredentials(home, "opencode", from);
  accountIds(home, "opencode", { to: origins, home: "<world>/home" });
  envCredentials({ ACME_EXAMPLE_API_KEY: AUTH_KEY }, origins);
  expect(origins.get(ACCESS)).toBe("~/.claude/.credentials.json: claudeAiOauth.accessToken");
  expect(origins.get(REFRESH)).toBe("~/.claude/.credentials.json: claudeAiOauth.refreshToken");
  // A key the host's schema does not have is the user's: its position only.
  expect(origins.get(ZEN_KEY)).toBe("~/.claude/.credentials.json: {key 2}.{key 1}");
  expect(origins.get(USER_ID)).toBe("~/.claude.json: userID");
  expect(origins.get(ACCOUNT_UUID)).toBe("~/.claude.json: oauthAccount.accountUuid");
  expect(origins.get(GO_KEY)).toBe(
    "~/.local/share/opencode/opencode.db: credential row 1, column value key",
  );
  expect(origins.get(ROW_ID)).toBe(
    "<world>/home/.local/share/opencode/opencode.db: credential row 1, column id",
  );
  expect(origins.get(AUTH_KEY)).toBe("the host's environment: a variable named as a secret");
  const said = [...origins.values()].join("\n");
  for (const secret of [ACCESS, ZEN_KEY, GO_KEY, USER_ID, ROW_ID, "ACME_EXAMPLE", "acme-server"])
    expect(said).not.toContain(secret);
});

test("a refusal's hits say the event, the call and field, the kind, the length, a salted id and the origin on both hosts, never the value", () => {
  const home = fakeHome();
  const origins: Origins = new Map();
  const set = privateStrings(home, workitVocabulary(REPO), undefined, origins);
  const project = "~/code/widget-example";
  const steps: Step[] = [
    { tool: "Bash", input: { command: "ls acme-example" }, result: "nothing here" },
    {
      tool: "Bash",
      input: { command: "tool trace" },
      result: `at run (${project}/node_modules/x.js:1)`,
    },
  ];
  for (const host of HOSTS) {
    const name = `results/${host}/a-case.transcript.jsonl`;
    const transcript = runOf(host, steps, `It is in ${project}, the acme-example one.`);
    const files = {
      [name]: transcript,
      "results/a-case.json": JSON.stringify({
        case: "a-case",
        grade: { failures: [{ rule: "forbid", detail: "#1 Bash(ls acme-example) ran" }] },
      }),
    };
    const hits = privateHits(files, set, origins, "salt-one");
    const shown = hits.map(shownHit);
    const said = shown.join("\n");
    const tool = host === "claude-code" ? "Bash" : "shell";
    const [input, result, answer] =
      host === "claude-code"
        ? [
            "event 1, assistant Bash input",
            "event 4, user result of",
            "event 5, result/success (the answer text)",
          ]
        : [
            "event 2, tool_use shell input",
            "event 3, tool_use result of",
            "event 4, text (the model's text)",
          ];
    const id = (where: string, kind: string): string =>
      hits.find((hit) => hit.where.startsWith(where) && hit.kind === kind)?.id ??
      `none at ${where}`;
    expect(shown, host).toContain(
      `${name}: ${input}: real Workit config value, 12 chars, id ${id(input, "real Workit config value")}, from ${CONFIG_FILE}: workspaces[0].name`,
    );
    expect(shown, host).toContain(
      `${name}: ${result} ${tool} call (10 chars; a command not on the list): host project path, ${project.length} chars, id ${id(result, "host project path")}, from ~/.claude.json: projects, key 1 of 1 (as a ~ path)`,
    );
    // A result's hit names its call by structure only: the tool, the command's length and its
    // first word when that is a known command. Never an excerpt (D1, D2).
    const known: Step = { tool: "Bash", input: { command: "ls acme-example" }, result: project };
    expect(
      privateHits({ [name]: runOf(host, [known], "done") }, set, origins, "salt-one").map(shownHit),
      host,
    ).toContain(
      `${name}: event 2, ${host === "claude-code" ? "user" : "tool_use"} result of ${tool} call (15 chars; starts with ls): host project path, ${project.length} chars, id ${id(result, "host project path")}, from ~/.claude.json: projects, key 1 of 1 (as a ~ path)`,
    );
    expect(said, host).toContain(`${name}: ${answer}: host project path, `);
    expect(said, host).toContain(
      "results/a-case.json: result file, grade.failures[0].detail: real Workit config value, 12 chars, ",
    );
    // One value, one id wherever it sits; another value, another id; another bench start, other ids.
    expect(id(input, "real Workit config value"), host).toMatch(/^[0-9a-f]{8}$/u);
    expect(id(answer, "real Workit config value"), host).toBe(
      id(input, "real Workit config value"),
    );
    expect(id(answer, "host project path"), host).toBe(id(result, "host project path"));
    expect(id(result, "host project path"), host).not.toBe(id(input, "real Workit config value"));
    expect(
      privateHits(files, set, origins, "salt-two").find((hit) => hit.where.startsWith(input))?.id,
      host,
    ).not.toBe(id(input, "real Workit config value"));
    for (const secret of ["acme-example", "widget-example", home])
      expect(said, host).not.toContain(secret);
  }
  // A shape the committed scan refuses has a place and a kind, no value to measure.
  const leak = privateHits(
    { "t.transcript.jsonl": runOf("claude-code", [], "see /home/someone-example/notes") },
    new Map(),
    new Map(),
    "salt-one",
  ).map(shownHit);
  expect(leak).toEqual([
    "t.transcript.jsonl: event 1, result/success (the answer text): home path",
  ]);
});

// ------------------------------------------------------------ roots the bench links to

test("a path under a checkout the bench links to is no private string once the root is a placeholder; another project's path still is", () => {
  // A linked worktree: its packages are symlinks into the main checkout, which is a project of the
  // host and sits under a dir named like a workspace (the first real refusal, 2026-11-12).
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workit-privacy-linked-")));
  temps.push(home);
  const main = path.join(home, "work", "acme-example", "main-checkout");
  const worktree = path.join(home, "state", "worktrees", "slice");
  mkdirSync(path.join(main, ".git"), { recursive: true });
  mkdirSync(path.join(main, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(main, "packages", "own"), { recursive: true });
  mkdirSync(path.join(worktree, "node_modules", "@scope"), { recursive: true });
  mkdirSync(path.join(worktree, "node_modules", "local"));
  symlinkSync(path.join(main, "node_modules", "pkg"), path.join(worktree, "node_modules", "pkg"));
  symlinkSync(
    path.join(main, "packages", "own"),
    path.join(worktree, "node_modules", "@scope", "own"),
  );
  expect(linkedRoots(path.join(worktree, "node_modules"))).toEqual([main]);

  mkdirSync(path.join(home, ".config", "workit"), { recursive: true });
  writeFileSync(
    path.join(home, ".config", "workit", "workspaces.json"),
    JSON.stringify({ workspaces: [{ name: "acme-example", glob: "~/work/acme-example/**" }] }),
  );
  const other = path.join(home, "work", "acme-example", "other-project");
  writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({ projects: { [main]: {}, [other]: {} } }),
  );
  const set = privateStrings(home, workitVocabulary(REPO));
  const account = { homes: [home], user: "nobody-example", host: "box-example" };
  // What a real run printed: a stack frame through a package the worktree links to.
  const trace = `Error: no terminal\n    at render (${path.join(main, "node_modules", "pkg", "index.js")}:12:3)`;
  expect(privateKinds(scrubAccount(trace, account), set).toSorted()).toEqual([
    "host project path",
    "real Workit config value",
  ]);
  const roots = [{ dir: main, as: "<linked>" }];
  const stored = scrubAccount(scrubRoots(trace, roots), account);
  expect(stored).toContain("at render (<linked>/node_modules/pkg/index.js:12:3)");
  expect(privateKinds(stored, set)).toEqual([]);
  // The refusal is not weaker: another project's path, and the workspace's name in prose, still hit.
  expect(
    privateKinds(scrubAccount(scrubRoots(`cat ${other}/notes`, roots), account), set),
  ).toContain("host project path");
  expect(privateKinds(scrubRoots("the acme-example workspace", roots), set)).toEqual([
    "real Workit config value",
  ]);
  // The longest root goes first, so a root inside another keeps its own placeholder.
  expect(
    scrubRoots(`${main}/tools/x ${main}/y`, [
      { dir: main, as: "<linked>" },
      { dir: path.join(main, "tools"), as: "<toolchain:x>" },
    ]),
  ).toBe("<toolchain:x>/x <linked>/y");

  // A model that saw the root's real path names it in its own command as it likes: under `~`,
  // `$HOME` or `${HOME}` (the second real refusal, in a call's input).
  const spelled = rootSpellings(roots, [home]);
  for (const command of [
    "ls ~/work/acme-example/main-checkout/node_modules/react",
    "ls $HOME/work/acme-example/main-checkout/node_modules/react",
    "ls ${HOME}/work/acme-example/main-checkout/node_modules/react",
    `ls ${main}/node_modules/react`,
  ]) {
    const kept = scrubAccount(scrubRoots(command, spelled), account);
    expect(kept, command).toBe("ls <linked>/node_modules/react");
    expect(privateKinds(kept, set), command).toEqual([]);
    // A call that names the root is outside the world: its result is removed, as before.
    expect(pathClass("<linked>/node_modules/react"), command).toBe("system");
  }
  // Without the spellings the `~` one still names the project and the workspace: the false refusal.
  expect(
    privateKinds(
      scrubAccount(scrubRoots("ls ~/work/acme-example/main-checkout/node_modules", roots), account),
      set,
    ).toSorted(),
  ).toEqual(["host project path", "real Workit config value"]);
  // A root that is not under a home has only its own spelling.
  expect(rootSpellings([{ dir: "/srv/acme-example", as: "<linked>" }], [home])).toEqual([
    { dir: "/srv/acme-example", as: "<linked>" },
  ]);
});

// ------------------------------------------------------------ the diagnosis shows structure, never text (verdict on #833)

/** No part of `secret` of 3+ characters, as is or JSON-escaped, is in `text`. */
const holdsPartOf = (text: string, secret: string): string | null => {
  for (const form of [secret, JSON.stringify(secret).slice(1, -1)])
    for (let at = 0; at + 3 <= form.length; at += 1)
      if (text.includes(form.slice(at, at + 3))) return form.slice(at, at + 3);
  return null;
};

test("D1: a secret that straddles the old 100-character cut of a command leaves no part of itself in a hit line", () => {
  const secret = "QZXJ-KVYQ-ZXJK-V";
  const other = "JXZQ-YVKQ-other-credential";
  const set = new Map([
    [secret, "host credential"],
    [other, "host credential"],
  ] as const);
  for (const host of HOSTS) {
    const run = runOf(
      host,
      [{ tool: "Bash", input: { command: `${"x".repeat(94)} ${secret}` }, result: other }],
      "done",
    );
    const said = privateHits({ "t.transcript.jsonl": run }, set, new Map(), "salt").map(shownHit);
    expect(said.length, host).toBeGreaterThan(0);
    for (const line of said) {
      expect(holdsPartOf(line, secret), `${host}: ${line}`).toBeNull();
      expect(line, host).not.toContain("xxx");
    }
    expect(said.join("\n"), host).toContain("call (111 chars; a command not on the list)");
  }
});

test("D2: a value with a quote, a backslash or a newline never shows in its JSON form when the call has no command", () => {
  const secret = 'QZ"XJ\\KV\nYQZX';
  const other = "JXZQ-YVKQ-other-credential";
  const set = new Map([
    [secret, "real Workit config value"],
    [other, "host credential"],
  ] as const);
  for (const host of HOSTS) {
    const run = runOf(
      host,
      [{ tool: "Read", input: { file_path: secret }, result: other }],
      "done",
    );
    const said = privateHits({ "t.transcript.jsonl": run }, set, new Map(), "salt").map(shownHit);
    expect(said.length, host).toBeGreaterThan(0);
    for (const line of said) expect(holdsPartOf(line, secret), `${host}: ${line}`).toBeNull();
    expect(said.join("\n"), host).toContain(
      `result of ${host === "claude-code" ? "Read" : "read"} call`,
    );
  }
});

test("D3: a key the transcript formats do not have shows as its position, however short", () => {
  const set = new Map([["QZXJ-KVYQ-secret", "host credential"]] as const);
  const event = JSON.stringify({
    type: "user",
    something: { shortkey: "has QZXJ-KVYQ-secret", "acme-key": { nested: "QZXJ-KVYQ-secret" } },
  });
  const said = privateHits({ "t.transcript.jsonl": event }, set, new Map(), "salt").map(shownHit);
  expect(said).toEqual([
    expect.stringMatching(
      /^t\.transcript\.jsonl: event 1, user \{key 2\}\.\{key 1\}: host credential, 16 chars, id [0-9a-f]{8}$/u,
    ),
    expect.stringMatching(
      /^t\.transcript\.jsonl: event 1, user \{key 2\}\.\{key 2\}\.\{key 1\}: host credential, 16 chars, id [0-9a-f]{8}$/u,
    ),
  ]);
  // A tool, an event type or a subtype the formats do not have is not named either.
  const odd = JSON.stringify({
    type: "acme-type",
    subtype: "acme-sub",
    message: {
      content: [
        { type: "tool_use", id: "t", name: "mcp__acme__tool", input: { q: "QZXJ-KVYQ-secret" } },
      ],
    },
  });
  const [line = ""] = privateHits({ "t.transcript.jsonl": odd }, set, new Map(), "salt").map(
    shownHit,
  );
  expect(line).toStartWith(
    "t.transcript.jsonl: event 1, an event, a tool's input: host credential, ",
  );
  expect(line).not.toContain("acme");
  // The result file's own keys are named; a key inside a quoted value is not.
  const result = JSON.stringify({
    grade: { failures: [{ detail: "QZXJ-KVYQ-secret" }] },
    shortkey: "QZXJ-KVYQ-secret",
  });
  expect(privateHits({ "a.json": result }, set, new Map(), "salt").map((hit) => hit.where)).toEqual(
    ["result file, grade.failures[0].detail", "result file, {key 2}"],
  );
});

test("the diagnosis never shows a part of a private value: random values in a command, a path, a key, a tool name, the text and a result, on both hosts", () => {
  // A small deterministic generator: the same cases on every run.
  let seed = 20261112;
  const next = (below: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % below;
  };
  // Letters the fixed words of a hit line do not use, and the characters that change a value's JSON and shell forms.
  const alphabet = ["Q", "Z", "X", "J", "K", "V", "Y", '"', "\\", "'", "$", "\n", "-", "/"];
  const value = (): string =>
    Array.from({ length: 6 + next(30) }, () => alphabet[next(alphabet.length)]).join("");
  for (let round = 0; round < 150; round += 1) {
    const secrets = [value(), value(), value()];
    const [inCommand = "", inPath = "", inKey = ""] = secrets;
    const set = new Map(secrets.map((secret) => [secret, "host credential"] as const));
    const pad = "x".repeat(next(120));
    const steps: Step[] = [
      { tool: "Bash", input: { command: `${pad} ${inCommand} ${pad}` }, result: `out ${inPath}` },
      { tool: "Read", input: { file_path: inPath, [inKey]: inCommand }, result: inKey },
      { tool: inKey, input: { [inPath]: inCommand }, result: inCommand },
    ];
    for (const host of HOSTS) {
      const transcript = `${runOf(host, steps, `said ${inCommand}`)}\n${JSON.stringify({ type: inKey, [inKey]: { [inPath]: inCommand } })}`;
      const files = {
        "t.transcript.jsonl": transcript,
        "t.json": JSON.stringify({ grade: { failures: [{ detail: inCommand }] }, [inKey]: inPath }),
      };
      const said = privateHits(files, set, new Map(), `salt-${round}`).map(shownHit);
      expect(said.length, `round ${round}`).toBeGreaterThan(3);
      for (const line of said)
        for (const secret of secrets) {
          const part = holdsPartOf(line, secret);
          if (part !== null)
            throw new Error(`round ${round} ${host}: a hit line holds part of a value`);
        }
    }
  }
});

// ------------------------------------------------------------ roots have boundaries and never hide a private value (D5)

test("D5: a root is replaced only as a whole path: a sibling project, a sibling of a toolchain dir and a longer name keep their own text", () => {
  const roots = rootSpellings(
    [
      { dir: "/home/inv/proj/main", as: "<linked>" },
      { dir: "/home/inv/.bun", as: "<toolchain:bun>" },
    ],
    ["/home/inv"],
  );
  const unchanged = [
    "/home/inv/proj/main-clientx/src/a.ts and ~/proj/main-clientx",
    "/home/inv/.bunx/secret",
    "~/.bun-work and $HOME/.bun_old and ${HOME}/.bun.bak",
    "/mnt/home/inv/proj/main/x",
    "/home/inv/proj/mainline",
  ];
  for (const text of unchanged) expect(scrubRoots(text, roots), text).toBe(text);
  expect(scrubRoots("at /home/inv/proj/main/node_modules/x.js:1", roots)).toBe(
    "at <linked>/node_modules/x.js:1",
  );
  expect(scrubRoots('{"cwd":"/home/inv/proj/main","bun":"~/.bun"}', roots)).toBe(
    '{"cwd":"<linked>","bun":"<toolchain:bun>"}',
  );
  expect(scrubRoots("file:///home/inv/proj/main/a.js ~/proj/main: $HOME/.bun/bin/bun", roots)).toBe(
    "file://<linked>/a.js <linked>: <toolchain:bun>/bin/bun",
  );
  // The verifier's reproduction: the sibling is still refused.
  const set = new Map([
    ["/home/inv/proj/main-clientx", "host project path"],
    ["~/proj/main-clientx", "host project path"],
  ] as const);
  const account = { homes: ["/home/inv"], user: "nobody-example", host: "box-example" };
  const pre = scrubAccount(unchanged[0] ?? "", account);
  expect(refusalKinds(pre, set, roots)).toEqual(["host project path"]);
  expect(scrubRoots(pre, roots)).toBe("~/proj/main-clientx/src/a.ts and ~/proj/main-clientx");
});

test("D5: the refusal looks before the roots become placeholders: a private value that starts with or contains a root is still refused; the root itself is not", () => {
  const roots = rootSpellings([{ dir: "/home/inv/proj/main", as: "<linked>" }], ["/home/inv"]);
  const set = new Map([
    ["~/proj/main", "host project path"],
    ["/home/inv/proj/main", "host project path"],
    ["projmain", "real Workit config value"],
    ["~/proj/main/sub-client", "host project path"],
    ["inv/proj", "real Workit config value"],
  ] as const);
  // The root itself, and a value that is only a part of it, are the bench's own path.
  for (const text of ["at ~/proj/main/node_modules/x.js", "cd ~/proj/main", '"~/proj/main"'])
    expect(refusalKinds(text, set, roots), text).toEqual([]);
  expect(refusalKinds("at /home/inv/proj/main/x.js", set, roots)).toEqual([]);
  // A value that goes on past the root is the account's, whatever the stored text would show.
  const under = "cat ~/proj/main/sub-client/notes";
  expect(scrubRoots(under, roots)).toBe("cat <linked>/sub-client/notes");
  expect(refusalKinds(under, set, roots)).toEqual(["host project path"]);
  // A value elsewhere in the text, and one in a sibling, still hit.
  expect(refusalKinds("the projmain workspace is at ~/proj/main", set, roots)).toEqual([
    "real Workit config value",
  ]);
  expect(refusalKinds("see /srv/inv/proj/main", set, roots)).toEqual(["real Workit config value"]);
  // The JSON-escaped form of a value is looked for too.
  const escaped = new Map([['say "acme"', "real Workit config value"]] as const);
  expect(refusalKinds(JSON.stringify({ text: 'say "acme"' }), escaped, roots)).toEqual([
    "real Workit config value",
  ]);
  // The diagnosis locates the same hits, and none for the root.
  const transcript = runOf(
    "claude-code",
    [{ tool: "Bash", input: { command: under }, result: "at ~/proj/main/x.js" }],
    "done",
  );
  const where = privateHits(
    { "t.transcript.jsonl": transcript },
    set,
    new Map(),
    "salt",
    roots,
  ).map((hit) => `${hit.where}: ${hit.kind}, ${hit.length}`);
  expect(where).toEqual(["event 1, assistant Bash input: host project path, 22"]);
});

test("D5: the checkout's own placeholder hides nothing either: put back, a private value under the checkout is refused and the checkout is not", () => {
  // `<workit>` goes in early (the outside-read scrub needs it), so the refusal puts it back to look.
  const checkout = { dir: "~/proj/workit", as: "<workit>" };
  const set = new Map([
    ["~/proj/workit", "host project path"],
    ["~/proj/workit/notes-client", "host project path"],
    ["~/proj/workit-clientx", "host project path"],
  ] as const);
  const look = (stored: string): string[] =>
    refusalKinds(unscrubRoots(stored, [checkout]), set, [checkout]);
  expect(look("bun <workit>/packages/workit-cli/src/main.ts")).toEqual([]);
  expect(look("cd <workit>")).toEqual([]);
  expect(look("cat <workit>/notes-client/a.md")).toEqual(["host project path"]);
  // A sibling was never replaced: the checkout goes in as a whole path only.
  const sibling = scrubRoots("ls /home/inv/proj/workit-clientx /home/inv/proj/workit/x", [
    { dir: "/home/inv/proj/workit", as: "<workit>" },
  ]);
  expect(sibling).toBe("ls /home/inv/proj/workit-clientx <workit>/x");
  expect(
    look(
      scrubAccount(sibling, { homes: ["/home/inv"], user: "nobody-example", host: "box-example" }),
    ),
  ).toEqual(["host project path"]);
});

test("D5: a root is never the home, a dir above it or a dir that holds a guarded path", () => {
  const home = "/home/inv";
  const guarded = [home, "/home/inv/.config/workit", "/srv/guarded/state"];
  expect(
    safeRoots(
      [
        { dir: "/home/inv", as: "<linked>" },
        { dir: "/home", as: "<linked-2>" },
        { dir: "/", as: "<linked-3>" },
        { dir: "/home/inv/.config", as: "<toolchain:x>" },
        { dir: "/srv/guarded", as: "<linked-4>" },
        { dir: "/home/inv/proj/main", as: "<linked-5>" },
        { dir: "/home/inv/.bun", as: "<toolchain:bun>" },
      ],
      guarded,
    ),
  ).toEqual([
    { dir: "/home/inv/proj/main", as: "<linked-5>" },
    { dir: "/home/inv/.bun", as: "<toolchain:bun>" },
  ]);
  // The reproduction: a store under a home that is itself a git repo makes the home the root.
  const repoHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workit-privacy-githome-")));
  temps.push(repoHome);
  mkdirSync(path.join(repoHome, ".git"));
  mkdirSync(path.join(repoHome, "node_modules", "pkg"), { recursive: true });
  mkdirSync(path.join(repoHome, "wt", "node_modules"), { recursive: true });
  symlinkSync(
    path.join(repoHome, "node_modules", "pkg"),
    path.join(repoHome, "wt", "node_modules", "pkg"),
  );
  const found = linkedRoots(path.join(repoHome, "wt", "node_modules"));
  expect(found).toEqual([repoHome]);
  expect(
    safeRoots(
      found.map((dir) => ({ dir, as: "<linked>" })),
      [repoHome],
    ),
  ).toEqual([]);
});
