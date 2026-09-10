# Spec: validation fix program

**Task:** `485f48a6` · **Branch:** `feature/workit-v1` · **Mode:** report-only validation is over; this program implements fixes.

**Goal:** resolve the validation finding set so v1 launches without known
doc/code drift, untested CLI surfaces, hook bypasses, or unreachable
ownership paths.

## User decisions (recorded in task progress; the decision recorder mints no

receipts in this environment, see finding `b611654d`)

1. Invocation shape: **docs yield to the parser** — the surface is
   `workit <family> <action>`.
2. Codex writer: **build session binding** — the CLI stamps a session-bound
   caller the hook can match; tests use bound callers, never forged ones.
3. `init_apply`: **wire both hosts** — register the surface the
   branch-policy spec claims instead of deleting the claims.
4. Matchers: **harden toward fail-closed** on both hooks.

## Slice A — docs corrections (no behavior change)

- Invocation shape `workit <family> <action>` in: `index.tsx` HELP +
  `COMMAND_DESCRIPTIONS`, `packages/workit-cli/README.md:23`,
  `AGENTS.md:11` lifecycle cell, `AGENTS.md:69` contract line.
  Update `packed-cli.test.ts:440` which pins the old help string.
- `CHANGELOG.md`: delegation entry drops the `coordinator_session_id`
  term; OpenCode pin `1.18.29` → `1.18.30`.
- Accept: grep finds no `workit task <family>` outside released history;
  full suite green.

## Slice B — CLI robustness

- `runCutoverCommand` CLI tests (new `test/workit-cli/cutover-command.test.ts`):
  preview/apply/rollback shapes, `--hosts/--resolution/--json/--confirm`,
  usage exit-2 paths.
- Fail loud, exit nonzero usage: unknown `--hosts` values, malformed
  `--resolution`, missing `--task` value (currently coerced into the next
  flag). `--hosts=` empty keeps the all-hosts default (documented).
- `cutover apply --json` honors `--json`; rollback parses flags in any
  position (backup id stays positional-first, flags anywhere).
- `runActionCommand`: document the TTY requirement for `--confirm`
  (headless stays `needs_input`; no posture change), add `@file`/`-` payload
  parity with the task surface.
- Consent coverage: successful `task` mutation with `--confirm` +
  `--revision`/`--workspace-revision` (pins the happy path).
- Wizard: direct Pi-detection + `preselectedPlatforms` exclusion tests.
- Uninstall picker gains codex/pi (core already plans all four).
- Accept: new tests fail before / pass after (RED shown once per area);
  full suite green.

## Slice C — hook hardening (fail-closed)

- Cursor: widen `hooks-cursor.json` preToolUse matcher to ⊇ the
  12-name `isWriteTool` guard; pin matcher ⊇ guard with a test.
- Doctor + installer cover **all** hook events, not just sessionStart
  (matcher drift becomes a `stale_install`-class finding).
- Shell containment (both hooks): extend verb coverage
  (`tee`, `sed -i`, `ln`/`unlink`, `rmdir`, `dd`, `truncate`, `git clean` /
  `restore` with a dry-run carve-out); the `install` token covers every
  package manager uniformly with a small table for non-install verbs
  (`dotnet add`, `composer require`, `poetry/cargo add`, `go get`,
  `npm ci`); `checkout`/`add` stay out as routine workflow; resolve symlinks
  before containment (realpath on the operand when it
  exists); case-insensitive compare on win32; unparseable non-`command`
  shapes deny instead of allow.
- Codex matcher precision: quote-aware verb scan (quoted mentions never
  deny); package-manager installs (`npm/pip/bun install <pkg>`) never demand
  ownership of package names; split `&&`/`||`/`;` chains before extraction.
- Codex `callerAttested`: stop hardcoding `true` on unsigned stdin input;
  core `writer()`/`assertProductWriteAllowed` treat unattested Codex input as
  unattested (no consumer may trust the flag today).
- Surface fallback: unknown override value logs a warning and resolves CLI
  (no silent misclassification).
- Accept: bypass repros from the reviews deny after the fix; suites green.

## Slice D — architecture

- Codex session binding: CLI accepts `--actor <session-id>` (which stamps
  the owner session handle the hook matches; provenance receipts carry the
  same actor), the hook honors human-bound workit_cli ownership; `cli.test.ts`/`desktop.test.ts`
  forged callers replaced with bound ones; hook guidance + MCP refusal print
  the exact `node_modules/.bin/workit --json --confirm` invocation.
- `init_apply`: register **only** the `workit_init_apply` tool (not the
  whole repo factory) on OpenCode (`plugin.ts`) with the `branch_policy`
  action; Cursor stays wizard-only (unattested MCP refuses all mutations, so
  a listed tool could never execute); tests pin the OpenCode surface;
  AGENTS.md row flips OpenCode to live.
- Pi `reconcile`: wire the existing `reconcileWorker` into the
  `workit_worker_control` handler instead of unconditional failure; schema
  text updated.
- Accept: Codex allow-branch reachable in a live-shaped test; both hosts
  expose `init_apply`; Pi reconcile round-trips; full suite green.

## Verification

Per slice: targeted suites (run twice for flake signal), `bun run lint`,
`tsc --noEmit`, regen-sensitive tests (`deterministic.test.ts`), one bounded
reviewer + lead reconcile, then resolve the corresponding validation
findings `fixed` with the check evidence. Full `bun test` before the final
close. No push without approval.
