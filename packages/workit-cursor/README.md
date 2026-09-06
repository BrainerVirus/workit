# @brainervirus/workit-cursor

Cursor plugin for workit — shared MCP tools, documented native hooks, compact continuity, and adaptive method skills.

## Install

**Wizard (recommended)** — configures Cursor and/or OpenCode and installs the platform packages:

```bash
npx @brainervirus/workit-cli init
```

**npm (package)** — the package is published as `@brainervirus/workit-cursor`; its `.cursor-plugin/plugin.json` identifies the plugin as `workit` (display name `Workit`) and registers its MCP server, hook, rules, and skills. A local (non-npm) install lives at `~/.cursor/plugins/local/workit` and writes `enabled_plugins.workit = true`; the installer migrates exact legacy `workflow-toolkit` entries only after the replacement succeeds.

**Marketplace** — see [Marketplace](#marketplace).

**Manual** — add the MCP server to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "workit": {
      "command": "npx",
      "args": [
        "-y",
        "--prefer-online",
        "--package=@brainervirus/workit-cursor@latest",
        "workit-cursor-mcp",
        "${workspaceFolder}"
      ]
    }
  }
}
```

### Requirements

- **Node.js ≥ 24** — the MCP server and session-start hook are self-contained Node bundles invoked through `npx`.
- **Network** — `npx -y --prefer-online …@latest` resolves and downloads the package on first run in each environment; a machine that cannot reach the npm registry cannot start the MCP server or hook (see [Runtime](#runtime)).

## What it provides

- MCP server exposing exactly the eight shared operation families: `workit_task`, `workit_policy`, `workit_evidence`, `workit_finding`, `workit_decision`, `workit_worker`, `workit_writer`, and `workit_state`.
- One bounded native hook executable for session context, recognized product-write and shell interception, and native subagent lifecycle observations.
- Seven canonical `workit-*` method skills and the `workit-contract` rule.

## Host limitations

Cursor maps shared Workit operations through the shared MCP transport. AskQuestion remains policy-only (`agent_guided`), session start and compaction are non-blocking, and arbitrary shell writes, Tab edits, and exact subagent stop identity are unavailable. Known Write/Edit/Delete targets are enforced only when the documented Cursor hook inputs prove them. Native subagent delegation is read-only for reviewer/investigator assignments; implementer delegation is unavailable because Cursor exposes no attested writer identity or stable child-stop identity.

## Configuration

- Plugin metadata: `packages/workit-cursor/.cursor-plugin/plugin.json` (`name: "workit"`, `displayName: "Workit"`).
- MCP server: `mcp.json`.
- Session-start hook: `hooks/hooks-cursor.json`.
- Rule: `rules/workit-contract.mdc`.
- Skills: `skills/` (seven canonical Workit methods).

## Runtime

Cursor launches the MCP server and session-start hook through `npx`, so the shipped manifests contain no repository-relative `dist` paths:

- **MCP server** — `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp ${workspaceFolder}`. It speaks the MCP stdio protocol; `stdout` is reserved for protocol messages and diagnostics go to `stderr`.
- **Session-start hook** — `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`. It emits valid hook output and a diagnostic on runtime failure, and remains fail-open where Cursor's hook contract requires startup continuity.
- `npx` startup or network failure is surfaced by Cursor as an MCP/hook startup failure; Workit never silently substitutes stale local runtime code.

The runtime runs from `@latest` with the mandatory `--prefer-online` flag: Cursor reviews plugin metadata from Git, while npm serves the runtime. `--prefer-online` forces npx to check the registry so a stale cached `latest` resolution is never reused. See [Update review](#update-review).

## Capability boundaries

- Authority-sensitive MCP mutations require an attested caller. A standalone or ordinary Cursor launch stays usable for read-only inspection and reports `capability_unavailable` for authority mutations.
- Native hook enforcement is limited to documented inputs and blocking behavior. The plugin does not claim a `beforeMCPExecution` hook, cross-process receipts, delegation tokens, or automatic compaction restoration.

## Plugin layout

| Path                          | Contents                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| `mcp/` + `dist/mcp-server.js` | MCP server entry (built).                                     |
| `hooks/`                      | session-start hook manifest.                                  |
| `rules/workit-contract.mdc`   | Adaptive task contract and truthful Cursor capability limits. |
| `skills/`                     | Seven canonical adaptive Workit method skills.                |
| `.cursor-plugin/plugin.json`  | authoritative plugin manifest.                                |

## Package scripts

```bash
  bun run build   # bundle MCP + native hook entries and copy seven method skills
```

From the repository root, `bun run validate:cursor-marketplace` validates the tracked Marketplace artifact against the official Cursor JSON schemas and clean-checkout invariants (component paths, frontmatter, logo, sanitized vendor parity, no ignored-`dist` runtime references).

## Marketplace

The repository root carries `.cursor-plugin/marketplace.json`, indexing `packages/workit-cursor` (plugin `workit` / `Workit`). Cursor installs Marketplace plugins from Git and does not build the repository, so all declared skills, rules, and assets are tracked and validated in CI — the runtime is launched from npm as described in [Runtime](#runtime).

- **Installing from Marketplace** — a Marketplace admin adds the repository URL through Cursor's authenticated publisher flow; end users then install the plugin from the Cursor Marketplace UI, which reads `.cursor-plugin/plugin.json` and the tracked components directly from Git.
- **Submission** — Marketplace submission is a separate, later authenticated action at `https://cursor.com/marketplace/publish`. It is **not** performed here and no publication or acceptance is claimed; the repository is kept validated and submission-ready.
- **Update review** — Git plugin metadata (manifest, rules, skills, assets) is reviewed by Cursor on Marketplace updates, while the npm runtime runs from `@latest` with `--prefer-online`. The selector is shared across `mcp.json` and `hooks-cursor.json`, and a stale `latest` resolution is prevented by the mandatory `--prefer-online` flag.
  An MCP or hook startup failure with no network is an `npx`/registry reachability
  issue; inspect the host's startup diagnostics and retry after connectivity is
  restored.

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
