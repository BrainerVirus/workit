// `workit lock` (issue #325): the machine-wide heavy-check lease under its
// own name. `status` shows who holds it, `wait` waits for a free slot without
// taking it, `run` is `workit check --heavy`, and `heavy` lists, tests and
// extends which commands the shell hook gates (core/heavy.ts).
//
//   workit lock status
//   workit lock wait [--timeout <s>]
//   workit lock run [--shell] [--wait <s>] [--timeout <s>] -- <cmd…>
//   workit lock heavy list | add <pattern> | remove <pattern> | test <cmd…>
import fs from "node:fs";
import path from "node:path";
import { CHECKS_FILE, loadCheckConfig } from "@brainervirus/workit-core/src/check-config";
import {
  heavyCommand,
  heavyCommandsFile,
  heavyPlan,
  machinePatterns,
  parsePattern,
  repoPatterns,
} from "@brainervirus/workit-core/src/core/heavy";
import {
  describeHolder,
  leaseDir,
  leaseSlots,
  resolveResourceSettings,
  type SlotState,
} from "@brainervirus/workit-core/src/core/resources";
import { emit, fail, ok, type Io } from "../output";
import { workspaceResources } from "./check";

const USAGE =
  "workit lock status | wait [--timeout <s>] | run [--shell] [--wait <s>] [--timeout <s>] -- <cmd…> | heavy list|add|remove|test";

async function settingsFor(io: Io) {
  const workspace = await workspaceResources(io);
  const config = loadCheckConfig(io.cwd);
  return resolveResourceSettings([
    { label: "workspaces.json", trust: "machine", value: workspace.value },
    { label: CHECKS_FILE, trust: "repo", value: config.resources },
  ]).settings;
}

const held = (slots: SlotState[]) => slots.filter((slot) => slot.holder && !slot.stale);

function slotLines(slots: SlotState[]): string[] {
  const busy = held(slots).length;
  return [
    `heavy-check lease: ${busy} of ${slots.length} slot${slots.length === 1 ? "" : "s"} held`,
    ...slots.map((slot) =>
      slot.holder
        ? `  slot ${slot.slot}: ${describeHolder(slot.holder)}${slot.stale ? ` (stale: ${slot.stale}; the next heavy check reclaims it)` : ""}`
        : `  slot ${slot.slot}: free`,
    ),
  ];
}

async function status(io: Io): Promise<number> {
  const settings = await settingsFor(io);
  const slots = leaseSlots(leaseDir(io.env), settings.slots);
  return emit(io, ok({ dir: leaseDir(io.env), slots, waitMs: settings.waitMs }), (data) =>
    slotLines(data.slots),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function timeoutOf(args: string[]): number | null | Error {
  const at = args.findIndex((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
  if (at < 0) return null;
  const raw = args[at].includes("=") ? args[at].split("=")[1] : args[at + 1];
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.round(seconds * 1000)
    : new Error("--timeout must be a number of seconds");
}

async function wait(args: string[], io: Io): Promise<number> {
  const timeout = timeoutOf(args);
  if (timeout instanceof Error) return emit(io, fail("invalid_input", timeout.message));
  const settings = await settingsFor(io);
  const limit = timeout ?? settings.waitMs;
  const dir = leaseDir(io.env);
  const started = Date.now();
  let told = false;
  for (;;) {
    const slots = leaseSlots(dir, settings.slots);
    const busy = held(slots);
    const waitedMs = Date.now() - started;
    if (busy.length < slots.length)
      return emit(io, ok({ free: true, waitedMs, slots }), () => [
        `workit: the heavy-check lease has a free slot${waitedMs ? ` after ${Math.round(waitedMs / 1000)} s` : ""}`,
      ]);
    if (waitedMs >= limit)
      return emit(
        io,
        fail("busy", `the heavy-check lease stayed busy for ${Math.round(waitedMs / 1000)} s`, {
          data: { free: false, waitedMs, slots },
          unblock: "workit lock status",
        }),
      );
    if (!told) {
      told = true;
      io.stderr(
        `workit: waiting for the heavy-check lease: held by ${busy.flatMap((slot) => (slot.holder ? [describeHolder(slot.holder)] : [])).join("; ")}\n`,
      );
    }
    await sleep(Math.min(1000, Math.max(1, limit - waitedMs)));
  }
}

async function runHeavy(args: string[], io: Io): Promise<number> {
  const split = args.indexOf("--");
  const head = split < 0 ? args : args.slice(0, split);
  const unknown = head.find(
    (arg, index) =>
      arg !== "--shell" &&
      arg !== "--json" &&
      !arg.startsWith("--timeout") &&
      !arg.startsWith("--wait") &&
      !((head[index - 1] === "--timeout" || head[index - 1] === "--wait") && !arg.startsWith("-")),
  );
  if (split < 0 || unknown)
    return emit(
      io,
      fail("invalid_input", unknown ? `unexpected ${unknown}` : "no command after --", {
        unblock: "workit lock run [--shell] [--wait <s>] [--timeout <s>] -- <cmd…>",
      }),
    );
  const check = await import("./check");
  // Passed to check, not a lock flag.
  return check.run([`--heavy`, ...head, ...args.slice(split)], io);
}

type PatternFile = { patterns: string[] } & Record<string, unknown>;

function readPatterns(file: string): PatternFile {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const patterns = Array.isArray(record.patterns)
        ? record.patterns.filter((item): item is string => typeof item === "string")
        : [];
      return { ...record, patterns };
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { patterns: [] };
}

function writePatterns(file: string, value: PatternFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

const commandText = (args: string[]): string => {
  const split = args.indexOf("--");
  return (split < 0 ? args : args.slice(split + 1)).join(" ").trim();
};

async function heavy(args: string[], io: Io): Promise<number> {
  const [action, ...rest] = args.filter((arg) => arg !== "--json");
  const file = heavyCommandsFile(io.env);
  if (action === "list")
    return emit(
      io,
      ok({ file, machine: machinePatterns(io.env), repo: repoPatterns(io.cwd) }),
      (data) => [
        "built in: test runners, builds and bundlers, lint and typecheck, installs, image builds, Sonar, browser tests (JS, Go, Rust, JVM, .NET, Python, Ruby, PHP, Elixir, Swift, C)",
        `machine (${data.file}): ${data.machine.length ? data.machine.join(", ") : "none"}`,
        `repo (${CHECKS_FILE} resources.heavyCommands): ${data.repo.length ? data.repo.join(", ") : "none"}`,
      ],
    );
  if (action === "add" || action === "remove") {
    const pattern = commandText(rest);
    if (!parsePattern(pattern))
      return emit(
        io,
        fail("invalid_input", `${action} needs a command pattern`, {
          unblock: `workit lock heavy ${action} '<command words>'`,
        }),
      );
    const current = readPatterns(file);
    const normalized = pattern.split(/\s+/u).join(" ");
    const has = current.patterns.includes(normalized);
    const patterns =
      action === "add"
        ? has
          ? current.patterns
          : [...current.patterns, normalized]
        : current.patterns.filter((item) => item !== normalized);
    try {
      if (patterns !== current.patterns) writePatterns(file, { ...current, patterns });
    } catch (error) {
      return emit(io, fail("unavailable", `cannot write ${file}: ${(error as Error).message}`));
    }
    const changed = action === "add" ? !has : has;
    return emit(io, ok({ file, pattern: normalized, changed, patterns }), () => [
      action === "add"
        ? `workit: ${changed ? "added" : "already had"} heavy pattern "${normalized}" (machine-wide, ${file})`
        : `workit: ${changed ? "removed" : "had no"} heavy pattern "${normalized}"`,
    ]);
  }
  if (action === "test") {
    const command = commandText(rest);
    if (!command)
      return emit(
        io,
        fail("invalid_input", "test needs a command", {
          unblock: "workit lock heavy test -- <cmd…>",
        }),
      );
    const match = heavyCommand(command, { cwd: io.cwd, env: io.env });
    // Host permission rules are the hook's to read; this answers without them.
    const plan = heavyPlan(command, { cwd: io.cwd, env: io.env, rules: null });
    return emit(
      io,
      ok({
        command,
        heavy: Boolean(match),
        reason: match?.reason ?? null,
        source: match?.source ?? null,
        rewrite: plan.kind === "rewrite" ? plan.command : null,
        split: plan.kind === "split" ? plan.reason : null,
      }),
      (data) =>
        !data.heavy
          ? ["light: the shell hook leaves it alone"]
          : data.rewrite
            ? [`heavy (${data.reason}): the shell hook runs it as ${data.rewrite}`]
            : data.split
              ? [`heavy (${data.reason}): the shell hook denies the chain: ${data.split}`]
              : [`heavy (${data.reason}): outside a git checkout the shell hook leaves it alone`],
    );
  }
  return emit(
    io,
    fail("invalid_input", `unknown lock heavy action ${action ?? "(none)"}`, {
      unblock: "workit lock heavy list|add <pattern>|remove <pattern>|test -- <cmd…>",
    }),
  );
}

export async function run(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return status(io);
  if (sub === "wait") return wait(rest, io);
  if (sub === "run") return runHeavy(rest, io);
  if (sub === "heavy") return heavy(rest, io);
  return emit(
    io,
    fail("invalid_input", `unknown lock subcommand ${sub ?? "(none)"}`, { unblock: USAGE }),
  );
}
