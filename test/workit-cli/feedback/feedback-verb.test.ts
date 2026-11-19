import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { forgeDeps } from "@/packages/workit-cli/src/verbs/forge-common";
import { redactDraft } from "@/packages/workit-cli/src/verbs/feedback";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";
import { replayRunner, replyError, type Reply } from "@/test/shared/helpers/forge-replay";

// `workit feedback` (#777) in a temp "work" checkout, over a fake forge: no
// real forge, gh login or Workit config is reached.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
const original = { ...forgeDeps };
const roots: string[] = [];
beforeAll(() => {
  configHome = useConfigHome("wk-feedback-config-");
});
afterAll(() => configHome.restore());
afterEach(() => {
  Object.assign(forgeDeps, original);
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
};

/** A work checkout: a private org/repo remote and a ticket branch. */
const workRepo = (): string => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-feedback-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", "git@github.com:acme-corp/billing-api.git");
  git(root, "switch", "-q", "-c", "feature/BILL-482-retry");
  return root;
};

const workspaces = (root: string, entry: Record<string, unknown> = {}, top = {}) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      ...top,
      workspaces: [{ name: "acmework", glob: `${root.replaceAll("\\", "/")}/**`, ...entry }],
    }),
  );

const DUPLICATE = JSON.stringify({
  items: [
    {
      number: 321,
      title: "pr status fails outside a checkout",
      html_url: "https://github.com/BrainerVirus/workit/issues/321",
    },
  ],
});

const fake = (routes: Record<string, Reply>, stdin: string) => {
  const runner = replayRunner(routes);
  Object.assign(forgeDeps, { runner, readStdin: () => stdin, now: () => Date.UTC(2026, 10, 19) });
  return runner;
};

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, PWD: cwd, CLAUDECODE: "1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, json: () => JSON.parse(stdout) };
};

const REPRO =
  "`workit pr status` in /home/dev/src/billing-api on feature/BILL-482-retry printed: see https://git.acme-corp.internal/acme-corp/billing-api/-/merge_requests/9\n";

test('Given a failing verb in a work workspace, When `workit feedback "t" --body-file -` runs, Then a redacted draft with version and exit text is printed, a matching open issue is suggested, and nothing is posted', async () => {
  const root = workRepo();
  workspaces(root);
  writeFileSync(
    path.join(root, "exit.txt"),
    "workit: pr status: blocked: acme-corp/billing-api has no PR for feature/BILL-482-retry\n",
  );
  const runner = fake({ "GET search/issues": DUPLICATE }, REPRO);
  const result = await run(
    [
      "feedback",
      "pr status fails outside a checkout",
      "--body-file",
      "-",
      "--verb",
      "workit pr status",
      "--exit-file",
      "exit.txt",
      "--json",
    ],
    root,
  );
  expect(result.code).toBe(0);
  const data = result.json().data;
  const pkg = JSON.parse(
    readFileSync(path.join(import.meta.dir, "../../../packages/workit-cli/package.json"), "utf8"),
  );
  expect(data.repo).toBe("BrainerVirus/workit");
  expect(data.body).toContain(`- Workit: ${pkg.version}`);
  expect(data.body).toContain("- Host: claude-code");
  expect(data.body).toContain("- Verb: `workit pr status`");
  expect(data.body).toContain("workit: pr status: blocked: <name>/<name> has no PR for <branch>");
  for (const leak of ["acme-corp", "billing-api", "BILL-482", "/home/dev", "acmework", "git.acme"])
    expect(data.body).not.toContain(leak);
  expect(data.duplicates).toEqual([
    {
      number: 321,
      title: "pr status fails outside a checkout",
      url: "https://github.com/BrainerVirus/workit/issues/321",
    },
  ]);
  expect(data.posted).toBeNull();
  expect(runner.calls.map((call) => `${call.method} ${call.endpoint}`)).toEqual([
    "GET search/issues",
  ]);
  expect(runner.calls[0].vars.q).toStartWith("repo:BrainerVirus/workit is:issue is:open ");
});

test("Given the user declines (no --post), Then the draft is saved under `workit dir retros` and the path printed", async () => {
  const root = workRepo();
  workspaces(root);
  fake({ "GET search/issues": JSON.stringify({ items: [] }) }, REPRO);
  const result = await run(["feedback", "hook blocks a read", "--body-file", "-"], root);
  expect(result.code).toBe(0);
  const retros = path.join(root, ".git", "workit", "retros");
  const [file] = readdirSync(retros);
  expect(file).toMatch(/^feedback-20261119T000000-hook-blocks-a-read\.md$/u);
  const saved = path.join(retros, file);
  expect(result.stdout).toContain(`draft saved: ${saved}`);
  expect(result.stdout).toContain("nothing posted");
  // #916: redaction is pattern-based, so the header says the user reads the draft first.
  expect(result.stdout.split("\n")[1]).toStartWith("The user reads this whole draft before --post");
  expect(readFileSync(saved, "utf8")).toContain("<!-- workit feedback -->");
  expect(readFileSync(saved, "utf8")).not.toContain("billing-api");
});

test("Given --post without a configured feedback account and only a work account logged in, Then it refuses with the retry line and posts nothing", async () => {
  const root = workRepo();
  workspaces(root, { vcs: { provider: "github", account: "acme-dev" } });
  const runner = fake({ "GET search/issues": JSON.stringify({ items: [] }) }, REPRO);
  const result = await run(["feedback", "t", "--body-file", "-", "--post"], root);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toMatch(
    /Retry as: workit feedback "t" --body-file "[^"]+" --post --account <login>/u,
  );
  expect(runner.calls.filter((call) => call.method !== "GET")).toEqual([]);
  expect(runner.calls.some((call) => call.endpoint.includes("acme-dev"))).toBe(false);
});

test("Given feedback.account in workspaces.json, When --post runs, Then the issue is created with that login's token, which never reaches the output", async () => {
  const root = workRepo();
  workspaces(root, {}, { feedback: { account: "me-personal" } });
  const runner = fake(
    {
      "CLI auth token --hostname github.com --user me-personal":
        "gho_personaltoken000000000000000000\n",
      "GET search/issues": JSON.stringify({ items: [] }),
      "POST repos/BrainerVirus/workit/issues": JSON.stringify({
        number: 990,
        html_url: "https://github.com/BrainerVirus/workit/issues/990",
      }),
    },
    REPRO,
  );
  const result = await run(["feedback", "t", "--body-file", "-", "--post"], root);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("posted issue #990");
  const post = runner.calls.find((call) => call.method === "POST");
  expect(post?.token).toBe("gho_personaltoken000000000000000000");
  expect(post?.vars.body).not.toContain("billing-api");
  expect(result.stdout + result.stderr).not.toContain("gho_personal");
  expect(existsSync(path.join(root, ".git", "workit", "retros"))).toBe(false);
});

test("Given --comment <n> and an account without a gh login, Then it refuses naming gh auth login and posts nothing", async () => {
  const root = workRepo();
  workspaces(root);
  const runner = fake(
    {
      "CLI auth token --hostname github.com --user me": replyError("no oauth token found"),
      "GET search/issues": DUPLICATE,
    },
    REPRO,
  );
  const result = await run(
    ["feedback", "t", "--body-file", "-", "--post", "--account", "me", "--comment", "321"],
    root,
  );
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("gh auth login --hostname github.com as me");
  expect(result.stderr).toContain("--account me --comment 321");
  expect(runner.calls.filter((call) => call.method === "POST")).toEqual([]);
});

test('Given `feedback: "off"` on the workspace, Then the verb refuses before reading anything', async () => {
  const root = workRepo();
  workspaces(root, { feedback: "off" });
  const runner = fake({}, REPRO);
  const result = await run(["feedback", "t", "--body-file", "-"], root);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("workit feedback is off for workspace acmework");
  expect(runner.calls).toEqual([]);
});

test("Given workspace text, When --include-workspace is not passed, Then secrets are masked either way and only the opt-in keeps names and paths", () => {
  const facts = {
    names: ["acme-corp", "billing-api"],
    branch: "feature/BILL-482-retry",
    home: "/home/dev",
  };
  const text =
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 at /home/dev/src/billing-api, UTF-8 ok, see https://github.com/BrainerVirus/workit/issues/1";
  const redacted = redactDraft(text, facts, "BrainerVirus/workit");
  expect(redacted).not.toContain("ghp_");
  expect(redacted).toContain("<path>");
  expect(redacted).toContain("UTF-8");
  expect(redacted).toContain("https://github.com/BrainerVirus/workit/issues/1");
  const kept = redactDraft(text, facts, "BrainerVirus/workit", true);
  expect(kept).not.toContain("ghp_");
  expect(kept).toContain("/home/dev/src/billing-api");
});

// Review mwnr0zos: every spelling that names the workspace goes by default.
const FACTS = { names: [], branch: null, home: "/home/dev" };
const redact = (text: string, include = false) =>
  redactDraft(text, FACTS, "BrainerVirus/workit", include);

test.each([
  ["https://oauth2:SECRET@gitlab.corp.local/team/proj.git", "<url>"],
  ["ssh://git@gitlab.corp.local:2222/team/proj.git", "<url>"],
  ["postgres://u:p@db.internal:5432/x", "<url>"],
  ["git@gitlab.corp.local:team/proj.git", "<url>"],
  ["github.com/acme-corp/billing-api", "<url>"],
  ["https://github.com/BrainerVirus/workit-private/issues/2", "<url>"],
  ["acme.youtrack.cloud", "<host>"],
  ["gitlab.corp.local", "<host>"],
  ["db.internal.corp:5432", "<host>"],
  ["10.0.12.7", "<host>"],
  ["10.0.12.7:8080", "<host>"],
  ["[fe80::1ff:fe23:4567:890a]:443", "<host>"],
  ["2001:db8:85a3:0:0:8a2e:370:7334", "<host>"],
  ["dev@acme-corp.com", "<email>"],
  ["app-123", "<ticket>"],
  ["BILL-482", "<ticket>"],
  ["src/billing/invoice.ts", "<path>"],
  ["./scripts/run", "<path>"],
  [String.raw`\\fileserver\share\team\notes.txt`, "<path>"],
  [String.raw`C:\Users\dev\My Projects\app\x.ts`, "<path>"],
  ["/home/dev/My Projects/app/x.ts", "<path>"],
  ['"/srv/My Data/app"', '"<path>"'],
])(
  "Given `%s` in a draft, Then it reads %s by default and stays with --include-workspace",
  (text, expected) => {
    const out = redact(`see ${text} now`);
    expect(out).toBe(`see ${expected} now`);
    // A URL's userinfo is a credential: masked even with the opt-in.
    if (!/:\/\/[^/]*@/u.test(text)) expect(redact(text, true)).toBe(text);
  },
);

test("Given a URL with a credential, Then no part of it survives, with or without the opt-in's secret masking", () => {
  const text = "clone https://oauth2:SECRET@gitlab.corp.local/team/proj.git failed";
  expect(redact(text)).toBe("clone <url> failed");
  expect(redact(text, true)).not.toContain("SECRET");
});

test("Given the tracker's own URLs and ordinary prose, Then they stay", () => {
  for (const text of [
    "see https://github.com/BrainerVirus/workit/issues/777.",
    "github.com/BrainerVirus/workit#readme",
    "Workit 2.18.1 on linux, UTF-8 output, SHA-256 hash, README.md and node.js, e.g. and/or 12:30:45",
    "workit pr status failed: exit 1",
  ])
    expect(redact(text)).toBe(text);
});

test.skipIf(process.platform === "win32")(
  "Given GH_TOKEN for a work account in the env, When --post reads the feedback account's token, Then gh runs without it and the post carries the account's own token",
  async () => {
    const root = workRepo();
    workspaces(root, {}, { feedback: { account: "me-personal" } });
    const bin = path.join(root, "fake-bin");
    const posted = path.join(root, "posted-token");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        `  "auth token") printf '%s\\n' "\${GH_TOKEN:-personal-token}" ;;`,
        `  "api -X") if [ "$3" = GET ]; then echo '{"items":[]}'; else printf '%s' "$GH_TOKEN" > "${posted}"; echo '{"number":7}'; fi ;;`,
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );
    Object.assign(forgeDeps, { runner: undefined, readStdin: () => REPRO });
    let stdout = "";
    const code = await main(["feedback", "t", "--body-file", "-", "--post"], {
      cwd: root,
      env: {
        ...process.env,
        PWD: root,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        GH_TOKEN: "work-token",
        GITHUB_TOKEN: "work-token",
      },
      stdout: (text) => void (stdout += text),
      stderr: () => {},
    });
    expect(code).toBe(0);
    expect(stdout).toContain("posted issue #7");
    expect(readFileSync(posted, "utf8")).toBe("personal-token");
  },
);

// #916: what the first review of `workit feedback` left open.
test("Given a secret in a kept tracker URL's query or fragment, Then the draft masks it and keeps the URL", () => {
  const out = redact(
    "see https://github.com/BrainerVirus/workit/issues/1?access_token=SECRET1234567890abcdef and github.com/BrainerVirus/workit#ghp_0123456789abcdefghijklmnopqrstuvwxyz",
  );
  expect(out).not.toContain("SECRET1234567890abcdef");
  expect(out).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  expect(out).toContain("https://github.com/BrainerVirus/workit/issues/1?");
  expect(out).toContain("github.com/BrainerVirus/workit#");
});

test("Given Workit's own paths and well-known dotted names, Then they stay while workspace paths go", () => {
  for (const text of [
    "packages/workit-cli/src/verbs/feedback.ts",
    "@workit-dev/cli/src/verbs/feedback.ts",
    "node_modules/@workit-dev/core/src/forge/redact.ts",
    "socket.io",
    "registry.npmjs.org",
  ])
    expect(redact(`at ${text} now`)).toBe(`at ${text} now`);
  expect(redact("at packages/billing/src/x.ts now")).toBe("at <path> now");
});

test("Given input holding the private-use placeholder, Then it never comes back as undefined", () => {
  const out = redact(
    "a \uE0000\uE000 b \uE0007\uE000 c https://github.com/BrainerVirus/workit/issues/9",
  );
  expect(out).not.toContain("undefined");
  expect(out).toBe("a 0 b 7 c https://github.com/BrainerVirus/workit/issues/9");
});
