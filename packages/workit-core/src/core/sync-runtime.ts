import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Port of scripts/sync-runtime.sh — explicit runtime sync used by the installers.
// NOT part of runtime startup: the session-start hook performs no sync (RL-09).
// The bash installer scripts still invoke sync-runtime.sh directly; this typed
// operation mirrors the same RR-05 failure semantics (missing flock, held lock,
// failed fetch, failed dependency install all fail loudly).

export type SyncRuntimeResult = { ok: true } | { ok: false; error: string };

export type SyncRuntimeOptions = {
  home?: string;
  dev?: string;
  repoSlug?: string;
  lockDir?: string;
  env?: NodeJS.ProcessEnv;
};

const run = (cmd: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }) => {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
  };
};

/** Acquire a non-blocking flock for the duration of the sync (mirrors `exec 9>"$LOCK"; flock -n 9`). */
async function acquireLock(
  lock: string,
  env: NodeJS.ProcessEnv,
): Promise<{ proc: ChildProcess } | { error: string }> {
  // A single `sh` child opens fd 9 and takes the flock on it, then stays alive
  // until killed, so the lock is held atomically for the whole sync: no
  // probe-then-hold TOCTOU window and no duration cap. The child signals it
  // holds the lock by creating a ready marker; any other exit means it was held.
  const ready = `${lock}.ready`;
  rmSync(ready, { force: true });
  const proc = spawn(
    "sh",
    [
      "-c",
      `exec 9>"$1"; flock -n 9 || exit 7; : >"$2"; while :; do sleep 3600; done`,
      "workit-lock",
      lock,
      ready,
    ],
    { stdio: "ignore", env, detached: true },
  );
  const acquired = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    proc.once("exit", () => finish(false));
    proc.once("error", () => finish(false));
    const poll = () => {
      if (settled) return;
      if (existsSync(ready)) {
        finish(true);
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
  if (!acquired) {
    killLockProcess(proc);
    return { error: `sync-runtime: another process holds ${lock} — state unverified, failing` };
  }
  return { proc };
}

/** Kill the lock-holder process group so the sleep child releases the flock'd fd. */
function killLockProcess(proc: ChildProcess): void {
  try {
    if (proc.pid) process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill();
  }
}

export async function syncRuntime(options: SyncRuntimeOptions = {}): Promise<SyncRuntimeResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const dev =
    options.dev ??
    env.WORKFLOW_TOOLKIT_DEV ??
    path.join(home, "Documents/projects/personal/workflow-toolkit");
  const repoSlug = options.repoSlug ?? env.WORKFLOW_TOOLKIT_REPO ?? "BrainerVirus/workit";
  const share = path.join(home, ".local/share/workflow-toolkit");
  const pluginDir = path.join(home, ".cursor/plugins/local/workflow-toolkit");
  const opencodePlugins = path.join(home, ".config/opencode/plugins");
  const lock = path.join(
    options.lockDir ?? env.XDG_RUNTIME_DIR ?? "/tmp",
    "workflow-toolkit-sync.lock",
  );

  // RR-05: a missing required tool must never look like a successful sync.
  if (run("flock", ["--version"], { env }).exitCode !== 0) {
    return {
      ok: false,
      error: "FATAL: sync-runtime requires flock (util-linux) — not found in PATH",
    };
  }

  const acquired = await acquireLock(lock, env);
  if ("error" in acquired) return { ok: false, error: acquired.error };
  const lockProc = acquired.proc;

  try {
    let src = "";
    if (
      existsSync(path.join(dev, "packages/workit-opencode/src/plugin.ts")) &&
      existsSync(path.join(dev, "packages/workit-cursor/.cursor-plugin"))
    ) {
      src = dev;
    } else if (existsSync(path.join(share, ".git"))) {
      // RR-05: propagate fetch/pull failures to a FATAL nonzero exit.
      if (run("git", ["-C", share, "fetch", "--quiet", "origin"], { env }).exitCode !== 0) {
        return { ok: false, error: `FATAL: could not fetch updates for ${share}` };
      }
      const pull = run("git", ["-C", share, "pull", "--ff-only", "--quiet", "origin", "main"], {
        env,
      });
      if (pull.exitCode !== 0) {
        return { ok: false, error: `FATAL: could not update ${share} from origin/main` };
      }
      src = share;
    } else if (!existsSync(path.join(share, "packages/workit-core/src"))) {
      mkdirSync(path.dirname(share), { recursive: true });
      const clone = run(
        "git",
        ["clone", "--depth", "1", `https://github.com/${repoSlug}.git`, share],
        { env },
      );
      if (clone.exitCode !== 0) {
        return {
          ok: false,
          error: `FATAL: could not clone https://github.com/${repoSlug}.git into ${share}`,
        };
      }
      src = share;
    } else {
      src = share;
    }

    if (src !== share) {
      mkdirSync(share, { recursive: true });
      // Keep .git if share is a clone; never wipe it when syncing from the monorepo.
      const r = run(
        "rsync",
        [
          "-a",
          "--delete",
          "--exclude",
          ".git",
          "--exclude",
          "node_modules",
          "--exclude",
          "cursor/mcp/node_modules",
          "--exclude",
          ".cache",
          `${src}/`,
          `${share}/`,
        ],
        { env },
      );
      if (r.exitCode !== 0) return { ok: false, error: `FATAL: rsync share failed: ${r.stderr}` };
    }

    mkdirSync(path.join(home, ".cursor/plugins/local"), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    const cursorCopy = run(
      "rsync",
      [
        "-a",
        "--delete",
        "--exclude",
        "mcp/node_modules",
        `${share}/packages/workit-cursor/`,
        `${pluginDir}/`,
      ],
      { env },
    );
    if (cursorCopy.exitCode !== 0) {
      return { ok: false, error: `FATAL: rsync cursor plugin failed: ${cursorCopy.stderr}` };
    }

    // Vendored skills for Cursor (same folder layout as OpenCode registration).
    const skillsSrc = path.join(share, "packages/workit-core/vendor/superpowers/skills");
    if (existsSync(skillsSrc)) {
      mkdirSync(path.join(pluginDir, "vendor/superpowers"), { recursive: true });
      const r = run(
        "rsync",
        ["-a", "--delete", skillsSrc, path.join(pluginDir, "vendor/superpowers/")],
        { env },
      );
      if (r.exitCode !== 0) {
        return { ok: false, error: `FATAL: skills rsync failed: ${r.stderr}` };
      }
    }

    // Canonical user rules -> Cursor .mdc (compiled by the shared core).
    const configRules = path.join(env.WORKFLOW_TOOLKIT_CONFIG ?? "", "rules");
    if (env.WORKFLOW_TOOLKIT_CONFIG && existsSync(configRules)) {
      const bun = resolveBun(env);
      if (bun) {
        run(
          bun,
          [
            "-e",
            `import('${share}/packages/workit-core/src/core/rules.ts').then(({ writeCompiledCursorRules }) => writeCompiledCursorRules('${pluginDir}/rules'));`,
          ],
          { env },
        );
      }
    }
    writeFileSync(
      path.join(pluginDir, ".workflow-toolkit-root"),
      `${share}/packages/workit-core\n`,
    );

    if (!existsSync(path.join(pluginDir, "mcp/node_modules"))) {
      const r = run("npm", ["install", "--silent"], { cwd: path.join(pluginDir, "mcp"), env });
      if (r.exitCode !== 0) {
        return {
          ok: false,
          error: `FATAL: MCP dependency install failed in ${pluginDir}/mcp: ${r.stderr}`,
        };
      }
    }

    // Share MCP also needs deps when launched via run-cursor-mcp fallback.
    if (!existsSync(path.join(share, "packages/workit-cursor/mcp/node_modules"))) {
      const r = run("npm", ["install", "--silent"], {
        cwd: path.join(share, "packages/workit-cursor/mcp"),
        env,
      });
      if (r.exitCode !== 0) {
        return {
          ok: false,
          error: `FATAL: MCP dependency install failed in ${share}/packages/workit-cursor/mcp: ${r.stderr}`,
        };
      }
    }

    // Remove broken TLA live-loader if present (OpenCode ignored it; /wk-* vanished).
    rmSync(path.join(opencodePlugins, "workflow-toolkit.ts"), { force: true });

    // Ensure OpenCode has plugin peer dep.
    const pkg = path.join(home, ".config/opencode/package.json");
    if (existsSync(pkg)) {
      try {
        const data = JSON.parse(readFileSync(pkg, "utf8")) as {
          dependencies?: Record<string, string>;
        };
        data.dependencies = data.dependencies ?? {};
        data.dependencies["@opencode-ai/plugin"] ??= "1.17.7";
        writeFileSync(pkg, JSON.stringify(data, null, 2) + "\n");
      } catch {
        /* best-effort */
      }
    }

    // Drop bun package cache so old github/file installs cannot shadow file:// plugin.ts.
    const cacheDir = path.join(home, ".cache/opencode/packages");
    if (existsSync(cacheDir)) {
      try {
        for (const entry of readdirSync(cacheDir)) {
          if (entry.startsWith("workflow-toolkit-opencode@")) {
            rmSync(path.join(cacheDir, entry), { recursive: true, force: true });
          }
        }
      } catch {
        /* best-effort */
      }
    }

    return { ok: true };
  } finally {
    killLockProcess(lockProc);
    rmSync(`${lock}.ready`, { force: true });
  }
}

const resolveBun = (env: NodeJS.ProcessEnv): string | null => {
  if (env.BUN) return env.BUN;
  const candidates = [
    path.join(os.homedir(), ".bun/bin/bun"),
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
};
