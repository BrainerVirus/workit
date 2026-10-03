# Inspiration scan: Superpowers, spec frameworks, and 2026 tooling

Date: 2026-10-03. Local shallow clones: `/tmp/claude-1000/-home-cristhofer-pincetti/fb894a62-61b7-4f32-a4d0-f47c2e5e300f/scratchpad/refs/{superpowers,spec-kit,OpenSpec,BMAD-METHOD}`.
Clone heads: superpowers v6.4.2 (8ca22db, 2026-09-25); spec-kit 1.1.1.dev0 (ae5ade7, 2026-10-03); OpenSpec 1.14.0 (2500d6d, 2026-10-02); BMAD-METHOD unreleased main (3cae711, 2026-10-03; its `package.json` is absent, it uses `pyproject.toml`/`bmod.toml`).
Confidence: file-level claims below were read from the clones. Tool-landscape claims (section 5) come from web search/fetch snippets and are marked where unverified.

## 0. Existing workit context

- `docs/workit-v1/spec.md:944-956` and `docs/adaptive-workit/spec.md:270-274` already cite Superpowers brainstorming (pinned b36e082), Spec Kit agentic-sdd, OpenSpec overview, and BMAD review triage. The sources are pinned at older SHAs; Superpowers has moved a lot since (see 1.7).
- `docs/workit-v1/plan.md:1472-1493` deletes `packages/workit-core/vendor/superpowers/`, `update-superpowers.sh`, and `templates/superpowers-doc-contract.md`. The reliability-overhaul spec still handles legacy `docs/superpowers/` migration (`workit-reliability-overhaul/spec.md:11,46,330`).
- `.superpowers/` in the repo root is NOT a config dir. It is the runtime workspace of Superpowers' subagent-driven-development (SDD) skill, written while workit-v1 was implemented:
  - `.superpowers/sdd/.gitignore` containing `*` (self-ignoring, so nothing shows in `git status`).
  - `.superpowers/sdd/plan/` (1.6 MB, 37 files): `progress.md` (the ledger: branch, merge base, design commits, open review fixes, rulings, full-check results), `task-N-brief.md` (extracted task text handed to an implementer), `task-N-report.md` (implementer reports), `review-<sha>..<sha>.diff` (review packages).
  - Directory name `plan` = basename of `docs/workit-v1/plan.md`; the ledger's first line records the owning plan path (`sdd-workspace` marker scheme).
  - Takeaway: this is disposable run state, not durable knowledge. Workit-next should keep an equivalent run ledger out of git by default and promote only outcomes worth keeping.

## 1. obra/superpowers (v6.4.2)

### 1.1 Inventory (15 skills under `skills/`)
brainstorming, writing-plans, executing-plans, subagent-driven-development, test-driven-development, verification-before-completion, requesting-code-review, receiving-code-review, systematic-debugging, using-git-worktrees, dispatching-parallel-agents, finishing-a-development-branch, using-superpowers (meta/bootstrap), writing-skills (authoring + pressure-testing skills with subagents), diagnosing-superpowers (new in 6.4.1: post-mortem of a bad session). No slash commands dir in this version; skills are auto-invoked through the `Skill` tool. No agents/ dir: reviewers are `general-purpose` subagents filled from prompt templates (`requesting-code-review/code-reviewer.md`, `subagent-driven-development/{implementer,task-reviewer,re-review}-prompt.md`).
Release notes: `RELEASE-NOTES.md`. Recent direction (6.4.x): leaner plans, native/inline execution as a first-class mode, no mid-run check-ins, "Review Focus" in plans.

### 1.2 Brainstorming (`skills/brainstorming/SKILL.md`, 285 lines)
- Step 0: classify and announce out loud: Spike (feasibility; output is an answer; no files), Bounded (change to existing flow; short design in chat; STOP for yes; no spec file, no plan doc), Architectural (new project/subsystem/interface change; full path).
- Ratchet is one-way: when in doubt take the heavier path; hidden complexity mid-task upgrades the path, never downgrades.
- HARD-GATE: no implementation action until the path's approvals exist. Approval applies only to the stage actually presented (idea approval is not spec approval; spec approval only unlocks writing-plans).
- "Establish shared understanding": write back intent/constraints/success criteria, separating said vs assumed, invite correction.
- Architectural path: explore context, optional visual companion (browser; offered just-in-time), one question per message, 2-3 approaches with recommendation, sectioned design with approval per section, write `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and commit, inline spec self-review (placeholders, contradictions, ambiguity, scope), user reviews the file, then ONLY writing-plans.
- Relevance: this is the closest prior art to workit's adaptive "scale ceremony to risk" idea (already cited). Its weakness for workit: classification is the model's self-declared label, enforced by prose, not by a deterministic resolver.

### 1.3 Writing-plans (`skills/writing-plans/SKILL.md`, 204 lines; 6.4.2 "leaner plans")
- Saved to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`. Required header: Goal, Architecture, Tech Stack, Spec path, Global Constraints (verbatim spec values), Review Focus (up to 5 spec-implied failure modes no task tests, each pinned to a test in the owning task).
- Task right-sizing: "smallest unit that carries its own test cycle and is worth a fresh reviewer's gate". Steps are single checkable actions (failing test, run it red, minimal impl, run green, commit); checkbox syntax for resumability.
- 6.4.2: a plan records decisions (signatures, assertions, spec values), not full code; self-review compares plan length to spec length (a plan several times longer than the spec is a transcript).
- Execution handoff: user reviews the saved plan, chooses Subagent-driven vs Native (inline); skill recommends one with a reason.
- Observed in this repo: `docs/workit-v1/plan.md` is 1,500+ lines, i.e. the old transcript style the 6.4.2 release now argues against.

### 1.4 Subagent-driven-development (568 lines) and executing-plans (373 lines)
- SDD: controller reads plan once, per task dispatches a fresh implementer (clean context, no session history), then a task reviewer (spec compliance + quality) with a generated review package (`scripts/review-package`, `scripts/task-brief`, `scripts/sdd-workspace`). Fix loop capped at 5 rounds (rounds 1-3 resume implementer, 4-5 fresh implementer on a more capable model); scoped re-review prompt; final broad whole-branch review; workspace deleted when final review is clean.
- "Continuous execution": never pause between tasks. "Rulings, not stalls": decide ambiguities, ledger `Ruling: <what> - <why> - <cost if wrong>`. Only four stop conditions: irreversible/destructive op, security-sensitive action, side effect outside the worktree (merge, push to shared branch, publish), plan so broken every path is a guess.
- Model selection per role (controller expensive; Claude Code reference suggests dispatching one mid-tier orchestrator subagent for the whole plan using nested subagents, `skills/using-superpowers/references/claude-code-tools.md`).
- executing-plans (inline "Native" mode, rebuilt in 6.4.1): same ledger (`scripts/task-start`, `task-done`), TDD as per-task gate, one fresh-context review at the end.
- Worth stealing: plan-scoped run workspace outside tracked files, ledger as memory, rulings log surfaced to the human at the end, bounded fix rounds with model escalation.

### 1.5 TDD, verification, review, worktrees, debugging
- TDD (`test-driven-development/SKILL.md`, 330 lines): iron law (no production code without a failing test), explicit "watch it fail" and "watch it pass" verify steps, rationalization table, red-flags list.
- `test-driven-development/writing-good-tests.md` is directly relevant to the tautological-test problem: Principle 1 "Name the Break" (what production change should make this fail, and is it a bug or a decision?), Principle 2 "Exercise the Real Thing" (limit mocks), derive expectations independently (literals, not values computed by the code under test), "Tests ship with the implementation... only those needed", and a manual "Mutation Check" (mentally mutate wrong constant/branch/missing side effect/empty return/missing validation; at least one test must fail for each). It is advisory prose only; nothing runs a mutation tool.
- verification-before-completion (120 lines): "no completion claims without fresh verification evidence"; gate function identify/run/read/verify/claim; table of claim vs required evidence ("Agent completed" needs the VCS diff, not the agent's report).
- requesting-code-review: base/head SHAs, subagent filled from `code-reviewer.md`, severity handling (Critical now, Important before proceeding, Minor noted). receiving-code-review (205 lines): push back with reasoning, no performative agreement.
- using-git-worktrees: detect existing isolation first (`git-dir != git-common-dir`, submodule guard), prefer harness-native worktree tools, fall back to manual `git worktree`. dispatching-parallel-agents: one agent per independent problem domain, only when no shared state.
- Enforcement style across all skills: prose gates, red-flag/rationalization tables, graphviz flows. No code-level enforcement, no hooks beyond bootstrap; discipline relies on model compliance (evals under `tests/`).

### 1.6 Claude Code packaging (what workit's adapter must reproduce)
- `.claude-plugin/plugin.json`: name, description, version, author, homepage, repository, license, keywords. No explicit `skills`/`hooks` keys; Claude Code auto-discovers `skills/` and `hooks/hooks.json` at plugin root.
- `.claude-plugin/marketplace.json`: marketplace `superpowers-dev` listing one plugin with `source: "./"` (repo is its own marketplace). Install = add marketplace, then install plugin.
- `hooks/hooks.json`: single `SessionStart` hook, matcher `startup|clear|compact`, command `"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start`, `shell: bash`, `async: false`. `run-hook.cmd` is a polyglot wrapper (cmd/bash) for Windows.
- `hooks/session-start`: reads `skills/using-superpowers/SKILL.md`, JSON-escapes it with bash parameter substitution, and emits it wrapped in `<EXTREMELY_IMPORTANT>You have superpowers...` as `hookSpecificOutput.additionalContext` (Claude Code), `additional_context` (Cursor, when `CURSOR_PLUGIN_ROOT` set), or top-level `additionalContext` (Copilot CLI/others). Comment in the script: Claude Code reads BOTH shapes without deduplication, so emit only the one for the current platform. Uses printf not heredoc (bash 5.3 hang, issue #571).
- Bootstrap skill `using-superpowers`: "1% chance a skill applies, you MUST invoke it"; has `<SUBAGENT-STOP>` so dispatched subagents ignore it; `references/claude-code-tools.md` maps vocabulary per harness.
- Multi-harness manifests at repo root: `.cursor-plugin/`, `.codex-plugin/`, `.devin-plugin/`, `.hermes-plugin/`, `.kimi-plugin/`, `.muse-plugin/`, `.opencode/plugins/superpowers.js`, `.pi/extensions/superpowers.ts`, `gemini-extension.json`, `GEMINI.md`, plus `scripts/bump-version.sh` driven by `.version-bump.json` (version kept in sync across manifests) and `scripts/sync-to-codex-plugin.sh`. `AGENTS.md` is the contributor guide (CLAUDE.md removed in 6.4.2 because Claude Code reads AGENTS.md only when no CLAUDE.md exists).
- Implication for workit Claude Code adapter: (a) skills dir + hooks.json + plugin.json is enough; (b) SessionStart injection is the only always-on mechanism, so keep the injected text small (Superpowers injects a 65-line skill); (c) emit exactly one hook-output shape per platform; (d) ship a marketplace.json so the repo installs itself; (e) version-sync script across manifests; (f) a subagent-skip guard for bootstrap content.

### 1.7 Delta vs the workit-v1 pinned reference
Workit pinned Superpowers at b36e082; current head adds: spike/bounded/architectural classification (the pinned brainstorming link in `adaptive-workit/spec.md:270` already cites scaled paths), plan-scoped SDD workspace + ledger + rulings, inline native execution, Review Focus, diagnosing-superpowers, lean plans. Re-pin before relying on any of these.

## 2. Spec frameworks

### 2.1 github/spec-kit (Python `specify` CLI, 1.1.1.dev0)
- Pipeline: `/speckit.constitution -> specify -> clarify -> plan -> checklist -> tasks -> analyze -> implement -> converge` (+ `taskstoissues`). Only `specify` strictly required before `plan` (`docs/reference/agentic-sdd.md`).
- Artifacts per feature under `specs/<###-feature>/`: `spec.md` (prioritized user stories with Given/When/Then and "Independent Test"; `templates/spec-template.md`), `plan.md`, `tasks.md`, checklists, optional `roadmap.md` for epics (`docs/concepts/spec-of-specs.md`). `constitution.md` holds project principles evaluated at each phase.
- Specs are created at the start of every feature and by default stay as a per-feature folder (a growing archive, not a merged truth). `docs/concepts/spec-persistence.md` discusses lifecycle.
- Extensibility is large: `extensions/`, `presets/` (incl. `lean` preset: "just the prompt, just the artifact"), `workflows/`, `bundles/` (assess, bugfix), `integrations/` for many agents, community catalogs.
- Overhead: highest of the four. Many phases, each producing a large template-driven document. Value is greatest for greenfield/ambiguous features; the project itself ships a `lean` preset and an `assess` step (evaluate idea before specifying), an admission that the full flow is heavy.
- Ideas to borrow: constitution as the single always-loaded rule set; clarify-before-plan capped at 5 questions; `analyze` cross-artifact consistency check as an optional gate; `converge` (compare implementation to artifacts, append remaining work); independently testable prioritized slices.

### 2.2 Fission-AI/OpenSpec (TypeScript, pnpm, 1.14.0)
- Model (`docs/overview.md`, `docs/concepts.md`, `docs/writing-specs.md`): `openspec/specs/<domain>/spec.md` = current truth (requirements with SHALL + scenarios); `openspec/changes/<change>/` = proposal.md, design.md, tasks.md, `specs/**` delta specs. Delta headings: `## ADDED / MODIFIED / REMOVED Requirements` (+ RENAMED). `archive` merges deltas into main specs and moves the change to `changes/archive/<date>-name`.
- Default schema `schemas/spec-driven/schema.yaml`: artifacts proposal -> specs -> design -> tasks with `requires` dependencies; "enablers, not gates" (any artifact editable at any time). Schemas are customizable (`schema init/fork/validate`).
- Notable rule in the proposal instruction: a change must declare at least one capability or set `skip_specs: true` in `.openspec.yaml`; "specs describe behavior, so if behavior does not change, no spec should change"; do not invent a requirement to satisfy validation. Closest existing match to "durable knowledge only when it adds value".
- CLI (`docs/cli.md`): `init, update, list, show, validate, status, instructions, templates, schemas, new change, archive, config, doctor, context, store*, workset*`; agent-facing ones accept `--json`. Slash flow `/opsx:explore -> propose -> apply -> archive`. Stores/worksets (beta) for multi-repo specs.
- Known weakness, documented by the project itself (`openspec-parallel-merge-plan.md`): MODIFIED blocks replace whole requirements, so two parallel changes touching one requirement silently drop the first one's scenarios at archive; no base fingerprint, no conflict UX. Remediation (detection/guardrails, base hash) is planned, not necessarily shipped. Directly relevant to parallel agents in worktrees.
- Overhead: moderate; proposal + delta + tasks per change; the doc admits it is not worth it for one-line fixes.
- Ideas to borrow: delta-not-whole-doc; archive step as the explicit, rare "promotion to durable knowledge" event; `skip_specs`; JSON-first CLI for agents; validate command; if adopting deltas, add a base hash from day one.

### 2.3 bmad-code-org/BMAD-METHOD (v6 line; skills-based)
- Now ~30 skills under `skills/` (`bmad-build`, `bmad-build-auto`, `bmad-code-review`, `bmad-prd`, `bmad-architecture`, `bmad-spec`, `bmad-ticket`, `bmad-correct-course`, `bmad-retrospective`, agent personas analyst/pm/architect/dev/ux, `bmad-party-mode`, `bmad-customize`, etc.); TOML customization (`bmod.toml`, `customize.toml`, `_bmad/custom/config.toml`); `bmad setup/status/migrate` CLI; breaking changes noted in `CHANGELOG.md` (ticket tree, initiatives, web bundles removed).
- Direction: "use the smallest amount of BMad that safely fits the change" (`docs/build/build-a-change.md`): one session-sized unit (~500 LOC excluding tests, a handful of files) goes straight to `bmad-build` (clarify, plan file with `status:`, implement, review, fix). Larger work goes through planning skills (PRD, architecture, UX, ticket tree, `docs/plan/choose-a-planning-path.md`). Trivial edits skip process.
- Review model (`docs/build/review-a-change.md`): parallel reviewer "layers/lenses" on one diff, then triage per finding: verify claimed consequence, assign severity, dismiss with recorded reason, route to patch / defer / decision-needed; quick vs thorough depth; plan is the intent, no-plan mode degrades gracefully; stop when findings are low-value exotic corner cases; non-trivial findings on a third pass signal an upstream design problem. `bmad-build-auto` is the unattended worker for one unit under an external orchestrator.
- Overhead: highest persona/ceremony surface, but the new build path is notably lean. Persistent artifacts are the plan file with status and ticket tree, kept per initiative.
- Ideas to borrow: findings triage with mandatory recorded dismissal reasons; plan file with status + `baseline_revision` as the review anchor; "stop reviewing" heuristic; size-the-work gate.

### 2.4 Which ideas fit "durable knowledge only when it adds value"
1. Default artifact is ephemeral run state (Superpowers `.superpowers/sdd/<plan>/`, self-gitignored), promoted only on an explicit decision.
2. OpenSpec `skip_specs` + "no behavior change, no spec change", and archive-as-promotion; deltas instead of rewriting documents.
3. Superpowers' bounded path (design in chat, no files) as the default for small work; BMAD's size-the-work gate (~500 LOC) as a numeric trigger for planning.
4. Spec Kit's constitution as the one durable always-on file; everything else per-feature and disposable.
5. Avoid: Spec Kit's mandatory per-feature spec/plan/tasks folders accumulating in `specs/` (archive without a merge step), and OpenSpec whole-requirement replacement without a base check.

## 3. Comparison table

| | Superpowers 6.4.2 | Spec Kit 1.1.1 | OpenSpec 1.14 | BMAD (main) |
|---|---|---|---|---|
| Form | Skills + SessionStart hook | Python CLI + slash commands/skills for ~many agents | Node CLI + slash commands/skills | Skills + CLI + TOML config |
| Spec persistence | `docs/superpowers/{specs,plans}` for architectural only; SDD ledger ephemeral | `specs/<n>/` per feature, kept | `specs/` truth + `changes/` deltas, archived | plan file + ticket tree per initiative |
| Process scaling | spike/bounded/architectural, one-way ratchet | lean preset, optional gates | enablers-not-gates, `skip_specs` | size gate; quick/thorough review |
| Enforcement | prose gates only | templates, optional analyze | `validate` CLI | skill logic, `tickets.py` |
| Review | per-task spec+quality reviewer, final review | `analyze`, `converge` | human reads proposal/deltas | multi-lens parallel + triage |
| Parallel work | worktree skill, parallel dispatch skill | branch-per-feature | change folders (merge hazard) | external orchestrator (bmad-loop) |

## 4. Gaps these frameworks leave (relevant to workit)
No deterministic policy engine (all rely on prompt compliance); none verify test quality beyond prose; none manage stacked PRs; none handle GitLab+GitHub forge differences; parallel-agent merge safety is weak (OpenSpec archive hazard, Superpowers just says "no shared state").

## 5. Tools

### 5.1 Stacked PRs
Sources: web search results (2026-10); statuses not independently verified beyond README fetches noted.

| Tool | Forge | Notes | Fit for Bun/TS, GitHub+GitLab |
|---|---|---|---|
| `github/gh-stack` (gh extension, https://github.com/github/gh-stack) | GitHub only | Public preview since 2026-07-30 per InfoQ/community discussion #201439. ~20 commands (`init add checkout rebase modify sync push submit link merge view unstack up/down/top/bottom`), metadata in `<git-common-dir>/gh-stack` JSON (not committed), worktree-aware, recovery journals, `view --json`, `gh skill install` agent skill, native stack UI + base-branch-protection on final target. Needs gh 2.x, git 2.36+. MIT. | Best GitHub path; agent-friendly. No GitLab. Preview status, API may change. |
| `abhinav/git-spice` (`gs`, https://github.com/abhinav/git-spice) | GitHub, GitLab, Bitbucket, Gitea/Forgejo | Mature (1.2k commits, ~770 stars at fetch time), offline until push, `gs branch create`, `gs stack submit`, `gs repo sync`, `gs stack restack`. GPL-3.0 (fine as an external CLI, not as a bundled dependency). Go binary. Agent-friendliness not documented (verified: README does not mention it). | Best single tool spanning both forges. |
| `glab stack` (https://docs.gitlab.com/cli/stack/) | GitLab | Marked EXPERIMENTAL ("might be unstable or removed"); 14 subcommands (`create save amend sync next/prev/first/last move reorder infer delete list switch`). | GitLab-only fallback; low maturity. |
| Graphite `gt` | GitHub (GitLab claimed in one search snippet, unverified) | Acquired by Cursor Dec 2025 (search result, Wikipedia/Contrary snippets); `gt mcp` since CLI 1.6.7 so agents can create stacks; commercial service dependency. | Vendor lock/uncertain direction after acquisition; avoid as a core dependency. |
| Sapling (`sl pr submit`) | GitHub | Meta; one PR per commit; requires adopting sl on top of git repos. | Heavy workflow change. Unverified for GitLab. |
| `ejoffe/spr` | GitHub | One PR per commit; not researched beyond search mentions. | GitHub only. |

Design hint for workit: define a forge-neutral "stack provider" interface (create branch on top of parent, restack, submit/update PR/MR chain, view as JSON) with adapters: `gh stack` for GitHub, `git-spice` or workit's own thin git+`gh`/`glab` implementation for GitLab. Workit already owns GitHub/GitLab/YouTrack plumbing (see workit-v1 plan), so a minimal own implementation (branch-per-task, base=parent branch, retarget on merge) may be cheaper than depending on a GPL tool; `gh-stack`'s on-disk metadata layout (`<git-common-dir>/gh-stack`, worktree-aware) is a good model.

### 5.2 Parallel agent orchestration in worktrees
- Claude Code native: subagent frontmatter `isolation: worktree` gives each invocation a fresh temporary worktree, auto-cleaned if no changes (docs: https://code.claude.com/docs/en/sub-agents); Agent Teams (research preview since v2.1.32, Feb 2026): lead + shared task list with dependency tracking and file locking + teammates in tmux panes (secondary blog sources). Superpowers `using-git-worktrees` explicitly prefers harness-native worktrees.
- `max-sixty/worktrunk` (`wt switch/list/remove`, https://github.com/max-sixty/worktrunk): Rust, hooks, copy-on-write build caches, `wt list --full` with CI status; described as the most popular worktree manager (search snippet). Useful as an optional helper, not a dependency.
- Orchestrators surveyed by search (not hands-on verified): Conductor (Melty Labs), Vibe Kanban (kanban UI, branch+worktree per task), Claude Squad, Cursor background agents, Gastown, bmad-loop (external to BMAD). Lists: https://github.com/andyrewlee/awesome-agent-orchestrators, https://www.augmentcode.com/tools/open-source-agent-orchestrators.
- Common failure modes to design against: shared untracked state (node_modules, build caches, ports), merge-order conflicts (cf. OpenSpec archive hazard), unreviewed fan-in. Superpowers' answer is only a precondition ("no shared state"); a workit file-ownership/scope manifest per task plus stacked branches with explicit parent order would be a stronger answer.
- Observed local hazard in this repo's ledger: a self-referential symlink in `node_modules` broke tests (`progress.md`), a worktree-hygiene issue worth a preflight check.

### 5.3 Tautological / low-value test detection
- StrykerJS (https://stryker-mutator.io): the standard JS/TS mutation tool (current core 10.x; community Bun runners peer-depend on 9.x, per search snippets: `@hughescr/stryker-bun-runner` 1.3.8, 18 releases Jan-Jul 2026, and `stryker-mutator-bun-runner`; no official Bun runner). Could not fetch npm pages (HTTP 403), so Bun-runner details are unverified. Alternative: run Stryker with the `command` runner invoking `bun test` (slower, no per-test coverage analysis).
- Tautest (npm `tautest`, `@tautest/core`): wraps Stryker; mutates only changed lines from `git diff`, lists surviving mutants, emits AI-ready fix prompts, optional GitHub PR comment/Action. Vitest full, Jest beta; no Bun test runner support stated. Small, young project (v1.x).
- Diff-scoped mutation is the key ergonomic: full-repo mutation is too slow for an agent loop; mutate only lines changed on the branch. Stryker supports `--mutate` globs and incremental mode; Tautest shows the git-diff approach.
- LLM-based: Meta ACH (arXiv 2501.12862; 73% of generated tests accepted by engineers), Mutahunter (LLM mutant injection, open source), 2026 papers showing LLM mutants beat rule-based at real-bug detection but with more non-compilable/duplicate/equivalent mutants (arXiv 2609.35841 snippet). Useful as an optional "mutation-by-reviewer" step; equivalent-mutant noise needs triage like BMAD's dismiss-with-reason.
- Cheap static heuristics not requiring a mutation run (to be implemented in workit, not found as a ready tool): flag tests with no assertions, assertions whose expected value is computed by the code under test, mock-only assertions, snapshot of the mock; Superpowers' "Name the Break" + "Mutation Check" are the prompt-level equivalents.
- Other languages if needed: mutmut/Cosmic Ray (Python), cargo-mutants (Rust), PIT (Java).
- Fit for a Bun/TS repo: Stryker (command or community Bun runner) restricted to the branch diff, run as a post-implementation verification step in the "high-risk/behavior-change" policy tier only; pair with the independent-expectation rule from `writing-good-tests.md`.

## 6. Recommendations for workit-next (opinionated)
1. Keep Superpowers' behavioral contracts (classify-and-announce, hard gates per stage, fresh-context review, evidence-before-claims, rulings log, four stop conditions) but enforce them in workit-core code where possible, since Superpowers enforces only through prose.
2. Run state: per-plan, git-ignored workspace with ledger and rulings (mirror `.superpowers/sdd/<plan>/`), plus a plan-path ownership marker; durable artifacts only via an explicit promote step (OpenSpec-archive-like), with `skip` as the default for no-behavior-change work.
3. Plans: adopt the 6.4.2 "decisions not transcript" rule and proportion check; add Review Focus. Retire 1,500-line transcript plans.
4. Claude Code adapter: plugin.json + marketplace.json + `skills/` + `hooks/hooks.json` SessionStart (matcher `startup|clear|compact`) emitting a minimal bootstrap via `hookSpecificOutput.additionalContext`; one output shape only; subagent-skip guard; version-sync script across adapters.
5. Stacks: forge-neutral stack interface; adapters `gh stack` (GitHub), `git-spice` or built-in git+`glab` (GitLab); `--json` view for agents.
6. Parallelism: prefer harness-native worktree isolation; add per-task file-scope declaration and a restack/merge-order step; preflight for shared-state hazards.
7. Test quality: diff-scoped Stryker (Bun via command/community runner) as an opt-in verification gate for behavior changes, plus static tautology heuristics; treat surviving mutants with BMAD-style triage (fix / dismiss with reason / defer).
8. Review: BMAD-style multi-lens review with recorded dispositions; stop rule (third-pass non-trivial findings mean upstream design problem).

## 7. Source index
- Local: `refs/superpowers/{skills,hooks,.claude-plugin,RELEASE-NOTES.md}`, `refs/spec-kit/{docs/reference/agentic-sdd.md,docs/concepts,templates,presets/lean}`, `refs/OpenSpec/{docs/overview.md,docs/concepts.md,docs/writing-specs.md,docs/cli.md,schemas/spec-driven/schema.yaml,openspec-parallel-merge-plan.md}`, `refs/BMAD-METHOD/{docs/build,docs/plan,skills,CHANGELOG.md}`.
- Web: https://github.com/github/gh-stack ; https://www.infoq.com/news/2026/04/github-stacked-prs/ ; https://github.com/orgs/community/discussions/201439 ; https://github.com/abhinav/git-spice ; https://docs.gitlab.com/cli/stack/ ; https://graphite.com/docs/gt-mcp ; https://github.com/max-sixty/worktrunk ; https://code.claude.com/docs/en/sub-agents ; https://dev.to/canblmz/i-built-tautest-a-mutation-testing-workflow-for-ai-written-tests-43l7 ; https://arxiv.org/pdf/2501.12862 ; https://www.augmentcode.com/tools/open-source-agent-orchestrators
