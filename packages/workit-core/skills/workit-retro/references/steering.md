# Editing steering text (AGENTS.md, CODING_STANDARDS.md, skills)

Steering text is paid for on every session that reads it. Each line must
change what an agent does; everything else is cost.

## Write

- **Point, do not copy.** Link the file or name the command; never paste its
  content. A pointer says when to follow it: "Read before editing a hook:
  `docs/agents/hosts.md`".
- **Say what done looks like.** "Run `bun run check`; it must exit 0" beats
  "make sure everything works".
- **Concrete over adjectives.** A command, a path, a number. Prefer the action
  to take over a list of things to avoid.
- **One rule, one home.** A rule with an enforcer (type, lint, check, test)
  appears in steering text at most as a pointer to that enforcer. The same
  sentence in AGENTS.md and CODING_STANDARDS.md is a defect
  (`duplicate-rule`).
- **Judgment goes to CODING_STANDARDS.md**, which the reviewer reads; only
  navigation goes to AGENTS.md.

## Cut

- **No-ops.** Delete lines that would not change any behavior if removed:
  "be thorough", "write clean code", "keep it concise", "follow best
  practices".
- **Session residue.** No notes about one session, no implementation detail
  the code already shows, no `path:line` references (they go stale).
- **Dead rules.** A rule whose mistake can no longer happen (a type or check
  now prevents it) is deleted, not kept "for context".

## Budget

- AGENTS.md stays within 8 KB (`workit knowledge lint`, rule
  `agents-budget`). A proposal that adds text names what it removes, or shows
  the byte count still holds.
- A need-based file (`CODING_STANDARDS.md`, `GLOSSARY.md`) is created in the
  same edit as its first real entry. Headers-only or "TBD" files fail the lint
  (`scaffold-file`).
