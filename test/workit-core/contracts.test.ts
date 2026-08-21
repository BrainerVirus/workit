import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runFlowCommand, runHandoffCommand } from "../../packages/workit-cli/src/flow";
import { createFlowTools } from "../../packages/workit-opencode/src/tools/flow";
import { buildHandoffPrompt } from "../../packages/workit-core/src/core/handoff-tools";
import {
  DESTINATION_MENU_CHOICES,
  DESTINATION_MENU_LABELS,
  HANDOFF_DESTINATION_MARKER,
  SOURCE_MENU_CHOICES,
  SOURCE_MENU_LABELS,
  HostReceiptStore,
  markHandoffDestination,
  readEffectiveFlowState,
  recordMenuChoice,
  transitionExecution,
} from "../../packages/workit-core/src/core/flow-state";
import {
  DESTINATION_REMINDER_TEXT,
  REMINDER_TEXT,
  SOURCE_MENU_LABELS_DISPLAY,
  reminderTextFor,
} from "../../packages/workit-core/src/core/reminder";

const skill = (name: string) =>
  readFileSync(
    path.join(import.meta.dir, "..", "..", "packages", "workit-core", "skills", name, "SKILL.md"),
    "utf8",
  );

// Destination-block extractors anchored on the sentinel marker rather than a
// `## ` heading or sentence, so a heading rename cannot make the scan go
// vacuous (advisory F10). `destinationBlockOf` covers the bullet allow-list
// (the last `## ` heading before the marker up to the marker); `destinationParaOf`
// covers the destination paragraph (from the marker onward).
const destinationBlockOf = (text: string): string => {
  const marker = text.indexOf(HANDOFF_DESTINATION_MARKER);
  if (marker < 0) return "";
  const heading = text.lastIndexOf("\n## ", marker);
  return text.slice(heading < 0 ? 0 : heading + 1, marker);
};

const destinationParaOf = (text: string): string => {
  const marker = text.indexOf(HANDOFF_DESTINATION_MARKER);
  return marker < 0 ? "" : text.slice(marker);
};

test("all native skills exist and contain no Cursor runtime vocabulary", () => {
  const root = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core");
  const dirs = readdirSync(path.join(root, "skills")).filter((name) => name.startsWith("wk-"));
  expect(dirs).toHaveLength(12);
  const source = dirs
    .map((dir) => readFileSync(path.join(root, "skills", dir, "SKILL.md"), "utf8"))
    .join("\n");
  for (const forbidden of [
    "Cursor TodoWrite",
    "Cursor AskQuestion",
    "${workspaceFolder}",
    "~/.cursor/plugins",
    "copy-paste prompt",
    "MCP tool",
    "/handoff-next-session",
    "/implement-from-plan",
  ]) {
    expect(source).not.toContain(forbidden);
  }
  for (const required of [
    "question",
    "todowrite",
    "task",
    "workflow_handoff_session",
    "workflow_verify",
  ]) {
    expect(source).toContain(required);
  }
});

test("meetings logs the sole configured target with explicit confirmation", () => {
  const text = skill("wk-meetings");
  expect(text).not.toContain("Pick meeting type");
  expect(text).toContain("`confirmed: true`, `issueId`, `minutes`, `text`");
  expect(text).toContain("correct invalid input before retrying");
});

test("issue update consumes the Result envelope and retries only proven missing time", () => {
  const text = skill("wk-issue-update");
  expect(text).toContain("result.ok");
  expect(text).toContain("result.data.postedComment");
  expect(text).toContain("result.data.retry");
  expect(text).toContain("`confirmed: true`, `issueId`, `minutes`");
  expect(text).toContain("outcome is `unknown`");
  expect(text).not.toContain("partial: true");
});

test("implement confirms every branch setup after previewing branch and stash behavior", () => {
  const text = skill("wk-implement");
  const contract = readFileSync(
    path.join(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "workit-core",
      "templates",
      "execution-contract.md",
    ),
    "utf8",
  );
  for (const source of [text, contract]) {
    expect(source).toContain("current branch");
    expect(source).toContain("target branch");
    expect(source).toContain("stash behavior");
    expect(source).toContain("clean tree");
    expect(source).toContain("proceed or cancel");
    expect(source).toContain("workflow_branch_setup");
    expect(source).toContain("confirmed: true");
  }
});

test("issue update names both safe retries and bounds each retry to one attempt", () => {
  const text = skill("wk-issue-update");
  expect(text).toContain('result.data.retry === "workflow_youtrack_post"');
  expect(text).toContain('result.data.retry === "workflow_youtrack_log_time"');
  expect(text).toContain("unchanged reviewed `issueId`, `markdown`, and `minutes`");
  expect(text).toContain("same `issueId` and `minutes`");
  expect(text).toContain("at most once");
  expect(text).toContain("second attempt fails");
});

test("status uses only the aggregate toolkit status tool", () => {
  const text = skill("wk-status");
  expect(text).toContain("Use only `workit_status`");
  expect(text).not.toContain("workflow_youtrack_verify_token");
});

test("handoff always ends the originating turn and never falls back inline", () => {
  const text = skill("wk-handoff");
  expect(text).toContain(
    "After any `workflow_handoff_session` result—success, partial, or failure—end the originating turn immediately",
  );
  expect(text).toContain(
    "Never create todos, execute the plan inline, modify files, retry handoff, or call another tool",
  );
});

test("wf commands never emit a bare Arguments: label", () => {
  const dir = path.join(import.meta.dir, "..", "..", "packages", "workit-core", "commands");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(path.join(dir, file), "utf8");
    expect(text).not.toMatch(/Arguments:\s*\$ARGUMENTS/);
    expect(text).not.toMatch(/Arguments:\s*$/m);
  }
});

test("post-plan override lists five fixed options and forbids two-option prose", () => {
  const packages = path.resolve(import.meta.dir, "..", "..", "packages");
  const surfaces = [
    readFileSync(
      path.join(packages, "workit-core", "templates", "superpowers-doc-contract.md"),
      "utf8",
    ),
    readFileSync(path.join(packages, "workit-opencode", "src", "bootstrap.ts"), "utf8"),
    readFileSync(path.join(packages, "workit-cursor", "rules", "ask-question-only.mdc"), "utf8"),
  ].join("\n");
  for (const label of [
    "Subagent-driven",
    "Inline",
    "Handoff",
    "Review spec first",
    "Review plan first",
  ]) {
    expect(surfaces).toContain(label);
  }
  const stripped = surfaces.replace(/do not emit[^\n]+/gi, "");
  expect(stripped).not.toMatch(/Two execution options:\s*\n/);
  expect(stripped).not.toContain("1. Subagent-Driven (recommended)");
  expect(surfaces).toMatch(/no stay|No `--stay` option/i);
  expect(surfaces).toContain("workflow_docs_validate");
});

test("source reminder prose carries the display-only (new session only) qualifier on the Handoff label", () => {
  // The machine label tuple and choice tuple stay bare `Handoff`/`handoff` so
  // the receipt label match never weakens (AR-12); the qualifier is display-only
  // in the source reminder prose, matching bootstrap/session-start/docs surfaces.
  expect(SOURCE_MENU_LABELS).toContain("Handoff");
  expect(SOURCE_MENU_CHOICES).toContain("handoff");
  expect(REMINDER_TEXT).toContain("Handoff (new session only)");
  expect(REMINDER_TEXT).not.toContain(
    "Subagent-driven, Inline, Handoff, Review spec first, Review plan first",
  );
  expect(DESTINATION_REMINDER_TEXT).not.toContain("Handoff");
});

test("source contracts/reminders expose five choices and destination contracts exactly four", () => {
  const packages = path.resolve(import.meta.dir, "..", "..", "packages");
  const coreTemplates = path.join(packages, "workit-core", "templates");
  const executionContract = readFileSync(path.join(coreTemplates, "execution-contract.md"), "utf8");
  const docContract = readFileSync(path.join(coreTemplates, "superpowers-doc-contract.md"), "utf8");
  // Choice arrays: destination is exactly the source minus handoff.
  expect(SOURCE_MENU_CHOICES).toHaveLength(5);
  expect(DESTINATION_MENU_CHOICES).toHaveLength(4);
  expect(DESTINATION_MENU_CHOICES).not.toContain("handoff");
  expect(DESTINATION_MENU_LABELS).not.toContain("Handoff");
  // Source surfaces carry all five labels; the destination wording never lists Handoff.
  expect(docContract).toContain("Subagent-driven");
  expect(docContract).toContain("Inline");
  expect(docContract).toContain("Handoff");
  expect(docContract).toContain("Review spec first");
  expect(docContract).toContain("Review plan first");
  expect(executionContract).toContain(HANDOFF_DESTINATION_MARKER);
  for (const label of DESTINATION_MENU_LABELS) expect(executionContract).toContain(label);
  // The destination allow-list block must not present a fifth Handoff choice.
  // Anchor on the marker (not a `## ` heading split) so a heading rename cannot
  // make the scan go vacuous, and match a strict choice form case-insensitively.
  const destinationBlock = destinationBlockOf(executionContract);
  for (const label of DESTINATION_MENU_LABELS) expect(destinationBlock).toContain(label);
  expect(destinationBlock).not.toMatch(/^\s*(?:[-*]|\d+\.)\s*handoff\s*$/im);
  // Reminders: source reminder lists five, destination reminder lists exactly four.
  expect(REMINDER_TEXT).toContain("Subagent-driven");
  expect(REMINDER_TEXT).toContain("Handoff");
  expect(DESTINATION_REMINDER_TEXT).toContain(HANDOFF_DESTINATION_MARKER);
  expect(DESTINATION_REMINDER_TEXT).not.toContain("Handoff");
  for (const label of DESTINATION_MENU_LABELS) expect(DESTINATION_REMINDER_TEXT).toContain(label);
  expect(reminderTextFor(false)).toBe(REMINDER_TEXT);
  expect(reminderTextFor(true)).toBe(DESTINATION_REMINDER_TEXT);
});

test("documented display labels match their base menu choices through the receipt matcher", () => {
  // Task 3 (label-matching parity): every label the hosts actually render — the
  // qualifier-decorated display forms in the reminder prose and the OpenCode
  // bootstrap question — must still match the bare machine enum through the
  // shared sameChoiceLabel matcher. A reworded display form that breaks the
  // match fails here instead of surfacing as a runtime evidence_mismatch.
  // The display forms come from reminder.ts's exported SOURCE_MENU_LABELS_DISPLAY
  // (single source of truth, advisory #5), never a re-derivation in the test.
  expect(REMINDER_TEXT).toContain(`exactly: ${SOURCE_MENU_LABELS_DISPLAY.join(", ")}.`);
  expect(DESTINATION_REMINDER_TEXT).toContain(`exactly: ${DESTINATION_MENU_LABELS.join(", ")}.`);
  const bootstrap = readFileSync(
    path.resolve(import.meta.dir, "..", "..", "packages", "workit-opencode", "src", "bootstrap.ts"),
    "utf8",
  );
  expect(bootstrap).toContain(`exactly: ${SOURCE_MENU_LABELS_DISPLAY.join(", ")}.`);

  // Same positional order as the choice enum (advisory #5): a reworded label or
  // reordered tuple breaks the pair mapping instead of drifting in silence.
  const displayToChoice = SOURCE_MENU_LABELS_DISPLAY.map(
    (display, i) => [display, SOURCE_MENU_CHOICES[i]] as [string, string],
  );
  for (const [display, choice] of displayToChoice) {
    const store = new HostReceiptStore();
    store.record("s1", `call-menu-${choice}`, display);
    const matched = store.consume("s1", { label: choice });
    expect(matched.ok, `${display} matches ${choice}`).toBe(true);
    if (matched.ok) expect(matched.receipt.selectedLabel).toBe(display);
    expect(store.count("s1")).toBe(0);
  }
});

test("implement review policy caps blockers and defers advisories", () => {
  const text = skill("wk-implement");
  const contract = readFileSync(
    path.join(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "workit-core",
      "templates",
      "execution-contract.md",
    ),
    "utf8",
  );
  for (const source of [text, contract]) {
    expect(source).toMatch(/two|2/);
    expect(source).toMatch(/advisory|Advisory/i);
    expect(source).toMatch(/Critical|Important|spec-compliance/);
  }
});

test("PR skills show title and body before create confirmation", () => {
  const root = path.resolve(import.meta.dir, "..", "..", "packages");
  for (const rel of ["workit-core/skills/wk-pr/SKILL.md", "workit-cursor/skills/wk-pr/SKILL.md"]) {
    const text = readFileSync(path.join(root, rel), "utf8");
    const body = text.split("## Rules")[0] ?? text;
    const showIdx = body.search(
      /\*\*Show\*\*|Show title|Show the exact Title|Title:\s*\n|<copy-paste title>/i,
    );
    const createQ = body.search(
      /Create the reviewed|create this MR\/PR|Create MR\/PR now|before creation/i,
    );
    const createTool = body.indexOf("workflow_pr_create");
    expect(showIdx).toBeGreaterThanOrEqual(0);
    expect(createQ).toBeGreaterThan(showIdx);
    expect(createTool).toBeGreaterThan(createQ);
  }
});

test("native runtime outputs use OpenCode-neutral vocabulary", () => {
  const root = path.resolve(import.meta.dir, "..", "..", "packages", "workit-core");
  const sources = [
    "src/core/sdd.ts",
    "src/core/repo-context.ts",
    "src/core/verify-project.ts",
    "src/core/init.ts",
    "src/core/vcs-config.ts",
  ]
    .map((file) => readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  for (const stale of [
    "Cursor TodoWrite",
    "Cursor AskQuestion",
    "Cursor plugin",
    "MCP tool",
    "Cursor workspace",
  ]) {
    expect(sources).not.toContain(stale);
  }
  expect(sources).toContain("OpenCode");
});

test("quality templates and findings are wired into contracts", () => {
  const implement = readFileSync(
    path.resolve(import.meta.dir, "../../packages/workit-core/skills/wk-implement/SKILL.md"),
    "utf8",
  );
  const exec = readFileSync(
    path.resolve(import.meta.dir, "../../packages/workit-core/templates/execution-contract.md"),
    "utf8",
  );
  const specContract = readFileSync(
    path.resolve(
      import.meta.dir,
      "../../packages/workit-core/templates/superpowers-doc-contract.md",
    ),
    "utf8",
  );
  expect(implement).toMatch(/spec-template\.md|plan-template\.md/);
  expect(implement).toMatch(/quality/);
  expect(exec).toMatch(/quality/);
  expect(specContract).toMatch(/spec-template\.md/);
});

test("SDD contracts name gitignored docs/<slug>/sdd/ with no nested slug and no early ledger", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const surfaces = [
    "packages/workit-core/skills/wk-implement/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-implement/SKILL.md",
    "packages/workit-cursor/skills/wk-implement/SKILL.md",
    "packages/workit-cursor/rules/sdd-docs-path.mdc",
    "packages/workit-cursor/hooks/session-start.ts",
    "packages/workit-core/templates/execution-contract.md",
    "packages/workit-opencode/assets/templates/execution-contract.md",
    "packages/workit-cursor/assets/templates/execution-contract.md",
    "packages/workit-cli/assets/templates/execution-contract.md",
    "packages/workit-core/templates/superpowers-doc-contract.md",
    "packages/workit-opencode/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cursor/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cli/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cursor/skills/wk-handoff/SKILL.md",
  ]
    .map(read)
    .join("\n");
  // Canonical working state is docs/<slug>/sdd/ and is gitignored, never tracked.
  expect(surfaces).toContain("docs/<slug>/sdd/");
  expect(surfaces).toContain("gitignored");
  expect(surfaces).not.toMatch(/tracked `docs\/<slug>\/sdd/);
  // No "tracked" adjective may describe SDD working state on any shipped copy.
  expect(surfaces).not.toMatch(/tracked (SDD|state|ledger|brief|diff|under `docs\/<slug>\/sdd)/i);
  // No nested slug level under sdd/ on any shipped surface.
  expect(surfaces).not.toContain("sdd/<slug>");
  // Nothing claims the context creates the sdd dir or an empty progress ledger —
  // including the cursor rule's bold `**creates** `docs/<slug>/sdd/progress.md``
  // phrasing (D8: `\s+` alone would fail on the `**` boundary).
  expect(surfaces).not.toMatch(/creates\s*\*{0,2}\s*`?docs\/<slug>\/sdd\/progress\.md`?/i);
  expect(surfaces).not.toMatch(/creates\s*\*{0,2}\s*`?docs\/<slug>\/sdd\/?`?/i);
});

test("SDD create-prohibition regex catches the bold **creates** phrasing (D8)", () => {
  for (const bold of [
    "**creates** `docs/<slug>/sdd/progress.md`",
    "**creates** docs/<slug>/sdd/progress.md",
    "creates `docs/<slug>/sdd/progress.md`",
  ]) {
    expect(bold).toMatch(/creates\s*\*{0,2}\s*`?docs\/<slug>\/sdd\/progress\.md`?/i);
    expect(bold).toMatch(/creates\s*\*{0,2}\s*`?docs\/<slug>\/sdd\/?`?/i);
  }
  expect("**creates** `docs/<slug>/sdd/`").toMatch(/creates\s*\*{0,2}\s*`?docs\/<slug>\/sdd\/?`?/i);
});

test("cursor session-start includes the contract reminder", () => {
  const hook = readFileSync(
    path.resolve(import.meta.dir, "../../packages/workit-cursor/hooks/session-start.ts"),
    "utf8",
  );
  expect(hook).toContain("Bounded user choices");
  expect(hook).toContain("never A/B/C or 1/2/3 lists in prose");
});

test("contract includes the doc delivery section", () => {
  const contract = readFileSync(
    path.resolve(
      import.meta.dir,
      "../../packages/workit-core/templates/superpowers-doc-contract.md",
    ),
    "utf8",
  );
  expect(contract).toContain("## Doc delivery");
  expect(contract).toMatch(/\[spec\.md\]\(docs\/<slug>\/spec\.md\)/);
});

test("flow contracts state the host-capability boundary: OpenCode receipts + parentage, Cursor attested:false, no caller evidence/role", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const surfaces = [
    "packages/workit-core/skills/wk-implement/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-implement/SKILL.md",
    "packages/workit-cursor/skills/wk-implement/SKILL.md",
    "packages/workit-cursor/rules/ask-question-only.mdc",
    "packages/workit-core/templates/execution-contract.md",
    "packages/workit-opencode/assets/templates/execution-contract.md",
    "packages/workit-cursor/assets/templates/execution-contract.md",
    "packages/workit-cli/assets/templates/execution-contract.md",
    "packages/workit-core/templates/superpowers-doc-contract.md",
    "packages/workit-opencode/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cursor/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cli/assets/templates/superpowers-doc-contract.md",
  ]
    .map(read)
    .join("\n");
  // OpenCode trust comes from host-observed one-use receipts consumed by the
  // approval/menu tools; no evidence argument exists anywhere (AR-12).
  expect(surfaces).toContain("one-use receipt");
  expect(surfaces).toContain("attested: true");
  expect(surfaces).toContain("no evidence argument");
  expect(surfaces).toContain("NativeChoiceEvidence");
  for (const field of ["attested", "callID", "selectedLabel", "recordedAt"]) {
    expect(surfaces).toContain(field);
  }
  // Delegation comes from host session parentage, never a caller role field.
  expect(surfaces).toContain("parentID");
  expect(surfaces).not.toContain('role: "delegated"');
  expect(surfaces).not.toContain("taskIdentity");
  expect(surfaces).not.toContain("questionId");
  // Cursor reports its policy-only boundary honestly and rejects subagent-driven.
  expect(surfaces).toContain("attested: false");
  expect(surfaces).toMatch(/subagent-driven[^\n]*(unsupported|rejected)/i);
  // Host contract copies stay byte-identical across the four template roots.
  const templates = [
    "packages/workit-core/templates",
    "packages/workit-opencode/assets/templates",
    "packages/workit-cursor/assets/templates",
    "packages/workit-cli/assets/templates",
  ];
  for (const name of ["execution-contract.md", "superpowers-doc-contract.md"]) {
    const contents = templates.map((dir) => read(`${dir}/${name}`));
    for (const copy of contents) expect(copy).toBe(contents[0]);
  }
});

test("templates and skills codify one contiguous non-empty commit range per task with real base..head shas (CA-02)", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const surfaces = [
    "packages/workit-core/templates/plan-template.md",
    "packages/workit-opencode/assets/templates/plan-template.md",
    "packages/workit-cursor/assets/templates/plan-template.md",
    "packages/workit-cli/assets/templates/plan-template.md",
    "packages/workit-core/skills/wk-implement/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-implement/SKILL.md",
    "packages/workit-cursor/skills/wk-implement/SKILL.md",
    "packages/workit-core/vendor/superpowers/skills/subagent-driven-development/SKILL.md",
    "packages/workit-opencode/assets/vendor/superpowers/skills/subagent-driven-development/SKILL.md",
    "packages/workit-cursor/vendor/superpowers/skills/subagent-driven-development/SKILL.md",
  ];
  // Every surface must carry the per-task commit-range rule and record the
  // task's real base..head shas, so a single missing copy fails the test.
  for (const rel of surfaces) {
    expect(read(rel)).toContain("one contiguous non-empty commit range");
    expect(read(rel)).toContain("real base..head");
  }
  // No stale "do not create per-task commits" wording survives on any copy.
  const joined = surfaces.map(read).join("\n");
  expect(joined).not.toContain("do not create per-task commits");
  // The vendor sync script's own RULE must carry both asserted phrases so a
  // re-sync re-applies the full rule verbatim (advisory 8).
  const script = readFileSync(
    path.resolve(
      import.meta.dir,
      "..",
      "..",
      "packages",
      "workit-core",
      "scripts",
      "update-superpowers.sh",
    ),
    "utf8",
  );
  expect(script).toMatch(/RULE=.*one contiguous non-empty commit range/s);
  expect(script).toMatch(/RULE=.*real base\.\.head/s);
});

test("execution contracts mandate plan completion: workflow_plan_complete after a complete ledger and green verification (CA-01/CA-07)", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const surfaces = [
    "packages/workit-core/skills/wk-implement/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-implement/SKILL.md",
    "packages/workit-cursor/skills/wk-implement/SKILL.md",
    "packages/workit-core/skills/wk-handoff/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-handoff/SKILL.md",
    "packages/workit-cursor/skills/wk-handoff/SKILL.md",
    "packages/workit-core/vendor/superpowers/skills/subagent-driven-development/SKILL.md",
    "packages/workit-opencode/assets/vendor/superpowers/skills/subagent-driven-development/SKILL.md",
    "packages/workit-cursor/vendor/superpowers/skills/subagent-driven-development/SKILL.md",
    "packages/workit-core/templates/execution-contract.md",
    "packages/workit-opencode/assets/templates/execution-contract.md",
    "packages/workit-cursor/assets/templates/execution-contract.md",
    "packages/workit-cli/assets/templates/execution-contract.md",
    "packages/workit-core/templates/plan-template.md",
    "packages/workit-opencode/assets/templates/plan-template.md",
    "packages/workit-cursor/assets/templates/plan-template.md",
    "packages/workit-cli/assets/templates/plan-template.md",
  ];
  // Every surface must mandate ending the run with the completion tool and
  // name its precondition — the tool's own gates: a complete SDD ledger and
  // green repository verification. A single missing copy fails the test.
  for (const rel of surfaces) {
    const surface = read(rel);
    expect(surface, rel).toContain("workflow_plan_complete");
    expect(surface, rel).toContain("ledger is complete");
    expect(surface, rel).toContain("verification");
    // CA-01: no run may finish while the plan is `active` — every surface
    // states the clause (wording varies by surface, so match tolerantly).
    expect(surface, rel).toMatch(/never finish|while the plan is (?:still )?`?active`?/i);
  }
  // The CLI host can complete the plan from the CLI-facing surfaces.
  const cliFacing = [
    "packages/workit-cli/assets/templates/execution-contract.md",
    "packages/workit-cli/assets/templates/plan-template.md",
  ]
    .map(read)
    .join("\n");
  expect(cliFacing).toContain("workit flow complete");
});

test("the four template roots are byte-identical with the exact marker, the five-choice source list, and the four-choice destination list", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const roots = [
    "packages/workit-core/templates",
    "packages/workit-opencode/assets/templates",
    "packages/workit-cursor/assets/templates",
    "packages/workit-cli/assets/templates",
  ];
  for (const name of ["execution-contract.md", "superpowers-doc-contract.md"]) {
    const contents = roots.map((dir) => read(`${dir}/${name}`));
    for (const copy of contents) expect(copy, `${name} byte-parity`).toBe(contents[0]);
  }
  const executionContract = read(`${roots[0]}/execution-contract.md`);
  const docContract = read(`${roots[0]}/superpowers-doc-contract.md`);
  // Ordinary source surfaces present all five labels (CA-08).
  for (const label of SOURCE_MENU_LABELS) {
    expect(docContract, `source label ${label}`).toContain(label);
  }
  // A destination carries the exact marker and the four-choice allow-list.
  expect(executionContract).toContain(HANDOFF_DESTINATION_MARKER);
  for (const label of DESTINATION_MENU_LABELS) {
    expect(executionContract, `destination label ${label}`).toContain(label);
  }
  // Destination sections never offer the originating Handoff choice.
  const destinationBlock = destinationBlockOf(executionContract);
  for (const label of DESTINATION_MENU_LABELS) expect(destinationBlock).toContain(label);
  expect(destinationBlock).not.toMatch(/^\s*(?:[-*]|\d+\.)\s*handoff\s*$/im);
  const destinationPara = destinationParaOf(docContract);
  expect(destinationPara).toContain(HANDOFF_DESTINATION_MARKER);
  // The destination paragraph names no menu label Handoff in any case form, and
  // presents no strict choice item named handoff.
  expect(destinationPara).not.toMatch(/Handoff/);
  expect(destinationPara).not.toMatch(/^\s*(?:[-*]|\d+\.)\s*handoff\s*$/im);
});

test("user and maintainer documentation reflects the integrity contracts, without weakening the Cursor pin", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const readme = read("README.md");
  const agents = read("AGENTS.md");
  const cliReadme = read("packages/workit-cli/README.md");
  const ocReadme = read("packages/workit-opencode/README.md");
  const cursorReadme = read("packages/workit-cursor/README.md");
  // Approval integrity: approvals bind to the document's exact SHA-256 digest,
  // and drift forces a fresh reapproval.
  expect(readme).toMatch(/SHA-256|sha256/i);
  expect(readme).toMatch(/re-?approve/i);
  // Menu contracts: an ordinary session sees five choices; a marked destination
  // sees exactly four and never Handoff.
  expect(readme).toContain("Subagent-driven");
  expect(readme).toContain("Review plan first");
  expect(readme).toContain("Handoff");
  // Lifecycle semantics: the only execution states are pending/active/paused/completed.
  expect(readme).toMatch(/pending/);
  expect(readme).toMatch(/paused/);
  // The CLI flow/handoff command surface is documented on the CLI package.
  expect(cliReadme).toContain("workit flow status");
  expect(cliReadme).toContain("workit handoff");
  expect(cliReadme).toMatch(/--confirm/);
  // Host capability table documents lifecycle on every host, and the Cursor
  // runtime runs from @latest with a mandatory --prefer-online flag so the
  // registry is re-resolved on every execution (CA-17).
  expect(agents).toMatch(/pending\/active\/paused\/completed|Lifecycle/i);
  expect(agents).toMatch(/workit-cursor@latest/);
  expect(agents).toMatch(/--prefer-online/);
  expect(agents).not.toMatch(/never (a )?mutable latest|never fall back to a mutable/);
  // Host READMEs map lifecycle surfaces where the host behavior changed.
  expect(ocReadme).toMatch(/workflow_plan_pause|lifecycle|digest/i);
  expect(cursorReadme).toMatch(/workflow_plan_pause|lifecycle|digest/i);
});

test("execution-reliability contract phrases are present across canonical and host asset surfaces (CA-01..CA-20)", () => {
  const read = (rel: string) => readFileSync(path.join(import.meta.dir, "..", "..", rel), "utf8");
  const contractRels = [
    "packages/workit-core/templates/execution-contract.md",
    "packages/workit-opencode/assets/templates/execution-contract.md",
    "packages/workit-cursor/assets/templates/execution-contract.md",
    "packages/workit-cli/assets/templates/execution-contract.md",
  ];
  const handoffRels = [
    "packages/workit-core/skills/wk-handoff/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-handoff/SKILL.md",
  ];
  const implementRels = [
    "packages/workit-core/skills/wk-implement/SKILL.md",
    "packages/workit-opencode/assets/skills/wk-implement/SKILL.md",
  ];
  const docContractRels = [
    "packages/workit-core/templates/superpowers-doc-contract.md",
    "packages/workit-opencode/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cursor/assets/templates/superpowers-doc-contract.md",
    "packages/workit-cli/assets/templates/superpowers-doc-contract.md",
  ];
  const joined = [...contractRels, ...handoffRels, ...implementRels, ...docContractRels].map(read).join("\n");
  // Model deferral is present.
  expect(joined).toContain("Change model first");
  // Direct-child authority.
  expect(joined).toContain("delegation_lineage_denied");
  // Persisted activating coordinator.
  expect(joined).toContain("coordinator_session_id");
  // Coordinator-owned advisories.
  expect(joined).toContain("workflow_sdd_append_advisory");
  // Native recovery phrase.
  expect(joined).toContain("Continue opencode -s <session-id>");
  // Immediate menu recording.
  expect(joined).toMatch(/immediately before any skill|workflow_plan_menu immediately|call `?workflow_plan_menu`? immediately/i);
  for (const rel of contractRels) {
    const text = read(rel);
    expect(text, `${rel} Change model first`).toContain("Change model first");
    expect(text, `${rel} delegation_lineage_denied`).toContain("delegation_lineage_denied");
  }
  for (const rel of handoffRels) {
    const text = read(rel);
    expect(text, `${rel} Workit: <slug>`).toContain("Workit: <slug>");
    expect(text, `${rel} Continue opencode -s <session-id>`).toContain("Continue opencode -s <session-id>");
  }
  for (const rel of implementRels) {
    expect(read(rel), `${rel} compact worker contract`).toContain("compact worker contract");
  }
  for (const rel of docContractRels) {
    const text = read(rel);
    expect(text, `${rel} Change model first`).toContain("Change model first");
    expect(text, `${rel} workflow_plan_menu immediately`).toMatch(/workflow_plan_menu.{0,40}immediately/i);
  }
});

// --- Cross-host parity matrix (CA-08/CA-10/CA-20/CA-21/CA-22/CA-23) ---

type NState = {
  spec: string | null;
  plan: string | null;
  menu: { presented: boolean; chosen: string } | null;
  execution: { status: string; mode: string | null } | null;
  handoff_destination: boolean | null;
  drift: { document: string; code: string }[] | null;
  code: string | null;
  details: unknown;
};

type HostDriver = {
  name: string;
  status(root: string, slug: string): Promise<NState>;
  pause(root: string, slug: string): Promise<NState>;
  resume(root: string, slug: string): Promise<NState>;
  complete(root: string, slug: string): Promise<NState>;
  reenterHandoff(root: string, slug: string): Promise<NState>;
  firstHandoff(root: string, slug: string): Promise<{ prompt: string; state: NState }>;
};

const MATRIX_SPEC = (slug: string) =>
  `# ${slug}\n\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n## Goals\n\n## Non-goals\n\n## Architecture\n\n## Acceptance criteria\n\n- CA-01: test\n`;

const MATRIX_PLAN = (slug: string) =>
  `# ${slug}\n\n**Spec:** \`docs/${slug}/spec.md\`\n**Branch:** \`feature/${slug}\`\n\n## Context\n\n### Task 1: Do the thing\n\n- [ ] **Step 1:** do it\n`;

const planFor = (slug: string) => `docs/${slug}/plan.md`;

const normSuccess = (s: Record<string, any>, dest: boolean | null): NState => ({
  spec: s.spec.status,
  plan: s.plan.status,
  menu: { presented: s.menu.presented, chosen: s.menu.chosen },
  execution: { status: s.execution.status, mode: s.execution.mode },
  handoff_destination: dest,
  drift: s.drift.map((d: { document: string; code: string }) => ({
    document: d.document,
    code: d.code,
  })),
  code: null,
  details: null,
});

const normFailure = (code: string, details?: unknown): NState => ({
  spec: null,
  plan: null,
  menu: null,
  execution: null,
  handoff_destination: null,
  drift: null,
  code,
  details: details ?? null,
});

const destFromFlow = (root: string, slug: string): boolean | null => {
  const file = path.join(root, "docs", slug, "sdd", "flow.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { handoff_destination?: unknown };
    return typeof parsed.handoff_destination === "boolean" ? parsed.handoff_destination : false;
  } catch {
    return null;
  }
};

type SeedOverrides = {
  execution?: { status: string; mode: string | null; evidence?: unknown };
  menu?: { presented: boolean; chosen: string; evidence?: unknown };
  handoff_destination?: boolean;
};

// Equivalent fixture for every host: an approved spec+plan with recorded
// SHA-256 digests and a chosen execution mode. The same bytes seed core,
// OpenCode, Cursor, and the CLI; each host surface then drives the scenario.
const seedFlow = (root: string, slug: string, over: SeedOverrides = {}): void => {
  mkdirSync(path.join(root, "docs", slug, "sdd"), { recursive: true });
  const specPath = path.join(root, "docs", slug, "spec.md");
  const planPath = path.join(root, "docs", slug, "plan.md");
  writeFileSync(specPath, MATRIX_SPEC(slug));
  writeFileSync(planPath, MATRIX_PLAN(slug));
  const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const state = {
    slug,
    activated: true,
    spec: {
      path: `docs/${slug}/spec.md`,
      status: "approved",
      evidence: null,
      approved_digest: digest(specPath),
    },
    plan: {
      path: `docs/${slug}/plan.md`,
      status: "approved",
      evidence: null,
      approved_digest: digest(planPath),
    },
    menu: over.menu ?? { presented: true, chosen: "inline", evidence: null },
    execution: over.execution ?? { status: "active", mode: "inline", evidence: null },
    handoff_destination: over.handoff_destination ?? false,
    updated_at: Date.now(),
  };
  writeFileSync(
    path.join(root, "docs", slug, "sdd", "flow.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
};

// Shared core surface: the canonical transitions and effective read directly.
function coreDriver(): HostDriver {
  const evidence = { host: "cursor", attested: false, confirmation: "contract" } as const;
  const status = async (root: string, slug: string): Promise<NState> => {
    const effective = readEffectiveFlowState(root, slug);
    if (!effective.ok) return normFailure(effective.code, effective.details);
    return normSuccess(
      {
        spec: effective.state.spec,
        plan: effective.state.plan,
        menu: effective.state.menu,
        execution: effective.state.execution,
        drift: effective.drift,
      },
      effective.state.handoff_destination,
    );
  };
  const mutate =
    (action: "pause" | "resume" | "complete") =>
    async (root: string, slug: string): Promise<NState> => {
      const r = transitionExecution(root, slug, planFor(slug), action, evidence, undefined);
      if (!r.ok) return normFailure(r.code, r.details);
      return status(root, slug);
    };
  return {
    name: "core",
    status,
    pause: mutate("pause"),
    resume: mutate("resume"),
    complete: mutate("complete"),
    async reenterHandoff(root, slug) {
      const r = recordMenuChoice(root, slug, planFor(slug), "handoff", evidence, undefined);
      if (!r.ok) return normFailure(r.code, r.details);
      return status(root, slug);
    },
    async firstHandoff(root, slug) {
      const built = buildHandoffPrompt(root, planFor(slug));
      if ("error" in built) throw new Error(built.error);
      const marked = markHandoffDestination(root, slug, planFor(slug));
      if (!marked.ok) throw new Error(marked.error);
      return { prompt: built.prompt, state: await status(root, slug) };
    },
  };
}

// OpenCode adapter: native plugin tools with host-observed question receipts.
function opencodeDriver(): HostDriver {
  const receipts = new HostReceiptStore();
  const tools = createFlowTools(receipts, { session: { get: async () => ({ data: {} }) } });
  const run = async (name: string, args: Record<string, unknown>, root: string) =>
    JSON.parse(
      await (
        tools as unknown as Record<string, { execute: (a: never, c: never) => Promise<string> }>
      )[name as "workflow_flow_status"].execute(
        args as never,
        {
          directory: root,
          worktree: root,
          sessionID: "oc",
        } as never,
      ),
    ) as { ok: boolean; data?: any; error?: string };
  const status = async (root: string, slug: string): Promise<NState> => {
    const out = await run("workflow_flow_status", { plan_path: planFor(slug) }, root);
    if (!out.ok) return normFailure(out.data?.code ?? "flow_status_failed", out.data?.details);
    // OpenCode's workflow_flow_status does not surface `handoff_destination`, so
    // the flag keeps the flow.json fallback here (advisory F9); the Cursor and
    // CLI drivers read it from their host surfaces.
    return normSuccess(out.data, destFromFlow(root, slug));
  };
  const mutate =
    (name: string, label: string) =>
    async (root: string, slug: string): Promise<NState> => {
      receipts.record("oc", `call-${label}`, label);
      const out = await run(name, { plan_path: planFor(slug) }, root);
      if (!out.ok) return normFailure(out.data?.code, out.data?.details);
      return status(root, slug);
    };
  return {
    name: "opencode",
    status,
    pause: mutate("workflow_plan_pause", "Pause plan"),
    resume: mutate("workflow_plan_resume", "Resume plan"),
    complete: mutate("workflow_plan_complete", "Complete plan"),
    async reenterHandoff(root, slug) {
      receipts.record("oc", "call-handoff", "handoff");
      const out = await run(
        "workflow_plan_menu",
        { plan_path: planFor(slug), choice: "handoff" },
        root,
      );
      if (!out.ok) return normFailure(out.data?.code, out.data?.details);
      return status(root, slug);
    },
    async firstHandoff(root, slug) {
      // OpenCode's host handoff surface is workflow_handoff_session (exercised in
      // handoff.test.ts); the matrix drives the shared core mutation for OpenCode
      // as the advisory allows ("or core markHandoffDestination").
      const built = buildHandoffPrompt(root, planFor(slug));
      if ("error" in built) throw new Error(built.error);
      const marked = markHandoffDestination(root, slug, planFor(slug));
      if (!marked.ok) throw new Error(marked.error);
      return { prompt: built.prompt, state: await status(root, slug) };
    },
  };
}

type CursorRequest = (method: string, params: unknown) => Promise<unknown>;

// Cursor adapter: the real MCP server over stdio with the policy-only constant.
function cursorDriver(request: CursorRequest): HostDriver {
  const call = async (name: string, args: Record<string, unknown>) => {
    const msg = (await request("tools/call", { name, arguments: args })) as {
      result?: { isError?: boolean; content?: { type: string; text: string }[] };
    };
    return {
      isError: Boolean(msg.result?.isError),
      text: JSON.parse(msg.result?.content?.[0]?.text ?? "{}") as Record<string, any>,
    };
  };
  const status = async (root: string, slug: string): Promise<NState> => {
    const r = await call("workflow_flow_status", {
      plan_path: planFor(slug),
      workspace_root: root,
    });
    if (r.isError) return normFailure(r.text.code ?? "flow_status_failed", r.text.details);
    // The Cursor MCP workflow_flow_status payload does not surface
    // `handoff_destination`; read the host surface when a future payload adds it
    // and fall back to flow.json today. The MCP surface that DOES report the
    // flag (workflow_handoff_prompt) is asserted directly in firstHandoff.
    const dest =
      typeof r.text.handoff_destination === "boolean"
        ? r.text.handoff_destination
        : destFromFlow(root, slug);
    return normSuccess(r.text, dest);
  };
  const mutate =
    (name: string) =>
    async (root: string, slug: string): Promise<NState> => {
      const r = await call(name, { plan_path: planFor(slug), workspace_root: root });
      if (r.isError) return normFailure(r.text.code, r.text.details);
      return status(root, slug);
    };
  return {
    name: "cursor",
    status,
    pause: mutate("workflow_plan_pause"),
    resume: mutate("workflow_plan_resume"),
    complete: mutate("workflow_plan_complete"),
    async reenterHandoff(root, slug) {
      const r = await call("workflow_plan_menu", {
        plan_path: planFor(slug),
        choice: "handoff",
        workspace_root: root,
      });
      if (r.isError) return normFailure(r.text.code, r.text.details);
      return status(root, slug);
    },
    async firstHandoff(root, slug) {
      // Drive the real MCP handoff surface: workflow_handoff_prompt reports the
      // destination flag and the reset menu in its own payload (CA-07), so the
      // matrix reads the flag from the host surface, not flow.json.
      const r = await call("workflow_handoff_prompt", {
        message: planFor(slug),
        workspace_root: root,
      });
      if (r.isError) throw new Error(r.text.error ?? "handoff prompt failed");
      expect(r.text.handoff_destination).toBe(true);
      expect(r.text.menu).toMatchObject({ presented: false, chosen: "" });
      const prompt = r.text.prompt as string;
      return { prompt, state: await status(root, slug) };
    },
  };
}

// CLI adapter: the exported runner with argv + --confirm, real core verification.
function cliDriver(): HostDriver {
  const previous = process.env.WORKFLOW_WORKSPACE_ROOT;
  const unsetEnv = () => delete process.env.WORKFLOW_WORKSPACE_ROOT;
  const restoreEnv = () => {
    if (previous === undefined) delete process.env.WORKFLOW_WORKSPACE_ROOT;
    else process.env.WORKFLOW_WORKSPACE_ROOT = previous;
  };
  const capture = () => {
    let stdout = "";
    let stderr = "";
    return {
      out: { write: (s: string) => void (stdout += s) },
      err: { write: (s: string) => void (stderr += s) },
      read: () => ({ stdout, stderr }),
    };
  };
  const flow = async (args: string[], root: string) => {
    const c = capture();
    unsetEnv();
    try {
      const code = await runFlowCommand(args, { cwd: root, out: c.out, err: c.err });
      return { code, ...c.read() };
    } finally {
      restoreEnv();
    }
  };
  const flowHandoff = async (root: string, slug: string) => {
    const c = capture();
    unsetEnv();
    try {
      const code = await runHandoffCommand(["--message", planFor(slug)], {
        cwd: root,
        out: c.out,
        err: c.err,
      });
      return { code, ...c.read() };
    } finally {
      restoreEnv();
    }
  };
  const status = async (root: string, slug: string): Promise<NState> => {
    const r = await flow(["status", "--plan", planFor(slug)], root);
    if (r.code !== 0) {
      try {
        const err = JSON.parse(r.stderr) as { code?: string; details?: unknown };
        return normFailure(err.code ?? "flow_error", err.details);
      } catch {
        return normFailure("flow_error");
      }
    }
    const out = JSON.parse(r.stdout) as { handoff_destination?: unknown };
    // CLI `flow status` exposes `handoff_destination` in its own payload
    // (advisory F9): read the host surface, never flow.json. If the CLI ever
    // drops the field, parity fails loudly instead of silently passing.
    return normSuccess(
      out,
      typeof out.handoff_destination === "boolean" ? out.handoff_destination : null,
    );
  };
  const mutate =
    (action: string) =>
    async (root: string, slug: string): Promise<NState> => {
      const r = await flow([action, "--plan", planFor(slug), "--confirm"], root);
      if (r.code !== 0) {
        try {
          const err = JSON.parse(r.stderr) as { code?: string; details?: unknown };
          return normFailure(err.code ?? "flow_error", err.details);
        } catch {
          return normFailure("flow_error");
        }
      }
      return status(root, slug);
    };
  return {
    name: "cli",
    status,
    pause: mutate("pause"),
    resume: mutate("resume"),
    complete: mutate("complete"),
    async reenterHandoff(root, slug) {
      const r = await flowHandoff(root, slug);
      if (r.code !== 0) {
        try {
          const err = JSON.parse(r.stderr) as { code?: string; details?: unknown };
          return normFailure(err.code ?? "handoff_error", err.details);
        } catch {
          return normFailure("handoff_error");
        }
      }
      return status(root, slug);
    },
    async firstHandoff(root, slug) {
      // `workit handoff` builds the destination prompt and marks the flow, then
      // prints the prompt to stdout (CA-07).
      const r = await flowHandoff(root, slug);
      if (r.code !== 0) throw new Error(r.stderr || "handoff failed");
      return { prompt: r.stdout, state: await status(root, slug) };
    },
  };
}

// A compact MCP stdio client bound to one spawned Cursor server process.
function startCursorServer() {
  const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
  const child = spawn("bun", ["packages/workit-cursor/mcp/server.ts"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = new Map<number, (value: unknown) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const id = (msg as { id?: number }).id;
      if (id !== undefined) {
        const resolve = pending.get(id);
        if (resolve) {
          pending.delete(id);
          resolve(msg);
        }
      }
    }
  });
  child.stderr.on("data", () => {});
  const nextId = { id: 0 };
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId.id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      // Clear the timer and drop the pending entry on BOTH settle paths so a
      // timeout cannot leak a stale resolver/timer (advisory F11).
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 20000);
      pending.set(id, (value: unknown) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };
  return { child, request };
}

type Scenario = {
  name: string;
  seed(root: string, slug: string): void;
  run(driver: HostDriver, root: string, slug: string): Promise<NState>;
};

const SCENARIOS: Scenario[] = [
  {
    name: "fresh success",
    seed: (root, slug) => seedFlow(root, slug),
    run: (driver, root, slug) => driver.status(root, slug),
  },
  {
    name: "spec drift",
    seed(root, slug) {
      seedFlow(root, slug);
      writeFileSync(
        path.join(root, "docs", slug, "spec.md"),
        MATRIX_SPEC(slug).replace("test", "changed"),
      );
    },
    run: (driver, root, slug) => driver.status(root, slug),
  },
  {
    name: "plan drift",
    seed(root, slug) {
      seedFlow(root, slug);
      writeFileSync(
        path.join(root, "docs", slug, "plan.md"),
        MATRIX_PLAN(slug).replace("do it", "do it now"),
      );
    },
    run: (driver, root, slug) => driver.status(root, slug),
  },
  {
    name: "pause/resume",
    seed: (root, slug) => seedFlow(root, slug),
    async run(driver, root, slug) {
      const paused = await driver.pause(root, slug);
      expect(paused.code).toBeNull();
      expect(paused.execution).toEqual({ status: "paused", mode: "inline" });
      const resumed = await driver.resume(root, slug);
      expect(resumed.code).toBeNull();
      expect(resumed.execution).toEqual({ status: "active", mode: "inline" });
      return resumed;
    },
  },
  {
    name: "incomplete completion",
    seed: (root, slug) => seedFlow(root, slug),
    run: (driver, root, slug) => driver.complete(root, slug),
  },
  {
    name: "failed verification",
    seed(root, slug) {
      seedFlow(root, slug);
      writeFileSync(path.join(root, "docs", slug, "sdd", "progress.md"), "Task 1: complete\n");
    },
    run: (driver, root, slug) => driver.complete(root, slug),
  },
  {
    name: "successful completion",
    seed(root, slug) {
      seedFlow(root, slug);
      writeFileSync(path.join(root, "docs", slug, "sdd", "progress.md"), "Task 1: complete\n");
      writeFileSync(
        path.join(root, "CHANGELOG.md"),
        "# Changelog\n\n## [Unreleased]\n\n- fixture\n",
      );
    },
    run: (driver, root, slug) => driver.complete(root, slug),
  },
  {
    name: "recursive handoff",
    seed: (root, slug) =>
      seedFlow(root, slug, {
        menu: { presented: true, chosen: "handoff" },
        handoff_destination: true,
      }),
    run: (driver, root, slug) => driver.reenterHandoff(root, slug),
  },
  {
    name: "first handoff mark",
    seed: (root, slug) =>
      seedFlow(root, slug, {
        // Canonical shape (evidence included) so the CAS baseline byte-matches
        // the on-disk flow.json the way the other matrix seeds do.
        menu: { presented: true, chosen: "handoff", evidence: null },
        execution: { status: "pending", mode: null, evidence: null },
      }),
    run: async (driver, root, slug) => {
      const { prompt, state } = await driver.firstHandoff(root, slug);
      // A successful first mark seeds a real destination contract: the exact
      // marker and the four-choice allow-list (CA-07/CA-08).
      expect(prompt).toContain(HANDOFF_DESTINATION_MARKER);
      for (const label of DESTINATION_MENU_LABELS) expect(prompt).toContain(label);
      return state;
    },
  },
];

test("cross-host parity matrix: core/opencode/cursor/cli yield identical normalized outcomes per scenario", async () => {
  const server = startCursorServer();
  // Pin the initialize handshake before any scenario request (advisory F12): the
  // SDK's initialize response confirms the negotiated protocol and tool list.
  const init = (await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "parity-matrix", version: "1.0" },
  })) as {
    result?: {
      protocolVersion?: string;
      capabilities?: { tools?: unknown };
      serverInfo?: { name?: string };
    };
  };
  expect(init.result?.protocolVersion).toBe("2024-11-05");
  expect(init.result?.capabilities?.tools).toBeDefined();
  expect(init.result?.serverInfo?.name).toBe("workit");
  server.child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
  );
  const drivers: Record<string, HostDriver> = {
    core: coreDriver(),
    opencode: opencodeDriver(),
    cursor: cursorDriver(server.request),
    cli: cliDriver(),
  };
  try {
    for (const scenario of SCENARIOS) {
      const outcomes: Record<string, NState> = {};
      for (const [host, driver] of Object.entries(drivers)) {
        const root = mkdtempSync(path.join(os.tmpdir(), "wk-matrix-"));
        const slug = "matrix-flow";
        try {
          scenario.seed(root, slug);
          outcomes[host] = await scenario.run(driver, root, slug);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
      for (const host of ["opencode", "cursor", "cli"] as const) {
        expect(outcomes[host], `${scenario.name} on ${host}`).toEqual(outcomes.core);
      }
      // Scenario invariants: the terminal outcome is meaningful on every host.
      const core = outcomes.core;
      if (scenario.name === "fresh success") {
        expect(core.execution).toEqual({ status: "active", mode: "inline" });
        expect(core.drift).toEqual([]);
        expect(core.code).toBeNull();
      } else if (scenario.name === "spec drift") {
        expect(core.spec).toBe("draft");
        expect(core.plan).toBe("draft");
        expect(core.drift).toEqual([{ document: "spec", code: "digest_mismatch" }]);
      } else if (scenario.name === "plan drift") {
        expect(core.spec).toBe("approved");
        expect(core.plan).toBe("draft");
        expect(core.drift).toEqual([{ document: "plan", code: "digest_mismatch" }]);
      } else if (scenario.name === "incomplete completion") {
        expect(core.code).toBe("execution_incomplete");
        expect(core.details).toEqual({ required: [1], completed: [], missing: [1] });
      } else if (scenario.name === "failed verification") {
        expect(core.code).toBe("verification_failed");
        expect(core.details).toEqual({ exitCode: 1 });
      } else if (scenario.name === "successful completion") {
        expect(core.execution).toEqual({ status: "completed", mode: "inline" });
        expect(core.handoff_destination).toBe(false);
        expect(core.code).toBeNull();
      } else if (scenario.name === "recursive handoff") {
        expect(core.code).toBe("recursive_handoff");
      } else if (scenario.name === "first handoff mark") {
        // The source flow is now a marked destination with the menu reset and
        // execution still pending for the destination session to choose.
        expect(core.handoff_destination).toBe(true);
        expect(core.menu).toEqual({ presented: false, chosen: "" });
        expect(core.execution).toEqual({ status: "pending", mode: null });
        expect(core.code).toBeNull();
      }
    }
  } finally {
    server.child.kill();
  }
});
