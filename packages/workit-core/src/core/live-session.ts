// Live-session markers (#274): which agent session last wrote in a checkout,
// so another session's write gate can refuse to edit a checkout a live agent
// owns. One marker per checkout (a worktree's top level: worktrees of one
// repository are distinct checkouts) in the per-user state dir, so nothing is
// written into a repository Workit does not manage:
// `<state>/live-sessions/<hash of the checkout>.json`, holding the owner's
// session, lead, host, process id, machine and heartbeat. The hooks each host
// already runs write it on every allowed edit or mutating command.
//
// A marker is live while its heartbeat is younger than LIVE_SESSION_TTL_MS
// and, on the same machine, its process still runs. The owning session, its
// subagents (`<lead>:<agent>`, `<lead>-w-<slice>`, a parent session) and any
// session in the same host process are never refused. Every state error reads
// as "no marker": the guard fails open.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStore } from "../store/paths";
import { resolveStateDir } from "./logger";

export const LIVE_SESSION_TTL_MS = 15 * 60_000;
/** Rewrite a live marker of one's own at most this often. */
const HEARTBEAT_EVERY_MS = 30_000;

export type LiveOwner = {
  host: string;
  session: string;
  /** Lead ids this session counts as (its own lead, its parent's). */
  leads: string[];
  /** The host process (null when it cannot be told). */
  pid: number | null;
};

export type LiveMarker = {
  version: 1;
  session: string;
  leads: string[];
  host: string;
  pid: number | null;
  machine: string;
  checkout: string;
  heartbeatAt: string;
};

export type LiveDeps = {
  now?: Date;
  alive?: (pid: number) => boolean;
  machine?: string;
  ttlMs?: number;
};

/** A session's lead: the part before `:` (an issued subagent id), minus a fanout `-w-<slice>` tail. */
export const leadOf = (session: string): string =>
  session.split(":")[0].replace(/-w-.*$/su, "") || session;

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Parent pid and command line of `pid`: /proc on Linux, `ps` on other POSIX systems. */
const processInfo = (pid: number): { ppid: number; command: string } | null => {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const command = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      return Number.isInteger(ppid) ? { ppid, command: command.trim() } : null;
    }
    if (process.platform === "win32") return null;
    const run = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const match = /^\s*(\d+)\s+(.*)$/su.exec(run.stdout ?? "");
    return match ? { ppid: Number(match[1]), command: match[2].trim() } : null;
  } catch {
    return null;
  }
};

/** A process that only launches the hook and exits with it: a shell, npx, the Cursor launcher. */
const WRAPPER =
  /^(?:\S*\/)?(?:sh|bash|dash|zsh|ash|ksh|fish|env|timeout|npx|npm|bunx|cmd\.exe|pwsh|powershell)(?:\s|$)|launch\.mjs|npx-cli\.js/u;

/**
 * The long-lived host process behind this hook: the plugin's own process for
 * an in-process host (OpenCode, Pi); for a hook process (Claude Code, Codex,
 * Cursor), the nearest ancestor that is not a launcher wrapper. Null when the
 * ancestry cannot be read (Windows): the heartbeat alone then bounds the marker.
 */
export const hostPid = (transport: string): number | null => {
  if (transport !== "hook-process") return process.pid;
  let pid = process.ppid;
  for (let hop = 0; hop < 4; hop++) {
    const info = processInfo(pid);
    if (!info) return process.platform === "win32" ? null : pid;
    if (!WRAPPER.test(info.command) || info.ppid <= 1) return pid;
    pid = info.ppid;
  }
  return pid;
};

const sessionSafe = (value: string): string => value.replace(/[^A-Za-z0-9_.:@/+-]/gu, "-");

/** The owner a hook acts for, or null without a session id (never refused, never recorded). */
export const liveOwner = (
  input: { host: string; session: { id: string; parentId: string | null } },
  transport: string,
  env: NodeJS.ProcessEnv = process.env,
): LiveOwner | null => {
  const session = input.session.id?.trim();
  if (!session) return null;
  const leads = new Set([leadOf(sessionSafe(session))]);
  if (input.session.parentId) leads.add(leadOf(sessionSafe(input.session.parentId)));
  // A Pi worker's hooks see its own Pi session; its workit id names the lead.
  if (env.WORKIT_PI_WORKER_SESSION && env.WORKIT_SESSION_ID)
    leads.add(leadOf(sessionSafe(env.WORKIT_SESSION_ID)));
  return {
    host: input.host,
    session: sessionSafe(session),
    leads: [...leads],
    pid: hostPid(transport),
  };
};

/** The checkout (worktree top level) holding `target`; null outside git. */
const checkoutOf = (target: string): string | null => {
  let dir = path.resolve(target);
  // A path that does not exist yet: its nearest existing ancestor.
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  const location = resolveStore(dir);
  if (location instanceof Error || !location.shared || !location.top) return null;
  let top = location.top;
  try {
    top = fs.realpathSync.native(top);
  } catch {
    // keep git's spelling
  }
  return top;
};

/** The marker file of a checkout. */
export const markerFile = (top: string): string =>
  path.join(
    resolveStateDir(),
    "live-sessions",
    `${createHash("sha256").update(top).digest("hex").slice(0, 32)}.json`,
  );

const readMarker = (file: string): LiveMarker | null => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LiveMarker>;
    if (
      value?.version !== 1 ||
      typeof value.session !== "string" ||
      typeof value.host !== "string" ||
      typeof value.heartbeatAt !== "string" ||
      Number.isNaN(Date.parse(value.heartbeatAt))
    )
      return null;
    return {
      version: 1,
      session: value.session,
      leads: Array.isArray(value.leads)
        ? value.leads.filter((item) => typeof item === "string")
        : [],
      host: value.host,
      pid: typeof value.pid === "number" ? value.pid : null,
      machine: typeof value.machine === "string" ? value.machine : "",
      checkout: typeof value.checkout === "string" ? value.checkout : "",
      heartbeatAt: value.heartbeatAt,
    };
  } catch {
    return null;
  }
};

const ageOf = (marker: LiveMarker, now: Date): number =>
  now.getTime() - Date.parse(marker.heartbeatAt);

/** Whether the marker's owner still counts: a fresh heartbeat and, on this machine, a running process. */
const isLive = (marker: LiveMarker, deps: LiveDeps): boolean => {
  const age = ageOf(marker, deps.now ?? new Date());
  if (age > (deps.ttlMs ?? LIVE_SESSION_TTL_MS)) return false;
  const local = marker.machine === (deps.machine ?? os.hostname());
  return !(local && marker.pid !== null && !(deps.alive ?? processAlive)(marker.pid));
};

/** The same session, one of its subagents or its lead, or another session of the same host process. */
export const sameOwner = (marker: LiveMarker, owner: LiveOwner, machine: string): boolean =>
  marker.session === owner.session ||
  owner.leads.some((lead) => lead === marker.session || marker.leads.includes(lead)) ||
  (owner.pid !== null && marker.pid === owner.pid && marker.machine === machine);

export type LiveConflict = { marker: LiveMarker; file: string; ageMs: number; checkout: string };

/** The live marker of another session in `target`'s checkout, or null (also on any error). */
export const liveConflict = (
  target: string,
  owner: LiveOwner,
  deps: LiveDeps = {},
): LiveConflict | null => {
  try {
    const checkout = checkoutOf(target);
    if (!checkout) return null;
    const file = markerFile(checkout);
    const marker = readMarker(file);
    if (!marker || !isLive(marker, deps)) return null;
    if (sameOwner(marker, owner, deps.machine ?? os.hostname())) return null;
    return { marker, file, ageMs: ageOf(marker, deps.now ?? new Date()), checkout };
  } catch {
    return null;
  }
};

/**
 * Record `owner` as the live session of `target`'s checkout (a fresh
 * heartbeat), unless another live session owns it. Never throws.
 */
export const claimLiveSession = (target: string, owner: LiveOwner, deps: LiveDeps = {}): void => {
  try {
    const checkout = checkoutOf(target);
    if (!checkout) return;
    const file = markerFile(checkout);
    const now = deps.now ?? new Date();
    const machine = deps.machine ?? os.hostname();
    const current = readMarker(file);
    if (current && isLive(current, deps)) {
      if (!sameOwner(current, owner, machine)) return;
      if (
        current.session === owner.session &&
        current.pid === owner.pid &&
        ageOf(current, now) < HEARTBEAT_EVERY_MS
      )
        return;
    }
    const marker: LiveMarker = {
      version: 1,
      session: owner.session,
      leads: owner.leads,
      host: owner.host,
      pid: owner.pid,
      machine,
      checkout,
      heartbeatAt: now.toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(marker));
    fs.renameSync(temp, file);
  } catch {
    // Fail open: without a marker nobody is refused.
  }
};
