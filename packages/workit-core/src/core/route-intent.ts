import { TaskStore } from "./task-store";

export type ShellRouteIntent = {
  route: "git.branch_setup" | "hosting.pull_request" | "hosting.merge";
  guidance: string;
};

const GUIDANCE: Record<ShellRouteIntent["route"], string> = {
  "git.branch_setup":
    "use the Workit git.branch_setup action (workit_external_action in hosts, or `workit action git.branch_setup --payload '{}' --confirm --json` in the CLI)",
  "hosting.pull_request":
    "use the Workit hosting.pull_request action (workit_external_action in hosts, or `workit action hosting.pull_request --payload '{...}' --confirm --json` in the CLI), then drive the created PR through workit-babysit",
  "hosting.merge":
    "use the Workit hosting.merge action (workit_external_action in hosts, or `workit action hosting.merge --payload '{...}' --confirm --json` in the CLI)",
};

const unbalancedQuotes = (segment: string): boolean => {
  const text = segment.replace(/\\./gu, "");
  return (text.match(/"/gu)?.length ?? 0) % 2 !== 0 || (text.match(/'/gu)?.length ?? 0) % 2 !== 0;
};

const segmentTokens = (segment: string): string[] | null => {
  if (segment.includes("`") || segment.includes("$(")) return null;
  if (unbalancedQuotes(segment)) return null;
  const parts = segment.trim().split(/\s+/u);
  while (parts.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(parts[0])) parts.shift();
  return parts.length > 0 ? parts : null;
};

const unquote = (token: string): string => token.replace(/^['"]|['"]$/gu, "");

/**
 * Narrow recognizer for direct branch and PR creation commands. It returns null
 * for everything it cannot classify unambiguously, so hosts deny only the exact
 * routes that must go through the shared action reservation.
 */
export function shellRouteIntent(command: string): ShellRouteIntent | null {
  if (typeof command !== "string" || command.trim() === "") return null;
  for (const raw of command.split(/&&|\|\||;|\n/u)) {
    const parts = segmentTokens(raw);
    if (!parts) continue;
    const head = unquote(parts[0]);
    const second = unquote(parts[1] ?? "");
    const third = unquote(parts[2] ?? "");
    if (head === "git" && second === "switch" && (third === "-c" || third === "--create"))
      return { route: "git.branch_setup", guidance: GUIDANCE["git.branch_setup"] };
    if (head === "git" && second === "checkout" && (third === "-b" || third === "-B"))
      return { route: "git.branch_setup", guidance: GUIDANCE["git.branch_setup"] };
    if (head === "gh" && second === "pr" && third === "create")
      return { route: "hosting.pull_request", guidance: GUIDANCE["hosting.pull_request"] };
    if (head === "glab" && second === "mr" && third === "create")
      return { route: "hosting.pull_request", guidance: GUIDANCE["hosting.pull_request"] };
    if (head === "gh" && second === "pr" && third === "merge")
      return { route: "hosting.merge", guidance: GUIDANCE["hosting.merge"] };
    if (head === "glab" && second === "mr" && third === "merge")
      return { route: "hosting.merge", guidance: GUIDANCE["hosting.merge"] };
  }
  return null;
}

/**
 * Session-scoped enforcement: the denial protects live Workit coordination,
 * so it fires only where an active or paused task exists. Any filesystem or
 * storage failure means "no live task" — never deny on uncertainty.
 */
export function hasLiveWorkitTask(dir: string): boolean {
  try {
    if (typeof dir !== "string" || dir === "") return false;
    const listed = new TaskStore(dir).listTasks();
    if (!listed.ok) return false;
    return listed.data.some((task) => task.status === "active" || task.status === "paused");
  } catch {
    return false;
  }
}

/**
 * Single core gate for the shell route denial. Adapters pass their
 * session/project directory and delete local deny duplication; outside
 * attributed sessions the command is silently allowed.
 */
export function shouldDenyShellRoute(dir: string, command: string): ShellRouteIntent | null {
  if (!hasLiveWorkitTask(dir)) return null;
  return shellRouteIntent(command);
}
