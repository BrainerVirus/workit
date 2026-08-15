import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { docsValidate, parseTasksFromPlan, qualitySpec, stripFences } from "./docs-validate";
import { resolveCanonicalLayout } from "./docs-layout";
import { ledgerCompletion } from "./sdd";
import { runVerifyProject } from "./verify-project";

export type FlowHost = "opencode" | "cursor";
export type FlowStatus = "draft" | "self_reviewed" | "approved";
export type FlowRole = "coordinator" | "delegated";

/** The canonical document kinds a flow binds approvals to (CA-01). */
export type FlowDocument = "spec" | "plan";

/** Structured approval-drift reasons (CA-04). */
export type FlowDriftCode =
  | "digest_missing"
  | "document_missing"
  | "document_unreadable"
  | "digest_mismatch";

export type FlowDriftReason = {
  document: FlowDocument;
  code: FlowDriftCode;
  path: string;
};

/** Execution lifecycle (CA-11): only these four states exist; no cancellation. */
export type ExecutionStatus = "pending" | "active" | "paused" | "completed";
export type ExecutionMode = "subagent-driven" | "inline";

/** CLI confirmation evidence (CA-19, CA-21): policy-only, no attestation. */
export type CliConfirmation = {
  host: "cli";
  attested: false;
  confirmation: "flag" | "tty";
};

export type LifecycleEvidence = NativeChoiceEvidence | CliConfirmation;

export type FlowExecutionState = {
  status: ExecutionStatus;
  mode: ExecutionMode | null;
  evidence: LifecycleEvidence | null;
};

/**
 * Host-bound identity for every flow/product mutation (FG-05, CA-20, CA-21):
 * the authoritative host workspace, the coordinator/delegated role, the host
 * session, and the authenticated task identity a delegated worker carries.
 * Cursor has no per-session identity, so it derives a deterministic session
 * from the workspace root; OpenCode derives it from the tool context.
 * Delegation is host-derived (Task 30, AR-12): callers never supply `role`.
 */
export type MutationContext = {
  hostWorkspace: string;
  role: FlowRole;
  sessionId: string;
  taskIdentity?: string;
};

/** Recovery guidance surfaced on a blocked coordinator mutation (FG-07). */
export const COORDINATOR_RECOVERY_TEXT =
  "A subagent-driven plan is active: coordinator product edits are blocked. " +
  "Delegate product mutations (task briefs, progress, review packages) to an " +
  "authenticated delegated worker via `task` / `wk-implement` instead of " +
  "editing in the coordinator session.";

/**
 * Cursor recovery guidance for the unsupported subagent-driven mutation path
 * (CA-42): the Cursor MCP has no child sessions, so it cannot run a
 * subagent-driven plan and must not enter that flow state.
 */
export const CURSOR_SUBAGENT_UNSUPPORTED_TEXT =
  "Cursor cannot execute subagent-driven plans: the MCP has no child-session " +
  "support. Choose Inline, Handoff, or a review option in this session, or " +
  "run the plan in OpenCode with `wk-implement`.";

/**
 * The only acceptable approval / execution-menu evidence (FG-04, CA-19, AR-12).
 * Trust comes from HOST CAPABILITIES, never from caller-supplied fields:
 *
 * - OpenCode: a one-use receipt the plugin records when it observes the
 *   answered native `question` tool (host-observed, `attested: true`). The
 *   approval/menu tool schemas expose no evidence argument; the receipt is
 *   consumed from the in-memory store bound to sessionID + callID + exact
 *   selected label + timestamp.
 * - Cursor: a policy-only constant (`attested: false`). The MCP cannot observe
 *   the AskQuestion result, so it records an unauthenticated confirmation and
 *   never claims a host-observed answer. The constant carries no caller data.
 */
export type OpenCodeChoiceEvidence = {
  host: "opencode";
  attested: true;
  /** Host question-tool call id observed by the plugin hook. */
  callID: string;
  /** The exact label the user selected. */
  selectedLabel: string;
  recordedAt: number;
};

export type CursorConfirmation = {
  host: "cursor";
  attested: false;
  confirmation: "contract";
};

export type NativeChoiceEvidence = OpenCodeChoiceEvidence | CursorConfirmation;

export type FlowDocState = {
  path: string;
  status: FlowStatus;
  evidence?: NativeChoiceEvidence | null;
  /** SHA-256 (lowercase hex) of the canonical document's exact bytes (CA-01). */
  approved_digest: string | null;
};

export type FlowMenuState = {
  presented: boolean;
  chosen: string;
  evidence?: NativeChoiceEvidence | null;
};

export type FlowState = {
  slug: string;
  /** Recorded when flow preparation began (FG-01): canonical paths + activation. */
  activated: boolean;
  spec: FlowDocState;
  plan: FlowDocState;
  menu: FlowMenuState;
  execution: FlowExecutionState;
  handoff_destination: boolean;
  updated_at: number;
};

/** One shared result shape for every flow transition and mutation gate (FG-09). */
export type FlowError = {
  ok: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
};
export type FlowGateResult = { ok: true } | FlowError;
export type EvidenceResult =
  | { ok: true; evidence: NativeChoiceEvidence }
  | { ok: false; error: string };
export type StatusTransition = { ok: true; next: FlowStatus } | FlowError;

/** Persisted state after legacy normalization and approval-integrity reconciliation (CA-02). */
export type EffectiveFlowState = {
  state: FlowState;
  drift: FlowDriftReason[];
};

/** Structured result of an effective (reconciled) flow-state read (CA-04). */
export type FlowReadResult = ({ ok: true } & EffectiveFlowState) | FlowError;

export const MENU_CHOICES = [
  "subagent-driven",
  "inline",
  "handoff",
  "review-spec",
  "review-plan",
] as const;
export type MenuChoice = (typeof MENU_CHOICES)[number];

/**
 * The source post-plan menu (CA-08): the full five-way choice set the source
 * session presents after the plan is approved. `DESTINATION_MENU_CHOICES` is
 * the same tuple without `handoff` — a marked destination never re-offers the
 * originating handoff choice.
 */
export const SOURCE_MENU_CHOICES = MENU_CHOICES;
export const DESTINATION_MENU_CHOICES = [
  "subagent-driven",
  "inline",
  "review-spec",
  "review-plan",
] as const;
export type DestinationMenuChoice = (typeof DESTINATION_MENU_CHOICES)[number];

// The source/destination menu labels and the destination marker live in the
// import-light menu module (CA-07/CA-08) so session-start hooks select reminder
// wording without pulling in the full flow-state graph; flow-state re-exports
// them so every existing consumer keeps the same import site.
export { DESTINATION_MENU_LABELS, HANDOFF_DESTINATION_MARKER, SOURCE_MENU_LABELS } from "./menu";

const err = (code: string, error: string, details?: Record<string, unknown>): FlowError => ({
  ok: false,
  code,
  error,
  ...(details ? { details } : {}),
});

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const flowPath = (root: string, slug: string) => {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid slug: ${JSON.stringify(slug)}`);
  return path.join(root, "docs", slug, "sdd", "flow.json");
};

// Resolve one spec/plan doc path under the shared contained contract (DC-01,
// DC-02): the caller-supplied slug must match the slug derived from the path.
const resolveDoc = (
  root: string,
  slug: string,
  docPath: string,
  kind: "spec" | "plan",
): { ok: true; path: string } | { ok: false; error: string } => {
  const resolved = resolveCanonicalLayout({
    workspace_root: root,
    ...(slug ? { slug } : {}),
    [kind === "spec" ? "spec_path" : "plan_path"]: docPath,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  return { ok: true, path: resolved.layout[kind === "spec" ? "spec" : "plan"] };
};

// A flow.json that exists was activated when preparation began; the field is
// kept for forward compatibility but a present file is always treated as
// activated. Missing state is NOT silently activated (FG-01).
const normalizeState = (parsed: unknown, slug: string): FlowState => {
  const p = (parsed ?? {}) as Partial<FlowState>;
  const spec = (p.spec ?? {}) as Partial<FlowDocState>;
  const plan = (p.plan ?? {}) as Partial<FlowDocState>;
  const menu = (p.menu ?? {}) as Partial<FlowMenuState>;
  const execution = (p.execution ?? {}) as Partial<FlowExecutionState>;
  return {
    slug: p.slug ?? slug,
    activated: p.activated ?? true,
    spec: {
      path: spec.path ?? "",
      status: spec.status ?? "draft",
      evidence: spec.evidence ?? null,
      approved_digest: spec.approved_digest ?? null,
    },
    plan: {
      path: plan.path ?? "",
      status: plan.status ?? "draft",
      evidence: plan.evidence ?? null,
      approved_digest: plan.approved_digest ?? null,
    },
    menu: {
      presented: Boolean(menu.presented),
      chosen: menu.chosen ?? "",
      evidence: menu.evidence ?? null,
    },
    execution: {
      status: (execution.status ?? "pending") as ExecutionStatus,
      mode: (execution.mode ?? null) as ExecutionMode | null,
      evidence: (execution.evidence ?? null) as LifecycleEvidence | null,
    },
    handoff_destination: p.handoff_destination ?? false,
    updated_at: p.updated_at ?? Date.now(),
  };
};

const emptyState = (slug: string): FlowState => ({
  slug,
  activated: false,
  spec: { path: "", status: "draft", evidence: null, approved_digest: null },
  plan: { path: "", status: "draft", evidence: null, approved_digest: null },
  menu: { presented: false, chosen: "", evidence: null },
  execution: { status: "pending", mode: null, evidence: null },
  handoff_destination: false,
  updated_at: Date.now(),
});

export const readFlowState = (root: string, slug: string): FlowState => {
  const file = flowPath(root, slug);
  if (!existsSync(file)) return emptyState(slug);
  try {
    return normalizeState(JSON.parse(readFileSync(file, "utf8")), slug);
  } catch {
    return emptyState(slug);
  }
};

const HEX64_RE = /^[0-9a-f]{64}$/;
const FLOW_STATUSES: readonly FlowStatus[] = ["draft", "self_reviewed", "approved"];
const EXECUTION_STATUSES: readonly ExecutionStatus[] = ["pending", "active", "paused", "completed"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Structural validation of persisted choice evidence (CA-18). Approved
 * lifecycle/approval evidence is data, not a host hook: we validate the shape
 * (host + required fields) but never re-check freshness here — freshness is a
 * consume-time property of the host receipt store.
 */
const validateEvidenceValue = (v: unknown, allowCli: boolean): boolean => {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  if (v.host === "opencode") {
    return (
      v.attested === true &&
      typeof v.callID === "string" &&
      typeof v.selectedLabel === "string" &&
      typeof v.recordedAt === "number"
    );
  }
  if (v.host === "cursor") return v.attested === false && v.confirmation === "contract";
  if (allowCli && v.host === "cli") {
    return v.attested === false && (v.confirmation === "flag" || v.confirmation === "tty");
  }
  return false;
};

/**
 * Strict validation + documented normalization of parsed flow.json (CA-18):
 * unsupported field values are rejected (flow_state_invalid) instead of being
 * coerced; missing OPTIONAL fields are normalized only by the documented rules.
 */
const validateState = (
  parsed: unknown,
  slug: string,
): { ok: true; state: FlowState } | { ok: false; error: string } => {
  if (!isRecord(parsed)) return { ok: false, error: "flow state must be a JSON object" };
  if (parsed.slug !== undefined && (typeof parsed.slug !== "string" || parsed.slug !== slug)) {
    return { ok: false, error: `flow state slug must be ${JSON.stringify(slug)}` };
  }
  if (parsed.activated !== undefined && typeof parsed.activated !== "boolean") {
    return { ok: false, error: "flow state activated must be a boolean" };
  }
  if (parsed.handoff_destination !== undefined && typeof parsed.handoff_destination !== "boolean") {
    return { ok: false, error: "flow state handoff_destination must be a boolean" };
  }
  if (
    parsed.updated_at !== undefined &&
    (typeof parsed.updated_at !== "number" || !Number.isFinite(parsed.updated_at))
  ) {
    return { ok: false, error: "flow state updated_at must be a finite number" };
  }
  const doc = (value: unknown, name: FlowDocument): FlowDocState | string => {
    const p = isRecord(value) ? value : {};
    if (!isRecord(value) && value !== undefined) {
      return `flow state ${name} must be an object`;
    }
    if (p.status !== undefined && !FLOW_STATUSES.includes(p.status as FlowStatus)) {
      return `flow state ${name}.status must be draft, self_reviewed, or approved`;
    }
    if (p.path !== undefined && typeof p.path !== "string") {
      return `flow state ${name}.path must be a string`;
    }
    if (
      p.approved_digest !== undefined &&
      p.approved_digest !== null &&
      (typeof p.approved_digest !== "string" || !HEX64_RE.test(p.approved_digest))
    ) {
      return `flow state ${name}.approved_digest must be 64-char lowercase hex or null`;
    }
    if (p.evidence !== undefined && !validateEvidenceValue(p.evidence, false)) {
      return `flow state ${name}.evidence has an unsupported shape`;
    }
    return {
      path: (p.path as string | undefined) ?? "",
      status: (p.status as FlowStatus | undefined) ?? "draft",
      evidence: (p.evidence as NativeChoiceEvidence | null | undefined) ?? null,
      approved_digest: (p.approved_digest as string | null | undefined) ?? null,
    };
  };
  const spec = doc(parsed.spec, "spec");
  if (typeof spec === "string") return { ok: false, error: spec };
  const plan = doc(parsed.plan, "plan");
  if (typeof plan === "string") return { ok: false, error: plan };

  const menuRaw = isRecord(parsed.menu) ? parsed.menu : undefined;
  if (parsed.menu !== undefined && !isRecord(parsed.menu)) {
    return { ok: false, error: "flow state menu must be an object" };
  }
  if (menuRaw?.presented !== undefined && typeof menuRaw.presented !== "boolean") {
    return { ok: false, error: "flow state menu.presented must be a boolean" };
  }
  if (menuRaw?.chosen !== undefined && typeof menuRaw.chosen !== "string") {
    return { ok: false, error: "flow state menu.chosen must be a string" };
  }
  // The only persisted `chosen` values are the MENU_CHOICES plus the empty
  // string ("" marks an unpresented/reset menu — markHandoffDestination and the
  // drift resets persist it). Anything else is a bogus/legacy value and fails
  // closed (CA-18).
  if (
    menuRaw?.chosen !== undefined &&
    menuRaw.chosen !== "" &&
    !MENU_CHOICES.includes(menuRaw.chosen as MenuChoice)
  ) {
    return {
      ok: false,
      error: `flow state menu.chosen must be one of: ${MENU_CHOICES.join(", ")} (or an empty string when the menu is unpresented)`,
    };
  }
  if (menuRaw?.evidence !== undefined && !validateEvidenceValue(menuRaw.evidence, false)) {
    return { ok: false, error: "flow state menu.evidence has an unsupported shape" };
  }

  const execRaw = isRecord(parsed.execution) ? parsed.execution : undefined;
  if (parsed.execution !== undefined && !isRecord(parsed.execution)) {
    return { ok: false, error: "flow state execution must be an object" };
  }
  if (
    execRaw?.status !== undefined &&
    !EXECUTION_STATUSES.includes(execRaw.status as ExecutionStatus)
  ) {
    return {
      ok: false,
      error: "flow state execution.status must be pending, active, paused, or completed",
    };
  }
  if (
    execRaw?.mode !== undefined &&
    execRaw.mode !== null &&
    execRaw.mode !== "subagent-driven" &&
    execRaw.mode !== "inline"
  ) {
    return {
      ok: false,
      error: "flow state execution.mode must be subagent-driven, inline, or null",
    };
  }
  if (execRaw?.evidence !== undefined && !validateEvidenceValue(execRaw.evidence, true)) {
    return { ok: false, error: "flow state execution.evidence has an unsupported shape" };
  }

  return {
    ok: true,
    state: {
      slug,
      activated: parsed.activated ?? true,
      spec,
      plan,
      menu: {
        presented: menuRaw?.presented ?? false,
        chosen: (menuRaw?.chosen as string | undefined) ?? "",
        evidence: (menuRaw?.evidence as NativeChoiceEvidence | null | undefined) ?? null,
      },
      execution: {
        status: (execRaw?.status as ExecutionStatus | undefined) ?? "pending",
        mode: (execRaw?.mode as ExecutionMode | null | undefined) ?? null,
        evidence: (execRaw?.evidence as LifecycleEvidence | null | undefined) ?? null,
      },
      handoff_destination: parsed.handoff_destination ?? false,
      updated_at: parsed.updated_at ?? Date.now(),
    },
  };
};

// Strict read for transitions and guards: missing or corrupt state is a
// structured error, never a silent draft fallback (CA-18). The raw readFlowState
// above stays a lenient compatibility helper for controlled tests and mutation
// internals; status, gates, and host adapters use the effective path. The raw
// parsed JSON is carried so compatibility normalization can distinguish a
// genuinely missing `execution` key from an explicit persisted state (CA-16).
type StrictRead =
  | { ok: true; state: FlowState; raw: unknown }
  | { ok: false; error: string; code: string };

const readFlowStrict = (root: string, slug: string): StrictRead => {
  const file = flowPath(root, slug);
  const rel = path.posix.join("docs", slug, "sdd", "flow.json");
  if (!existsSync(file)) {
    return err(
      "flow_not_activated",
      `flow not activated for ${slug} — run workflow_flow_status first`,
    );
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return err(
      "flow_io_error",
      `cannot read flow state at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return err(
      "flow_state_invalid",
      `invalid flow state at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { path: rel, original_bytes_preserved: true },
    );
  }
  const validated = validateState(parsed, slug);
  if (!validated.ok) {
    return err("flow_state_invalid", `invalid flow state at ${file}: ${validated.error}`, {
      path: rel,
      original_bytes_preserved: true,
    });
  }
  return { ok: true, state: validated.state, raw: parsed };
};

// Unique per-write temporary buffer so two concurrent writers never share the
// same `<file>.tmp` (FG-08, CA-21). Pattern mirrors docs-migration.ts:597.
const uniqueTempPath = (file: string) =>
  `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;

/**
 * Same-directory atomic replacement (CA-19): write a unique temp file, fsync its
 * descriptor, close it, and rename it into place. The temp shares the target's
 * directory so rename is atomic on the same filesystem; a reader never observes
 * partial JSON. Best-effort removal of the temp on every exit path.
 */
const writeFlowFileAtomic = (file: string, state: FlowState): void => {
  const text = JSON.stringify(state, null, 2) + "\n";
  const tmp = uniqueTempPath(file);
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // best effort
    }
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // best effort: a leftover temp is preferable to masking the real error
    }
  }
};

export const writeFlowState = (root: string, state: FlowState) => {
  writeFlowFileAtomic(flowPath(root, state.slug), state);
};

const MAX_WRITE_ATTEMPTS = 5;

/**
 * Age threshold for stale-lock recovery (CA-19): a crash between
 * `openSync(lock, "wx")` and `rmSync(lock)` leaves `<flow.json>.lock` forever.
 * A lock file older than this is treated as abandoned and removed before a
 * fresh acquisition attempt, so a crash never wedges every later operation.
 *
 * ponytail: age-based recovery has two documented ceilings. (1) A very slow
 * writer still legitimately holding the lock (or clock skew) can have its lock
 * reclaimed; the CAS below still protects data, but that writer's critical
 * section is no longer mutually exclusive with the new acquirer's. (2)
 * Recovery renames by PATH, not by inode: two simultaneous reclaimers of the
 * same stale lock can still move a freshly re-acquired winner's lock (one
 * reclaimer's rename lands after the other's re-acquisition). No data is lost —
 * `writeFlowStateIfCurrent`'s CAS is the integrity backstop — but mutual
 * exclusion is not absolute. Upgrade path: write PID/host-session into the
 * lock and verify liveness, or lease-renew, when writers that legitimately
 * exceed the threshold matter.
 */
const STALE_LOCK_MS = 1000;

// The lock's mtime, or null when it vanished between the EEXIST and the stat
// (a concurrent writer removed it) — either way the caller retries acquisition.
const lockMtimeMs = (lock: string): number | null => {
  try {
    return statSync(lock).mtimeMs;
  } catch {
    return null;
  }
};

// Whether the lock at `lock` is still the inode `fd` opened (CA-19): release
// must never unlink a successor's fresh lock, only the file this writer owns.
// ponytail: this is a stat-then-rmSync window — a successor that replaces the
// path between the stat and the release rmSync (a concurrent recovery of a
// >1s-held lock) can still lose its fresh lock. Microsecond window, documented
// ceiling; the CAS backstops data integrity.
const lockOwnedBy = (fd: number, lock: string): boolean => {
  try {
    return fstatSync(fd).ino === statSync(lock).ino;
  } catch {
    return false;
  }
};

export type FlowWriteResult =
  | { ok: true }
  | { ok: false; conflict: true }
  | { ok: false; io_error: string };

/**
 * Compare-and-write (FG-08, CA-19): write `next` only if the on-disk content
 * still equals the version this writer read (`expected`). A stale writer gets
 * `conflict` instead of clobbering a concurrent newer write; the caller re-reads
 * and retries the transition (bounded). Unique per-write temp names keep the
 * write buffer from being shared between writers.
 *
 * The first compare happens before the buffer is staged; the file is re-read
 * immediately before the rename so a writer that committed between the two
 * points still wins. Without the re-read, two writers holding the same expected
 * text would both pass the compare and both rename — a lost update. This CAS
 * stays as the second safety net under the per-flow `flow.json.lock` (CA-19):
 * cooperating writers are serialized by the lock; the CAS catches any writer
 * that bypasses it.
 *
 * A thrown error here is a real IO/permission failure (EACCES, ENOSPC, ...),
 * not a conflict: it is returned as `io_error` so callers surface it instead of
 * advising a pointless re-read-and-retry. Any unique `.tmp` staged by this
 * writer is removed on every non-success path so crashed writers don't
 * accumulate temp buffers.
 */
export const writeFlowStateIfCurrent = (
  root: string,
  expected: FlowState,
  next: FlowState,
): FlowWriteResult => {
  const file = flowPath(root, next.slug);
  const expectedText = JSON.stringify(expected, null, 2) + "\n";
  const nextText = JSON.stringify(next, null, 2) + "\n";
  if (expectedText === nextText) return { ok: true };
  const tmp = uniqueTempPath(file);
  let fd: number | null = null;
  try {
    const currentText = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (currentText !== expectedText) return { ok: false, conflict: true };
    mkdirSync(path.dirname(file), { recursive: true });
    fd = openSync(tmp, "w");
    writeFileSync(fd, nextText, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    const reRead = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (reRead !== expectedText) return { ok: false, conflict: true };
    renameSync(tmp, file);
    return { ok: true };
  } catch (error) {
    return { ok: false, io_error: error instanceof Error ? error.message : String(error) };
  } finally {
    // On success the rename moved the buffer into place; on any other exit the
    // unique temp is orphaned — remove it so crashed writers don't accumulate
    // `<file>.<pid>-<rand>.tmp` buffers.
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // best effort
    }
    try {
      if (existsSync(tmp)) rmSync(tmp, { force: true });
    } catch {
      // best effort: a leftover temp is preferable to masking the real error
    }
  }
};

/**
 * One internal strict-byte helper (CA-01, CA-06): resolve the canonical
 * document, read it as a Buffer, validate it with a fatal TextDecoder, and
 * return both the decoded text and the SHA-256 of the exact bytes. Line endings
 * and Unicode are never normalized — any byte change invalidates the approval.
 */
type CanonicalDigestResult =
  | { ok: true; text: string; digest: string }
  | { ok: false; code: "document_missing" | "document_unreadable" };

const readCanonicalDigest = (root: string, rel: string): CanonicalDigestResult => {
  const abs = path.join(root, ...rel.split("/"));
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, code: "document_missing" };
    }
    return { ok: false, code: "document_unreadable" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, code: "document_unreadable" };
  }
  return { ok: true, text, digest: createHash("sha256").update(bytes).digest("hex") };
};

/**
 * Approval-integrity reconciliation (CA-02, CA-03): recompute approved
 * document digests in spec-before-plan order and return the reset state plus
 * the structured drift reasons. Spec drift resets the whole approval chain;
 * plan drift (spec valid) preserves the spec approval and digest.
 */
const resetForSpecDrift = (state: FlowState): FlowState => ({
  ...state,
  spec: { ...state.spec, status: "draft", evidence: null, approved_digest: null },
  plan: { ...state.plan, status: "draft", evidence: null, approved_digest: null },
  menu: { presented: false, chosen: "", evidence: null },
  execution: { status: "pending", mode: null, evidence: null },
  handoff_destination: false,
  updated_at: Date.now(),
});

const resetForPlanDrift = (state: FlowState): FlowState => ({
  ...state,
  plan: { ...state.plan, status: "draft", evidence: null, approved_digest: null },
  menu: { presented: false, chosen: "", evidence: null },
  execution: { status: "pending", mode: null, evidence: null },
  handoff_destination: false,
  updated_at: Date.now(),
});

const driftCodeFor = (
  root: string,
  relPath: string,
  storedDigest: string | null,
): FlowDriftCode | null => {
  if (storedDigest === null) return "digest_missing";
  const current = readCanonicalDigest(root, relPath);
  if (!current.ok) return current.code;
  return current.digest !== storedDigest ? "digest_mismatch" : null;
};

const reconcileState = (
  root: string,
  slug: string,
  state: FlowState,
): { state: FlowState; drift: FlowDriftReason[] } => {
  const specPath = path.posix.join("docs", slug, "spec.md");
  const planPath = path.posix.join("docs", slug, "plan.md");
  if (state.spec.status === "approved") {
    const code = driftCodeFor(root, specPath, state.spec.approved_digest);
    if (code) {
      return {
        state: resetForSpecDrift(state),
        drift: [{ document: "spec", code, path: specPath }],
      };
    }
  }
  if (state.plan.status === "approved") {
    const code = driftCodeFor(root, planPath, state.plan.approved_digest);
    if (code) {
      return {
        state: resetForPlanDrift(state),
        drift: [{ document: "plan", code, path: planPath }],
      };
    }
  }
  return { state, drift: [] };
};

/**
 * Compatibility normalization for legacy persisted shapes (CA-16): a flow.json
 * written before the execution lifecycle has NO `execution` key. Only then is
 * execution derived — active exactly when the persisted plan approval, a
 * subagent-driven menu choice, and an in-progress SDD ledger prove a legacy
 * execution is running; every other combination (and any explicit persisted
 * execution) stays pending/fail-closed. Runs BEFORE digest reconciliation
 * (CA-17) so a drift reset can still pull a derived active state back to
 * pending. Migration evidence is null by design: a legacy flow has no
 * host-observed lifecycle receipt to cite.
 */
const deriveLegacyExecution = (
  root: string,
  slug: string,
  state: FlowState,
): FlowExecutionState => {
  const ledger = ledgerCompletion(root, slug);
  if (
    state.plan.status === "approved" &&
    state.menu.chosen === "subagent-driven" &&
    ledger.started &&
    !ledger.complete
  ) {
    return { status: "active", mode: "subagent-driven", evidence: null };
  }
  return { status: "pending", mode: null, evidence: null };
};

type CompatibilityResult = { state: FlowState; changed: boolean };

const normalizeCompatibility = (
  root: string,
  slug: string,
  parsed: unknown,
  state: FlowState,
): CompatibilityResult => {
  if (!isRecord(parsed) || !("execution" in parsed)) {
    const derived = deriveLegacyExecution(root, slug, state);
    const current = state.execution;
    if (derived.status !== current.status || derived.mode !== current.mode) {
      return { state: { ...state, execution: derived, updated_at: Date.now() }, changed: true };
    }
  }
  return { state, changed: false };
};

type MutateResult = { ok: true; next: FlowState } | FlowError;

/**
 * Per-flow critical section (CA-19): acquire `<flow.json>.lock` exclusively
 * (openSync "wx"); on contention retry with a bounded 10ms backoff; a lock
 * older than STALE_LOCK_MS (a crashed writer) is removed and acquisition is
 * retried; run the critical section; release the lock and best-effort remove
 * it in `finally`. A never-activated flow (no `docs/<slug>/sdd/` dir) runs
 * without a lock: there is no flow.json to serialize and no filesystem side
 * effect is created — the write helpers create the dir on the first actual
 * write. No lock module and no adapter-side lock: every host shares this one
 * core contract. ponytail: stale recovery and release are path-based with
 * documented TOCTOU ceilings (see STALE_LOCK_MS and lockOwnedBy); data
 * integrity is guaranteed by the CAS, not by absolute mutual exclusion.
 */
type Locked<T> = { locked: true; value: T } | { locked: false; error: FlowError };

const withFlowLock = <T>(file: string, fn: () => T): Locked<T> => {
  const lock = `${file}.lock`;
  // An activated flow's `docs/<slug>/sdd/` dir always exists (a file implies
  // its parent dir); a never-activated flow has neither. Skip the lock for the
  // never-activated case so a failed flow_not_activated gate/status read
  // leaves no filesystem side effect. The skip window is benign: a concurrent
  // first activation writes byte-equivalent initial state through unique temp
  // names + atomic rename, and the CAS serializes every later mutation.
  if (!existsSync(path.dirname(file))) return { locked: true, value: fn() };
  // Best-effort cleanup of a leftover `<file>.lock.stale` from a crashed
  // recovery (a crash between the recovery rename and the unlink strands it).
  // It is never a live lock path — the live lock is always `<file>.lock` — so
  // removing it here is safe. ponytail: on-acquisition best-effort only; an
  // unremovable `.stale` falls through and never blocks the live lock path.
  try {
    if (existsSync(`${lock}.stale`)) rmSync(`${lock}.stale`, { force: true });
  } catch {
    // best effort: a leftover .stale is harmless and cannot wedge the lock
  }
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let fd: number | null = null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      fd = openSync(lock, "wx");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        return {
          locked: false,
          error: err(
            "flow_io_error",
            `flow lock failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
      // Stale-lock recovery (CA-19): the lock is older than STALE_LOCK_MS, so
      // its writer crashed after acquiring it. Reclaim it via a PATH-based
      // atomic rename to `<file>.lock.stale`, unlink the stale inode, then
      // re-attempt acquisition inline so the final attempt still acquires
      // instead of falling out of the loop unlocked. ponytail: the rename is
      // NOT inode-conditional — a concurrent reclaimer of the same stale lock
      // can move a freshly re-acquired winner's lock at the same path
      // (documented TOCTOU ceiling; the CAS backstops integrity). A crash
      // between the rename and the unlink strands only `<file>.lock.stale`,
      // which is never a live lock path and is best-effort removed on the next
      // acquisition.
      const mtime = lockMtimeMs(lock);
      if (mtime !== null && Date.now() - mtime > STALE_LOCK_MS) {
        try {
          renameSync(lock, `${lock}.stale`);
          unlinkSync(`${lock}.stale`);
        } catch {
          // best effort: an unremovable or concurrently-reclaimed stale lock
          // falls through to the bounded retries and, ultimately,
          // flow_concurrent_conflict — never past the lock
        }
        try {
          fd = openSync(lock, "wx");
          break;
        } catch (innerError) {
          const innerCode = (innerError as NodeJS.ErrnoException).code;
          if (innerCode !== "EEXIST") {
            return {
              locked: false,
              error: err(
                "flow_io_error",
                `flow lock failed for ${file}: ${innerError instanceof Error ? innerError.message : String(innerError)}`,
              ),
            };
          }
          // another writer won the reclaimed lock — fall through to backoff
        }
      }
      if (attempt === MAX_WRITE_ATTEMPTS - 1) {
        return {
          locked: false,
          error: err(
            "flow_concurrent_conflict",
            `concurrent flow update detected for ${path.dirname(file)}: re-read the flow state and retry the transition`,
          ),
        };
      }
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (fd === null) {
    // Every acquisition attempt failed without granting the lock: never run the
    // critical section unlocked.
    return {
      locked: false,
      error: err(
        "flow_concurrent_conflict",
        `concurrent flow update detected for ${path.dirname(file)}: re-read the flow state and retry the transition`,
      ),
    };
  }
  try {
    return { locked: true, value: fn() };
  } finally {
    try {
      if (fd !== null && lockOwnedBy(fd, lock)) rmSync(lock, { force: true });
    } catch {
      // best effort: a leftover lock is preferable to masking the real error
    }
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      // best effort
    }
  }
};

/**
 * Effective flow-state read (CA-02, CA-04): under the per-flow lock, validate
 * persisted state, normalize legacy compatibility (missing execution) first,
 * reconcile approval digests in spec-before-plan order, and persist any reset
 * or migration atomically. Status reads and gates operate ONLY on this
 * reconciled state; drift is reported structurally.
 */
export const readEffectiveFlowState = (root: string, slug: string): FlowReadResult => {
  const file = flowPath(root, slug);
  const rel = path.posix.join("docs", slug, "sdd", "flow.json");
  const locked = withFlowLock<FlowReadResult>(file, () => {
    const strict = readFlowStrict(root, slug);
    if (!strict.ok) return strict;
    const normalized = normalizeCompatibility(root, slug, strict.raw, strict.state);
    const { state, drift } = reconcileState(root, slug, normalized.state);
    if (normalized.changed || drift.length > 0) {
      try {
        writeFlowFileAtomic(file, state);
      } catch (error) {
        // A read-path persist failure (EACCES, ENOSPC, EROFS) must never throw
        // through the lock: the FlowReadResult contract is structured (CA-04),
        // and every gate/status read now writes on drift. The original
        // flow.json bytes are untouched — the atomic write never got far enough
        // to swap the file.
        return err(
          "flow_io_error",
          `cannot persist reconciled flow state at ${file}: ${error instanceof Error ? error.message : String(error)}`,
          { path: rel, original_bytes_preserved: true },
        );
      }
    }
    return { ok: true, state, drift };
  });
  if (!locked.locked) return locked.error;
  return locked.value;
};

/**
 * Locked read-modify-write (FG-08, CA-19): under the per-flow lock, read strict,
 * normalize legacy compatibility, reconcile approval digests first, mutate on
 * the reconciled state, then commit only if the on-disk state still matches
 * what was read (CAS); otherwise re-read and retry the transition, bounded.
 * A compatibility migration is persisted under the lock first so the CAS
 * baseline matches the on-disk bytes. Reconciliation runs inside this same
 * critical section before every transition (CA-02).
 */
const readModifyWrite = (
  root: string,
  slug: string,
  mutate: (state: FlowState) => MutateResult,
): FlowGateResult => {
  const file = flowPath(root, slug);
  const locked = withFlowLock<FlowGateResult>(file, () => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      const strict = readFlowStrict(root, slug);
      if (!strict.ok) return strict;
      const normalized = normalizeCompatibility(root, slug, strict.raw, strict.state);
      const reconciled = reconcileState(root, slug, normalized.state);
      const result = mutate(reconciled.state);
      if (!result.ok) return result;
      let baseline = strict.state;
      if (normalized.changed) {
        try {
          writeFlowFileAtomic(file, normalized.state);
        } catch (error) {
          return err(
            "flow_io_error",
            `cannot persist normalized flow state at ${file}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        baseline = normalized.state;
      }
      const commit = writeFlowStateIfCurrent(root, baseline, result.next);
      if (commit.ok) return { ok: true };
      if ("io_error" in commit) {
        return err("flow_io_error", `flow state write failed for ${slug}: ${commit.io_error}`);
      }
      // a non-cooperating writer won the race — re-read and retry the transition
    }
    return err(
      "flow_concurrent_conflict",
      `concurrent flow update detected for ${slug}: re-read the flow state and retry the transition`,
    );
  });
  if (!locked.locked) return locked.error;
  return locked.value;
};

// The caller-supplied workspace must be the host workspace the context names
// (CA-21): a context built for another repo must not drive writes here.
const assertMutationWorkspace = (root: string, ctx?: MutationContext): FlowGateResult => {
  if (ctx && ctx.hostWorkspace !== root) {
    return err(
      "workspace_mismatch",
      `mutation context workspace ${JSON.stringify(ctx.hostWorkspace)} does not match flow workspace ${JSON.stringify(root)}`,
    );
  }
  return { ok: true };
};

/**
 * Coordinator boundary (FG-05, CA-20): while a plan's execution is ACTIVE and
 * subagent-driven, the coordinator session cannot mutate product state — only
 * authenticated delegated workers can. A historical subagent-driven menu choice
 * alone is not a boundary: a pending/paused/completed/inline execution leaves
 * the coordinator unblocked. A delegated worker without a task identity is
 * blocked.
 */
export const assertCoordinatorBoundary = (
  ctx: MutationContext | undefined,
  state: FlowState,
): FlowGateResult => {
  if (
    ctx?.role === "coordinator" &&
    state.execution.status === "active" &&
    state.execution.mode === "subagent-driven"
  ) {
    return err("coordinator_blocked", COORDINATOR_RECOVERY_TEXT);
  }
  if (ctx?.role === "delegated" && !ctx.taskIdentity) {
    return err(
      "delegated_unauthenticated",
      "delegated mutations require an authenticated task identity (taskIdentity) — re-run inside the delegated worker session",
    );
  }
  return { ok: true };
};

/**
 * The shared transition matrix (FG-09): draft -> approved in one receipt; a
 * legacy self_reviewed state still advances to approved. The self-review
 * validation runs automatically inside the draft transition.
 *
 * @deprecated public compat — production transitions (transitionSpec /
 * transitionPlan) hardcode "approved"; this matrix is retained only as the
 * documented single-source transition contract for tests and external
 * consumers of the exported API.
 */
export const nextFlowStatus = (current: FlowStatus): StatusTransition => {
  if (current === "draft") return { ok: true, next: "approved" };
  if (current === "self_reviewed") return { ok: true, next: "approved" };
  return err("flow_already_approved", "already approved; no further transitions");
};

const MAX_CLOCK_SKEW_MS = 60_000;
const MAX_RECEIPTS_PER_SESSION = 10;

/**
 * Freshness window for receipts (FINDING 2): an answer older than this can no
 * longer be taken as the user's current intent. ponytail: fixed constant, not
 * config — the consume path runs per approval-tool call, so a knob would buy
 * surface area, not security.
 */
const RECEIPT_FRESHNESS_MS = 10 * 60 * 1000;

/**
 * Independent belt-and-suspenders age gate for evidence objects passed to the
 * transition functions (receipts are already capped at RECEIPT_FRESHNESS_MS at
 * consume time; this defends direct library callers that fabricate a shape).
 */
const EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Case-insensitive negative-answer denylist (FINDING 3): a user answering
 * "No"/"Reject"/"Cancel" can never be recorded as consent for an approval or
 * a menu choice. The boundary closes the laundering case (negative answer ->
 * approval); a prefix variant ("no, thanks") is covered too.
 */
const NEGATIVE_ANSWER_LABELS = [
  "no",
  "nope",
  "nah",
  "reject",
  "cancel",
  "decline",
  "not now",
  "not yet",
  "skip",
  "back",
  "deny",
];

const isNegativeLabel = (label: string): boolean => {
  const normalized = label.trim().toLowerCase();
  return NEGATIVE_ANSWER_LABELS.some((entry) => {
    const firstWord = normalized.split(/\s+/)[0] ?? "";
    if (entry.includes(" ")) {
      // multi-word entries ("not now", "not yet"): whole-answer match,
      // punctuation-insensitive ("not yet, let me check" -> "not yet")
      const plain = normalized.replace(/[^a-z ]/g, "");
      return plain === entry || plain.startsWith(`${entry} `);
    }
    // single-word entries ("no", "reject", ...): match the first word,
    // ignoring punctuation ("no, thanks" -> "no"); "notebook" stays allowed
    return firstWord.replace(/[^a-z]/g, "") === entry;
  });
};

/**
 * One-use host-observed receipt (AR-12, CA-41): recorded by the OpenCode
 * plugin when the answered `question` tool completes, bound to the session,
 * the question tool call id, the exact selected label, and the timestamp.
 * The model has no way to inject a receipt — `record` is only reachable from
 * the plugin's `tool.execute.after` hook.
 */
export type HostReceipt = {
  sessionId: string;
  callID: string;
  selectedLabel: string;
  recordedAt: number;
  /** The question text the user answered (plugin-observed, best effort), so
   *  the consuming tool can report WHICH question authorized a transition
   *  (FINDING 2). */
  question?: string;
};

export type ReceiptConsumeResult = { ok: true; receipt: HostReceipt } | FlowError;

/**
 * In-memory per-session receipt queue. `record` simulates the host hook; the
 * OpenCode plugin is the only production caller. Unconsumed receipts are
 * bounded per session (oldest dropped) so a session that asks questions
 * without approving cannot grow memory without limit.
 *
 * Correlation (FINDING 2): on a real host the model first calls the native
 * `question` (user answers), THEN calls the approval/menu tool — the tools
 * never run a question internally, so a before/after execution window can
 * never capture the answer. Consumption therefore takes the session's MOST
 * RECENT unconsumed receipt and verifies: one-use (atomic take), freshness
 * (RECEIPT_FRESHNESS_MS), NOT a negative label (isNegativeLabel), and session
 * match. Menu tools additionally pin the expected choice label. CallID and
 * the exact selected label stay bound at record time.
 *
 * Residual risk (honest boundary): any recent POSITIVE host answer (e.g. a
 * "proceed with stash?" -> "yes, proceed") plus the model's choice to call an
 * approval tool authorizes the transition. The laundering case — a negative
 * answer recorded as an approval — is closed by the negative-label denylist.
 *
 * ponytail: in-memory only — receipts die with the plugin process, which is
 * correct: a host-observed answer cannot survive a restart. Upgrade path:
 * persist to the host session store when cross-restart approvals are required.
 */
export class HostReceiptStore {
  #bySession = new Map<string, HostReceipt[]>();

  record(
    sessionId: string,
    callID: string,
    selectedLabel: string,
    recordedAt: number = Date.now(),
    question?: string,
  ): void {
    const label = selectedLabel.trim();
    if (!label) return;
    if (recordedAt > Date.now() + MAX_CLOCK_SKEW_MS) return; // forged future receipt
    const queue = this.#bySession.get(sessionId) ?? [];
    if (queue.length >= MAX_RECEIPTS_PER_SESSION) queue.shift();
    queue.push({ sessionId, callID, selectedLabel: label, recordedAt, question });
    this.#bySession.set(sessionId, queue);
  }

  count(sessionId: string): number {
    return this.#bySession.get(sessionId)?.length ?? 0;
  }

  /**
   * Non-destructive consume: same checks as `consume`, but a positive receipt
   * stays queued. The tools no longer use peek — FINDING 5 (round 3) moved the
   * approval/menu tools to consume-before-transition (the atomic take gates
   * the transition and is spent on any attempt, closing the concurrent-call
   * race). Peek remains for tests and read-only callers. A NEGATIVE receipt is
   * the exception: it is spent by peek too (consumed-and-rejected, FINDING 3)
   * so it cannot poison the top of the queue.
   */
  peek(sessionId: string, opts: { label?: string } = {}): ReceiptConsumeResult {
    return this.#take(sessionId, opts, false);
  }

  /**
   * One-use consumption of the session's most recent receipt (FINDING 2).
   * The atomic take gates the transition at the tool layer (FINDING 5, round
   * 3): a stale receipt, a wrong pinned label (menu), or a negative label
   * fails the transition; the receipt is removed on take, staleness, or
   * negativity (fail-closed). A wrong label (menu) is NOT spent — it stays
   * queued for the choice it actually matched.
   */
  consume(sessionId: string, opts: { label?: string } = {}): ReceiptConsumeResult {
    return this.#take(sessionId, opts, true);
  }

  #take(sessionId: string, opts: { label?: string }, remove: boolean): ReceiptConsumeResult {
    const queue = this.#bySession.get(sessionId);
    if (!queue || queue.length === 0) {
      return err(
        "receipt_missing",
        "no host-observed native-question receipt for this session — ask the native " +
          "`question` tool and have the user answer before calling this tool",
      );
    }
    const index = queue.length - 1;
    const receipt = queue[index];
    if (isNegativeLabel(receipt.selectedLabel)) {
      // Consumed-and-rejected: a negative answer is still an answer, and it
      // can never authorize a transition (FINDING 3). The whole session queue
      // is revoked too: the user's most recent intent is negative, so an
      // older positive answer must not come back to life on a retry.
      this.#bySession.delete(sessionId);
      return err(
        "receipt_rejected",
        `the user's most recent answer (${JSON.stringify(receipt.selectedLabel)}) is a ` +
          "negative answer — it cannot authorize an approval; ask the native question again",
      );
    }
    if (opts.label !== undefined && !sameChoiceLabel(receipt.selectedLabel, opts.label)) {
      // FINDING 6: a wrong-label answer is not spent — it stays queued for
      // the choice it actually matched (or expires via freshness/bounds).
      return err(
        "evidence_mismatch",
        `receipt selectedLabel does not match ${JSON.stringify(opts.label)} — fabricated menu choice rejected`,
      );
    }
    if (Date.now() - receipt.recordedAt > RECEIPT_FRESHNESS_MS) {
      if (remove) {
        queue.splice(index, 1);
        if (queue.length === 0) this.#bySession.delete(sessionId);
      }
      return err(
        "receipt_stale",
        "the question receipt is too old — ask the native question again and re-answer",
      );
    }
    if (remove) {
      queue.splice(index, 1);
      if (queue.length === 0) this.#bySession.delete(sessionId);
    }
    return { ok: true, receipt };
  }
}

/** Menu labels compare semantically: hosts decorate choices with
 *  parenthesized qualifiers ("Handoff (new session only)") that the enum does
 *  not carry, so we strip them, trim, collapse whitespace, and lowercase both
 *  sides before comparing. Only the comparison normalizes — the stored label
 *  and evidence bytes are preserved verbatim. */
const sameChoiceLabel = (a: string, b: string): boolean => normalizeLabel(a) === normalizeLabel(b);

const normalizeLabel = (s: string): string =>
  s
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\bfirst\b/gi, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();

/** Derive the evidence record from a consumed host receipt (AR-12). */
export const createOpenCodeEvidence = (receipt: HostReceipt): OpenCodeChoiceEvidence => ({
  host: "opencode",
  attested: true,
  callID: receipt.callID,
  selectedLabel: receipt.selectedLabel,
  recordedAt: receipt.recordedAt,
});

/** The Cursor policy-only constant: unauthenticated, no caller data (CA-42). */
export const createCursorConfirmation = (): EvidenceResult => ({
  ok: true,
  evidence: { host: "cursor", attested: false, confirmation: "contract" },
});

const CURSOR_KEYS = ["attested", "confirmation", "host"];

/**
 * Strict shape validation for every flow transition (CA-41): OpenCode evidence
 * must be a host-attested receipt record; Cursor evidence must be exactly the
 * policy-only constant and carries no caller-supplied question data. A Cursor
 * object claiming an observed answer (`attested: true`) is rejected as forged.
 */
export const assertEvidenceShape = (input: unknown): EvidenceResult => {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      error:
        "native choice evidence required — bare booleans and other primitives are not approval evidence",
    };
  }
  const record = input as Record<string, unknown>;
  if (record.host === "cursor") {
    if (record.attested !== false || record.confirmation !== "contract") {
      return {
        ok: false,
        error:
          'cursor confirmations are policy-only: exactly { host: "cursor", attested: false, confirmation: "contract" } — Cursor cannot attest a host-observed answer',
      };
    }
    const keys = Object.keys(record).sort();
    if (keys.length !== CURSOR_KEYS.length || !CURSOR_KEYS.every((key) => keys.includes(key))) {
      return {
        ok: false,
        error:
          "cursor confirmations carry no caller-supplied question data — the attested: false constant only",
      };
    }
    return { ok: true, evidence: { host: "cursor", attested: false, confirmation: "contract" } };
  }
  if (record.host !== "opencode") {
    return {
      ok: false,
      error: `evidence host must be 'opencode' or 'cursor', got ${JSON.stringify(record.host)}`,
    };
  }
  if (record.attested !== true) {
    return {
      ok: false,
      error:
        "opencode evidence requires host attestation (attested: true) — only host-observed question receipts are accepted",
    };
  }
  const { callID, selectedLabel, recordedAt } = record;
  if (typeof callID !== "string" || callID.trim() === "") {
    return {
      ok: false,
      error: "opencode evidence callID must be a non-empty string (host question tool call)",
    };
  }
  if (typeof selectedLabel !== "string" || selectedLabel.trim() === "") {
    return {
      ok: false,
      error:
        "opencode evidence selectedLabel must be the exact label the user selected on the native question",
    };
  }
  if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt) || recordedAt <= 0) {
    return {
      ok: false,
      error: "opencode evidence recordedAt must be a positive epoch-ms timestamp",
    };
  }
  const now = Date.now();
  if (recordedAt > now + MAX_CLOCK_SKEW_MS) {
    return {
      ok: false,
      error: "opencode evidence recordedAt is in the future — forged evidence is rejected",
    };
  }
  if (now - recordedAt > EVIDENCE_WINDOW_MS) {
    return {
      ok: false,
      error:
        "opencode evidence recordedAt is too old — ask the native question again and re-record the answer",
    };
  }
  return {
    ok: true,
    evidence: {
      host: "opencode",
      attested: true,
      callID: callID.trim(),
      selectedLabel: selectedLabel.trim(),
      recordedAt,
    },
  };
};

/** Host provenance binding: OpenCode only accepts opencode evidence, and vice versa. */
export const assertHostEvidence = (host: FlowHost, evidence: unknown): FlowGateResult => {
  const shaped = assertEvidenceShape(evidence);
  if (!shaped.ok) return err("evidence_invalid", shaped.error);
  if (shaped.evidence.host !== host) {
    return err(
      "evidence_host_mismatch",
      `evidence was recorded on ${JSON.stringify(shaped.evidence.host)}, not ${host} — forged or misattributed evidence is rejected`,
    );
  }
  return { ok: true };
};

/**
 * Record flow activation and the canonical spec/plan paths when preparation
 * begins. The flow store lives under the canonical docs/<slug>/sdd/ layout
 * (Task 18 contract). Re-runs keep existing statuses while recording paths.
 * Activation is a locked critical section (CA-19): existing state is validated
 * and reconciled before being trusted, and malformed state fails closed without
 * overwriting the original file (CA-18).
 */
export const prepareFlowState = (
  root: string,
  slug: string,
  opts: { spec_path?: string; plan_path?: string } = {},
  ctx?: MutationContext,
): FlowGateResult => {
  const bound = assertMutationWorkspace(root, ctx);
  if (!bound.ok) return bound;
  const resolved = resolveCanonicalLayout({
    workspace_root: root,
    slug,
    spec_path: opts.spec_path,
    plan_path: opts.plan_path,
  });
  if (!resolved.ok) return err("flow_prepare_failed", resolved.error);
  const specPath = path.posix.join("docs", slug, "spec.md");
  const planPath = path.posix.join("docs", slug, "plan.md");
  const file = flowPath(root, slug);
  const locked = withFlowLock<FlowGateResult>(file, () => {
    if (!existsSync(file)) {
      writeFlowFileAtomic(file, {
        slug,
        activated: true,
        spec: { path: specPath, status: "draft", evidence: null, approved_digest: null },
        plan: { path: planPath, status: "draft", evidence: null, approved_digest: null },
        menu: { presented: false, chosen: "", evidence: null },
        execution: { status: "pending", mode: null, evidence: null },
        handoff_destination: false,
        updated_at: Date.now(),
      });
      return { ok: true };
    }
    const strict = readFlowStrict(root, slug);
    if (!strict.ok) return strict;
    const reconciled = reconcileState(root, slug, strict.state);
    writeFlowFileAtomic(file, {
      ...reconciled.state,
      spec: { ...reconciled.state.spec, path: specPath },
      plan: { ...reconciled.state.plan, path: planPath },
      updated_at: Date.now(),
    });
    return { ok: true };
  });
  if (!locked.locked) return locked.error;
  return locked.value;
};

/**
 * Approve the canonical spec (CA-01): under the locked read/reconcile/mutate
 * critical section, reset any stale approval first, then read the exact bytes,
 * run the self-review on the decoded text, and atomically store the approval
 * evidence TOGETHER WITH the SHA-256 digest of those bytes.
 */
export const transitionSpec = (
  root: string,
  slug: string,
  specPath: string,
  evidence: unknown,
  ctx?: MutationContext,
): FlowGateResult => {
  const bound = assertMutationWorkspace(root, ctx);
  if (!bound.ok) return bound;
  const recorded = assertEvidenceShape(evidence);
  if (!recorded.ok) return err("evidence_invalid", recorded.error);
  const doc = resolveDoc(root, slug, specPath, "spec");
  if (!doc.ok) return err("path_invalid", doc.error);
  const relPath = path.posix.join("docs", slug, "spec.md");
  return readModifyWrite(root, slug, (state) => {
    if (!existsSync(doc.path)) return err("spec_missing", `spec not found: ${specPath}`);
    if (state.spec.status === "draft" || state.spec.status === "self_reviewed") {
      const digest = readCanonicalDigest(root, relPath);
      if (!digest.ok) {
        return err(
          "spec_self_review_failed",
          `spec self-review failed: unreadable or invalid UTF-8 canonical spec: ${specPath}`,
        );
      }
      if (state.spec.status === "draft") {
        const hard = qualitySpec(digest.text).filter((f) => f.severity === "hard");
        const missing: string[] = [];
        if (!/^\s*\*+Branch:\*+/im.test(stripFences(digest.text)))
          missing.push("**Branch:** header missing");
        if (hard.length > 0 || missing.length > 0) {
          return err(
            "spec_self_review_failed",
            "spec self-review failed: " +
              hard
                .map((f) => `${f.code} — ${f.message}`)
                .concat(missing)
                .join("; ") +
              " — see templates/spec-template.md for the required structure",
          );
        }
      }
      return {
        ok: true,
        next: {
          ...state,
          spec: {
            path: relPath,
            status: "approved",
            evidence: recorded.evidence,
            approved_digest: digest.digest,
          },
          updated_at: Date.now(),
        },
      };
    }
    return err("flow_already_approved", "already approved; no further transitions");
  });
};

/**
 * Approve the canonical plan (CA-01): requires a currently valid spec approval;
 * under the locked read/reconcile/mutate critical section, reset any stale plan
 * approval first, then read the exact bytes, run the self-review on the decoded
 * text, and atomically store the approval evidence TOGETHER WITH the SHA-256
 * digest of those bytes.
 */
export const transitionPlan = (
  root: string,
  slug: string,
  planPath: string,
  evidence: unknown,
  ctx?: MutationContext,
): FlowGateResult => {
  const bound = assertMutationWorkspace(root, ctx);
  if (!bound.ok) return bound;
  const recorded = assertEvidenceShape(evidence);
  if (!recorded.ok) return err("evidence_invalid", recorded.error);
  const doc = resolveDoc(root, slug, planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  const relPath = path.posix.join("docs", slug, "plan.md");
  return readModifyWrite(root, slug, (state) => {
    if (!existsSync(doc.path)) return err("plan_missing", `plan not found: ${planPath}`);
    if (state.spec.status !== "approved") {
      return err("spec_not_approved", "spec must be approved before the plan can be approved");
    }
    if (state.plan.status === "draft" || state.plan.status === "self_reviewed") {
      const digest = readCanonicalDigest(root, relPath);
      if (!digest.ok) {
        return err(
          "plan_self_review_failed",
          `plan self-review failed: unreadable or invalid UTF-8 canonical plan: ${planPath}`,
        );
      }
      if (state.plan.status === "draft") {
        const missing: string[] = [];
        const stripped = stripFences(digest.text);
        if (parseTasksFromPlan(digest.text).length === 0)
          missing.push("no ### Task N: sections outside fences");
        if (!/^\s*\*+Spec:\*+/im.test(stripped)) missing.push("**Spec:** header missing");
        if (!/^\s*\*+Branch:\*+/im.test(stripped)) missing.push("**Branch:** header missing");
        if (missing.length > 0)
          return err("plan_self_review_failed", "plan self-review failed: " + missing.join("; "));
      }
      return {
        ok: true,
        next: {
          ...state,
          plan: {
            path: relPath,
            status: "approved",
            evidence: recorded.evidence,
            approved_digest: digest.digest,
          },
          updated_at: Date.now(),
        },
      };
    }
    return err("flow_already_approved", "already approved; no further transitions");
  });
};

export const recordMenuChoice = (
  root: string,
  slug: string,
  planPath: string,
  choice: unknown,
  evidence: unknown,
  ctx?: MutationContext,
): FlowGateResult => {
  const bound = assertMutationWorkspace(root, ctx);
  if (!bound.ok) return bound;
  const recorded = assertEvidenceShape(evidence);
  if (!recorded.ok) return err("evidence_invalid", recorded.error);
  if (typeof choice !== "string" || !MENU_CHOICES.includes(choice as MenuChoice)) {
    return err("menu_choice_invalid", `invalid menu choice: ${JSON.stringify(choice)}`);
  }
  // Cursor cannot run subagent-driven plans (no child sessions): entering that
  // flow state on Cursor is rejected with recovery guidance (CA-42).
  if (recorded.evidence.host === "cursor" && choice === "subagent-driven") {
    return err("unsupported_mode", CURSOR_SUBAGENT_UNSUPPORTED_TEXT);
  }
  // The execution-menu evidence must be the label the user selected on the
  // native question; a mismatched choice is fabricated (FG-04). Comparison is
  // case-insensitive: the host presents "Inline", the enum stores "inline"
  // (FINDING 3). Cursor evidence is the policy-only constant (no label), so
  // the check applies to host-observed OpenCode receipts only.
  if (
    recorded.evidence.host === "opencode" &&
    !sameChoiceLabel(recorded.evidence.selectedLabel, choice)
  ) {
    return err(
      "evidence_mismatch",
      `evidence selectedLabel ${JSON.stringify(recorded.evidence.selectedLabel)} does not match choice ${JSON.stringify(choice)}`,
    );
  }
  const doc = resolveDoc(root, slug, planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  return readModifyWrite(root, slug, (state) => {
    if (state.spec.status !== "approved")
      return err("spec_not_approved", "spec must be approved before the execution menu");
    if (state.plan.status !== "approved")
      return err("plan_not_approved", "plan must be approved before the execution menu");
    // Recursive-handoff rejection (CA-09): a marked destination never re-offers
    // the originating handoff choice, even when an adapter or CLI caller
    // bypasses the destination prompt's four-choice wording.
    if (state.handoff_destination && choice === "handoff") {
      return err(
        "recursive_handoff",
        "this flow is already a handoff destination — a second handoff is rejected",
      );
    }
    // Lifecycle is set ATOMICALLY with the menu evidence (CA-11/CA-13): an
    // executing choice starts the plan; a review/handoff choice leaves it
    // pending. The menu evidence IS the lifecycle evidence — the choice the
    // user selected on the native question.
    const executing = choice === "subagent-driven" || choice === "inline";
    return {
      ok: true,
      next: {
        ...state,
        // Legacy fixup (CA-16): a hand-crafted legacy flow.json with an empty
        // plan.path keeps it empty through menu recording unless restored to
        // the canonical path here.
        plan: { ...state.plan, path: state.plan.path || `docs/${slug}/plan.md` },
        menu: { presented: true, chosen: choice, evidence: recorded.evidence },
        execution: executing
          ? { status: "active", mode: choice as ExecutionMode, evidence: recorded.evidence }
          : { status: "pending", mode: null, evidence: recorded.evidence },
        updated_at: Date.now(),
      },
    };
  });
};

/**
 * Atomically mark a flow as a handoff destination (CA-07, CA-09): one effective
 * state mutation under the existing lock/CAS writer. Requires approved spec and
 * plan plus the source menu choice `handoff`; rejects an already marked
 * destination (recursive_handoff). Sets `handoff_destination: true`, resets the
 * menu presentation/evidence, and keeps execution pending. Host-neutral
 * (CA-10): OpenCode, Cursor, and the CLI all reach this single core mutation.
 */
export const markHandoffDestination = (
  root: string,
  slug: string,
  planPath: string,
): FlowGateResult => {
  const doc = resolveDoc(root, slug, planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  return readModifyWrite(root, slug, (state) => {
    if (state.spec.status !== "approved")
      return err("spec_not_approved", "spec must be approved before marking a handoff destination");
    if (state.plan.status !== "approved")
      return err("plan_not_approved", "plan must be approved before marking a handoff destination");
    if (state.handoff_destination) {
      return err(
        "recursive_handoff",
        "this flow is already a handoff destination — a second handoff is rejected",
      );
    }
    if (state.menu.chosen !== "handoff") {
      return err(
        "handoff_not_chosen",
        `source menu choice must be "handoff" to mark a handoff destination (chosen: ${JSON.stringify(state.menu.chosen)})`,
      );
    }
    return {
      ok: true,
      next: {
        ...state,
        handoff_destination: true,
        menu: { presented: false, chosen: "", evidence: null },
        updated_at: Date.now(),
      },
    };
  });
};

const CLI_CONFIRMATION_KEYS = ["attested", "confirmation", "host"];

/**
 * Strict shape validation for lifecycle evidence (CA-19, CA-21): OpenCode and
 * Cursor use the existing native-choice validation; CLI evidence accepts ONLY
 * the exact `{ host: "cli", attested: false, confirmation: "flag" | "tty" }`
 * constant — no caller data, no attestation.
 */
const validateLifecycleEvidence = (
  input: unknown,
): { ok: true; evidence: LifecycleEvidence } | { ok: false; error: string } => {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      error: "lifecycle evidence required — native choice evidence or an exact CLI confirmation",
    };
  }
  const record = input as Record<string, unknown>;
  if (record.host === "cli") {
    const validValue =
      record.attested === false &&
      (record.confirmation === "flag" || record.confirmation === "tty");
    const keys = Object.keys(record).sort();
    const exactShape =
      keys.length === CLI_CONFIRMATION_KEYS.length &&
      CLI_CONFIRMATION_KEYS.every((key) => keys.includes(key));
    if (validValue && exactShape) {
      return {
        ok: true,
        evidence: {
          host: "cli",
          attested: false,
          confirmation: record.confirmation as "flag" | "tty",
        },
      };
    }
    return {
      ok: false,
      error:
        'cli confirmations accept only the exact { host: "cli", attested: false, confirmation: "flag" | "tty" } shape',
    };
  }
  return assertEvidenceShape(input);
};

const errPendingFlow = (action: string): FlowError =>
  err("flow_not_active", `cannot ${action} a pending flow — the execution menu has not started it`);

const errCompletedFlow = (action: string): FlowError =>
  err("flow_already_completed", `cannot ${action} a completed flow`);

/**
 * Completion (CA-23): acquire/read/reconcile/validate and capture the exact
 * effective state plus the ledger result; RELEASE the lock; run repository
 * verification outside the lock (no expensive command ever runs while a flow
 * lock is held); stop on nonzero verification; reacquire and compare-and-swap
 * the completed state against the captured state — a concurrent mutation during
 * verification returns flow_concurrent_conflict rather than rerunning
 * verification or overwriting the newer state.
 */
const completeExecution = (
  root: string,
  slug: string,
  deps?: { verifyProject?: typeof runVerifyProject },
): FlowGateResult => {
  const file = flowPath(root, slug);
  const captured = readEffectiveFlowState(root, slug);
  if (!captured.ok) return captured;
  const exec = captured.state.execution;
  if (exec.status === "pending") return errPendingFlow("complete");
  if (exec.status === "completed") return errCompletedFlow("complete");
  const ledger = ledgerCompletion(root, slug);
  if (!ledger.complete) {
    return err(
      "execution_incomplete",
      `execution ledger incomplete for ${slug}: missing tasks ${ledger.missing.join(", ")}`,
      { required: ledger.required, completed: ledger.completed, missing: ledger.missing },
    );
  }
  const verifier = deps?.verifyProject ?? runVerifyProject;
  const verify = verifier(root, false);
  if (verify.exitCode !== 0) {
    return err(
      "verification_failed",
      `repository verification failed for ${slug} (exit ${verify.exitCode}) — see the verification output`,
      { exitCode: verify.exitCode },
    );
  }
  const locked = withFlowLock<FlowGateResult>(file, () => {
    const strict = readFlowStrict(root, slug);
    if (!strict.ok) return strict;
    const reconciled = reconcileState(root, slug, strict.state);
    const currentExec = reconciled.state.execution;
    if (currentExec.status !== exec.status || currentExec.mode !== exec.mode) {
      return err(
        "flow_concurrent_conflict",
        `concurrent execution state change detected for ${slug}: re-read the flow state and retry completion`,
      );
    }
    const next: FlowState = {
      ...reconciled.state,
      execution: { ...exec, status: "completed" },
      // A completed flow is never a destination: clear the context so the next
      // ordinary session gets the source five-choice reminder, not the stale
      // four-choice destination wording (CA-08). Both approval-drift resets
      // (resetForSpecDrift/resetForPlanDrift) and completion clear
      // handoff_destination; only a new-flow prepareFlowState initializes it.
      handoff_destination: false,
      updated_at: Date.now(),
    };
    const commit = writeFlowStateIfCurrent(root, captured.state, next);
    if (commit.ok) return { ok: true };
    if ("io_error" in commit) {
      return err("flow_io_error", `flow state write failed for ${slug}: ${commit.io_error}`);
    }
    return err(
      "flow_concurrent_conflict",
      `concurrent flow update detected for ${slug}: re-read the flow state and retry completion`,
    );
  });
  if (!locked.locked) return locked.error;
  return locked.value;
};

/**
 * Execution lifecycle transitions (CA-11, CA-14, CA-23): pause, resume, and
 * complete move the plan between the only four states — pending, active,
 * paused, completed. Pause/resume run under the per-flow critical section and
 * preserve the retained mode and original lifecycle evidence; every SDD
 * artifact (briefs, reviews, ledger) is untouched. Completion is orchestrated
 * by completeExecution (ledger check -> verification outside the lock -> CAS).
 */
export const transitionExecution = (
  root: string,
  slug: string,
  planPath: string,
  action: "pause" | "resume" | "complete",
  evidence: LifecycleEvidence,
  ctx?: MutationContext,
  deps?: { verifyProject?: typeof runVerifyProject },
): FlowGateResult => {
  const bound = assertMutationWorkspace(root, ctx);
  if (!bound.ok) return bound;
  const validated = validateLifecycleEvidence(evidence);
  if (!validated.ok) return err("evidence_invalid", validated.error);
  const doc = resolveDoc(root, slug, planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);

  if (action === "complete") return completeExecution(root, slug, deps);

  if (action === "pause") {
    return readModifyWrite(root, slug, (state) => {
      const exec = state.execution;
      if (exec.status === "pending") return errPendingFlow("pause");
      if (exec.status === "completed") return errCompletedFlow("pause");
      if (exec.status === "paused") return err("flow_already_paused", "flow is already paused");
      return {
        ok: true,
        next: { ...state, execution: { ...exec, status: "paused" }, updated_at: Date.now() },
      };
    });
  }
  return readModifyWrite(root, slug, (state) => {
    const exec = state.execution;
    if (exec.status === "completed") return errCompletedFlow("resume");
    if (exec.status !== "paused") {
      return err(
        "flow_not_paused",
        exec.status === "active"
          ? "flow is already active — cannot resume"
          : "cannot resume a pending flow — the execution menu has not started it",
      );
    }
    return {
      ok: true,
      next: { ...state, execution: { ...exec, status: "active" }, updated_at: Date.now() },
    };
  });
};

export const slugFromPath = (p: string) => {
  const dirName = path.basename(path.dirname(p));
  return dirName === "." || dirName === "/" || dirName === "" ? "" : dirName;
};

/** Derive a slug from a canonical docs/<slug>/sdd/... path (SDD write gates). */
export const slugFromSddPath = (p: string): string => {
  const match = p
    .split(path.sep)
    .join("/")
    // The sdd dir name may be followed by a separator, end-of-string, or a
    // quote char part of a quote-bearing dir name; `sdd-attack` (hyphen/letter
    // continuation) is still rejected.
    .match(/^docs\/([^/]+)\/sdd(\/|$|['"])/);
  return match?.[1] ?? "";
};

export const assertFlowGates = (
  root: string,
  planPath: string,
  opts: { requireMenu?: boolean } = {},
): FlowGateResult => {
  const doc = resolveDoc(root, "", planPath, "plan");
  if (!doc.ok) return err("path_invalid", doc.error);
  const slug = slugFromPath(planPath);
  // Effective read (CA-02): digest reconciliation runs before the gate trusts
  // persisted approvals; drift resets are persisted before gating.
  const effective = readEffectiveFlowState(root, slug);
  if (!effective.ok) return effective;
  const state = effective.state;
  if (state.spec.status !== "approved") {
    return err(
      "spec_not_approved",
      `spec not approved (status: ${state.spec.status}). Run workflow_spec_approve after the user's approval.`,
    );
  }
  if (state.plan.status !== "approved") {
    return err(
      "plan_not_approved",
      `plan not approved (status: ${state.plan.status}). Run workflow_plan_approve after the user's approval.`,
    );
  }
  if (opts.requireMenu && !state.menu.presented) {
    return err(
      "menu_not_presented",
      "post-plan menu not presented. Ask the native question menu (Subagent-driven/Inline/Handoff/Review spec/Review plan) and record the answer with workflow_plan_menu.",
    );
  }
  return { ok: true };
};

/**
 * Shared mutation guard for non-document product writes (FG-03, CA-18): a write
 * is blocked until the spec is approved, the plan is approved, the execution
 * menu has been recorded (when required), and the canonical docs validate.
 * The optional MutationContext adds the coordinator boundary (FG-05, CA-20).
 * The gate reconciles approval digests before trusting persisted approvals
 * (CA-02); drift resets are persisted before gating.
 */
export const assertProductGates = (
  root: string,
  slug: string,
  opts: { requireMenu?: boolean; requireDocs?: boolean } = {},
  ctx?: MutationContext,
): FlowGateResult => {
  const bound = assertMutationWorkspace(root, ctx);
  if (!bound.ok) return bound;
  // Effective strict read (CA-18): missing state surfaces flow_not_activated,
  // malformed state flow_state_invalid — never a misleading spec_not_approved
  // from a silent draft fallback. Fail-closed is preserved — no gate ever
  // passes on absent state.
  const effective = readEffectiveFlowState(root, slug);
  if (!effective.ok) return effective;
  const state = effective.state;
  if (state.spec.status !== "approved") {
    return err(
      "spec_not_approved",
      `spec not approved (status: ${state.spec.status}). Run workflow_spec_approve after the user's approval.`,
    );
  }
  if (state.plan.status !== "approved") {
    return err(
      "plan_not_approved",
      `plan not approved (status: ${state.plan.status}). Run workflow_plan_approve after the user's approval.`,
    );
  }
  if (opts.requireMenu && !state.menu.presented) {
    return err(
      "menu_not_presented",
      "post-plan menu not presented. Record the native question answer with workflow_plan_menu.",
    );
  }
  if (opts.requireDocs) {
    // Canonical relative form of the docs pair (DC-01/DC-02): docsValidate
    // resolves the contained paths itself.
    const validated = docsValidate({
      spec_path: path.posix.join("docs", slug, "spec.md"),
      plan_path: path.posix.join("docs", slug, "plan.md"),
      workspace_root: root,
    });
    if (validated.ok === false) return err("docs_invalid", validated.error);
  }
  return assertCoordinatorBoundary(ctx, state);
};

/**
 * Delegated status derives from host session parentage (AR-12, CA-20): a
 * session whose host record has a parent is a child (delegated worker); a root
 * session (no parent) is the coordinator. Caller-supplied role fields are
 * removed from every tool schema — this pure function is the only source.
 */
export const roleFromParentage = (parentID?: string | null): FlowRole =>
  parentID ? "delegated" : "coordinator";

/**
 * Root-session write interception while a subagent-driven plan is active
 * (CA-18, AR-13): known mutation tools are denied outright. Host-native write
 * tools (write/edit/apply_patch/patch/rename/delete/…) plus the workit
 * mutation tools are listed here so the plugin hook can deny them before any
 * file is touched. Read-only host tools (read/grep/glob/list/question/task/…)
 * are intentionally absent. The list is the audited boundary: adding a write
 * tool here without a test is the escape hatch the audit checks for.
 */
export const COORDINATOR_WRITE_TOOLS: readonly string[] = [
  // host-native file/command mutation tools
  "write",
  "edit",
  "apply_patch",
  "patch",
  "rename",
  "delete",
  "mkdir",
  "mv",
  "cp",
  "rm",
  "touch",
  "chmod",
  "chown",
  // workit product/config/external mutation tools
  "workflow_commit",
  "workflow_pr_create",
  "workflow_rule_edit",
  "workflow_template_edit",
  "workflow_changelog_apply",
  "workflow_branch_setup",
  "workflow_toolkit_init_apply",
  "workflow_docs_promote",
  "workflow_docs_layout",
  "workflow_docs_repo_link",
  "workflow_sdd_task_brief",
  "workflow_sdd_review_package",
  "workflow_sdd_append_progress",
  "workflow_youtrack_post",
  "workflow_youtrack_log_time",
];

/**
 * Bounded coordinator shell allowlist (CA-18, AR-13): while a subagent-driven
 * plan is active, the coordinator may run ONLY read/review/test/verify
 * commands — never anything that mutates files, git state, the system clock,
 * or the network.
 *
 * DENY matrix (every check below is asserted by the adversarial test table):
 * - Denied fragments, checked on the raw command before tokenizing:
 *   `>` `>>` `2>` `&>` `<>` (any `>` — redirection), `|` (pipes, incl. `2>|`),
 *   `&` (backgrounding), `;` (chains), `$(` (command substitution),
 *   `${` (parameter expansion — `${IFS}` can smuggle whitespace past the
 *   tokenizer), `$'` (ANSI-C quoting — can embed `\t`/`\n` escapes that are
 *   real whitespace to the shell), `` ` `` (backticks), newline (multi-line
 *   scripts), `<(` (process substitution input — `>(` dies on `>` already).
 *   Heredocs `<<` are stdin-only and allowed (a heredoc cannot write without
 *   a `>`). Literal `\t`/`\n` backslash escapes OUTSIDE `$'...'` are plain
 *   `t`/`n` characters to the shell — they cannot create whitespace
 *   (documented, FINDING 4).
 * - `(` `)` are denied per-token (process substitution `<(`, `>(`, subshells
 *   `(cmd)`, and `awk system(...)` all need them) — EXCEPT as git `--format`
 *   placeholders (`--format='%(refname)'`): a `--format` value is display
 *   text (the shell already consumed the quotes) and `$(`/`<(`/`>`/backticks
 *   are denied raw regardless (FINDING 3, round 4). Multi-token format
 *   values (a space inside the quoted format) stay denied — fail-closed.
 *   Pure-stdout verbs (`echo printf jq`) may print parens as display text:
 *   a shell-quote-state scan allows the command iff every paren lies inside
 *   a quoted region — any unquoted paren (subshell syntax, bash-verified
 *   syntax error) denies the whole command, fail-closed (FINDING 3, round 5).
 * - Denied command heads: `curl`, `sudo`, `tee`, `wget` (privilege/network/
 *   tee writes). These words are ONLY denied as the first token — as argument
 *   text (`grep curl README.md`, `cat sudo-config.txt`) they pass (FINDING 5).
 * - Every other first token must be one of the allowlisted sets below.
 * - Tokens are UNQUOTED (every `'`/`"` character stripped — the shell's word
 *   parsing removes quote characters entirely, so `--out'put=x'` IS
 *   `--output=x`, `-de'lete'` IS `-delete`, `cu'rl'` IS `curl`, `awk -'f x'`
 *   IS `awk -f x`) before every check (FINDING 2, round 5).
 * - `--output` and `--output=` (git log/diff and any other verb) are denied
 *   on every command: both forms write a file.
 * - Write-capable `-o`/attached `-oFILE`/`--output`/`--output=FILE` are
 *   denied on `sort`, `tree`, `comm`, `diff`, `jq` (grep/rg keep `-o` — it
 *   only prints the matching part, read-only; find's `-o` is the logical-OR
 *   operator and stays allowed).
 * - `--compress-program` (any form, every verb): GNU sort EXECUTES the given
 *   program with the sorted data on its stdin — `sh` runs that data as a
 *   script (bash-verified, FINDING 1, round 6). Only sort has the flag, but
 *   the deny is global so no flag surface needs tracking.
 * - `date -s`/`--set` (any attached/separate/`=` form): mutates the system
 *   clock (bash-verified setter, FINDING 3, round 6). `date -d`/`--date`
 *   (display) stays allowed.
 * - `sort -T`/`--temporary-directory` (any form): writes sort's own temp
 *   files into an arbitrary directory (bash/strace-verified, FINDING 4,
 *   round 6). `sort -t:` (field separator) stays allowed.
 * - Read-only tool heads (`cat head tail less more grep rg ag find ls stat wc
 *   file diff sort uniq cut tr fold printf echo pwd date which type du df tree
 *   jq basename dirname realpath readlink rev comm paste nl od xxd awk gawk
 *   mawk test [`):
 *   `find` is denied every destructive/file-writing form: `-delete -exec
 *   -execdir -ok -okdir` and `-fprint* -fls` (prefix).
 *   `sed` is NOT allowlisted at all (round 5, decision: deny outright). GNU
 *   sed 4.9 executes arbitrary commands through the `e` command (`sed 'e
 *   touch x' f`) and the `s///e` flag (bash-verified: both ran `touch` —
 *   e.g. `sed 's/.+/touch x/e' f`); closing the class needs a full sed script
 *   grammar, and five review rounds of sed escapes (`w`/`W`/`-f`/attached
 *   forms/quote joins) show a token parser cannot close it. sed reads are a
 *   nice-to-have — `cat`/`grep`/`awk` cover them.
 *   `awk`/`gawk`/`mawk` are denied every script file form (`-f`/`--file`,
 *   attached or separate — the script may contain `system(...)`/file
 *   redirects); `-F` (field separator, read-only) stays allowed.
 * - `tsc` with `--noEmit` (bare `tsc` can emit build artifacts).
 * - `git` with a read-only subcommand (`status log diff show branch rev-parse
 *   merge-base remote ls-files blame shortlog describe check-ignore name-rev
 *   stash grep tag`); `git stash` only as `git stash list`; the mutable
 *   listing subcommands (`branch tag remote`) are bare or one of their
 *   whitelisted read flags only — `branch` `-a -r -v -vv --all --remotes
 *   --verbose --show-current -l --list --merged --no-merged --contains
 *   --points-at --format --sort`, `tag` `-l --list --sort --contains
 *   --points-at --merged --no-merged --format --column`, `remote` `-v
 *   --verbose`. The value-taking flags (`--contains --points-at --merged
 *   --no-merged --sort --format`) accept AT MOST ONE following value token
 *   (a commit/tag name, a sort key, a format string — or glued
 *   `--flag=value`; verified read-only in bash). Every other flag
 *   (`-d -D -m -c -f -a -s ...`) is denied, a trailing NAME after a value
 *   is denied (it would CREATE a branch/tag), and non-listed subcommands
 *   (`config`, `var`, `push`, `commit`, `checkout`, `stash push`, ...) are
 *   denied outright.
 * - git exec-trigger flags are denied on every allowlisted subcommand
 *   (FINDING 2, round 6): `grep --open-files-in-pager[=<pager>]`/`-O[<pager>]`
 *   executes the pager with each matched file (`sh` executes the file —
 *   bash-verified), `log/diff/show --ext-diff` runs repo gitattributes
 *   external diff drivers, `log/diff/show/blame/grep --textconv` runs
 *   repo-configured textconv drivers, `--show-signature` runs gpg
 *   (core.gpg.program), `--remerge-diff` runs the merge machinery
 *   (external merge drivers). `-O` on log/diff/show is `--diff-order`
 *   (a read flag) and stays allowed; `--no-ext-diff`/`--no-textconv`
 *   disable the drivers and stay allowed. Global `-p`/`--paginate` (before
 *   the subcommand) are already denied by the subcommand-position rule;
 *   `git log -p` is `--patch` (read-only) and stays allowed.
 * - `git --no-pager <sub>` (global pager-disable, BEFORE the subcommand) is
 *   allowed and behaves exactly like `git <sub>` for every rule below — it
 *   never lifts a mutable/exec deny (FINDING 3, round 7). Combined
 *   read-only short flags (`-av`, `-ar`, `-avv` on `branch` — every char
 *   from the per-subcommand read set `branch: a r v l`, `tag: l`, `remote:
 *   v`) are allowed on the mutable listing subcommands; a combined form
 *   containing any write char (`git tag -av` creates an annotated tag,
 *   `git branch -adv` deletes) is denied (FINDING 4, round 7).
 * - A test runner head (`bun|npm|pnpm|yarn|npx`) with one of the test/check/
 *   lint/typecheck/verify/validate verbs (`vitest jest mocha` are runner
 *   verbs too, e.g. `npx jest`; `tsc` as a runner verb requires `--noEmit`).
 *   The FULL enumerated runner-write surface is denied on every runner verb
 *   (FINDING 1, round 7, bash-verified): `--fix*` (lint autofix), `--write*`
 *   (prettier), `--update*`/`-u` (snapshot updates — `bun test -u` rewrote
 *   the snapshot, verified), `-w` (write-capable short form in some runners;
 *   vitest/mocha watch is over-denied — the `--watch` long form stays
 *   allowed), `--coverage*` plus camelCase `--collectCoverage*` AND kebab
 *   `--collect-coverage*` (all write coverage/), `--outputFile`/`=` (jest
 *   JSON report — bash-verified, also
 *   denied globally as an output flag), `--cache*` (eslint/jest cache files;
 *   `--cache=false` is read-only but over-denied — the coordinator never
 *   needs cache control), and the tsc build-info flags (`-b`/`--build`,
 *   `--incremental`, `--tsBuildInfoFile`, `--composite` — they write
 *   .tsbuildinfo/outputs even with `--noEmit`). Matching is
 *   case-insensitive-prefix on lowercased tokens (camelCase cannot dodge
 *   the prefixes). Direct-head tools (`jest vitest eslint prettier oxlint
 *   oxfmt mocha ...`) are NOT allowlisted at all — head denial, so their
 *   write flags never reach the runner rules.
 * - `command` is allowed ONLY as `command -v <name>` / `command -V <name>`
 *   (path lookup — read-only); bare `command` EXECUTES and is denied.
 *   `test`/`[` evaluate expressions only and are read-only (FINDING 3,
 *   round 4).
 *
 * Test runner flags write nothing — exact statement (FINDING 1, round 7 +
 * round 8): the allowed verbs are `test check lint typecheck verify validate`
 * (plus the `vitest jest mocha` runner verbs and `tsc --noEmit`), and every
 * write-capable runner flag family is denied (snapshot updates
 * `-u`/`--update*`, autofix `--fix*`, `--write*`, `-w`, coverage
 * `--coverage*`/`--collectCoverage*`/`--collect-coverage*` (camel AND kebab),
 * jest JSON reports `--outputFile`, caches `--cache*`, tsc build-info
 * `-b`/`--incremental`/`--tsBuildInfoFile`/`--composite`), so no RUNNER
 * WRITE FLAG inside the boundary can write a file — that is the exact scope
 * of this claim. A test run itself can still write by design (inherent
 * allowance, stated here as the documented boundary): a first-run jest
 * creates new `__snapshots__` WITHOUT `-u`, and test code runs with
 * coordinator permissions — the test runner is admitted to the boundary as
 * a runner, not sandboxed. `bun run format` (writes) and `bun run build`
 * (dist) are NOT allowed. This allowlist is an audited security boundary (asserted by the
 * adversarial table). The EXACT deny statement (FINDING 3, round 6 — the old
 * "every WRITE form of the listed verbs" claim was false while `date -s` and
 * `sort -T` were unguarded): redirections, pipes, chains, substitution,
 * parens; `sed` denied outright (round 5 — its `e`/`s///e` commands execute);
 * awk/gawk/mawk `-f`/`--file` script files; `--output`/`--output-file`/`-o`
 * on output-flag verbs; `--compress-program` on EVERY verb (executes PROG
 * with data on stdin — `sh` runs sorted data as a script, bash-verified,
 * round 6); git mutable-subcommand mutations AND git exec-trigger flags
 * (`--open-files-in-pager`/`-O` on grep — executes the pager on matched
 * files, bash-verified; `--ext-diff`; `--textconv`; `--show-signature`;
 * `--remerge-diff`; global `-p`/`--paginate` denied by the subcommand-
 * position rule); `date -s`/`--set` (system-clock mutation, round 6);
 * `sort -T`/`--temporary-directory` (writes sort's temporaries into the
 * given directory, round 6); find's delete/exec/fprint family; runner
 * mutating flags (round 7: `-u`/`-w`/`--cache*`/`--collectCoverage*`/
 * `--outputFile`/tsc build-info added to the `--fix`/`--write`/`--coverage`/
 * `--update` families); `command` without `-v`/`-V` — and every head not
 * listed above is denied outright (unlisted write/exec/network commands
 * never enter the allowlist at all).
 */
const BASH_READ_TOKENS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "grep",
  "rg",
  "ag",
  "find",
  "ls",
  "stat",
  "wc",
  "file",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "fold",
  "printf",
  "echo",
  "pwd",
  "date",
  "which",
  "type",
  "du",
  "df",
  "tree",
  "jq",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "rev",
  "comm",
  "paste",
  "nl",
  "od",
  "xxd",
  "awk",
  "gawk",
  "mawk",
  "test",
  "[",
]);

const BASH_GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "rev-parse",
  "merge-base",
  "remote",
  "ls-files",
  "blame",
  "shortlog",
  "describe",
  "check-ignore",
  "name-rev",
  "stash",
  "grep",
  "tag",
]);

const BASH_GIT_MUTABLE_SUBCOMMANDS = new Set(["branch", "remote", "tag"]);

// Exact read-only flag forms per mutable git subcommand: every other flag or
// argument (a branch/tag name, `-d -D -m -c -f -a -s ...`) is a write and is
// denied (FINDING 1).
const BASH_GIT_READ_FLAGS: Record<string, Set<string>> = {
  branch: new Set([
    "-a",
    "--all",
    "-r",
    "--remotes",
    "-v",
    "--verbose",
    "-vv",
    "--show-current",
    "-l",
    "--list",
    "--merged",
    "--no-merged",
    "--contains",
    "--points-at",
    "--format",
    "--sort",
  ]),
  tag: new Set([
    "-l",
    "--list",
    "--sort",
    "--contains",
    "--points-at",
    "--merged",
    "--no-merged",
    "--format",
    "--column",
  ]),
  remote: new Set(["-v", "--verbose"]),
};

// Read-only SHORT flags per mutable git subcommand (FINDING 4, round 7):
// `branch` `-a -r -v -l` (+ `-vv` = `-v -v`), `tag` `-l` ONLY (`-a` creates
// an annotated tag), `remote` `-v` ONLY. Git combines short flags into one
// token (`-av` = `-a -v`), so a single-dash all-letter token is allowed iff
// EVERY character is a read char for that subcommand — any write char
// (`git tag -av` → `-a` creates; `git branch -adv` → `-d` deletes) denies.
const BASH_GIT_READ_SHORT_FLAGS: Record<string, string> = {
  branch: "arvl",
  tag: "l",
  remote: "v",
};

const isCombinedReadShortFlag = (sub: string, token: string): boolean => {
  if (!/^-[a-z]+$/.test(token)) return false;
  const allowed = BASH_GIT_READ_SHORT_FLAGS[sub] ?? "";
  for (let i = 1; i < token.length; i++) {
    if (!allowed.includes(token[i])) return false;
  }
  return true;
};

// find's destructive and file-writing forms: `-delete` deletes, `-exec/
// -execdir/-ok/-okdir` execute arbitrary commands, `-fprint/-fprintf/
// -fprint0/-fls` write files (FINDING 1).
const BASH_FIND_DENIED_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

const BASH_FIND_DENIED_PREFIXES = ["-fprint", "-fls"];

const BASH_TEST_RUNNERS = ["bun", "npm", "pnpm", "yarn", "npx"];

const BASH_TEST_VERBS = new Set([
  "test",
  "check",
  "lint",
  "typecheck",
  "verify",
  "validate",
  "vitest",
  "jest",
  "mocha",
]);

// Mutating flag families on test/lint verbs — the FULL enumerated
// runner-write surface (FINDING 1, round 7): `--fix*` (lint autofix),
// `--write*` (prettier), `--update*`/`-u` (snapshot updates — `bun test -u`,
// `npm test -u`, `jest -u`/`--updateSnapshot`), `-w` (write-capable short
// form in some runners; vitest/mocha watch is over-denied — the `--watch`
// long form stays allowed), `--coverage*` plus the camelCase
// `--collectCoverage*` AND the kebab `--collect-coverage*` (all write
// coverage/ — the kebab form escapes the camelCase entry because the dash
// breaks the prefix match, FINDING 1, round 8), `--cache*` (eslint/jest
// cache files; `--cache=false` is read-only but over-denied — the
// coordinator never needs cache control). Matching is
// case-insensitive-prefix on lowercased tokens so camelCase spellings cannot
// dodge the prefixes.
const BASH_MUTATING_TEST_FLAGS = [
  "--fix",
  "--write",
  "--update",
  "-u",
  "-w",
  "--coverage",
  "--collectcoverage",
  "--collect-coverage",
  "--cache",
];

// Privilege/network/tee-write heads: denied ONLY as the first token, so the
// words themselves stay legal as argument text (FINDING 5).
const BASH_DENIED_HEADS = new Set(["curl", "sudo", "tee", "wget"]);

// Write-capable -o/-oFILE/--output/--output=FILE on allowlisted read verbs
// (FINDING 1). grep/rg keep `-o` (read-only match printing); find keeps `-o`
// (logical OR). `--output` is denied globally for every command. jq `-o` is
// `--output-file` (round 3 audit — same write class as sort -o).
const BASH_OUTPUT_FLAG_VERBS = new Set(["sort", "tree", "comm", "diff", "jq"]);

const BASH_FORBIDDEN_FRAGMENTS = [">", "|", "&", ";", "$(", "${", "$'", "`", "\n", "<("];

// Pure-stdout verbs exempt from the per-token paren denial, but only for
// parens inside a fully-quoted token (display text). Unquoted parens stay
// denied. jq qualifies: its only write paths (`-o`/`--output-file`) are
// denied separately. awk is NOT exempt (`system(...)` executes). (FINDING 3,
// round 5)
const BASH_PAREN_EXEMPT_HEADS = new Set(["echo", "printf", "jq"]);

// Value-taking READ flags on the mutable git listing subcommands (FINDING 3,
// round 4): `--contains|--points-at|--merged|--no-merged [<commit>]`,
// `--sort <key>`, `--format <format>` — each takes AT MOST ONE following
// value token (the value may also be glued: `--sort=-x`, `--format='%(x)'`).
// The value is display/list filtering only — verified read-only in bash. A
// trailing NAME after a value would create a branch/tag (`git branch --sort=
// -x y`, `git tag --format=x y` both create), so anything that is neither a
// whitelisted flag nor the single value of a value flag is denied.
const BASH_GIT_VALUE_FLAGS = new Set([
  "--contains",
  "--points-at",
  "--merged",
  "--no-merged",
  "--sort",
  "--format",
]);

const gitGluedValueFlag = (token: string): boolean =>
  /^--(contains|points-at|merged|no-merged|sort|format)=.+/.test(token);

const hasMutatingTestFlag = (tokens: string[]): boolean => {
  const lower = tokens.map((t) => t.toLowerCase());
  return lower.some((t) => BASH_MUTATING_TEST_FLAGS.some((flag) => t.startsWith(flag)));
};

// Script FILE forms for awk/gawk/mawk (FINDING 2/3, round 3): the option may
// carry its value ATTACHED (`-fscript.awk`, `-f/tmp/evil.awk`, `--file=x`) —
// GNU awk accepts the attached short-option form, so any token starting with
// `-f`/`--file` is a script file. The script may contain `system(...)`/
// redirections. `-F` (awk field separator, read-only, uppercase) is NOT
// matched. sed is not allowlisted at all (round 5), so no sed -f rule exists.
const scriptFileForm = (token: string): boolean =>
  token === "-f" || token.startsWith("-f") || token.startsWith("--file");

const findDenied = (token: string): boolean =>
  BASH_FIND_DENIED_FLAGS.has(token) ||
  BASH_FIND_DENIED_PREFIXES.some((prefix) => token.startsWith(prefix));

// Any command may write via --output/--output=FILE (git log/diff, sort, ...)
// or --output-file/--output-file=FILE (jq). `--outputFile`/`--outputFile=`
// is jest's JSON-report flag (writes the report file — bash-verified,
// FINDING 1, round 7: `npx jest --json --outputFile=out.json` created the
// file); it is denied globally for the same reason as `--output-file`.
const outputFlagDenied = (token: string): boolean =>
  token === "--output" ||
  token.startsWith("--output=") ||
  token === "--output-file" ||
  token.startsWith("--output-file=") ||
  token === "--outputFile" ||
  token.startsWith("--outputFile=");

// `--compress-program` (GNU sort; any verb — global deny) EXECUTES PROG with
// the sorted data on its stdin: `sh` runs the data as a script (bash-verified,
// FINDING 1, round 6: `sort --buffer-size=1M --compress-program=sh` created
// PWNED_COMPRESS). The space form dies at the flag token; the `=` form here.
const compressProgramDenied = (token: string): boolean =>
  token === "--compress-program" || token.startsWith("--compress-program=");

// git flags that TRIGGER external program execution (FINDING 2, round 6):
// `grep --open-files-in-pager[=<pager>]` and its short form `-O[<pager>]`
// open each matched file with a pager — `sh` executes the file (bash-verified:
// `git grep --open-files-in-pager=sh -e x -- f` and `git grep -Osh` both
// created GITPWNED files); `log/diff/show --ext-diff` runs repo gitattributes
// external diff drivers; `log/diff/show/blame/grep --textconv` runs
// repo-configured textconv drivers; `--show-signature` runs gpg
// (core.gpg.program); `--remerge-diff` runs the merge machinery on merge
// commits (external merge drivers) — same driver-execution class, denied
// fail-closed. `-O` on grep is open-files-in-pager, but `-O` on log/diff/show
// is `--diff-order=<orderfile>` (a read flag) — the short form is scoped to
// grep. `--no-ext-diff`/`--no-textconv` DISABLE the drivers and stay allowed.
// Global `-p`/`--paginate` (before the subcommand) never reach this check —
// the subcommand-position rule already denies them (pinned in the matrix).
const gitExecFlagDenied = (sub: string, token: string): boolean => {
  if (sub === "grep" && (token === "-O" || token.startsWith("-O"))) return true;
  if (token === "--open-files-in-pager" || token.startsWith("--open-files-in-pager=")) return true;
  if (token === "--ext-diff" || token.startsWith("--ext-diff=")) return true;
  if (token === "--textconv" || token.startsWith("--textconv=")) return true;
  if (token === "--show-signature" || token.startsWith("--show-signature=")) return true;
  if (token === "--remerge-diff" || token.startsWith("--remerge-diff=")) return true;
  return false;
};

// `date -s`/`--set` (and attached `-sVALUE`, `--set=VALUE`) MUTATE the system
// clock (bash-verified: `date -s` attempts the set — "cannot set date:
// Operation not permitted", FINDING 3, round 6). No other GNU date flag
// starts with `-s`; `-d`/`--date` (display) stays allowed.
const dateSetDenied = (token: string): boolean =>
  token === "-s" || token.startsWith("-s") || token === "--set" || token.startsWith("--set=");

// `sort -T`/`--temporary-directory` writes sort's own temp files into an
// arbitrary directory (bash/strace-verified: `sort -T <dir>` created
// sortGdvlHf, sortV2VyNF, ..., FINDING 4, round 6). `-t:` (field separator,
// lowercase) is NOT matched. The space form dies at the flag token.
const sortTempDirDenied = (token: string): boolean =>
  token === "-T" ||
  token.startsWith("-T") ||
  token === "--temporary-directory" ||
  token.startsWith("--temporary-directory=");

// tsc build-info flags (FINDING 1, round 7): `-b`/`--build` (build mode
// writes outputs), and `--incremental`/`--tsBuildInfoFile`/`--composite`
// write `.tsbuildinfo` even WITH `--noEmit` — so `--noEmit` alone is not a
// sufficient read guarantee. Denied on BOTH the direct `tsc` head and the
// runner verb (`bun run tsc`); `tsc --noEmit` remains the only admitted form.
const tsBuildDenied = (token: string): boolean =>
  token === "-b" ||
  token.startsWith("-b") ||
  token === "--build" ||
  token.startsWith("--build=") ||
  token === "--incremental" ||
  token.startsWith("--incremental=") ||
  token === "--tsBuildInfoFile" ||
  token.startsWith("--tsBuildInfoFile=") ||
  token === "--composite" ||
  token.startsWith("--composite=");

export const isCoordinatorBashAllowed = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed) return false;
  for (const fragment of BASH_FORBIDDEN_FRAGMENTS) {
    if (trimmed.includes(fragment)) return false;
  }
  // FINDING 2 (round 5): the shell's word parsing REMOVES every quote
  // character when building argv — `'w'out` IS `wout`, `--out'put=x'` IS
  // `--output=x`, `-de'lete'` IS `-delete`, `awk -'f x'` IS `awk -f x`.
  // Strip ALL `'`/`"` from each token before every check so mid-token
  // quote joins cannot smuggle a deny-listed flag past the rules. Stripping
  // only removes characters, so a deny rule can never be evaded by it.
  const unquote = (token: string): string => token.replace(/['"]/g, "");
  const rawTokens = trimmed.split(/\s+/);
  const tokens = rawTokens.map(unquote);
  const head = tokens[0] ?? "";
  // `(`/`)` are denied per-token (process substitution `<(`, `>(`, subshells
  // `(cmd)`, and `awk system(...)` all need them) — EXCEPT as git `--format`
  // placeholders (`--format='%(refname)'`): the shell has already consumed
  // the quotes, so a `--format` value is display text, and `$(`/`<(`/`>`/
  // backticks are denied raw regardless (FINDING 3, round 4). A value token
  // AFTER a bare `--format` is likewise display text. Pure-stdout verbs
  // (`echo printf jq`) may print parens as display text: a shell-quote-state
  // scan of the RAW command allows the command iff every paren lies inside a
  // quoted region; any unquoted paren (subshell/syntax forms — bash-verified
  // syntax errors) denies the whole command, fail-closed. jq's only write
  // paths (`-o`/`--output-file`) are denied separately (FINDING 3, round 5).
  const parenExempt = BASH_PAREN_EXEMPT_HEADS.has(head);
  let parensSafe = true;
  if (parenExempt) {
    let state = 0; // 0 = unquoted, 1 = '...', 2 = "..."
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (state === 0) {
        if (ch === "'") state = 1;
        else if (ch === '"') state = 2;
        else if (ch === "(" || ch === ")") parensSafe = false;
      } else if (state === 1) {
        if (ch === "'") state = 0;
      } else if (ch === "\\") {
        i++; // escaped char inside "..."
      } else if (ch === '"') {
        state = 0;
      }
    }
  }
  let formatValue = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (formatValue) {
      formatValue = false;
      continue;
    }
    if (t.includes("(") || t.includes(")")) {
      if (parenExempt && parensSafe) continue;
      if (t.startsWith("--format=") && !t.includes("<(")) continue;
      return false;
    }
    formatValue = t === "--format";
  }
  if (BASH_DENIED_HEADS.has(head)) return false;
  if (tokens.some(outputFlagDenied) || tokens.some(compressProgramDenied)) return false;
  if (head === "git") {
    // FINDING 3 (round 7): `--no-pager` is a GLOBAL pager-disable that sits
    // BEFORE the subcommand (`git --no-pager log ...`) — read-only, the
    // exact counterpart of the already-allowed post-subcommand form. It only
    // shifts the subcommand position; every rule below (exec flags, mutable
    // subcommands, stash list, value walk) still applies to the real
    // subcommand. `git --no-pager` alone (no subcommand) falls through to
    // the subcommand-position deny.
    let subIndex = 1;
    if (tokens[1] === "--no-pager") subIndex = 2;
    const sub = tokens[subIndex] ?? "";
    const flagTokens = tokens.slice(subIndex + 1);
    if (flagTokens.some((t) => gitExecFlagDenied(sub, t))) return false;
    if (sub === "stash") return flagTokens[0] === "list";
    if (!BASH_GIT_READ_SUBCOMMANDS.has(sub)) return false;
    if (!BASH_GIT_MUTABLE_SUBCOMMANDS.has(sub)) return true;
    if (flagTokens.length === 0) return true; // bare listing (`git branch`)
    const flags = BASH_GIT_READ_FLAGS[sub];
    if (!flags) return false;
    // exact read flags, plus AT MOST ONE value after each value-taking flag,
    // plus combined read-only short flags (FINDING 4, round 7)
    let valuePending = false;
    for (const t of flagTokens) {
      if (flags.has(t) || gitGluedValueFlag(t)) {
        valuePending = BASH_GIT_VALUE_FLAGS.has(t);
        continue;
      }
      if (valuePending) {
        valuePending = false;
        continue;
      }
      if (isCombinedReadShortFlag(sub, t)) continue;
      return false;
    }
    return true;
  }
  if (head === "command") {
    // `command` EXECUTES its argument; only `command -v`/`-V` (lookup) is
    // read-only — exactly one name, no more (FINDING 3, round 4).
    return (tokens[1] === "-v" || tokens[1] === "-V") && tokens.length === 3;
  }
  if (head === "tsc") return tokens.includes("--noEmit") && !tokens.some(tsBuildDenied);
  if (BASH_READ_TOKENS.has(head)) {
    if (head === "find") return !tokens.some(findDenied);
    // awk/gawk/mawk: only the script-file form is denied (`-f`/`--file`,
    // attached or separate); `-F` (field separator) and reads stay allowed.
    if (head === "awk" || head === "gawk" || head === "mawk") {
      return !tokens.some(scriptFileForm);
    }
    // date: only `-s`/`--set` (clock mutation) is denied (FINDING 3, round 6).
    if (head === "date") return !tokens.some(dateSetDenied);
    // sort: `-T`/`--temporary-directory` (temp files in arbitrary dirs) is
    // denied; the `-o`/`--output` write forms are denied by the output-flag
    // check below (FINDING 4, round 6).
    if (head === "sort" && tokens.some(sortTempDirDenied)) return false;
    if (BASH_OUTPUT_FLAG_VERBS.has(head)) {
      return !tokens.some((t) => t === "-o" || t.startsWith("-o") || outputFlagDenied(t));
    }
    return true;
  }
  if (BASH_TEST_RUNNERS.includes(head)) {
    if (hasMutatingTestFlag(tokens)) return false;
    const verbIndex = tokens[1] === "run" ? 2 : 1;
    const verb = tokens[verbIndex] ?? "";
    if (verb === "tsc") return tokens.includes("--noEmit") && !tokens.some(tsBuildDenied);
    return BASH_TEST_VERBS.has(verb);
  }
  return false;
};

export const COORDINATOR_SHELL_DENIED_TEXT =
  "Coordinator shell commands are restricted while a subagent-driven plan is " +
  "active: only bounded read/test/review commands are allowed (the exact " +
  "allowlist is in flow-state.ts, isCoordinatorBashAllowed). " +
  COORDINATOR_RECOVERY_TEXT;

/**
 * The plugin hook's decision function (AR-13): a delegated child session
 * (host parentage) is never intercepted; the root session is intercepted only
 * while at least one subagent-driven plan is active in its workspace. Returns
 * the denial error to throw from `tool.execute.before`, or `{ ok: true }`.
 */
export const subagentDrivenInterception = (input: {
  tool: string;
  command?: string;
  parentID?: string | null;
  active: boolean;
}): FlowGateResult => {
  if (input.parentID) return { ok: true }; // delegated child — the worker
  if (!input.active) return { ok: true };
  if (COORDINATOR_WRITE_TOOLS.includes(input.tool)) {
    return err("coordinator_write_denied", COORDINATOR_RECOVERY_TEXT);
  }
  if (input.tool === "bash") {
    if (!input.command || !isCoordinatorBashAllowed(input.command)) {
      return err("coordinator_shell_denied", COORDINATOR_SHELL_DENIED_TEXT);
    }
  }
  return { ok: true };
};
