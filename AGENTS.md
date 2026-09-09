# Agent Contract

Multi-platform workit: OpenCode, Cursor, Codex CLI/desktop, Pi, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature | OpenCode | Cursor | Pi | CLI |
| --- | --- | --- | --- | --- |
| Approval | native `question` tool receipts | AskQuestion policy-only (`attested: false`) | native `ctx.ui.confirm`; headless `needs_input` | `--confirm` flags / TTY prompts |
| Implementation | subagent-driven via native `task`, delegated status from session parentage (`parentID` = recorded `coordinator_session_id`) | native `subagentStart` assignment and recognized Write/Edit/Delete interception; exact stop identity, AskQuestion answers, arbitrary shell writes, and Tab edits remain agent_guided/unavailable | known write/edit `tool_call` guard through shared core; shell writes remain agent_guided and no OS sandbox is provided | n/a (`workit flow` lifecycle only) |
| Lifecycle | `workit_plan_pause`/`resume`/`complete` (receipts) | `workit_plan_pause`/`resume`/`complete` (policy-only) | session start/compaction/shutdown continuity; supervised stock-Pi worker lifecycle | `workit flow pause\|resume\|complete` |
| Handoff | spawns a native OpenCode session | seeds a handoff prompt for the next agent | fresh stock-Pi review/worker processes; no nested worker launch | `workit handoff` (prints the destination prompt) |
| Tools | exact eight native core-backed `workit_<family>` tools | MCP server (`workit_*`) | exact eight native core-backed `workit_<family>` tools | `workit` commands |
| Shared MCP transport | n/a (native tools remain host-owned) | `@brainervirus/workit-mcp`; host wiring remains adapter-owned | n/a (native tools remain host-owned) | n/a |
| Skills | `skills.paths` + seven canonical policy-selected method skills (no vendored Superpowers dirs) | plugin `skills/` dirs | package `pi.skills` + seven canonical method skills | n/a |
| Branch policy init | `workit_init_apply action=branch_policy` | same MCP tool | same native core-backed tool family | wizard screen |
| Distribution | npm plugin entry (`opencode.json`) | Cursor Marketplace (git-discovered `.cursor-plugin/plugin.json`) | npm package manifest (`pi.extensions`/`pi.skills`) | npm bin (`npx`) |

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
through existing writer/scope-guarded native actions, with CLI identification
remaining read-only. Cursor and Codex expose the same contexts as
MCP resources (`workit://context/{kind}`); resource URIs cannot supply a
workspace or caller identity.

Codex CLI and desktop use the native plugin manifest, hooks, and shared MCP
transport. Hook enforcement is limited to documented covered events; the host
does not expose arbitrary-question receipts or attested writer delegation.

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

- Specs/plans live in `docs/<slug>/`; spec+plan are committed, `sdd/` is gitignored.
- Approvals bind to the exact SHA-256 digest of the approved document bytes; editing an approved spec/plan invalidates the approval and forces a fresh reapproval (drift resets the whole approval chain in spec-before-plan order).
- Execution lifecycle is exactly `pending` → `active` → `paused`/`active` → `completed`; completion requires a complete SDD ledger and passing repository verification. Subagent-driven product edits are intercepted while the plan is active.
- The execution contract mandates ending each run with `workit_plan_complete` (or the CLI `workit flow complete`) after the final task once the SDD ledger is complete (all task IDs appended) and repository verification passes; a run never finishes while the plan is still `active`.
- Each SDD task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite an active review range, and each progress line records the task's real `base..head` shas. `sddReviewPackage` and the progress-line validator reject empty (`base == head` or empty-diff) ranges with a structured error; the CLI exposes the review path as `workit flow review-package --plan <path> --base <sha> --head <sha> [--confirm]`.
- An ordinary post-plan session presents five choices; a handoff-destination session presents exactly four (never the originating Handoff option) and carries the handoff-destination marker.
- Approval evidence: OpenCode records native-question receipts; Cursor is policy-only by design (never fabricate delegated identity). Receipt and menu labels are compared semantically: host qualifiers such as `(Recommended)` and `(new session only)` are normalized at comparison time, and the original label bytes are preserved. Receipts are purpose-bound: each gate consumes the newest unconsumed fresh receipt for exactly its purpose (`spec-approval`, `plan-approval`, `execution-menu`, `plan-pause`, `plan-resume`, `plan-complete`); unrelated questions never authorize or mask a gate.
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
  reservation — those stay unresolved.
- VCS routing is per-workspace: `workspaces.json` `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow, resolved in the order explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The active `vcs.json` carries no global `defaultTargetBranch`; a global default can no longer shadow a matched workspace's branchPolicy default. On GitHub, `prCreate` pushes the branch before `gh pr create` when `pr.pushBranch` is enabled (default), and a caller-supplied target equal to the resolved default is accepted even though protected. The runtime reads only the active `~/.config/workit/` config dir; legacy `~/.config/workflow-toolkit/` non-secret files were cleaned up once the active config passed status checks.
- Never use worktrees; use guarded in-place branch setup.
