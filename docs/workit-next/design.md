
# workit 3.0, Phases 2–4: implementation design (S8–S18)

Base: `origin/main` @ `3507d7b` (S0 + S3 merged). Open Phase 1 branches I read: `bugfix/store-lock-reclaim` (adds `core/store-lock.ts`), `bugfix/bounded-recovery` (adds `TaskStore.collectGarbage`, `workit gc`), `bugfix/opencode-hot-path` (adds `core/session-context.ts`, `TaskStore.listTaskIndex`, `.workit/index.json`), `chore/tooling-refresh` (moves lint/format path lists into `.oxlintrc.json`/`.oxfmtrc.json`, rewrites CI), `chore/test-suite-cleanup` (folds route-denial into `test/workit-core/route-denial-parity.test.ts`).

I checked the Claude Code facts against the local binary, v2.1.288: the `claude plugin … --help` output, plus the zod schemas embedded in `~/.local/share/claude/versions/2.1.288`. I did not take the reference doc on trust.

---

## 0. Where the spec or plan is wrong, given the code (read first)

| # | Claim | Reality / fix |
|---|---|---|
| 1 | S8 says to "add branch-policy denial to Cursor **and Pi**" | Pi already has it: `packages/workit-pi/src/tools.ts:663` (`enforceNativeWriter` → `shellBranchPolicyViolation`), and the parity test covers it. Only **Cursor** is missing: `hooks-cursor.json` registers `beforeShellExecution`, but `handleCursorHook` returns `allow` for it. |
| 2 | `core/hooks` should handle "pre-compact" on Claude | Claude's `PreCompact` has **no `hookSpecificOutput`** (input is `trigger`, `custom_instructions`), so it cannot inject context. The restore path is `SessionStart` with `source:"compact"`. Claude `SubagentStart` output is **only `additionalContext`**, so it cannot block or bind a subagent. The reference doc's "permission config" claim is wrong. |
| 3 | `workit check -- <cmd>` alone makes gates meaningful | `workit check -- true` would also "pass". Gates must bind to **named checks** whose argv matches configured commands (§2.2). Ad-hoc checks are recorded but satisfy only ad-hoc requirements. |
| 4 | Evidence becomes "host_observed" | What we get is **CLI-observed**: the CLI saw the exit code. It is attributed to a session or agent only if a host hook attests it. Claude can attest via `PostToolUse` (its common input carries `session_id` and `agent_id` on subagent calls). Other hosts degrade to `attested:false`. Model this as `observer:"workit_cli"` + `attestation: {host, session, agentId} \| null`. |
| 5 | "Run ledger lives in `.workit/`" (D6), with implicit task per branch/worktree | Stacks, verdicts and branch tasks span worktrees (fanout implementers run in `isolation: worktree`), and they must outlive a removed worktree. `<cwd>/.workit` is per-checkout, and `git clean -fdx` deletes it (it is ignored). **Recommendation:** in git repos the store root is `$(git rev-parse --git-common-dir)/workit/`; non-git directories keep `<cwd>/.workit/`. This deviates from D6 and needs a user OK. |
| 6 | Forge = configured provider | `vcsConfig()` (`vcs-config.ts:150`) lets the workspace `vcs.provider` win over the origin host. Repos migrated from GitLab to GitHub under the `work` glob therefore misroute, which is why the `workit-github-override` skill exists. New verbs must derive the forge **from the push remote host**. If config disagrees, return `blocked` with an unblock hint. |
| 7 | Additive fields are safe | Every record schema is `.strict()`. Older hosts read the same store (OpenCode `@latest`, cached Cursor npx), and a new optional field in `evidenceSchema` makes them fail with `recovery_required`. S8 must ship reader tolerance (strip unknown keys on read, strict on write) **one release before** S9 writes new fields. Alternatively, release S8 and S9 in the same version and accept the window. | **Rule (S8a):** a new record field must be safe for an older reader to ignore and to lose on rewrite, **or** the writer lists its path in the record's top-level `critical` array; a reader that would strip a critical path fails closed with the upgrade message and never rewrites the record. Recovery never writes back a record it had to strip.
| 8 | `pr status` via gh porcelain | Local gh is **2.45.0**, and its `gh pr checks` has **no `--json`**. Use `gh api graphql` / `gh api` and `glab api` only. This matches the existing code (`remoteBranchTip`, `mergedBranch`) and does not depend on the CLI version. |
| 9 | Stack land: "PR 3 is retargeted" | With squash merges, retargeting **forces a restack**: `git rebase --onto <trunk> <oldParentTip>`, then push `--force-with-lease`. That changes the head SHA and re-triggers CI. Patch-id carry-over keeps the *verdict*, not CI. Only a merge-commit strategy can retarget without a restack. |
| 10 | Codex adapter is reusable for Claude | `parseCodexHookInput` rejects **unknown keys** and denies `PreToolUse` on a parse error. A Codex release that adds a field would therefore deny every tool call (a latent bug). Claude sends extra keys (`prompt_id`, `agent_id`, `agent_type`, `mcp_server`, …). All parsers must be lenient on unknown keys and strict only on required ones. |
| 11 | Cursor hooks are fine | Every Cursor hook spawns `npx -y --prefer-online …@latest` per event, so there is a registry round-trip on each shell command. That is out of scope here, but the descriptor should flag it, and `doctor` should suggest a local install. | **Follow-up:** the Cursor hook answers `{permission:"allow"}` for compliant shell commands and pre-tool calls (pre-existing). Verify against a live Cursor whether `allow` skips Cursor's own approval prompt; if it does, answer with no permission instead.
| 12 | Host authority suffices (D2) | A user who allowlists `Bash(workit *)` makes `workit pr merge` silent. **Grants are the real ceiling.** They must live only in user config (`~/.config/workit/workspaces.json`), never in a repo file, and must not be settable headless. Docs should recommend allowlisting read verbs only. |
| 13 | `hostSchema` | `task-contract.ts:80` has no `claude_code`. Add it in S8, not S14, so S14 does not touch the contract. |
| 14 | S2b (engine revision retry) | It is in the plan but has no branch yet. S9's `observeCheck` and the hooks must not surface `revision_conflict`, so S2b is a hard prerequisite for S9. |
| 15 | `claude plugin eval` as a CI gate | It needs a Claude credential, costs money (`--max-cost-usd`), and is nondeterministic (default 3 runs, LLM judges). Make it a nightly or label-gated job. Make deterministic hook-fixture tests plus `claude plugin validate --strict` the PR gate. |
| 16 | `<package>@npm` direct install | The binary contains "Installing plugins straight from an npm registry … is not enabled for this account", so it is gated. The reliable route is a git-hosted marketplace whose entry has `source: {source:"npm", package}`. |

---

## 1. S8: `core/hooks`, the shared host-hook protocol

### 1.1 Layout (new: `packages/workit-core/src/hooks/`)
```
hooks/protocol.ts     types below (no I/O)
hooks/handle.ts       handleHook(input, deps): HookDecision  (the one implementation)
hooks/context.ts      sessionContextText(), unfinishedOffer()  ← moves hot-path's core/session-context.ts here
hooks/policy.ts       shellPolicy(cwd, command) wraps route-intent.shellBranchPolicyViolation
hooks/descriptor.ts   HostDescriptor type + capabilitiesFor(desc): Capability[]  (bridge to engine until S17)
hooks/hosts/{claude-code,codex,cursor,opencode,pi}.ts   parse<Host>(raw) / render<Host>(decision) + DESCRIPTOR
hooks/run.ts          runHookProcess(host, stdin, stdout): Promise<number>  (stdin→parse→handle→render, fail policy)
```
Add a package export `"./hooks": "./src/hooks/index.ts"`. Hook bundles then import only `hooks/*` + store reads, not the `core.ts` barrel, which drags in doctor, setup and cutover (today each hook bundle is about 1 MB). Target bundle size is ≤300 KB. Startup budgets: SessionStart <300 ms, PreToolUse <60 ms.

### 1.2 Types
```ts
export type HostId = "claude_code"|"opencode"|"codex_cli"|"codex_desktop"|"cursor"|"pi";
export type Session = { id: string; agentId: string|null; agentType: string|null; parentId: string|null };
export type HookEvent =
  | { kind: "session.start"; source: "startup"|"resume"|"clear"|"compact"|"fork" }
  | { kind: "context.turn" }                                   // per-turn injection (OpenCode session.context, Pi before_agent_start, Claude UserPromptSubmit)
  | { kind: "shell.pre"; command: string; toolUseId: string|null }
  | { kind: "shell.post"; command: string; stdout: string; exitCode: number|null; toolUseId: string|null } // attestation
  | { kind: "subagent.start"; agentId: string; agentType: string; task: string|null }
  | { kind: "subagent.stop"; agentId: string|null; agentType: string|null; lastMessage: string|null; stopHookActive: boolean }
  | { kind: "prompt.submit"; prompt: string; source: string|null }
  | { kind: "compact.pre"; trigger: "manual"|"auto" }
  | { kind: "stop"; lastMessage: string|null; stopHookActive: boolean };
export type HookInput = { host: HostId; cwd: string; session: Session; permissionMode: string|null;
                          transcriptPath: string|null; event: HookEvent };
export type HookDecision =
  | { kind: "none" }
  | { kind: "context"; text: string }                       // additionalContext
  | { kind: "deny"; reason: string; unblock: string|null }  // reason text always ends with the unblock command (principle 3)
  | { kind: "continue"; reason: string }                    // Stop/SubagentStop: keep working
  | { kind: "notice"; userMessage: string };
export type HookDeps = { store: (cwd: string) => TaskStoreLike; now: () => string; descriptor: HostDescriptor; env: NodeJS.ProcessEnv };
export function handleHook(input: HookInput, deps: HookDeps): HookDecision;
export type HostAdapter = { parse(raw: unknown): {ok:true; input: HookInput}|{ok:false; error:string; event: HookEvent["kind"]|null};
                            render(d: HookDecision, e: HookEvent["kind"]): {stdout: string; exitCode: number} };
```
Fail policy, decided centrally in `run.ts`:
- `shell.pre` parse or handler error: deny only if the descriptor's `failClosedShell` is true (Cursor `failClosed`); otherwise `none` plus a stderr diagnostic. A broken hook must not brick the host. This deliberately reverses today's Codex deny-on-parse-error.
- Every other event fails open.

Behavior in S8 (no model change):
- `session.start` / `context.turn` emit `<workit-contract>` + bootstrap addendum + task context + history offer, reusing hot-path's `sessionCompactContext` / `unfinishedTaskOffer`.
- `shell.pre` applies branch policy.
- `subagent.start` emits read-only context. Cursor keeps its worker-assign path behind a descriptor flag.
- `stop`, `prompt.submit` and `shell.post` are no-ops until S9/S15.

### 1.3 Host mapping

| Protocol | Claude Code (`hooks/hooks.json`) | Codex (`workit-codex/hooks/workit-hook.ts`) | Cursor (`workit-cursor/hooks/workit-hook.ts`) | OpenCode V2 (`src/v2/plugin.ts`) | Pi (`extensions/workit.ts`) |
|---|---|---|---|---|---|
| session.start | `SessionStart` (matcher `startup\|resume\|clear\|compact`) → `hookSpecificOutput.additionalContext`; also append `export WORKIT_HOST=claude_code WORKIT_SESSION_ID=…` to `$CLAUDE_ENV_FILE` | `SessionStart` → `additionalContext` | `sessionStart` → `additional_context` | n/a (per-turn) | `session_start` |
| context.turn | `UserPromptSubmit` → `additionalContext`, only when the task revision changed (cache in `${CLAUDE_PLUGIN_DATA}/ctx/<session>.json`; each hook is a new process, so the in-memory cache in `session-context.ts` is useless) | undocumented → none | none | `session.hook("context")` → `injectAgentContext` | `before_agent_start` → `{message}` |
| shell.pre | `PreToolUse` matchers `Bash` (`"if":"Bash(git *)"`) and `PowerShell` (`"if":"PowerShell(git *)"`, Windows) → `permissionDecision:"deny"`, `permissionDecisionReason`. **Never emit `allow`**: it would bypass the user's permission prompt | `PreToolUse` (bash/unified-exec) → deny | `beforeShellExecution` → `{permission:"deny",agent_message}`, exit 2 (**new**) | `permission.hook("evaluate")` → `event.effect="deny"` (`v2/permissions.ts`) | `tool_call` bash → `{block,reason}` (exists) |
| shell.post | `PostToolUse` matcher `Bash`, `"if":"Bash(workit *)"`, input has `tool_response` + `agent_id` | undocumented | undocumented | `tool.execute.after` (bash) | `tool_result` |
| subagent.start | `SubagentStart` (`agent_id`,`agent_type`) → `additionalContext` only | `SubagentStart` | `subagentStart` (can deny) | `tool.execute.before` tool=`subagent` | n/a (supervisor) |
| subagent.stop | `SubagentStop` (`agent_transcript_path`, `last_assistant_message`) → `decision:"block"` + `reason` to continue | `SubagentStop` | `subagentStop` (no stable id) | `tool.execute.after` | worker protocol |
| compact.pre | `PreCompact` → none (restore via SessionStart compact) | n/a | `preCompact` → `user_message` | `session.hook("compaction")` → append context | `session_before_compact` |
| stop | `Stop` → top-level `{"decision":"block","reason":…}` (guard `stop_hook_active`) | undocumented | undocumented | `session.idle` event (partial) | none |

Verified from the 2.1.288 binary:
- Common input: `session_id, transcript_path, cwd, prompt_id?, permission_mode?, agent_id?, agent_type?`.
- `SessionStart.source` ∈ `startup|resume|clear|compact|fork`.
- Command hooks support exec form `{"type":"command","command":"node","args":[…]}` (with `${CLAUDE_PLUGIN_ROOT}` substituted per element), plus `if`, `timeout`, `async`, `asyncRewake`, `once`, `statusMessage`.
- Output events: `PreToolUse` {permissionDecision, permissionDecisionReason, updatedInput, additionalContext}, `SessionStart` {additionalContext, initialUserMessage, sessionTitle, watchPaths, reloadSkills}, `UserPromptSubmit` {additionalContext, sessionTitle}, `SubagentStart` / `Stop` / `SubagentStop` {additionalContext}.
- `CLAUDE_ENV_FILE` exists.

Do **not** rely on `updatedInput` without `allow` for provenance stamping; its semantics are unverified. Use `shell.post` attestation (§2.2).

### 1.4 Capability descriptor (GSD-style; replaces `codexCapabilities`, `cursorCapabilities`, `piCapabilities`, and OpenCode's inline array)
```ts
type Support = "native"|"partial"|"none"|"undocumented";        // undocumented ⇒ treated as none (fail-closed)
export type HostDescriptor = {
  host: HostId; verifiedAgainst: string /* "claude 2.1.288" */; docs: string[];
  transport: "hook-process"|"in-process-plugin";
  events: Record<HookEvent["kind"], { support: Support; native: string|null }>;
  shellPolicy: { deny: Support; channel: "permissionDecision"|"exit2+json"|"effect"|"block"|null; failClosed: boolean };
  context: { sessionStart: Support; perTurn: Support; afterCompact: Support };
  subagents: { identity: Support; parentBinding: Support; blockStart: Support; worktreeIsolation: Support; maxConcurrency: number|"undocumented" };
  provenance: { sessionId: Support; agentIdOnTool: Support; postToolObserve: Support };
  stopControl: Support; shellAvailable: Support; perEventCost: "low"|"npx-network";
};
export const effective = (d: HostDescriptor) => ({ canDenyShell: d.shellPolicy.deny==="native", attest: d.provenance.postToolObserve==="native",
  fanoutConcurrency: typeof d.subagents.maxConcurrency==="number" ? d.subagents.maxConcurrency : 1, … });
export const capabilitiesFor = (d: HostDescriptor): Capability[];   // keeps task-engine OperationContext API until S17
```
Every `native` value carries a citation (docs URL or the binary/version it was verified against). Golden test: `test/workit-core/hooks/descriptor.test.ts` snapshots each descriptor and asserts that `undocumented` never yields an `enforced` capability.

### 1.5 S8 file changes
- New: `packages/workit-core/src/hooks/**`.
- Modify:
  - `task-contract.ts` (`hostSchema += "claude_code"`; reader tolerance per §0 #7)
  - `workit-codex/hooks/workit-hook.ts` (→ ~30 lines: `runHookProcess("codex_cli"|…)`)
  - `workit-cursor/hooks/workit-hook.ts` (field mapping + keeps `handleSubagentStart` worker assignment as a Cursor-only branch)
  - `workit-opencode/src/v2/{injection,permissions}.ts`, `src/runtime.ts`
  - `workit-pi/src/context.ts`
  - `knip.json`
- Tests:
  - extend `route-denial-parity.test.ts` with Cursor and Claude rows
  - new `test/workit-core/hooks/{protocol,claude-code,lenient-parse}.test.ts`
  - fixtures in `test/fixtures/hooks/<host>/*.json` (real captured payloads)

---

## 2. CLI verbs (S9–S13)

### 2.0 Shared conventions
- **Router (S9a):** `packages/workit-cli/src/main.ts` becomes the lean entry, and `index.tsx` keeps only the wizards, lazy-imported for `init`/`uninstall`. Ink and React must not load for verbs. `src/verbs/<verb>.ts` exports `run(argv, io): Promise<number>`, and `verbs/registry.ts` maps names to modules. Pre-create stubs for all S9–S13 verbs (they print "not implemented", exit 2) so parallel slices touch only their own file. Families (`task`, `evidence`…) keep routing to `task.ts` until S17. Collision: `workit task` already exists, so the new `task status|note|close` lands in S15.
- **Envelope (`--json`)**: `{"ok":bool,"code":"ok|failed|blocked|busy|invalid_input|unavailable|not_found|pending","data":{…},"error"?:string,"unblock"?:string}`. Human output is the default.
- **Exit codes:** 0 ok · 1 failed (check red, CI red) · 2 usage · 3 blocked (grant, policy or identity; `unblock` names the exact command or user action) · 4 busy/pending (retryable) · 5 unavailable (gh/glab missing or unauthenticated).
- **Global flags:** `--json`, `--cwd <dir>`. CLI lock timeout stays at 2 s (`setDefaultLockTimeout(2_000)` from S1).
- **New core modules** (pure, plain TS):

  `core/src/git/rev.ts`
  ```ts
  headSha(cwd):string; worktreeTree(cwd):{tree:string;dirty:boolean}   // temp GIT_INDEX_FILE + `git add -A` + `git write-tree`; no ref change
  mergeBase(cwd,a,b):string; patchId(cwd, base, head):string|null       // `git diff base...head | git patch-id --stable`
  remoteTip(cwd, remote, branch):string|null                            // `git ls-remote`
  ```
  `core/src/forge/`, extracted from `external-action-effects.ts:601-925` (`remoteRepo`, `remoteProvider`, `hostingCliEnv`, `hostingProvider`, `remoteBranchTip`, `mergedBranch`, the PR-listing parse in `readHostingAction`), `pr-create.ts` (`pushRemote`, `pushRemoteIdentity`, `safePushUrl`, `pushTargetIsStable`, `prCreate`, `mergePr`, `cliRepository`) and `vcs-config.ts` (`vcsCliIdentity`, `hostingApiHostMatches`). The old call sites re-import from `forge/` until S16 deletes them.
  ```ts
  export type ForgeKind = "github"|"gitlab";
  export function resolveForge(cwd: string): Result<Forge>;   // from push remote host; vcs.json hosts for GHE/self-hosted; mismatch with workspace provider ⇒ blocked
  export interface Forge {
    kind: ForgeKind; apiHost: string; repo: string /* owner/name or group/proj */;
    identity(): Result<{ login: string; expected: string|null; matches: boolean|null }>;
    findPr(head: string): Result<PrRef|null>;   prStatus(n: number): Result<ForgePrStatus>;
    jobLogTail(job: JobRef, lines: number): Result<string[]>;  rerun(t: { runId?: number; jobId?: number; failedOnly: boolean }): Result<void>;
    createPr(i: { head: string; base: string; title: string; body: string; draft: boolean }): Result<PrRef>;
    updateBase(n: number, base: string): Result<void>;
    merge(n: number, o: { sha: string; method: "squash"|"merge"|"rebase"; deleteBranch: boolean }): Result<{ mergeSha: string }>;
  }
  ```
  GitHub endpoints:
  - `gh api graphql` for `pullRequest{state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefOid,reviewDecision,reviewThreads(first:100){nodes{id,isResolved,isOutdated,path,line,comments(first:1){nodes{author{login,__typename},body,url}}}},commits(last:1){nodes{commit{statusCheckRollup{state,contexts(first:100){nodes{…on CheckRun{name,status,conclusion,detailsUrl,databaseId,checkSuite{workflowRun{databaseId}}} …on StatusContext{context,state,targetUrl}}}}}}}}`
  - log tail: `gh api repos/{r}/actions/jobs/{id}/logs`
  - rerun: `POST …/runs/{id}/rerun-failed-jobs`
  - merge: `PUT …/pulls/{n}/merge -f sha=<head>` (atomic head guard)
  - retarget: `PATCH …/pulls/{n} -f base=`

  GitLab endpoints:
  - `glab api projects/:id/merge_requests/:iid` (`detailed_merge_status`, `has_conflicts`, `diverged_commits_count`, `head_pipeline`)
  - `…/pipelines/:pid/jobs?scope[]=failed`, `…/jobs/:id/trace`
  - `…/merge_requests/:iid/discussions` (`resolvable`/`resolved`)
  - retry: `POST …/jobs/:id/retry`
  - merge: `PUT …/merge_requests/:iid/merge?sha=…&squash=…`
  - retarget: `PUT …/merge_requests/:iid target_branch=`

  Behind-base is computed locally (fetch, `rev-list --count`, `merge-base --is-ancestor`), so it is forge-neutral. Parity tests run against fake `gh`/`glab` on PATH that replay `test/fixtures/forge/{github,gitlab}/*.json`.
- **Identity:** `forge.identity()` = `gh api user` / `glab api user` (the credential actually used) vs the workspace `vcs.account`.
  - Mismatch → `blocked` with unblock `gh auth switch -u <account>` / `glab auth login`.
  - No configured account: read verbs pass. Push, pr and merge return `blocked` if the workspace has any autonomy grant, because grants require an account. This prevents the work/personal mix-up that the existing `github-backend` workspace (no `account`) is exposed to.

### 2.1 Grammar and outputs

**S9 `workit check`**
```
workit check <name> [--json] [--timeout 600]            # runs configured command (checks config)
workit check [--name <n>] [--stream] [--json] -- <cmd…> # ad-hoc
```
Check config is resolved in this order: `.workit/checks.json` → package.json scripts (`test`, `lint`, `typecheck`, `check`) → none. Shape: `{"checks":{"test":"bun test","lint":"bun run lint"}}`, committed in the repo and visible in review.

The exit code mirrors the child's (or 4 on timeout). On failure it prints the last 80 lines; on success, nothing. The full log goes to `<store>/blobs/logs/<sha256>.log`.
```json
{"ok":false,"code":"failed","data":{"evidenceId":"…","name":"test","argv":["bun","test"],"configured":true,"exitCode":1,
 "durationMs":5321,"head":"<sha>","tree":"<tree-sha>","dirty":true,"base":"origin/main","patchId":"<id>|null",
 "logDigest":"sha256:…","logRef":"blobs/logs/<sha>.log","logTail":["…"],"task":{"id":"…","key":"feature/x","created":false},
 "satisfies":[],"stillUnsatisfied":[{"requirement":"tests","unblock":"workit check test"}],"attested":false}}
```
Pre-S15 engine integration:
- `WorkitCore.observeCheck(input: CheckObservation): Result<Entry<Evidence>>` is a host-only method, like `observeDecision`. It records `provenance.kind:"host_observed"`, `host:"workit_cli"`, and an optional `observation` field on evidence (additive; see §0 #7).
- `task-evaluation.evaluateRequirements`: `testing`/`verification` requirements accept only `kind:"check"` with `provenance.kind==="host_observed"`, `observation.configured===true`, exit 0, and `observation.tree === currentTree`. Otherwise an `accepted_limitation` waiver.
- `task-engine.ts:1114` (`evidence.record`) keeps agent-reported checks as notes only. RED-first (`task-evaluation.ts:557-591`) becomes advisory (`status.redFirst:false`), not a gate.
- Implicit task seam: `implicitTaskFor(store, cwd, actor): Result<{id; created}>`. Before S15 it attaches to the single active task bound to this branch, or starts one (`objective: "Branch <name>"`, scope `.`). S15 reimplements it.

Attestation (Claude-native):
- The CLI prints a marker line `workit:evidence <id> <nonce>`, and the nonce is also stored in the event.
- `PostToolUse` (`if: Bash(workit *)`) → `shell.post` → `attestEvidence({id, nonce, session, agentId, toolUseId})`, which appends `check.attested`.
- On hosts without `postToolObserve`, `attested:false` stays.

**S10 `workit pr status`**
```
workit pr status [--pr <n> | --branch <b>] [--log-lines 60] [--json]
```
```json
{"forge":"github","repo":"o/r","number":12,"url":"…","state":"open","draft":false,"base":"main",
 "head":{"branch":"feature/x","sha":"…","localSha":"…","pushed":true},
 "mergeable":"yes|no|unknown","conflicts":false,"behindBase":{"behind":3,"ahead":5,"baseSha":"…","upToDate":false},
 "checks":{"state":"failing|pending|passing|none","failing":[{"name":"ci / test","url":"…","runId":1,"jobId":2,"conclusion":"failure","logTail":["…"],"rerunsOnHead":0}],"pending":["lint"]},
 "reviews":{"decision":"review_required","unresolvedThreads":[{"id":"…","path":"a.ts","line":10,"author":"x","isBot":false,"url":"…","body":"≤300 chars, untrusted data"}]},
 "next":"RESOLVE_CONFLICTS|REBASE|RESOLVE_THREADS|FIX_CI|WAITING_CI|READY|MERGED|CLOSED"}
```
`next` uses the pstack priority: conflicts > behind (only if required by branch protection) > threads > CI. S12 adds a `verdict` block via the ledger.

**S10 `workit ci wait|rerun`**
```
workit ci wait  [--pr <n>] [--head <sha>] [--timeout 20m] [--interval 30s] [--json]   # exit 0 pass /1 fail /4 pending at timeout; final payload = pr status
workit ci rerun [--pr <n>] [--check <name>…|--failed] --reason flake|infra [--force] [--json]
```
`ci rerun` allows once per (pr, head, check) without `--force` and records a `ci.rerun` ledger row; the agent classifies flake vs real. In skills on Claude, tell the agent to run `ci wait` with `run_in_background: true` (no second sleep loop).

**S11 `workit git`**
```
workit git branch <name> | --kind feature|bugfix|hotfix --slug <s>  [--base <b>] [--carry]
workit git commit -m <msg> [--all | -- <paths…>]
workit git push [--force-with-lease]        # lease always computed by the CLI from the recorded remote tip
```
- `git branch` reuses `validateBranchNamePolicy` / `validateBranchNameFor`, `resolveBranchPolicyFor`, `classifyBranchDirt` and `ensureBaseBranch`. It fetches and branches from `origin/<base>`, where base = stack parent or `vcsConfig("resolve").defaultTargetBranch`. Output: `{branch, base, baseSha}`.
- `git commit` reuses `validateCommitMessageFor` and `detectCommitFlavor`. It refuses protected branches. Output: `{sha, branch, files, message}`, and it appends `commit.recorded{sha, session, agentId}`, the author identity used for verifier ≠ author.
- `git push` checks forge identity, `isProtectedTarget`, `pushTargetIsStable` and the `push` grant. After pushing it checks `remoteTip == HEAD` and records `delivery{kind:"push"}`. Output: `{remote, branch, sha, delivered:true}`.

**S11 `workit pr create|merge`**
```
workit pr create [--base <b>] [--title <t>] [--body-file <f>] [--draft] [--json]   # idempotent: existing open PR ⇒ ok, created:false
workit pr merge  [--pr <n>] [--method squash|merge|rebase] [--delete-branch] [--json]
```
- `pr create` reuses the `prBuildBody`/`buildBody` template logic as typed input, not via env vars. It requires the `pr` grant and post-verifies `head.sha` equals the pushed SHA.
- `pr merge` requires the `merge` grant. `merge:"verified"` additionally requires `checks.state==passing`, no conflicts, no unresolved threads, and a verdict valid at head (S13). It merges with the head SHA guard and records `delivery{kind:"merge", mergeSha}`.
- Denial: `{"ok":false,"code":"blocked","error":"grant_required: merge is not granted for workspace \"work\"","unblock":"ask the user to run: workit grant set work merge=verified"}`.

**S11 `workit verify-delivery`** (read-only, records `delivery` evidence)
```
workit verify-delivery push    [--branch b] [--sha s]
workit verify-delivery pr      [--pr n] [--sha s]            # provider head == sha
workit verify-delivery merge   [--pr n]                      # merged_at set and mergeSha reachable from origin/<base> after fetch
workit verify-delivery release --tag vX [--package @scope/p@X]   # ls-remote tag; npm view <p>@<v> version/gitHead
→ {"delivered":bool,"observations":[{"kind":"remote_tip","expected":"…","observed":"…","ok":true}]}
```

**S12 `workit stack`**
```
workit stack plan [--trunk main] [<branch>…] [--json]         # no mutation
workit stack sync [--push] [--create-prs] [--json]            # restack + lease push + retarget + missing PRs
workit stack land [--dry-run] [--max <n>] [--json]
```
- **Representation:** forge PR bases plus git ancestry are the truth. `<store>/stacks/<name>.json` is a reconstructible cache:
  `{v:1,name,trunk,forge,repo,branches:[{branch,parent,pr,lastHead,lastParentHead,patchId}],updatedAt}`. The default name is the root branch, and `lastParentHead` drives `git rebase --onto <parentTip> <lastParentHead> <branch>`.
- **sync:** goes in order. On conflict it stops with `{"code":"blocked","data":{"conflict":"feature/b"},"unblock":"resolve, git rebase --continue, then workit stack sync"}`.
- **land:** walk from the root.
  - PR_i qualifies if: open; base == trunk (after retargeting); verdict valid at head (exact SHA, or patch-id equal ⇒ `carried`); checks passing **on the current head**; no conflicts or unresolved threads; and the merge grant allows it.
  - Merge PR_i with the SHA guard. Then for PR_{i+1}: `updateBase(trunk)`, restack onto trunk, lease push, compare patch-id (carry the verdict or mark it stale), `ci wait`, then re-evaluate.
  - Stop at the first non-qualifying PR. That PR is still retargeted and restacked so it sits on trunk.
  - Output: `{landed:[{pr,mergeSha}],stoppedAt:{pr,reason,unblock},retargeted:[pr]}`.
  - Never arm descendants (no auto-merge). Recompute after each merge.

**S13 `workit ledger` / `workit handoff`**
```
workit ledger decision "<what>" --why "<why>" [--ref <path|url>…]
workit ledger ruling   "<what>" --why "<why>" --cost-if-wrong "<…>"
workit ledger verdict  verified|tests-verified|type-check-only|blocked|failed [--pr n|--branch b] --how "<method/evidence>" [--surface ui|cli|api] [--self]
workit ledger list  [--pr n] [--type verdict|decision|ruling|ci.rerun] [--json]
workit ledger check --pr n   → {"valid":bool,"basis":"fresh|carried|stale|none","verdict":{…},"head":"…","patchId":"…"}
workit handoff [--json]      → resume brief: branch/task/endpoint, checks vs current tree, open findings, rulings, stack position, pr next, one "next command"
```
- Storage: `<store>/ledger/ledger.jsonl`, append-only, repo-wide, one O_APPEND write per row (≤4096 bytes; an advisory lock on network filesystems). A row is `{v,id,at,type,actor:{host,session,agentId},pr?,branch,head,base,patchId,diffHash,…}`. As built (S13), rows carry a random `id`, not a stored `seq`: a lock-free appender cannot allocate one, so `seq` is the row's position on read. A superseding row references the older row's `id`, and only a row of the same type from the same session may supersede it (D18).
- A verdict is refused (`blocked`) when `actor.session` ∈ authors(branch), where authors = the sessions in `commit.recorded` + `task.opened`. `--self` records a `self` label that `merge:"verified"` does not accept.
- Validity (D18): `head == current head` (verdicts on a dirty worktree are refused) → fresh. `patchId` **and** `diffHash` (sha256 of the exact, whitespace-sensitive `base...head` diff minus line positions) equal → carried. Otherwise stale. `ledger check` returns `current` (basis) and `accepted` (current, passing, independent, no current independent failure); merge gates read only `accepted`. `--pr` resolves only through the CLI's own PR rows or a fetched forge ref.
- `handoff` replaces the export/import ceremony, because the store in the common dir is shared across worktrees. The existing `workit handoff --task` stays until S15.

### 2.2 How evidence is keyed
- Each check or verdict stores `head` (HEAD SHA), `tree` (worktree tree, including dirty files, from a temp index), `base` + `patchId` (`git diff merge-base..head | git patch-id --stable`), and `dirty`.
- Fresh means `tree == current tree`. Carried (verdicts only) means `patchId` is equal after a rebase. CI is always re-observed.
- This replaces candidate capture: full per-file snapshots are 88% of the bloat. Non-git dirs keep a bounded manifest digest stored once as `blobs/<digest>.json`.

---

## 3. S14: `packages/workit-claude-code`

```
packages/workit-claude-code/
  .claude-plugin/plugin.json      {"name":"workit","displayName":"Workit","version":"<synced>","description":"…","author":{"name":"BrainerVirus"},
                                   "repository":"https://github.com/BrainerVirus/workit","license":"MIT","keywords":[…]}   (no component overrides; defaults scan)
  hooks/hooks.json
  bin/workit                      #!/bin/sh shim → dev: `exec bun "$ROOT/../workit-cli/src/main.ts" "$@"` when ../workit-core/src exists; else `exec node "$ROOT/dist/workit.js" "$@"`
  bin/workit-hook                 same pattern → src/hook.ts | dist/workit-hook.js
  src/hook.ts                     import { runHookProcess } from "@brainervirus/workit-core/hooks"; process.exitCode = await runHookProcess("claude_code", …)
  agents/{verifier,reviewer,implementer}.md
  skills/                         GENERATED (gitignored): from workit-core/skills, renamed workit-x → x (=> /workit:review), host tool refs injected
  evals/<case>/{case.yaml|prompt.md, graders/*.md}
  scripts/build.ts                bun build src/hook.ts → dist/workit-hook.js; workit-cli/src/main.ts → dist/workit.js; copy+transform skills
  package.json                    "@brainervirus/workit-claude-code", files: [".claude-plugin","hooks","bin","agents","skills","dist","README.md"]
.claude-plugin/marketplace.json   (repo root, beside .cursor-plugin/ and .agents/plugins/)
```
`hooks/hooks.json` (exec form, absolute plugin paths; `bin/` is on PATH for the **Bash tool**, as the binary confirms, but that is not guaranteed for hooks):
```json
{"hooks":{
 "SessionStart":[{"matcher":"startup|resume|clear|compact","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":10}]}],
 "UserPromptSubmit":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]}],
 "PreToolUse":[{"matcher":"Bash","if":"Bash(git *)","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]},
               {"matcher":"PowerShell","if":"PowerShell(git *)","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]}],
 "PostToolUse":[{"matcher":"Bash","if":"Bash(workit *)","hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]}],
 "SubagentStart":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]}],
 "SubagentStop":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]}],
 "Stop":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/bin/workit-hook","timeout":5}]}]}}
```
Root `.claude-plugin/marketplace.json`:
```json
{"name":"workit","owner":{"name":"BrainerVirus"},"plugins":[{"name":"workit","description":"…","source":{"source":"npm","package":"@brainervirus/workit-claude-code"}}]}
```
Do not put a version in the entry: `claude plugin tag` and `validate` reject plugin.json/entry disagreement, and plugin.json carries the synced version. The npm `version` field defaults to the latest dist-tag.

**Agents** (frontmatter):
- `verifier`: `tools: Read, Grep, Glob, Bash`; `disallowedTools: Write, Edit`. Its body tells it to run `verify-<app>` if present and record `workit ledger verdict`.
- `reviewer`: read-only plus `workit pr status`, `git diff`. It records findings and rulings.
- `implementer`: `isolation: worktree`. Its body requires a brief (goal/scope/acceptance/verify/forbidden/report) and uses `workit git branch|commit`.

Plugin subagents may ignore `hooks`/`mcpServers`/`permissionMode` frontmatter, so don't use them, and confirm with `validate --strict`. Note: `isolation: worktree` worktrees are created by Claude with its own branch naming, which may violate branch policy. The implementer brief must run `workit git branch` first.

**MCP:** ship **no** `.mcp.json` by default. Claude has a shell, and tool schemas cost resident tokens. Document opt-in via user settings pointing at `workit-mcp`.

**Install modes:**
- **Local pin:** `claude --plugin-dir packages/workit-claude-code` (in a worktree). The shims detect the monorepo and run TS from source with bun, so no build is needed and the "don't rebuild a pinned checkout" rule holds. Skills need `bun packages/workit-claude-code/scripts/build.ts --skills-only`, or the dev build symlinks `skills/` to the generated output.
- **Latest:** `claude plugin marketplace add BrainerVirus/workit` → `claude plugin install workit@workit` → update via `claude plugin update workit@workit` (auto-update is off by default).

`workit doctor` (CLI) reports which `workit` resolves on PATH vs the plugin bundle version (skew warning). Plugin `bin/` PATH precedence is undocumented.

**Release:** add the package to:
- `release.config.cjs` (`@semantic-release/npm` bumper)
- `sync-release-manifests.ts` `SYNC_MANIFEST_PATHS` (+ `packages/workit-claude-code/.claude-plugin/plugin.json`)
- `publish-changed-packages.ts`
- `.oxlintrc.json` / `.oxfmtrc.json` paths (after S7)
- `knip.json`

**CI** (`.github/workflows/ci.yml` after S7):
- **PR gate:** `bun packages/workit-claude-code/scripts/build.ts $RUNNER_TEMP/cc` → `npx @anthropic-ai/claude-code plugin validate --strict --json $RUNNER_TEMP/cc` and `plugin validate --strict .` (marketplace) → `bun test test/workit-claude-code` (hook fixtures piped through `bin/workit-hook`; asserts JSON shape and exit codes).
- **Nightly or label `eval`:** `claude plugin eval $RUNNER_TEMP/cc --trust-plugin --runs 1 -j 2 --max-cost-usd 2 --threshold 0.8 --no-publish --json results.json`, with `ANTHROPIC_API_KEY` from secrets.
- **Eval cases:**
  - `pin-skills-load` (grader `tool_used: Skill`)
  - `check-records-evidence` (scaffold repo, prompt "run the tests via workit"; regex on `workit:evidence`)
  - `branch-policy-deny` ("create branch main" → regex `branch_policy_denied`)
  - `no-spec-for-one-line-fix` (regex `not_contains: spec.md`)

---

## 4. S15–S17: model simplification

### 4.1 S15: implicit task and event store
- Store root: `storeRoot(cwd)` = git ? `<git-common-dir>/workit` : `<cwd>/.workit` (§0 #5).
- `resolveTaskKey(cwd): {root, key, branch|null, worktree}`. The key is the branch name if attached, `detached-<hash(worktree)>` otherwise, and `dir-<hash(cwd)>` outside git.
- Layout: `tasks/<key-slug>/{events.jsonl, snapshot.json, lock}`, `tasks/<key-slug>/archive/<taskId>.jsonl` (closed), `ledger.jsonl`, `stacks/`, `blobs/`, `legacy/`.
- Event: `{v:1,seq,at,id(ulid),task,actor:{host,session,agentId},attested,type,data}`. Types: `task.opened|noted|endpoint_set|judged|closed|reopened`, `check.ran|attested`, `finding.recorded|resolved`, `decision.recorded`, `worker.started|stopped`, `commit.recorded`, `delivery.verified`, `waiver.recorded`, `migrated.from_v2`.
- Write: take the per-task lock (generalize S1's `lockPathFor(root)` → `lockPathFor(dir)`), read the last seq, write one line with `O_APPEND`, fsync. Recovery is just truncating a torn trailing line on the next locked append. There is no recovery dir. Contention → `busy`.
- Snapshot: `{v,seq,byteOffset,state}` via atomic rename every 50 events and on close. On read: validate offset/seq, then replay the tail. If the snapshot is bad, replay fully.
- `reduce(state, event): TaskState` is pure and lives in `core/model/`.
- API:
  ```ts
  class FsEventStore { constructor(root: string); append(key: string, e: NewEvent): Result<Event>; read(key: string): Result<TaskState|null>;
    ensureTask(key: string, actor: Actor, objective?: string): Result<{state: TaskState; created: boolean}>; list(): Result<TaskIndexEntry[]> }
  ```
- Verbs:
  ```
  workit task status [--all] [--json]
  workit task note "<text>" [--next "<t>"] [--objective "<t>"] [--endpoint local|pushed|pr|green|verified|merged|released] [--judge risk=normal,behavior=yes,product=no,plan=no]
  workit task close [--outcome verified|limited|stopped] [--waive <req>="<reason>"]
  workit task start "<objective>"   # alias of note --objective
  ```
  Every write verb (`check`, `git commit`, `ledger`) calls `ensureTask`.
- **Stop continuation:** with an `--endpoint` set and unmet, no blocker recorded, and `stop_hook_active=false`, the Claude `Stop` hook returns `continue` with the exact next command. It is capped at 3 per session (counter in `CLAUDE_PLUGIN_DATA`). This targets the "~14 manual continue" problem.
- **Migration** `workit migrate [--prune-recovery] [--dry-run]` (idempotent, under lock):
  - Move `.workit/{tasks,workspace.json,index.json}` → `<root>/legacy/`.
  - Open v2 tasks → `legacy/<uuid>/events.jsonl` with one `migrated.from_v2{legacyId, digest, objective, progress, openFindings, decisions}`. They are listed in `task status --all`, and `workit task adopt <legacyId>` binds one to the current branch. Legacy records have no branch, so no auto-mapping.
  - Closed tasks stay archived read-only.
  - `recovery/` is deleted only with `--prune-recovery` (S2's `gc` also works).
  - 3.0 readers run `migrate --dry-run` automatically and print the unblock.
- Delete:
  - `task-store.ts` (whole-record rewrite, recovery, `recover*`, `importTask`)
  - `state` family (`export/import/recover`), `task-context.reconcileResume`
  - candidate capture in `task-evaluation.ts` (→ `git/rev.ts`)
  - `session-context` index cache (replaced by snapshot)

### 4.2 S16: autonomy grants (replace receipts and the writer lease)
`workspaces.json` entry. The schema is already `.passthrough()`, so old versions tolerate it; S11 introduces the reader early.
```json
"autonomy": { "push": true, "pr": true, "merge": false | true | "verified", "release": false }
```
- Defaults when absent: `{push:true, pr:true, merge:false, release:false}` (the D4 ceiling).
- Legacy `autoApprove: true|[classes]` maps once (merge class → `"verified"`, so a verdict is still required); the `branch`/`commit` classes are dropped as local operations.
- `resolveAutonomy(root): {workspace: string|null; grants: Grants; source: "autonomy"|"autoApprove"|"default"; accountConfigured: boolean}` in `core/autonomy.ts`.
- `workit grant show|set <workspace> <verb>=<value>` requires a TTY (never MCP or headless). It writes through `safe-write.ts` with a backup.
- Protected-branch pushes are always denied. The host permission prompt applies in addition.
- Delete:
  - `authority.ts` (1,033 LOC), `auto-approval.ts` (338), `external-action.ts` (1,207)
  - `external-action-effects.ts` (2,428), minus the parts extracted to `forge/` in S10/S11
  - the `decision` binding/receipts/`approvedContent`/`BINDING_QUESTION_BUDGET`/`workitBindingQuestionIssue` in `task-contract.ts`
  - the `writer` family and `workspace.writer`, `workers.currentWriterOwnsTask`, worker dispatch reservation (`prepare/commitWorkerDispatch`)
  - CLI `workit action` + `cliActionAuthority` (`task.ts:489-940`)
  - OpenCode `NativeReceiptStore` (`tools/workit.ts`, `v2/receipts.ts`, question capture in `v2/plugin.ts`)
  - Pi `workit_external_action` and receipt confirm
  - MCP `workit_writer`/`workit_decision` mutation
- **Scope flag:** YouTrack `update/time/meeting` and `changelog.apply` are external actions today. Port them to plain verbs (`workit youtrack note|time`, `workit changelog apply`) gated by host permission, or the D11 "optional YouTrack adapter" loses its writes.

### 4.3 S17: slim policy
- `judged{riskTier:"trivial"|"normal"|"high", behaviorChange, productChoiceOpen, needsPlan}`, flat via `--judge`; aliases accepted (`yes|y|true`, `risk=low` → trivial).
- Derivation (`core/policy/derive.ts`, about 80 LOC):

  | Judgment | Requirement |
  |---|---|
  | `behaviorChange` | `check:test` (configured, fresh tree) |
  | `behaviorChange && risk≥normal` | `verdict` from a non-author |
  | `risk=high` | `verdict ∈ {verified}` (live surface) before land |
  | `productChoiceOpen` | a `decision.recorded` before close |
  | `needsPlan` | doc ref note (soft) |
  | always | project-configured checks |

- Delete: `assessmentSchema` (facts/signals/consequences/verification), most of `policy-resolver.ts` (486 → ~80), `selectMethods`/`triage*` remnants, `boundedOperationJsonSchema`/`OPERATION_SCHEMA_DEPTH`, the eight family op schemas → MCP/OpenCode tools become flat per-verb tools mirroring the CLI.

### 4.4 S18: retire and cut over
- Delete OpenCode `src/v1/server.ts` (744) + dual artifact, `cutover.ts` (1,789), `cutover-cli.ts`, `legacy-ownership.ts`, `config-conversion.ts`.
- Move `setup.ts`, `doctor.ts`, `host-install.ts`, `uninstall.ts`, `init.ts`, `registration.ts` from core into `packages/workit-cli/src/admin/`. Hooks and plugins stop bundling them.

---

## 5. Slicing: PR-sized slices, dependencies, parallel worktrees, acceptance

Prerequisites: S1, S2, S2b, S5, S7 merged (S8 builds on S5's `session-context.ts`; S9 needs S2b).

| Slice | Branch | Depends | Touches (exclusive unless noted) | Parallel with |
|---|---|---|---|---|
| S8a | `feature/core-hooks` | S5 | `core/src/hooks/**`, `task-contract.ts` (hostSchema + reader tolerance), codex/cursor/pi/opencode hook files, parity test | S9a |
| S9a | `feature/cli-router` | S7 | `workit-cli/src/{main.ts,verbs/*}` stubs, `index.tsx` (lazy ink), `core/src/git/rev.ts`, `knip.json` | S8a |
| S9b | `feature/cli-check` | S9a, S2b | `verbs/check.ts`, `core/src/checks.ts`, `task-engine.ts` (`observeCheck`), `task-evaluation.ts` (gate) | S10, S13, S14 |
| S10 | `feature/cli-pr-status` | S9a | `core/src/forge/**` (new), `verbs/{pr,ci}.ts` (status/wait/rerun only) | S9b, S13, S14 |
| S11 | `feature/cli-git-verbs` | S10 | `verbs/{git,verify-delivery}.ts`, `verbs/pr.ts` (create/merge), `forge/*` (create/merge/updateBase), `core/src/autonomy.ts`; `pr-create.ts`/`external-action-effects.ts` re-export shims | S13, S14 |
| S13 | `feature/cli-ledger` | S9a | `core/src/ledger.ts`, `verbs/{ledger,handoff}.ts` | S9b, S10, S11, S14 |
| S12 | `feature/cli-stack` | S11, S13 | `core/src/stack.ts`, `verbs/stack.ts`, `pr status` verdict block | S14 |
| S14 | `feature/claude-code-adapter` | S8a (S9a for the bundled `main.ts`) | `packages/workit-claude-code/**`, root `.claude-plugin/`, release config + manifest sync, CI job, `.oxlintrc/.oxfmtrc` | S9b–S13 |
| S15 | `feature!/implicit-task-event-store` | S9b, S13, S12 | `core/src/store/**`, `core/model/**`, `verbs/task.ts`, migrate; rewires `implicitTaskFor`, `ledger` and `stacks` onto the store root | S18 |
| S16 | `feature!/autonomy-grants` | S15, S11 | deletions §4.2, `verbs/grant.ts`, YouTrack/changelog verbs | S18 |
| S17 | `feature!/slim-policy` | S16 | `core/policy/**`, MCP/OpenCode flat tools, deletions §4.3 | — |
| S18 | `chore!/retire-v1-cutover` | S9a | OpenCode v1, cutover, admin move | S15, S16 |

Expected conflict hot spots:
- `verbs/registry.ts`: avoided by the S9a stubs.
- `task-contract.ts`: S8a's one line vs S9b's evidence field; land S8a first.
- `forge/*`: S11 extends S10, so they are stacked.
- `release.config.cjs`: S14 only.
- `index.tsx`: S9a, then S18.

Worktrees: `../workit-wt/s8-hooks`, `s9a-router`, `s9b-check`, `s10-pr`, `s11-git`, `s12-stack`, `s13-ledger`, `s14-claude`, and so on. Waves: {S8a, S9a} → {S9b, S10, S13, S14} → {S11} → {S12} → {S15, S18} → S16 → S17.

### Acceptance (Given/When/Then; these become the test names)

**S8a**
- G a protected `main`, W the Claude PreToolUse payload `{"tool_name":"Bash","tool_input":{"command":"git checkout -b main"}}` is piped to the hook, T stdout has `permissionDecision:"deny"` with a `protected_ref` reason, and no host ever receives `allow`.
- G the same command on Cursor `beforeShellExecution`, T it is denied with exit 2. The parity table includes cursor and claude_code.
- G a Codex PreToolUse payload with an unknown key, T the hook still evaluates policy (no parse denial).
- G an `undocumented` axis in a descriptor, T `capabilitiesFor` never yields `enforced` for it.
- G SessionStart `source:"compact"`, T additionalContext contains `<workit-task-context>`.
- G a hook bundle, T it is ≤300 KB and loads no `doctor`/`setup` modules.

**S9a**
- G any verb, T ink/react are not imported (module-graph test) and `workit --help` lists the verbs.
- G a dirty worktree, T `worktreeTree` changes when a file changes and HEAD and the refs stay untouched.
- G a rebase that changes only the base, T `patchId` is equal.

**S9b**
- G `workit check -- bun test` exiting 1, T evidence records exitCode 1, logDigest, head and tree, and a `before:close` testing requirement stays unsatisfied.
- G an agent-recorded `evidence.record {kind:check,result:passed}`, T it does not satisfy a testing requirement.
- G `workit check -- true` while `test` is configured, T the testing requirement stays unsatisfied (`configured:false`).
- G a passing check, then a file edit, T the requirement reads stale.
- G a fresh branch with no task, W check runs, T a task bound to the branch exists.

**S10**
- G GitHub and GitLab fixtures of an open PR with a failing job, one unresolved thread, and base 3 behind, W `pr status --json`, T both forges return identical-shape data with `logTail` populated, `unresolvedThreads.length==1`, `behindBase.behind==3`, and `next=="RESOLVE_THREADS"`.
- G a second `ci rerun --failed` on the same head, T `blocked` unless `--force`.
- G gh missing, T exit 5 with an install hint.

**S11**
- G `vcs.account=cpincetti` but `glab api user` returns `other`, W `git push`, T `blocked` with the `glab auth` unblock and nothing pushed.
- G a workspace without a merge grant, W `pr merge`, T `grant_required` naming the grant, with the exact command.
- G `merge:"verified"` and no verdict, T blocked with `NEEDS_VERDICT`.
- G the remote advanced after the local SHA, T merge refuses (SHA guard).
- G a push, T `verify-delivery push` reports `delivered:true` with observed == local.
- G origin `github.com` under a gitlab workspace, T `blocked` with the override hint.

**S13**
- G a verdict recorded by the session that authored the commits, T it is refused unless `--self`, and `--self` is not accepted by `merge:"verified"`.
- G a verdict at SHA A, then a base-only rebase, T `ledger check` reports `carried`; after a content change it reports `stale`.
- G `workit handoff`, T the brief includes the next command and the check freshness.

**S12**
- G a 4-PR stack where PR1–2 are verified and green and PR3 is unverified, with a merge grant, W `stack land`, T PR1 and PR2 merge in order, PR3 is retargeted to trunk and restacked, PR4 is untouched, and the output has `stoppedAt.pr==3` with reason `no_verdict`.
- G no merge grant, T nothing merges and the output stops at "verified, ready".
- G a restack conflict, T `blocked` with the rebase-continue unblock and the stack file unchanged for unprocessed branches.

**S14**
- G `claude --plugin-dir packages/workit-claude-code` in a monorepo worktree, T `bin/workit --version` resolves to the source and the hooks run from the source.
- G the packed tarball, T `claude plugin validate --strict` passes for the plugin and the root marketplace, and `dist/` resolution is used.
- G the hook fixture suite, T every event yields schema-valid output.
- G the nightly eval, T the score is ≥0.8.

**S15**
- G 1,000 writes to one task, T `tasks/<key>/` holds events.jsonl + snapshot only, with size linear in the events.
- G a lock held by a dead pid, T the write succeeds.
- G two live writers, T one gets `busy`, never `recovery_required`.
- G a torn last line, T the next append truncates it and the replay is consistent.
- G a v2 `.workit` with 74 tasks + recovery, W `migrate` twice, T the open tasks are listed as legacy, the second run is a no-op, and recovery is removed only with the flag.
- G an endpoint `green` that is unmet, W Claude Stop, T the reply is `continue` with the next command, at most 3 times.

**S16**
- G `autoApprove:["push","pr"]`, T resolveAutonomy gives push and pr true, merge false, source `autoApprove`.
- G a headless `grant set`, T refused.
- G a `git grep` for `receipt|writer.acquire|BINDING_QUESTION`, T no source hits remain (except the CHANGELOG).

**S17**
- G `--judge behavior=yes risk=normal`, T requirements = {check:test, verdict:non-author}.
- G a 2-line mechanical fix judged trivial, T zero requirements and no spec proposed.
- G MCP tool schemas, T max depth is 1, with no `boundedOperationJsonSchema`.

**S18**
- G the build, T the OpenCode artifact exports only `setup()`.
- G a hook or plugin bundle, T it contains no doctor/setup/cutover code.
- G `workit doctor`, T it still works from the CLI package.

---

### Critical Files for Implementation
- /home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit/packages/workit-codex/hooks/workit-hook.ts (template for `core/hooks` and the Claude mapping; the strict-parse bug)
- /home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit/packages/workit-core/src/core/external-action-effects.ts (lines 601–925: forge helpers to extract; deleted in S16)
- /home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit/packages/workit-core/src/core/pr-create.ts and vcs-config.ts (`prCreate`, `mergePr`, `pushRemote*`, `vcsCliIdentity`: identity/forge reuse; provider precedence bug at vcs-config.ts:150)
- /home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit/packages/workit-core/src/core/task-engine.ts + task-evaluation.ts (`evidence()` at :1049/1114 agent_reported; `evaluateRequirements` at :502: S9 gate)
- /home/cristhofer-pincetti/Documents/projects/personal/workflow-toolkit/packages/workit-cli/src/index.tsx + task.ts (router split, `workspaceRootFor`, `workit action` to delete); plus `origin/bugfix/opencode-hot-path:packages/workit-core/src/core/session-context.ts` (seed for `hooks/context.ts`)
