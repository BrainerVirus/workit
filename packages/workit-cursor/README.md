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

- MCP server exposing exactly the eight shared `workit_*` operation families.
- One bounded native hook executable for session context, recognized product-write and shell interception, and native subagent lifecycle observations.
- Seven canonical `workit-*` method skills and the `workit-contract` rule.

## Host limitations

Cursor maps shared Workit operations through the shared MCP transport. AskQuestion remains policy-only (`agent_guided`), session start and compaction are non-blocking, and arbitrary shell writes, Tab edits, and exact subagent stop identity are unavailable. Known Write/Edit/Delete targets and native subagent starts are enforced only when the documented Cursor hook inputs prove them.

## Configuration

- Plugin metadata: `packages/workit-cursor/.cursor-plugin/plugin.json` (`name: "workit"`, `displayName: "Workit"`).
- MCP server: `mcp.json`.
- Session-start hook: `hooks/hooks-cursor.json`.
- Rules: `rules/` (`workit-contract.mdc`, `cursor-todowrite.mdc`, `no-worktrees.mdc`, `sdd-docs-path.mdc`).
- Skills: `skills/` (seven canonical Workit methods).

## Runtime

Cursor launches the MCP server and session-start hook through `npx`, so the shipped manifests contain no repository-relative `dist` paths:

- **MCP server** — `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-mcp ${workspaceFolder}`. It speaks the MCP stdio protocol; `stdout` is reserved for protocol messages and diagnostics go to `stderr`.
- **Session-start hook** — `npx -y --prefer-online --package=@brainervirus/workit-cursor@latest workit-cursor-session-start`. It emits valid hook output and a diagnostic on runtime failure, and remains fail-open where Cursor's hook contract requires startup continuity.
- `npx` startup or network failure is surfaced by Cursor as an MCP/hook startup failure; Workit never silently substitutes stale local runtime code.

The runtime runs from `@latest` with the mandatory `--prefer-online` flag: Cursor reviews plugin metadata from Git, while npm serves the runtime. `--prefer-online` forces npx to check the registry so a stale cached `latest` resolution is never reused. See [Update review](#update-review).

## Security and data handling

- **Secrets** — tokens are stored in files with mode 600 (`~/.config/workit/*.token`) and are never printed by tools; edit them locally.
- **Logs** — a persistent JSONL journal records redacted structured diagnostics under the configuration directory; Cursor keeps `stderr` diagnostics for protocol safety, and `stdout` remains reserved for the MCP/hook protocol (the logger never writes to it).
- **External interactions** — Git/VCS (branch resolution, PR/MR creation) and YouTrack (task updates, time logging) happen only when you invoke the corresponding tools; local setup copies files under `~/.cursor/plugins/local/workit` and `~/.config/workit/`.

## Plugin layout

| Path | Contents |
| --- | --- |
| `mcp/` + `dist/mcp-server.js` | MCP server entry (built). |
| `hooks/` | session-start hook manifest. |
| `rules/` | 4 `.mdc` rules. |
| `skills/` | Seven canonical adaptive Workit method skills. |
| `.cursor-plugin/plugin.json` | authoritative plugin manifest. |

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
- **Troubleshooting** — `workit doctor` (or the `workit_doctor` tool) reports installation health including runtime, token, VCS/YouTrack, and log-writability checks; it exits nonzero on failure. An MCP/hook startup failure with no network is an `npx`/registry reachability issue, not a Workit defect.

## Auto-load repair

Workit self-heals stale Cursor plugin installs so the workflow features never silently drop out of auto-load (CA-01/CA-04):

- **Detection** — the doctor's `stale_install` finding reads the installed `~/.cursor/plugins/local/workit` directory and fails on a legacy `--package=` pin in the plugin's own `mcp.json`, a sessionStart hook running a legacy selector, or a local-dist install behind the current/published runtime; each finding carries the exact repair step.
- **Self-heal** — `install-cursor-plugin.sh` runs `doctor-check.ts cursor --stale` as a pre-check: exit 2 (stale) triggers a refresh of the plugin directory plus a rewrite of the workit MCP/hook entries to the canonical `@latest` + `--prefer-online` selector, preserving unrelated MCP servers; a healthy install is byte-untouched.
- **Fail-open** — the one network probe (the npm registry version comparison for local-dist installs) never blocks an install: an unreachable registry warns as `registry_unreachable`, never `stale_install` and never a failure. Canonical `@latest` installs skip the probe entirely — the selector resolves fresh at launch, so the installed `package.json` version is metadata, not a freshness signal.

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
