import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { apiJson, systemRunner } from "@/packages/workit-core/src/forge/exec";

// Every gh/glab call runs with stdin closed and a deadline: a CLI that waits
// for input (a prompt, a pager, `cat`) gets EOF, and one that never returns
// is killed at the deadline and named in the error (#644).

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A PATH whose `gh` is `script`. */
const stubGh = (script: string): NodeJS.ProcessEnv => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-gh-stub-"));
  dirs.push(dir);
  const gh = path.join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh\n${script}\n`);
  chmodSync(gh, 0o755);
  return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
};

const posix = process.platform !== "win32";

test.skipIf(!posix)(
  "Given a gh that reads stdin to EOF, When the runner calls it, Then stdin is closed and it returns at once",
  () => {
    const run = systemRunner(
      "github",
      "github.com",
      stubGh("cat >/dev/null\necho '{\"ok\":true}'"),
    );
    const began = Date.now();
    const result = run("gh", ["api", "user"], { timeoutMs: 10_000 });
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
    expect(Date.now() - began).toBeLessThan(5_000);
  },
);

test.skipIf(!posix)(
  "Given a body on stdin, When the runner calls gh, Then gh reads exactly the body and then EOF",
  () => {
    const run = systemRunner("github", "github.com", stubGh("cat"));
    const result = run("gh", ["api", "--input", "-", "x"], {
      timeoutMs: 10_000,
      input: '{"body":"b"}',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"body":"b"}');
  },
);

test.skipIf(!posix)(
  "Given a gh that never returns, When apiJson calls it, Then it is killed at the deadline and the error names the call",
  () => {
    const run = systemRunner("github", "github.com", stubGh("exec sleep 30"));
    const began = Date.now();
    const result = apiJson(run, "gh", "github.com", ["api", "user"], "user lookup", 500);
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(result).toMatchObject({
      ok: false,
      code: "unavailable",
      error: "gh api user lookup timed out after 500 ms",
    });
  },
);
