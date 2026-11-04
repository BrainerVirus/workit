// `workit youtrack show|create` (#263): issue reads and creates go through
// `ytrack … --json` (BrainerVirus/youtrack-cli, token in the OS keyring) when
// it is on PATH, and through the built-in client (youtrack.json + token file)
// otherwise, or when ytrack answers "authentication required" (exit 4). The
// caller never sees the token: ytrack holds its own, and the built-in path
// redacts it from every error it returns.
import { spawnSync } from "node:child_process";
import { findExecutable } from "../forge/exec";
import { redact } from "./youtrack-tools";
import { youTrackBaseUrl, youTrackRequest, youTrackToken } from "./youtrack";

export const YT_WRITE_GATE = "WORKIT_YT_WRITE";

export type YtrackResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  missing?: boolean;
};
export type YtrackRun = (args: string[], input?: string) => YtrackResult;

export type IssueDeps = {
  ytrack: YtrackRun;
  creds: typeof youTrackToken;
  request: typeof youTrackRequest;
};

const YTRACK_TIMEOUT_MS = 60_000;

/** The real `ytrack`, aimed at youtrack.json's baseUrl when one is configured. */
export function ytrackRunner(env: NodeJS.ProcessEnv): YtrackRun {
  return (args, input) => {
    const exe = findExecutable("ytrack", env);
    if (!exe) return { status: null, stdout: "", stderr: "", missing: true };
    const base = youTrackBaseUrl();
    const result = spawnSync(exe, args, {
      encoding: "utf8",
      env: { ...env, NO_COLOR: "1", ...(base ? { YTRACK_HOST: base } : {}) },
      timeout: YTRACK_TIMEOUT_MS,
      killSignal: "SIGKILL",
      windowsHide: true,
      ...(input === undefined
        ? { stdio: ["ignore", "pipe", "pipe"] as const }
        : { input, stdio: ["pipe", "pipe", "pipe"] as const }),
    });
    const error: NodeJS.ErrnoException | undefined = result.error;
    if (error?.code === "ENOENT") return { status: null, stdout: "", stderr: "", missing: true };
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr || (error ? error.message : ""),
    };
  };
}

export const defaultIssueDeps = (env: NodeJS.ProcessEnv): IssueDeps => ({
  ytrack: ytrackRunner(env),
  creds: youTrackToken,
  request: youTrackRequest,
});

export type IssueComment = {
  id: string;
  text: string;
  author: string | null;
  created: string | null;
};
export type IssueView = {
  issueId: string;
  summary: string;
  description: string | null;
  state: string | null;
  url: string | null;
  fields: { name: string; value: unknown }[];
  comments: IssueComment[];
  source: "ytrack" | "api";
};
export type Created = { issueId: string; url: string | null; source: "ytrack" | "api" };

export type IssueOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: "unavailable" | "failed" | "not_found" | "blocked";
      error: string;
      unblock?: string;
    };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A field value as one readable scalar: an enum's name, a user's login, a period's text. */
function plainValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainValue);
  if (!isObj(value)) return value ?? null;
  for (const key of ["name", "login", "presentation", "text", "fullName"])
    if (typeof value[key] === "string") return value[key];
  return null;
}

const isoTime = (value: unknown): string | null =>
  typeof value === "number" ? new Date(value).toISOString() : str(value);

function comments(raw: unknown): IssueComment[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Obj => isObj(item) && item.deleted !== true)
    .map((item) => ({
      id: String(item.id ?? ""),
      text: str(item.text) ?? "",
      author: isObj(item.author)
        ? (str(item.author.login) ?? str(item.author.fullName))
        : str(item.author),
      created: isoTime(item.created),
    }));
}

function fields(raw: unknown): { name: string; value: unknown }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((field): field is Obj => isObj(field) && typeof field.name === "string")
    .map((field) => ({ name: field.name as string, value: plainValue(field.value) }));
}

const stateOf = (list: { name: string; value: unknown }[]): string | null =>
  str(list.find((field) => field.name === "State")?.value);

/** Normalize `ytrack issue view --json …` or the REST issue into one shape. */
function issueView(raw: Obj, source: IssueView["source"], base: string | null): IssueView {
  const list = fields(raw.customFields);
  const issueId = String(raw.idReadable ?? "");
  const state = source === "ytrack" ? (str(plainValue(raw.state)) ?? stateOf(list)) : stateOf(list);
  return {
    issueId,
    summary: str(raw.summary) ?? "",
    description: str(raw.description),
    state,
    url: str(raw.url) ?? (base && issueId ? `${base}/issue/${issueId}` : null),
    fields: list,
    comments: comments(raw.comments),
    source,
  };
}

const YTRACK_VIEW_FIELDS = "idReadable,summary,description,state,url,customFields,comments";
const API_VIEW_FIELDS =
  "idReadable,summary,description,customFields(name,value(name,login,fullName,presentation,text)),comments(id,text,author(login,fullName),created,deleted)";

/** ytrack's answer, or "fallback" when the built-in client should take over. */
function viaYtrack(
  run: YtrackRun,
  args: string[],
  input?: string,
): { ok: true; json: unknown } | { ok: false; error: string } | "fallback" {
  const out = run(args, input);
  // Missing ytrack, or not logged in (exit 4): the built-in client may still have a token.
  if (out.missing || out.status === 4) return "fallback";
  const detail = out.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  if (out.status !== 0)
    return {
      ok: false,
      error: `ytrack ${args.slice(0, 2).join(" ")} failed (exit ${out.status ?? "signal"})${detail ? `: ${detail}` : ""}`,
    };
  try {
    return { ok: true, json: JSON.parse(out.stdout) as unknown };
  } catch {
    return { ok: false, error: "ytrack printed invalid JSON" };
  }
}

const noCredentials = (error: string): IssueOutcome<never> => ({
  ok: false,
  code: "unavailable",
  error: `YouTrack is not reachable: ytrack is missing or logged out, and the built-in client has no credentials (${error})`,
  unblock: "ytrack auth login (preferred), or configure youtrack.json and its token file",
});

/** Read one issue: summary, state, custom fields and comments. */
export async function showIssue(
  issueId: string,
  deps: IssueDeps,
): Promise<IssueOutcome<IssueView>> {
  const viaCli = viaYtrack(deps.ytrack, ["issue", "view", issueId, "--json", YTRACK_VIEW_FIELDS]);
  if (viaCli !== "fallback") {
    if (!viaCli.ok) return { ok: false, code: "failed", error: viaCli.error };
    if (!isObj(viaCli.json)) return { ok: false, code: "failed", error: "ytrack printed no issue" };
    return { ok: true, data: issueView(viaCli.json, "ytrack", null) };
  }
  const creds = deps.creds();
  if ("error" in creds) return noCredentials(creds.error);
  const out = await deps.request(
    `${creds.base}/api/issues/${encodeURIComponent(issueId)}?fields=${API_VIEW_FIELDS}`,
    { method: "GET", token: creds.token },
  );
  if (out.status === 404)
    return { ok: false, code: "not_found", error: `${issueId} was not found on ${creds.base}` };
  if (out.status !== 0)
    return {
      ok: false,
      code: "failed",
      error: redact(`YouTrack issue read failed (${out.status}): ${out.stderr}`, creds.token),
    };
  try {
    const parsed = JSON.parse(out.stdout) as unknown;
    if (!isObj(parsed)) throw new Error("not an object");
    return { ok: true, data: issueView(parsed, "api", creds.base) };
  } catch {
    return { ok: false, code: "failed", error: "invalid JSON from YouTrack API" };
  }
}

export type CreateInput = { project: string; summary: string; description?: string };

/** Create one issue; refused unless WORKIT_YT_WRITE=1, like every other YouTrack write. */
export async function createIssue(
  input: CreateInput,
  env: NodeJS.ProcessEnv,
  deps: IssueDeps,
): Promise<IssueOutcome<Created>> {
  if (env[YT_WRITE_GATE] !== "1")
    return {
      ok: false,
      code: "blocked",
      error: `creating a YouTrack issue requires ${YT_WRITE_GATE}=1 (refusing to mutate the tracker)`,
      unblock: `set ${YT_WRITE_GATE}=1 for this command once the user asked for the issue`,
    };
  const args = ["issue", "create", "--project", input.project, "--summary", input.summary];
  if (input.description !== undefined) args.push("--description-file", "-");
  args.push("--json", "idReadable,url");
  const viaCli = viaYtrack(deps.ytrack, args, input.description);
  if (viaCli !== "fallback") {
    if (!viaCli.ok) return { ok: false, code: "failed", error: viaCli.error };
    const json = isObj(viaCli.json) ? viaCli.json : {};
    return {
      ok: true,
      data: { issueId: String(json.idReadable ?? ""), url: str(json.url), source: "ytrack" },
    };
  }
  const creds = deps.creds();
  if ("error" in creds) return noCredentials(creds.error);
  const projects = await deps.request(
    `${creds.base}/api/admin/projects?fields=id,shortName,name&$top=1000`,
    { method: "GET", token: creds.token },
  );
  if (projects.status !== 0)
    return {
      ok: false,
      code: "failed",
      error: redact(
        `YouTrack project lookup failed (${projects.status}): ${projects.stderr}`,
        creds.token,
      ),
    };
  let projectId: string | null = null;
  try {
    const list = JSON.parse(projects.stdout) as unknown;
    const want = input.project.toLowerCase();
    const match = Array.isArray(list)
      ? list.find(
          (item): item is Obj =>
            isObj(item) &&
            (String(item.shortName ?? "").toLowerCase() === want ||
              String(item.name ?? "").toLowerCase() === want),
        )
      : undefined;
    projectId = match ? String(match.id) : null;
  } catch {
    return { ok: false, code: "failed", error: "invalid JSON from YouTrack API" };
  }
  if (!projectId)
    return { ok: false, code: "not_found", error: `no YouTrack project named ${input.project}` };
  const created = await deps.request(`${creds.base}/api/issues?fields=idReadable`, {
    method: "POST",
    token: creds.token,
    body: {
      project: { id: projectId },
      summary: input.summary,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
  });
  if (created.status !== 0)
    return {
      ok: false,
      code: created.status === 1 ? "unavailable" : "failed",
      error: redact(
        `YouTrack issue create failed (${created.status}): ${created.stderr}`,
        creds.token,
      ),
      ...(created.status === 1
        ? {
            unblock: `search ${input.project} for "${input.summary}" before retrying: the outcome is unknown`,
          }
        : {}),
    };
  try {
    const parsed = JSON.parse(created.stdout) as Obj;
    const issueId = String(parsed.idReadable ?? "");
    return {
      ok: true,
      data: { issueId, url: issueId ? `${creds.base}/issue/${issueId}` : null, source: "api" },
    };
  } catch {
    return { ok: false, code: "failed", error: "invalid JSON from YouTrack API" };
  }
}
