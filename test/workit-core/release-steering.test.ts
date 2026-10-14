import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { tempRoot, withProtectedMain } from "./hooks/hook-fixtures";

// The pre-shell hook's release steering (#302 review): a raw tag push or a
// raw push onto git-flow main names `workit git push --release` with the
// repository's own tag prefix, never a hard-coded `v`.

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

/** A git-flow Workit workspace (main and develop) with `prefix` as git-flow's tag prefix. */
const flowRoot = (prefix: string) => {
  const root = tempRoot("workit-release-steering-");
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "branch", "develop");
  git(root, "config", "gitflow.prefix.versiontag", prefix);
  git(root, "init", "-q", "--bare", "remote.git");
  git(root, "remote", "add", "origin", path.join(root, "remote.git"));
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

const reason = (cwd: string, command: string): string =>
  String(
    (
      dispatchHook(claudeCodeAdapter, {
        hook_event_name: "PreToolUse",
        session_id: `s-${command.length}-${cwd.length}`,
        cwd,
        tool_name: "Bash",
        tool_input: { command },
      }).json as { hookSpecificOutput?: { permissionDecisionReason?: string } }
    ).hookSpecificOutput?.permissionDecisionReason,
  );

test("Given an empty or v tag prefix, When a raw tag push or a push onto git-flow main is denied, Then the steering names that prefix's release tag", async () => {
  await withProtectedMain(async (configDir) => {
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ branchPolicy: { preset: "gitflow" } }),
    );
    for (const [prefix, shape] of [
      ["", "<version>"],
      ["v", "v<version>"],
    ]) {
      const root = flowRoot(prefix);
      expect(reason(root, "git push --tags"), prefix).toContain(
        `workit git push --release ${shape}\``,
      );
      expect(reason(root, "git push --tags"), prefix).toContain(`(${shape} tags whose commit`);
      expect(reason(root, "git push origin main"), prefix).toContain(
        `workit git push --release main [--release ${shape}]`,
      );
    }
  });
});
