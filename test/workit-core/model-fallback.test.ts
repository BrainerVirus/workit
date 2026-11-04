import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { main } from "@/packages/workit-cli/src/main";
import {
  exhaustedProviders,
  LIMITS_FILE,
  markExhausted,
  providerOf,
} from "@/packages/workit-core/src/core/model-fallback";
import {
  chooseSpawnModel,
  leadSwitchNotice,
  resolveAvailableRoleModel,
  resolveRoleModel,
  roleModelIssues,
} from "@/packages/workit-core/src/core/role-models";
import {
  parseUsageLimit,
  recordUsageLimit,
  redispatchNote,
} from "@/packages/workit-core/src/hooks/model-limit";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

// #655: a role's ordered model list falls back past a provider whose usage
// limit is exhausted, until its reset; the limit text names the reset.

let configHome: ConfigHome;
let state: string;
const previousState = process.env.WORKIT_STATE_DIR;
beforeAll(() => {
  configHome = useConfigHome("wk-model-fallback-");
});
afterAll(() => {
  configHome.restore();
  if (previousState === undefined) delete process.env.WORKIT_STATE_DIR;
  else process.env.WORKIT_STATE_DIR = previousState;
});

const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const freshState = (): void => {
  state = temp("wk-model-fallback-state-");
  process.env.WORKIT_STATE_DIR = state;
};
freshState();
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true });
  freshState();
});

const config = (document: unknown): void =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify(document));

/** What OpenCode's subagent tool takes: `providerID/modelID`. */
const opencodeSubagentModel = (model: string): string | null =>
  model.includes("/") ? model : null;

const NOW = new Date("2026-11-03T15:00:00.000Z");
const HOUR = 3_600_000;

test("G Claude Code's real weekly-limit text, W it is parsed at noon in Santiago, T the reset is 7pm Santiago that day", () => {
  const limit = parseUsageLimit(
    "You've hit your weekly limit · resets 7pm (America/Santiago)",
    NOW,
  );
  expect(limit).not.toBeNull();
  expect(limit?.resetAt?.toISOString()).toBe("2026-11-03T22:00:00.000Z");
});

test("G the same text after 7pm Santiago, W it is parsed, T the reset is 7pm the next day", () => {
  const late = new Date("2026-11-03T23:30:00.000Z");
  expect(
    parseUsageLimit(
      "You've hit your weekly limit · resets 7pm (America/Santiago)",
      late,
    )?.resetAt?.toISOString(),
  ).toBe("2026-11-04T22:00:00.000Z");
});

test("G an Anthropic 5-hour limit, an Opus limit and a dated reset, W parsed, T each is a limit with its reset", () => {
  expect(
    parseUsageLimit("5-hour limit reached ∙ resets 3:30am (UTC)", NOW)?.resetAt?.toISOString(),
  ).toBe("2026-11-04T03:30:00.000Z");
  const opus = parseUsageLimit("You've hit your Opus limit · resets Nov 5, 9am (UTC)", NOW);
  expect(opus?.family).toBe("opus");
  expect(opus?.resetAt?.toISOString()).toBe("2026-11-05T09:00:00.000Z");
  expect(
    parseUsageLimit("Claude AI usage limit reached|1793750400", NOW)?.resetAt?.toISOString(),
  ).toBe(new Date(1_793_750_400_000).toISOString());
});

test("G OpenAI's usage limit and a 429 quota, W parsed, T both are limits; the OpenAI one resets after the named span", () => {
  const openai = parseUsageLimit(
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/pricing) or try again in 2 days 3 hours 5 minutes.",
    NOW,
  );
  expect(openai?.provider).toBe("openai");
  expect(openai?.resetAt?.getTime()).toBe(NOW.getTime() + (2 * 24 + 3) * HOUR + 5 * 60_000);
  const quota = parseUsageLimit(
    '429 {"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}',
    NOW,
  );
  expect(quota).not.toBeNull();
  expect(quota?.resetAt).toBeNull();
  expect(
    parseUsageLimit("rate_limit_error (429): retry-after: 7200", NOW)?.resetAt?.getTime(),
  ).toBe(NOW.getTime() + 2 * HOUR);
});

test("G a short 429 rate limit or unrelated text, W parsed, T it is no usage limit", () => {
  expect(
    parseUsageLimit(
      "429 Rate limit reached for gpt-5 in organization org-x. Please try again in 20s.",
      NOW,
    ),
  ).toBeNull();
  expect(parseUsageLimit("Error: ENOENT no such file", NOW)).toBeNull();
});

test("G a worker's prose about limits, W parsed, T it is no usage limit (a banner sentence marked Anthropic exhausted for 5h)", () => {
  expect(
    parseUsageLimit("Done: I added a usage limit banner to the settings page.", NOW),
  ).toBeNull();
  expect(
    parseUsageLimit(
      "Done: the client now handles a 429 from the API and honours retry-after: 3600 before retrying.",
      NOW,
    ),
  ).toBeNull();
  expect(parseUsageLimit("Users who hit your quota limit see a dialog.", NOW)).toBeNull();
});

test("G models of each subscription, W providerOf runs, T Anthropic, OpenAI and OpenCode Go are told apart", () => {
  expect(providerOf("opus")).toBe("anthropic");
  expect(providerOf("claude-sonnet-5-5")).toBe("anthropic");
  expect(providerOf("gpt-5.5")).toBe("openai");
  expect(providerOf("anthropic/claude-opus-5")).toBe("anthropic");
  expect(providerOf("opencode-go/kimi-k2")).toBe("opencode-go");
  expect(providerOf("mystery")).toBeNull();
  expect(providerOf("mystery", "codex_cli")).toBe("openai");
});

const VERIFIER_LIST = {
  models: {
    roles: { verifier: { opencode: ["anthropic/claude-sonnet-5", "openai/gpt-5.5"] } },
  },
};

test("G a verifier list and Anthropic marked exhausted, W the next verifier spawn runs, T the second model is applied", () => {
  config(VERIFIER_LIST);
  const cwd = temp("wk-model-fallback-cwd-");
  expect(
    chooseSpawnModel(cwd, { role: "verifier" }, "opencode", {}, opencodeSubagentModel).model,
  ).toBe("anthropic/claude-sonnet-5");
  recordUsageLimit("You've hit your weekly limit · resets 7pm (America/Santiago)", {
    cwd,
    host: "opencode",
    model: "anthropic/claude-sonnet-5",
  });
  const choice = chooseSpawnModel(cwd, { role: "verifier" }, "opencode", {}, opencodeSubagentModel);
  expect(choice.model).toBe("openai/gpt-5.5");
  expect(choice.note).toContain("fell back past anthropic/claude-sonnet-5");
});

test("G Anthropic exhausted until a reset, W the reset has passed, T the primary model is used again", () => {
  config(VERIFIER_LIST);
  const cwd = temp("wk-model-fallback-cwd-");
  markExhausted("anthropic", new Date(NOW.getTime() + HOUR), "weekly limit", NOW);
  expect(resolveAvailableRoleModel(cwd, { role: "verifier" }, "opencode", NOW)?.model).toBe(
    "openai/gpt-5.5",
  );
  const later = new Date(NOW.getTime() + 2 * HOUR);
  expect(resolveAvailableRoleModel(cwd, { role: "verifier" }, "opencode", later)?.model).toBe(
    "anthropic/claude-sonnet-5",
  );
});

test("G a limit text with no reset and models.limitWindow 2h, W recorded, T the provider is exhausted for 2h, stored in the user's state dir", () => {
  config({ models: { limitWindow: "2h" } });
  const cwd = temp("wk-model-fallback-cwd-");
  const seen = recordUsageLimit("You exceeded your current quota (insufficient_quota)", {
    cwd,
    host: "codex_cli",
    now: NOW,
  });
  expect(seen?.provider).toBe("openai");
  expect(seen?.until).toBe(new Date(NOW.getTime() + 2 * HOUR).toISOString());
  expect(existsSync(path.join(state, LIMITS_FILE))).toBe(true);
  expect(exhaustedProviders(NOW).map((one) => one.provider)).toEqual(["openai"]);
});

test("G no limitWindow, W a limit with no reset is recorded, T the default window is 5h", () => {
  const cwd = temp("wk-model-fallback-cwd-");
  const seen = recordUsageLimit("Claude usage limit reached.", {
    cwd,
    host: "claude_code",
    now: NOW,
  });
  expect(seen?.until).toBe(new Date(NOW.getTime() + 5 * HOUR).toISOString());
});

test("G every model in the list exhausted, W the spawn runs, T the primary runs and the note names the fix", () => {
  config(VERIFIER_LIST);
  const cwd = temp("wk-model-fallback-cwd-");
  const until = new Date(Date.now() + HOUR);
  markExhausted("anthropic", until, "limit");
  markExhausted("openai", until, "limit");
  const choice = chooseSpawnModel(cwd, { role: "verifier" }, "opencode", {}, opencodeSubagentModel);
  expect(choice.model).toBe("anthropic/claude-sonnet-5");
  expect(choice.note).toContain("Add a model of another provider");
});

test("G a list naming models a host cannot take, W Claude Code resolves the spawn, T the Claude model is chosen past the others", () => {
  config({ models: { roles: { verifier: ["openai/gpt-5.5", "sonnet"] } } });
  const cwd = temp("wk-model-fallback-cwd-");
  const choice = chooseSpawnModel(cwd, { role: "verifier" }, "claude_code", {}, (model) =>
    ["sonnet", "opus"].includes(model) ? model : null,
  );
  expect(choice.model).toBe("sonnet");
  expect(resolveRoleModel(cwd, { role: "verifier" }, "opencode")?.model).toBe("openai/gpt-5.5");
});

test("G an Opus limit, W a Sonnet verifier spawns on Claude Code, T only the Opus family counts as exhausted", () => {
  const cwd = temp("wk-model-fallback-cwd-");
  recordUsageLimit("You've hit your Opus limit · resets 7pm (UTC)", { cwd, host: "claude_code" });
  expect(exhaustedProviders().map((one) => one.provider)).toEqual(["anthropic/opus"]);
  expect(resolveAvailableRoleModel(cwd, { role: "verifier" }, "claude_code")?.skipped).toEqual([]);
  expect(
    resolveAvailableRoleModel(cwd, { role: "implementer", tier: "hard" }, "claude_code")
      ?.allExhausted,
  ).toBe(true);
});

test("G a worker that died on a limit, W the note is built twice for the same prompt, T it says re-dispatch once, then not again", () => {
  const cwd = temp("wk-model-fallback-cwd-");
  const seen = recordUsageLimit("You've hit your weekly limit · resets 7pm (UTC)", {
    cwd,
    host: "claude_code",
  });
  if (!seen) throw new Error("no limit recorded");
  const worker = { label: "worker w1", prompt: "GOAL: x\nWORKTREE: /w" };
  expect(redispatchNote(seen, worker)).toContain("Re-dispatch it once with the same prompt");
  expect(redispatchNote(seen, worker)).toContain("do not re-dispatch it again");
});

test("G a lead list and the lead's provider exhausted, W the switch notice is built, T it names the next lead model and the host's switch command", () => {
  config({ models: { lead: { opencode: ["anthropic/claude-opus-5", "openai/gpt-5.5"] } } });
  const cwd = temp("wk-model-fallback-cwd-");
  expect(leadSwitchNotice(cwd, "opencode", null)).toBeNull();
  markExhausted("anthropic", new Date(Date.now() + HOUR), "limit");
  expect(leadSwitchNotice(cwd, "opencode", null)).toContain(
    "Switch the lead to openai/gpt-5.5 with /models",
  );
  expect(leadSwitchNotice(cwd, "claude_code", "opus")).toContain("Add one to models.lead");
});

test("G lists in models.roles and a bad limitWindow, W issues are read, T lists are accepted and the window is reported", () => {
  config({
    models: {
      limitWindow: "soon",
      roles: { verifier: ["sonnet", { claude_code: ["opus"] }], reviewer: [] },
    },
  });
  const cwd = temp("wk-model-fallback-cwd-");
  expect(roleModelIssues(cwd)).toEqual([
    'global default models.limitWindow: not a duration such as "5h" or "1d 12h"; read as 5h',
    "global default models.roles.reviewer: an empty list; ignored",
  ]);
});

test("G Anthropic exhausted, W workit models show runs, T it lists the provider with its reset and the role's fallback", async () => {
  config(VERIFIER_LIST);
  const root = temp("wk-model-fallback-cwd-");
  const cwd = path.join(root, "app");
  mkdirSync(cwd);
  markExhausted("anthropic", new Date(Date.now() + HOUR), "You've hit your weekly limit");
  let stdout = "";
  const io = {
    cwd,
    env: { ...process.env, WORKIT_HOST: "", WORKIT_SESSION_ID: "" },
    stdout: (text: string) => void (stdout += text),
    stderr: () => {},
  };
  expect(await main(["models", "show", "--host", "opencode"], io)).toBe(0);
  expect(stdout).toContain("exhausted providers (usage limit):");
  expect(stdout).toMatch(
    /anthropic: until \d{4}-\d{2}-\d{2} \d{2}:\d{2} {2}\[You've hit your weekly limit\]/u,
  );
  expect(stdout).toContain("verifier: openai/gpt-5.5");
  stdout = "";
  await main(["models", "show", "--host", "opencode", "--json"], io);
  const data = JSON.parse(stdout).data;
  expect(data.exhausted[0].provider).toBe("anthropic");
  expect(data.roles.verifier.fallback).toContain("fell back past anthropic/claude-sonnet-5");
});
