// The one seam between Workit and YouTrack (#263). Every Workit YouTrack
// operation (issue read and create, comments, work items, the marker
// read-back) goes through `ytrack … --json` (BrainerVirus/youtrack-cli), which
// keeps its token in the OS keyring. Workit never reads, writes or stores a
// YouTrack token.
//
// ytrack exits 0 ok, 1 failed, 2 cancelled, 4 authentication required. A
// missing ytrack is `unavailable` with the install as the unblock; exit 4 is
// `unavailable` with `ytrack auth login --host <host>`.
import {
  YTRACK_EXIT,
  YTRACK_MISSING,
  ytrackDetail,
  ytrackLogin,
  ytrackMissingUnblock,
  ytrackRunner,
  type YtrackRun,
} from "./youtrack-ytrack";
import { youTrackBaseUrl } from "./youtrack";

export const YT_WRITE_GATE = "WORKIT_YT_WRITE";

type Obj = Record<string, unknown>;

export type IssueComment = {
  id: string;
  text: string;
  author: string | null;
  created: string | null;
};
export type BackendKind = "ytrack";
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
export type Created = {
  issueId: string;
  url: string | null;
  source: BackendKind;
};
export type CreateInput = {
  project: string;
  summary: string;
  description?: string;
};
export type WorkItemInput = { minutes: number; text: string; dateMs: number };

type FailCode = "unavailable" | "failed" | "not_found" | "blocked";
export type IssueOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; code: FailCode; error: string; unblock?: string };

/** A write's result; `outcome` says whether it surely did not land. */
export type WriteResult =
  | { ok: true; data: Obj }
  | {
      ok: false;
      error: string;
      outcome: "not_applied" | "unknown";
      unblock?: string;
    };

/** The texts on an issue; `complete` is false when older items may be missing. */
export type Texts = { texts: string[]; complete: boolean };

/** A comment or work item by the current user, for the duplicate check (#780). */
export type OwnEntry = {
  id: string;
  text: string;
  minutes?: number;
  /** As read: ytrack documents YYYY-MM-DD; an epoch or ISO timestamp is normalised by the caller. */
  date?: string | number;
};

export interface YouTrackBackend {
  readonly kind: BackendKind;
  showIssue(issueId: string): Promise<IssueOutcome<IssueView>>;
  createIssue(input: CreateInput): Promise<IssueOutcome<Created>>;
  addComment(issueId: string, text: string): Promise<WriteResult>;
  addWorkItem(issueId: string, item: WorkItemInput): Promise<WriteResult>;
  /** Comment or work item texts, for the marker read-back; null when unreadable. */
  texts(issueId: string, where: "comments" | "workItems"): Promise<Texts | null>;
  /** The current user's comments or work items on the issue; null when unreadable. */
  ownEntries(issueId: string, where: "comments" | "workItems"): Promise<OwnEntry[] | null>;
}

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
    .map((field) => ({
      name: field.name as string,
      value: plainValue(field.value),
    }));
}

/** Normalize `ytrack issue view --json …` into one shape. */
function issueView(raw: Obj): IssueView {
  const list = fields(raw.customFields);
  const issueId = String(raw.idReadable ?? "");
  const stateField = str(list.find((field) => field.name === "State")?.value);
  return {
    issueId,
    summary: str(raw.summary) ?? "",
    description: str(raw.description),
    state: str(plainValue(raw.state)) ?? stateField,
    url: str(raw.url),
    fields: list,
    comments: comments(raw.comments),
    source: "ytrack",
  };
}

/** YYYY-MM-DD of a YouTrack work date (midnight UTC). */
const workDay = (dateMs: number): string => new Date(dateMs).toISOString().slice(0, 10);

// ---------------------------------------------------------------- ytrack

const VIEW_FIELDS = "idReadable,summary,description,state,url,customFields,comments";

type Ran = { ok: true; json: unknown } | { ok: false; status: number | null; error: string };
type RanFailure = Extract<Ran, { ok: false }>;

function ranJson(run: YtrackRun, args: string[], input?: string): Ran {
  const out = run(args, input);
  const what = `ytrack ${args.slice(0, 2).join(" ")}`;
  if (out.missing) return { ok: false, status: null, error: `${what}: ${YTRACK_MISSING}` };
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
    return {
      ok: false,
      status: out.status,
      error: `${what} printed invalid JSON`,
    };
  }
}

/** The unblock for a failure that sent nothing: install ytrack, or log in to `host`. */
const unblockFor = (ran: RanFailure, host: string | null): { unblock?: string } =>
  ran.status === null
    ? { unblock: ytrackMissingUnblock(host) }
    : ran.status === YTRACK_EXIT.auth
      ? { unblock: ytrackLogin(host) }
      : {};

const readFailure = (ran: RanFailure, host: string | null): IssueOutcome<never> => ({
  ok: false,
  code: ran.status === null || ran.status === YTRACK_EXIT.auth ? "unavailable" : "failed",
  error: ran.error,
  ...unblockFor(ran, host),
});

/**
 * A failed ytrack write: auth (4), cancel (2) and a missing binary sent
 * nothing; any other failure may have landed, so the caller reads back.
 */
const writeFailure = (ran: RanFailure, host: string | null): WriteResult => ({
  ok: false,
  error: ran.error,
  outcome:
    ran.status === YTRACK_EXIT.auth || ran.status === YTRACK_EXIT.cancelled || ran.status === null
      ? "not_applied"
      : "unknown",
  ...unblockFor(ran, host),
});

/** The backend over `run`; `host` (youtrack.json's baseUrl) names the login in an unblock. */
export function ytrackBackend(run: YtrackRun, host: string | null = null): YouTrackBackend {
  return {
    kind: "ytrack",
    async showIssue(issueId) {
      const ran = ranJson(run, ["issue", "view", issueId, "--json", VIEW_FIELDS]);
      if (!ran.ok) return readFailure(ran, host);
      if (!isObj(ran.json)) return { ok: false, code: "failed", error: "ytrack printed no issue" };
      return { ok: true, data: issueView(ran.json) };
    },
    async createIssue(input) {
      const args = ["issue", "create", "--project", input.project, "--summary", input.summary];
      if (input.description !== undefined) args.push("--description-file", "-");
      args.push("--json", "idReadable,url");
      const ran = ranJson(run, args, input.description);
      if (!ran.ok) return readFailure(ran, host);
      const json = isObj(ran.json) ? ran.json : {};
      return {
        ok: true,
        data: {
          issueId: String(json.idReadable ?? ""),
          url: str(json.url),
          source: "ytrack",
        },
      };
    },
    async addComment(issueId, text) {
      const ran = ranJson(
        run,
        ["issue", "comment", issueId, "--body-file", "-", "--json", "id,url"],
        text,
      );
      if (!ran.ok) return writeFailure(ran, host);
      return {
        ok: true,
        data: { issueId, ...(isObj(ran.json) ? ran.json : {}) },
      };
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
      if (!ran.ok) return writeFailure(ran, host);
      const json = isObj(ran.json) ? ran.json : {};
      return {
        ok: true,
        data: {
          issueId,
          workItemId: json.id,
          minutes: item.minutes,
          dateMs: item.dateMs,
        },
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
    async ownEntries(issueId, where) {
      if (where === "workItems") {
        const ran = ranJson(run, [
          "work-item",
          "list",
          issueId,
          "--author",
          "me",
          "--json",
          "id,text,date,duration",
        ]);
        if (!ran.ok || !Array.isArray(ran.json)) return null;
        return ran.json.filter(isObj).map((item) => ({
          id: String(item.id ?? ""),
          text: str(item.text) ?? "",
          ...(isObj(item.duration) && typeof item.duration.minutes === "number"
            ? { minutes: item.duration.minutes }
            : {}),
          ...(typeof item.date === "string" || typeof item.date === "number"
            ? { date: item.date }
            : {}),
        }));
      }
      const me = ranJson(run, ["api", "/users/me", "--fields", "login"]);
      const login = me.ok && isObj(me.json) ? str(me.json.login) : null;
      if (!login) return null;
      const ran = ranJson(run, ["issue", "view", issueId, "--json", "comments"]);
      if (!ran.ok || !isObj(ran.json)) return null;
      return comments(ran.json.comments)
        .filter((comment) => comment.author === login)
        .map((comment) => ({ id: comment.id, text: comment.text }));
    },
  };
}

// ---------------------------------------------------------------- selection

/** ytrack from `env`'s PATH, aimed at youtrack.json's baseUrl when set. */
export function youTrackBackend(env: NodeJS.ProcessEnv = process.env): YouTrackBackend {
  const host = youTrackBaseUrl();
  return ytrackBackend(ytrackRunner(env, host), host);
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
