import { createInterface } from "node:readline/promises";
import {
  applyCutover,
  applyRollback,
  previewCutover,
  previewRollback,
  type CutoverDecision,
  type CutoverHost,
  type CutoverPaths,
} from "./logic";

export type CutoverCliDeps = {
  stdinIsTTY?: () => boolean;
  confirm?: () => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  out?: { write: (chunk: string) => void };
  err?: { write: (chunk: string) => void };
};

const CUTOVER_HOSTS: CutoverHost[] = ["opencode", "cursor", "codex", "pi"];

const defaultIsTTY = (): boolean => process.stdin.isTTY === true;

const defaultConfirm = async (out?: { write: (chunk: string) => void }): Promise<boolean> => {
  const rl = createInterface({
    input: process.stdin,
    output: (out ?? process.stdout) as NodeJS.WritableStream,
  });
  try {
    const answer = await rl.question("Apply cutover? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

const outStream = (deps: CutoverCliDeps) => deps.out ?? process.stdout;
const errStream = (deps: CutoverCliDeps) => deps.err ?? process.stderr;

const write = (stream: { write: (chunk: string) => void }, text: string) =>
  stream.write(text.endsWith("\n") ? text : `${text}\n`);

const writeJSON = (stream: { write: (chunk: string) => void }, value: unknown) =>
  write(stream, JSON.stringify(value, null, 2));

const usage = (err: { write: (chunk: string) => void }, message: string): number => {
  write(err, message);
  write(err, "usage: workit cutover preview [--json] [--hosts opencode,cursor,codex,pi]");
  write(err, "       workit cutover apply [--confirm] [--hosts ...] [--resolution key=value]...");
  write(err, "       workit cutover rollback preview <backupId> [--json]");
  write(err, "       workit cutover rollback apply <backupId> [--confirm]");
  return 2;
};

const parseHosts = (value: string | undefined): CutoverHost[] => {
  if (!value) return ["opencode", "cursor"];
  const hosts = value
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean) as CutoverHost[];
  return hosts.filter((h) => CUTOVER_HOSTS.includes(h));
};

const parseResolutions = (argv: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const token of argv) {
    if (!token.startsWith("--resolution=")) continue;
    const body = token.slice("--resolution=".length);
    const idx = body.indexOf("=");
    if (idx <= 0) continue;
    out[body.slice(0, idx)] = body.slice(idx + 1);
  }
  return out;
};

const cutoverPaths = (deps: CutoverCliDeps): CutoverPaths => ({
  env: deps.env ?? process.env,
  workspace: deps.cwd ?? process.cwd(),
});

const requireConfirm = async (
  argv: string[],
  deps: CutoverCliDeps,
  action: string,
): Promise<boolean> => {
  const isTTY = deps.stdinIsTTY ?? defaultIsTTY;
  const err = errStream(deps);
  if (argv.includes("--confirm")) return true;
  if (!isTTY()) {
    write(err, `--confirm required for cutover ${action} when stdin is not a TTY`);
    return false;
  }
  const confirm =
    deps.confirm ?? ((out?: { write: (chunk: string) => void }) => defaultConfirm(out));
  return confirm(outStream(deps));
};

const printPlan = (
  deps: CutoverCliDeps,
  plan: ReturnType<typeof previewCutover>,
  json: boolean,
) => {
  const out = outStream(deps);
  if (json) {
    writeJSON(out, plan);
    return;
  }
  write(out, `cutover plan ${plan.id}`);
  if (plan.blocked.length > 0) {
    write(out, "blocked:");
    for (const item of plan.blocked) write(out, `  - ${item}`);
  }
  if (plan.unresolved.length > 0) {
    write(out, "unresolved:");
    for (const item of plan.unresolved) write(out, `  - ${item.key}: ${item.reason}`);
  }
  write(out, `managed files: ${plan.managedFiles.length}`);
  write(out, `sessions: ${plan.sessions.length}`);
};

export async function runCutoverCommand(
  argv: string[],
  deps: CutoverCliDeps = {},
): Promise<number> {
  const err = errStream(deps);
  const [action, subaction, backupId, ...rest] = argv;
  if (!action) return usage(err, "missing cutover action");

  if (action === "preview") {
    const json = argv.includes("--json");
    const hosts = parseHosts(argv.find((t) => t.startsWith("--hosts="))?.slice("--hosts=".length));
    const plan = previewCutover(cutoverPaths(deps), hosts);
    printPlan(deps, plan, json);
    return plan.blocked.length > 0 ? 1 : 0;
  }

  if (action === "apply") {
    const hosts = parseHosts(argv.find((t) => t.startsWith("--hosts="))?.slice("--hosts=".length));
    const resolutions = parseResolutions(argv);
    const plan = previewCutover(cutoverPaths(deps), hosts);
    printPlan(deps, plan, false);
    if (plan.blocked.length > 0) {
      write(err, "cutover apply blocked — resolve preview findings first");
      return 1;
    }
    if (!(await requireConfirm(argv, deps, "apply"))) return 2;
    const decision: CutoverDecision = {
      approve: true,
      hosts,
      resolutions: Object.keys(resolutions).length > 0 ? resolutions : undefined,
    };
    const result = applyCutover(plan, decision, cutoverPaths(deps));
    if (!result.ok) {
      writeJSON(err, result);
      return result.code === "needs_input" ? 2 : 1;
    }
    write(
      outStream(deps),
      `cutover applied backupId=${result.data.backupId} partial=${result.data.partial}`,
    );
    for (const note of result.data.notes) write(outStream(deps), note);
    return result.data.partial ? 1 : 0;
  }

  if (action === "rollback") {
    if (!subaction || !backupId) {
      return usage(err, "rollback requires preview|apply and a backup id");
    }
    if (subaction === "preview") {
      const json = rest.includes("--json");
      const preview = previewRollback(backupId, cutoverPaths(deps));
      if (json) writeJSON(outStream(deps), preview);
      else {
        write(outStream(deps), `rollback preview ${backupId}`);
        write(outStream(deps), `restorable: ${preview.restorable.length}`);
        write(outStream(deps), `conflicts: ${preview.conflicts.length}`);
      }
      return preview.conflicts.length > 0 ? 1 : 0;
    }
    if (subaction === "apply") {
      const preview = previewRollback(backupId, cutoverPaths(deps));
      if (preview.conflicts.length > 0) {
        write(err, "rollback blocked — managed files changed after cutover");
        return 1;
      }
      if (!(await requireConfirm([...rest, backupId], deps, "rollback apply"))) return 2;
      const result = applyRollback(backupId, cutoverPaths(deps));
      if (!result.ok) {
        writeJSON(err, result);
        return 1;
      }
      write(outStream(deps), `rollback restored ${result.data.restored.length} managed file(s)`);
      return 0;
    }
    return usage(err, `unknown rollback action: ${subaction}`);
  }

  return usage(err, `unknown cutover action: ${action}`);
}
