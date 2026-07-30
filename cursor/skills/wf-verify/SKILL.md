---
name: wf-verify
description: Run project validation via workflow_verify MCP tool. Use for /wf-verify or when user says "use verify skill".
disable-model-invocation: true
---

# Verify — Project Validation

Run the repository's validation checks and report exact results.

## Step 1 — Gather facts (required)

Call MCP tool `workflow_verify` with arguments from the user's message (range, version, paths, etc.).

**Workspace root:** defaults to the Cursor workspace. Pass `workspace_root` when the user names a different repository path.

Use the tool return value as ground truth. Do not read git, run npm, or infer repo state yourself.
If the tool errors, report the error and stop.

Map `--dry-run` or `dry-run` in the user message to `dry_run: true`.

## Rules

- Do not edit files.
- Do not fix failures.
- Do not claim success unless every executed command exits 0.
- If a command is skipped, report the skip reason.
- If a command fails, report the failed command and the relevant output.
- If validation commands are detected but not run because arguments requested a dry run, clearly say that.

## Output

Return only:

```md
Validation summary:

- Passed: <count>
- Failed: <count>
- Skipped: <count>

Commands:

- `<command>`: pass|fail|skipped - <short reason>

Next action:
<one concise recommendation>
```
