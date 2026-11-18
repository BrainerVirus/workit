// Automation browsers (#328): the Chrome or Chromium that agent-browser,
// chrome-devtools-mcp, Playwright or Puppeteer starts for an agent, found in
// the process table so the process registry can stop it with its session.
//
// An automation browser is a browser main process (no `--type=` child) whose
// argv has `--remote-debugging-port` or `--remote-debugging-pipe` and a
// `--user-data-dir` under a temp dir or a known automation profile dir (or an
// executable a tool downloaded). A browser on the user's default profile, or
// without those flags, is never one.
//
// Its owner needs proof (wave 9 decider ruling 5), never a guess:
//   - `env`: the browser's own environment names the session
//     (WORKIT_SESSION_ID or a host's session variable). It survives the
//     launcher's death; readable on Linux only (/proc/<pid>/environ).
//   - `ancestry`: an ancestor is a live session's host process (its
//     live-session marker's pid and start time). Readable only while the
//     owner lives, so the registry records it then.
// A browser with no proof is reported, never stopped.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostSessionFromEnv } from "../host-session";
import { leadOf } from "./live-session";
import { procTree } from "./proc-tree";
import { stateDir, userHome } from "./workit-paths.mjs";

/** One row of the process table. `argv` is exact where the platform gives it (Linux /proc, a test); else it is split from `command`. */
export type ProcessEntry = {
  pid: number;
  ppid: number;
  pgid: number | null;
  command: string;
  argv?: string[];
};

/** A live-session marker's owner: the host process one session runs in. */
type SessionHost = {
  session: string;
  leads: string[];
  host: string;
  pid: number;
  pidStart: string | null;
  checkout: string | null;
  heartbeatAt: string;
};

export type BrowserOwner = {
  /** How ownership was proved. */
  proof: "env" | "ancestry";
  /** Null when the host process runs several sessions and none can be told apart. */
  session: string | null;
  host: string;
  /** The owner's host process; null when no marker names it (listed, never stopped as an orphan). */
  hostPid: number | null;
  hostPidStart: string | null;
  /** The checkout the owner last wrote in, when a marker says. */
  checkout: string | null;
};

export type FoundBrowser = {
  pid: number;
  /** The browser's process group, only when it leads one (its children share it). */
  pgid: number | null;
  cmd: string;
  userDataDir: string;
  /** The `--remote-debugging-port` when it is a fixed one. */
  port: number | null;
  /** The process's working directory, where readable (Linux). */
  cwd: string | null;
  owner: BrowserOwner | null;
};

export type BrowserScan = {
  browsers: FoundBrowser[];
  /** Why the process table could not be read; the scan then found nothing. */
  error: string | null;
  ms: number;
};

const POSIX_TEMP = ["/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/** What a scan reads; tests swap these for a fake process table. */
export const browserDeps = {
  platform: process.platform as string,
  home: (): string => userHome(process.env),
  tempDirs: (): string[] => {
    const temp = os.tmpdir();
    let real = temp;
    try {
      real = fs.realpathSync.native(temp);
    } catch {
      // keep the spelling
    }
    return [...new Set([temp, real, ...(browserDeps.platform === "win32" ? [] : POSIX_TEMP)])];
  },
  hostname: (): string => os.hostname(),
  /**
   * `value` with every symbolic link resolved: the nearest existing ancestor's
   * real path plus the rest. Unchanged when it cannot be read, or when the scan
   * acts as another platform (a test).
   */
  realpath: (value: string): string => {
    if (browserDeps.platform !== process.platform) return value;
    let dir = value;
    const rest: string[] = [];
    while (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) return value;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      return value;
    }
  },
  processes: (): ProcessEntry[] | null => readTable(browserDeps.platform),
  /** The exact argv of `pid`; null where it cannot be read (off Linux). */
  argv: (pid: number): string[] | null => {
    if (browserDeps.platform !== "linux") return null;
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      const argv = raw.split("\0");
      if (argv.at(-1) === "") argv.pop();
      return argv.length ? argv : null;
    } catch {
      return null;
    }
  },
  /** The environment `pid` started with; null where it cannot be read (off Linux, another user). */
  environ: (pid: number): NodeJS.ProcessEnv | null => {
    if (browserDeps.platform !== "linux") return null;
    try {
      const env: NodeJS.ProcessEnv = {};
      for (const pair of fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0")) {
        const at = pair.indexOf("=");
        if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
      }
      return env;
    } catch {
      return null;
    }
  },
  cwd: (pid: number): string | null => {
    if (browserDeps.platform !== "linux") return null;
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------
// reading the process table

/** `ps -A -o pid=,ppid=,pgid=,args=` output (Linux, macOS). */
export function parsePsTable(text: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    if (match)
      entries.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4].trim(),
      });
  }
  return entries;
}

/** The JSON of the Win32_Process query: `{p: pid, q: parent pid, c: command line}`, one object or an array. */
export function parseWin32Table(text: string): ProcessEntry[] | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = Array.isArray(value) ? value : [value];
  return rows.flatMap((row) => {
    const { p, q, c } = (row ?? {}) as { p?: unknown; q?: unknown; c?: unknown };
    if (typeof p !== "number" || typeof q !== "number") return [];
    return [{ pid: p, ppid: q, pgid: null, command: typeof c === "string" ? c : "" }];
  });
}

/** One bounded PowerShell call: every process's id, parent id and command line. */
const WIN32_QUERY =
  "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{p=[int]$_.ProcessId;q=[int]$_.ParentProcessId;c=$_.CommandLine} } | ConvertTo-Json -Compress";

/** Linux: /proc itself, about half the cost of a `ps` call; null when /proc cannot be listed. */
function readProcTable(): ProcessEntry[] | null {
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const entries: ProcessEntry[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const argv = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (argv.at(-1) === "") argv.pop();
      entries.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        command: argv.join(" "),
        argv,
      });
    } catch {
      // it exited meanwhile
    }
  }
  return entries;
}

function readTable(platform: string): ProcessEntry[] | null {
  if (platform === "linux") {
    const entries = readProcTable();
    if (entries) return entries;
  }
  const [command, args] =
    platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN32_QUERY]]
      : ["ps", ["-A", "-ww", "-o", "pid=,ppid=,pgid=,args="]];
  const run = spawnSync(command, args, {
    encoding: "utf8",
    timeout: platform === "win32" ? 10_000 : 2_000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (run.error || run.status !== 0) return null;
  return platform === "win32" ? parseWin32Table(run.stdout) : parsePsTable(run.stdout);
}

/** A Windows command line split the way the C runtime does for the common cases: quotes group, backslashes stay. */
export function splitWindowsCommand(command: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (const char of command) {
    if (char === '"') {
      quoted = !quoted;
      started = true;
    } else if (/\s/u.test(char) && !quoted) {
      if (started) argv.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) argv.push(current);
  return argv;
}

const BROWSER_NAME =
  /^(?:chrome|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable|-canary)?|google chrome(?: for testing| canary| beta| dev)?|chrome-headless-shell|headless_shell|msedge|microsoft-edge(?:-stable|-beta|-dev)?|microsoft edge)(?:\.exe)?$/iu;

/**
 * A `ps` command line (spaces lost, so an app path like `Google Chrome.app`
 * cannot be told from two words): the executable is the shortest prefix that
 * ends in a browser name, and each later ` --` starts a flag.
 */
export function splitPosixCommand(command: string): string[] {
  const ends = [...command.matchAll(/\s/gu)].map((match) => match.index).concat(command.length);
  const exe =
    ends
      .map((end) => command.slice(0, end))
      .find((prefix) => BROWSER_NAME.test(prefix.split("/").at(-1) ?? "")) ??
    command.split(/\s/u)[0];
  const rest = command.slice(exe.length).trim();
  return [exe, ...rest.split(/\s+(?=--)/u).filter(Boolean)];
}

const argvOf = (entry: ProcessEntry, platform: string): string[] =>
  entry.argv ??
  browserDeps.argv(entry.pid) ??
  (platform === "win32" ? splitWindowsCommand(entry.command) : splitPosixCommand(entry.command));

// ---------------------------------------------------------------------------
// the signature

/** Profile dirs (under home) automation tools use by default. */
const AUTOMATION_DIRS = [
  ".cache/chrome-devtools-mcp",
  ".cache/chrome-devtools-mcp-cli",
  ".cache/ms-playwright",
  "Library/Caches/ms-playwright",
  "AppData/Local/ms-playwright",
  ".cache/puppeteer",
  ".agent-browser",
];

/** The browsers' own default profiles: never an automation browser's. */
const DEFAULT_PROFILES = [
  ".config/google-chrome",
  ".config/google-chrome-beta",
  ".config/google-chrome-unstable",
  ".config/chromium",
  ".config/microsoft-edge",
  "snap/chromium/common/chromium",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Google/Chrome Beta",
  "Library/Application Support/Google/Chrome Canary",
  "Library/Application Support/Chromium",
  "Library/Application Support/Microsoft Edge",
  "AppData/Local/Google/Chrome/User Data",
  "AppData/Local/Chromium/User Data",
  "AppData/Local/Microsoft/Edge/User Data",
];

const pathApi = (platform: string): path.PlatformPath =>
  platform === "win32" ? path.win32 : path.posix;

/** `value` with `.`, `..`, doubled and trailing separators resolved; null when it is relative. */
const normalized = (value: string, platform: string): string | null => {
  const api = pathApi(platform);
  return api.isAbsolute(value) ? api.resolve(value) : null;
};

/** The ways one absolute path is spelled: as written (normalized) and with its links resolved. */
const spellings = (value: string): string[] => [...new Set([value, browserDeps.realpath(value)])];

/** A path in one comparable spelling: forward slashes, no trailing one, case folded where the file system folds it. */
const comparable = (value: string, platform: string): string => {
  let spelled = value.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (platform === "win32" || platform === "darwin") spelled = spelled.toLowerCase();
  return spelled;
};

const under = (child: string, parent: string, platform: string): boolean => {
  const a = comparable(child, platform);
  const b = comparable(parent, platform);
  return b !== "" && (a === b || a.startsWith(`${b}/`));
};

/** Is any of `paths` inside any spelling of any of `dirs`? */
const anyUnder = (paths: string[], dirs: string[], platform: string): boolean =>
  paths.some((child) =>
    dirs.some((dir) => spellings(dir).some((parent) => under(child, parent, platform))),
  );

const flag = (argv: readonly string[], name: string): string | null => {
  for (const arg of argv) {
    if (arg === name) return "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).replace(/^"(.*)"$/u, "$1");
  }
  return null;
};

/**
 * The automation browser `argv` describes, or null: a browser main process
 * with remote debugging on and a profile under a temp or automation dir (or a
 * tool-downloaded executable), never on a default profile.
 */
export function automationSignature(
  argv: readonly string[],
  platform: string = browserDeps.platform,
): { userDataDir: string; port: number | null } | null {
  const exe = argv[0] ?? "";
  if (!BROWSER_NAME.test(exe.split(/[\\/]/u).at(-1) ?? "")) return null;
  if (flag(argv, "--type") !== null) return null;
  const port = flag(argv, "--remote-debugging-port");
  if (port === null && flag(argv, "--remote-debugging-pipe") === null) return null;
  const written = flag(argv, "--user-data-dir")?.trim();
  if (!written) return null;
  // Compared only once `..`, doubled slashes and links are resolved: a default profile
  // reached by any path is never an automation browser's.
  const userDataDir = normalized(written, platform);
  if (!userDataDir) return null;
  const forms = spellings(userDataDir);
  const real = forms.at(-1)!;
  const home = browserDeps.home();
  const inHome = (relative: string) => pathApi(platform).join(home, relative);
  if (anyUnder(forms, DEFAULT_PROFILES.map(inHome), platform)) return null;
  const automationDirs = AUTOMATION_DIRS.map(inHome);
  const executable = normalized(exe, platform);
  const automation =
    anyUnder([real], browserDeps.tempDirs(), platform) ||
    anyUnder([real], automationDirs, platform) ||
    (executable !== null && anyUnder(spellings(executable), automationDirs, platform));
  if (!automation) return null;
  const portNumber = port ? Number(port) : 0;
  return { userDataDir, port: Number.isInteger(portNumber) && portNumber > 0 ? portNumber : null };
}

// ---------------------------------------------------------------------------
// owners

/** Every live-session marker on this machine that names a host process. */
function sessionHosts(env: NodeJS.ProcessEnv): SessionHost[] {
  const dir = path.join(stateDir(env), "live-sessions");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
  const machine = browserDeps.hostname();
  return files.flatMap((file) => {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<
        string,
        unknown
      >;
      if (
        typeof value.session !== "string" ||
        typeof value.host !== "string" ||
        typeof value.pid !== "number" ||
        (typeof value.machine === "string" && value.machine !== machine)
      )
        return [];
      return [
        {
          session: value.session,
          leads: Array.isArray(value.leads)
            ? value.leads.filter((lead): lead is string => typeof lead === "string")
            : [],
          host: value.host,
          pid: value.pid,
          pidStart: typeof value.pidStart === "string" ? value.pidStart : null,
          checkout: typeof value.checkout === "string" ? value.checkout : null,
          heartbeatAt: typeof value.heartbeatAt === "string" ? value.heartbeatAt : "",
        },
      ];
    } catch {
      return [];
    }
  });
}

const newest = (hosts: SessionHost[]): SessionHost | undefined =>
  hosts.toSorted((a, b) => b.heartbeatAt.localeCompare(a.heartbeatAt))[0];

/** Owner by the browser's own environment: the session it names, and that session's host when a marker records it. */
function ownerByEnv(pid: number, hosts: SessionHost[]): BrowserOwner | null {
  const env = browserDeps.environ(pid);
  if (!env) return null;
  const { host, session } = hostSessionFromEnv(env);
  if (!session) return null;
  const lead = leadOf(session);
  const marker =
    newest(hosts.filter((entry) => entry.session === session)) ??
    newest(hosts.filter((entry) => leadOf(entry.session) === lead || entry.leads.includes(lead)));
  return {
    proof: "env",
    session,
    host: host ?? marker?.host ?? "unknown",
    hostPid: marker?.pid ?? null,
    hostPidStart: marker?.pidStart ?? null,
    checkout: marker?.checkout ?? null,
  };
}

/** Owner by ancestry: the nearest ancestor that is a marker's host process, still the same process. */
function ownerByAncestry(
  pid: number,
  parents: Map<number, number>,
  hosts: SessionHost[],
): BrowserOwner | null {
  const seen = new Set<number>();
  let current = parents.get(pid);
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current);
    const ancestor = current;
    const markers = hosts.filter((entry) => entry.pid === ancestor);
    if (markers.length) {
      const start = procTree.start(ancestor);
      const same = markers.filter(
        (entry) => entry.pidStart === null || start === null || entry.pidStart === start,
      );
      if (same.length) {
        const sessions = new Set(same.map((entry) => entry.session));
        const latest = newest(same)!;
        return {
          proof: "ancestry",
          // One host process can run several sessions (OpenCode's server, a cleared Claude Code
          // session): name one only when it is the only one.
          session: sessions.size === 1 ? latest.session : null,
          host: latest.host,
          hostPid: ancestor,
          hostPidStart: latest.pidStart ?? start,
          checkout: latest.checkout,
        };
      }
    }
    current = parents.get(current);
  }
  return null;
}

// ---------------------------------------------------------------------------
// the scan

const CANDIDATE = /--remote-debugging-(?:port|pipe)/u;

/**
 * Every automation browser running now, with its owner where one is proved.
 * Fails open: an unreadable process table finds nothing and says why.
 */
export function scanBrowsers(env: NodeJS.ProcessEnv): BrowserScan {
  const started = performance.now();
  const done = (browsers: FoundBrowser[], error: string | null): BrowserScan => ({
    browsers,
    error,
    ms: Math.round(performance.now() - started),
  });
  const platform = browserDeps.platform;
  let table: ProcessEntry[] | null;
  try {
    table = browserDeps.processes();
  } catch (error) {
    return done([], (error as Error).message);
  }
  if (!table) return done([], "the process table could not be read");
  const parents = new Map(table.map((entry) => [entry.pid, entry.ppid]));
  let hosts: SessionHost[] | null = null;
  const browsers: FoundBrowser[] = [];
  for (const entry of table) {
    if (!CANDIDATE.test(entry.command) && !entry.argv?.some((arg) => CANDIDATE.test(arg))) continue;
    const argv = argvOf(entry, platform);
    const signature = automationSignature(argv, platform);
    if (!signature) continue;
    hosts ??= sessionHosts(env);
    browsers.push({
      pid: entry.pid,
      pgid: entry.pgid === entry.pid ? entry.pid : null,
      cmd: argv.join(" ").slice(0, 300),
      userDataDir: signature.userDataDir,
      port: signature.port,
      cwd: browserDeps.cwd(entry.pid),
      owner: ownerByEnv(entry.pid, hosts) ?? ownerByAncestry(entry.pid, parents, hosts),
    });
  }
  return done(browsers, null);
}
