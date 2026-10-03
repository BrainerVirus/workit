# Workit architecture audit

Date: 2026-10-03 · Scope: `packages/*` at `eac7bf4` (v2.1.0), plus the on-disk state under `.workit/` and `~/.config/workit/`.
Method: I read AGENTS.md, the READMEs, all of `task-contract`, `task-store`, `policy-resolver`, `methods` and the skills, and the hot paths of `task-engine`, `task-evaluation`, `youtrack`, the adapters and the hooks. I also ran the toolchain, built small reproductions in a scratch directory, and measured real state. Every claim below cites code or a command result.

> Environment note: I ran root `bun run check` before reading AGENTS.md's rule that forbids it when a host pins this checkout (OpenCode pins `file://…/packages/workit-opencode`). I stopped the run during tests. Its build step had already rewritten the ignored `dist/` bundles. I verified that they are byte-identical to fresh builds in a scratch directory (sha256 `1156d93d…` for the OpenCode plugin, `b34846fc…` for the Cursor MCP server, `23245636…` for Pi), so the loaded plugin is unchanged. I ran every other step on its own.

---

## 0. Executive summary

- **The core is a carefully built state machine that mostly checks itself.** Policy "requirements" come from signals the agent reports about its own work, and they are satisfied by evidence the agent also reports (`provenance: "agent_reported"`, `task-engine.ts:1114`). The gates are enforced in code, but every input to them is LLM judgment. The deterministic parts that would make the gates meaningful are missing: running the check and recording its exit code, and reading CI or PR state.
- **About 25–30% of core is dead or reachable only from tests.** Six OpenCode tool groups (`docs-repo`, `rules`, `templates`, `youtrack`, and most of `repo`) are never registered at runtime. That strands about 2.6k LOC of core (`docs-*`, `verify-project`, `present`, `ports/*`, `sync-runtime.ts`, …). `knip` misses this because `knip.json` marks every `src/core/*.ts` and `src/tools/*.ts` file as an entry point.
- **The recovery machinery is a liability.** Every write copies the full previous record into `.workit/recovery/`, and nothing ever prunes it. In this repo that is 5,752 files and 818 MB for 74 tasks. Meanwhile `state.recover` is unreachable on every production host: no adapter provides `nativeRecovery`.
- **The metadata lock fails closed in both directions.** A crashed process leaves a lock that is never stale, which bricks the store (reproduced). Ordinary contention between two processes returns `recovery_required` instead of a retryable error (reproduced: 3 concurrent writers, 83 of 120 calls failed with `recovery_required`).
- **Performance sits on the host's hot path.** OpenCode runs `listTasks()` (parse plus zod-validate of all task files; about 300 ms here) and `captureCandidate()` (hash every file in scope) **synchronously on every model turn** (`experimental.chat.messages.transform` → `runtime.ts:12-45`).
- **Timezone exists only for YouTrack**, specifically for the "buenos días / buenas tardes" greeting and the work-item date. That date computation is wrong for any process TZ east of UTC (reproduced: off by one day). The global `config.json` timezone is written by the wizard and never read at runtime.
- **Measured usage.** 72 of 74 tasks in this repo were created from OpenCode, and OpenCode has *no* managed external-action path. That makes the about 6.8k LOC external-action, approval and auto-approval stack (Pi and CLI only) the most expensive and least exercised part of the system.
- **The toolchain is healthy.** TS 7.0.2 (native `tsc`) typechecks in 2.3 s; lint and format are clean; 1,572 tests pass under Node 24 (113.6 s). The 35 failures in the first run came entirely from Node 22.19 on PATH while the repo requires Node 24.

---

## 1. Architecture map

### 1.1 Packages and size

| Package | TS LOC (src+scripts, no dist) | Role |
|---|---:|---|
| `workit-core` | 29,238 | Everything: task kernel, policy, approvals, managed Git/hosting/YouTrack effects, setup, doctor, upgrade, cutover |
| `workit-cli` | 5,721 | Ink/React TTY wizard (`steps.tsx` 1,660, `wizard-state.ts` 894), `workit <family> <action>`, `workit action`, upgrade, cutover |
| `workit-opencode` | 3,955 | V1 `server()` (744) and V2 `setup()` (339 + lifecycle 646) dual artifact, native question-receipt store, worker dispatch |
| `workit-pi` | 2,193 | Native extension (9 tools), stock-Pi worker supervisor (`worker.ts` 764) |
| `workit-cursor` | 608 | MCP launcher, one hook dispatcher (458), rule, skills |
| `workit-codex` | 554 | Hook dispatcher (426), MCP launcher |
| `workit-mcp` | 494 | Low-level MCP `Server` exposing the 8 families plus `workit://context/{kind}` resources |
| **tests** | **56,430** (139 files) | About 1.9× the size of core |
| skills | 526 lines (14 × SKILL.md) | Already slim |
| docs | 12,047 lines (37 md) | Plans and specs of past iterations |

Bundle sizes: CLI 3.5 MB, MCP 1.45 MB, OpenCode 1.57 MB, Pi 1.23 MB, and about 1 MB for *each* Cursor and Codex hook entry. Each hook invocation is a cold `node` start that loads a 1 MB bundle containing the whole core.

### 1.2 Core module groups (LOC)

| Group | LOC | Modules |
|---|---:|---|
| **Task kernel** | 8,305 | `task-contract` 1,379 (zod data model, op schemas, canonical JSON, digests), `task-store` 1,307 (fs persistence, lock, recovery), `task-engine` 2,675 (`WorkitCore`: 8 families + worker dispatch + action reservation), `task-evaluation` 809 (candidate capture, requirement and evidence evaluation), `task-context` 205, `policy-resolver` 531, `methods` 167 (bootstrap prompt + method selection), `workers` 199, `authority` 1,033 (decision/receipt verification, reserve/settle/reconcile) |
| **Managed external actions** | 6,834 | `external-action` 1,207 (11-op zod union, plan/chain bindings), `external-action-effects` 2,428 (git, gh/glab, YouTrack execution and read-back), `auto-approval` 338, `pr-create` 717, `branch` 835, `tracker-issues` 174, `repo-context` 505, `changelog` 392, `git`, `commit-flavors`, `branch-policy`, `route-intent` |
| **YouTrack** | 1,133 | `youtrack` 856, `youtrack-tools` 230, `templates` 47 |
| **Install / setup / doctor / upgrade / cutover** | 9,190 | `setup` 1,575, `doctor` 1,775, `cutover` 1,789, `host-install` 458, `uninstall` 441, `init` 501, `registration` 308, `workspaces` 718, `vcs-config` 407, `config` 359, `config-conversion` 183, … |
| **Dead or test-only** | 2,621 | `docs-repo`, `docs-migration`, `docs-layout`, `docs-validate`, `rules`, `verify-project`, `verify-parse`, `repo-tools`, `repo-tool`, `doc-render`, `present`, `sync-runtime.ts`, `parse-sections`, `ports/*` (16 files) — see §3 |
| infra | 377 | `logger`, `boundary` |

The "evidence / finding / decision / continuity / recovery / workspace" concepts named in the brief are **not separate modules**. They are record collections inside one `TaskRecord` document, mutated by methods on the 2,675-line `WorkitCore` class. "Continuity" is `task-context.ts` (compact context string, resume reconciliation) plus `state.export/import`. "Recovery" is `TaskStore.recover*` plus the `recovery/` directory.

### 1.3 The eight operation families (`task-contract.ts:843-1027`)

| Family | Actions | Notes |
|---|---|---|
| `task` | start, list, inspect, revise, progress, pause, resume, close | close is gated by `before:close` requirements |
| `policy` | assess, preview, explain | The agent submits an `Assessment` (8 signals + facts + consequences + verification); the resolver maps it to requirements |
| `evidence` | record | Auto-captures a "candidate" (hash of every file in scope) on each call |
| `finding` | record, resolve | Fixed findings auto-reopen when later failing evidence shares a ref (`task-engine.ts:1121-1150`) |
| `decision` | record, revoke | Binding of task, workspace, scope, presented text and approvedContent; verified against a host receipt where one exists |
| `worker` | assign, report, cancel | Plus host-only `prepareWorkerDispatch` / `commitWorkerDispatch` |
| `writer` | acquire, release | A lease on `workspace.writer` |
| `state` | export, import, recover | `recover` is unreachable in production (§3.4) |

There are also host-only surfaces outside the families: `workit_context` / `context.read` (8 read-only kinds), `workit_init_apply` (OpenCode), `workit_external_action` (Pi), `workit action` (CLI), and `workit_worker_control` (Pi).

### 1.4 Data model and on-disk state

- **`<cwd>/.workit/`** is per session directory (it need not be a Git repository):
  - `workspace.json`: `{id, revision, root, runtime, writer: {state: held|uncertain, owner{taskId, workerId, session}} | null}`
  - `tasks/<uuid>.json`: one monolithic `TaskRecord`. All collections (assessments, candidates, evidence, decisions, findings, workers, policyChanges) are append-only arrays inside it. Every mutation rewrites the whole file with an fsync, a rename and a directory fsync.
  - `recovery/{task|workspace}.<id>.<sha256>.json`: a full copy of the *previous* bytes, written before every replacement (`task-store.ts:1093-1151`), never pruned.
  - `metadata.lock`: an `@openclaw/fs-safe` file lock that holds `{pid, processStart, host, nonce}`.
  - `.gitignore` containing `*` (rewritten on every mutation, `task-store.ts:1090`).
- **`~/.config/workit/`**: `config.json` (locale, timezone, branch and commit policy), `workspaces.json` (glob → VCS provider, account, branch policy, `autoApprove`), `vcs.json`, `youtrack.json`, `youtrack.token`, `templates/`. There are also legacy `github.token`, `github-work.token` and `gitlab.token` files, which the README says are no longer read.
- **`~/.workit/`** is not a separate global store. It is just a `.workit/` created when an agent ran from `$HOME` (24 KB here).
- **`~/.local/state/workit/upgrades/`** holds upgrade backups; **`~/.local/share/workit/`** is the sync-runtime share clone (130 MB here).

Measured bloat in this repo (`bun -e` over `.workit/tasks`):

| Metric | Value |
|---|---|
| Tasks | 74 (70 closed, 2 active, 2 paused) |
| Largest task | 2.57 MB, of which **2.27 MB (88%) is `candidates`**: 29 full snapshots of a 476-file manifest |
| `recovery/` | **5,752 files, 818 MB** (2,244 of them `workspace.workspace.*`) |
| `listTasks()` | 263–394 ms per call (3 runs) |
| Stale state | Two active duplicate tasks with the same objective (`0e625303…`, `75a3089f…`); a writer lease held since 2026-09-25 by an OpenCode session that no longer exists |

### 1.5 How each host maps onto the core

| Host | Transport | Identity / attestation | Approvals | Workers | Managed external actions |
|---|---|---|---|---|---|
| OpenCode V1+V2 | In-process plugin, 10 native tools (8 families, `workit_context`, `workit_init_apply`) | Session ID and `parentID` from the host | Native `question` tool. The adapter captures receipts (`tools/workit.ts` `NativeReceiptStore`) only for questions headed exactly `Workit decision: <purpose>` with options `Approved` / `Rejected` | Native `task` tool; dispatch reservation at `tool.execute.before` | **None.** They were removed; the agent uses native shell `git`/`gh` |
| Pi | In-process extension, 8 family tools + `workit_external_action` + `workit_worker_control` | Pi session, `ctx.ui.confirm` | Native confirm | Bundled supervisor spawns stock-Pi child processes | **Yes**: the full reserve → execute → settle path |
| Cursor | MCP (`workit-mcp`) + one hook binary | MCP caller is unattested; hooks see session IDs | AskQuestion is policy-only (`attested:false`) | `subagentStart` observation only | Unavailable |
| Codex | MCP + hook binary (SessionStart / PreToolUse / SubagentStart / SubagentStop) | Unattested MCP; the hook honors a writer bound via the CLI | None (agent_guided) | Observation only | Unavailable over MCP; available through the CLI |
| CLI | Direct `WorkitCore` | `workit_cli` + `--actor` | TTY confirm; headless returns `needs_input` | n/a | Yes (`workit action`) |

### 1.6 Coupling and duplication between adapters

- Rule #1 in AGENTS.md ("never re-implement core logic per host") is violated in several places:
  - `unfinishedTaskOffer` has five near-identical implementations: `workit-cursor/hooks/workit-hook.ts:233`, `workit-codex/hooks/workit-hook.ts:300`, `workit-pi/src/context.ts:108`, `workit-opencode/src/runtime.ts:47`, plus a V1 call site. Each one filters `listTasks()` by host and session, slices the top 3 and builds the same `<workit-history-offer>` string.
  - `activeTask`, `isRecord`/`nonEmpty`, the hook input parsers, and capability tables are duplicated between the Cursor and Codex hooks. After normalizing host names, the two files still differ in 614 lines, but their structure is the same (parse → capabilities → SessionStart context → PreToolUse decision).
  - The session-matching predicate `provenance.session.kind==="host" && host===X && handle===S` is open-coded in at least 8 places across `runtime.ts`, `v1/server.ts`, `pi/context.ts`, and both hooks.
- Adapters import deep core paths (`@brainervirus/workit-core/src/core/authority`, `/workers`, `/boundary`, `/logger`, `/external-action-effects`). That leaves core without a public API boundary, which is also why knip cannot see dead exports.
- OpenCode carries two complete adapters (V1 `server.ts` 744 and V2 `plugin.ts` + `lifecycle.ts` 985) with parallel receipt, dispatch and injection logic.
- **Parity gap:** the shell branch-policy denial (`route-intent.ts`) is wired in OpenCode V1 (`v1/server.ts:569`), V2 (`v2/permissions.ts`) and Codex (`workit-hook.ts:398`), but not in Cursor or Pi.

---

## 2. Deterministic vs non-deterministic classification

Legend: **D**: deterministic logic that belongs in a library or CLI · **J**: LLM judgment that belongs in a skill or prompt · **M**: currently mixed badly.

| Capability | Class | Where it lives today | Verdict |
|---|---|---|---|
| Task CRUD, revisions/CAS, export/import digests | D | core | Correct placement. The agent still has to know taskIds and schemas, which should collapse into a CLI (`workit task start "…"` returning an id) |
| **Policy assessment** (8 signals × {value, basis, reason, refs} + facts + consequences + verification) | **M** | The agent authors a payload whose full JSON schema is 40 KB (`operationJsonSchema("policy")`), advertised collapsed to depth 1 (5.7 KB of one-line descriptions); code maps it to requirements | The *signals* are judgment and the *mapping* is deterministic, which is fine in principle. But the input is over-structured: every signal needs `basis` + `refs` consistency (`task-contract.ts:301-329`) and contradiction rules. Reduce it to about 4 judgments (risk tier, behavior change, open product choice, needs plan) and let the CLI derive the rest |
| **Evidence of checks** | **M (worst)** | The agent runs `bun test` itself, then calls `evidence.record {kind:"check", result:"passed", exitCode, …}`, stored as `agent_reported` | This is fully deterministic and should be `workit check -- <cmd>`: the CLI runs the command, captures the exit code, a log digest and the candidate, and records `host_observed` evidence. Today the "enforced" close gate is satisfied by self-reported claims |
| Candidate capture (hashing files in scope) | D | `task-evaluation.ts:180` | Correctly automatic, but runs on every evidence, view and close call, is stored in full every time, and walks non-Git trees without bounds (§6) |
| Review independence (session ≠ creator) | D | `task-evaluation` | Fine, but only as strong as the session IDs the host provides |
| Review content, findings, dispositions | J | skills + `finding.record` | Correct. The auto-reopen of `fixed` findings on ref overlap (`task-engine.ts:1121-1150`) over-constrains judgment |
| **Approvals / decision receipts** | **M** | The agent must ask a question headed exactly `Workit decision: action` with options `Approved`/`Rejected` (normalized), keep text ≤300 chars (`BINDING_QUESTION_BUDGET`, `task-contract.ts:602`), then call `decision.record` with a hand-built binding {taskId, workspaceId, scope, presented, approvedContent (canonical JSON descriptor), contentRefs} | The "should I ask?" judgment belongs in the prompt. Building the descriptor and binding is pure bookkeeping, and the core already has `actionProposalQuestion` / `externalActionDescriptor`. One call (`workit approve <op> --payload …` → returns question text + digest; the host hook captures the answer → decision recorded) would remove a whole class of `invalid_input` loops |
| Git branch / commit / push / PR / merge | **M** | Pi/CLI: a managed, deterministic reserve/settle path. OpenCode (72 of 74 real tasks): the agent composes raw `git`/`gh`/`glab` itself, guided by bootstrap prose such as "verify `gh api user --jq .login`…" | The identity check, branch-name validation, base-SHA binding and lease-guarded delete are deterministic and already written. Expose them as plain CLI verbs the agent calls from any host (`workit git push --check-identity`, `workit pr create`) instead of tying them to receipt-attested reservations only Pi can satisfy |
| PR babysit / green-run | **M** | Skills tell the agent to read failing checks, classify flake vs stale-base vs real, and run `git merge-base --is-ancestor` | Gathering the data is deterministic: `workit pr status --json` → {mergeable, conflicts, unresolved threads, failing checks with log tail, behind-base}. Classifying the failure stays judgment. `context.read pr` today is only a local diff/log (`prReadyContext`), not the provider's state |
| Branch-name / commit-message conventions | D | `branch.ts`, `commit-flavors.ts` | Correct, but only reachable through managed actions or the narrow shell-deny hook. Add `workit branch suggest` / `workit commit lint` |
| Writer lease | D | `task-engine.ts:1950` | Deterministic, but of little value (§3.3) |
| Worker lifecycle / dispatch reservation | D | core + OpenCode/Pi | Deterministic. Whether to delegate stays in `workit-implement` (J), which is fine |
| Method / skill selection | D+J | `selectMethods` (code) + bootstrap "Skill routing" prose | `triageTier` / `triageSignals` (`policy-resolver.ts:63-84`) are dead in production; the real routing lives in prose. Pick one |
| Handoff | D | `state.export/import` | Deterministic. The skill is fine |
| YouTrack greeting, mention, time entry | D | `youtrack.ts` | Deterministic but hard-coded to one user (§6) |
| Setup / doctor / upgrade | D | core + CLI | Correct placement, but 9.2k LOC (§3.7) |
| "When to start a task", "is this consequential", "ask vs proceed" | J | 70-line `invariantBootstrap()` injected every session | Correct placement, but too long and full of host-specific exceptions ("On OpenCode V1 and V2…") that each adapter should inject only for its own host |

**Deterministic work currently pushed onto the agent:**
1. Running checks and transcribing their results into evidence.
2. Building decision bindings and descriptors and matching exact question headers and labels.
3. Composing `git`/`gh`/`glab` commands on OpenCode, including the identity check the bootstrap asks for in prose.
4. Collecting PR, CI and thread state for babysit.
5. Choosing taskIds and finding the current task: the agent created duplicate active tasks with identical objectives.
6. Knowing nested schemas that the advertised depth-1 projection hides (`OPERATION_SCHEMA_DEPTH = 1`, `task-contract.ts:1138`).

**Judgment that code over-constrains:** the signal/basis/refs cross-validation, the 300-char question budget and fixed Approved/Rejected labels, finding auto-reopen, the 9-value `dimension` taxonomy (`task-contract.ts:437`), and rejection of evidence whose candidate was not captured (`task-engine.ts:1094-1102`).

---

## 3. Useless, over-engineered or dead features

### 3.1 Dead code (evidence)

`knip` reports nothing, but only because `knip.json` declares `src/core/*.ts` and `src/tools/*.ts` as entries. With real entries (`knip --config` using `src/core.ts`, `src/plugin.ts`, `extensions/workit.ts`, `src/index.tsx`), it reports 11 unused exports and 13 unused types, including OpenCode's `createTools`, `createWorkitTools` and `opencodeCapabilities`. A manual import graph is more telling:

| Unregistered at runtime | Evidence | Core it strands |
|---|---|---|
| `workit-opencode/src/tools/docs-repo.ts` (`workit_docs_layout`, `_docs_repo_link`, `_docs_list`, `_docs_promote`) | Only imported by `test/workit-opencode/schema-depth.test.ts` | `docs-repo` 233, `docs-migration` 639, `docs-layout` 279, `docs-validate` 393 |
| `tools/rules.ts`, `tools/templates.ts` | Tests only | `rules` 125 |
| `tools/youtrack.ts` (5 tools) | Tests only (`config-guard.test.ts`, `schema-depth.test.ts`) | YouTrack stays reachable via `context.read` / external actions |
| `tools/repo.ts` except `workit_init_apply` | `v1/server.ts:168` uses only `createRepoTools().workit_init_apply`; V2 uses `WORKIT_TOOL_CATALOG` | `verify-project` 181, `verify-parse` 29, `repo-tools` 22, `parse-sections` 24 |
| `core/ports/*.ts` (16 Bun-only shell-script ports) | No references from code, scripts, package.json or tests; they use `Bun.stdin`, so they would not even run on the Node runtime | `present` (`asciiWireframe`, `flowDiagram` unused) |
| `core/sync-runtime.ts` (375) | The `.sh` version is what the install scripts run; the TS port is referenced only by tests | — |
| Unused exports with a single self-reference | `validateCommitMessageFor`, `conversionDigest`, `describeConfigSource`, `cliFound`, `prRangeArgOrDefault`, `withWorkspace`, `ASSET_ROOT`, `vcsWorkspacesPath`, `triageTier`, `triageSignals`, `shouldRenderDoc`, … (29 total) | — |

Total: about 2.6k LOC in core, about 0.4k in the OpenCode adapter, and roughly 15 test files that test only dead code (`docs-*.test.ts`, `rules*.test.ts`, `template-tools.test.ts`, `triage.test.ts`, `doc-render.test.ts`, …).

### 3.2 Timezone

What it is for: only YouTrack. `youtrack.ts:121-170` builds a Spanish greeting (`"@<named colleague> Hola, buenos días."`) using `timezone` and `greetingCutoff`. `youtrack.ts:185-227` (`youTrackWorkDateMs`) resolves the "auto" work-item date for `youtrack.update` and `youtrack.meeting` (`external-action-effects.ts:1729`). `youtrack.time` requires an explicit `dateMs`.

Problems:
- **Two copies.** The wizard writes `config.json.timezone` (here `"UTC"`) and `youtrack.json.timezone` (here `"America/Santiago"`). Nothing reads the former at runtime; it only feeds the wizard and config conversion.
- **Bug.** `Date.parse("YYYY-MM-DDT00:00:00")` is evaluated in the *process* TZ and then floored to a UTC day, so the configured IANA zone affects only the `localDate` label. Reproduced with config `America/Santiago`, input `2026-10-03`: under `TZ=Asia/Tokyo` it returns `2026-10-02T00:00Z`, under UTC or Santiago `2026-10-03T00:00Z`.
- **A mandatory wizard step** (`steps.tsx:1086-1125`, a full IANA picker) for every user, including those without YouTrack.
- **A coupling bug.** `youTrackContext` fails entirely if the greeting fails (`youtrack.ts:608-611`), so a greeting problem blocks reading an issue.

**Verdict:** pointless as a global setting. Keep one optional `youtrack.timezone` that defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`, compute the date as `Date.UTC(y, m-1, d)`, drop the wizard step and the `config.json` field, and move the greeting text into the skill or template (a judgment or locale concern, not core logic).

### 3.3 Writer lease ("writer locks")

- Two different mechanisms share the name. `metadata.lock` is a short file mutex around each mutation. `workspace.writer` is a long-lived lease.
- The lease only gates managed external actions (`assertLocalExternalActionWriter` → `assertProductWriteAllowed`, `external-action-effects.ts:277`) and helper and worker write ownership. No host blocks file writes based on it: AGENTS.md itself says that file writes pass through to host policy on Cursor and Pi, and OpenCode has no managed actions.
- Any lead session can take the lease from any other lead, even one on a *different task* (`task-engine.ts:1984-1991`: only a `workerId` blocks the transfer). Between leads it is therefore advisory, yet it blocks `task.close` and `pause` (`activeWorkerBlocker`, `task-engine.ts:775-784`) until it is released.
- Observed: a lease held since 2026-09-25 by a dead OpenCode session on an "active" duplicate task.
- **Verdict:** over-engineered for the threat it addresses. Keep a simple, TTL-based advisory "who is working here" marker for implementer workers if parallel implementers stay a feature; otherwise delete it.

### 3.4 Recovery directory and `state.recover`

- `saveRecovery` copies the full previous bytes on every replace (`task-store.ts:1093-1151`), with no cap, TTL or pruning, and `initializeMutationStorage` creates the directory on every mutation. Because task records grow, total bytes grow roughly quadratically with mutations (818 MB for 74 tasks). In the 3-process contention test, 37 successful writes produced 36 recovery files.
- `state.recover` requires `context.nativeRecovery` (`task-engine.ts:851-852`). Grepping all packages finds it supplied only in tests (`task-continuity.test.ts:31`, `omitted-defaults.test.ts:22`); the CLI forwards an optional `deps.nativeRecovery` that `index.tsx` never sets. Reproduced: `state.recover` returns `permission_denied: native recovery authority is unavailable`.
- **Verdict:** about 400 LOC of protocol (process-evidence freezing, digest gates, reclaim gates) protects a path no user can reach, while it fills the disk. Replace it with the append-only event log in §7, which gives history for free, or at minimum keep the last N copies per record.

### 3.5 Workers and dispatch reservation

Workers are used: 149 recorded, all `stopped`, nearly all OpenCode reviewers and investigators. But the `prepare/commit` dispatch reservation (in-memory WeakMap tokens, `task-engine.ts:166-180`), `cancelling`/`unknown` vetoes and lead-attested cancel add a lot of machinery to what is mostly a "child session reviewed X" record. **Keep** worker records as evidence provenance (that is what makes independent review checkable). **Drop** the launch-slot reservation protocol except where a host truly spawns processes (Pi).

### 3.6 Policy engine, approvals and route denial

- **Policy engine:** a deterministic mapping from self-reported signals to requirements, 531 LOC plus an assessment schema the model must fill. Value is modest (it reminds the agent to test, review and deslop), and the reminder could come from a 10-line rubric in a skill. Keep a much smaller resolver whose inputs are a risk tier plus project constraints, and make its *checks* deterministic (§2).
- **Approvals (receipts, standing auto-approval, plan/chain bindings):** about 6.8k LOC serve hosts that represent 2 of 74 real tasks. The exactly-once reservation, expected-tip delete and source-SHA prebind are genuinely valuable for remote effects, and they belong in a CLI that any host can call. Receipt attestation and digest-bound decisions per host are over-engineered relative to the host's own permission prompt, which the docs repeatedly call authoritative anyway.
- **Route denial** (`route-intent.ts`, 37 LOC): cheap, deterministic, honest about its narrow coverage. **Keep it**, and add it to the Cursor and Pi hooks for parity.
- **Provider-safe schemas** (`boundedOperationJsonSchema`, depth 1, plus a stringified-object tolerance for Pi): a workaround for providers that limit nesting depth. It makes models guess nested shapes from one-line summaries. A flat CLI argument surface or flat per-action tools would remove the need for it.

### 3.7 Other over-engineering

- **`cutover`** (1,789 LOC + `legacy-ownership` + `config-conversion`) migrates legacy `workflow-toolkit` installs. AGENTS.md says the legacy config "was cleaned up", so this can be retired behind a one-release deprecation.
- **`doctor`** at 1,775 LOC includes npm-registry staleness logic for an OpenCode cache path. It is valuable, but it should live in the CLI package, not in core (core is bundled into every hook and plugin).
- **The parity rule itself** ("a new feature adds the core module, both host adapters, and the CLI surface plus parity tests") multiplies the cost of every feature by about 4. It is the root cause of the test volume and of the dead OpenCode tools.

---

## 4. Toolchain results (`bun run check`, run step by step)

Environment: Bun **1.3.14** locally (repo pins `packageManager: bun@1.4.1`, CI uses 1.4.1); Node **22.19.0** on PATH (repo requires ≥24; `.node-version` is 24.20.0, available via fnm).

| Step | Result | Time |
|---|---|---|
| build (6 packages, run once by accident; rerun into a scratch target per package) | OK; output deterministic (identical sha256) | about 0.06–0.11 s per package |
| `oxlint --deny-warnings` | OK, 0 warnings | 0.08 s |
| `oxfmt --check` | OK, 294 files | 42 ms |
| `tsc --noEmit` (typescript **7.0.2**, native) | OK | 2.3 s wall |
| `bun test` with Node 22 on PATH | 1,537 pass / **35 fail** | 123.5 s, 693 MB max RSS |
| Rerun of the 14 failing files with Node 24.20 | 217 / 217 pass | 53.6 s |
| `bun test` full with Node 24.20 | **1,572 pass / 0 fail** | **113.6 s** |
| `knip` (repo config) | Clean (4 config hints) | 1.3 s |
| `knip` with real entries | 11 unused exports, 13 unused types | — |

All 35 failures came from Node 22: 27 contain "node 24+ required (found v22.19.0)", and the rest are EBADENGINE warnings and doctor exit codes. One test is brittle: `test/workit-pi/stock-pi.test.ts:15` asserts the *exact* `node --version === v24.20.0`, so it fails on 24.21.

Slowest suites under Node 24: `doctor.test.ts` 13.1 s, `artifacts/phase-0-candidate.test.ts` 11.7 s, `install-scripts.test.ts` 5.9 s, `packed-runtime.test.ts` 5.4 s, `packed-cli.test.ts` 4.2 s. The slowest single test is "isolated npm install of the packed CLI" at 9.3 s (it runs a real `npm install`, so it depends on network and cache). These artifact and packaging tests belong in a separate `test:packaging` lane. The domain tests alone would run in about 60 s.

I observed no flakes in two full runs. Tests that depend on the environment (Node version, npm registry, `flock`, `gh`) are the risk.

---

## 5. Dependencies

| Dep | Current | Latest | Notes |
|---|---|---|---|
| zod | 4.5.4 | 4.6.5 | See quality notes below |
| @modelcontextprotocol/sdk | 1.30.0 | 1.32.0 | Uses the low-level `Server` + `setRequestHandler` (fine for hand-built JSON Schema) |
| @openclaw/fs-safe | **0.8.1** | **0.23.0** | Far behind, and it is the lock primitive behind §6.1 |
| @opencode-ai/plugin / @opencode/plugin | 1.18.30 / 2.0.18 | 1.18.34 / 2.0.22 | V2 uses the `promise` flavor (no Effect in the adapter) |
| @earendil-works/pi-coding-agent | 0.85.1 (peer) | **1.0.1** | A major version; the Pi contract is pinned to 0.85.1 everywhere |
| ink | 7.1.1 | 8.0.0 | CLI wizard |
| typescript | 7.0.2 | 7.0.2 | Native compiler in use (`tsc` is tsgo); no `tsgo` binary needed |
| oxlint / oxfmt / knip | 1.81 / 0.66 / 6.35 | 1.86 / 0.71 / 6.39 | Minor |
| @types/node | 24.13 | 26.6 | Keep 24 to match the engine |

**Zod 4 usage quality:**
- Good: strict objects everywhere, discriminated unions, `.check()` refinements, `z.toJSONSchema` for host projection.
- Weaker:
  - `operationSchemas` are built with `Object.values(...) as any` (`task-contract.ts:1019-1026`), which erases request types. The engine then does `parsed.data as any` in every family method. There are 63 `any` casts in the repo, 15 of them in `task-engine.ts`.
  - `parseOperation` parses **twice** on success: the `z.compile` JIT schema first, then the uncompiled schema (`task-contract.ts:1119-1120`). The compile step adds cost on the happy path instead of saving it.
  - A hand-written UUID and UTC validator duplicates `z.uuid()` / `z.iso.datetime()`.
  - `rewriteRecordRefs` walks values by duck-typing every object against `refSchema.safeParse` (`task-contract.ts:170-255`), which is O(nodes × union parse).
  - Records are re-validated with the full `taskRecordSchema` on every read, which is the main cost behind the 300 ms `listTasks`.

**Effect:** Workit does not use Effect. `effect@4.0.0-beta.83` and `4.0.0-rc.112` are present only as transitive dependencies of `@opencode-ai/plugin` and `@opencode/plugin`.
- **Where Effect 4 would genuinely help:** the managed-action runner and the new CLI. These are long async pipelines of subprocesses (`git`, `gh`, `glab`, HTTP to YouTrack) with timeouts, retries, lock acquire and release (`Effect.acquireRelease` / `Scope` would replace the nested try/finally in `task-store.ts:897-973`), typed failures (the 13 `ErrorCode`s map naturally to tagged errors), and "outcome unknown" reconciliation. Effect also fits Pi worker supervision (interruption, structured concurrency) and `@effect/cli` for `workit <noun> <verb>`.
- **Where it would hurt:**
  - In-process plugin and hook bundles: hooks are synchronous, cold-started node processes, and Effect adds bundle size and runtime.
  - The pure domain kernel (policy mapping, evaluation), where plain functions and zod are clearer.
  - Schema migration: Effect Schema would duplicate zod, which the MCP SDK and OpenCode's standard-schema already expect.
  - Effect 4 was still beta/rc in this lockfile.
- **Recommendation:** use Effect 4 (once stable) only in the CLI's I/O layer (action runner, subprocess, locks, retry) and the Pi supervisor. Keep core domain logic pure TypeScript + zod.

---

## 6. Risks and bugs

1. **A stale metadata lock bricks the store permanently.** `staleMs: Number.MAX_SAFE_INTEGER`, `shouldReclaim: () => false`, `staleRecovery: "fail-closed"` (`task-store.ts:873-889`). Reproduced: a lock file holding a dead pid makes every mutation return `recovery_required`, and `state.recover` returns `permission_denied`. No doctor check or command clears it; the user must delete `.workit/metadata.lock` by hand, which AGENTS.md forbids ("never edit it directly").
2. **Contention is reported as `recovery_required`.** `timeoutMs: 0, retries: 0` together with `lockFailure` mapping `EEXIST`/timeout to `recovery_required` (`task-store.ts:1062-1085`). Reproduced: three processes making 40 `task.progress` calls each got 83 of 120 `recovery_required` and only 36 ok. A lead and its subagent recording evidence at the same moment will hit this, and the bootstrap tells agents to treat it as a stop condition.
3. **Unbounded recovery growth.** See §3.4: `task-store.ts:1124-1151`, 818 MB here.
4. **Per-turn blocking work in the OpenCode host.** `experimental.chat.messages.transform` → `compactContextFor` → `listTasks()` + `task.inspect view:"full"` → `captureCandidate` (`opencode/src/runtime.ts:12-45`, `task-engine.ts:2346`) runs synchronously on every LLM request. It costs about 300 ms + 40 ms here and grows with history and repo size. `tool.execute.before` for `task` and `prepareDispatch` also call `listTasks()` (`v1/server.ts:209-211, 581`). Core has 84 `spawnSync`/`execSync` call sites, all of which block the host's event loop when run in-process.
5. **Unbounded walk in non-Git directories.** `captureCandidate` → `walk()` recursively reads and hashes every file (`task-evaluation.ts:132-153, 215-235`) with no file count, size or depth limit. A task started from `$HOME` or a non-Git monorepo directory with `node_modules` would hash the whole tree on every evidence and view call. The README says this behavior is intentional.
6. **Candidates stored in full on every change.** They make up 88% of the largest record (2.27 MB of 2.57 MB) and are re-serialized and fsynced on every mutation and copied into `recovery/` each time.
7. **Writer lease steal and stale leases.** `task-engine.ts:1984-1991` lets any lead overwrite another task's lease. Leases of dead sessions persist and block close and pause.
8. **YouTrack date off by one day** when the process TZ is east of UTC (`youtrack.ts:205-221`, reproduced). The configured timezone does not drive the epoch.
9. **A personal identity hard-coded in published packages.** `defaultMention: "<named colleague>"` (`youtrack.ts:157`, `init.ts:287`, `workit-cli/src/logic.ts:518-520`), the default timezone `America/Santiago` in 6 places, and `DEV_DEFAULT="${HOME}/Documents/projects/personal/workflow-toolkit"` in `scripts/sync-runtime.sh`.
10. **`state.recover` is advertised in every host's schema but cannot succeed anywhere.** The agent wastes turns on it.
11. **Duplicate tasks.** Two active tasks share an identical objective. `task.start` has no idempotency key; similarity is only checked in prose ("similar titles alone never merge tasks").
12. **Double zod parse** on every operation (`task-contract.ts:1119-1120`) and full-record validation on every read.
13. **Environment drift.** The local Bun 1.3.14 differs from the pinned 1.4.1 and nothing enforces `.node-version`, so `bun test` fails 35 tests on a default shell. CI is correct.
14. **Parity gaps.** Branch-policy denial is missing in Cursor and Pi. AGENTS.md's host table says Cursor Implementation is "native `subagentStart` assignment", while the README says implementer delegation is unavailable on Cursor.
15. **The MCP server cannot know the workspace for resources** ("resource URIs cannot supply a workspace", AGENTS.md). Cursor and Codex context reads depend on the launch `${workspaceFolder}` argument, which is wrong in multi-root workspaces.

---

## 7. Recommendations

### 7.1 Target architecture

```
packages/
  workit-core/        pure domain, no I/O side effects beyond an injected Store port
    model/            zod schemas (Task, Evidence, Decision, Finding, Worker) — typed requests, no `as any`
    policy/           small resolver: {riskTier, behaviorChange, productChoiceOpen, needsPlan} + project constraints → requirements
    eval/             requirement/evidence evaluation over candidate *digests* (store manifest once, content-addressed)
    store/            Store port + FsEventStore: .workit/tasks/<id>/events.jsonl (append-only) + snapshot.json cache;
                      O_APPEND writes, short retried lock with pid/TTL reclaim, no recovery/ dir (history = the log)
    hooks/            shared host-hook protocol: SessionStart context, PreToolUse(shell) branch policy, Subagent start/stop,
                      unfinished-task offer — one implementation, host adapters supply only field mapping
    bootstrap/        short invariant prompt + per-host addenda
  workit-cli/         THE deterministic surface the agent calls (any host, via shell):
                      workit task start|status|note|close        (idempotent by --key / branch)
                      workit check -- <cmd>                       (runs, records host_observed evidence + candidate digest)
                      workit review record|finding …
                      workit git branch|commit|push|pr|merge|delete-branch  (identity, conventions, expected-tip, SHA binding)
                      workit pr status --json                    (checks, failing log tails, threads, mergeability)
                      workit context <kind> --json
                      workit doctor|setup|upgrade                (moved out of core)
                      I/O layer in Effect 4 (subprocess, locks, retries, typed errors) once stable
  workit-mcp/         thin: exposes the same CLI verbs as tools for hosts without a shell; read-only resources
  workit-opencode/    plugin: hooks only (inject context, observe question answers, shell policy); tools = CLI verbs
  workit-claude-code/ NEW: .claude-plugin/plugin.json + marketplace.json, skills/, commands/ (wk-*),
                      hooks/hooks.json → shared core/hooks (SessionStart, PreToolUse(Bash), PostToolUse(AskUserQuestion)
                      for answer receipts, SubagentStart/SubagentStop, PreCompact), optional .mcp.json → workit-mcp;
                      ~300 LOC: the Codex hook already uses the same event names/fields (session_id, tool_input,
                      permission_mode, transcript_path) — generalize it rather than fork it
  workit-cursor/ workit-codex/ workit-pi/   thin manifests + field mapping onto core/hooks
skills/               keep 14 short skills; replace procedure text that duplicates CLI behavior with "run `workit …`"
```

Principles:
- The agent decides *what* and *whether*; the CLI does *how* and records *proof*.
- Evidence the CLI observed is `host_observed`; agent prose is a note, not evidence.
- Host-specific approval receipts become an optional enhancement. The CLI's `--confirm` + TTY path and the host's own permission prompt are the authority, as the docs already state.

### 7.2 Ranked backlog (value ÷ effort)

| # | Change | Value | Effort |
|---|---|---|---|
| 1 | **Fix the lock:** short timeout with retries for contention (return a retryable `busy` code, not `recovery_required`); reclaim when the pid is dead or the process start time differs; add `workit doctor --fix-lock` | High (unbricks users) | S |
| 2 | **Cap or stop recovery copies** (keep the last N=3 per record, or none) and add `workit gc` that prunes `recovery/` and dedupes candidates; remove `state.recover` from advertised schemas | High (818 MB here) | S |
| 3 | **Take hot paths off the OpenCode turn:** cache the compact context keyed by file mtime; don't run `captureCandidate` for context injection; index tasks (`index.json`: id, status, sessions, updatedAt) so `listTasks` doesn't parse full records | High | S–M |
| 4 | **Delete dead code:** OpenCode `tools/{docs-repo,rules,templates,youtrack}.ts` and most of `repo.ts`; core `docs-*`, `verify-*`, `repo-tool(s)`, `present`, `ports/`, `sync-runtime.ts`, `doc-render`, `triage*`, and their tests. Fix `knip.json` entries so knip guards this from now on | High (−3k LOC src, −15 test files) | S |
| 5 | **Timezone cleanup and YouTrack date fix;** remove the hard-coded mention, Santiago defaults and the dev path | Med | S |
| 6 | **`workit check -- <cmd>`** records host-observed evidence; make close gates accept only it (or a waiver) | Very high (makes the policy meaningful) | M |
| 7 | **`workit pr status --json`** + slimmer babysit and green-run skills | High | M |
| 8 | **Extract `core/hooks`** (one `unfinishedTaskOffer`, one session predicate, one shell-policy check), then build **`workit-claude-code`** on it; add branch-policy denial to Cursor and Pi | High | M |
| 9 | **Store candidates as content-addressed manifests** (`.workit/blobs/<digest>.json`) referenced by id; only diffs in the record | Med–High | M |
| 10 | **Shrink the assessment schema** to about 4 judgments plus constraints; flatten tool schemas so depth projection is unnecessary | High (fewer invalid_input loops) | M |
| 11 | **Expose managed git/PR verbs as CLI commands on every host** (identity check, expected-tip delete, SHA prebind); demote host receipt attestation to optional | High | M–L |
| 12 | **Retire `cutover`;** move `doctor`/`setup`/`upgrade` from core into the CLI so plugins and hooks stop bundling about 9k LOC | Med | M |
| 13 | **Append-only event-log store** replacing whole-record rewrite + recovery | Med–High | L |
| 14 | **Retire the OpenCode V1 adapter** once the 2.x floor is acceptable | Med | M |
| 15 | **Split tests:** `test` (domain, about 60 s) vs `test:packaging` (npm, packed artifacts, doctor); replace the exact Node version assertion with a major-version check; add a `.node-version` guard to `bun test` setup | Med | S |
| 16 | **Dependency refresh:** fs-safe 0.23 (re-verify lock semantics), MCP SDK 1.32, zod 4.6, OpenCode SDKs; plan for Pi 1.x | Med | S–M |
| 17 | **Adopt Effect 4** in the CLI I/O layer only, after it ships stable | Med | M |

Suggested order: 1 → 2 → 4 → 3 → 5 (one small PR each, about a week of work total), then 6 + 8 (the new shape), then 10/11/9/12/13.
