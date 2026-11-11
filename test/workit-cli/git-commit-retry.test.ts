import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import type { Io } from "@/packages/workit-cli/src/output";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { makeRemoteRepo, type RemoteRepo } from "@/test/shared/helpers/git-remote";

// #792 item 25: a pre-commit hook refuses the commit and its formatter rewrites
// the named path. Left staged at the pre-format copy, the retry would read the
// path as staged in part and commit that stale copy through a private index.

setDefaultTimeout(60_000);

let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-git-commit-retry-");
});
afterAll(() => configHome.restore());

const repos: RemoteRepo[] = [];
afterEach(() => {
  rmSync(path.join(configHome.configDir, "config.json"), { force: true });
  for (const repo of repos.splice(0)) repo.cleanup();
});

const run = async (argv: string[], cwd: string) => {
  let stdout = "";
  let stderr = "";
  const io: Partial<Io> = {
    cwd,
    env: { ...process.env, WORKIT_SESSION_ID: "author-1" },
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
};

/** A pre-commit formatter that rewrites a.txt and refuses once, then passes. */
const refuseOnce = (repo: RemoteRepo) => {
  const file = path.join(repo.root, "hooks", "pre-commit");
  const mark = path.join(repo.root, "refused-once");
  writeFileSync(
    file,
    `#!/bin/sh\nif [ ! -f '${mark}' ]; then touch '${mark}'; printf 'formatted\\n' > a.txt; echo 'a.txt reformatted' >&2; exit 1; fi\nexit 0\n`,
  );
  chmodSync(file, 0o755);
};

test("Given a pre-commit refusal that reformats the path, When the same commit is retried, Then it commits the reformatted file", async () => {
  writeFileSync(
    path.join(configHome.configDir, "config.json"),
    JSON.stringify({ branchPolicy: { preset: "github-flow" } }),
  );
  const repo = makeRemoteRepo();
  repos.push(repo);
  repo.git("switch", "-q", "-c", "feature/a");
  refuseOnce(repo);
  repo.write("a.txt", "raw\n");
  const argv = ["git", "commit", "-m", "feat: a", "--", "a.txt"];

  const refused = await run(argv, repo.cwd);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toContain("a.txt reformatted");
  // The path stays staged whole, the formatter's rewrite included.
  expect(repo.git("show", ":a.txt")).toBe("formatted");
  expect(repo.git("diff", "--name-only")).toBe("");

  const retried = await run(argv, repo.cwd);
  expect(retried.code).toBe(0);
  expect(repo.git("show", "HEAD:a.txt")).toBe("formatted");
  expect(repo.git("status", "--porcelain")).toBe("");
  expect(readFileSync(path.join(repo.cwd, "a.txt"), "utf8")).toBe("formatted\n");
});
