# Agent Contract

Multi-platform workit: OpenCode, Cursor, Codex CLI/desktop, Pi, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature              | OpenCode                                                                                                                                | Cursor                                                                                                                                                                                           | Pi                                                                                                                     | CLI                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Approval             | native `question` tool receipts                                                                                                         | AskQuestion policy-only (`attested: false`)                                                                                                                                                      | native `ctx.ui.confirm`; headless `needs_input`                                                                        | `--confirm` flags / TTY prompts                                                |
| Implementation       | subagent-driven via native `task`, delegated status from session parentage (child `parentID` must equal the coordinator session handle) | native `subagentStart` assignment; file writes pass through to host policy, exact stop identity, AskQuestion answers, arbitrary shell writes, and Tab edits remain agent_guided/unavailable | project-trust `tool_call` boundary; file writes pass through to host policy, shell writes remain agent_guided and no OS sandbox is provided | n/a (`workit task` only)                                                       |
| Lifecycle            | `workit_task` pause/resume/close (native decision receipts)                                                                             | `workit_task` pause/resume/close (policy-only)                                                                                                                                                   | session start/compaction/shutdown continuity; supervised stock-Pi worker lifecycle                                     | `workit task pause\|resume\|close`                                             |
| Handoff              | manual `workit state export` + destination `state import` via the handoff skill (no native session spawn)                               | seeds a handoff prompt for the next agent                                                                                                                                                        | fresh stock-Pi review/worker processes; no nested worker launch                                                        | `workit state export` + destination `state import` (or printed handoff prompt) |
| Tools                | eight native core-backed `workit_<family>` tools (+ adapter-owned `workit_external_action`)                                             | MCP server (`workit_*`)                                                                                                                                                                          | eight native core-backed `workit_<family>` tools (+ adapter-owned `workit_external_action`)                            | `workit` commands                                                              |
| Shared MCP transport | n/a (native tools remain host-owned)                                                                                                    | `@brainervirus/workit-mcp`; host wiring remains adapter-owned                                                                                                                                    | n/a (native tools remain host-owned)                                                                                   | n/a                                                                            |
| Skills               | `skills.paths` + fourteen canonical policy-selected method skills (no vendored Superpowers dirs)                                           | plugin `skills/` dirs                                                                                                                                                                            | package `pi.skills` + fourteen canonical method skills                                                                    | n/a                                                                            |
| Branch policy init   | `workit_init_apply action=branch_policy` (narrow registration)                                                                          | pending — use the wizard screen (unattested MCP cannot mutate)                                                                                                                                   | pending — use the wizard screen (no host surface is wired yet)                                                         | wizard screen                                                                  |
| Distribution         | npm plugin entry (`opencode.json`)                                                                                                      | Cursor Marketplace (git-discovered `.cursor-plugin/plugin.json`)                                                                                                                                 | npm package manifest (`pi.extensions`/`pi.skills`)                                                                     | npm bin (`npx`)                                                                |

OpenCode's native adapter keeps the eight shared operation contracts authoritative while projecting advertised nested schemas to the provider's supported depth; runtime parsing remains core-owned.

Concrete optional Git, hosting, YouTrack, and documentation mutations remain
adapter-owned on host surfaces that can attest the effect. They must run
through the shared one-time action reservation and host-observed settlement,
with an exact canonical operation/target/payload binding (never prose
matching). Caller-unattested MCP keeps optional mutations unavailable. The CLI
`workit action` route has a native terminal confirmation path; headless calls
(including `--confirm` without a TTY) return `needs_input` and never fabricate
an approval receipt.

Read-only `context.read` is available on OpenCode, Pi, and the CLI for the
enumerated git/PR/YouTrack/changelog/release/affected contexts without
approval or writer ownership; release context includes a deterministic draft,
and affected context identifies files only. Documentation edits continue
through existing writer-guarded native actions (file writes themselves are host-policy), with CLI identification
remaining read-only. Cursor and Codex expose the same contexts as
MCP resources (`workit://context/{kind}`); resource URIs cannot supply a
workspace or caller identity.

Codex CLI and desktop use the native plugin manifest, hooks, and shared MCP
transport. Hook enforcement is limited to documented covered events; the host
does not expose arbitrary-question receipts or attested writer delegation. A
human may bind a writer to a Codex session explicitly with
`workit writer acquire --actor <session-id>`; the hook honors exactly that
session and nothing else.

Pi uses the stock 0.85.1 package contract. Its extension is self-contained
apart from the Pi peer, reports native session/UI provenance truthfully, and
bundles a coordinator for fresh stock-Pi reviewer/investigator and scoped
implementer processes. Only an observed child process may acquire the shared
writer; cancellation or restart uncertainty blocks replacement ownership.
Pi extensions remain workflow controls, not an OS sandbox, and shell writes are
agent-guided. The parent extension additionally exposes a child-disabled
`workit_worker_control` orchestration tool; it is not a ninth core family and
is never available to supervised children.

## Parity rules

1. Core logic lives in `packages/workit-core/src/core/`; adapters only map host-native surfaces to it. Never re-implement core logic per host.
2. A new feature adds: the core module, both host adapters, and the CLI surface (command or wizard screen), plus tests proving identical outcomes (parity test).
3. Docs (README), this file, and the CHANGELOG Unreleased section are updated in the same change.
   Candidate capture must use Git's ignore-aware inventory in Git workspaces; do not recursively walk ignored trees.
4. Marketplace distribution is host-native: Cursor discovers the plugin from Git (`.cursor-plugin/plugin.json` + tracked skills/rules/assets), OpenCode installs the npm plugin entry, and the CLI ships as an npm bin. The tracked Marketplace artifact is validated in CI by `validate:cursor-marketplace` against the pinned official Cursor JSON schema snapshots (`test/fixtures/cursor-schemas/`). `marketplace.json` `plugins[].source` is repo-root-relative (the directory containing `.cursor-plugin/`), not `.cursor-plugin/`-relative. Never claim Marketplace publication or acceptance; keep the repository submission-ready but not submitted.
5. Cursor runtime execution uses the `@latest` dist-tag with the mandatory `--prefer-online` flag (`npx -y --prefer-online --package=@brainervirus/workit-cursor@latest …`): `--prefer-online` forces fresh registry re-resolution so a stale `latest` in the `_npx` cache is never reused. The selector is intentional — no per-release manual pin bump is required, and the doctor enforces this exact launcher shape.
6. Stable v1 publication requires deterministic acceptance (`test:acceptance/`,
   `verify:release-candidate`) plus authorized live qualification evidence
   (`docs/workit-v1/qualification.md`). Do not invoke `scripts/run-v1-evaluation.ts`
   or fabricate batch results without explicit model/run/time/usage authorization.
7. Stale-install auto-load repair is automatic and fail-open: the doctor's `stale_install` finding (legacy `mcp.json`/hook selectors, or a local-dist install behind the current/published runtime) is enforced by `install-cursor-plugin.sh` via a `doctor-check.ts cursor --stale` pre-check — exit 2 triggers a refresh + canonical re-registration, a healthy install is byte-untouched, and a registry-unreachable comparison warns as `registry_unreachable` (never `stale_install`, never an install failure). Canonical `@latest` installs never fail on version metadata.

## Workflow contract

- Task state lives under `.workit/` in the checkout; never edit it directly. Use the eight shared operation families (`workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, `workit_state`) with closed `action` enums. CLI surface is `workit <family> <action>` (hyphenated actions). There are no `workit flow` aliases.
- Start work with `task.start` then `policy.assess`. Policy is adaptive: reassess when evidence or constraints change; `policy.preview` is read-only. Behavior and mechanical-low-risk assessments add a `pre-pr-cleanup` requirement that gates `hosting.pull_request` (and close) on a fresh passing deslop check or an approved limitation waiver. Optional spec/plan docs may live under `docs/<slug>/`, but they are not required gates for every task.
- Task lifecycle is `unassessed` → `active`/`paused` → closed outcomes (`verified`, `accepted_limitations`, `stopped`). **Mandatory:** close the lead task with `task.close` once requirements are satisfied and repository verification passes — never finish while the task is still `active` or `paused`.
- Helpers are bounded: they cannot widen scope, record binding decisions, close or pause the lead task, assign further helpers, or resolve blocking findings on behalf of the lead. Managed workit mutations require `writer.acquire` ownership; arbitrary file writes are host-policy and pass through every adapter ungated.
- Binding decisions use host-native approval where available. OpenCode records native-question receipts; Cursor is policy-only by design (never fabricate delegated identity). Labels are compared semantically; host qualifiers such as `(Recommended)` are normalized at comparison time while preserving original label bytes. Ask binding questions receipt-shaped the first time: header exactly `Workit decision: <purpose>` with exactly two options, `approved` (description carries the approved content) and `rejected` — ordinary multi-option questions mint no receipt, and the recorder cannot match them later. If the decision recorder reports no native question receipt, record the approval in task progress and proceed — ask once, never re-ask to mint a receipt.
- Delegated authority is direct-child-only where the host exposes a trusted parent binding. OpenCode derives it from native session parentage; Cursor uses documented `subagentStart` identity for bounded assignment and never invents a cross-process token or receipt. Cursor `subagentStop` lacks a stable child identity, AskQuestion answers are policy-only, and arbitrary shell/Tab writes remain unavailable.
- Worker launches are reservation-bound. `prepareWorkerDispatch` /
  `commitWorkerDispatch` are host-only core methods (never a ninth family, never
  caller-supplied receipts): a host claims the slot of an exactly-`assigned`
  worker before spawning, and the in-process reservation settles once as either
  `started` with the observed child session or `not_started` (host-attested
  `stopped`, null session). OpenCode prepares at `tool.execute.before` for a
  native `task` call with exactly one attributable assigned worker; Pi prepares
  on the live handle immediately before spawn. Never mark a worker stopped from
  a null session, missing metadata, a cancellation string, or a lost
  reservation — those stay unresolved. Serial native `task` calls consume
  the oldest still-unbound worker first, but only within a single task:
  workers spread across tasks bind nothing, because no observed child can
  prove which task the coordinator intends. A `cancelling` worker vetoes
  launches from its own coordinator until a repeated cancel on the ended
  worker confirms its stop; other coordinators proceed. Review evidence
  only counts from a session that is neither the task creator's nor any
  other evidence recorder's.
- VCS routing is per-workspace: `workspaces.json` `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow, resolved in the order explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The active `vcs.json` carries no global `defaultTargetBranch`; a global default can no longer shadow a matched workspace's branchPolicy default. On GitHub, `prCreate` pushes the branch before `gh pr create` when `pr.pushBranch` is enabled (default), and a caller-supplied target equal to the resolved default is accepted even though protected. The runtime reads only the active `~/.config/workit/` config dir; legacy `~/.config/workflow-toolkit/` non-secret files were cleaned up once the active config passed status checks.
- Never use worktrees; use guarded in-place branch setup.
- Before any GitHub remote mutation (push, PR create/close, branch delete), verify the effective identity with `gh api user --jq .login` and confirm it matches the checkout's area account — `gh auth status` shows config metadata and can disagree with the credential actually used (keyring vs hosts file). Never trust the status display for this check.
