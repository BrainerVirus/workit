/** Reusable Docker harness for the OpenCode V2 contract spike
 * (docs/opencode-v2/plan.md step 3) and the later parity matrix.
 *
 * Layout per run (all disposable except the assertions):
 * - isolated bridge network;
 * - fresh temp HOME (server state) with the fixture config;
 * - `stub` container (oven/bun, mock-provider.ts) on the same network;
 * - `server` container (pinned V2 image, tail entrypoint); the CLI inside
 *   auto-starts exactly one background service, which the driver talks to.
 * - host-mounted log dir so probe/stub/server logs are plain files.
 *
 * Run: `WORKIT_V2_HARNESS=1 bun test test/opencode-v2/contract.test.ts`
 * Without the opt-in the suite passes silently (docker-gated, like the
 * platform guards elsewhere in this repo).
 */

import { $ } from "bun";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const V2_IMAGE =
  "ghcr.io/anomalyco/opencode@sha256:aaf8c5420e10652c520e068532384f6e20cece2922c404db7f89e36720b9f212";
export const BUN_IMAGE =
  "oven/bun@sha256:1d653098bf847813e26adb2435f932b7cfa3c132a7e25dd5216dbb1f67dbd118";

export type Harness = {
  root: string;
  net: string;
  stub: string;
  server: string;
  workdir: string;
  logDir: string;
  api: (method: string, route: string, body?: unknown, voidOk?: boolean) => Promise<any>;
  op: (
    operation: string,
    args?: Record<string, string>,
    body?: unknown,
    voidOk?: boolean,
  ) => Promise<any>;
  serverLog: () => string;
  probeLog: () => string;
  stubLog: () => string;
};

const sh = async (args: string[]): Promise<string> => {
  const out = await $`docker ${args}`.text();
  return out;
};

export const dockerAvailable = async (): Promise<boolean> => {
  try {
    await $`docker info`.quiet();
    return true;
  } catch {
    return false;
  }
};

const imagePresent = async (ref: string): Promise<boolean> => {
  try {
    await $`docker image inspect ${ref}`.quiet();
    return true;
  } catch {
    return false;
  }
};

export const ensureImages = async (): Promise<void> => {
  for (const ref of [V2_IMAGE, BUN_IMAGE]) {
    if (await imagePresent(ref)) continue;
    await $`docker pull ${ref}`;
  }
};

/** Remove root-owned server leftovers so a temp HOME can be recreated. */
const wipe = async (dir: string): Promise<void> => {
  try {
    await $`docker run --rm -v ${dir}:/h alpine:3.20 sh -c 'rm -rf /h/.local /h/.cache && mkdir -p /h'`.quiet();
    return;
  } catch {
    // fall through to best-effort host removal
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // root-owned leftovers may survive; the next boot wipes via helper
  }
  mkdirSync(dir, { recursive: true });
};

const waitFor = async (
  fn: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(1000);
  }
};

export const boot = async (): Promise<Harness> => {
  const root = mkdtempSync(path.join(tmpdir(), "workit-v2-"));
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const logDir = path.join(root, "logs");
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(work, ".opencode", "plugins"), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  // Probe plugin inside the project (location discovery) — no build step,
  // no SDK dependency (plain object form; 2.0.3 has no ctx.provider/ctx.model).
  mkdirSync(path.join(work, ".opencode", "plugins", "v2probe"), { recursive: true });
  await $`cp ${path.join(HERE, "probe-plugin", "index.js")} ${path.join(work, ".opencode", "plugins", "v2probe", "index.js")}`;
  await $`cp ${path.join(HERE, "probe-plugin", "package.json")} ${path.join(work, ".opencode", "plugins", "v2probe", "package.json")}`;

  const net = `v2harness-${process.pid}`;
  const stub = `v2harness-stub-${process.pid}`;
  const server = `v2harness-server-${process.pid}`;
  const stubUrl = "http://stub:8000/v1";
  const config = readFileSync(path.join(HERE, "fixtures", "opencode.json"), "utf8").replaceAll(
    "__STUB_URL__",
    stubUrl,
  );
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(path.join(home, ".config", "opencode", "opencode.json"), config);

  await sh(["network", "create", net]);
  try {
    await sh([
      "run",
      "--rm",
      "-d",
      "--name",
      stub,
      "--network",
      net,
      "--network-alias",
      "stub",
      "-v",
      `${path.join(HERE, "mock-provider.ts")}:/stub/mock-provider.ts:ro`,
      "-v",
      `${logDir}:/logs`,
      "-e",
      "PORT=8000",
      "-e",
      "STUB_LOG=/logs/stub-requests.log",
      BUN_IMAGE,
      "bun",
      "/stub/mock-provider.ts",
    ]);
    await sh([
      "run",
      "--rm",
      "-d",
      "--name",
      server,
      "--network",
      net,
      "--entrypoint",
      "tail",
      "-w",
      "/workspace/work",
      "-e",
      "HOME=/home/oc",
      "-e",
      "V2PROBE_LOG=/logs/probe-events.log",
      "-v",
      `${home}:/home/oc`,
      "-v",
      `${work}:/workspace/work`,
      "-v",
      `${logDir}:/logs:rw`,
      V2_IMAGE,
      "-f",
      "/dev/null",
    ]);
  } catch (e) {
    await sh(["network", "rm", net]).catch(() => {});
    throw e;
  }

  const execServer = async (args: string[]): Promise<string> =>
    sh(["exec", "-w", "/workspace/work", server, ...args]);

  /** Call the in-container CLI driver (auto-starts the single service). */
  const cli = async (args: string[]): Promise<string> => execServer(["opencode", ...args]);

  const parseJson = (out: string): any => {
    const start = out.indexOf("{");
    if (start < 0) throw new Error(`no JSON in CLI output: ${out.slice(0, 200)}`);
    return JSON.parse(out.slice(start));
  };

  // The first CLI call spawns the background service; calls racing the
  // spawn return empty output with exit 0. Retry transient empties bounded.
  // Some routes (model switch, replies, rules) succeed with an empty body:
  // callers pass voidOk to accept that once the service answers health.
  const callJson = async (argv: string[], voidOk = false): Promise<any> => {
    const start = Date.now();
    let attempts = 0;
    for (;;) {
      attempts++;
      let out: string;
      let failed: string | null = null;
      try {
        out = await cli(argv);
      } catch (e) {
        failed = String(e).slice(0, 300);
        out = "";
      }
      if (out.indexOf("{") >= 0) return parseJson(out);
      if (voidOk && out === "" && failed === null) {
        try {
          await cli(["api", "GET", "/api/health"]);
          return null;
        } catch {
          // service not answering yet; keep retrying below
        }
      }
      if (Date.now() - start > 90_000)
        throw new Error(
          `CLI never returned JSON after ${attempts} attempts: ${(failed ?? out).slice(0, 200)}`,
        );
      await Bun.sleep(2000);
    }
  };

  const api = async (
    method: string,
    route: string,
    body?: unknown,
    voidOk = false,
  ): Promise<any> => {
    const args = ["api", method, route];
    if (body !== undefined) args.push("-d", JSON.stringify(body));
    return callJson(args, voidOk);
  };

  const op = async (
    operation: string,
    args?: Record<string, string>,
    body?: unknown,
    voidOk = false,
  ): Promise<any> => {
    const argv = ["api", operation];
    for (const [k, v] of Object.entries(args ?? {})) argv.push("--param", `${k}=${v}`);
    if (body !== undefined) argv.push("-d", JSON.stringify(body));
    return callJson(argv, voidOk);
  };

  const serverLog = (): string => {
    try {
      return readFileSync(
        path.join(home, ".local", "share", "opencode", "log", "opencode.log"),
        "utf8",
      );
    } catch {
      return "";
    }
  };
  const probeLog = (): string => {
    try {
      return readFileSync(path.join(logDir, "probe-events.log"), "utf8");
    } catch {
      return "";
    }
  };
  const stubLog = (): string => {
    try {
      return readFileSync(path.join(logDir, "stub-requests.log"), "utf8");
    } catch {
      return "";
    }
  };

  // Boot: the in-container CLI auto-starts exactly one background service;
  // wait for it, then for the stub model to appear in the catalog.
  await waitFor(
    async () => {
      try {
        await cli(["api", "GET", "/api/health"]);
        return true;
      } catch {
        return false;
      }
    },
    60_000,
    "service health",
  );
  await waitFor(
    async () => {
      try {
        const r = await api("GET", "/api/model");
        return Array.isArray(r.data) && r.data.some((m: any) => m.id === "stub-model");
      } catch {
        return false;
      }
    },
    90_000,
    "stub-model in catalog",
  );

  const h: Harness = {
    root,
    net,
    stub,
    server,
    workdir: work,
    logDir,
    api,
    op,
    serverLog,
    probeLog,
    stubLog,
  };
  return h;
};

export const dispose = async (h: Harness): Promise<void> => {
  await sh(["rm", "-f", h.server, h.stub]).catch(() => {});
  await sh(["network", "rm", h.net]).catch(() => {});
  await wipe(path.join(h.root, "home"));
  try {
    rmSync(h.root, { recursive: true, force: true });
  } catch {
    // root-owned crumbs may survive a failed helper wipe; never fail teardown
  }
};
