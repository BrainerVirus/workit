// Bench privacy (scripts/eval/privacy.ts): evals/results is committed to a
// public repo, so no result file may carry an account's home path, a host's
// projects map or a real Workit config; the runner scrubs a transcript and
// refuses a file that still holds a private string. Every fixture here is
// invented, and the "real" home is a temp dir.
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  committedLeaks,
  pathClass,
  privateKinds,
  privateStrings,
  scrubAccount,
  scrubOutsideReads,
  workitVocabulary,
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
    claudeResult("d1", "PreToolUse:Edit hook error: workit config guard: ask the user"),
  ].join("\n");
  const lines = scrubOutsideReads(transcript)
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
  expect(result(9)).toStartWith("PreToolUse:Edit hook error");
  expect(lines.map((line) => JSON.stringify(line)).join("\n")).not.toContain("acme-example");
});

const opencodeTool = (tool: string, state: Record<string, unknown>): string =>
  JSON.stringify({ type: "tool_use", sessionID: "ses_1", part: { id: `p-${tool}`, tool, state } });

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
  const states = scrubOutsideReads(transcript)
    .split("\n")
    .map((line) => JSON.parse(line).part.state);
  expect(states[0]).toEqual({
    status: "completed",
    input: { filePath: "~/.config/workit/workspaces.json" },
    output: `<outside-world file: real config, ${Buffer.byteLength(SECRET)} bytes>`,
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
