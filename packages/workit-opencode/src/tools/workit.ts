import { tool } from "@opencode-ai/plugin";
import {
  WorkitCore,
  TaskStore,
  canonicalJson,
  failure,
  parseOperation,
  sha256,
  success,
  type OperationFamily,
  type OperationContext,
  type ContractResult as Result,
} from "@brainervirus/workit-core/src/core";
import type { NativeAuthorityVerifier } from "@brainervirus/workit-core/src/core/authority";
import type { NativeWorkerVerifier } from "@brainervirus/workit-core/src/core/workers";

type SessionLookup = {
  session: {
    get: (input: {
      path: { id: string };
    }) => Promise<{ data?: { parentID?: string; directory?: string } }>;
  };
};

export type DirectChildren = Map<string, string>;
export type ReceiptExpectation = Partial<
  Pick<Receipt, "callID" | "selectedLabel" | "contentDigest" | "question">
>;

type Question = {
  question?: unknown;
  header?: unknown;
  options?: unknown;
};

type Receipt = {
  sessionID: string;
  callID: string;
  selectedLabel: string;
  question: string;
  purpose: "decision" | "worker" | "resume" | "pause" | "complete";
  contentDigest: string;
  recordedAt: number;
};

const negative = /^(?:no|nope|nah|reject|cancel|decline|deny|skip|back|not now|not yet)\b/i;
const freshMs = 5 * 60 * 1000;

const purposeForQuestion = (question: Question): Receipt["purpose"] | undefined => {
  const text = `${String(question.header ?? "")} ${String(question.question ?? "")}`.toLowerCase();
  if (/\bdecision\b|\bapprove\b|\bapproval\b|\bconsent\b/.test(text)) return "decision";
  if (/\bworker\b|\bcancel\b/.test(text)) return "worker";
  if (/\bresume\b/.test(text)) return "resume";
  if (/\bpause\b/.test(text)) return "pause";
  if (/\bcomplete\b/.test(text)) return "complete";
  return undefined;
};

/** Host-only receipt queue. The only writer is the native question after-hook. */
export class NativeReceiptStore {
  #receipts = new Map<string, Receipt[]>();
  #observations = new WeakSet<object>();

  record(
    input: { sessionID: string; callID: string; args?: unknown },
    output: { metadata?: unknown },
  ): void {
    const answers = (output.metadata as { answers?: unknown } | undefined)?.answers;
    const answer = Array.isArray(answers) && Array.isArray(answers[0]) ? answers[0][0] : undefined;
    if (typeof answer !== "string" || !answer.trim()) return;
    const args = input.args as { questions?: unknown } | undefined;
    const questions = args?.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return;
    const question = questions[0] as Question;
    if (!question || typeof question !== "object") return;
    const purpose = purposeForQuestion(question);
    if (!purpose || negative.test(answer.trim())) return;
    const content = {
      header: typeof question.header === "string" ? question.header : "",
      question: typeof question.question === "string" ? question.question : "",
      options: question.options ?? null,
    };
    const receipt: Receipt = {
      sessionID: input.sessionID,
      callID: input.callID,
      selectedLabel: answer,
      question: content.question,
      purpose,
      contentDigest: sha256(canonicalJson(content)),
      recordedAt: Date.now(),
    };
    const queue = this.#receipts.get(input.sessionID) ?? [];
    queue.push(receipt);
    if (queue.length > 16) queue.shift();
    this.#receipts.set(input.sessionID, queue);
  }

  consume(
    sessionID: string,
    purpose: Receipt["purpose"],
    expected: ReceiptExpectation = {},
  ): { ok: true; receipt: Receipt; observation: object } | { ok: false; error: string } {
    const queue = this.#receipts.get(sessionID) ?? [];
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const receipt = queue[i];
      if (receipt.purpose !== purpose) continue;
      if (
        (expected.callID !== undefined && receipt.callID !== expected.callID) ||
        (expected.selectedLabel !== undefined &&
          receipt.selectedLabel !== expected.selectedLabel) ||
        (expected.contentDigest !== undefined &&
          receipt.contentDigest !== expected.contentDigest) ||
        (expected.question !== undefined && receipt.question !== expected.question)
      )
        return {
          ok: false,
          error: "permission_denied: native question receipt does not match the requested content",
        };
      queue.splice(i, 1);
      if (!queue.length) this.#receipts.delete(sessionID);
      if (Date.now() - receipt.recordedAt > freshMs)
        return { ok: false, error: "permission_denied: native question receipt is stale" };
      const observation = { receipt };
      this.#observations.add(observation);
      return { ok: true, receipt, observation };
    }
    return { ok: false, error: "permission_denied: no native question receipt for this purpose" };
  }

  verify(observation: unknown, sessionID: string, purpose: Receipt["purpose"]): Receipt | null {
    if (
      typeof observation !== "object" ||
      observation === null ||
      !this.#observations.has(observation)
    )
      return null;
    const receipt = (observation as { receipt?: Receipt }).receipt;
    if (!receipt || receipt.sessionID !== sessionID || receipt.purpose !== purpose) return null;
    return receipt;
  }
}

const operationShape = tool.schema
  .object({
    schemaVersion: tool.schema.literal(1),
    action: tool.schema.string(),
    taskId: tool.schema.string().optional(),
    expectedRevision: tool.schema.string().optional(),
    expectedWorkspaceRevision: tool.schema
      .union([tool.schema.string(), tool.schema.null()])
      .optional(),
    intent: tool.schema.any().optional(),
    progress: tool.schema.any().optional(),
    reason: tool.schema.string().optional(),
    view: tool.schema.string().optional(),
    assessment: tool.schema.any().optional(),
    evidence: tool.schema.any().optional(),
    claim: tool.schema.string().optional(),
    consequence: tool.schema.string().optional(),
    scope: tool.schema.any().optional(),
    candidateId: tool.schema.any().optional(),
    refs: tool.schema.any().optional(),
    findingId: tool.schema.string().optional(),
    disposition: tool.schema.string().optional(),
    evidenceIds: tool.schema.any().optional(),
    decisionIds: tool.schema.any().optional(),
    purpose: tool.schema.string().optional(),
    binding: tool.schema.any().optional(),
    response: tool.schema.string().optional(),
    requirementIds: tool.schema.any().optional(),
    decisionId: tool.schema.string().optional(),
    assignment: tool.schema.any().optional(),
    workerId: tool.schema.any().optional(),
    report: tool.schema.any().optional(),
    outcome: tool.schema.string().optional(),
    summary: tool.schema.string().optional(),
    bundle: tool.schema.any().optional(),
    authorityRefs: tool.schema.any().optional(),
    target: tool.schema.string().optional(),
    expectedBytes: tool.schema.string().optional(),
    snapshotDigest: tool.schema.string().optional(),
  })
  .passthrough().shape;

const output = (value: unknown): string => JSON.stringify(value, null, 2);

const sessionData = async (client: SessionLookup | undefined, sessionID: string) => {
  if (!client) return { parentID: undefined, directory: undefined };
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    return result.data ?? {};
  } catch {
    return null;
  }
};

const hostRef = (handle: string) => ({ kind: "host" as const, host: "opencode" as const, handle });

export const opencodeCapabilities = () => [
  {
    name: "interactive_decision",
    surface: "question",
    assurance: "enforced" as const,
    reason: "native question answers are observed by tool.execute.after and consumed once",
    refs: [hostRef("question")],
  },
  {
    name: "direct_child_workers",
    surface: "task",
    assurance: "enforced" as const,
    reason: "nested native task launches are denied and observed child sessions are parent-bound",
    refs: [hostRef("task")],
  },
  {
    name: "known_product_writes",
    surface: "write/edit/bash",
    assurance: "enforced" as const,
    reason: "known write surfaces check the authoritative core writer before execution",
    refs: [hostRef("tool.execute.before")],
  },
  {
    name: "arbitrary_shell_write",
    surface: "unobservable_shell",
    assurance: "agent_guided" as const,
    reason: "OpenCode does not expose a reliable interception boundary for every shell mutation",
    refs: [hostRef("tool.execute.before")],
  },
];

const nativeAuthority = (receipts: NativeReceiptStore, actor: string): NativeAuthorityVerifier => ({
  verifyDecision: ({ observation, expected, caller }) => {
    const receipt = receipts.verify(observation, actor, "decision");
    if (
      !receipt ||
      caller.host !== "opencode" ||
      caller.actor !== actor ||
      receipt.selectedLabel !== expected.response ||
      receipt.question !== expected.binding.presented
    )
      return failure("permission_denied", "native decision receipt is not bound to this session");
    return success(null, null, {
      kind: "host_observed",
      host: "opencode",
      session: hostRef(actor),
      workerId: null,
      receipts: [hostRef(receipt.callID)],
    });
  },
  verifyAction: () => failure("permission_denied", "native action observation is unavailable"),
});

const nativeWorker = (directChildren: DirectChildren, actor: string): NativeWorkerVerifier => ({
  verifyWorker: ({ expected, caller }) => {
    if (caller.host !== "opencode" || caller.actor !== actor || !expected.session)
      return failure("permission_denied", "native worker observation is unavailable");
    if (expected.session.kind !== "host" || directChildren.get(expected.session.handle) !== actor)
      return failure("permission_denied", "worker lineage is not an exact direct child");
    return success(null, null, {
      kind: "host_observed",
      host: "opencode",
      session: hostRef(expected.session.handle),
      workerId: expected.workerId,
      receipts: [hostRef(expected.session.handle)],
    });
  },
});

const workerIdFor = async (
  store: TaskStore,
  client: SessionLookup | undefined,
  actor: string,
  directChildren: DirectChildren,
): Promise<string | null> => {
  const current = await sessionData(client, actor);
  if (!current?.parentID) return null;
  const tasks = store.listTasks();
  if (!tasks.ok) return null;
  for (const task of tasks.data) {
    for (const worker of task.workers) {
      if (
        worker.data.session?.kind === "host" &&
        worker.data.session.handle === actor &&
        directChildren.get(actor) === current.parentID
      )
        return worker.id;
    }
  }
  return null;
};

export type WorkitToolOptions = {
  client?: SessionLookup;
  receipts?: NativeReceiptStore;
  directChildren?: DirectChildren;
};

export const createWorkitTools = ({
  client,
  receipts = new NativeReceiptStore(),
  directChildren = new Map<string, string>(),
}: WorkitToolOptions = {}) => {
  const make = (family: OperationFamily) =>
    tool({
      description: `Workit ${family} operations backed by the shared task contract.`,
      args: operationShape,
      execute: async (args, context) => {
        const parsed = parseOperation(family, args);
        if (!parsed.ok) return output(parsed);
        if (!client)
          return output(
            failure("permission_denied", "OpenCode native session observation unavailable"),
          );
        const data = await sessionData(client, context.sessionID);
        if (data === null)
          return output(failure("permission_denied", "OpenCode session observation unavailable"));
        const store = new TaskStore(context.directory);
        const workerId = await workerIdFor(store, client, context.sessionID, directChildren);
        const operationContext: OperationContext = {
          root: context.directory,
          caller: { host: "opencode", actor: context.sessionID },
          capabilities: opencodeCapabilities(),
          constraints: [],
          now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          workerId,
          nativeAuthority: nativeAuthority(receipts, context.sessionID),
          nativeWorker: nativeWorker(directChildren, context.sessionID),
        };
        const core = new WorkitCore(store, operationContext);
        let result: Result<unknown>;
        if (family === "decision" && (args as { action?: string }).action === "record") {
          const decision = parsed.data as {
            response: string;
            binding: { presented: string };
          };
          const observed = receipts.consume(context.sessionID, "decision", {
            selectedLabel: decision.response,
            question: decision.binding.presented,
          });
          if (!observed.ok) return output(failure("permission_denied", observed.error));
          result = core.observeDecision(parsed.data, observed.observation);
        } else {
          const run = core[family] as unknown as (request: unknown) => Result<unknown>;
          result = run.call(core, parsed.data);
        }
        return output(result);
      },
    });
  return Object.fromEntries(
    (
      ["task", "policy", "evidence", "finding", "decision", "worker", "writer", "state"] as const
    ).map((family) => [`workit_${family}`, make(family)]),
  );
};

export const observeQuestion = (
  receipts: NativeReceiptStore,
  input: { tool: string; sessionID: string; callID: string; args?: unknown },
  outputValue: { metadata?: unknown },
): void => {
  if (input.tool === "question") receipts.record(input, outputValue);
};

export type { Receipt };
