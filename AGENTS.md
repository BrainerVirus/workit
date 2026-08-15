# Agent Contract

Multi-platform workit: OpenCode, Cursor, and the CLI share one core. Every feature must ship with **feature parity across hosts, implemented the best way each host allows**.

## Host-native adaptation

| Feature | OpenCode | Cursor | CLI |
| --- | --- | --- | --- |
| Approval | native `question` tool receipts | AskQuestion policy-only (`attested: false`) | `--confirm` flags / TTY prompts |
| Lifecycle | `workflow_plan_pause`/`resume`/`complete` (receipts) | `workflow_plan_pause`/`resume`/`complete` (policy-only) | `workit flow pause\|resume\|complete` |
| Handoff | spawns a native OpenCode session | seeds a handoff prompt for the next agent | `workit handoff` (prints the destination prompt) |
| Tools | native plugin tools | MCP server (`workflow_*`) | `workit` commands |
| Skills | `skills.paths` + vendored dirs | plugin `skills/` dirs | n/a |
| Branch policy init | `workflow_toolkit_init_apply action=branch_policy` | same MCP tool | wizard screen |
| Distribution | npm plugin entry (`opencode.json`) | Cursor Marketplace (git-discovered `.cursor-plugin/plugin.json`) | npm bin (`npx`) |

## Parity rules

1. Core logic lives in `packages/workit-core/src/core/`; adapters only map host-native surfaces to it. Never re-implement core logic per host.
2. A new feature adds: the core module, both host adapters, and the CLI surface (command or wizard screen), plus tests proving identical outcomes (parity test).
3. Docs (README), this file, and the CHANGELOG Unreleased section are updated in the same change.
4. Marketplace distribution is host-native: Cursor discovers the plugin from Git (`.cursor-plugin/plugin.json` + tracked skills/rules/assets), OpenCode installs the npm plugin entry, and the CLI ships as an npm bin. The tracked Marketplace artifact is validated in CI by `validate:cursor-marketplace` against the pinned official Cursor JSON schema snapshots (`test/fixtures/cursor-schemas/`). `marketplace.json` `plugins[].source` is repo-root-relative (the directory containing `.cursor-plugin/`), not `.cursor-plugin/`-relative. Never claim Marketplace publication or acceptance; keep the repository submission-ready but not submitted.
5. Cursor runtime execution uses the exact reviewed pin `@brainervirus/workit-cursor@0.8.0`; each Marketplace release bumps that pin deliberately after the npm artifact is public — never fall back to a mutable `latest` dist-tag.

## Workflow contract

- Specs/plans live in `docs/<slug>/`; spec+plan are committed, `sdd/` is gitignored.
- Approvals bind to the exact SHA-256 digest of the approved document bytes; editing an approved spec/plan invalidates the approval and forces a fresh reapproval (drift resets the whole approval chain in spec-before-plan order).
- Execution lifecycle is exactly `pending` → `active` → `paused`/`active` → `completed`; completion requires a complete SDD ledger and passing repository verification. Subagent-driven product edits are intercepted while the plan is active.
- An ordinary post-plan session presents five choices; a handoff-destination session presents exactly four (never the originating Handoff option) and carries the handoff-destination marker.
- Approval evidence: OpenCode records native-question receipts; Cursor is policy-only by design (never fabricate delegated identity). Receipt and menu labels are compared semantically: host qualifiers such as `(Recommended)` and `(new session only)` are normalized at comparison time, and the original label bytes are preserved.
- VCS routing is per-workspace: `workspaces.json` `resolveWorkspace` maps `work`-glob repos to GitLab/`develop`/gitflow and `personal`-glob repos to GitHub/`main`/github-flow, resolved in the order explicit workspace `vcs.defaultTargetBranch` → workspace branchPolicy default → global `vcs.json` → preset defaults. The active `vcs.json` carries no global `defaultTargetBranch`; a global default can no longer shadow a matched workspace's branchPolicy default. On GitHub, `prCreate` pushes the branch before `gh pr create` when `pr.pushBranch` is enabled (default), and a caller-supplied target equal to the resolved default is accepted even though protected. The runtime reads only the active `~/.config/workit/` config dir; legacy `~/.config/workflow-toolkit/` non-secret files were cleaned up once the active config passed status checks.
- Never use worktrees; use guarded in-place branch setup.
