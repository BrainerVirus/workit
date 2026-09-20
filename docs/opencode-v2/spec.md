# Workit OpenCode V2 - Spec (dual-entry, Docker-first, V2-native)

## 1. Goal

One `@brainervirus/workit-opencode` package works on OpenCode V1 `1.18.30` and
OpenCode V2 `2.0.3`, with the same Workit outcomes:

- 10 native tools: 8 core families, `workit_external_action`, and
  `workit_init_apply`;
- 14 method skills and their 14 `wk-*` command aliases;
- native decision receipts;
- direct-child delegation lineage and worker lifecycle;
- bootstrap, task, worker, and compaction context;
- denial of Git worktree creation; and
- denial of recognized raw branch and PR creation routes.

The live V1 host stays unchanged until the packed dual-entry artifact passes
the real-host V1 and V2 matrices. The prerequisite behavior in
`docs/workit-runtime-reliability/spec.md` has landed on
`feature/workit-runtime-reliability` (`ecccfc0` semantic receipts and per-loop
method projection, `1bd7374` durable dispatch claims, `a70a8a5` route
enforcement, `8338cbf` docs handoff); this port consumes those corrected
contracts. The `docs/workit-reliability-delta/` slice then added
concise native action approvals with hidden exact descriptors, plan-scoped
commit approvals, protocol and state-transition fixes, persisted runtime
metadata, and show-before-ask guidance; the V2 adapter consumes those contracts
as well.

## 2. Non-goals

- No additional `workit-core` behavior change inside the V2 port. The separate
  runtime-reliability prerequisite may correct core behavior first; this port
  consumes that released contract. Core remains in
  `packages/workit-core/src/core`; adapters map host-native surfaces to it.
- No V1 removal. `server()` remains until the support window ends.
- No live-host V2 install while a V1 session is running.
- No new tool family, skill, command, CLI surface, storage format, or plugin
  option.
- No durable V2 plugin cache. `.workit/` remains the source of truth.

## 3. Pinned contracts

- V1 host and SDK: `1.18.30` / `@opencode-ai/plugin@1.18.30`.
- V2 host and SDK: `2.0.3` / `@opencode/plugin@2.0.3`.
- V2 image:
  `ghcr.io/anomalyco/opencode@sha256:aaf8c5420e10652c520e068532384f6e20cece2922c404db7f89e36720b9f212`
  (tag `2.0.3`).
- V1 image:
  `ghcr.io/anomalyco/opencode@sha256:412b37a894bb937a0d5d6a1860789b9fd7d34a109334bec98a3f6ecf812bb442`
  (tag `1.18.30`).

There is no `ghcr.io/anomalyco/opencode:2.x` tag. Package and image versions
must move together in a deliberate compatibility update.

Primary references:

- [V2 plugin API](https://opencode.ai/v2/docs/build/plugins/)
- [V1 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [V1 to V2 migration](https://opencode.ai/v2/docs/migrate-v1)
- [V1 plugin API](https://opencode.ai/docs/plugins/)
- [OpenCode 2.0.3 source](https://github.com/anomalyco/opencode/tree/v2.0.3)

## 4. Constraints

- V1 and V2 share the `opencode` command and config locations. The V2 curl
  installer replaces V1; side-by-side host installation is not assumed.
- V1 plugin implementations do not run in V2. V2 requires a stable `id` and
  `setup(ctx)` registrations.
- A dual default export containing V1 `server()` and V2 `setup()` is supported
  by V1 `1.18.29+`; the supported V1 floor here is `1.18.30`.
- The implementation must raise the declared and enforced V1 floor to
  `1.18.30` in the same change: `SUPPORT_MATRIX.opencode.minimum`, the doctor
  check, CI `OPENCODE_MINIMUM`, and the manifests tests. A host older than
  `1.18.29` must not pass doctor while being unable to load the object-form
  entry.
- V2 transforms are synchronous, cheap, and replayable. Read files before a
  transform and call the domain's `reload()` only when captured data changes.
- V2 tool calls from one model response run concurrently. Worker dispatch must
  not assume host serialization.
- `ctx.location` is the plugin instance location, not proof of every session or
  event location. Session-scoped actions revalidate the session location.
- V2 tool execution context has `sessionID`, `agent`, `messageID`, `id`, and
  `progress`; it has no `directory` or `worktree` field.

## 5. Package shape

```text
packages/workit-opencode/
  src/
    plugin.ts          # stable checkout path; re-exports the default from index.ts
    index.ts           # dual default export: {...v2Definition, server: v1Server}
    v1/server.ts       # V1 adapter on @opencode-ai/plugin
    v2/plugin.ts       # Plugin.define({ id: "workit", setup })
    shared/            # only execution/schema/receipt logic genuinely used by both
  dist/plugin.js       # single bundled published entry for both hosts
```

- Keep package `main` and `exports["."]` at `./dist/plugin.js`.
- Build `src/index.ts` to `dist/plugin.js`; do not introduce `dist/index.js` or
  an export condition because both hosts load the same default object.
- Keep `src/plugin.ts` so setup, doctor, sync, cutover, root package exports,
  Knip, and checkout `file://` registrations remain valid.
- Pin `@opencode/plugin` to `2.0.3` as a build-time dependency and bundle the
  used runtime into `dist/plugin.js`, preserving the current self-contained
  packed artifact. No new runtime dependency is required by default. Effect may
  be added only through the adapter-local adoption gate in section 6 and must be
  bundled into the same artifact.
- Resolve `assets/skills` through one helper that works from both source files
  and the bundled `dist/plugin.js`; moving `plugin.ts` unchanged would otherwise
  change `import.meta.url` relative paths.
- Keep stable plugin `id: "workit"`; V2 storage and diagnostics are scoped by
  it. Do not add `ctx.storage` usage without a real need.

## 6. Shared adapter boundary

Do not pass a V1 or V2 SDK tool context into shared code. Shared execution
accepts explicit values such as `root`, `sessionID`, a normalized session
lookup, receipt/lineage stores, and a progress callback.

- V1 wrappers adapt `{ client, directory }`, V1 `{ path: { id } }` session
  calls, Zod helper schemas, and string results.
- V2 wrappers close over `ctx.location.directory`, adapt
  `ctx.session.get({ sessionID })`, read `Session.Info.location.directory`, and
  return structured `Tool.Result` values.
- Every V2 Workit tool verifies that the observed session ID and
  `session.location.directory` belong to the plugin checkout before opening
  `.workit/`.
- Core operation schemas remain authoritative. The V2 JSON Schema projection
  preserves action enums, required fields, descriptions, and
  `additionalProperties: false`; core parsing remains the final validator.
- Register the existing effective names directly (`workit_task`, etc.). Do not
  add a V2 namespace in the first port; combining a namespace with prefixed
  names would produce different tool IDs.

### Optional Effect boundary

Effect is not part of `workit-core`, the operation contracts, or durable state.
After the runtime-reliability slice and Docker spike, it may be piloted only
inside `packages/workit-opencode` for V2 event subscription cleanup,
cancellation, bounded reconciliation schedules, or concurrent event
correlation.

Adoption requires a runnable failing lifecycle case that remains awkward after
the durable dispatch fix, a smaller and clearer implementation than native
`AbortSignal`/promises, no Effect value crossing the shared adapter boundary,
and a self-contained packed artifact. Effect `Ref`, queues, semaphores, scopes,
and fibers are process-local aids; `TaskStore` remains authoritative.
Interruption and finalization never prove `not_started`, `stopped`, or that a
remote action did not occur. A separate recorded design decision is required
after spike evidence. Without that evidence and decision, the V2 implementation
uses native platform primitives.

## 7. V1 to V2 mapping

| V1 today                                                             | V2-native destination                                                                                         | Required parity behavior                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool: {...createWorkitTools(), workit_init_apply}` through `tool()` | One `ctx.tool.transform` registering the 10 exact names with JSON Schema and structured `{ content }` results | Include all 8 families, `workit_external_action`, and `workit_init_apply`. Adapt root/session/progress explicitly as described in section 6.                                                                                                                                                                                                                                                                                                                |
| `tool.execute.before` for native `task`                              | `ctx.tool.hook("execute.before", event => ...)` for `event.tool === "subagent"`                               | V2 fields are `event.sessionID`, `event.id`, and `event.input`. Enforce direct-child lineage. Only a fresh call with no input `sessionID` may claim a worker. Claim the adapter's single fresh-launch slot synchronously before any awaited validation, and let core `prepareWorkerDispatch` persist the durable `dispatching` claim before the spawn attempt. Deny a managed launch before spawn when no attributable assigned worker exists or a claim is unsettled; the in-memory slot is adapter-local correlation only and releases on settlement or pre-reservation failure, while the durable claim settles only from host evidence. |
| Coordinator-keyed dispatch reservation                               | One in-flight fresh `subagent` launch per coordinator                                                         | V2 executes tools concurrently. If a coordinator already has an unsettled fresh launch, fail a second fresh launch before it runs. Never overwrite the first reservation; the durable `dispatching` claim is store-owned, and only the live reservation may settle it as `running` with an observed child or `stopped` with host-attested proof that no child started. Add a parallel-call regression check.                                                                                                             |
| Native task continuation                                             | V2 `subagent` input with existing `sessionID`                                                                 | Validate that the session is an existing direct child already bound to the coordinator. Do not prepare or consume a new Workit worker assignment.                                                                                                                                                                                                                                                                                                           |
| `tool.execute.after` task bind/settle                                | V2 `execute.after` completed/error union                                                                      | Correlate with `event.id`. On success read `event.result.output` (`sessionID`, `status`, `output`) and `event.result.metadata`; completed content uses `<subagent ...>`. A running/background result remains running.                                                                                                                                                                                                                                       |
| `childCreated:false` no-child proof                                  | No equivalent proof in the released V2 error result                                                           | Never infer `not_started` from a missing session ID or generic error. Keep the launch unresolved until a trusted created/terminal event settles it; block replacement while uncertainty remains.                                                                                                                                                                                                                                                            |
| `question.*` plus question after-hook                                | Question `ctx.tool.hook("execute.after")` only                                                                | V2 has no public `question.asked/replied/rejected` events. On completed `question`, combine `event.input.questions` with `event.result.metadata.answers`. Use the corrected shared semantic receipt recognizer: exact binding-question structure, normalized host label qualifiers, approved content identity, matching-queue search, one-selection checks, injectable freshness time, session binding, and consume-once behavior. `form.*` events are not needed for receipt minting. |
| `event` session lifecycle                                            | Abortable `ctx.event.subscribe({ signal })` loop using V2 event envelopes                                     | Read `event.data`, not V1 `properties`. Map `session.created` to bind/running; `session.execution.started` to running; `succeeded`, `failed`, and `interrupted` to stopped; and `session.deleted` to stopped. `session.status` and `session.idle` remain delivered compatibility events, but the canonical terminal lifecycle is `session.execution.*`; `session.error` is not part of the V2 stream.                                                       |
| Volatile V2 event stream                                             | Event-driven settlement plus bounded reconciliation                                                           | The plugin event stream may miss events and is not a delivery guarantee. Before an unresolved worker blocks a launch, reconcile its bound child once through `ctx.session.get`: a successful read with a terminal `outcome` (recorded at `time.idle`) settles stopped, and a completed subagent tool result settles its own child. Failed or inconclusive reads keep the worker unresolved and the veto in place. Never forge stopped from a missing event. |
| Rich V1 `session.deleted` payload                                    | V2 sparse delete `{ data: { sessionID } }`                                                                    | Trust deletion only for one persisted child binding in this checkout, plus a matching event location when present. Do not call `session.get` after deletion or invent parent/directory fields.                                                                                                                                                                                                                                                              |
| `config` skill path                                                  | Read 14 packaged manifests/content before `ctx.skill.transform`                                               | Register exact skill IDs, locations, descriptions, and content. Skip an existing user skill ID rather than silently replacing it. Validate active `ctx.skill.list()`, not just asset directory count.                                                                                                                                                                                                                                                       |
| `config` `wk-*` command aliases                                      | Read `ctx.command.list()`, then `ctx.command.transform(editor.add(...))`                                      | Register all 14 aliases. Preserve existing user commands by skipping names already present. `execute({sessionID,prompt,delivery})` calls `ctx.session.prompt` and preserves prompt attachments, arguments, and delivery.                                                                                                                                                                                                                                    |
| `config` Bash worktree deny                                          | `ctx.permission.hook("evaluate")`                                                                             | For `action === "shell"`, deny resources matching the existing Git-worktree rule and set the denial message. `permission.rules()` is not called from setup: it requires a session ID and replaces session rules. Explicit configured denies remain final; the hook handles allow/ask decisions.                                                                                                                                                             |
| `tool.execute.before` bash route deny                                | `ctx.permission.hook("evaluate")` for `action === "shell"`                                                     | Evaluate `shellRouteIntent` on the shell resource before the worktree rule: deny recognized `git switch -c`/`--create`, `git checkout -b`/`-B`, `gh pr create`, and `glab mr create` with the exact Workit route guidance, and let unparseable or unrelated commands keep their configured allow/ask behavior. The spike confirms the V2 shell resource shape; the recognizer and guidance stay core-owned (`shellRouteIntent`).                          |
| `experimental.session.compacting` context push                       | `ctx.session.hook("compaction")`                                                                              | Append `<workit-task-context>` as a text system part when absent. Never set `event.result`; that supplies a completed summary and skips the model call.                                                                                                                                                                                                                                                                                                     |
| `experimental.chat.messages.transform`                               | `ctx.session.hook("context")`                                                                                 | Add `<workit-contract>`, `<workit-task-context>`, or `<workit-worker-context>` to model-visible system context as applicable on every agent-loop call. Shared task context includes current policy-selected methods and assurance. Do not use `prompt`: prompt edits become persisted user input. Dedupe markers within the current hook event, never across later policy changes. |
| `client.session.get` lineage checks                                  | `ctx.session.get({ sessionID })` and V2 `Session.Info`                                                        | Normalize the direct response and use `session.location.directory`; `ctx.location` alone is insufficient.                                                                                                                                                                                                                                                                                                                                                   |
| Initialization/provenance and stale-source warning                   | V2 setup logging plus the same tool-before stale-source check                                                 | Preserve diagnostics without allowing logging failures to break hook/event delivery. Update source-marker paths for the new layout.                                                                                                                                                                                                                                                                                                                         |
| Ephemeral receipt queues, in-flight launch slots, and context markers | Per-plugin in-memory state                                                                                    | Return cleanup that aborts event subscription. Hook/transform registrations are plugin-scoped and auto-disposed. `.workit/` remains durable authority: the `dispatching` claim lives in `TaskStore`, and there is no speculative `ctx.storage` cache.                                                                                                                                                                                                          |

Unused V1 hooks remain unported: Workit has no `shell.env`, `$`,
`chat.params`, `chat.headers`, provider/auth, small-model, or text-complete
behavior.

## 8. Config coexistence

- Never modify or mount the live V1 config into V2.
- Create a temporary HOME/XDG config tree and copy only non-secret files.
  Replace package paths with the mounted test artifact and remove live provider
  credentials, tokens, and remote mutation targets.
- Run two V2 config lanes:
  1. a V1-shaped copy using `plugin`, `permission.bash`, `command`, and
     `skills.paths`, proving V2 normalization; and
  2. a native V2 copy using `plugins`, ordered `permissions`, `commands`, and
     `skills`.
- Native V2 values win top-level conflicts. Do not mix formats recursively
  inside one agent, provider, command, or model entry.
- Native conversion remains optional. When used, convert `bash` to `shell`,
  `task` to `subagent`, `write`/`patch` to `edit`, `subtask` to `subagent`,
  `prompt` to `system`, `disable` to `disabled`, and model variants to
  `provider/model#variant`.
- `~/.config/opencode/cli.json` is terminal-client-owned and irrelevant to the
  service plugin.

## 9. Docker harness

Use an internal Docker network with:

- the pinned OpenCode image;
- a deterministic local OpenAI-compatible stub that emits scripted text and
  tool calls for lead, subagent, question, and compaction flows; and
- an API driver that creates sessions, watches events, replies to
  `form.created` through the form API, triggers compaction/reload, and asserts
  resulting `.workit/` state.

Mount the repository read-only, overlay a writable scratch checkout state and
`.workit/`, and mount only the temporary config tree. Do not pass host model,
GitHub, GitLab, or YouTrack credentials. Remote external actions are never
executed; exercise `workit_external_action` with `context.read` and assert that
mutating operations remain approval-gated.

The pre-implementation Docker spike uses a disposable V2 probe plugin to
confirm container loading, event ordering, permission resources, mock-provider
tool calls, form replies, and unload behavior. It does not pretend the current
V1-only Workit entry can pass V2 parity. The full matrix runs after the dual
entry is implemented.

### Spike findings (plan step 3, `test/opencode-v2/` harness green 13/13)

- **Tool visibility resolved — matrix item 4 is unblocked.** A tool
  registered through `ctx.tool.transform` + `editor.add` appears in
  `editor.list()` but reaches model requests ONLY with
  `options: { codemode: false }`; without it (or with `codemode: true`,
  namespaces, `permission`, or `pinned` variants tried) the tool stays
  code-mode-only and direct calls fail as "not currently available".
  Verified end-to-end: offered alongside the 12 builtins, called by the
  model, `tool.execute` ran in-plugin, structured result returned.
  Register the 10 workit tools with `codemode: false` under their existing
  effective names (no V2 namespace, per section 6).
- Latest docs describe `ctx.provider`/`ctx.model` transforms; the pinned
  `2.0.3` SDK has neither. Custom providers are config-declared, and model
  entries require `capabilities: { tools, input: [...], output: [...] }` —
  anything less is skipped as malformed (server logs a normalization
  diagnostic). Plain-object plugins (no SDK import) load fine.
- The `openai-compatible` runtime requires SSE-streamed chat completions;
  plain JSON bodies fail as `provider.invalid-output` with endless retries.
- Permission `evaluate` carries `{ sessionID, agent, action, resources[],
  source, effect }` with mutable `effect`/`message`. Pre-set deny rules
  FILTER the tool from the offering; a mid-flight deny yields
  `permission.rejected` with `executed: false`. Question forms round-trip
  through `form.created` → form GET → `/form/{id}/reply`.
- `subagent` requires `agent`, spawns a child with `parentID` lineage, and
  completes concurrently (two children, one turn) with `<subagent
  sessionID state>result</subagent>` envelopes. Prompt `text` edits persist
  (prompt hook); `context`-hook `system` edits do NOT reach the provider in
  `2.0.3`. Compaction validates a fixed section template and fires the
  `compaction` hook. V1-shaped config normalizes in memory (`plugin`→
  `plugins`, `provider`→`providers`, `npm`→`aisdk:`-prefixed `package`,
  `options`→`settings`) without rewriting the source file.
- Harness caveats: the CLI always spawns a background service, so the driver
  must tolerate transient empty outputs and void endpoints; location services
  boot on first prompt (not session create); plugin file changes hot-reload
  via watchers; `prompt` takes no model (switch via `/model`); event ids are
  `evt_`-prefixed across a wide taxonomy (`session.step.*`,
  `session.execution.*`, `session.usage.updated`, `*.updated`).

## 10. Validation matrix

Run the packed artifact, not only workspace-linked source.

1. V1 `1.18.30` loads the dual default export through `server()` from both the
   stable checkout path and packed `dist/plugin.js`, and its existing config
   file is byte-unchanged after the lane.
2. V2 `2.0.3` loads the same packed artifact through `setup()`, with plugin ID
   `workit` and the expected source in `ctx.plugin.list()`.
3. Both V2 config lanes from section 8 pass: the unchanged live-shaped V1
   config copy normalizes in memory without rewriting the source file, and the
   native V2 config behaves identically.
4. The exact 10 Workit tools are active with valid schemas. Execute each core
   family safely, `workit_external_action` as `context.read`, and
   `workit_init_apply` only against scratch files.
5. All 14 skills appear in `ctx.skill.list()` with non-empty packaged content;
   all 14 `wk-*` commands appear, one command preserves arguments/attachments,
   and a user-defined collision is untouched.
6. Fresh serial subagent launches bind same-task workers oldest-first;
   preparation durably changes the selected worker from `assigned` to
   `dispatching`; cross-task ambiguity binds nothing and denies a managed launch;
   nested launch is denied.
7. Concurrent fresh launches cannot overwrite a reservation, the first
   adapter slot is claimed before any awaited validation, core persists the
   `dispatching` claim before the spawn attempt, and a managed launch with no
   attributable assigned worker is denied before a child starts; continuation
   of an existing `sessionID` consumes no assigned worker.
8. Foreground completion, background running/completion, failure,
   interruption, sparse deletion, no-child uncertainty, and one injected
   missed terminal event produce the documented worker states: reconciliation
   never forges `not_started` or `stopped` and never deadlocks the coordinator.
9. A receipt-shaped native question mints one matching, consume-once receipt;
   rejected presentation text is not magic; host label qualifiers normalize;
   unrelated newer receipts do not shadow a match; custom text, ordinary
   questions, mismatched content, and stale answers mint none.
10. Bootstrap is model-visible without changing persisted user text; task and
    worker contexts appear on each applicable agent-loop call; compaction gets
    task context and still performs its normal model call.
11. Git worktree shell commands and recognized raw branch/PR creation
    (`git switch -c`/`--create`, `git checkout -b`/`-B`, `gh pr create`,
    `glab mr create`) are denied with a reason and the exact Workit route.
    Unparseable or unrelated shell commands retain configured behavior,
    including explicit existing denies.
12. Unload/reload aborts the event stream and removes registrations without
   duplicate tools, skills, commands, hooks, or stale in-memory receipts.
13. The package artifact remains self-contained, includes `assets/skills`,
    imports without runtime SDK/workspace dependencies, and keeps the stable
    `src/plugin.ts` / `dist/plugin.js` paths.
14. Existing V1 OpenCode tests, package/artifact tests, typecheck, lint, format,
    and full repository tests pass after implementation.
15. The declared minimum OpenCode version, doctor, CI, and manifests tests all
    enforce `1.18.30`, so a pre-`1.18.29` host cannot pass doctor while failing
    to load the object-form entry.
16. The packed artifact uses no Effect dependency unless the section 6 adoption
    gate has recorded evidence and approval. If piloted, adapter tests prove
    cancellation/finalization cannot settle durable worker or action outcomes,
    and V1/V2 parity remains unchanged.

## 11. Remaining risks

- Event and hook ordering under concurrent launches must be verified in the
  pinned container even though field names are fixed by `2.0.3` source.
- V2 exposes no explicit `childCreated:false` result. Conservative unresolved
  handling may require manual recovery; it must never guess that no child
  exists.
- Command, skill, and permission registration order can affect collision and
  last-match behavior; both user-config collision lanes are required.
- Bundling `@opencode/plugin` must remain tree-shaken and self-contained; the
  packed-artifact import test is authoritative.
- An optional Effect pilot could create a second error/lifecycle model or hide
  provenance boundaries. Keep it adapter-local and remove it if the Docker case
  is no clearer than native platform primitives.
- A future OpenCode V2 release can change the plugin contract. Upgrade the SDK,
  image tag/digest, source citations, and matrix together.

## 12. Acceptance for this spec revision

- Every confirmed review finding has a concrete requirement or check above.
- Released `2.0.3` field names are requirements, not Docker unknowns.
- The Docker spike is reproducible, credential-isolated, and distinct from the
  post-implementation parity run.
- `plan.md` records the landed runtime-reliability prerequisite, then sequences
  the probe, the Effect decision gate, implementation, dual-host acceptance,
  docs, and release without changing the live V1 host.
