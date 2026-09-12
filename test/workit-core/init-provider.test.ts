import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveInitProvider } from "@/packages/workit-core/src/core/init";

const repoWithRemote = (url: string | null): string => {
  const root = mkdtempSync(path.join(tmpdir(), "wk-init-prov-"));
  const run = (args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "T"]);
  run(["config", "user.email", "t@t"]);
  if (url) run(["remote", "add", "origin", url]);
  return root;
};

test("resolveInitProvider prefers env, then origin remote, else null (no silent default)", () => {
  const gh = repoWithRemote("https://github.com/acme/workit.git");
  const gl = repoWithRemote("https://gitlab.com/acme/workit.git");
  const bare = repoWithRemote(null);
  const prev = process.env.WORKFLOW_VCS_PROVIDER;
  try {
    delete process.env.WORKFLOW_VCS_PROVIDER;
    expect(resolveInitProvider(gh)).toBe("github");
    expect(resolveInitProvider(gl)).toBe("gitlab");
    expect(resolveInitProvider(bare)).toBe(null);
    process.env.WORKFLOW_VCS_PROVIDER = "GitHub";
    expect(resolveInitProvider(gl)).toBe("github");
  } finally {
    if (prev === undefined) delete process.env.WORKFLOW_VCS_PROVIDER;
    else process.env.WORKFLOW_VCS_PROVIDER = prev;
    for (const root of [gh, gl, bare]) rmSync(root, { recursive: true, force: true });
  }
});
