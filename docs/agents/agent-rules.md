# Skills, bootstrap and where a rule lives

Read before editing a skill or the bootstrap, or before adding a rule meant to
change agent behavior in installed Workit projects. `AGENTS.md` does not reach
those projects.

| Rule kind | Home |
| --- | --- |
| How agents behave in any installed project | `invariantBootstrap()` in `packages/workit-core/src/core/methods.ts` (injected on every host) |
| Method-specific behavior | the skill under `packages/workit-core/skills/` |
| Skill triggers | `WORKIT_SKILL_TRIGGERS` in `packages/workit-core/src/core/skill-manifests.ts`, the skill description and the bootstrap routing list |
| Failure guidance for one host | that adapter's messages |
| Developing and releasing this repo | `AGENTS.md`, `docs/agents/` and `CODING_STANDARDS.md` |
| Install and usage | README, `docs/guides/`, package READMEs |
| Release history | GitHub release notes and `CHANGELOG.md` |

## Skills

- Skills have one source, `packages/workit-core/skills/`. Each package's
  `scripts/build.ts` generates the host copies, which are git-ignored, except
  Cursor's `skills/` and `commands/`: Cursor installs from git, so those are
  committed. `test/workit-core/generated-copies.test.ts` fails when they drift
  and names the command that regenerates them.
- Refer to another skill as its name alone in parentheses, `(workit-bdd)`.
  The builds rewrite that form into each host's load wording
  (`renderSkillText` in `packages/workit-core/src/core/skill-manifests.ts`;
  on Claude Code, "call the Skill tool with `workit:bdd`"). A name in plain
  prose is not rewritten.
- `test/workit-core/skill-set.test.ts` keeps descriptions, trigger words and
  the routing list in step.

## Role agents

- The role agents (implementer, verifier, reviewer, decider, babysitter)
  have one source, `packages/workit-claude-code/agents/*.md`; its
  `model:`/`effort:` frontmatter is each role's default, mirrored in
  `CLAUDE_AGENT_FILES` (`packages/workit-core/src/core/role-models.ts`).
- The Codex and Cursor builds render committed copies
  (`packages/workit-codex/agents/workit-<role>.toml`;
  `packages/workit-cursor/agents/workit-<role>.md`), and OpenCode imports the
  bodies (`packages/workit-opencode/src/v2/agents.ts`).
  `test/workit-codex/agents.test.ts` and
  `test/workit-cursor/role-agents.test.ts` fail when a copy drifts;
  regenerate with `bun packages/workit-codex/scripts/build.ts` and
  `bun packages/workit-cursor/scripts/build.ts --skills-only`.
