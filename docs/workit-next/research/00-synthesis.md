# Workit next — research synthesis

Date: 2026-10-03 · Base: workit 2.1.0 (`eac7bf4`) · Status: input for brainstorm, not a spec.

Sources (this folder): `audit-architecture.md`, `audit-skills.md`, `audit-tests-tooling-docs.md`,
`private/` (session mining + setup audit; local only, gitignored), `inspiration-{pstack,mattpocock,gsd-gentle,superpowers-specs-tools}.md`,
`claude-code-plugin-reference.md`.

## 1. What the evidence says (classified)

### 1.1 Workit is fighting its users

| Signal | Evidence |
|---|---|
| ~1 in 4 workit tool calls error in long OpenCode sessions | ~119 `invalid_input`, ~40 `permission_denied`, ~33 `recovery_required`, ~36 `requirements_unsatisfied` across 10 sessions (sessions-opencode) |
| Agents bypass workit when it gets in the way | 5/10 Cursor sessions abandoned task start and edited anyway (sessions-cursor) |
| User as meat proxy | ~14 manual "continue", 8+ session restarts, pasting ids/configs, retyping "readonly, don't push" in 8+ briefs, "commit the changes" 9+ times |
| Self-reports unreliable | agent "done" claims wrong in 4/4 independently reviewed tasks (Cursor); evidence today is `agent_reported` (architecture §2) |
| Quote | "I hate having to pass for all that process just to start working" |

Root causes (architecture audit, reproduced):
- **Lock bugs**: a dead-process lock is never reclaimed; plain contention is reported as `recovery_required` (83/120 calls in a 3-process test).
- **Unbounded recovery copies**: 5,752 files / 818 MB in this repo alone; `state.recover` can't succeed on any production host.
- **Over-structured agent inputs**: the policy assessment schema is 40 KB, advertised at depth 1; the approval binding is hand-built JSON with a 300-char question budget.
- **Wrong side of the line**: deterministic work (running checks, recording evidence, building approval bindings, git/gh/glab, PR/CI state) is pushed onto the agent, while judgment (finding dispositions, signal `basis`/`refs` cross-validation) is over-constrained by code.
- **Effort mismatch**: 72/74 real tasks ran on OpenCode, while the 6.8k-LOC managed external-action/approval stack serves only Pi and the CLI.

### 1.2 What clearly earns its keep (keep it)

- Independent fresh-context **review** (real findings in 3 OpenCode sessions and 4/4 Cursor tasks).
- **babysit** (requested by name 6×), RED→GREEN proof, handoff/state export.
- Implementer + reviewer subagents on **written briefs** (the Sep 9 v1 build; Codex coordinator with up to 8 workers).
- **Specs and plans for large or uncertain work** (an ambiguous-scope client feature, the v1 build). They were ceremony for mechanical CI or text tasks.
- Deterministic **git/changelog/release helpers** (0.x era), branch/commit conventions (`branch.ts`, `commit-flavors.ts`).
- Brainstorm/challenge with a teaching tone (the user explicitly wants to keep it).

### 1.3 Dead, useless or over-engineered (candidates to delete)

| Item | Verdict | Evidence |
|---|---|---|
| Timezone | Only feeds a hard-coded Spanish YouTrack greeting that mentions one named colleague, plus a work-item date that is off by one east of UTC. `config.json` timezone is written and never read | architecture §3.2 |
| ~2.6k LOC dead core | OpenCode `docs-repo/rules/templates/youtrack` tools, `docs-*`, `verify-*`, `present`, `ports/*`, `sync-runtime.ts`, `triage*`; knip is blind because every file is an entry | architecture §3.1 |
| Recovery dir + `state.recover` | Replace with a bounded/append-only store | architecture §3.4 |
| Writer lease | Never blocks writes on any host; a lease from a dead session has been held since 09-25 | architecture §3.3 |
| Receipt-attested approval chain | Main source of `permission_denied`; host permission prompts already provide the authority | sessions-opencode, architecture §3.6 |
| `cutover`, and setup/doctor/upgrade bundled into core (9.2k LOC) | Move to the CLI; retire cutover | architecture §7.2 #12 |
| OpenCode V1 adapter | Retire once the 2.x floor is fine | architecture #14 |
| `templates/execution-contract.md` | Unused; contradicts the adaptive spec | audit-skills |
| Committed per-host skill copies (70 files), hand-written Cursor `/wk-*` commands | Generate at build time; commands have already drifted | audit-skills |
| Tests: byte-copy checks, skill-list repeats, 42 long-prose `toContain`, the 485-line phase-9 doc-ID mapping, parity tests against deleted shell scripts | ~15-20% of the suite | audit-tests |
| Docs: ~11 of 15 spec/plan folders superseded; `.superpowers/` (old SDD run state), `.workit-evaluation/`, `docs/manifest.json` | Archive or delete | audit-tests §docs |
| Local setup clutter: `~/.workit` (runtime 1.2.1), missing `sync-runtime.sh` in the zsh `opencode()` wrapper, stale `~/.local/share/workflow-toolkit` clone, unregistered Codex plugin copy, Cursor registering workit twice, *.bak files | Clean up with a `workit doctor --fix` pass | setup-audit |

### 1.4 What the inspirations already solved

| Problem in workit | Who solved it, and how | Fit |
|---|---|---|
| Human verifies everything | **pstack**: the verifier is never the author; a repo-generated `verify-<app>` skill runs on the real surface; claims are labeled measured/inferred/guess; the human is asked only for product/preference calls. **GSD**: goal-backward adversarial verifier ("SUMMARY is not evidence") | Core idea of the redesign |
| Self-reported evidence | pstack's SHA-keyed verdict ledger (patch-id carry-over across rebases); GSD's deterministic `gsd-tools` | `workit check -- <cmd>` records host-observed evidence |
| Deterministic vs judgment | GSD: thin orchestrator + deterministic CLI for state, waves and gates. pstack: `orch`, `watch-pr` (JSON `READY/WAITING/ADVANCE/COMPLETE`), `check-plan` | Same split, implemented in workit's TS core + CLI |
| Micromanagement / "continue" nudges | superpowers SDD: never pauses between tasks; ambiguities ledgered as `Ruling: what/why/cost-if-wrong`; only 4 stop conditions. pstack: standing orders re-pasted on every spawn; liveness judged by side effects | Autonomy contract + run ledger |
| Parallel work | pstack: one writer per worktree, fixed brief template (incomplete brief is refused), replace stuck agents ≤2×. GSD: waves with ready/blocked rules. Claude Code: `isolation: worktree` subagents | `fanout` with brief template + file-scope manifest |
| PR slicing | pstack: plain `--base` chains, "five narrow PRs beat one large", land only the contiguous verified run from the root. Matt: tracer-bullet tickets with blocking edges, sized to one context window. Tools: `gh stack` (GitHub-only, preview; needs gh ≥ recent), git-spice (GitHub+GitLab, GPL), Graphite (now Cursor-owned; avoid) | Forge-neutral `workit stack` over plain base chains |
| Durable knowledge only when valuable | Gentle AI: ODD default, "no silent SDD enrollment". OpenSpec: no behavior change → no spec change. Matt: lazy files, glossary, ADR three-part gate, `.out-of-scope/`. superpowers: plans record decisions, not code | Detection flow + opt-in artifacts |
| Brainstorm/grill | Matt: whole frontier per round, numbered, with a recommended answer; the agent researches facts itself. Gentle: verify before agreeing, one question then stop, ≤1 high-stakes assumption challenge, persona scoped to chat. GSD: assumptions mode (codebase-first, confidence tags) | Upgrade `challenge` → `shape` |
| Tautological tests | Matt: "the assertion recomputes the expected value the way the code does". superpowers: "Name the Break", manual mutation check. Tools: StrykerJS (no first-class Bun runner) | `test-audit`: static heuristics + optional diff-scoped mutation |
| Multi-host | GSD: per-host capability descriptor, undocumented → degrade fail-closed. Gentle: adapter interface, golden files per host, idempotent sync. superpowers: one repo, many manifests, single-shape session hook | Shared `core/hooks` + per-host capability descriptor |

## 2. Deterministic vs judgment — target split

**CLI (deterministic: how + proof)**
- `workit task start|status|note|close`: implicit, idempotent per branch/worktree.
- `workit check -- <cmd>`: runs the command and records host-observed evidence keyed to the commit.
- `workit git branch|commit|push`: identity, conventions and base checks built in.
- `workit pr create|status --json|merge`.
- `workit stack plan|sync|land`.
- `workit verify-delivery`: did it really reach the remote/registry?
- `workit test-audit`: static checks plus optional mutation.
- `workit ledger`: decisions, rulings, verdicts.
- `workit handoff`.
- `workit doctor --fix`, `gc`, `setup`, `upgrade`.

**Agent (judgment: what + whether)**
- Shaping and grilling.
- Risk tier.
- Spec/plan/ADR worthiness.
- Slicing.
- Implementation craft.
- Review findings.
- Classifying failures (flake vs real).
- Choosing tests and seams.
- Product questions to the human.

**Rule**: if a step has one right answer, it belongs to the CLI. If a mechanical failure repeats, it gets a deterministic check (Matt's `retro` rule).

## 3. Open decisions (brainstorm frontier)

See the chat round. Answers are recorded below as they are settled.

| # | Decision | Recommended | Settled |
|---|---|---|---|
| 1 | Strategy: rewrite vs strangler | Strangler toward a CLI-first 3.0, sliced PRs on main | ✅ 2026-10-03 |
| 2 | Approval/receipt chain + writer lease | Remove; host permission + autonomy grants | ✅ 2026-10-03 |
| 3 | Task model/store | Implicit per branch; append-only jsonl; no recovery dir | ✅ 2026-10-03 |
| 4 | Default autonomy ceiling | Up to "stack opened, CI green, verified"; merge needs a grant | ✅ 2026-10-03 |
| 5 | Verification | Independent verifier + repo `verify-<app>` skill; host-observed evidence only | ✅ 2026-10-03 |
| 6 | Durable knowledge home and triggers | Detection flow; repo `docs/`; ledger in `.workit/` | ✅ 2026-10-03 |
| 7 | Stacking backend | Built-in thin `workit stack` on plain base chains; `gh stack`/git-spice adapters later | ✅ 2026-10-03 |
| 8 | Host tiers | Tier 1 Claude Code + OpenCode; Tier 2 Codex/Cursor/Pi via shared hooks | ✅ 2026-10-03 |
| 9 | Effect 4 | CLI I/O layer only, once stable | ✅ 2026-10-03 |
| 10 | BDD form | Given/When/Then acceptance criteria → test names; Gherkin only where the repo already uses it | ✅ 2026-10-03 |
| 11 | YouTrack | Keep as an optional tracker adapter; remove the greeting/mention/timezone | ✅ 2026-10-03 |
| 12 | Skill set | 14 → ~10 (shape, implement, review, debug, ship, continue, bdd, test-audit, deslop, fanout) | ✅ 2026-10-03 |
