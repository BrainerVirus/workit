# Inspiration scout: GSD (core, pi, original) and Gentle AI (gentle-ai, gentle-pi, engram)

Research date: 2026-10-03. Shallow clones live in
`/tmp/claude-1000/-home-cristhofer-pincetti/fb894a62-61b7-4f32-a4d0-f47c2e5e300f/scratchpad/refs/`.
All HEADs read were dated 2026-10-03: gsd-core `81cb6f8`, gsd-pi `387de59`, gentle-ai `f4d3f3e`
(docs say v4.0.0), gentle-pi `cd4ba5a`, engram `a5d9429`, get-shit-done `bdcaab2` (2026-05-31).

## 0. What workit already borrowed, and pin drift

Workit cites these in `docs/workit-v1/spec.md` section 16 (~line 942) and `docs/adaptive-workit/spec.md` (~266-275):
Gentle AI `72e0ccc` (natural outcome requests, inline work, focused delegation, optional SDD), GSD Core
`eca9c2b` context-engineering.md (bounded fresh contexts, durable continuity), Gentle Pi `d901018`, GSD Pi `2a1882e`,
Engram (optional, never mandatory: "adding a mandatory Engram server" is out of scope).

Drift since those pins (HEAD, not pinned):
- Gentle AI replaced "SDD-by-size" routing with **ODD (Organic Driven Development)** as the default workflow,
  plus **RDD (Receipt-Driven Development)** review authority owned by the Go binary. `docs/trigger-rules.md` now says
  "SDD is an explicit choice ... not an ambiguity resolver", "No silent SDD enrollment", and the 1-3 / 4+ file counts
  "describe the context needed for the current action, not a risk score and not an SDD threshold". The workit note
  "do not copy file-count thresholds" is therefore even more correct. Embedded `sdd-*` skills are listed in
  `docs/components.md` but I did NOT find them in `internal/assets/skills/` at HEAD (only judgment-day, branch-pr, etc.);
  treat SDD as legacy/optional and re-verify before citing phase details.
- GSD: `get-shit-done` (glittercowboy) is now an archive redirect to gsd-core. `gsd-core` is the community v1 line
  (markdown commands/workflows/agents + Node CLI `gsd-tools`); `gsd-pi` is the standalone Pi-based agent with SQLite
  authority. gsd-pi `VISION.md` records the maintainer abandonment (2026-04-01) and token episode. Do not cite the
  original as living reference.
- Gentle Pi is now branded **gentle-shell** (npm `gentle-pi`), a Pi package.

## 1. GSD Core (https://github.com/open-gsd/gsd-core)

### 1.1 Inventory (counts from `docs/INVENTORY.md`, `agents/`, `skills/`, `gsd-core/workflows/`)
- Layers: `commands/gsd/*.md` (thin prompt files) -> `gsd-core/workflows/*.md` (orchestration logic, with
  `steps/` and `detail/` sub-files and a `section-manifest.json`) -> `agents/gsd-*.md` (fresh-context workers) ->
  `gsd-core/bin/gsd-tools.cjs` + `src/*.cts` (deterministic CLI) -> `.planning/` on disk. `skills/gsd-*/SKILL.md` is the
  same command surface rendered as skills for hosts that use skills.
- ~65 skills/commands. Router meta-skills (`/gsd-workflow`, `-project`, `-quality`, `-context`, `-manage`, `-ideate`)
  are descriptor-only so eager skill-listing token cost stays low (`docs/ARCHITECTURE.md` "Two-stage hierarchical routing").
  Core loop: `new-project`, `onboard`, `discuss-phase`, `spec-phase`, `mvp-phase`, `ui-phase`, `plan-phase`,
  `plan-review-convergence` (cross-AI loop, max 3 cycles), `execute-phase`, `verify-work`, `ship`, `fast`, `quick`,
  `quick-batch`, `code-review [--fix]`, `debug`, `spike`, `sketch`, `explore`, `pause-work`/`resume-work`, `next`, `progress`,
  `audit-milestone`, `audit-uat`, `validate-phase` (Nyquist), `secure-phase`, `map-codebase`, `extract-learnings`,
  `workstreams`, `workspace`, `undo`, `forensics`, `health`, `inbox`, `capture`, `thread`.
- ~33 agents (each with a `.compact.md` token-minimised sibling): researchers (project, phase, ui, advisor, ai, domain),
  `gsd-research-synthesizer`, `gsd-planner`, `gsd-plan-checker` (12+ "dimensions"), `gsd-roadmapper`, `gsd-executor`,
  `gsd-verifier`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-security-auditor`, `gsd-code-reviewer`/`-fixer`,
  `gsd-debugger` + `gsd-debug-session-manager`, `gsd-codebase-mapper`, `gsd-pattern-mapper`, `gsd-assumptions-analyzer`,
  `gsd-doc-*` (writer/verifier/classifier/synthesizer), `gsd-ui-*`, `gsd-dom-verifier`, `gsd-intel-updater`,
  `gsd-mempalace-curator`, `gsd-user-profiler`.
- Hooks (`docs/ARCHITECTURE.md` ~283-301): statusline, `gsd-context-monitor` (PostToolUse; warns at 35%/25% context remaining),
  prompt-injection guards on `.planning/` writes and Read output, `gsd-secret-read-guard` (hard-blocks `.env` reads),
  read-before-edit guard, conventional-commit validator, workflow-guard (opt-in), phase-boundary detector.
- Capabilities: `capabilities/<name>/capability.json` (about 45): per-host runtime descriptors (claude, codex, copilot,
  cursor, opencode, kilo, kimi, qwen, windsurf, trae, cline, augment, antigravity, pi, hermes, vscode, ollama, llama-cpp,
  lm-studio, zcode, codebuddy ...) AND optional feature capabilities (nyquist, security, tdd, code-review, intel, graphify,
  mempalace, live-dom-uat, schema-gate, drift, refactor-trigger...), with a trust/consent/lock model
  (`docs/explanation/capability-trust-model.md`, `src/capability-*.cts`).

### 1.2 Lifecycle, state, deterministic vs LLM
Loop (`docs/explanation/the-phase-loop.md`): Discuss -> (UI design) -> Plan -> Execute -> Verify -> Ship, per phase inside a
milestone. Milestone = releasable version; phase = bounded unit that fits one loop ("Add HMAC validation middleware" yes,
"Build auth" no; "when in doubt, split").

State on disk (`docs/reference/planning-artifacts.md`):
```
.planning/ PROJECT.md ROADMAP.md REQUIREMENTS.md STATE.md config.json [MILESTONES BACKLOG LEARNINGS DECISIONS-INDEX HANDOFF.json codebase/ intel/]
.planning/phases/<NN>-<slug>/ <NN>-CONTEXT.md  -DISCUSSION-LOG.md  -RESEARCH.md  -VALIDATION.md  -PATTERNS.md
                              <NN>-<PP>-PLAN.md  <NN>-<PP>-SUMMARY.md  <NN>-VERIFICATION.md  <NN>-UAT.md  .continue-here.md
```
Requirements carry IDs (AUTH-01) mapped to phases; the plan-checker enforces "every REQ-ID covered".
Markdown is authority in gsd-core (no DB).

Deterministic vs prompt:
- Deterministic (Node/TS): `gsd-tools init <workflow> <phase>` loads a compact JSON context payload; `resolve-model <agent>`;
  `state update|patch|advance-plan`; `phase-plan-index` (wave grouping, `ready`, `blocked_by`, `has_summary`, `gap_closure`);
  `verify` (plan structure, commit validation); frontmatter CRUD; roadmap parsing; config schema; dispatch-capacity;
  gate predicates (`src/gate-*.cts`, evaluation-scope resolver that computes a unit's own commits); capability
  lifecycle; installer; hooks. `.planning/.lock` serialises writers.
- LLM prompt: workflows (`.md`), agent personas, discuss/UAT conversation, plan content, verification judgement.
  Tests enforce that doc rosters match filesystem (`tests/inventory-manifest-sync.test.cjs`).
- Workflow size tiers: XL 90KB / LARGE 54KB / DEFAULT 38KB per file, with progressive disclosure into `steps/` and `detail/`.

### 1.3 Context engineering (strong, directly relevant)
- Thesis ("context rot"): thin orchestrator that never touches source; heavy work in fresh-context subagents (200k each)
  that receive only the artifacts they need; durable files replace conversation memory. `STATE.md` is read first by every workflow.
- Wave execution (`workflows/execute-phase.md`): plans have `wave` + `depends`; orchestrator discovers plans, groups waves,
  spawns one executor per plan in parallel within a wave, passes prior-wave SUMMARY.md + CONTEXT/RESEARCH, collects, advances.
  Per-plan worktree isolation decision (submodule paths drop isolation); `--wave N`, `--gaps-only`, `--interactive`
  (inline, no subagents), `parallelization:false` for sequential. Safety: never run wave N+1 while lower waves are incomplete;
  skip plans with `blocked_by` and report them by name; never dispatch `ready:false`.
- Headroom: context-monitor hook warns the orchestrator at 35%/25% remaining; `effort:` frontmatter (max for orchestrators, low for
  status skills). Honest caveat in the doc: `context: fork` was removed because a forked skill loses the Agent tool.
- Spawn-boundary rule: subagents cannot see uncommitted orchestrator state, so everything must be on disk before spawn.
- Escape hatches for small work: `/gsd-fast` (inline, no plan, "describable in one sentence, under 2 min"), `/gsd-quick`
  (atomic commits + state, skips optional agents), `quick-batch`. The doc explicitly admits overhead/latency trade-offs.
- Token tooling: `.compact.md` agent variants for non-Claude hosts; hierarchical command routers; per-agent model profiles.

### 1.4 Verification
- `gsd-plan-checker` verifies the PLAN before execution along numbered dimensions (requirement coverage, task completeness,
  dependency correctness incl. undeclared temporal coupling, key links, scope sanity, verification derivation, CONTEXT
  compliance, scope-reduction detection, architectural tier, Nyquist, cross-plan data contracts, CLAUDE.md compliance,
  research resolution, pattern compliance). Loop planner <-> checker.
- `gsd-executor`: atomic commit per task; deviation rules 1-4 (auto-fix bug; auto-add missing critical functionality;
  auto-fix blockers; STOP and ask for architectural change); CLAUDE.md directives are hard constraints; auto-mode "tracer"
  gate re-runs `<verify>` end-to-end and HALTS rather than expanding on a broken base.
- `gsd-verifier` (`agents/gsd-verifier.md`): **goal-backward** (what must be TRUE -> what must EXIST -> what must be WIRED),
  adversarial FORCE stance ("assume goal not achieved until code evidence proves it"; "SUMMARY.md claims are not evidence"),
  every truth resolves VERIFIED | FAILED(BLOCKER) | UNCERTAIN(WARNING, human decision). Writes VERIFICATION.md; generates fix plans.
- `/gsd-verify-work`: conversational UAT, one test at a time, persistent `UAT.md`, auto-diagnose failures (`gsd-debugger`),
  plan and verify fix plans, re-route into execute. `gsd-dom-verifier` observes a live DOM per wave (additive, never blocks).
- Cross-checks: `audit-milestone` (completion vs original intent), `audit-uat`, `integration-checker`, `validate-phase`
  (Nyquist test-coverage gaps), `secure-phase` (threat-model mitigations), 6-pillar UI audit, `code-review --fix`.

### 1.5 Durable knowledge
Specs/plans are first-class phase artifacts created at fixed lifecycle points (discuss->CONTEXT, plan->RESEARCH/PLAN,
execute->SUMMARY, verify->VERIFICATION/UAT, milestone close->LEARNINGS/DECISIONS-INDEX via `extract-learnings`).
`/gsd-spike --wrap-up` and `sketch --wrap-up` package findings as persistent skills. Optional MemPalace capability
(ship-time diary + KG mirror with provenance) is the only cross-project memory. There is NO trigger-based "should I write a
spec" detection; the user picks the command (smart-entry / `/gsd-do` and `/gsd-next` route but are explicit).

### 1.6 Brainstorm / challenge style
- `discuss-phase` has two modes (`docs/workflow-discuss-mode.md`): **interview** (identify grey areas, user selects, ~4
  questions per area, ~15-20 interactions) and **assumptions** (explore subagent reads 5-15 files, presents assumptions with
  evidence file paths, "what goes wrong if wrong", confidence Confident/Likely/Unclear; user confirms or corrects; ~2-4
  interactions). Both emit the same six-section CONTEXT.md. Flags: `--auto`, `--batch`, `--analyze` (trade-off tables), `--text`.
- `spec-phase` = Socratic refinement to falsifiable requirements; `explore` = Socratic ideation; `plan-review-convergence`
  = cross-AI challenge of the plan. Tone is neutral/imperative, not a persona; no teaching mode.

### 1.7 Multi-host approach (best-documented of the set)
- One canonical source authored in Claude Code format (`commands/`, `agents/`) + per-host **capability descriptor**
  (`capabilities/<cli>/capability.json`): config home/env var, config format (toml/json/md), `artifactLayout` (kind, destSubpath,
  prefix, nesting, **converter function name** e.g. `convertClaudeCommandToCodexSkill`, `convertClaudeAgentToCodexAgent`).
  The installer (`bin/install.js`, npx) is mandatory: "do not copy files from agents/ or commands/ directly".
- **Host-Integration Interface (ADR-1239)**, `docs/reference/host-integration-interface.md`: versioned negotiated contract over
  nine axes (`embeddingMode`, `commandSurface`, `dispatch{namedDispatch,nested,maxDepth,background,isolation,maxConcurrency}`,
  `modelMode`, `hookBus`, `stateIO`, `transport`, `runtime`, `effortSurface`). Each value must be cited from the host's own
  docs, else the sentinel `undocumented`, and the engine **degrades fail-closed** (e.g. `shouldFlattenDispatch` runs the
  orchestrator inline; `maxConcurrency` degrades to 1). Six interface points: command, dispatch, model, hooks, state, artifact.
  Five engine adapters (declarative/imperative embedding, model, hook bus, state).
- Hooks are registered per host in the host's native vocabulary (Claude `PreCompact/Stop/SubagentStop/FileChanged`, Qwen mirror,
  Cursor `gsd-cursor-*` hooks); "same concept, native event name".
- `gsd-core/pi/` + `capabilities/pi` for Pi; `GEMINI.md`, `vscode/` for others.
- Cost: large maintenance surface (many converters, tests per runtime). Value: the "documented-or-undocumented, degrade closed"
  rule is the transferable idea.

## 2. GSD Pi (https://github.com/open-gsd/gsd-pi)

A different product: a **standalone local-first coding agent** (fork of the Pi agent, `packages/pi-coding-agent`, `pi-agent-core`,
`gsd-agent-core`, TUI, web UI, `daemon`, `mcp-server`, `db`, native Rust bits) with the workflow built in as an extension
(`src/resources/extensions/gsd/`, ~hundreds of TS modules). `VISION.md`: extension-first, simplicity over abstraction,
"heavy orchestration layers: don't duplicate what the agent infrastructure already provides", provider-agnostic.

1. Inventory: slash `/gsd ...` (auto, queue, parallel, discuss, explore, spike, sketch, quick, doctor, recover, sync, knowledge,
   memory, rethink, extract-learnings, ship, pr-branch, verdict, worktree...), 13 bundled agents (`src/resources/agents/`:
   scout, planner, worker, researcher, reviewer, tester, debugger, refactorer, security, doc-writer, git-ops, js/ts-pro),
   `subagent` tool (single / parallel `tasks` / `chain` with `{previous}`), ~85 prompt templates
   (`extensions/gsd/prompts/*.md`: plan-slice, execute-task, reactive-execute, complete-slice, run-uat, validate-milestone, reassess-roadmap...),
   extensions (browser-tools, bg-shell, mcp-client, context7, ttsr, async-jobs, remote-questions, github-sync...).
2. Lifecycle: **Milestone -> Slice (demoable vertical capability, 1-7 tasks) -> Task (must fit one context window; "iron rule")**.
   Loop: Plan (with integrated research) -> Execute per task (fresh session) -> Complete (summary + UAT script) -> Reassess
   roadmap -> next slice -> Validate Milestone (reconciliation gate) -> Complete. `planning_depth: deep` adds staged discovery
   (workflow prefs -> project context -> requirements -> research decision -> milestone roadmap). Progressive planning leaves later slices as `[sketch]`.
   ROADMAP has a mandatory **Boundary Map** (what each slice produces/consumes) and per-slice `risk:` and `depends:[]` tags.
   State: `.gsd/` markdown projections + **SQLite is canonical** (`.gsd/gsd.db`, WAL, single-host). Markdown is a rendered projection;
   hand edits are quarantined under `.gsd/quarantine/projections/` and never imported implicitly. `.compat.json` baselines.
   `docs/user-docs/switching-between-gsd-tools.md` documents the authority mismatch with gsd-core (git commit as handoff).
   Deterministic: state machine derives next unit, milestone leases, dispatch claims, durable **Attempt** records, Kernel
   checkpoints (`execute -> verify`), idempotent receipts, worker heartbeats, worktree lifecycle (dozens of `auto-worktree-*.ts`),
   token profiles. LLM: the unit prompts, with context **pre-inlined** into the prompt ("all relevant context has been preloaded;
   start working immediately without re-reading").
3. Context: fresh session per unit; `token_profile` budget/balanced/quality (40-60% saving claim; coordinates model tier, skipping
   research/reassess, inline level minimal/standard/full); complexity-based routing; compaction snapshot; `CODEBASE.md` cache.
   Parallel: whole **milestones** in isolated worktrees with file-overlap check, `max_workers`; reactive execution dispatches
   independent ready tasks as subagents.
4. Verification: executor `gsd_task_complete` only *stages* a result; host-owned verification then records a **Technical Verdict**
   before publication; `gsd_uat_exec` with intents (`uat-artifact-check`, `-runtime-check`, `-browser-check`, `-service-start`); UAT modes
   artifact-driven / browser-executable / runtime-executable / live-runtime / mixed / **human-experience** where subjective checks
   must be `NEEDS-HUMAN` ("do not invent subjective PASS"); `uat_result_save` rejects PASS that cites failed `uat_exec` evidence;
   rework briefs with per-finding resolution gate completion; closeout-consistency gate.
5. Durable knowledge: `memories` table (decisions as `architecture` memories, patterns/lessons K/P/L ids), `/gsd knowledge`, `/gsd memory`;
   `DECISIONS.md` and `KNOWLEDGE.md` are projections; append-only decisions register; LEARNINGS at milestone end.
6. Interaction: `discuss.md` prompt: ask one vision opener, then a mandatory **Reflection Step** (summary in own words, honest size read,
   "Correct anything I missed", END THE TURN), then layered question rounds (1-3 open questions each, gated), silent
   incremental CONTEXT-DRAFT saves, **anti-reduction rule** (big vision -> plan it, do not push MVP unless asked), "do not survey the
   codebase before the first question; the snapshot is authoritative".
7. Multi-host: not a multi-host core; it is one host (its own agent) that can *call* Claude Code / Cursor Agent as providers and ships
   an MCP server + RPC client + Hermes integration; Claude Code integration shields gsd-core-owned skills and disables native task tools.
8. Lesson: the database-authority route buys leases/idempotency/resumability but costs enormous surface (hundreds of modules, recovery
   commands like `/gsd recover`, doctor heal). It is justified only for unattended `auto` mode.

## 3. Gentle AI (https://github.com/Gentleman-Programming/gentle-ai)

Go binary (`gentle-ai`, v4.0.0) that **configures the agent you already have** (17 hosts). It never installs an agent. It injects
managed prompt sections, skills, MCP (Engram, Context7, CodeGraph), personas, permissions deny-list, and owns native review state.
Tagline: "verifying beats generating".

### 3.1 Inventory
- Components (`docs/components.md`): engram, sdd (optional), skills, context7, persona, permissions (sensitive-path deny list:
  `~/.ssh`, `*.pem`, `.env*`, `~/.aws/credentials`...), gga (Guardian Angel, provider switcher), theme. Presets: full-gentleman,
  ecosystem-only, minimal, custom.
- Skills (`internal/assets/skills/`, `skills/`): judgment-day (blind dual adversarial review), branch-pr, chained-pr,
  work-unit-commits, issue-creation, comment-writer, cognitive-doc-design, skill-creator, skill-improver, skill-registry,
  go-testing, rdd-defect-workflow, rdd-advisory-transport, systemic-issue-triage, issue-root-resolution, gentle-ai-bench.
  (Docs also list 11 `sdd-*` skills: init, explore, propose, spec, design, tasks, apply, verify, archive, onboard.)
- Agents (gentle-pi `assets/agents/`): gentle-ai-explore, gentle-ai-worker, gentle-ai-verify, jd-judge-a/b, jd-fix-agent,
  review-risk/resilience/readability/reliability (the 4R lenses). Chain: `4r-review.chain.md`.
- CLI: `gentle-ai [install|sync|doctor|skill-registry refresh|review mode|review assess|review store-reset|...]`.

### 3.2 Work lifecycle: ODD (current default) and RDD
ODD protocol (`docs/usage.md` ~10-40): 1 Authorize (does the request authorize a change? explain/investigate stays read-only),
2 Explore, 3 Resolve uncertainty (optional research; one focused question for a real product decision; at most ONE assumption
challenge for a high-consequence unproven premise), 4 Classify (substantial = 2+ meaningful steps or progress worth recovering),
5 Track before first write (substantial only: `odd/tasks/<feature>.md` + Engram mirror topic `odd/<feature>/tasks`, tell the user in
one line), 6 Implement task by task (smallest topology; TDD per configured mode; check off ONLY with observed proof; every
task closes with a work-unit Conventional Commit recorded as evidence), 7 Close (verified outcome, every failed/pending
check, next step). Feature doc holds objective, scope, constraints, checklist with stable IDs and acceptance criteria, evidence,
progress, next step. ~400 changed lines per task is a planning heuristic only, never a gate. Delivery strategy per feature:
`ask-on-risk` (default), `auto-chain`, `single-pr`, `exception-ok`. Resume: read both the feature file and the Engram observation,
reconcile with code, read back both writes (not atomic); keep conflicting versions rather than overwrite.
Public states shown to the user: **Working / Checking / Ready / Needs your decision**. A question is allowed only if the answer changes
scope, destructive impact, security exposure, verification cost, accepted residual risk, or delivery.

Trigger/routing rules (`docs/trigger-rules.md`; source `internal/components/agentguidance/routing.go`): direct inline (decide/verify
needs 1-3 files, or one mechanical understood file); delegated direct (understanding needs 4+ files, reading prepares a write, broad
research, or writer changes 2+ non-trivial files); SDD only on explicit request or accepted proposal. Delegation is per action
(tests/builds/review may use fresh workers without changing route). Orchestrator prompt (`internal/assets/generic/orchestrator.md`):
inline evidence budget = one parallel batch, <=3 calls, ~10k tokens; >5 sequential lookups -> one read-only explorer returning
<=~2k tokens with path:line evidence plus one parent spot check; one writer, no parallel writers unless isolated worktrees approved;
~150k parent-context backstop is advisory and explicitly "not mechanically enforced"; launch-deduplication of identical
(phase, fingerprint) delegations; sub-agents must `mem_save` before returning.

RDD (`docs/review-integration.md`, `docs/architecture/organic-rdd.md`): on by default, user opt-out (global or clone-local; any
disabled source wins; automation may never toggle). Candidate (a work-unit commit or PR slice, never a TODO or whole branch) is
frozen to lineage/revision/target; `gentle-ai review assess` returns risk -> passive/low = structural readback, zero reviewers;
medium = one lens; high = 4R (Risk, Resilience, Readability, Reliability) read-only reviewers against frozen git trees; at most one
scoped correction ("no loop-until-clean"); receipts bound to the exact candidate. The **binary owns the transitions** ("a model that
guesses the next step guesses differently tomorrow"), returning the single valid next transition from files on disk. Commit/push/PR
gates are informational and never block.

Judgment Day (`skills/judgment-day`): explicit-only; two blind parallel judges on one immutable target; findings need both judges to be
actionable; ask before first fix round; max two fix rounds and two re-judgments; terminal verdict only APPROVED | ESCALATED.

### 3.3 Verification
Task checkboxes require observed proof; delegated writer runs the parent-listed commands in foreground and reports
`<command>: <observed result>`; parent verifies rather than trusting self-report ("Delegated Verification Gate"); Strict TDD is an
explicit mode (RED observed -> GREEN -> REFACTOR; tests existing does not enable it; unknown mode or missing runner is surfaced,
not guessed); native review is the independent check; unavailable verifier yields a typed "unavailable" result, never invented PASS.
No explicit "goal-backward" construct (GSD has it).

### 3.4 Durable knowledge
- ODD feature doc (only when substantial) + Engram mirror; no artifacts for small work. SDD artifacts (proposal/spec/design/tasks) only
  by explicit choice. Skill registry catalogs skills with triggers + exact SKILL.md paths; sub-agents are handed exact paths under
  `## Skills to load before work`. Persona self-check: "does this request match an available skill? If yes read it BEFORE replying."
- Compaction recovery and session handoffs go through Engram (below).

### 3.5 Brainstorm / challenge / gentle tone
`internal/assets/generic/persona-gentleman.md`: "Senior Architect ... passionate teacher ... frustration from CARING". Rules: never agree with a user
claim without verification (say you will verify, then check code/docs); if user is wrong explain WHY with evidence, if the agent was wrong
acknowledge with proof; always propose alternatives with tradeoffs; push back on code requests without understanding; correct errors
ruthlessly but explain why. Tone recipe: (1) validate the question makes sense, (2) explain why wrong with technical reasoning,
(3) show correct way with examples. Hard constraints on verbosity: short answers by default, **at most one question at a time, then STOP**,
no option menus unless a real fork. Persona scope guard: persona governs only chat text, never code/UI/commit/docs artifacts (which default
English, no slang). Persona is a swappable module (Gentleman / neutral / unmanaged) delivered through each host's native mechanism
(Claude output-style, AGENTS.md section, etc.), which is how tone stays out of the core logic.
Lossless blocking prompts: a sub-agent's user-facing menu must be relayed complete and in order (never summarised), with plain-chat fallback and strict answer-domain validation.

### 3.6 Multi-host approach
- Go `Adapter` interface (`internal/agents/interface.go`): identity, tier, `Detect`, `InstallCommand`, config paths (global dir, system-prompt
  file, skills dir, settings, MCP config path), **strategies** (`SystemPromptStrategy`, `MCPStrategy` = how to inject, not where),
  and capability projections (output styles, slash commands, sub-agents, skills, system prompt, MCP) derived from one canonical
  `AgentCapabilityManifest` (`internal/agents/capabilitymanifest/manifest.go`). Components call adapter methods, never `switch AgentID`.
- Rendering: one canonical rules text rendered into each host's carrier: managed-marker block in an adapter-owned prompt file
  (`<!-- gentle-ai:persona -->`), OpenCode/Kilo `opencode.json` agent prompt, Jinja module for template hosts. `install`/`sync` is idempotent and
  replaces the managed region. Golden-file tests per host (`testdata/golden/persona-<host>-*.golden`) lock the output.
- Honest capability matrix per host (`docs/agents.md`): Claude/OpenCode/Cursor/Qwen/Kimi have native sub-agents; Codex "native multi-agent
  when available, solo fallback"; Windsurf/Trae/OpenClaw = rules+skills+MCP only; Conductor = detection only, no writes; Hermes = ephemeral
  `delegate_task`. Docs say outright: "available features such as delegation and RDD review can differ."
- Safety around config: snapshot backups before every write, managed digest, rollback docs, `doctor` read-only, `sync --dry-run`.
- Pi is carved out: the Pi runtime is owned by a separate package (gentle-pi/gentle-shell), not the binary.

## 4. Gentle Pi / gentle-shell (https://github.com/Gentleman-Programming/gentle-pi)
Pi package (TS extensions: `gentle-ai.ts` incl. a `gentle_review` tool, `gentle-agents.ts`, `child-context.ts`, `child-safety.ts`,
`gentle-todo.ts`, `skill-registry.ts`, `ask-user-question.ts`, plus `runtime/*.mjs` shims that shell out to the `gentle-ai` binary).
Value for workit: (a) the extension is a **thin consumer** of the Go binary's negotiated contract
(`gentle-ai.review-integration/v2`, fixtures mirrored in `contracts/`), see `docs/native-authority-architecture.md`: Pi keeps only
canonical identity, repository identity, candidate-view materialisation, dangerous-command safety; ordinary review authority was
*deleted from Pi* and moved native. (b) `assets/orchestrator*.md` (identity, delegation overlay, memory, skills) are package-owned prompt
assets; delegated writer assets under `assets/agents/`. (c) `docs/delegated-verification.md`: verification rule keyed on a rendered
line `Receipt-driven development: on|off|unknown`, risk tier table when off. (d) Child agents: bounded context, child-safety, explicit
reporting. (e) Migration manifests (`assets/migrations/managed-assets-v*.json`) to evolve managed files across versions.

## 5. Engram (https://github.com/Gentleman-Programming/engram)
Single Go binary + SQLite/FTS5 (`~/.engram/engram.db`), surfaces: MCP (stdio), CLI, HTTP API, TUI, optional Cloud (Postgres, opt-in sync).
- Tools (23): `mem_save`, `mem_update`, `mem_delete`, `mem_search`, `mem_context`, `mem_timeline`, `mem_get_observation`, `mem_suggest_topic_key`,
  `mem_save_prompt`, `mem_session_start/end/summary`, `mem_capture_passive`, `mem_current_project`, `mem_list_projects`, `mem_merge_projects`,
  `mem_pin/unpin`, `mem_review`, `mem_judge`, `mem_compare`, `mem_stats`, `mem_doctor`.
- Model: **observation** = id, sync_id, session_id, `type` (bugfix | decision | architecture | discovery | pattern | config | preference),
  title (Verb + what), content as **What/Why/Where/Learned**, `project` (auto-detected from git remote; ambiguous cwd returns
  `ambiguous_project`; `project_transition_conflict` guard), `scope` (project | personal | global), `topic_key` (stable `family/description`
  upsert key; "different topics must not overwrite each other"; `revision_count`, `duplicate_count`, `normalized_hash` dedupe), `pinned`.
  `memory_relations` (`conflicts_with` etc., `judgment_status` pending/judged/orphaned/ignored) = conflict surfacing audited by `mem_judge`/`mem_compare`.
  Sessions + prompts + summaries stored separately.
- Retrieval discipline ("curated project memory, not a transcript sink"): orient (`mem_current_project`, `mem_context`) -> search before repeating -> **progressive
  retrieval** (search = previews; `mem_timeline`; `mem_get_observation` for the full record before relying on it).
- Save triggers (mandatory): bug fix done, architecture/design decision, non-obvious discovery, config change, pattern established,
  user preference/constraint. Session close protocol: `mem_session_summary` (Goal / Instructions / Discoveries / Accomplished / Next steps / Files). After
  compaction: save summary first, then `mem_context`. "Delivery guarantee": memory writes are bookkeeping and must finish before, never replace, the final answer.
- Host integration via hooks (Claude plugin `plugin/claude-code/hooks/hooks.json`): SessionStart (startup|resume|clear|fork -> load; `compact` -> recover),
  UserPromptSubmit (capture prompt), PreToolUse validator on memory tools, SessionEnd; Codex plugin (+Windows PowerShell native hook), OpenCode TS plugin,
  Pi package (HTTP tools). Single behavioural contract (`memory-protocol` skill / DOCS.md "Memory Protocol") embedded in several carriers with an explicit
  "must change together" alignment table.
- Sharing: `engram sync` exports chunked JSON to `.engram/` for git; Obsidian export; cloud sync with deferred-apply for missing FKs.

## 6. Comparison with workit-relevant needs

| Concern | GSD Core | GSD Pi | Gentle AI/Pi + Engram |
|---|---|---|---|
| Unit of work | milestone > phase > plan(wave) | milestone > slice > task | request; "substantial" -> one feature doc w/ tasks |
| Authority for state | markdown + CLI | SQLite, md projections | feature doc + Engram mirror; review state in binary |
| Who picks the ceremony | user (command) | user/auto | agent by routing rules, user can opt up (SDD) or out (RDD) |
| Fresh-context units | executor per plan | session per unit | one bounded worker per action; one writer |
| Verification | goal-backward verifier + UAT + plan-checker | verdicts + uat_exec + gates | observed-proof checkoffs, risk-tiered review receipts, judgment-day |
| Memory | files + optional MemPalace | DB memories + KNOWLEDGE.md | Engram (optional MCP) |
| Multi-host | installer + converters + capability descriptors + negotiated axes | one host | Go adapters + managed marker injection + goldens + honest matrix |
| Tone | neutral | neutral, reflection-first | persona module, caring mentor, 1 question at a time |

## 7. Recommendations for workit

### Adopt (concrete)
1. **Goal-backward verifier with adversarial stance** (GSD `agents/gsd-verifier.md`): given the stated goal, derive truths -> artifacts -> wiring,
   treat the implementer's SUMMARY as non-evidence, require every truth to resolve VERIFIED | FAILED(blocker) | UNCERTAIN(human). Fits a
   workit "verify" step and the existing evidence-before-claims policy. Add the "stub file satisfies existence, not behavior" failure list.
2. **Plan-check before execute, dimension list as checklist data** (not 12 dimensions of prose): requirement coverage, task completeness,
   undeclared coupling, scope reduction (plan silently dropping a stated decision), CLAUDE.md/AGENTS.md compliance. Keep it a bounded
   loop (GSD uses max 3 cycles; Gentle uses max 1 scoped correction).
3. **Orchestrator spawn contract: "everything on disk first"** and `init`-style compact JSON context payload produced by deterministic
   code (GSD `gsd-tools init`). In workit this belongs in the TS runtime, not the prompt: a `workit context <step>` command that emits only
   needed paths/ids.
4. **Deterministic next-step owner** (Gentle's strongest idea; GSD `phase-plan-index`): a binary/CLI reads state files and returns the one valid
   next transition and ready/blocked work; models never vote. Concretely: workit already has runtime TS (bun); push gating predicates
   (wave readiness, `blocked_by`, "evidence recorded?") there and keep prompts as thin renderers.
5. **Routing by action context, not by size/risk, with explicit opt-in to heavy artifacts**: adopt ODD's authorize -> explore -> resolve
   uncertainty -> classify -> track-before-first-write -> task-by-task -> close skeleton, the "no silent SDD enrollment" rule, and the
   four public states (Working/Checking/Ready/Needs your decision). Question budget rule: ask only when the answer changes scope,
   destructive impact, security, verification cost, residual risk or delivery.
6. **Observed-proof checkoffs** + commit-as-evidence per task (Gentle) combined with GSD atomic commit per task and deviation rules 1-4
   (auto-fix bug / add critical missing / fix blocker / STOP on architecture). Make the deviation taxonomy part of the executor brief.
7. **Wave execution safety rules** (GSD): never dispatch next wave while predecessors incomplete, report skipped/blocked plans by name,
   per-plan isolation decision, a `sequential` fallback and an `--interactive` inline mode. Gentle's counterpoint: single writer unless
   isolated worktrees are explicitly approved; keep that default.
8. **Reflection step before questions** (gsd-pi `discuss.md`): summarise the idea back, give an honest size read, invite correction,
   end the turn. Plus gsd-core's **assumptions mode** (codebase-first, evidence paths, "what breaks if wrong", confidence tag) as the
   default for brownfield, interview mode as fallback. This is the best concrete answer to "agent researches facts, user decides choices".
9. **Challenge protocol from the persona**: verify-before-agree; if user wrong -> validate question, explain why with evidence, show the
   correct way; if agent wrong -> admit with proof; one question then STOP; no option menus without a real fork; at most one
   assumption challenge, only for high-consequence unproven premises. Keep the **persona scope guard** (tone never leaks into code,
   commits, docs) and ship tone as a swappable output-style module, not inside workflow logic.
10. **Engram-compatible memory contract, still optional**: adopt the observation shape (type, What/Why/Where/Learned, `topic_key` upsert,
    scope project/personal), save triggers, progressive retrieval (search preview -> timeline -> full get), session-close summary and
    compaction-recovery. Implement the contract against workit's own record store with an Engram adapter if present (matches the
    adaptive-workit decision). Add the mirror-reconciliation rule: read both copies, reconcile, never silently overwrite a conflict.
11. **Evidence budget numbers as defaults, labelled advisory** (<=3 calls/~10k tokens inline; read-only explorer returns <=~2k tokens with
    path:line + parent spot-check; ~150k parent-context advisory backstop). Plus the honest disclaimer that the backstop is not
    mechanically enforced; pair with a context-monitor hook only on hosts that expose one.
12. **Multi-host core**: copy three ideas, not the machinery. (a) GSD's per-host descriptor with axes and the rule "value must come from
    host docs else `undocumented`, degrade fail-closed" (dispatch -> inline, concurrency -> 1). (b) Gentle's adapter interface where
    components never branch on host id, plus capability projections from one manifest. (c) Gentle's managed-marker injection + golden
    files per host + idempotent `sync` + snapshot-before-write. Publish an honest per-host capability matrix in docs.
13. **Escape hatches in the product**: `fast` (inline, one sentence, <2 min) and `quick` tiers exist because GSD admitted the loop is
    overkill for small work. Workit's "inline vs delegated vs optional spec" already mirrors this; name the tiers.
14. **Judgment-day-style opt-in adversarial review** for high-risk targets: two blind read-only reviewers on one frozen target,
    corroboration instead of a refuter, <=2 fix rounds, terminal APPROVED | ESCALATED. Fit as an optional skill, not default.
15. **Test the docs/inventory**: GSD's inventory-manifest-sync test and Gentle's golden/drift-ratchet tests keep prompts and rosters honest.

### Avoid
- **Phase/milestone/requirements ceremony as the default** (GSD): `.planning/` with 10+ file types per phase and 12-dimension plan checks
  is heavy; GSD itself documents overhead and latency. Keep spec artifacts opt-in (matches ODD).
- **Database-as-authority** (gsd-pi): leases, attempts, kernel checkpoints, quarantine of hand edits, recovery commands. Only justified for
  unattended multi-worker auto mode on one host. Workit's single record store should stay file-based/rebuildable.
- **Making the external binary the review authority and blocking on it** (RDD hash/receipt/lineage machinery, store-reset, enormous
  consent envelopes). The idea (frozen candidate, risk-tiered depth, one scoped correction) is good; the implementation is a large
  security-style system. Take the tiers and the freeze, not the receipts. Also note Gentle itself made gates informational.
- **Copying SDD thresholds or file-count routing as risk scores**; Gentle explicitly retracted that framing.
- **Persona inside core prompts** (Rioplatense voseo, CAPS, "ruthlessly"): useful as an optional module, harmful as default for a team
  workflow; also keep the language-domain guard.
- **Per-host converter explosion** (GSD ~45 capability descriptors, converters in code per host): pick a small supported set and a generic fallback.
- **Mandatory MCP memory server**; keep optional (already in adaptive-workit spec).
- **Pi-fork-sized scope** (gsd-pi VISION: "don't wrap what the agent infrastructure already provides").
- **Citing the original get-shit-done repo**: archived redirect; cite gsd-core. Re-pin Gentle AI references (trigger-rules, components) to a
  v4.0.0 or later commit because ODD supersedes the pinned SDD-era routing text.

### Suggested re-pin list for workit docs
gentle-ai `f4d3f3e` (v4.0.0 line) docs/trigger-rules.md, docs/usage.md#organic-driven-development-odd, internal/assets/generic/persona-gentleman.md,
internal/agents/interface.go; gsd-core `81cb6f8` docs/explanation/{context-engineering,the-phase-loop,multi-agent-orchestration}.md,
docs/reference/host-integration-interface.md, agents/gsd-verifier.md, docs/workflow-discuss-mode.md; gsd-pi `387de59`
src/resources/extensions/gsd/prompts/{discuss,run-uat,execute-task}.md; engram `a5d9429` DOCS.md#memory-protocol, README "For agents".

## 8. Open items I did not verify
- Whether gentle-ai still ships `sdd-*` SKILL.md anywhere (not in `internal/assets/skills/` at HEAD; docs still list them). A deep read of
  `docs/architecture/organic-rdd.md` and the SDD runtime was not done.
- Exact per-host hook availability claims in gsd-core `capabilities/*/capability.json` were sampled (codex) not audited.
- No runtime execution of any tool; all findings are from source/docs reading.
