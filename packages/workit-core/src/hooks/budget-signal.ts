// The worker tool-call budget (retro P9, ruling mvrhg6lc). A brief's TIMEBOX
// names `N tool calls`; the spawn that carries it records N for the next
// subagent of that type (`<store>/budget/spawns-<lead>.jsonl`), SubagentStart
// binds it to the agent (`<store>/budget/<agent>.json`: limit and the last
// multiple told), and every pre-tool hook of that agent appends one byte to
// `<store>/budget/<agent>.calls`. At N calls (and 2N, 3N…) one line rides the
// standing-order channel; the call is never denied. An agent without a
// budget file is never counted.
// fs, path and crypto only: the Codex launcher imports this before the
// runtime, and the Claude Code launcher (bin/workit-hook.mjs) keeps a copy of
// spawnBudget, noteSpawnBudget and tickBudget that
// test/workit-core/hooks/budget-signal.test.ts holds equal.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gitStoreDir } from "./standing-signal";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

const budgetDir = (store: string): string => path.join(store, "budget");

/** The same key as the standing seen file: one per host session or subagent. */
const agentBase = (store: string, session: string, agentId: string | null): string =>
  path.join(budgetDir(store), hash(`${session}\0${agentId ?? ""}`));

const spawnsFile = (store: string, session: string): string =>
  path.join(budgetDir(store), `spawns-${hash(session)}.jsonl`);

/** `N tool calls` on a brief's TIMEBOX line, else null. */
export const spawnBudget = (prompt: string): number | null => {
  const found = /^TIMEBOX:[^\n]*?\b(\d+)\s+tool calls\b/mu.exec(prompt);
  const n = found ? Number(found[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** A lead's spawn whose prompt carries a budget: queue it for the next subagent of `type`. */
export const noteSpawnBudget = (
  cwd: string,
  session: string,
  type: string | null,
  prompt: string,
): void => {
  try {
    const n = spawnBudget(prompt);
    const store = n && session ? gitStoreDir(cwd) : null;
    if (!store) return;
    fs.mkdirSync(budgetDir(store), { recursive: true });
    fs.appendFileSync(spawnsFile(store, session), `${JSON.stringify({ type: type ?? "", n })}\n`);
  } catch {
    // Without the note the worker runs unbudgeted.
  }
};

type Budget = { limit: number; told: number };

const readBudget = (file: string): Budget | null => {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
      limit?: unknown;
      told?: unknown;
    };
    return typeof value.limit === "number" && value.limit > 0
      ? {
          limit: value.limit,
          told: typeof value.told === "number" ? value.told : 0,
        }
      : null;
  } catch {
    return null;
  }
};

const writeAtomic = (file: string, text: string): void => {
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
};

/**
 * SubagentStart: bind the first queued budget of this agent's type (else an
 * untyped one) to the agent. Returns the limit, or null when none was queued.
 */
export const claimSpawnBudget = (
  cwd: string,
  session: string,
  agentId: string,
  agentType: string | null,
): number | null => {
  try {
    const store = session ? gitStoreDir(cwd) : null;
    if (!store) return null;
    const file = spawnsFile(store, session);
    const entries = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: unknown; n?: unknown };
        } catch {
          return {};
        }
      });
    let at = entries.findIndex((entry) => entry.type === (agentType ?? ""));
    if (at < 0) at = entries.findIndex((entry) => entry.type === "");
    const n = at < 0 ? null : entries[at].n;
    if (typeof n !== "number") return null;
    entries.splice(at, 1);
    writeAtomic(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    startBudget(store, session, agentId, n);
    return n;
  } catch {
    return null;
  }
};

const startBudget = (store: string, session: string, agentId: string | null, n: number): void => {
  fs.mkdirSync(budgetDir(store), { recursive: true });
  const base = agentBase(store, session, agentId);
  writeAtomic(`${base}.json`, JSON.stringify({ limit: n, told: 0 }));
  fs.rmSync(`${base}.calls`, { force: true });
};

/**
 * A host that launches the worker itself (Pi) binds the budget its prompt
 * names straight to the worker's session. Returns the limit, else null.
 */
export const bindBudget = (
  cwd: string,
  session: string,
  agentId: string | null,
  prompt: string,
): number | null => {
  try {
    const n = spawnBudget(prompt);
    const store = n && session ? gitStoreDir(cwd) : null;
    if (!n || !store) return null;
    startBudget(store, session, agentId, n);
    return n;
  } catch {
    return null;
  }
};

/**
 * Count one tool call of a budgeted agent. True when the count reached the
 * next untold multiple of the budget, so the runtime must load to tell it.
 */
export const tickBudget = (cwd: string, session: string, agentId: string | null): boolean => {
  try {
    const store = session ? gitStoreDir(cwd) : null;
    if (!store) return false;
    const base = agentBase(store, session, agentId);
    const budget = readBudget(`${base}.json`);
    if (!budget) return false;
    fs.appendFileSync(`${base}.calls`, ".");
    return fs.statSync(`${base}.calls`).size >= budget.limit * (budget.told + 1);
  } catch {
    return false;
  }
};

const lineFor = (calls: number): string =>
  `Tool-call budget reached (${calls}): commit your work, write your report, stop.`;

type Reached = { base: string; budget: Budget; reached: number };

const reachedOf = (cwd: string, session: string, agentId: string | null): Reached | null => {
  const store = session ? gitStoreDir(cwd) : null;
  if (!store) return null;
  const base = agentBase(store, session, agentId);
  const budget = readBudget(`${base}.json`);
  if (!budget) return null;
  let count = 0;
  try {
    count = fs.statSync(`${base}.calls`).size;
  } catch {
    return null;
  }
  return { base, budget, reached: Math.floor(count / budget.limit) };
};

/** The one line for a budget reached and not yet told (marked told), else null. */
export const budgetLine = (cwd: string, session: string, agentId: string | null): string | null => {
  try {
    const at = reachedOf(cwd, session, agentId);
    if (!at || at.reached <= at.budget.told) return null;
    writeAtomic(`${at.base}.json`, JSON.stringify({ limit: at.budget.limit, told: at.reached }));
    return lineFor(at.budget.limit * at.reached);
  } catch {
    return null;
  }
};

/**
 * For a host that rebuilds its context on every model call (OpenCode): the
 * line while the budget stands reached, else null. Never marks it told.
 */
export const budgetStanding = (
  cwd: string,
  session: string,
  agentId: string | null,
): string | null => {
  try {
    const at = reachedOf(cwd, session, agentId);
    return at && at.reached > 0 ? lineFor(at.budget.limit * at.reached) : null;
  } catch {
    return null;
  }
};

/**
 * One native PreToolUse payload (Codex shape): a lead's call whose tool input
 * carries a brief with `N tool calls` queues N, and a budgeted subagent's call
 * is counted. True when the count reached the budget, so the runtime tells it.
 */
export const observeHookBudget = (payload: string): boolean => {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (value.hook_event_name !== "PreToolUse" || typeof value.session_id !== "string")
      return false;
    const cwd = typeof value.cwd === "string" ? value.cwd : ".";
    const agentId =
      typeof value.agent_id === "string" && value.agent_id.trim() ? value.agent_id : null;
    const spawn = value.tool_input;
    if (!agentId && payload.includes("TIMEBOX:") && spawn && typeof spawn === "object") {
      const fields = spawn as Record<string, unknown>;
      const prompt = Object.values(fields).find(
        (field): field is string => typeof field === "string" && field.includes("TIMEBOX:"),
      );
      const type = [fields.agent_type, fields.subagent_type].find(
        (field): field is string => typeof field === "string",
      );
      if (prompt) noteSpawnBudget(cwd, value.session_id, type ?? null, prompt);
    }
    return agentId ? tickBudget(cwd, value.session_id, agentId) : false;
  } catch {
    return false;
  }
};
