# Audit: Workit agent skills (2026-10-03)

Scope: the 14 canonical method skills in `packages/workit-core/skills/*/SKILL.md`,
their host copies, the Cursor commands/rules, `packages/workit-core/templates`,
the injected bootstrap (`packages/workit-core/src/core/methods.ts`
`invariantBootstrap`), the build scripts that distribute skills, and the intent
docs `docs/adaptive-workit/spec.md`, `docs/challenge-redesign/spec.md`,
`docs/deslop-gate/spec.md`, `docs/parallel-delegation/proposal.md`.

Token estimates are bytes / 4 (a proxy, not a tokenizer count).

## 0. Headline findings

1. **The skills describe Workit's bookkeeping more than they describe engineering.**
   About a third of the lines across `debug`, `handoff`, `implement`, `review`,
   `behavioral-tdd` and `challenge` say which shared operations to call
   (`task`, `policy`, `evidence`, `finding`, `writer`, `state`) or repeat the
   same guardrail ("no second lifecycle", "never edit metadata directly",
   "never fabricate a receipt"). The bootstrap (~5.3 KB, ~1.3k tokens, injected
   every session) already says all of this.
2. **The PR/CI loop runs by hand.** `babysit` and `green-run` make the model do
   pure `gh`/`glab`/`git` work: list checks, pull logs, find unresolved threads,
   rerun flakes, run `git merge-base --is-ancestor`, and check the remote ref after a
   push. Core has managed actions for `git.branch_setup|commit|push` and
   `hosting.pull_request|merge|delete_branch`, but nothing for CI status,
   logs, rerun or review threads. This is the biggest gap where a CLI should take over.
3. **The skills, templates and Cursor commands contradict each other** (section 1
   and section 2.3). Examples: `debug` says to acquire a writer before mutating, but
   `implement` and the bootstrap say not to do that for solo edits. `plan` says not to
   prescribe commit structure, but `plan-template.md` requires one contiguous commit
   range per task. `execution-contract.md` still requires start/assess, a writer and
   no worktrees, which is the ceremony `adaptive-workit` removed. Five Cursor
   `/wk-*` commands describe an older version of their skill.
4. **The descriptions trigger poorly.** Most say *when* in Workit-internal terms ("when
   policy identifies...", "when assessment selects...") and never say *what* the skill does or
   which words a user would type. `implement`'s description matches nearly every coding
   request and loads ~700 tokens about delegation and writer fencing.
5. **The copies are generated but committed.** All four host copies are byte-identical
   to canonical today. They are still checked into git (70 tracked SKILL.md files), so
   they can drift whenever someone skips `bun run build`. The Cursor commands are
   maintained by hand and *have* drifted.
6. **The skills have no progressive disclosure.** Every skill is one `SKILL.md`, with no
   `references/`, no `scripts/` and no examples. The fixed format (Method / Completion /
   Common mistakes) adds ceremony to skills as small as `mockup` and `diagram`.
7. **The workflow is missing pieces:** BDD/acceptance scenarios that are executed, a test-quality audit
   (tautology detection exists only as prose inside `behavioral-tdd`), PR
   slicing/stacking, parallel write fan-out (deferred proposal), and a
   self-verification loop ("run the app / prove the outcome" before saying done).

## 1. Per-skill audit

Legend: L = lines, T = estimated tokens. Score 1-5 (5 = keep as is).

### workit-babysit (37 L, ~450 T): score 3
- **Purpose:** drive an opted-in PR to PR-ready (conflicts, then threads, then CI) without merging.
- **Description:** "Use when the user asks to babysit a PR or explicitly opts in to PR follow-up". Narrow and
  correct, but it relies on the user knowing the word "babysit". Add phrasings such as "get this PR green",
  "address review comments", "fix the MR", "watch CI".
- **Tools referenced:** `git merge-base --is-ancestor`, push, a `babysit:true` flag (core
  `external-action.ts`), and evidence re-recording after a squash merge.
- **Manual work a CLI should do:** PR snapshot (mergeable state, conflict files,
  unresolved threads with file/line, failing checks with log tails); flake rerun-once
  bookkeeping; the stale-base check; waiting for checks on the new head; re-recording
  evidence against the squash commit. Today each of these costs several turns and
  invites hallucinated API calls.
- **Ceremony:** the watch / threads-only / drive mode taxonomy; the clause "help without claiming
  the Workit route was enforced", which is about provenance and not the task.
- **Unclear or contradictory:** step 3 duplicates `green-run` with slightly different wording.
  The history flipped (#111 "auto-babysit on PR creation" vs now "PR creation does not
  start babysitting"), and the tests pin the new wording. "Never mutate PR topology" also
  forbids a legitimate stale-base *rebase*, while step 3 allows "updating" the base, so the
  allowed update method is unclear (merge? rebase?).
- **Overlap:** `green-run` (CI), `review` (thread triage), `implement` (remote delivery check).

### workit-behavioral-tdd (48 L, ~575 T): score 3.5
- **Purpose:** test a single behavior at a stable boundary, with RED evidence before GREEN.
- **Description:** "Use when policy identifies behavior, side effects, permissions, or data handling that may change
  and a regression boundary is needed". Written for the policy router, not for users or models.
  It won't trigger on "add a test", "TDD this" or "write a regression test".
- **Tools:** shared `task`, `policy`, `evidence` ops. Close enforces RED-before-GREEN.
- **Manual work a CLI should do:** running the slice and recording RED/GREEN evidence. A
  `workit test red|green -- <cmd>` wrapper could run the command, assert the expected exit
  status, bind the result to the candidate SHA, and record it. That is one call instead of run, copy output, record.
- **Strengths:** the best anti-noise guidance in the set (tautologies, ghost loops,
  smoke renders, the "returns undefined" mutation heuristic).
- **Unclear:** `methods.ts` routes the `mechanical-existing-checks` rule to this skill, so
  mechanical changes pull in a RED/GREEN method. The adaptive spec says "no mandatory RED
  evidence ritual". The rule "every imported function returns undefined" is a mutation-testing
  idea stated as prose, with nothing to execute it.
- **Overlap:** `debug` step 3 (regression RED/GREEN), the proposed `test-audit`.

### workit-blast-radius (26 L, ~225 T): score 4
- **Purpose:** prove a small diff is safe beyond its hunks: one fact plus one runnable proof per
  touched surface, and anything unproven is labeled UNPROVEN.
- **Description:** good and short. Could add "who calls this", "is it safe to change X".
- **Manual work a CLI should do:** "grep every caller". A `workit impact <file|symbol>` command
  (LSP/tsc references, ast-grep, or `git grep -w` fallback, plus touched config, migration and
  public-export detection) would make this deterministic.
- **Unclear:** step 4 ("fix at the shared root") turns an analysis skill into a mutating
  one. Completion says to put the note in "evidence or review", which leaves its location open.
- **Overlap:** `review` (regression-risk axis), `debug` (trace callers). It works best as a
  sub-step of review.

### workit-challenge (47 L, ~545 T): score 3.5
- **Purpose:** ground the decision in evidence, give two or three real options and a recommendation,
  ask only consequential questions, record the decision once.
- **Description:** "Use when requirements or consequences leave a real decision open". It doesn't
  trigger on "brainstorm", "what do you think", "options for", "should we", "poke holes".
- **Manual work:** nothing heavy; recording a decision is the only bookkeeping.
- **Ceremony:** the Guardrails block is mostly Workit meta ("no universal spec", "use shared
  operations", "never write task metadata").
- **Unclear or contradictory:** `docs/challenge-redesign/spec.md` (the grill loop: one question
  per round, a 3-round cap, a receipt-shaped decision funnel) was **reversed**. The skill
  groups questions into "one small round", and `test/workit-core/methods.test.ts` asserts
  `not.toContain("receipt-shaped question")`. The redesign spec still sits in `docs/` with no
  superseded marker. The Cursor `/wk-challenge` command still tells the agent to label
  FACT/INFERENCE/OPINION/UNKNOWN, which the skill no longer says.
- **Overlap:** `plan` step 1 ("establish outcome... before asking"), the bootstrap's decision paragraph.

### workit-debug (39 L, ~500 T): score 3
- **Purpose:** find the root cause before patching: reproduce, trace callers, form a hypothesis,
  apply the smallest fix, add a regression.
- **Description:** good ("failing, surprising, contradictory, or regressed").
- **Ceremony:** step 1 makes the agent inspect "task scope, caller authority, candidate
  identity, existing evidence, findings, and worker/writer state" *before reproducing*. For an
  untracked bug that is pure overhead.
- **Contradiction:** step 4 says "Acquire writer authority through `writer` before mutation".
  The bootstrap says "A solo edit does not need writer acquisition", and `implement` says
  "Do not request writer ownership for a solo edit".
- **Missing:** `git bisect` for regressions (deterministic, so it belongs in a CLI or a script),
  instrumentation and log strategy, a hypothesis log so the agent doesn't retry the same idea, a stop
  rule after N failed hypotheses. The Cursor `/wk-debug` command ("build a loop that goes red
  before hypothesizing") is stronger than the skill.
- **Overlap:** `behavioral-tdd` (RED/GREEN), `blast-radius` (sibling paths).

### workit-deslop (31 L, ~305 T): score 3
- **Purpose:** a pre-PR pass that only removes things: dead code, restating comments, filler prose.
- **Description:** clear and it triggers well ("before opening a PR", "AI slop").
- **Manual work a CLI should do:** detecting dead code and exports (knip, ts-prune), finding
  comment-only lines and restating JSDoc in the diff, reporting diff stats ("lines removed"), and
  recording `check` evidence linked to the `pre-pr-cleanup` requirement id. The model has to
  find that id in the policy by hand.
- **Ceremony:** "If the change genuinely has nothing to clean, ask for an approved limitation
  decision". That forces a human prompt for a no-op. It conflicts with the adaptive spec's
  "no ... cleanup waiver for all requests". A clean result should be valid evidence
  ("0 removals; checked X, Y").
- **Contradiction:** "never refactors behavior / removes lines, never moves logic" vs
  "delete ... redundant validators". Removing a validator can change behavior. "Comments die by
  default" is too blunt: it will delete legitimate WHY comments, licence headers and directives.
- **Overlap:** `review` standards axis (smells), `simplify`-style skills.

### workit-diagram (27 L, ~215 T): score 3.5 (rarely used)
- **Purpose:** add a Mermaid diagram only when it supports a decision, with syntax rules.
- **Description:** fine.
- **Tension:** `spec-template.md` marks the mermaid block "REQUIRED" unless N/A, while the
  skill says "never by default". That pushes agents to write a diagram for every spec.
- **Recommendation:** fold it into a `plan`/`spec` reference file (`references/diagrams.md`).
  As a top-level skill it rarely earns a description slot.

### workit-green-run (24 L, ~185 T): score 3.5
- **Purpose:** the CI red-to-green loop: read logs, classify, fix, push once, re-verify.
- **Description:** "Use to drive a red CI pipeline back to green, usually inside babysit". Fine.
  Add "CI failing", "pipeline red", "checks failed".
- **Manual work:** almost all of it should be a CLI: failing checks plus log excerpts, a
  flake ledger (rerun once, remembered across turns), merge-base check, waiting for the re-run on the new
  head. "Never invent CI APIs" is a symptom of not having a CLI.
- **Overlap:** a near-copy of `babysit` step 3. Merge them: `babysit` = threads + conflicts +
  `green-run`, or make `green-run` a sub-reference.

### workit-handoff (37 L, ~440 T): score 3
- **Purpose:** move compact task state to another session or host (`state.export` /
  `state.import`) without moving authority.
- **Description:** good.
- **Manual work:** the skill is mostly "call export, call import, reconcile". A
  `workit handoff [--to <host>]` command could export, print a compact resume brief, and
  check the destination's import, leaving the skill to cover only what to write in the brief.
- **Ceremony:** step 1 lists ten state categories to inspect. Most should come from the
  export itself.
- **Overlap:** `steer` (park/checkpoint), `plan` step 6 (checkpoint). Three skills each define
  "checkpoint" slightly differently.

### workit-implement (48 L, ~710 T): score 2.5
- **Purpose (stated):** implement within authority. **Purpose (actual content):**
  helper delegation rules, writer fencing, cancellation uncertainty, cross-repo delivery
  verification. It says almost nothing about *implementing well*: read neighbouring code, follow
  local patterns, make small verified steps, run the app or tests, compare against acceptance criteria.
- **Description:** "Use when implementing requested code changes in a repository. Follow its
  rules and host permissions; use Workit tracking and delegation only when..." This matches
  almost every coding turn, it is the longest description, and its second sentence is an
  instruction rather than a trigger.
- **Manual work a CLI should do:** step 5's remote delivery check (`git ls-remote`, check the
  commit is an ancestor of the remote ref, report drift). That is exactly what `workit verify-delivery`
  should do. Resolving the checkout, branch and remote is also deterministic (`context.read`).
- **Contradictions:** `execution-contract.md` (shipped in CLI assets) says "Acquire product-write
  ownership ... before repository mutations", "Never use a worktree", and makes start, assess and close
  mandatory. All of that contradicts this skill and the adaptive spec. It also has no code consumer
  besides a package-contents test, so it is an orphan that is still shipped.
- **Overlap:** the bootstrap (cross-repo delivery paragraph almost verbatim), `steer`,
  `babysit`.

### workit-mockup (23 L, ~180 T): score 3.5 (rarely used)
- **Purpose:** ASCII wireframes, at most three hypotheses, before UI code.
- **Fine as written.** It assumes a "spec dir" exists, which contradicts selective docs. It is rarely
  triggered and would work as a reference file next to `diagram` under a planning or design skill.

### workit-plan (45 L, ~565 T): score 3
- **Purpose:** decide whether a plan or spec is worth writing and keep it minimal; avoid approval ceremony.
- **Description:** "Use when dependencies, sequencing, coordination, or resumption make durable
  next actions useful". This is abstract and won't trigger on "plan this", "write a spec",
  "break this down".
- **Content gap:** most of the text explains *when not to plan*. There is no guidance on slicing
  (vertical slices, PR-sized units, stacking), estimating, ordering by risk, or turning
  acceptance criteria into tests.
- **Contradictions:** `plan-template.md` "Global Constraints" require one contiguous commit range per task
  and closing the lead task with `workit_task close`. The skill says "Do not prescribe one commit per
  step". The Cursor `/wk-plan` says "spec + plan for large work, compact plan for
  medium, progress only for small". That size-tier ladder is what the adaptive spec removed.
- **Overlap:** `challenge` (grounding), `steer`/`handoff` (checkpoints).

### workit-review (55 L, ~650 T): score 3.5
- **Purpose:** review of the pinned candidate in a fresh context, on two separate axes (standards, spec fidelity),
  with proof required for each finding and a disposition for each.
- **Description:** "when policy requires fresh-context review ... or when an independent
  correctness and regression check is requested". Half of it is policy jargon; add
  "review this PR/diff/MR".
- **Manual work a CLI should do:** pinning (`git diff <base>...HEAD`, log, base detection),
  gathering the originating spec and acceptance criteria, collecting check output, and recording each finding.
  A `workit review prep` could emit one bundle (base, head, diff stat, spec path, CA list,
  check results), which would make "fresh context" cheap: a subagent gets the bundle.
- **Redundancy:** candidate pinning appears twice (Method step 1 and "Two axes, pinned").
- **Unclear:** the skill never says *how* to get fresh context on each host (spawn a subagent or
  `workit_worker assign role=reviewer`). Its "Do not cycle reviewers indefinitely" doesn't match
  `execution-contract.md`'s "at most two fix+re-review rounds".
- **Missing axes:** test quality (tautological or over-mocked tests), security/data handling.
- **Overlap:** `blast-radius`, `deslop` (smells), `babysit` (bot thread triage).

### workit-steer (39 L, ~505 T): score 3
- **Purpose:** sort mid-task input into a quick question, a same-task adjustment, or a separate request, without
  creating lifecycle churn.
- **Description:** good.
- **Ceremony:** mostly negative instructions. The multi-repo checkpoint paragraph is almost
  verbatim from the bootstrap, so it is paid for twice per session when loaded.
- **Drift:** Cursor `/wk-steer` says "Park state verbatim ... re-anchor with a one-line resume
  brief", which is the older, more ceremonial model.
- **Overlap:** `handoff`, `plan` step 6.

### Cross-cutting skill-writing issues
- **Repeated boilerplate:** "no second lifecycle / approval chain / metadata edits" appears in 7 skills
  plus `workit-contract.md` plus the bootstrap.
- **Jargon without a glossary:** candidate, policy, dimension, requirement id, writer, worker,
  receipt, endpoint, and an "assessment selects `X`" dimension. A model that hasn't seen
  Workit's tool schemas can't act on them.
- **Abstract operation names:** skills say `task`, `evidence`, `finding`, but hosts expose
  `workit_task` (MCP) or `workit task` (CLI). The mapping lives only in the bootstrap and the
  orphaned `execution-contract.md`.
- **Prose pinned by tests:** `test/workit-core/methods.test.ts` has about 60 `toContain`
  assertions on skill and bootstrap wording. This guards regressions, but it also makes
  wording hard to edit and favours legalistic phrasing. Prefer behavioural evals
  (`test/acceptance/*`) over substring pins.
- **No examples anywhere.** One worked example per skill (good vs bad finding, good vs bad
  test) would teach more than the "Common mistakes" tables.

### Score summary
| Skill | L | ~T | Score | Verdict |
| --- | --- | --- | --- | --- |
| babysit | 37 | 450 | 3 | keep, absorb green-run, push mechanics to CLI |
| behavioral-tdd | 48 | 575 | 3.5 | keep, rename/trigger fix, split test-audit out |
| blast-radius | 26 | 225 | 4 | keep or fold into review as a reference |
| challenge | 47 | 545 | 3.5 | keep, rewrite description, strip guardrails |
| debug | 39 | 500 | 3 | keep, drop step-1 ceremony and writer step, add bisect |
| deslop | 31 | 305 | 3 | keep, make no-op valid, CLI-backed detection |
| diagram | 27 | 215 | 3.5 | demote to reference |
| green-run | 24 | 185 | 3.5 | merge into babysit (or CLI-backed sub-reference) |
| handoff | 37 | 440 | 3 | shrink to ~12 lines over a `workit handoff` CLI |
| implement | 48 | 710 | 2.5 | rewrite around engineering craft plus self-verification |
| mockup | 23 | 180 | 3.5 | demote to reference |
| plan | 45 | 565 | 3 | rewrite: slicing, acceptance criteria, stacking |
| review | 55 | 650 | 3.5 | keep, add test-quality axis, CLI review bundle |
| steer | 39 | 505 | 3 | shrink, unify checkpoint with handoff |

Total: 526 lines, ~6.1k tokens if all were loaded. Descriptions are ~1.5 KB (~380 tokens),
always resident. The bootstrap is ~1.3k tokens, always resident.

## 2. Host copies vs canonical

### 2.1 Generated or maintained by hand?
- **Skills: generated.** `packages/workit-{codex,pi,cursor}/scripts/build.ts` and
  `packages/workit-opencode/scripts/build.ts` `rmSync` the target and `cpSync` each
  name in `WORKIT_METHOD_SKILLS` (`packages/workit-core/src/core/skill-manifests.ts`)
  from `workit-core/skills`. Pi, Cursor and OpenCode validate the manifest names
  (`validateSkillManifests`). Codex copies without validating. Cursor also rejects
  executable or shebang files (`validateCursorSkills`).
- **But committed:** `git ls-files` shows 14 copies each under codex, cursor, pi and
  opencode/assets plus core (70 files). The artifact tests (`test/artifacts/opencode-skill-contract.test.ts`
  and similar) compare **names**, not content. Any canonical edit committed without
  `bun run build` ships stale skills on the next publish if the package dir is used.
- **Cursor commands (`packages/workit-cursor/commands/wk-*.md`): maintained by hand.** The
  build only checks that each alias in `WORKIT_SKILL_ALIASES` has a file and copies it.
- **Cursor rule (`rules/workit-contract.mdc`): maintained by hand**, Cursor-specific (hook
  limits, `[workit-role: ...]` markers). This is justified.

### 2.2 Drift (skills)
`diff -rq` between canonical and all four host copies shows no output. They are byte-identical today.
None of the skills vary by host. That is appropriate: host differences (Cursor cannot attest
an implementer writer, OpenCode has no managed external executor, CLI hyphenated actions)
live in the bootstrap and the Cursor rule. One missing piece: skills reference abstract ops
(`evidence`) with no per-host mapping. A short generated `references/tools-<host>.md` would
let the build inject the exact tool names per host.

### 2.3 Drift (Cursor commands vs skills)
| Command | Says | Canonical skill says |
| --- | --- | --- |
| `/wk-challenge` | label FACT/INFERENCE/OPINION/UNKNOWN | observations / inferences / proposals, no label scheme |
| `/wk-plan` | size tiers: spec+plan large, compact plan medium, progress small | no size ladder; plans never prerequisite |
| `/wk-steer` | "park state verbatim", one-line resume brief | park only when needed; conversational checkpoint OK |
| `/wk-debug` | build a red loop *before hypothesizing*, fix at shared root | reproduce, then policy/writer ceremony |
| `/wk-implement` | "reconcile task state, evidence, and findings when done" | task tracking optional |
| others | consistent paraphrases | ok |

Fix: generate the commands from the skill frontmatter (name plus description plus "Extra
context: $ARGUMENTS") instead of maintaining a paraphrase.

### 2.4 Template drift
- `templates/execution-contract.md` is shipped in `workit-cli/assets/templates` but has
  no code consumer. It mandates start/assess, a writer before mutation, no worktrees, and a mandatory
  close: the pre-adaptive model. The Cursor build comment already calls the old bundle
  "retired". Delete it or rewrite it.
- `templates/plan-template.md` contradicts `workit-plan` (commit-range rule, mandatory close).
- `templates/spec-template.md` makes mermaid REQUIRED unless N/A and treats GIVEN/WHEN/THEN as
  prose. Good raw material for BDD, but nothing executes it.
- `docs/challenge-redesign/spec.md` was reversed by later tests and has no "superseded" note.
  `docs/deslop-gate/spec.md`'s "limitation waiver" conflicts with adaptive's "no cleanup waiver
  for all requests".

## 3. The workflow as a whole

### 3.1 Intended chain and how it actually connects
```
challenge ──► plan(/spec) ──► implement ──► review ──► deslop ──► [PR] ──► babysit ⊃ green-run ──► (merge only if authorized)
   ▲              │               │  ▲          │                                   
   └── steer ◄────┴── handoff ◄───┘  └── debug, behavioral-tdd, blast-radius (side methods)
diagram / mockup: decoration of plan/spec
```
- Policy routing (`methods.ts`) wires only `challenge`, `behavioral-tdd`, `review`,
  `plan`, `implement`, `deslop` to rules or dimensions. `debug`, `handoff`, `babysit`,
  `blast-radius`, `green-run`, `steer`, `diagram`, `mockup` depend on the
  description, the bootstrap "Skill routing" sentence, or a `/wk-*` alias.
- The handoffs between skills are implicit. No skill says "next: X" or what artifact it hands
  over (for example, plan produces acceptance criteria and review should check them). The
  `review` spec axis assumes a spec exists, while `plan` mostly argues against writing one.
- `deslop` is enforced (gate on `hosting.pull_request`), but `review` before PR is not. A
  deslop pass runs whether or not anyone reviewed.

### 3.2 Gaps
| Gap | Evidence | Impact |
| --- | --- | --- |
| **BDD / executable acceptance** | spec-template has GIVEN/WHEN/THEN as prose; no skill turns CA-xx into tests or traces tests to CAs | spec fidelity is judged by reading, not by running |
| **Test-quality audit** | tautology rules live inside `behavioral-tdd` prose; no mutation run, no "delete-the-impl" check, review has no test axis | tautological/over-mocked tests pass review |
| **PR slicing / stacking** | `plan` has "small end-to-end outcomes" only; no PR-size budget, no stacked-branch support, babysit forbids topology changes | big PRs, hard reviews |
| **Parallel fan-out for writes** | `docs/parallel-delegation/proposal.md` deferred; `execution-contract.md` bans worktrees | no safe concurrency beyond read-only explore |
| **Self-verification loop** | `implement` verifies *remote delivery*, not that the feature works (run the app or CLI, hit the endpoint, compare to CA) | "done" claims rest on unit tests only |
| **CI / PR CLI** | no `ci.*` / `pr.threads` ops in core | babysit/green-run burn turns on gh/glab mechanics |
| **Regression bisect** | absent from `debug` | slow regressions hunts |
| **Release / changelog** | core has `changelog.ts`, `commit-flavors.ts`, no skill | ok if CLI-only, but undocumented to the agent |

### 3.3 Likely rarely useful
- `mockup` and `diagram`: niche, better as references.
- `handoff`: real but infrequent. Mostly a CLI call.
- `steer`: the bootstrap already contains its core rules, so the skill adds little.
- `green-run` as a separate skill: it nearly always runs inside babysit.
- `blast-radius` as a standalone trigger: useful, but most valuable as a step inside review.

## 4. Recommendations

### 4.1 Target skill set (14 → 10 skills, plus references)
| Skill | Change | Contents |
| --- | --- | --- |
| `workit-shape` | **merge** challenge + plan | ground, options, recommendation; then slice into PR-sized vertical outcomes with CA list. `references/spec.md`, `references/diagrams.md` (ex-diagram), `references/mockups.md` (ex-mockup), `references/slicing.md` |
| `workit-bdd` | **new** | turn acceptance criteria into executable GIVEN/WHEN/THEN scenarios at the public boundary (existing test runner or the project's BDD tool); trace CA-id ↔ test; red first |
| `workit-tdd` | **rename/trim** behavioral-tdd | slice loop only; RED/GREEN via `workit test red|green -- <cmd>` |
| `workit-test-audit` | **new** | detect tautological/ghost/over-mocked/smoke tests: CLI runs stub-the-impl or mutation sample (Stryker/mutmut/`go-mutesting` when present, else "return undefined/throw" stub pass) and lists tests that still pass; agent judges and rewrites |
| `workit-implement` | **rewrite** | craft: read neighbours, follow conventions, small steps, **self-verify** (run the thing, compare to CAs) before done; delegation and writer rules move to `references/delegation.md` |
| `workit-debug` | **trim + add** | reproduce-first loop, hypothesis log, `git bisect` via CLI, stop rule; drop the ceremony in step 1 and the writer step |
| `workit-review` | **extend** | fresh context via CLI `review prep` bundle; axes: spec (CA trace), standards, **tests** (calls test-audit), impact (ex-blast-radius as `references/impact.md`) |
| `workit-deslop` | **fix** | CLI detection; clean no-op is valid evidence; keep WHY comments |
| `workit-ship` | **merge** babysit + green-run + new slice/stack | PR create/stack (`workit pr stack`), then drive to ready; CI/thread mechanics fully in CLI |
| `workit-continue` | **merge** steer + handoff | classify interruption; checkpoint/resume via `workit handoff`; one definition of checkpoint |
| `workit-fanout` | **new** (after parallel-delegation lands) | split disjoint-path work into worktree-isolated workers, collect, integrate, single lead commits; read-only fan-out guidance now |

Remove as top-level skills: `diagram`, `mockup`, `green-run`, `blast-radius` (they become
references). Delete `templates/execution-contract.md`. Align `plan-template.md` with the shape skill.
Mark `docs/challenge-redesign/spec.md` as superseded.

### 4.2 Push deterministic steps into the CLI (and MCP ops)
| Command | Replaces manual work in |
| --- | --- |
| `workit pr status [--json]`: mergeability, conflict files, unresolved threads (path:line, author, bot?), failing checks with log tails | babysit, green-run, review |
| `workit ci rerun --flaky <check>` with a once-per-head ledger; `workit ci wait --head <sha>` | green-run |
| `workit base check`: stale-base detection via merge-base | babysit, green-run |
| `workit verify-delivery --remote <r> --ref <b> --commit <sha>` | implement step 5 |
| `workit review prep`: pinned base/head, diff stat, spec plus CA list, latest checks, emitted as a bundle file for a subagent | review |
| `workit impact <path|symbol>`: references, exports, config/migration touch | blast-radius / review |
| `workit test red|green -- <cmd>`: runs, asserts the expected status, records evidence bound to the SHA | tdd, debug |
| `workit test-audit [--files]`: stub or mutation pass, lists surviving tests | test-audit, review |
| `workit deslop scan`: dead exports (knip), restating comments in diff, removed-line stats, auto-records pre-pr-cleanup | deslop |
| `workit pr stack create|sync|submit` | ship/slicing |
| `workit handoff [export|import]` with a printed resume brief | continue |
| `workit bisect -- <repro cmd>` | debug |

Principle: if a step has one right answer given repo state, it belongs in the CLI and returns
compact JSON. The skill keeps only the judgment (classify, decide, write).

### 4.3 Skill-writing principles for workit-next
1. **Description = what it does + when + trigger phrases users actually type**, in
   one or two sentences and under ~250 chars. No policy jargon ("dimension", "assessment selects").
   Write each description against 5 positive and 5 negative prompts and test triggering
   (skill-creator style evals).
2. **Body under ~40 lines / 500 tokens.** Use progressive disclosure: put detail in `references/*.md`
   and deterministic helpers in `scripts/` or the CLI. Load a reference only on the branch that needs it.
3. **Say each rule once.** Authority, no-second-lifecycle and receipt rules live in the
   bootstrap. Skills must not restate them. Add a lint that fails when a skill repeats a bootstrap sentence.
4. **Teach craft, not bookkeeping.** Each skill should change *what good work looks like*.
   State calls appear as one line ("record with `workit test green`"), using host-correct
   tool names injected at build time.
5. **Every skill ends with a self-check the agent can run**: a command or an observable,
   never only "report X".
6. **One worked example (good and bad)** instead of tables of mistakes.
7. **State the chain explicitly:** each skill names its input artifact and its next skill.
8. **Single source, generated distribution:** gitignore the host copies (or add a CI
   `bun run build && git diff --exit-code`). Generate Cursor commands from frontmatter. Compare
   content, not just names, in the artifact tests.
9. **Use behavioural evals, not substring pins.** Replace most `toContain` assertions in
   `methods.test.ts` with acceptance scenarios (`test/acceptance`) that check what the agent
   does: turns, tool calls, questions asked.
10. **Measure:** resident tokens (descriptions plus bootstrap), turns per babysit loop, and
    trigger precision and recall, before and after each change.
