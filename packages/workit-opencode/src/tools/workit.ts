import { realpathSync } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import {
  WorkitCore,
  TaskStore,
  canonicalJson,
  failure,
  operationSchemas,
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
    get: (input: { path: { id: string } }) => Promise<{ data?: SessionInfo }>;
  };
};

type SessionInfo = { id?: string; parentID?: string; directory?: string };

export const sessionParent = (session: unknown): string | undefined | null => {
  if (typeof session !== "object" || session === null) return null;
  if (!Object.prototype.hasOwnProperty.call(session, "parentID")) return undefined;
  const parentID = (session as SessionInfo).parentID;
  return typeof parentID === "string" && parentID.length > 0 ? parentID : null;
};

export type DirectChildren = Map<string, string>;
export type ReceiptExpectation = Partial<
  Pick<
    Receipt,
    | "callID"
    | "selectedLabel"
    | "selectedDescription"
    | "decisionPurpose"
    | "contentDigest"
    | "question"
  >
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
  selectedDescription: string;
  decisionPurpose: "design" | "action" | "limitation" | "preference";
  question: string;
  purpose: "decision" | "worker" | "resume" | "pause" | "complete";
  contentDigest: string;
  recordedAt: number;
};

const freshMs = 5 * 60 * 1000;
const rejectedDescription = "Reject this decision";

const decisionContent = (
  purpose: Receipt["decisionPurpose"],
  question: string,
  approvedContent: string,
) => ({
  header: `Workit decision: ${purpose}`,
  question,
  options: [
    { label: "approved", description: approvedContent },
    { label: "rejected", description: rejectedDescription },
  ],
});

const decisionOptions = (options: unknown) =>
  Array.isArray(options) &&
  options.length === 2 &&
  options.every(
    (option) =>
      typeof option === "object" &&
      option !== null &&
      typeof (option as { label?: unknown }).label === "string" &&
      typeof (option as { description?: unknown }).description === "string" &&
      Object.keys(option).length === 2 &&
      Object.keys(option).every((key) => key === "label" || key === "description"),
  )
    ? (options as Array<{ label: string; description: string }>)
    : null;

const purposeForQuestion = (question: Question): Receipt["purpose"] | undefined => {
  const header = typeof question.header === "string" ? question.header.trim() : "";
  const options = decisionOptions(question.options);
  const decisionPurpose = header.match(
    /^Workit decision: (design|action|limitation|preference)$/,
  )?.[1];
  if (
    decisionPurpose &&
    options !== null &&
    options[0].label === "approved" &&
    options[1].label === "rejected" &&
    options[1].description === rejectedDescription
  )
    return "decision";
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
    const answer =
      Array.isArray(answers) &&
      answers.length === 1 &&
      Array.isArray(answers[0]) &&
      answers[0].length === 1 &&
      typeof answers[0][0] === "string"
        ? answers[0][0]
        : undefined;
    if (typeof answer !== "string" || !answer.trim()) return;
    const args = input.args as { questions?: unknown } | undefined;
    const questions = args?.questions;
    if (!Array.isArray(questions) || questions.length !== 1) return;
    const question = questions[0] as Question;
    if (!question || typeof question !== "object") return;
    const purpose = purposeForQuestion(question);
    if (!purpose) return;
    const options = decisionOptions(question.options);
    if (!options) return;
    const selected = options?.find((option) => option.label === answer);
    if (!selected) return;
    const decisionPurpose =
      typeof question.header === "string"
        ? question.header.match(/^Workit decision: (design|action|limitation|preference)$/)?.[1]
        : undefined;
    if (!decisionPurpose) return;
    const content = decisionContent(
      decisionPurpose as Receipt["decisionPurpose"],
      typeof question.question === "string" ? question.question : "",
      options[0].description,
    );
    const receipt: Receipt = {
      sessionID: input.sessionID,
      callID: input.callID,
      selectedLabel: answer,
      selectedDescription: selected.description,
      decisionPurpose: decisionPurpose as Receipt["decisionPurpose"],
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
        (expected.selectedDescription !== undefined &&
          receipt.selectedDescription !== expected.selectedDescription) ||
        (expected.decisionPurpose !== undefined &&
          receipt.decisionPurpose !== expected.decisionPurpose) ||
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

const operationShapeFor = (family: OperationFamily): Record<string, any> => {
  const options = (
    operationSchemas[family] as unknown as {
      options: Array<{ shape: Record<string, any> }>;
    }
  ).options;
  const keys = new Set(options.flatMap((option) => Object.keys(option.shape)));
  const shape: Record<string, any> = {};
  for (const key of keys) {
    const schemas = options.map((option) => option.shape[key]).filter(Boolean);
    const schema =
      schemas.length === 1 ? schemas[0] : tool.schema.union(schemas as [any, any, ...any[]]);
    shape[key] =
      options.every((option) => key in option.shape) && !schema.isOptional()
        ? schema
        : schema.optional();
  }
  return shape;
};

const output = (value: unknown): string => JSON.stringify(value, null, 2);

const sessionData = async (client: SessionLookup | undefined, sessionID: string) => {
  if (!client) return null;
  try {
    const result = await client.session.get({ path: { id: sessionID } });
    const data = result.data;
    if (!data || data.id !== sessionID || typeof data.directory !== "string" || !data.directory)
      return null;
    return data;
  } catch {
    return null;
  }
};

export const sameWorkspace = (expected: string, observed: unknown): boolean => {
  if (typeof observed !== "string" || !observed) return false;
  try {
    return realpathSync(expected) === realpathSync(observed);
  } catch {
    return path.resolve(expected) === path.resolve(observed);
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
      receipt.selectedDescription !==
        (expected.response === "approved"
          ? expected.binding.approvedContent
          : rejectedDescription) ||
      receipt.decisionPurpose !== expected.purpose ||
      receipt.contentDigest !==
        sha256(
          canonicalJson(
            decisionContent(
              expected.purpose,
              expected.binding.presented,
              expected.binding.approvedContent,
            ),
          ),
        ) ||
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

export const nativeWorkerFor = (
  directChildren: DirectChildren,
  actor: string,
): NativeWorkerVerifier => ({
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
  const parentID = sessionParent(current);
  if (!current || !parentID) return null;
  const tasks = store.listTasks();
  if (!tasks.ok) return null;
  const matches = tasks.data.flatMap((task) => {
    if (task.status !== "active") return [];
    const coordinator = task.intent.provenance.session;
    if (
      coordinator?.kind !== "host" ||
      coordinator.host !== "opencode" ||
      coordinator.handle !== parentID ||
      directChildren.get(actor) !== parentID
    )
      return [];
    return task.workers.filter(
      (worker) =>
        worker.data.state === "running" &&
        worker.data.session?.kind === "host" &&
        worker.data.session.host === "opencode" &&
        worker.data.session.handle === actor,
    );
  });
  return matches.length === 1 ? matches[0].id : null;
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
      args: operationShapeFor(family),
      execute: async (args, context) => {
        const parsed = parseOperation(family, args);
        if (!parsed.ok) return output(parsed);
        if (!client)
          return output(
            failure("permission_denied", "OpenCode native session observation unavailable"),
          );
        const data = await sessionData(client, context.sessionID);
        if (data === null || !sameWorkspace(context.directory, data.directory ?? ""))
          return output(failure("permission_denied", "OpenCode session observation unavailable"));
        const parentID = sessionParent(data);
        if (parentID === null)
          return output(failure("permission_denied", "OpenCode session parentage is malformed"));
        const store = new TaskStore(context.directory);
        const workerId = await workerIdFor(store, client, context.sessionID, directChildren);
        if (parentID !== undefined && workerId === null)
          return output(
            failure("permission_denied", "OpenCode child session has no validated Workit worker"),
          );
        const operationContext: OperationContext = {
          root: context.directory,
          caller: { host: "opencode", actor: context.sessionID },
          capabilities: opencodeCapabilities(),
          constraints: [],
          now: () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
          workerId,
          nativeAuthority: nativeAuthority(receipts, context.sessionID),
          nativeWorker: nativeWorkerFor(directChildren, context.sessionID),
        };
        const core = new WorkitCore(store, operationContext);
        let result: Result<unknown>;
        if (family === "decision" && (args as { action?: string }).action === "record") {
          const decision = parsed.data as {
            response: string;
            purpose: Receipt["decisionPurpose"];
            binding: { presented: string; approvedContent: string };
          };
          const observed = receipts.consume(context.sessionID, "decision", {
            selectedLabel: decision.response,
            selectedDescription:
              decision.response === "approved"
                ? decision.binding.approvedContent
                : rejectedDescription,
            decisionPurpose: decision.purpose,
            contentDigest: sha256(
              canonicalJson(
                decisionContent(
                  decision.purpose,
                  decision.binding.presented,
                  decision.binding.approvedContent,
                ),
              ),
            ),
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
