// Shell completion (W2.43): `workit completion <shell>` prints a script built
// from the verb registry, `workit __complete <words…>` serves the positional
// values (check names, slice ids, workspaces) from local files only, and
// `workit setup` installs the script where the user's shell loads it, never
// touching an rc file.
import { afterAll, expect, test } from "bun:test";
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
import os from "node:os";
import path from "node:path";
import { complete } from "@/packages/workit-cli/src/completion/complete";
import {
  completionFile,
  installCompletion,
  removeCompletions,
} from "@/packages/workit-cli/src/completion/install";
import { COMPLETION_MARKER, completionScript } from "@/packages/workit-cli/src/completion/scripts";
import { flagsFor } from "@/packages/workit-cli/src/completion/spec";
import { main } from "@/packages/workit-cli/src/main";
import { run as setup } from "@/packages/workit-cli/src/verbs/setup";
import { VERBS } from "@/packages/workit-cli/src/verbs/registry";
import { fanoutsDir } from "@/packages/workit-core/src/fanout";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const mainEntry = path.join(repoRoot, "packages/workit-cli/src/main.ts");
const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), "wk-completion-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const verbs = VERBS.filter((entry) => !entry.planned);

/** The words a script's static table offers for `key` (the case row's printf list). */
const row = (script: string, key: string): string[] => {
  const lines = script.split("\n").map((line) => line.trim());
  const posix = lines.find((line) => line.startsWith(`"${key}") printf '%s\\n' `));
  if (posix) return posix.slice(`"${key}") printf '%s\\n' `.length, -" ;;".length).split(" ");
  const fish = lines.indexOf(`case '${key}'`);
  return fish < 0 ? [] : lines[fish + 1].slice("printf '%s\\n' ".length).split(" ");
};

test("Given workit completion zsh|bash|fish, Then each script offers every registry verb, its subcommands and its flags", async () => {
  for (const shell of ["zsh", "bash", "fish"] as const) {
    const out: string[] = [];
    expect(await main(["completion", shell], { stdout: (text) => void out.push(text) })).toBe(0);
    const script = out.join("");
    expect(script).toBe(
      completionScript(
        shell,
        JSON.parse(readFileSync(path.join(repoRoot, "packages/workit-cli/package.json"), "utf8"))
          .version,
      ),
    );
    expect(script).toContain(COMPLETION_MARKER);
    expect(script).toContain("workit __complete");
    const offered = row(script, "");
    for (const entry of verbs) {
      expect(offered, `${shell}: ${entry.name}`).toContain(entry.name);
      const subs = entry.subcommands ?? [];
      if (subs.length)
        expect(row(script, entry.name), `${shell} ${entry.name}`).toEqual([
          ...new Set(subs.map((sub) => sub.name)),
        ]);
      for (const flag of flagsFor(entry))
        expect(row(script, `-${entry.name}`), `${shell} ${entry.name}`).toContain(flag);
      for (const sub of subs)
        for (const flag of flagsFor(entry, sub))
          expect(
            row(script, `-${entry.name} ${sub.name}`),
            `${shell} ${entry.name} ${sub.name}`,
          ).toContain(flag);
    }
  }
});

test("Given workit completion with no or an unknown shell, Then it is a usage error naming the shells", async () => {
  const err: string[] = [];
  const io = { stdout: () => {}, stderr: (text: string) => void err.push(text) };
  expect(await main(["completion"], io)).toBe(2);
  expect(await main(["completion", "tcsh"], io)).toBe(2);
  expect(err.join("")).toContain("workit completion <zsh|bash|fish|powershell>");
});

// A repo with configured checks and a registered fanout, for __complete.
const repo = path.join(scratch, "repo");
mkdirSync(path.join(repo, ".workit"), { recursive: true });
spawnSync("git", ["init", "-q", repo]);
writeFileSync(
  path.join(repo, ".workit/checks.json"),
  JSON.stringify({
    checks: { unit: "bun test", lint: "bun run lint" },
    groups: { ci: ["unit", "lint"] },
  }),
);
const store = fanoutsDir(repo);
if (!store.ok) throw new Error(store.error);
mkdirSync(store.data, { recursive: true });
writeFileSync(
  path.join(store.data, "batch.json"),
  JSON.stringify({
    name: "batch",
    trunk: "main",
    slices: [
      { id: "cli-help", branch: "a" },
      { id: "docs", branch: "b" },
    ],
  }),
);

const run = (words: string[]) =>
  spawnSync(process.execPath, [mainEntry, "__complete", ...words], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });

test("Given workit __complete check '', Then it lists the configured check names and groups, and nothing else", () => {
  const result = run(["check", ""]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.split("\n").filter(Boolean).toSorted()).toEqual(["ci", "lint", "unit"]);
  expect(run(["check", "u"]).stdout).toBe("unit\n");
});

test("Given workit __complete fanout worktree create '', Then it lists the slice ids in under 300 ms", () => {
  expect(run(["fanout", "worktree", ""]).stdout).toBe("create\nrelease\n");
  const timings: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const start = performance.now();
    const result = run(["fanout", "worktree", "create", ""]);
    timings.push(performance.now() - start);
    expect(result.stdout).toBe("cli-help\ndocs\n");
  }
  expect(Math.min(...timings)).toBeLessThan(300);
});

test("Given words mid-command, Then __complete offers subcommands, flags, fixed words and help topics, and nothing after a value flag", async () => {
  const none = {
    checks: async () => [],
    workspaces: async () => ["work", "personal"],
    slices: async () => [],
  };
  const at = (words: string[]) => complete(words, repo, none);
  expect(await at(["fan"])).toEqual(["fanout"]);
  expect(await at(["fanout", "b"])).toEqual(["brief"]);
  expect(await at(["fanout", "brief", "x", "--m"])).toEqual(["--mode"]);
  expect(await at(["dir", "c"])).toEqual(["config", "cache"]);
  expect(await at(["grant", "show", ""])).toEqual(["work", "personal"]);
  expect(await at(["workspace", "rm", "w"])).toEqual(["work"]);
  expect(await at(["help", "fanout", "w"])).toEqual(["worktree"]);
  expect(await at(["fanout", "brief", "x", "--mode", ""])).toEqual([]);
  expect(await at(["--cwd", ""])).toEqual([]);
  expect(await at(["nosuchverb", ""])).toEqual([]);
});

test.skipIf(process.platform === "win32")(
  "Given the bash script, When bash completes, Then verbs, flags and __complete values come back",
  () => {
    const script = completionScript("bash", "0.0.0");
    const file = path.join(scratch, "workit.bash");
    writeFileSync(file, script);
    const ask = (line: string) => {
      const words = line.split(" ");
      const body = [
        `workit() { bun ${JSON.stringify(mainEntry)} "$@"; }`,
        `source ${JSON.stringify(file)}`,
        `COMP_WORDS=(${words.map((word) => JSON.stringify(word)).join(" ")}); COMP_CWORD=${words.length - 1}`,
        "_workit; printf '%s\\n' \"${COMPREPLY[@]}\"",
      ].join("\n");
      const result = spawnSync("bash", ["-c", body], { cwd: repo, encoding: "utf8" });
      return result.stdout.split("\n").filter(Boolean);
    };
    expect(ask("workit fano")).toEqual(["fanout"]);
    expect(ask("workit fanout wo")).toEqual(["worktree"]);
    expect(ask("workit check --he")).toEqual(["--heavy", "--help"]);
    expect(ask("workit check u")).toEqual(["unit"]);
    expect(ask("workit fanout worktree create ")).toEqual(["cli-help", "docs"]);
  },
);

const sandbox = (name: string) => {
  const home = path.join(scratch, name);
  const env = {
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    PATH: process.env.PATH,
  };
  mkdirSync(home, { recursive: true });
  return { home, env };
};

test("Given each shell, Then the script goes to its per-user location from the path resolver", () => {
  const { env } = sandbox("locations");
  expect(completionFile("zsh", env, "linux")).toBe(
    path.join(env.XDG_DATA_HOME, "zsh", "site-functions", "_workit"),
  );
  expect(completionFile("bash", env, "linux")).toBe(
    path.join(env.XDG_DATA_HOME, "bash-completion", "completions", "workit"),
  );
  expect(completionFile("fish", env, "linux")).toBe(
    path.join(env.XDG_CONFIG_HOME, "fish", "completions", "workit.fish"),
  );
  expect(completionFile("powershell", env, "linux")).toBeNull();
  const bare = { HOME: env.HOME };
  expect(completionFile("zsh", bare, "linux")).toBe(
    path.join(env.HOME, ".local", "share", "zsh", "site-functions", "_workit"),
  );
  expect(completionFile("fish", { ...bare, WORKIT_CONFIG: "/elsewhere" }, "linux")).toBe(
    path.join(env.HOME, ".config", "fish", "completions", "workit.fish"),
  );
});

test("Given zsh and an fpath without the directory, When installed, Then _workit is written and the fpath lines are printed; on fpath, they are not", () => {
  const { env } = sandbox("zsh");
  const file = path.join(env.XDG_DATA_HOME, "zsh", "site-functions", "_workit");
  const lacking = installCompletion({
    env,
    version: "1.2.3",
    shell: "zsh",
    fpath: () => ["/usr/share/zsh/functions"],
  });
  expect(lacking.status).toBe("written");
  expect(lacking.file).toBe(file);
  expect(readFileSync(file, "utf8")).toBe(completionScript("zsh", "1.2.3"));
  expect(lacking.notes).toContain(`  fpath=("${path.dirname(file)}" $fpath)`);
  expect(lacking.notes).toContain("  autoload -Uz compinit && compinit");
  const onPath = installCompletion({
    env,
    version: "1.2.3",
    shell: "zsh",
    fpath: () => [path.dirname(file)],
  });
  expect(onPath.status).toBe("current");
  expect(onPath.notes.join("\n")).not.toContain("fpath=(");
});

test("Given a completion file Workit did not write, Then install leaves it and uninstall's remover keeps it", () => {
  const { env } = sandbox("foreign");
  const file = completionFile("bash", env, "linux") as string;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "# mine\n");
  expect(installCompletion({ env, version: "1", shell: "bash", platform: "linux" }).status).toBe(
    "skipped",
  );
  expect(readFileSync(file, "utf8")).toBe("# mine\n");
  expect(installCompletion({ env, version: "1", shell: "fish", platform: "linux" }).status).toBe(
    "written",
  );
  expect(removeCompletions(env, "linux")).toEqual([completionFile("fish", env, "linux") as string]);
  expect(existsSync(file)).toBe(true);
});

test("Given no known shell, Then install writes nothing and says nothing; PowerShell gets the profile line only", () => {
  const { env } = sandbox("noshell");
  expect(
    installCompletion({ env: { ...env, SHELL: "/bin/tcsh" }, version: "1", platform: "linux" }),
  ).toEqual({ shell: null, file: null, status: "skipped", notes: [] });
  const ps = installCompletion({ env, version: "1", shell: "powershell" });
  expect(ps.file).toBeNull();
  expect(ps.notes.join("")).toContain(
    "workit completion powershell | Out-String | Invoke-Expression",
  );
});

test.skipIf(process.platform === "win32")(
  "Given workit setup on zsh with a temp HOME and XDG dirs, Then _workit is written, the fpath lines print, and no rc file changes",
  async () => {
    const { home, env } = sandbox("setup");
    const rc = path.join(home, ".zshrc");
    writeFileSync(rc, "# my zshrc\n");
    const out: string[] = [];
    const code = await setup(["--hosts=codex", "--no-shell", "--yes"], {
      json: false,
      cwd: home,
      env: { ...env, SHELL: "/bin/zsh" },
      stdout: (text) => void out.push(text),
      stderr: (text) => void out.push(text),
    });
    expect(code).toBe(0);
    const file = path.join(env.XDG_DATA_HOME, "zsh", "site-functions", "_workit");
    expect(readFileSync(file, "utf8")).toStartWith("#compdef workit\n");
    const text = out.join("");
    expect(text).toContain(`zsh completion written to ${file}`);
    expect(text).toContain(`  fpath=("${path.dirname(file)}" $fpath)`);
    expect(readFileSync(rc, "utf8")).toBe("# my zshrc\n");
  },
);
