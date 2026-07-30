# Workflow Toolkit Reliability Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight reproduced workflow-toolkit defects with regression tests and no new dependencies.

**Architecture:** Keep the existing skill → MCP → script flow. Fix each defect at its shared root: line-preserving changelog editing, direct native Cursor questions, correct stdin transport, explicit partial-success state, required release ranges, and one synchronized version.

**Tech Stack:** Node.js ESM with `node:test`, Python 3 standard library, POSIX shell, Zod, existing MCP SDK.

**Spec:** `docs/superpowers/specs/2026-07-14-workflow-toolkit-reliability-repairs-design.md`
**Branch:** `bugfix/workflow-toolkit-reliability`

## Global Constraints

- Add no dependencies and no new test framework.
- Preserve existing Markdown byte-for-byte outside the changed Unreleased category regions.
- Reject changelog targets outside the resolved workspace root.
- Use Cursor's built-in `AskQuestion` directly; plain text is only a fallback when the built-in is unavailable.
- Never retry a YouTrack comment after it was posted successfully.
- Require an explicit release tag or range.
- Keep `.cursor-plugin/plugin.json` and the MCP server version identical.
- Do not use git worktrees; this plugin directory is not a Git checkout, so commit steps are omitted.

---

### Task 1: Establish the Regression Harness and Changelog Safety

**Files:**
- Create: `mcp/test/regressions.test.js`
- Modify: `mcp/package.json`
- Modify: `mcp/lib/changelog-apply.js`
- Modify: `scripts/changelog/apply-unreleased.py`

**Interfaces:**
- Consumes: `changelogApply({ entries, path, normalize_only, workspace_root })`.
- Produces: `npm test`; structured `{ error }` validation; a line-preserving Unreleased editor.

- [ ] **Step 1: Add the failing changelog regressions**

Use `node:test`, `node:assert/strict`, `mkdtempSync`, and `spawnSync`. Assert that:

```js
assert.deepEqual(changelogApply({ workspace_root: root }), {
  error: "entries required unless normalize_only",
});
assert.match(changelogApply({
  entries: { Fixed: ["outside"] },
  path: "../outside.md",
  workspace_root: root,
}).error, /inside workspace_root/);
```

Run `apply-unreleased.py` against a fixture containing an HTML comment, custom `### Notes` heading, nested bullet, continuation line, duplicate `### Added`, and a released version. Assert those raw lines survive, one Unreleased `### Added` remains, duplicate top-level bullets occur once, and the new bullet occurs once.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd mcp && node --test --test-name-pattern='changelog' test/regressions.test.js`

Expected: FAIL because missing entries throws, path escape is accepted, and rich Markdown is discarded.

- [ ] **Step 3: Add the test command and minimal JavaScript validation**

Add `"scripts": { "test": "node --test test/*.test.js" }` to `mcp/package.json`.

Make `normalizeEntries(undefined)` return `{ data: {} }`. Resolve the requested target with `path.resolve(cwd, rel)` and reject it unless `target === cwd || target.startsWith(cwd + path.sep)`. Pass the safe relative path to Python.

- [ ] **Step 4: Replace bucket re-rendering with line-preserving editing**

In `apply-unreleased.py`, keep `split_unreleased`, `normalize_bullet`, and `format_bullet`. Replace `parse_body`/`render_unreleased` with a single pass over `body.splitlines(keepends=True)` that records recognized heading spans. Merge duplicate recognized spans by moving their complete raw bodies after the first heading, deduplicate only lines matching a top-level `^- |^\\* ` bullet, and insert fresh bullets at the start of the canonical span. Treat custom headings and every non-top-level-bullet line as opaque content.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `cd mcp && node --test --test-name-pattern='changelog' test/regressions.test.js`

Expected: PASS.

### Task 2: Restore Handoff Task Rows

**Files:**
- Modify: `mcp/test/regressions.test.js`
- Modify: `scripts/collect-handoff-context.sh`

**Interfaces:**
- Consumes: newline task rows from `scripts/lib/parse-plan-tasks.sh` on stdin.
- Produces: a rendered execution contract whose `## Task order` contains every parsed task title.

- [ ] **Step 1: Add a failing handoff regression**

Create a temporary Git repository with an explicit spec and a two-task plan, invoke `collect-handoff-context.sh "<spec> <plan>"`, and assert:

```js
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout, /- Task 1: First repair/);
assert.match(result.stdout, /- Task 2: Second repair/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd mcp && node --test --test-name-pattern='handoff' test/regressions.test.js`

Expected: FAIL because the heredoc replaces the piped task-list stdin.

- [ ] **Step 3: Use one stdin channel for task data**

Change the contract renderer to `printf '%s' "$TASK_LIST" | python3 -c '<renderer source>' "$TEMPLATE" ...`. Keep the renderer body and substitutions unchanged; only move Python source from heredoc to `-c`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd mcp && node --test --test-name-pattern='handoff' test/regressions.test.js`

Expected: PASS with both task rows present.

### Task 3: Remove the Fake Question Tool and Make Prompts Specific

**Files:**
- Modify: `mcp/test/regressions.test.js`
- Modify: `mcp/server.js`
- Modify: `mcp/lib/present.js`
- Delete: `scripts/present/prepare-question.sh`
- Modify: `rules/ask-question-only.mdc`
- Modify: `templates/superpowers-doc-contract.md`
- Modify: `README.md`
- Modify: `skills/wf-pr/SKILL.md`
- Modify: `skills/wf-issue-update/SKILL.md`
- Modify: `skills/wf-meetings/SKILL.md`
- Modify: every other `skills/*/SKILL.md` reference found by the regression scan
- Modify: `scripts/smoke-test.sh`

**Interfaces:**
- Consumes: Cursor's native `AskQuestion` tool.
- Produces: direct native calls with workflow-owned titles, prompts, and options.

- [ ] **Step 1: Add failing source-contract tests**

Recursively scan `mcp`, `skills`, `rules`, `templates`, `README.md`, and `scripts/smoke-test.sh` while excluding `mcp/test`. Assert no file contains `workflow_prepare_question` or `prepare-question.sh`. Also assert `wf-pr` contains both `AskQuestion` and `MR/PR`, while `wf-issue-update` contains both `AskQuestion` and `YouTrack`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd mcp && node --test --test-name-pattern='question' test/regressions.test.js`

Expected: FAIL with the existing MCP registration, wrapper, script, and documentation references.

- [ ] **Step 3: Delete the redundant implementation**

Remove `prepareQuestion` from the `present.js` import and module, remove the `workflow_prepare_question` registration from `server.js`, and delete `scripts/present/prepare-question.sh`.

- [ ] **Step 4: Rewrite question instructions to native calls**

Replace adapter instructions with direct `AskQuestion` payload instructions. The PR prompt must ask whether to create the reviewed MR/PR; the YouTrack prompt must ask whether to post the reviewed update and log its time. Meeting, branch, stash, provider, plan-execution, and generic choices keep their current option meanings. State one concise plain-text fallback only when native `AskQuestion` is unavailable.

- [ ] **Step 5: Remove obsolete smoke assertions and verify GREEN**

Delete executable/script checks for `prepare-question.sh`; retain assertions that injected rules and relevant skills mention native `AskQuestion`.

Run: `cd mcp && node --test --test-name-pattern='question' test/regressions.test.js`

Expected: PASS.

### Task 4: Report YouTrack Partial Success Safely

**Files:**
- Modify: `mcp/test/regressions.test.js`
- Modify: `mcp/lib/youtrack.js`
- Modify: `mcp/server.js`
- Modify: `skills/wf-issue-update/SKILL.md`

**Interfaces:**
- Consumes: `postUpdate(input, operations?)`, where `operations.postComment` and `operations.logTime` are optional test seams defaulting to current production functions.
- Produces: `{ ok: false, partial: true, postedComment: true, loggedMinutes: 0, error, retry: "workflow_youtrack_log_time" }` after comment success/time failure.

- [ ] **Step 1: Add a failing orchestration regression**

Inject operations whose comment succeeds and time call returns `{ error: "time failed" }`. Assert each operation is called once and the exact partial result is returned.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd mcp && node --test --test-name-pattern='YouTrack partial' test/regressions.test.js`

Expected: FAIL because `postUpdate` has no seam and returns only `{ error }`.

- [ ] **Step 3: Add the minimal dependency seam and partial result**

Use a second argument default:

```js
export function postUpdate(input, operations = {}) {
  const postComment = operations.postComment ?? ((issueId, markdown, root) =>
    runScriptJson("youtrack/api.sh", ["post-comment", issueId, markdown], root));
  const logTimeOperation = operations.logTime ?? logTime;
  // existing validation and ordering
}
```

On time error after comment success, return the structured partial result from the spec. In `server.js`, preserve the whole result instead of reducing it to `{ error }` whenever `data.partial` is true.

- [ ] **Step 4: Document time-only retry and verify GREEN**

Update `wf-issue-update`: on `partial: true`, report that the comment posted and call only `workflow_youtrack_log_time` if the user requests retry; never call `workflow_youtrack_post` again.

Run: `cd mcp && node --test --test-name-pattern='YouTrack partial' test/regressions.test.js`

Expected: PASS.

### Task 5: Require Release Ranges and Synchronize Versions

**Files:**
- Modify: `mcp/test/regressions.test.js`
- Modify: `scripts/release-notes-context.sh`
- Modify: `mcp/server.js`
- Modify: `skills/wf-release-notes/SKILL.md`
- Modify: `.cursor-plugin/plugin.json`

**Interfaces:**
- Consumes: required `range_or_tag: string`.
- Produces: structured `requested` and resolved `range`; plugin/MCP version `0.3.13`.

- [ ] **Step 1: Add failing release/version regressions**

Assert the release script exits nonzero without an argument. In a temporary Git repository, invoke it with `HEAD` and assert Repository output contains `requested: HEAD` and `range:`. Parse the manifest version and the MCP server constructor version and assert equality and `0.3.13`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd mcp && node --test --test-name-pattern='release|version' test/regressions.test.js`

Expected: FAIL because the script defaults silently and versions are `0.3.12`/`0.3.8`.

- [ ] **Step 3: Require and expose range metadata**

In the script, fail with `ERROR: release tag or range required` when `$1` is empty. In the MCP schema use `range_or_tag: z.string().min(1)`; always pass it to the script. Parse the Repository section and include `requested` and `range` in structured output. Keep the skill instruction to ask for an exact tag/version/range before calling.

- [ ] **Step 4: Set both runtime versions to `0.3.13` and verify GREEN**

Update the manifest and `new McpServer` version.

Run: `cd mcp && node --test --test-name-pattern='release|version' test/regressions.test.js`

Expected: PASS.

### Task 6: Full Verification

**Files:**
- Modify: `scripts/smoke-test.sh` only if full-suite behavior exposes an obsolete assertion.

**Interfaces:**
- Consumes: all repaired components.
- Produces: evidence that regressions and existing workflows remain healthy.

- [ ] **Step 1: Run the complete regression suite**

Run: `cd mcp && npm test`

Expected: all tests PASS.

- [ ] **Step 2: Run the existing smoke suite**

Run: `bash scripts/smoke-test.sh`

Expected: `smoke-test OK`.

- [ ] **Step 3: Run language and shell validation**

Run:

```bash
node --check mcp/server.js
node --check mcp/lib/changelog-apply.js
node --check mcp/lib/youtrack.js
python3 -m py_compile scripts/changelog/apply-unreleased.py
shellcheck scripts/collect-handoff-context.sh scripts/release-notes-context.sh scripts/smoke-test.sh
```

Expected: syntax checks exit 0 and ShellCheck reports no errors. Pre-existing informational warnings may be listed in the handoff.

- [ ] **Step 4: Re-index the knowledge graph and inspect the final diff**

Run the codebase-memory index for `workflow-toolkit`, then inspect every changed file and confirm no obsolete question adapter references remain outside historical design/plan documents.
