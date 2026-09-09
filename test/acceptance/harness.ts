/** Deterministic acceptance harness and stable-release qualification gate. */

import { readFileSync } from "node:fs";
import path from "node:path";
import { codexQualification } from "../../packages/workit-codex/scripts/launch-mcp";
import { OPERATION_FAMILIES, operationJsonSchema } from "../../packages/workit-core/src/core";
import {
  operationSchemas,
  parseOperation,
} from "../../packages/workit-core/src/core/task-contract";
import { codexCapabilities } from "../../packages/workit-codex/hooks/workit-hook";
import { cursorCapabilities } from "../../packages/workit-cursor/hooks/workit-hook";
import { opencodeCapabilities } from "../../packages/workit-opencode/src/tools/workit";
import { piCapabilities } from "../../packages/workit-pi/src/context";
import { operationCorpus } from "../workit-core/task-fixtures";
import type { Capability } from "../../packages/workit-core/src/core/task-contract";
import {
  EVALUATION_SCENARIO_IDS,
  FIXTURE_REVISION,
  SAFETY_REPEAT_SCENARIOS,
  assertFixturesFrozen,
  type EvaluationScenarioId,
} from "./scenarios";

export type CodingHost = "opencode" | "cursor" | "codex_cli" | "codex_desktop" | "pi";

export const CODING_HOSTS: CodingHost[] = [
  "opencode",
  "cursor",
  "codex_cli",
  "codex_desktop",
  "pi",
];

export type EvaluationAuthorization = {
  models: Partial<Record<CodingHost, string>>;
  maxRuns: number;
  wallTimeMs: number;
  usageCeiling: { unit: "usd" | "tokens"; value: number };
  externalWrites: false;
};

export type EvaluationRun = {
  host: CodingHost;
  scenario: EvaluationScenarioId;
  workit: boolean;
  repeat?: number;
  kind: "main" | "safety_repeat";
  identity: string;
};

export type EvaluationPlan = {
  fixtureRevision: string;
  mainRuns: EvaluationRun[];
  safetyRepeats: EvaluationRun[];
  runs: EvaluationRun[];
};

export type QualificationReport = {
  fixtureRevision: string;
  liveRunsComplete: boolean;
  /** Passed live-run identities; required for exact coverage when liveRunsComplete is true. */
  completed: string[];
  missing: string[];
  discarded: string[];
  failed: string[];
  deterministicFailures: string[];
  toolchain: ToolchainEvidence | null;
};

export type ToolchainEvidence = {
  node: string;
  bun: string;
  typescript: string;
  zod: string;
  mcpSdk: string;
  hosts: Record<CodingHost, string>;
};

export type GateResult = { ok: boolean; reasons: string[] };

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

export const runIdentity = (
  run: Pick<EvaluationRun, "host" | "scenario" | "workit" | "repeat">,
): string => {
  const base = `${run.host}/${run.scenario}/${run.workit ? "workit" : "native"}`;
  return run.repeat ? `${base}/repeat-${run.repeat}` : base;
};

const makeRun = (
  host: CodingHost,
  scenario: EvaluationScenarioId,
  workit: boolean,
  kind: EvaluationRun["kind"],
  repeat?: number,
): EvaluationRun => {
  const run = { host, scenario, workit, repeat, kind };
  return { ...run, identity: runIdentity(run) };
};

export const buildEvaluationPlan = (_authorization?: EvaluationAuthorization): EvaluationPlan => {
  assertFixturesFrozen();
  const mainRuns: EvaluationRun[] = [];
  for (const host of CODING_HOSTS) {
    for (const scenario of EVALUATION_SCENARIO_IDS) {
      mainRuns.push(makeRun(host, scenario, true, "main"));
      mainRuns.push(makeRun(host, scenario, false, "main"));
    }
  }
  const safetyRepeats: EvaluationRun[] = [];
  for (const host of CODING_HOSTS) {
    for (const scenario of SAFETY_REPEAT_SCENARIOS) {
      safetyRepeats.push(makeRun(host, scenario, true, "safety_repeat", 1));
      safetyRepeats.push(makeRun(host, scenario, true, "safety_repeat", 2));
    }
  }
  return {
    fixtureRevision: FIXTURE_REVISION,
    mainRuns,
    safetyRepeats,
    runs: [...mainRuns, ...safetyRepeats],
  };
};

export const authorizedBudget = (): EvaluationAuthorization => ({
  models: {
    opencode: "authorized-fixture-model",
    cursor: "authorized-fixture-model",
    codex_cli: "authorized-fixture-model",
    codex_desktop: "authorized-fixture-model",
    pi: "authorized-fixture-model",
  },
  maxRuns: 90,
  wallTimeMs: 6 * 60 * 60 * 1000,
  usageCeiling: { unit: "usd", value: 50 },
  externalWrites: false,
});

export type FailureResult = { ok: false; code: "needs_input"; message: string };

export const authorizeLiveEvaluation = (
  authorization: EvaluationAuthorization | undefined,
  plannedRuns: number,
): { ok: true } | FailureResult => {
  if (!authorization) {
    return failure("needs_input", "live evaluation requires an explicit bounded authorization");
  }
  if (plannedRuns > authorization.maxRuns) {
    return failure(
      "needs_input",
      `live evaluation requires an explicit bounded authorization (planned ${plannedRuns} > max ${authorization.maxRuns})`,
    );
  }
  if (authorization.externalWrites !== false) {
    return failure(
      "needs_input",
      "live evaluation denies external writes unless separately authorized",
    );
  }
  for (const host of CODING_HOSTS) {
    if (!authorization.models[host]) {
      return failure("needs_input", `live evaluation requires an authorized model for ${host}`);
    }
  }
  return { ok: true };
};

const failure = (code: "needs_input", message: string): FailureResult => ({
  ok: false,
  code,
  message,
});

export const qualificationReport = (
  partial: Partial<QualificationReport> = {},
): QualificationReport => ({
  fixtureRevision: FIXTURE_REVISION,
  liveRunsComplete: partial.liveRunsComplete ?? false,
  completed: partial.completed ?? [],
  missing: partial.missing ?? [],
  discarded: partial.discarded ?? [],
  failed: partial.failed ?? [],
  deterministicFailures: partial.deterministicFailures ?? [],
  toolchain: partial.toolchain ?? null,
});

export const stableReleaseGate = (report: QualificationReport): GateResult => {
  const reasons: string[] = [];
  if (report.deterministicFailures.length > 0) {
    reasons.push(...report.deterministicFailures.map((f) => `deterministic:${f}`));
  }
  if (!report.toolchain) {
    reasons.push("toolchain evidence missing");
  }
  const matrix = collectCapabilityMatrix();
  if (matrix.some((cell) => !baselinePassesCapability(cell))) {
    reasons.push("capability_matrix_untested");
  }
  if (report.missing.length > 0) {
    reasons.push(...report.missing.map((id) => `missing run:${id}`));
  }
  if (report.discarded.length > 0) {
    reasons.push(...report.discarded.map((id) => `discarded run:${id}`));
  }
  if (report.failed.length > 0) {
    reasons.push(...report.failed.map((id) => `failed run:${id}`));
  }
  if (report.liveRunsComplete) {
    const required = buildEvaluationPlan().runs.map((run) => run.identity);
    const requiredSet = new Set(required);
    const accounted = new Set([
      ...report.completed,
      ...report.missing,
      ...report.failed,
      ...report.discarded,
    ]);
    if (accounted.size === 0) {
      reasons.push("live runs marked complete but no run identities recorded");
    }
    for (const id of required) {
      if (!accounted.has(id)) reasons.push(`unaccounted run:${id}`);
    }
    for (const id of accounted) {
      if (!requiredSet.has(id)) reasons.push(`unexpected run:${id}`);
    }
  } else {
    reasons.push("live qualification runs incomplete");
  }
  return { ok: reasons.length === 0, reasons };
};

const readPkgJson = (pkg: string) =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, "packages", pkg, "package.json"), "utf8"));

const HOST_VERSION_PLACEHOLDERS = new Set([
  "native-plugin",
  "mcp+hooks",
  "recorded-at-qualification",
  "unknown",
]);

/** True when a host version string came from an installed/pinned probe, not a placeholder. */
export const hostVersionIsProbed = (version: string): boolean =>
  version.length > 0 && !HOST_VERSION_PLACEHOLDERS.has(version);

const probeHostVersions = (): Record<CodingHost, string> => {
  const opencodePkg = readPkgJson("workit-opencode");
  const cursorPkg = readPkgJson("workit-cursor");
  const piPkg = readPkgJson("workit-pi");
  const codexCli = codexQualification("codex_cli");
  const codexDesktop = codexQualification("codex_desktop");
  const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const piVersion =
    rootPkg.devDependencies?.["@earendil-works/pi-coding-agent"] ??
    piPkg.devDependencies?.["@earendil-works/pi-coding-agent"] ??
    piPkg.peerDependencies?.["@earendil-works/pi-coding-agent"];
  return {
    opencode: `@opencode-ai/plugin@${opencodePkg.devDependencies["@opencode-ai/plugin"]}`,
    cursor: `@brainervirus/workit-cursor@${cursorPkg.version}`,
    codex_cli: `codex-cli@${codexCli.cli}`,
    codex_desktop: `codex-desktop@${codexDesktop.desktopPackage};bundled-cli@${codexDesktop.bundledCodexCli}`,
    pi: `@earendil-works/pi-coding-agent@${piVersion}`,
  };
};

export const collectToolchainEvidence = (): ToolchainEvidence => {
  const mcpPkg = readPkgJson("workit-mcp");
  const rootPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const hosts = probeHostVersions();
  for (const host of CODING_HOSTS) {
    if (!hostVersionIsProbed(hosts[host])) {
      throw new Error(`host version placeholder remains for ${host}: ${hosts[host]}`);
    }
  }
  return {
    node: process.version,
    bun: process.versions.bun ?? "unknown",
    typescript: rootPkg.devDependencies.typescript,
    zod: mcpPkg.dependencies.zod,
    mcpSdk: mcpPkg.dependencies["@modelcontextprotocol/sdk"],
    hosts,
  };
};

export type CapabilityCell = {
  host: CodingHost | "cli";
  capability: string;
  assurance: Capability["assurance"] | "unknown" | "untested";
  tested: boolean;
  reason: string;
};

const adapterCapabilities = (host: CodingHost): Capability[] => {
  switch (host) {
    case "opencode":
      return opencodeCapabilities();
    case "cursor":
      return cursorCapabilities({
        preToolUse: true,
        subagentStart: true,
        subagentStop: true,
        sessionStart: true,
      });
    case "codex_cli":
      return codexCapabilities("codex_cli", {
        preToolUse: true,
        subagentStart: true,
        subagentStop: true,
        sessionStart: true,
      });
    case "codex_desktop":
      return codexCapabilities("codex_desktop", {
        preToolUse: true,
        subagentStart: true,
        subagentStop: true,
        sessionStart: true,
      });
    case "pi":
      return piCapabilities({ hasUI: true });
  }
};

export const collectCapabilityMatrix = (): CapabilityCell[] => {
  const cells: CapabilityCell[] = [];
  for (const host of CODING_HOSTS) {
    for (const cap of adapterCapabilities(host)) {
      cells.push({
        host,
        capability: cap.name,
        assurance: cap.assurance,
        tested: true,
        reason: cap.reason,
      });
    }
  }
  cells.push({
    host: "cli",
    capability: "interactive_decision",
    assurance: "enforced",
    tested: true,
    reason: "TTY confirmation route; headless returns needs_input",
  });
  return cells;
};

/** Unknown or untested cells fail the applicable baseline instead of reading as supported. */
export const baselinePassesCapability = (cell: CapabilityCell): boolean => {
  if (!cell.tested || cell.assurance === "unknown" || cell.assurance === "untested") return false;
  return true;
};

export const renderCapabilitiesMarkdown = (cells: CapabilityCell[]): string => {
  const hosts = [...CODING_HOSTS, "cli"] as const;
  const capabilities = [...new Set(cells.map((c) => c.capability))].sort();
  const lines = [
    "# Workit v1 host capability matrix",
    "",
    `Generated from adapter fixtures. Fixture revision: \`${FIXTURE_REVISION}\`.`,
    "",
    "Unknown or untested cells fail the applicable baseline rather than reading as supported.",
    "",
    "| Capability | " + hosts.join(" | ") + " |",
    "| --- | " + hosts.map(() => "---").join(" | ") + " |",
  ];
  for (const capability of capabilities) {
    const row = hosts.map((host) => {
      const cell = cells.find((c) => c.host === host && c.capability === capability);
      if (!cell) return "—";
      if (!baselinePassesCapability(cell)) return `**${cell.assurance}** (fails baseline)`;
      return cell.assurance;
    });
    lines.push(`| ${capability} | ${row.join(" | ")} |`);
  }
  lines.push("", "## Adapter notes", "");
  for (const host of CODING_HOSTS) {
    lines.push(`### ${host}`, "");
    for (const cap of adapterCapabilities(host)) {
      lines.push(`- **${cap.name}** (${cap.assurance}): ${cap.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};

export const verifyMcpSchemaDialect = (): string[] => {
  const failures: string[] = [];
  for (const family of OPERATION_FAMILIES) {
    const schema = operationJsonSchema(family);
    if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      failures.push(`mcp_schema_dialect:${family}`);
    }
  }
  return failures;
};

const normalizedSchemaIssues = (
  issues: {
    code: string;
    keys?: PropertyKey[];
    path: PropertyKey[];
    message: string;
  }[],
) =>
  issues.map((issue) => ({
    path: issue.code === "unrecognized_keys" ? String(issue.keys?.join(".")) : issue.path.join("."),
    reason: issue.message,
  }));

/** CA-32: compiled z.compile() paths must agree with canonical operationSchemas on the shared corpus. */
export const verifyCompiledSchemaParity = (): string[] => {
  const failures: string[] = [];
  const corpus = [
    ...operationCorpus(),
    ...operationCorpus()
      .filter(
        (fixture, index, all) =>
          all.findIndex((other) => other.family === fixture.family) === index,
      )
      .map((fixture) => ({ ...fixture, input: { ...fixture.input, action: "unknown" } as never })),
  ];
  for (const fixture of corpus) {
    const raw = operationSchemas[fixture.family].safeParse(fixture.input);
    const compiled = parseOperation(fixture.family, fixture.input);
    if (raw.success) {
      if (!compiled.ok) failures.push(`compiled_schema_parity:${fixture.family}:success_mismatch`);
      continue;
    }
    if (compiled.ok) {
      failures.push(`compiled_schema_parity:${fixture.family}:failure_mismatch`);
      continue;
    }
    const expected = normalizedSchemaIssues(raw.error.issues);
    if (JSON.stringify(compiled.details.fields) !== JSON.stringify(expected)) {
      failures.push(`compiled_schema_parity:${fixture.family}:issue_mismatch`);
    }
  }
  return failures;
};

export const verifyDeterministicQualification = (): GateResult => {
  assertFixturesFrozen();
  const deterministicFailures = [...verifyMcpSchemaDialect(), ...verifyCompiledSchemaParity()];
  const toolchain = collectToolchainEvidence();
  const matrix = collectCapabilityMatrix();
  const untested = matrix.filter((c) => !baselinePassesCapability(c));
  if (untested.length > 0) {
    deterministicFailures.push("capability_matrix_untested");
  }
  const plan = buildEvaluationPlan(authorizedBudget());
  if (plan.runs.length !== 90) {
    deterministicFailures.push("evaluation_plan_size");
  }
  const gate = stableReleaseGate(
    qualificationReport({
      deterministicFailures,
      toolchain,
      liveRunsComplete: false,
      missing: plan.runs.map((r) => r.identity),
    }),
  );
  // Deterministic slice passes when only live-run evidence is outstanding.
  const deterministicOnly = deterministicFailures.length === 0 && toolchain !== null;
  return {
    ok: deterministicOnly,
    reasons: deterministicOnly
      ? []
      : gate.reasons.filter(
          (r) => !r.startsWith("missing run:") && r !== "live qualification runs incomplete",
        ),
  };
};

export const targetedRerunSet = (affected: string[]): string[] => {
  const plan = buildEvaluationPlan();
  const identities = new Set(affected);
  for (const run of plan.runs) {
    if (affected.includes(run.scenario)) identities.add(run.identity);
  }
  return [...identities];
};

export const enforceBudget = (
  authorization: EvaluationAuthorization,
  observed: { runs: number; elapsedMs: number; usage: number },
): GateResult => {
  const reasons: string[] = [];
  if (observed.runs > authorization.maxRuns) reasons.push("maxRuns exceeded");
  if (observed.elapsedMs > authorization.wallTimeMs) reasons.push("wallTime exceeded");
  if (observed.usage > authorization.usageCeiling.value) reasons.push("usage ceiling exceeded");
  return { ok: reasons.length === 0, reasons };
};
