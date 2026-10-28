import path from "node:path";
import { type HostId } from "../admin/detect-hosts";
import { runner, type HostProcess, type UpgradeDeps } from "./shared";

/** A host process that matters to an upgrade: an interactive session Workit
 *  never kills, or a background daemon the host's own command can stop. */
export type Running = HostProcess & {
  host: HostId;
  kind: "session" | "daemon";
};

const PROCESS_HOSTS: Record<string, HostId> = {
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  pi: "pi",
};

/** Classify one listed process. Zombies, and helpers that load no plugin
 *  (Codex's `app-server daemon pid-update-loop` watcher), are not running hosts. */
export const classifyProcess = (proc: HostProcess): Running | null => {
  if (proc.state.startsWith("Z") || proc.args.includes("<defunct>")) return null;
  const argv0 = proc.args.trim().split(/\s+/)[0] ?? "";
  const name = path
    .basename(argv0.replaceAll("\\", "/"))
    .replace(/^\[|\]$/g, "")
    .replace(/\.exe$/i, "")
    .toLowerCase();
  const host = PROCESS_HOSTS[name];
  if (!host) return null;
  if (host === "codex" && /\bapp-server\b/.test(proc.args))
    return /\bdaemon\s+pid-update-loop\b/.test(proc.args)
      ? null
      : { ...proc, host, kind: "daemon" };
  if (host === "opencode" && /\bserve\b/.test(proc.args)) return { ...proc, host, kind: "daemon" };
  return { ...proc, host, kind: "session" };
};

export const listProcesses = (deps: UpgradeDeps): HostProcess[] | null => {
  if (deps.processes) return deps.processes();
  if (deps.activeHosts)
    return deps.activeHosts().map((host) => ({ pid: 0, state: "S", args: host }));
  const run = runner(deps);
  if (process.platform === "win32") {
    const list = run("tasklist", ["/fo", "csv", "/nh"]);
    if (list.status !== 0) return null;
    return list.stdout.split(/\r?\n/).flatMap((line) => {
      const [image, pid] = line.split('","').map((cell) => cell.replaceAll('"', ""));
      return image && /^\d+$/.test(pid ?? "")
        ? [{ pid: Number(pid), state: "R", args: image }]
        : [];
    });
  }
  const list = run("ps", ["-eo", "pid=,stat=,args="]);
  if (list.status !== 0) return null;
  return list.stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), state: match[2], args: match[3] }] : [];
  });
};

export const describe = (proc: Running): string =>
  `pid ${proc.pid}: ${proc.args.length > 120 ? `${proc.args.slice(0, 117)}...` : proc.args}`;
