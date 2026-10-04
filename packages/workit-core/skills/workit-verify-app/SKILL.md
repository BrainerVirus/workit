---
name: workit-verify-app
description: Generate or maintain the project's own verify-<app> skill that launches, drives and observes the real app (CLI, web, API) so agents prove features work. Use for verify the app, run it, smoke test, prove it works, set up verification.
---

# Generate a verify-<app> skill

Tests show branch behavior. A verifier also needs to drive the real thing, the
way a user would. This skill writes a project-local `verify-<app>` skill that
says exactly how, then proves it once.

## Generate

1. **Inspect the surface.** package.json scripts and `bin`, Makefile or
   justfile, Dockerfile and compose files, framework config, existing e2e
   (Playwright, Cypress), the README's run section, `.env.example`. Classify:
   CLI, web UI, HTTP API, library, or several.
2. **Write the skill** from `references/template.md` where this host finds
   project skills (Claude Code `.claude/skills/`, Cursor `.cursor/skills/`,
   Codex, OpenCode and Pi `.agents/skills/`; an existing skills dir wins):
   - **Launch:** one command, its ready signal (log line, port, exit 0), a timeout.
   - **Doctor:** each precondition and its fix (deps, env vars, ports, services).
   - **Drive:** how to exercise it: CLI invocations, `curl` against routes, a
     browser tool for UI, with fixture data.
   - **Evidence:** what to capture (exit code, response body, screenshot path)
     and the command that records it.
   - **Cleanup:** stop processes, remove temp data.
   - **Feature map:** feature, how to drive it, expected observation.
3. **Prove it end-to-end once:** launch, drive one feature, capture evidence,
   clean up. Fix the skill until that run is clean. A generated skill that was
   never run is a guess; do not hand it off.
4. **Make the driver a named check** when it is cheap and deterministic: add
   `"verify": "<driver command>"` to the `checks` in `workit.checks.json`, so
   `workit check verify` records it (it then joins the verification gate).

## Maintain

When scripts, ports, routes or features change, or a verifier reports a wrong
step: re-inspect, edit only that skill's directory, re-run the proof, and
report `clean`, `changed` (what) or `blocked` (why).

## Example

Bad: "Verify by running the tests." (that is not the real surface)

Good: "Launch `bun run dev` (ready: `listening on :5173`, 30 s). Drive:
`curl -s localhost:5173/api/health` returns `{"ok":true}`. Evidence:
`workit check --name verify-web -- bun scripts/smoke.ts` exit 0."

## Check

```sh
workit check verify   # or: workit check --name verify-<app> -- <driver>
```
