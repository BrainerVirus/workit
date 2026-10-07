# verify-<app> skill template

Copy into `<skills-dir>/verify-<app>/SKILL.md` and fill every section from what
you observed in the repo. Delete a section only when it cannot apply (a
library has no Launch) and say so in one line.

```md
---
name: verify-<app>
description: Launch, drive and observe <app> on its real surface (<cli|web|api>) to prove a feature works. Use to verify a change or reproduce a bug on the running <app>.
---

# Verify <app>

## Launch
`<command>` - ready when `<log line | port open | exit 0>`, timeout <n> s.

## Doctor
| Precondition | Check | Fix |
| --- | --- | --- |
| deps installed | `<cmd>` | `<cmd>` |
| <ENV_VAR> set | `test -n "$<ENV_VAR>"` | copy from `.env.example` |
| port <n> free | `<cmd>` | `<cmd>` |

## Drive
- CLI: `<binary> <args>` against `<fixture>`
- API: `curl -sS -X <METHOD> localhost:<port>/<route> -d '<body>'`
- UI: open `<url>`, <steps>, using the host's browser tool

## Evidence
`workit check --name verify-<app> -- <driver command>` records exit code and log.
Screenshots go to `<tmp dir>/verify-<app>/<feature>.png`; cite the path.

## Cleanup
`<command>` (stop servers, remove `<tmp dir>`).

## Feature map
| Feature | Drive | Expect |
| --- | --- | --- |
| <feature> | `<command or steps>` | `<observable result>` |
```

## Rules for the generated skill

- Every command is copy-pasteable and was run once while generating.
- Ready signals and expectations are literal (a string, a status code, a
  count), never "works" or "looks right".
- Keep it under ~80 lines; move long fixtures into the skill's own directory.
