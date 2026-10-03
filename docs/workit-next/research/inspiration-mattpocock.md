# Inspiration: Matt Pocock's agent skills

Source: https://github.com/mattpocock/skills, shallow clone at commit d81f3a18 (main, 2026-09-29), local copy in the session scratchpad `refs/skills`. All paths below are relative to that repo. Not fetched from the web beyond the repo: the repo's own README/docs are the primary source. Web posts were not separately searched; the "tautological" definition exists only in `skills/engineering/tdd/` (SKILL.md and tests.md).

Note: `~/.agents/skills/improve-codebase-architecture` is an OLDER copy of his skill (diff: it says `CONTEXT.md` where current main says `GLOSSARY.md`; otherwise identical). He renamed `CONTEXT.md` to `GLOSSARY.md` (changeset `rename-context-to-glossary`). Also, `to-prd`/`write-a-prd`/`prd-to-issues`/`prd-to-plan` no longer exist: they became `to-spec` and `to-tickets`. `grill-me` is now a one-line shim over `grilling`.

Already borrowed by workit (docs/workit-v1/spec.md "Behavioral TDD" ~L364 and table ~L947-949; docs/adaptive-workit/spec.md ~L267-268): grilling (agent researches facts, user decides), TDD seams + vertical slices + tautology objection, code-review intent+standards, selective ADRs, glossary vs ADR separation. What follows highlights what is NOT yet borrowed.

## 1. Inventory

Philosophy (README): "small, easy to adapt, composable"; explicitly against process-owning frameworks (GSD, BMAD, Spec-Kit). Four failure modes each map to skills: misalignment -> grilling; verbosity -> shared language (GLOSSARY.md); broken code -> feedback loops (tdd, diagnosing-bugs); ball of mud -> deep modules (codebase-design, improve-codebase-architecture). Split on one axis: user-invoked (`disable-model-invocation: true`, orchestrators) vs model-invoked (reference discipline, have a trigger description).

Engineering, user-invoked:
- `ask-matt`: router over skills; describes main flow idea->ship, on-ramps, "phase boundaries" (continue / clear / handoff / subagent / compact; ordered tree in PHASE-BOUNDARIES.md), context hygiene ("smart zone" ~150k tokens). Output: none.
- `grill-with-docs`: = `grilling` + `domain-modeling`. Output: GLOSSARY.md, ADRs, inline, lazily created.
- `setup-matt-pocock-skills`: one-time per-repo, prompt-driven (explicitly "not a deterministic script"). Asks issue tracker (GitHub/GitLab/local `.scratch/`/other), triage labels, domain layout. Writes `docs/agents/{issue-tracker,triage-labels,domain}.md` plus an `## Agent skills` block in the existing CLAUDE.md or AGENTS.md (never creates the second one).
- `to-spec`: NO interview; synthesises conversation into a spec and publishes to tracker with `ready-for-agent`. Also proposes test seams ("the ideal number is one") and confirms them. Sections: Problem, Solution, long User Stories, Implementation Decisions (no file paths/snippets), Testing Decisions, Out of Scope, Further Notes.
- `to-tickets`: spec/plan -> tracer-bullet tickets with blocking edges; quiz user on granularity/edges; publish (local `.scratch/<feature>/issues/NN-slug.md` or native tracker blocking links). Never modifies parent.
- `implement`: tiny (6 lines): /tdd at pre-agreed seams, typecheck often, single test files often, full suite once at end, /code-review, commit.
- `implement-spec`: whole spec on one integration branch; tickets = task graph; implementer subagents per ticket in own worktree on the ready "frontier", merger subagent, final code-review subagent, cleanup. Communication via "context pointers" not copied text.
- `triage`: state machine of roles (category: bug/enhancement; state: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). Verify claim (reproduce) BEFORE grilling; redundancy check; reads `.out-of-scope/`. Writes agent brief (AGENT-BRIEF.md), triage notes, `.out-of-scope/<concept>.md` for rejected enhancements. Comments start with an AI disclaimer. Only for issues you did not create.
- `wayfinder`: huge foggy efforts; shared map issue (`wayfinder:map`) with Destination/Notes/Decisions so far/Not yet specified (fog)/Out of scope; child "decision tickets" typed research/prototype/grilling/task; claim by assignment; one ticket per session; plans decisions, not deliverables; hands off to to-spec.
- `improve-codebase-architecture`: scope by git hot spots (YAGNI), sub-agent explores, writes a self-contained HTML report to the OS temp dir (nothing in repo), candidates with before/after, strength badge; then grilling on chosen one; offers ADR only for load-bearing rejections.
- `retro`: post-session suggestions for the agent ENVIRONMENT (navigation, automated checks, coding standards, AGENTS.md pruning, tool economy, no-ops, info access). Mechanical failures -> deterministic checks, judgement -> CODING_STANDARDS.md.

Engineering, model-invoked: `tdd` (+tests.md, mocking.md), `diagnosing-bugs` (+scripts/hitl-loop.template.sh), `domain-modeling` (+GLOSSARY-FORMAT.md, ADR-FORMAT.md), `codebase-design` (+DEEPENING.md, DESIGN-IT-TWICE.md), `code-review`, `prototype` (+LOGIC.md, UI.md), `research` (background agent, cited markdown from primary sources), `pr` (PR body template: Summary visual, Evidence before/after, Merge Danger one-way/two-way door + blast radius; credits Dex Horthy), `wizard` (generates interactive bash script from template.sh for human-only steps).

Productivity: user-invoked `grill-me`, `handoff` (compact conversation to a tmp-dir doc, references artifacts by path instead of duplicating, lists suggested skills, redacts secrets), `teach` (multi-session stateful workspace with MISSION/GLOSSARY/RESOURCES/LEARNING-RECORD files), `to-questionnaire` (interview user about the SEND, produce questionnaire for someone else), `wait-what` (re-pitch last message in ASD-STE100 Simplified Technical English using GLOSSARY.md). Model-invoked: `grilling`, `writing-for-agents`.
`misc/` (not promoted): setup-pre-commit, git-guardrails-claude-code (hook script blocks push/reset --hard/clean/branch -D), scaffold-exercises, migrate-to-shoehorn. `in-progress/`: loop-me, claude-handoff, writing-*, setup-ts-deep-modules (dependency-cruiser config to force deep modules).

Durable artifacts and when: GLOSSARY.md/GLOSSARY-MAP.md (inline, when a term resolves, lazily created); `docs/adr/NNNN-slug.md` (only when hard-to-reverse + surprising + real trade-off); spec + tickets on tracker (to-spec/to-tickets); `docs/agents/*.md` (setup); `.out-of-scope/*.md` (triage rejections); wayfinder map; `prototype/<name>` branch kept as primary source; research markdown file; CHANGELOG via changesets (repo-internal).

## 2. Tests

Source: `skills/engineering/tdd/SKILL.md`, `tests.md`, `mocking.md`; `diagnosing-bugs` Phase 5; `codebase-design/DEEPENING.md`.

Tautological, exact text: "the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec." tests.md: "Expected value restates the implementation, so the test passes by construction." Fix shown: replace `items.reduce(...)` expectation with literal `15`.
Detection is purely prompt guidance (anti-pattern list); no script or mutation tooling. Workit's own caveat (exact values valid when they are an external protocol contract) is a sensible refinement he does not state.

Other anti-patterns: "Implementation-coupled: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed." "Horizontal slicing: writing all tests first, then all implementation... Work in vertical slices instead: one test -> one implementation -> repeat, each test a tracer bullet that responds to what the last cycle taught you."

Good test: "Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification." Characteristics (tests.md): behavior callers care about, public API only, survives refactors, WHAT not HOW, one logical assertion per test. Red flags: mocking internal collaborators, private methods, asserting call counts/order, test name describes HOW, verifying via external means.

Seams: "Test only at pre-agreed seams. Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam." Purpose: concentrate on critical paths/complex logic. to-spec: "use the highest seam possible... the ideal number is one." codebase-design: "The interface is the test surface... If you want to test past the interface, the module is probably the wrong shape."

Loop rules: "Red before green"; "One slice at a time. One seam, one test, one minimal implementation"; do not anticipate future tests. NOTABLE: "Refactoring is not part of the loop. It belongs to the review stage (code-review), not the red -> green cycle." (differs from classic red-green-refactor and from workit's "refactor behind the same contract").

Mocking: mock only at system boundaries (external APIs, DB sometimes - prefer test DB, time/randomness, filesystem sometimes). Never your own classes/internal collaborators. Dependency injection; SDK-style per-operation interfaces over a generic fetcher so mocks have no conditional logic. DEEPENING.md: dependency categories (in-process, local-substitutable, remote-but-owned = port + in-memory adapter, true external = mock adapter); "One adapter = hypothetical seam, two = real"; "replace, don't layer": delete old unit tests on shallow modules once tests exist at the deepened interface.

Bug regression (diagnosing-bugs): write regression test before the fix only if a CORRECT seam exists (exercises the real bug pattern at call site); "If no correct seam exists, that itself is the finding" and flows to improve-codebase-architecture. Phase 1 criterion: one already-run command that is red-capable (asserts the user's exact symptom), deterministic, fast, agent-runnable; "jumping straight to a hypothesis is the exact failure this skill prevents."

## 3. Grilling mechanics (`skills/productivity/grilling/SKILL.md`, 2 KB)

- Model the problem as a design tree. Each ROUND = the whole "frontier" (every decision whose prerequisites are settled). Ask all in one round, numbered, each with a recommended answer; wait for answers; recompute frontier. A question depending on an open one goes to a later round.
- Format: `Q<n> - title: body` then recommended answer, separated by `---` (changeset added the hr).
- Facts are the agent's job (dispatch a sub-agent, don't block; only downstream questions wait); decisions are the user's.
- Done when frontier is empty, nothing silently assumed; do not act until user confirms shared understanding.
- This is a change from his older "one question at a time"; and `.out-of-scope/question-limits.md` records that he rejected capping question count. Workit's note (do not force interviews on precise requests) is NOT in his skill; he uses it every time ("Use them every time you want to make a change").
- grill-with-docs adds domain-modeling: challenge terms against glossary, sharpen fuzzy language, invent edge-case scenarios, cross-reference code vs claims, update GLOSSARY.md inline, offer ADRs sparingly.

## 4. Planning

Chain: grill -> (optional prototype/handoff) -> to-spec -> to-tickets -> implement per ticket (clear context between) or implement-spec. Context hygiene: keep grill+spec+tickets in one unbroken window; each implement starts fresh from a ticket.
Slicing rules (to-tickets): each slice a narrow but COMPLETE path through every layer (schema, API, UI, tests); demoable/verifiable alone; fits one fresh context window; prefactor first ("make the change easy, then make the easy change"); each declares blocking edges (task graph, not list); user approves granularity/edges before publish. Exception: wide refactors use expand-contract (expand, migrate batches by blast radius, contract; shared integration branch with final integrate-and-verify ticket if batches cannot stay green).
Ticket content: end-to-end behavior from user's view, acceptance criteria checkboxes, blocked-by; no file paths/code (stale), except prototype-derived snippets that encode a decision. Triage's agent brief: durability over precision, behavioral not procedural, complete testable acceptance criteria, explicit out-of-scope.
Wayfinder is the pre-spec level: decision tickets, fog of war, "Not yet specified", map is an index not a store (decision lives in exactly one place), refer to items by name not id.

## 5. Knowledge durability

- GLOSSARY.md: opinionated, one-two sentence definitions with `_Avoid_:` aliases, project-specific terms only (no general programming concepts), "totally devoid of implementation details"; not a spec/scratchpad. Multi-context via GLOSSARY-MAP.md. Updated inline, never batched. Benefits claimed: fewer tokens, consistent naming, navigability.
- ADR: `docs/adr/0001-slug.md`, 1-3 sentences enough; optional Status/Considered options/Consequences; three-part gate (hard to reverse AND surprising AND real trade-off); qualifying types listed (architecture shape, integration patterns, lock-in tech, boundary/scope no-s, deliberate deviations, invisible constraints, non-obvious rejections). Repo's own ADRs show it eats its own dog food (.agents/adr/0001, 0002).
- `.out-of-scope/` as dedup memory for rejected requests (one file per concept, readable like a short design doc, links issues).
- Not written: file paths/line numbers in specs/briefs; implementation details in glossary; handoff content duplicating existing artifacts; prototypes stay off main.
- AGENTS.md/CLAUDE.md "incredibly sparingly, usually only navigation pointers" (retro); CODING_STANDARDS.md read at review, not implementation; "the environment is a source of truth too ... a document that restates it is a cache" (writing-for-agents).
- Lazy creation of every file/dir.

## 6. Deterministic vs LLM

Almost everything is prose; he states preference: retro: mechanical violations get a deterministic check (linter rule, pre-commit, CI) "Default to building the check over writing the rule"; CODING_STANDARDS only for judgement calls. Actual scripts are few: `wizard/template.sh` (identical library, LLM only authors STAGES), `diagnosing-bugs/scripts/hitl-loop.template.sh`, `git-guardrails` hook, `setup-ts-deep-modules` dependency-cruiser config, repo tooling (`scripts/link-skills.sh`, `sync-plugin-version.mjs`, changesets, `claude plugin validate --strict`). Review smells (Fowler baseline of 12) are LLM judgement calls with repo standards overriding. Tests/evidence: pr skill ranks screenshots S-tier, execution evidence A-tier.

## 7. Skill-writing conventions

- SKILL.md files are short: grill-me 157 B, grilling 2 KB, tdd 3.5 KB, to-spec 3 KB; largest ~12 KB (wayfinder, ask-matt, writing-for-agents). Reference split into sibling files via pointers (tdd -> tests.md/mocking.md; domain-modeling -> *-FORMAT.md; prototype -> LOGIC/UI).
- Frontmatter: `name`, `description`, optional `disable-model-invocation`, `argument-hint`, `metadata.credits`. Model-invoked descriptions carry trigger phrases ("Use when the user wants..."); user-invoked descriptions are one-line human summaries, trigger lists stripped. Each skill also ships `agents/openai.yaml` (Codex UI metadata + `policy.allow_implicit_invocation: false` for user-invoked), kept in sync.
- Cross-skill deps: explicit "Call the Skill tool with \"name\"" (one skill per call; "Call the Skill tool twice, for X and Y"), never `../other/FILE.md`; user-invoked skills can never be called by other skills (tell the human to run it instead). Hard-dependency skills carry the "run /setup... if not provided" line; soft-dependency skills just say "the project's domain glossary" (ADR 0001).
- writing-for-agents: "context pointers" (wording decides when material is reached), context load vs cognitive load, information hierarchy and progressive disclosure, co-location, sprawl, every step ends on a completion criterion (clear + demanding; "checkable and exhaustive"), split by sequence to avoid premature completion, "leading words" (tight, red, tracer bullet, fog of war, frontier), negation is a failure mode (state the positive), pruning: single source of truth, no-ops, sediment, environment-as-cache.
- Style: no em-dashes in repo prose; every promoted skill needs README entry + plugin.json entry + docs page with sections What it does / When to reach for it / Common questions / It's working if (.agents/writing-docs.md). Changesets for versioning.
- Distribution: Claude Code plugin (official marketplace, `.claude-plugin/plugin.json` explicit skill array) plus skills.sh installer for other agents; Codex native plugin deferred (ADR 0002: Codex manifest takes one path string, drops symlinks).

## 8. What workit should adopt, and conflicts

Adopt (ordered by value):
1. Frontier-round grilling with a recommended answer per question and "facts are the agent's job" (already partly in). Add the explicit completion criterion "frontier empty, no silent assumptions" but keep workit's de-escalation for precise requests.
2. Pre-agreed seams as the unit of test planning, "highest seam, ideally one", recorded in the plan/spec's Testing Decisions. Gives workit a concrete evidence contract per task.
3. Tautology definition with the "independent source of truth" fix, plus the correct-seam rule for regression tests ("no seam is itself a finding"). Add workit's exception for external protocol constants. A cheap deterministic complement worth considering: flag tests whose expected value is computed from the same expression (static lint/heuristic) or mutation-style spot checks; Pocock has none, so this is workit's own extension.
4. Diagnosing-bugs Phase 1 gate: a red-capable, deterministic, fast, agent-runnable command that was already run, before any hypothesis; 3-5 falsifiable ranked hypotheses; tagged debug logs `[DEBUG-xxxx]` for one-grep cleanup; hypothesis stated in commit.
5. Tracer-bullet tickets with blocking edges (task graph, frontier) and expand-contract for wide refactors; slice sized to one context window; user approves breakdown. Map onto workit's tracker abstraction (GitHub/GitLab/YouTrack native links, local fallback).
6. Two-axis review (Standards vs Spec) in parallel sub-agents, never merged/reranked; Fowler smell baseline as judgement-only, repo standards override.
7. Knowledge rules: glossary strictly vocabulary (with _Avoid_), ADR three-part gate, lazy creation, `.out-of-scope/` as dedup memory, no file paths/line numbers in durable plans/briefs, handoff references artifacts instead of copying.
8. Durable agent brief format (Category/Summary/Current/Desired/Key interfaces/Acceptance/Out of scope) for delegated work, and "verify the claim (reproduce) before grilling" in triage.
9. retro idea: after a session, route mechanical failures to deterministic checks, judgement calls to review standards; keep AGENTS.md as navigation pointers only. Fits workit's deterministic-vs-LLM split.
10. Skill authoring rules: description = pointer with front-loaded trigger; reference in sibling files; each step ends in a checkable completion criterion; positive phrasing; prune no-ops; single source of truth; environment is a source of truth (do not restate scripts).
11. pr skill's Merge Danger (one-way/two-way door, blast radius) and evidence-before/after; prototype-as-primary-source on a throwaway branch; phase-boundary decision tree (continue/clear/handoff/subagent/compact).

Conflicts / do not copy for a multi-host plugin:
- His design assumes a Skill tool that other skills call by name; hosts differ (workit targets Cursor, OpenCode, Codex, Pi, CLI). Workit's shared core and per-host surfaces should express composition in core operations, with skills as thin text. User-invoked-only skills (`disable-model-invocation`) map poorly: Cursor/Pi/OpenCode lack identical flags; Codex needs `agents/openai.yaml`. Workit already sets authority per host.
- No deterministic layer: all state lives in prose and tracker issues. Workit has a task/evidence/policy core; keep it as source of truth rather than relying on the model to follow prose gates.
- "Refactoring is not part of the loop" and "never stop grilling until frontier empty" contradict workit v1 (refactor behind contract; do not force interviews on precise requests). Keep workit's versions.
- Tracker-agnostic but GitHub-first, with a one-time interactive `setup-matt-pocock-skills`; workit already has `workit init` and config, so do not add a second setup skill. Config doc in `docs/agents/*.md` duplicates what workit config holds.
- Wayfinder (map issue, assignee-as-claim, one ticket per session) depends on live tracker mutation and concurrent sessions; needs workit's tracker adapters and authority checks (e.g. YouTrack lacks native parent/child identical semantics). Treat as optional.
- Spec template demands a "LONG, extremely extensive" user-story list; that is heavy for small changes and conflicts with workit's scaled paths (spike/bounded/architectural). Scale it.
- Artifacts like HTML reports opened via `xdg-open`, wizards written in bash, Windows/WSL branches: host-specific and side-effectful; need workit's approval policy.
- Dependency on the Skill tool for `grilling`+`domain-modeling` double-call is Claude-Code-specific phrasing ("Call the Skill tool"); other hosts need their own invocation wording.
- The license/credit: `pr` credits Dex Horthy; attribute adapted text.
