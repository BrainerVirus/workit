import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateCursorSkills } from "./skill-manifests";

// Port of scripts/sync-runtime.sh — explicit runtime sync used by the installers.
// NOT part of runtime startup: the session-start hook performs no sync (RL-09).
// The bash installer scripts still invoke sync-runtime.sh directly; this typed
// operation mirrors the same RR-05 failure semantics (missing flock, held lock,
// and failed fetch all fail loudly).

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

/**
 * Acquire a non-blocking flock for the duration of the sync (mirrors
 * `exec 9>"$LOCK"; flock -n 9`). The `sh` child opens fd 9, takes the flock,
 * then blocks reading its stdin. When this parent exits — normally, or
 * hard-killed (SIGKILL/SIGINT/crash) — the kernel closes the stdin pipe write
 * end, the child's read hits EOF, and the child exits, releasing the flock.
 * The lock thus dies with its owner (no orphan holder), matching
 * sync-runtime.sh where the flock dies with the shell process itself. No
 * probe-then-hold TOCTOU window and no duration cap: the child holds the lock
 * for exactly the parent's lifetime. The child signals acquisition by writing
 * "ok" to stdout; any other exit means the flock was already held.
 */
async function acquireLock(
  lock: string,
  env: NodeJS.ProcessEnv,
): Promise<{ proc: ChildProcess } | { error: string }> {
  const proc = spawn(
    "sh",
    [
      "-c",
      `exec 9>"$1"; flock -n 9 || exit 7; printf 'ok\\n'; while IFS= read -r _; do :; done`,
      "workit-lock",
      lock,
    ],
    { stdio: ["pipe", "pipe", "ignore"], env },
  );
  const acquired = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };
    proc.stdout?.once("data", () => finish(true));
    proc.once("exit", () => finish(false));
    proc.once("error", () => finish(false));
  });
  if (!acquired) {
    killLockProcess(proc);
    return { error: `sync-runtime: another process holds ${lock} — state unverified, failing` };
  }
  return { proc };
}

/** Kill the lock-holder child so the flock is released immediately. */
function killLockProcess(proc: ChildProcess): void {
  try {
    proc.kill();
  } catch {
    /* already exited */
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

    const cursorSrc = path.join(src, "packages/workit-cursor");
    const cursorEntries = ["mcp-server.js", "cursor-session-start.js"];
    const bun = resolveBun(env, home);
    if (!bun.ok) return bun;
    const dependencies = ["@brainervirus/workit-core", "@modelcontextprotocol/sdk", "zod"];
    if (
      dependencies.some((dependency) => !existsSync(path.join(src, "node_modules", dependency)))
    ) {
      if (!existsSync(path.join(src, "bun.lock"))) {
        return { ok: false, error: `FATAL: dependency install requires ${src}/bun.lock` };
      }
      const install = run(bun.path, ["install", "--frozen-lockfile"], { cwd: src, env });
      if (install.exitCode !== 0) {
        return {
          ok: false,
          error: `FATAL: root dependency install failed in ${src}: ${install.stderr}`,
        };
      }
    }
    const build = run(bun.path, [path.join(cursorSrc, "scripts/build.ts")], {
      cwd: src,
      env: { ...env, PATH: `${path.dirname(bun.path)}${path.delimiter}${env.PATH ?? ""}` },
    });
    if (build.exitCode !== 0) {
      return {
        ok: false,
        error: `FATAL: Cursor adapter build failed in ${cursorSrc}: ${build.stderr}`,
      };
    }
    for (const entry of cursorEntries) {
      const distEntry = path.join(cursorSrc, "dist", entry);
      try {
        const stat = statSync(distEntry);
        if (
          !stat.isFile() ||
          stat.size === 0 ||
          !readFileSync(distEntry, "utf8").startsWith("#!/usr/bin/env node\n")
        ) {
          throw new Error("invalid");
        }
      } catch {
        return {
          ok: false,
          error: `FATAL: Cursor adapter invalid dist entry: ${distEntry}`,
        };
      }
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
    const vendorError = validateCursorSkills(pluginDir);
    if (vendorError) return { ok: false, error: `FATAL: ${vendorError}` };

    // Canonical user rules -> Cursor .mdc (compiled by the shared core).
    const configRules = path.join(env.WORKFLOW_TOOLKIT_CONFIG ?? "", "rules");
    if (env.WORKFLOW_TOOLKIT_CONFIG && existsSync(configRules)) {
      const rulesBun = resolveBun(env, home);
      if (rulesBun.ok) {
        run(
          rulesBun.path,
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
  }
}

const resolveBun = (
  env: NodeJS.ProcessEnv,
  home: string,
): { ok: true; path: string } | { ok: false; error: string } => {
  if (env.BUN) {
    return executable(env.BUN)
      ? { ok: true, path: env.BUN }
      : { ok: false, error: `FATAL: BUN is set but unusable: ${env.BUN}` };
  }
  const homeBun = path.join(home, ".bun/bin/bun");
  if (executable(homeBun)) return { ok: true, path: homeBun };
  const pathBun = executableOnPath("bun", env);
  return pathBun
    ? { ok: true, path: pathBun }
    : { ok: false, error: "FATAL: Bun is required to build the Cursor adapter" };
};

const executable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const executableOnPath = (name: string, env: NodeJS.ProcessEnv): string | null => {
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (executable(candidate)) return candidate;
  }
  return null;
};
