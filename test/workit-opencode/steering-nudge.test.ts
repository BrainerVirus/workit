// In-process hosts spend the raw-git nudge on the tool result (OpenCode's
// shell.after, Pi's tool_result): a read-only gh/git command gets none, and a
// Pi implementer worker, whose brief already says how to run git, gets no git
// nudge (#428).
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { observeShellResult, type ShellAfterEvent } from "@/packages/workit-opencode/src/v2/shell";
import { observeToolResult } from "@/packages/workit-pi/src/tools";
import { tempRoot, withProtectedMain } from "@/test/workit-core/hooks/hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const repo = () => {
  const root = tempRoot("workit-steering-nudge-");
  roots.push(root);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("checkout", "-q", "-b", "feature/x");
  mkdirSync(path.join(root, ".git", "workit"), { recursive: true });
  return root;
};

let calls = 0;

/** What OpenCode's shell result carries after Workit observed it. */
const opencode = (root: string, command: string): string => {
  const event: ShellAfterEvent = {
    tool: "shell",
    sessionID: `oc-${++calls}`,
    id: `call-${calls}`,
    input: { command },
    status: "completed",
    result: { content: "ok" },
  };
  observeShellResult(root, event);
  return String(event.result?.content);
};

/** What Pi's bash result gains, for a worker of `role` (undefined: the main session). */
const pi = (root: string, command: string, role?: string): string => {
  const saved = [process.env.WORKIT_PI_WORKER_SESSION, process.env.WORKIT_PI_WORKER_ROLE];
  if (role)
    Object.assign(process.env, {
      WORKIT_PI_WORKER_SESSION: `pw-${++calls}`,
      WORKIT_PI_WORKER_ROLE: role,
    });
  try {
    const out = observeToolResult(
      {
        toolName: "bash",
        isError: false,
        input: { command },
        content: [],
        toolCallId: `t${++calls}`,
      } as never,
      {
        cwd: root,
        sessionManager: { getSessionId: () => `pi-${calls}` },
        isProjectTrusted: () => true,
      } as never,
    );
    return JSON.stringify(out ?? {});
  } finally {
    for (const [key, value] of [
      ["WORKIT_PI_WORKER_SESSION", saved[0]],
      ["WORKIT_PI_WORKER_ROLE", saved[1]],
    ] as const)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
};

test("G OpenCode or Pi, W a read-only gh or git command, T its result carries no nudge", async () => {
  await withProtectedMain(() => {
    const root = repo();
    for (const command of ["gh pr view 4", "gh pr checks 4", "gh run list", "git status --short"]) {
      expect(opencode(root, command), command).toBe("ok");
      expect(pi(root, command), command).not.toMatch(/workit: /);
    }
    // A routine raw push still reads the nudge where no brief said otherwise.
    expect(opencode(root, "git push -u origin feature/x")).toContain("workit git push");
  });
});

test("G a Pi implementer worker, W a raw commit or push, T no git nudge, nor for a reviewer worker", async () => {
  await withProtectedMain(() => {
    const root = repo();
    for (const command of [
      "git commit -qm 'feat: x' --allow-empty",
      "git push -u origin feature/x",
    ])
      expect(pi(root, command, "implementer"), command).not.toMatch(/workit: /);
    expect(pi(root, "git push -u origin feature/x", "reviewer")).not.toMatch(/workit: /);
  });
});
