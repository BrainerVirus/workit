// The one seam between Workit and YouTrack (#263). Every Workit YouTrack
// operation (issue read and create, comments, work items, the marker
// read-back) goes through a YouTrackBackend:
//
//   ytrack   `ytrack … --json` (BrainerVirus/youtrack-cli). Chosen whenever
//            ytrack is on PATH; Workit then never reads its own token file.
//   builtin  youtrack.json + token file over fetch. Only when ytrack is
//            missing; removing it later is deleting builtinBackend and the
//            branch in youTrackBackend().
//
// ytrack exits 0 ok, 1 failed, 2 cancelled, 4 authentication required. Exit 4
// never falls back to the token file: it is `unavailable` with
// `ytrack auth login` as the unblock.
import {
  YTRACK_EXIT,
  findYtrack,
  ytrackDetail,
  ytrackRunner,
  type YtrackRun,
} from "./youtrack-ytrack";
import { youTrackApi, youTrackBaseUrl, youTrackRequest, youTrackToken } from "./youtrack";

export const YT_WRITE_GATE = "WORKIT_YT_WRITE";

type Obj = Record<string, unknown>;

export type IssueComment = {
  id: string;
  text: string;
  author: string | null;
  created: string | null;
};
export type BackendKind = "ytrack" | "builtin";
export type IssueView = {
  issueId: string;
  summary: string;
  description: string | null;
  state: string | null;
  url: string | null;
  fields: { name: string; value: unknown }[];
  comments: IssueComment[];
  source: BackendKind;
};
export type Created = { issueId: string; url: string | null; source: BackendKind };
export type CreateInput = { project: string; summary: string; description?: string };
export type WorkItemInput = { minutes: number; text: string; dateMs: number };

type FailCode = "unavailable" | "failed" | "not_found" | "blocked";
export type IssueOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: FailCode; error: string; unblock?: string };

/** A write's result; `outcome` says whether it surely did not land. */
export type WriteResult =
  | { ok: true; data: Obj }
  | { ok: false; error: string; outcome: "not_applied" | "unknown"; unblock?: string };

/** The texts on an issue; `complete` is false when older items may be missing. */
export type Texts = { texts: string[]; complete: boolean };

export interface YouTrackBackend {
  readonly kind: BackendKind;
  showIssue(issueId: string): Promise<IssueOutcome<IssueView>>;
  createIssue(input: CreateInput): Promise<IssueOutcome<Created>>;
  addComment(issueId: string, text: string): Promise<WriteResult>;
  addWorkItem(issueId: string, item: WorkItemInput): Promise<WriteResult>;
  /** Comment or work item texts, for the marker read-back; null when unreadable. */
  texts(issueId: string, where: "comments" | "workItems"): Promise<Texts | null>;
}

const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

/** Normalize `ytrack issue view --json …` or the REST issue into one shape. */
function issueView(raw: Obj, source: BackendKind, base: string | null): IssueView {
  const list = fields(raw.customFields);
  const issueId = String(raw.idReadable ?? "");
  const stateField = str(list.find((field) => field.name === "State")?.value);
  return {
    issueId,
    summary: str(raw.summary) ?? "",
    description: str(raw.description),
    state: str(plainValue(raw.state)) ?? stateField,
    url: str(raw.url) ?? (base && issueId ? `${base}/issue/${issueId}` : null),
    fields: list,
    comments: comments(raw.comments),
    source,
  };
}

/** YYYY-MM-DD of a YouTrack work date (midnight UTC). */
const workDay = (dateMs: number): string => new Date(dateMs).toISOString().slice(0, 10);

// ---------------------------------------------------------------- ytrack

const VIEW_FIELDS = "idReadable,summary,description,state,url,customFields,comments";
const LOGIN = "ytrack auth login";

type Ran = { ok: true; json: unknown } | { ok: false; status: number | null; error: string };
type RanFailure = Extract<Ran, { ok: false }>;

function ranJson(run: YtrackRun, args: string[], input?: string): Ran {
  const out = run(args, input);
  const what = `ytrack ${args.slice(0, 2).join(" ")}`;
  if (out.missing) return { ok: false, status: null, error: `${what}: ytrack is not on PATH` };
  if (out.status !== YTRACK_EXIT.ok) {
    const detail = ytrackDetail(out);
    return {
      ok: false,
      status: out.status,
      error: `${what} failed (exit ${out.status ?? "signal"})${detail ? `: ${detail}` : ""}`,
    };
  }
  try {
    return { ok: true, json: JSON.parse(out.stdout) as unknown };
  } catch {
    return { ok: false, status: out.status, error: `${what} printed invalid JSON` };
  }
}

const readFailure = (ran: RanFailure): IssueOutcome<never> =>
  ran.status === YTRACK_EXIT.auth
    ? { ok: false, code: "unavailable", error: ran.error, unblock: LOGIN }
    : ran.status === null
      ? { ok: false, code: "unavailable", error: ran.error }
      : { ok: false, code: "failed", error: ran.error };

/**
 * A failed ytrack write: auth (4), cancel (2) and a missing binary sent
 * nothing; any other failure may have landed, so the caller reads back.
 */
const writeFailure = (ran: RanFailure): WriteResult => ({
  ok: false,
  error: ran.error,
  outcome:
    ran.status === YTRACK_EXIT.auth || ran.status === YTRACK_EXIT.cancelled || ran.status === null
      ? "not_applied"
      : "unknown",
  ...(ran.status === YTRACK_EXIT.auth ? { unblock: LOGIN } : {}),
});

export function ytrackBackend(run: YtrackRun): YouTrackBackend {
  return {
    kind: "ytrack",
    async showIssue(issueId) {
      const ran = ranJson(run, ["issue", "view", issueId, "--json", VIEW_FIELDS]);
      if (!ran.ok) return readFailure(ran);
      if (!isObj(ran.json)) return { ok: false, code: "failed", error: "ytrack printed no issue" };
      return { ok: true, data: issueView(ran.json, "ytrack", null) };
    },
    async createIssue(input) {
      const args = ["issue", "create", "--project", input.project, "--summary", input.summary];
      if (input.description !== undefined) args.push("--description-file", "-");
      args.push("--json", "idReadable,url");
      const ran = ranJson(run, args, input.description);
      if (!ran.ok) return readFailure(ran);
      const json = isObj(ran.json) ? ran.json : {};
      return {
        ok: true,
        data: { issueId: String(json.idReadable ?? ""), url: str(json.url), source: "ytrack" },
      };
    },
    async addComment(issueId, text) {
      const ran = ranJson(
        run,
        ["issue", "comment", issueId, "--body-file", "-", "--json", "id,url"],
        text,
      );
      if (!ran.ok) return writeFailure(ran);
      return { ok: true, data: { issueId, ...(isObj(ran.json) ? ran.json : {}) } };
    },
    async addWorkItem(issueId, item) {
      const ran = ranJson(run, [
        "work-item",
        "add",
        issueId,
        "--duration",
        String(item.minutes),
        "--date",
        workDay(item.dateMs),
        "--text",
        item.text,
        "--json",
        "id,date,duration",
      ]);
      if (!ran.ok) return writeFailure(ran);
      const json = isObj(ran.json) ? ran.json : {};
      return {
        ok: true,
        data: { issueId, workItemId: json.id, minutes: item.minutes, dateMs: item.dateMs },
      };
    },
    async texts(issueId, where) {
      const ran =
        where === "comments"
          ? ranJson(run, ["issue", "view", issueId, "--json", "comments"])
          : ranJson(run, ["work-item", "list", issueId, "--json", "id,text"]);
      if (!ran.ok) return null;
      const list = where === "comments" && isObj(ran.json) ? ran.json.comments : ran.json;
      if (!Array.isArray(list)) return null;
      // ytrack lists every item (no page cap) and leaves deleted comments out.
      return {
        texts: list.flatMap((item) =>
          isObj(item) && typeof item.text === "string" ? [item.text] : [],
        ),
        complete: true,
      };
    },
  };
}

// ---------------------------------------------------------------- builtin
// The token-file fallback. Delete this section once ytrack is required.

type BuiltinDeps = {
  creds: typeof youTrackToken;
  request: typeof youTrackRequest;
  api: (args: string[]) => ReturnType<typeof youTrackApi>;
};

const redact = (text: string, token: string) => text.split(token).join("[REDACTED]");
const PAGE = 500;
const API_VIEW_FIELDS =
  "idReadable,summary,description,customFields(name,value(name,login,fullName,presentation,text)),comments(id,text,author(login,fullName),created,deleted)";

const noCredentials = (error: string): IssueOutcome<never> => ({
  ok: false,
  code: "unavailable",
  error: `ytrack is not on PATH and the built-in client has no credentials (${error})`,
  unblock: `install ytrack and run ${LOGIN} (the secure path), or configure youtrack.json and its token file`,
});

export function builtinBackend(
  deps: BuiltinDeps = {
    creds: youTrackToken,
    request: youTrackRequest,
    // The write gate is checked once by the caller (youTrackWriteGate).
    api: (args) => youTrackApi(args, "1"),
  },
): YouTrackBackend {
  const apiWrite = async (args: string[]): Promise<WriteResult> => {
    try {
      const out = await deps.api(args);
      if ("error" in out) return { ok: false, error: out.error, outcome: "unknown" };
      return { ok: true, data: out.data };
    } catch (error) {
      return { ok: false, error: errorText(error), outcome: "unknown" };
    }
  };
  return {
    kind: "builtin",
    async showIssue(issueId) {
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
        return { ok: true, data: issueView(parsed, "builtin", creds.base) };
      } catch {
        return { ok: false, code: "failed", error: "invalid JSON from YouTrack API" };
      }
    },
    async createIssue(input) {
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
        return {
          ok: false,
          code: "not_found",
          error: `no YouTrack project named ${input.project}`,
        };
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
        const issueId = String((JSON.parse(created.stdout) as Obj).idReadable ?? "");
        return {
          ok: true,
          data: {
            issueId,
            url: issueId ? `${creds.base}/issue/${issueId}` : null,
            source: "builtin",
          },
        };
      } catch {
        return { ok: false, code: "failed", error: "invalid JSON from YouTrack API" };
      }
    },
    addComment: (issueId, text) => apiWrite(["post-comment", issueId, text]),
    addWorkItem: (issueId, item) =>
      apiWrite(["log-time", issueId, String(item.minutes), item.text, String(item.dateMs)]),
    async texts(issueId, where) {
      const creds = deps.creds();
      if ("error" in creds) return null;
      const endpoint =
        where === "comments"
          ? `/api/issues/${encodeURIComponent(issueId)}/comments?fields=id,text,deleted`
          : `/api/issues/${encodeURIComponent(issueId)}/timeTracking/workItems?fields=id,text`;
      const out = await deps.request(`${creds.base}${endpoint}&$top=${PAGE}&$skip=0`, {
        method: "GET",
        token: creds.token,
      });
      if (out.status !== 0) return null;
      try {
        const items = JSON.parse(out.stdout) as unknown;
        if (!Array.isArray(items)) return null;
        return {
          texts: items.flatMap((item) =>
            isObj(item) && item.deleted !== true && typeof item.text === "string"
              ? [item.text]
              : [],
          ),
          // A full page may hide older items.
          complete: items.length < PAGE,
        };
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------- selection

/** ytrack when it is on PATH, else the token-file fallback. */
export function youTrackBackend(env: NodeJS.ProcessEnv = process.env): YouTrackBackend {
  return findYtrack(env) ? ytrackBackend(ytrackRunner(env, youTrackBaseUrl())) : builtinBackend();
}

/** null when YouTrack writes are allowed, else the refusal naming WORKIT_YT_WRITE. */
export function youTrackWriteGate(
  env: NodeJS.ProcessEnv,
  what = "a YouTrack write",
): Extract<IssueOutcome<never>, { ok: false }> | null {
  if (env[YT_WRITE_GATE] === "1") return null;
  return {
    ok: false,
    code: "blocked",
    error: `${what} requires ${YT_WRITE_GATE}=1 (refusing to mutate the tracker)`,
    unblock: `set ${YT_WRITE_GATE}=1 for this command once the user asked for the write`,
  };
}
