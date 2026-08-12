import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../shared/helpers/packages";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Task 31 Phase 9 traceability gate (AR-15, CA-44, CA-45): every post-audit
// finding (POST-01..15), every AR row (AR-01..15), and every Phase 9
// acceptance criterion (CA-33..45) maps to an exact test file+case or an
// exact command. A row is prose-only when its evidence target does not exist;
// the gate fails naming those rows. Evidence for behavior proven by Tasks
// 24-30 is referenced here, never re-implemented.

const DECLARED_BRANCH = "feature/workit-reliability-overhaul";
const PLAN = path.join(REPO_ROOT, "docs", "workit-reliability-overhaul", "plan.md");
const SPEC = path.join(REPO_ROOT, "docs", "workit-reliability-overhaul", "spec.md");

type Row = { row: string; requirement: string; evidence: string[] };

// Evidence grammar: "test-file::exact test name" resolves against the named
// test file; "command:bun run <script>" resolves against package.json
// scripts; "command:git ..." and "command:workflow_*" resolve against the
// plan's Step 6 / Step 5 text (executed by the coordinator, never in-test).
const ROWS: Row[] = [
  {
    row: "POST-01",
    requirement: "release can publish without built adapter dist/",
    evidence: [
      "test/artifacts/release-orchestration.test.ts::release job order is install → build → candidate gate → semantic-release (AR-01/CA-33)",
    ],
  },
  {
    row: "POST-02",
    requirement: "release rewrite/check order is after a possible publish",
    evidence: [
      "test/artifacts/release-orchestration.test.ts::rewrite runs before npm package verification and after version assignment (AR-02)",
    ],
  },
  {
    row: "POST-03",
    requirement: "clean CLI install omits both adapter packages",
    evidence: [
      "test/workit-cli/packed-cli.test.ts::packed CLI setup flow configures OpenCode + Cursor and doctor verifies it",
    ],
  },
  {
    row: "POST-04",
    requirement: "Workit package-prefix matching removes helper packages",
    evidence: [
      "test/artifacts/registration.test.ts::mergeOpenCodePlugins preserves prefix-shared helper packages (AR-04)",
    ],
  },
  {
    row: "POST-05",
    requirement: "Cursor launcher workspace is ignored by defaulted tools",
    evidence: [
      "test/workit-cursor/mcp-process.test.ts::run-server <workspace> from an unrelated cwd defaults omitted roots to the launcher workspace",
    ],
  },
  {
    row: "POST-06",
    requirement: "URL pathname builds and direct hook entry are not Windows-safe",
    evidence: [
      "test/workit-cursor/mcp-regressions.test.ts::build scripts derive their directory with fileURLToPath, not URL pathname",
    ],
  },
  {
    row: "POST-07",
    requirement: "object-shaped config accepts scalar/array/null JSON",
    evidence: [
      "test/workit-core/config.test.ts::AR-07: non-object config.json shapes are malformed with exact paths, never defaults",
    ],
  },
  {
    row: "POST-08",
    requirement: "embedded year-first dates derive Closes #2024",
    evidence: [
      "test/workit-core/pr-create.test.ts::AR-08: complete dates anywhere in a segment never close an issue",
    ],
  },
  {
    row: "POST-09",
    requirement: "preview omits host writes performed during Apply",
    evidence: [
      "test/workit-cli/platform-install.test.ts::preview/apply parity: every Apply write was previewed, exactly (AR-09/CA-39)",
    ],
  },
  {
    row: "POST-10",
    requirement: "custom credential paths are replaced by defaults",
    evidence: [
      "test/workit-cli/platform-install.test.ts::custom credential paths and canary bytes survive Apply (AR-10)",
    ],
  },
  {
    row: "POST-11",
    requirement: "doctor downgrades required installer failures",
    evidence: [
      "test/workit-core/doctor.test.ts::installer fails when a selected-host asset is missing",
    ],
  },
  {
    row: "POST-12",
    requirement: "native-choice evidence is model-forgeable",
    evidence: [
      "test/workit-opencode/flow-enforcement.test.ts::a caller-supplied evidence object is inert: no receipt means approval fails",
    ],
  },
  {
    row: "POST-13",
    requirement: "delegated identity and direct edits bypass coordinator gates",
    evidence: [
      "test/workit-core/flow-concurrency.test.ts::CA-18/AR-13: root-session interception blocks write tools and mutating shell once subagent-driven is active",
    ],
  },
  {
    row: "POST-14",
    requirement: "successful full checks emit unbounded negative Git diagnostics",
    evidence: [
      "test/workit-core/doctor.test.ts::AR-14: negative fixtures never leak raw git usage/fatal dumps into the suite output",
    ],
  },
  {
    row: "POST-15",
    requirement: "feature history still carries the pre-squash recovery lineage",
    evidence: ["command:git merge-base origin/main HEAD"],
  },
  {
    row: "AR-01",
    requirement:
      "release workflow builds every artifact and runs the release-candidate gate before semantic-release",
    evidence: [
      "test/artifacts/release-orchestration.test.ts::release job order is install → build → candidate gate → semantic-release (AR-01/CA-33)",
    ],
  },
  {
    row: "AR-02",
    requirement:
      "dependency rewriting before package verification and after version preparation; runnable build/verify:release-candidate scripts",
    evidence: [
      "test/artifacts/release-orchestration.test.ts::root scripts build the three adapters and run the pack-only gate (AR-02)",
      "test/artifacts/release-orchestration.test.ts::rewrite runs before npm package verification and after version assignment (AR-02)",
    ],
  },
  {
    row: "AR-03",
    requirement:
      "clean CLI install includes both adapters through declared same-release dependencies; tests never manually install undeclared siblings",
    evidence: [
      "test/artifacts/release-candidate.test.ts::packed CLI manifest declares both adapters at the core release version",
    ],
  },
  {
    row: "AR-04",
    requirement:
      "registration matches exact identities and version suffixes only; prefix-shared helpers remain untouched",
    evidence: [
      "test/artifacts/registration.test.ts::isWorkitPlugin rejects prefix-shared @brainervirus names, still accepts exact names",
    ],
  },
  {
    row: "AR-05",
    requirement:
      "Cursor launcher workspace becomes the default root when workspace_root is omitted",
    evidence: [
      "test/workit-cursor/mcp-process.test.ts::WORKFLOW_WORKSPACE_ROOT env beats the process cwd for omitted tool roots",
    ],
  },
  {
    row: "AR-06",
    requirement:
      "builds decode import.meta.url with fileURLToPath; Cursor MCP/hook manifests invoke Node explicitly on Linux, macOS, and Windows",
    evidence: [
      "test/workit-cursor/mcp-regressions.test.ts::build scripts derive their directory with fileURLToPath, not URL pathname",
    ],
  },
  {
    row: "AR-07",
    requirement:
      "every config reader, setup preflight, and doctor classifies parseable scalar/array/null JSON as malformed",
    evidence: [
      "test/workit-core/config.test.ts::AR-07: non-object config.json shapes are malformed with exact paths, never defaults",
    ],
  },
  {
    row: "AR-08",
    requirement:
      "date-like sequences anywhere in a branch segment cannot derive issue closures; explicit issue branches remain supported",
    evidence: [
      "test/workit-core/pr-create.test.ts::AR-08: complete dates anywhere in a segment never close an issue",
    ],
  },
  {
    row: "AR-09",
    requirement:
      "setup preview lists every exact Apply mutation; Apply rejects any unreviewed mutation",
    evidence: [
      "test/workit-cli/platform-install.test.ts::preview/apply parity: every Apply write was previewed, exactly (AR-09/CA-39)",
    ],
  },
  {
    row: "AR-10",
    requirement:
      "existing custom tokenFile paths and bytes remain authoritative unless the preview shows and the user approves a replacement",
    evidence: [
      "test/workit-cli/platform-install.test.ts::custom credential paths and canary bytes survive Apply (AR-10)",
    ],
  },
  {
    row: "AR-11",
    requirement:
      "doctor never reports an incomplete selected host as healthy; required installer checks remain failures with nonzero status",
    evidence: [
      "test/workit-core/doctor.test.ts::installer fails when a selected-host asset is missing",
    ],
  },
  {
    row: "AR-12",
    requirement:
      "approval, menu, and delegated identity come from host observations, not caller-created evidence, role, or taskIdentity",
    evidence: [
      "test/workit-opencode/flow-enforcement.test.ts::a host-issued question receipt is consumed by the approval tool without evidence args",
    ],
  },
  {
    row: "AR-13",
    requirement:
      "OpenCode intercepts known file-write tools and denies coordinator shell mutation while subagent-driven mode is active",
    evidence: [
      "test/workit-core/flow-concurrency.test.ts::CA-18/AR-13: root-session interception blocks write tools and mutating shell once subagent-driven is active",
    ],
  },
  {
    row: "AR-14",
    requirement:
      "the full check captures expected negative-command stderr so successful verification is free of repeated Git usage/fatal dumps",
    evidence: [
      "test/workit-core/doctor.test.ts::AR-14: negative fixtures never leak raw git usage/fatal dumps into the suite output",
    ],
  },
  {
    row: "AR-15",
    requirement:
      "final branch merges current main so the PR merge-base no longer predates the recovery change; revalidated without force-push or publish",
    evidence: [
      "command:git merge-base origin/main HEAD",
      "command:git merge --no-edit origin/main",
    ],
  },
  {
    row: "CA-33",
    requirement:
      "on a clean checkout with no generated dist/, the release job builds all adapters and completes verify:release-candidate before semantic-release",
    evidence: [
      "test/artifacts/release-orchestration.test.ts::a clean checkout tracks no generated adapter dist/ files (CA-33)",
      "test/artifacts/release-orchestration.test.ts::release job order is install → build → candidate gate → semantic-release (AR-01/CA-33)",
    ],
  },
  {
    row: "CA-34",
    requirement:
      "installing only the packed CLI and its declared dependency closure makes both adapter packages discoverable without manually copying sibling tarballs",
    evidence: [
      "test/workit-cli/packed-cli.test.ts::packed CLI setup flow configures OpenCode + Cursor and doctor verifies it",
    ],
  },
  {
    row: "CA-35",
    requirement:
      "unrelated package names that begin with a Workit package prefix survive registration merging unchanged",
    evidence: [
      "test/artifacts/registration.test.ts::mergeOpenCodePlugins preserves prefix-shared helper packages (AR-04)",
    ],
  },
  {
    row: "CA-36",
    requirement:
      "Cursor tools called without workspace_root use the launcher workspace; all build/hook entry paths pass Windows process tests",
    evidence: [
      "test/workit-cursor/mcp-process.test.ts::run-server <workspace> from an unrelated cwd defaults omitted roots to the launcher workspace",
      "test/workit-cursor/mcp-regressions.test.ts::cursor MCP manifests stay package-relative (mcp.json, marketplace.json, hooks-cursor.json)",
    ],
  },
  {
    row: "CA-37",
    requirement:
      "scalar, array, null, unreadable, and syntactically invalid configuration fixtures block readers, setup, and doctor with exact paths and nonzero status",
    evidence: [
      "test/workit-core/config.test.ts::AR-07: non-object config.json shapes are malformed with exact paths, never defaults",
      "test/workit-cli/wizard-config.test.ts::AR-07: readSetupState classifies non-object shapes as malformed on every file",
      "test/workit-core/doctor.test.ts::AR-07: doctor agrees with the readers on malformed shapes",
    ],
  },
  {
    row: "CA-38",
    requirement:
      "full date segments embedded after text cannot create issue clauses while explicit numeric issue branches retain documented behavior",
    evidence: [
      "test/workit-core/pr-create.test.ts::AR-08: complete dates anywhere in a segment never close an issue",
      "test/workit-core/pr-create.test.ts::B2: day-first date segments never derive a numeric issue id",
    ],
  },
  {
    row: "CA-39",
    requirement:
      "preview and Apply mutation sets are identical, including host package copies and registration files, and custom credential paths/bytes survive rerun",
    evidence: [
      "test/workit-cli/platform-install.test.ts::preview/apply parity: every Apply write was previewed, exactly (AR-09/CA-39)",
      "test/workit-cli/packed-cli.test.ts::packed CLI: custom credential paths and canary bytes survive preview/apply rerun (CA-39)",
    ],
  },
  {
    row: "CA-40",
    requirement:
      "installer doctor treats selected-host runtime, assets, launchers, registration, malformed config, and required utility defects as failures",
    evidence: [
      "test/workit-core/doctor.test.ts::installer fails when a selected-host asset is missing",
      "test/workit-core/doctor.test.ts::installer fails when a selected-host launcher entry is missing",
      "test/workit-core/doctor.test.ts::installer fails when the runtime is unavailable",
    ],
  },
  {
    row: "CA-41",
    requirement:
      "forged evidence, replayed receipts, mismatched sessions/labels, and caller-supplied delegated roles fail; a real host question plus child session succeeds",
    evidence: [
      "test/workit-opencode/flow-enforcement.test.ts::receipt replay fails: one receipt approves exactly once",
      "test/workit-opencode/flow-enforcement.test.ts::a real child session (host parentage) is delegated and passes product gates",
    ],
  },
  {
    row: "CA-42",
    requirement:
      "Cursor flow results expose unauthenticated confirmation provenance and subagent-driven selection returns actionable unsupported-mode failure",
    evidence: [
      "test/workit-cursor/flow-enforcement.test.ts::cursor MCP: subagent-driven menu is rejected as unsupported with recovery guidance",
      "test/workit-cursor/flow-enforcement.test.ts::cursor MCP: no evidence argument exists — caller-supplied evidence is inert",
    ],
  },
  {
    row: "CA-43",
    requirement:
      "a successful bun run check has zero test failures and no repeated raw Git usage/fatal dumps from expected negative fixtures",
    evidence: [
      "test/workit-core/doctor.test.ts::AR-14: negative fixtures never leak raw git usage/fatal dumps into the suite output",
      "command:bun run check",
    ],
  },
  {
    row: "CA-44",
    requirement:
      "the Phase 9 release candidate passes clean dependency install, isolated runtime, Linux/macOS/Windows, doctor, traceability, and no-publication checks",
    evidence: [
      "command:bun run verify:release-candidate",
      "test/artifacts/packed-runtime.test.ts::cli --help runs under node from the extracted package and exits 0",
      "test/artifacts/manifests.test.ts::ci.yml pins the declared support matrix (Bun/Node/OpenCode, 3 OS, no Deno)",
      "test/artifacts/reliability-report.test.ts::default report aggregates the deterministic candidate and an isolated doctor",
      "test/workit-cli/packed-cli.test.ts::packed CLI setup flow configures OpenCode + Cursor and doctor verifies it",
      "test/artifacts/release-candidate.test.ts::packing the candidate never invokes a publication command (RL-08/CA-30)",
    ],
  },
  {
    row: "CA-45",
    requirement:
      "before PR creation the feature branch has current main as its base, documents validate with all tasks numbered, and the PR diff excludes the recovery lineage",
    evidence: ["command:git merge-base origin/main HEAD", "command:workflow_docs_validate"],
  },
];

function resolveTest(target: string): string {
  const sep = target.indexOf("::");
  const rel = target.slice(0, sep);
  const name = target.slice(sep + 2);
  const file = path.join(REPO_ROOT, rel);
  expect(existsSync(file), `${rel}: file missing`).toBe(true);
  const src = readFileSync(file, "utf8");
  // Accept any whitespace between `test(` and the quoted name — formatters
  // may split long declarations across lines, and the options variant
  // `test("name", fn, { timeout })` is used by slow spawn-based cases.
  const testRe = new RegExp(`test\\(\\s*"${escapeRegExp(name)}"`);
  expect(testRe.test(src), `${rel}::${name}: case missing`).toBe(true);
  return `${rel}::${name}`;
}

function resolveCommand(cmd: string): string {
  if (cmd.startsWith("bun run ")) {
    const script = cmd.slice("bun run ".length).trim();
    const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    expect(typeof scripts[script], `package.json script ${script} missing`).toBe("string");
    return `package.json::scripts.${script}`;
  }
  const plan = readFileSync(PLAN, "utf8");
  expect(plan.includes(cmd), `plan.md does not document the command: ${cmd}`).toBe(true);
  return `plan.md::${cmd}`;
}

test("every mapped row resolves to an existing test case or declared command", () => {
  for (const row of ROWS) {
    for (const ev of row.evidence) {
      const where = ev.startsWith("command:") ? resolveCommand(ev.slice(8)) : resolveTest(ev);
      expect(where, `${row.row}: ${ev}`).toBeTruthy();
    }
  }
});

test("no row is prose-only: every POST/AR/CA row has at least one evidence target", () => {
  const unmapped = ROWS.filter((r) => r.evidence.length === 0).map((r) => r.row);
  expect(unmapped).toEqual([]);
});

test("the mapping table is complete: the spec carries no POST/AR/CA row outside the table", () => {
  const spec = readFileSync(SPEC, "utf8");
  const inSpec = {
    post: [...spec.matchAll(/POST-\d\d/g)].map((m) => m[0]),
    ar: [...spec.matchAll(/AR-\d\d/g)].map((m) => m[0]),
    ca: [...spec.matchAll(/CA-(?:3[3-9]|4[0-5])/g)].map((m) => m[0]),
  };
  const inTable = {
    post: ROWS.filter((r) => r.row.startsWith("POST-")).map((r) => r.row),
    ar: ROWS.filter((r) => r.row.startsWith("AR-")).map((r) => r.row),
    ca: ROWS.filter((r) => r.row.startsWith("CA-")).map((r) => r.row),
  };
  expect(new Set(inSpec.post)).toEqual(new Set(inTable.post));
  expect(new Set(inSpec.ar)).toEqual(new Set(inTable.ar));
  expect(new Set(inSpec.ca)).toEqual(new Set(inTable.ca));
});

test("the gate references the dependency-closure and release-ordering evidence instead of re-proving it", () => {
  const evidence = ROWS.flatMap((r) => r.evidence);
  expect(
    evidence.some((e) => e.startsWith("test/workit-cli/packed-cli.test.ts::")),
    "packed CLI declared-closure proof (AR-03/CA-34) must be referenced, not re-implemented",
  ).toBe(true);
  expect(
    evidence.some((e) => e.startsWith("test/artifacts/release-orchestration.test.ts::")),
    "release-ordering proof (AR-01/AR-02/CA-33) must be exercised",
  ).toBe(true);
});

test("the declared branch is active (AR-15/CA-45 pre-reconciliation state)", () => {
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(branch.status, branch.stderr ?? "").toBe(0);
  const head = branch.stdout.trim();
  if (head === DECLARED_BRANCH) return;
  // CI checks out the PR merge commit (detached HEAD): the declared branch
  // must exist and be an ancestor of the checked-out state. Post-merge the
  // declared branch is gone — nothing left to assert.
  const ref = spawnSync(
    "git",
    ["rev-parse", "--verify", `refs/remotes/origin/${DECLARED_BRANCH}`],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (ref.status !== 0) return;
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", ref.stdout.trim(), "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(ancestor.status).toBe(0);
});
