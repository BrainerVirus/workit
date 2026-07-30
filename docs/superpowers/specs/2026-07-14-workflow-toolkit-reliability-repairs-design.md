# Workflow Toolkit Reliability Repairs Design

**Date:** 2026-07-14
**Scope:** Repair the eight confirmed workflow-toolkit defects without adding dependencies or redesigning unrelated workflows.
**Branch:** `bugfix/workflow-toolkit-reliability`

## Goals

- Make Cursor questions use the native `AskQuestion` tool directly and show workflow-specific copy.
- Preserve all existing changelog content while merging Keep a Changelog entries.
- Include parsed tasks in generated handoff prompts.
- Prevent duplicate YouTrack comments after partial failures.
- Return structured validation errors instead of crashing.
- Keep changelog writes inside the selected workspace.
- Require an explicit release tag or range.
- Keep manifest and MCP server versions synchronized.

## Architecture

Keep the current Skill → MCP → script architecture. Remove only the redundant question-payload MCP layer because an MCP response cannot itself invoke Cursor's native question UI. Skills and always-on rules will call Cursor `AskQuestion` directly with their question payloads.

Use standard-library tests only: Node's `node:test` for JavaScript and cross-component regressions, with temporary repositories and subprocesses for shell/Python behavior. Do not add a test framework or production abstraction unless a side-effect boundary needs a minimal injection seam.

## Native Questions

Delete the `workflow_prepare_question` MCP registration, its JavaScript wrapper, and `prepare-question.sh`. Update every rule, template, README section, skill, and smoke assertion to call Cursor `AskQuestion` directly.

Each skill owns the exact prompt it needs. PR confirmation must mention MR/PR creation; YouTrack confirmation must mention posting to YouTrack. If the built-in tool is unavailable in a Cursor mode, the skill may ask one concise plain-text question rather than attempting an MCP tool with the same name.

## Changelog Editing

The changelog editor must treat existing Markdown as opaque text except for:

- locating `## [Unreleased]`;
- locating recognized Keep a Changelog `###` categories;
- inserting new top-level bullets into the matching category;
- consolidating duplicate recognized category headings while moving each duplicate category's complete raw body intact.

It must preserve comments, custom headings, nested bullets, continuation lines, blank-line structure, and version history. Duplicate detection applies only to normalized top-level bullet text. `normalize_only` performs only duplicate recognized-heading consolidation.

The MCP layer must return `entries required unless normalize_only` when both inputs are absent. The target path is resolved against `workspace_root` and rejected unless the resolved file is inside that root.

## Handoff Generation

Pass the parsed task list to Python through stdin while supplying Python source with `-c`, eliminating the heredoc/stdin collision. A regression test must assert that the generated `## Task order` contains the same number and titles reported by the plan parser.

## YouTrack Partial Failure

Keep comment-first ordering. If comment posting succeeds and time logging fails, return structured partial state:

```json
{
  "ok": false,
  "partial": true,
  "postedComment": true,
  "loggedMinutes": 0,
  "error": "...",
  "retry": "workflow_youtrack_log_time"
}
```

The skill must retry only `workflow_youtrack_log_time`, never the combined post operation. Add a minimal dependency injection parameter to the orchestration function so the sequence and partial result can be tested without network calls.

## Release Notes and Versions

Make `range_or_tag` required in the MCP schema and instruct the skill to ask before calling the tool when absent. Return the requested value and resolved range in structured output.

Bump the plugin patch version once and use the same value in the manifest and MCP server. A regression test compares both values.

## Test Strategy

Each defect gets a regression test that is observed failing before its implementation changes:

1. Changelog preserves rich Markdown and rejects workspace escape.
2. Changelog missing arguments returns a structured error.
3. Handoff includes task rows.
4. No production instruction or server registration references `workflow_prepare_question`; workflow prompts remain specific.
5. YouTrack time failure reports partial success and a safe retry.
6. Release notes reject a missing range and expose range metadata.
7. Manifest and MCP versions match.
8. Existing smoke behavior remains green after obsolete assertions are updated.

Final verification runs the regression suite, smoke test, Node syntax checks, Python compilation, and ShellCheck. ShellCheck must have no errors; pre-existing informational warnings unrelated to these repairs may be reported separately.

## Non-Goals

- No plugin framework rewrite.
- No MCP App UI.
- No new dependencies.
- No changes to PR branch policy, SDD storage, VCS providers, or YouTrack prose style.
