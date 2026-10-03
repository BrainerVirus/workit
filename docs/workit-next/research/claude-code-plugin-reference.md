# Claude Code Plugin Architecture Reference
## Comprehensive Guide for Multi-Host Adapter Integration

**Version**: Claude Code 2.1.288+  
**Last Updated**: 2026-10-03  
**Documentation Source**: https://code.claude.com/docs/

---

## 1. PLUGIN STRUCTURE & MANIFEST

### Directory Layout (Standard Layout)

```
plugin-root/
├── .claude-plugin/
│   ├── plugin.json                 # Manifest (required for marketplace)
│   ├── marketplace.json            # (optional) To publish marketplace
│   └── .lsp.json                   # Language servers (merges with LSP configs)
├── .mcp.json                       # MCP server definitions (merges with manifest)
├── skills/
│   └── <skill-name>/SKILL.md       # Individual skill with frontmatter
├── commands/                        # (legacy) Flat .md command files
│   └── <name>.md
├── agents/
│   └── <agent-name>.md             # Subagent frontmatter + prompt
├── hooks/
│   └── hooks.json                  # Hook configuration (top-level "hooks" key)
├── bin/                            # Executables on PATH (NOT for claude.ai/Cowork)
│   └── <tool-name>
├── output-styles/                  # Output rendering overrides
│   └── <style-name>.md
├── workflows/                      # Workflow .js scripts
│   └── <workflow>.js
├── themes/                         # Theme JSON files
│   └── <theme>.json
├── monitors/
│   └── monitors.json               # Background monitors (interactive only)
├── lsp-servers/                    # (optional alternate location)
│   └── <name>.json
├── .lsp.json                       # LSP configs (inline or file paths)
├── settings.json                   # Default settings (agent, subagentStatusLine)
└── README.md                       # Documentation
```

### plugin.json Fields (Manifest Reference)

**Required:**
- `name` (string): kebab-case identifier, unique within marketplace; namespaces all components

**Metadata:**
- `displayName` (string): user-facing label (overrides `name` in UI)
- `version` (string): semantic version string; when set, pins users until changed
- `description` (string): short explanation
- `author` { `name`, `email?`, `url?` }
- `homepage` (string): documentation URL (must be valid URL)
- `repository` (string): source repo URL
- `license` (string): SPDX identifier (e.g., MIT, Apache-2.0)
- `keywords` (array): discovery tags

**Directory Listing (Anthropic's directory only):**
- `icon` (path): plugin icon (inside plugin)
- `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`: HTTPS URLs for directory listings

**Component Configuration:**
- `skills` (path|array): directories to scan; adds to default `skills/`
- `commands` (path|array|object): replaces default `commands/` scan; object form: `{ "cmd-name": { "source"|"content", "description", "argumentHint", "model", "allowedTools" } }`
- `agents` (path|array): agent .md files; replaces default
- `hooks` (path|object|array): inline hooks or `.json` files; merges with `hooks/hooks.json`
- `mcpServers` (path|object|array): inline server configs or `.json`/`.mcpb`/`.dxt` files; merges with `.mcp.json`
- `lspServers` (path|object|array): language server configs; merges with `.lsp.json`
- `outputStyles` (path|array): output style files; replaces default
- `workflows` (path|array): workflow .js files; replaces default
- `experimental.themes` (path|array): theme files; replaces default
- `experimental.monitors` (path|array): monitor definitions; defaults to `monitors/monitors.json`
- `experimental.evals` (path): eval directory (default `evals/`)

**Plugin Control:**
- `defaultEnabled` (boolean, default true): load when user hasn't set `enabledPlugins`
- `dependencies` (array): plugins required to be enabled; entries: `"name"` or `"name@marketplace"` or `{ "name", "marketplace", "version" }`
- `settings` (object): `agent` and `subagentStatusLine` defaults while enabled

**User Configuration:**
- `userConfig` (object): schema for `/config` dialog
  - Keys: identifiers (letters, digits, underscore; can't start with digit)
  - Fields per option:
    - `type` (required): "string", "number", "boolean", "directory", "file"
    - `title`, `description` (required)
    - `default?`, `required?`, `sensitive?`, `options?` (for string), `multiple?` (for string), `min`/`max` (for number)
  - Sensitive options stored in secure storage; reference as `${user_config.KEY}` or `$CLAUDE_PLUGIN_OPTION_<KEY>` in exec-form hook args

**Channels (Message Bridges):**
- `channels` (array): message channels bound to MCP servers
  - Each entry: `{ "server" (required), "displayName"?, "userConfig"? }`
  - `userConfig` same schema as plugin-level; substitutes into server env

**Metadata & Release:**
- `metadata` (object): free-form custom data (Anthropic catalog)

### Path Rules

**All component paths:**
- Must start with `./`
- Must exist and reside inside plugin root
- Exceptions: `skills` accepts `"."` (plugin root); `mcpServers` accepts `https://` bundle URLs
- Path containment checked at manifest validation; no `..` allowed (path traversal protection)

**Field-Specific Merging:**
- **Replace default**: `commands`, `agents`, `outputStyles`, `workflows`, `experimental.themes`, `experimental.monitors`
  - To keep default and add more: list default explicitly, e.g., `"commands": ["./commands/", "./extras/"]`
- **Add to default**: `skills` (always scans `skills/` + declared paths)
- **Merge with default**: `hooks`, `mcpServers`, `lspServers` (manifest entries merge into defaults)

### Environment Variables (Path Substitution)

Available in hook commands, MCP/LSP server configs, and skill/agent/command content:

- `${CLAUDE_PLUGIN_ROOT}`: Absolute path to installed plugin version (changes on update)
- `${CLAUDE_PLUGIN_DATA}`: `~/.claude/plugins/data/<plugin-id>/` (persistent, survives updates)
  - `<plugin-id>`: plugin name with non-alphanumeric replaced by `-`
- `${CLAUDE_PROJECT_DIR}`: Project root
- `${user_config.KEY}`: User config value (non-sensitive only in skill/agent content; NOT in shell-form hooks/monitor commands)

**Exported to Process Env:**
- Hook commands: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PLUGIN_OPTION_<KEY>` (all options uppercased)
- MCP stdio servers: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`
- LSP servers: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR`

**Quoting in Shell-Form Hooks:**
- Wrap in double quotes: `"${CLAUDE_PLUGIN_ROOT}/script.sh"`
- Exec form (with `args`) avoids shell re-parsing; preferred

---

## 2. DISTRIBUTION & MARKETPLACES

### Marketplace Structure

**marketplace.json Location:** `.claude-plugin/marketplace.json`

**Top-level Fields:**
```json
{
  "name": "my-marketplace",                    // Unique identifier (kebab-case)
  "displayName"?: "My Marketplace",            // Label in UI
  "description"?: "Plugin collection",
  "owner": { "name": "...", "email"?, "url"? },
  "plugins": [...],                            // Array of plugin entries
  "renames"?: { "old-name": "new-name", "legacy": null },
  "forceRemoveDeletedPlugins"?: false,        // Uninstall removed plugins
  "allowCrossMarketplaceDependenciesOn"?: []   // Trusted marketplaces for deps
}
```

**Plugin Entry Fields:**
- `name` (required): entry identifier (install as `name@marketplace`)
- `source` (required): where to fetch the plugin
  - Relative path: `"./plugins/my-plugin"` (inside marketplace)
  - `github`: `{ "source": "github", "repo": "org/repo", "ref"?, "sha"? }`
  - `git-subdir`: `{ "source": "git-subdir", "url": "...", "path": "...", "ref"?, "sha"? }`
  - `url`: `{ "source": "url", "url": "https://...", "ref"?, "sha"? }`
  - `archive`: `{ "source": "archive", "url": "https://...", "sha256"? }`
  - `npm`: `{ "source": "npm", "package": "name" }`
  - `command`: `{ "source": "command", "command": "...", "mode": "copy"|"link" }`
- `description`?: Short text
- `version`?: Override manifest version
- `displayName`?: Override manifest displayName
- `defaultEnabled`?: Override manifest defaultEnabled
- `skills`?, `agents`?, `commands`?, etc.: Component path restrictions
- `strict`?: false allows adding components if plugin.json present
- `headers`?: HTTP headers for archive auth
- `headersHelper`?: Script that mints auth headers (v2.1.238+)

**Validation:**
- Run `claude plugin validate ./marketplace` before hosting
- Required fields, JSON syntax, path existence, reserved names checked

### Distribution Workflows

**1. Direct Sharing (No Marketplace)**
- Share plugin directory or `.zip`
- User loads with `claude --plugin-dir ./path` or `--plugin-url https://...`
- No auto-update; user re-downloads for updates
- Good for small teams, rapid iteration

**2. Custom Marketplace (Git-Hosted)**
```bash
# Create marketplace
mkdir -p my-marketplace/.claude-plugin
cat > my-marketplace/.claude-plugin/marketplace.json
cd my-marketplace && git init && git add . && git push

# User adds marketplace (once)
claude plugin marketplace add owner/my-marketplace

# User installs plugin
claude plugin install my-plugin@my-marketplace

# User updates
claude plugin update my-plugin@my-marketplace      # or auto-update enabled
```

**3. Custom Marketplace (URL-Hosted)**
- Host `marketplace.json` at static URL (S3, etc.)
- User: `claude plugin marketplace add https://example.com/marketplace.json`
- Limitations: no relative-path sources, 5 MiB marketplace file limit, 256 MiB zip limit

**4. Marketplace on Shared Directory**
- Place marketplace on shared network drive
- User: `claude plugin marketplace add /Volumes/shared/plugins`
- Plugins load in-place; edits visible at next session start

**5. Organization Sync (claude.ai)**
- Publish through **Admin Settings → Plugins & Skills** (Team/Enterprise)
- Plugins sync to all machines via `claude.ai` account
- Restrict `bin/` directory (not supported on claude.ai)
- Accept limited source types

### Version Management & Auto-Update

**Version Resolution Order:**
1. Manifest `version` field (highest priority)
2. Marketplace entry `version` field
3. Source-derived version:
   - Git commits: 12-char SHA (+ path hash for `git-subdir`)
   - Archive: SHA-256 digest (from `sha256` pin or download)
   - npm: `unknown` (no version tracking)
   - Relative path in git marketplace: commit SHA
   - Non-git local: `unknown`

**Pinning Behavior:**
- Set `version` to pin users to exact string; bump to release
- Omit `version` to track commits; users auto-receive new commits
- Don't set version in both `plugin.json` AND marketplace entry (error on validate)

**Auto-Update:**
- Off by default; user enables via `/plugin` **Marketplaces** tab or admin sets in managed settings
- Runs ~10 minutes after first message in session
- Skips if `DISABLE_AUTOUPDATER=1` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- Command-source plugins re-run once per session (not dependent on auto-update setting)
- Mid-session updates: hooks/MCP/LSP keep old path until `/reload-plugins`

**Release Channels:**
- Host separate `marketplace.json` files with different `name` values pointing to different git branches
- Users add either marketplace; Claude Code identifies by name
- Set different versions per marketplace or omit version to track branches

### Local Development

**Option 1: `--plugin-dir` (Single Session)**
```bash
claude --plugin-dir ./my-plugin
# Edits take effect with `/reload-plugins`
```

**Option 2: Load from Folder of Plugins**
```bash
claude --plugin-dir ./plugins  # Requires v2.1.265+
# Loads all subdirs with .claude-plugin/plugin.json
```

**Option 3: Skills Directory (Every Session)**
```bash
claude plugin init my-plugin
# Creates ~/.claude/skills/my-plugin/
# Auto-loads; invoke as /my-plugin

# Add sub-skills with --with skills
claude plugin init my-plugin --with skills
```

**Option 4: Local Marketplace**
```bash
# Create marketplace locally
mkdir -p ./local-marketplace/.claude-plugin
# Add plugin to plugins/ subdirectory
# Create marketplace.json

# Add it
claude plugin marketplace add ./local-marketplace

# Install and work
claude plugin install my-plugin@local-marketplace

# Changes to in-place plugins visible at next session/reload
```

---

## 3. HOOKS: LIFECYCLE AUTOMATION

### Hook Events Reference

**Session-Level:**
- `SessionStart`: Fires when session begins or resumes
  - Input: `source` (startup|resume|clear|compact|fork), `model`
  - Output: `additionalContext`, `sessionTitle`, `watchPaths`, skill reload
  - Runs in background; fast (no UI block)

- `SessionEnd`: Fires when session closes
  - Input: completion status
  - Output: cleanup actions (no blocking)

**Turn-Level:**
- `UserPromptSubmit`: Before Claude processes user prompt
  - Input: `user_message`
  - Decision: Allow (`exit 0`), block (exit 2 or JSON deny), modify via JSON
  - Blocking shows message to user

- `Stop`: After Claude finishes responding
  - Input: `last_assistant_message`
  - Decision: Block continuation, inject feedback via `additionalContext`

- `StopFailure`: When Claude stops due to error
  - Input: error type (rate_limit, authentication_failed, etc.)
  - Decision: None (informational)

- `PreCompact`: Before context compaction
  - Input: compaction reason, estimated token savings
  - Decision: Allow (exit 0), block (exit 2)

**Tool-Level:**
- `PreToolUse`: Before tool executes (blocking point)
  - Input: `tool_name`, `tool_input`, `tool_use_id`
  - Decision: Allow, deny, ask (via `permissionDecision`), modify `tool_input`
  - Can replace with `additionalContext`
  - Matcher: tool name, regex for MCP tools (`mcp__plugin_<plugin>_<server>__<tool>`)

- `PostToolUse`: After tool succeeds (non-blocking)
  - Input: `tool_name`, `tool_input`, `tool_result`
  - Decision: Replace result, block next turn, inject context
  - Matcher: tool name

**Special:**
- `PermissionRequest`: Tool needs permission (auto-approval)
  - Input: `tool_name`, `tool_input`, `permission_level`
  - Decision: `allow` or `deny` in hook output

- `Notification`: Desktop notification event
  - Input: notification type, content
  - Matcher: `permission_prompt`, `idle_prompt`, etc.

- `FileChanged`: File system watch
  - Input: `file_path`, `change_type` (modified|created|deleted)
  - Matcher: glob patterns (e.g., `.env|.envrc`)

- `SubagentStart`: Subagent begins
  - Input: agent type (Explore, General-purpose, custom name)
  - Output: context injection, permission config

### Hook Configuration Format

**Location:** `hooks/hooks.json` or inline in `plugin.json` or settings

**File Format** (hooks/hooks.json):
```json
{
  "hooks": {
    "EVENT_NAME": [
      {
        "matcher": "PATTERN",
        "if": "PERMISSION_RULE",
        "hooks": [
          { "type": "command|http|mcp_tool|prompt|agent", ... }
        ]
      }
    ]
  }
}
```

**Inline in plugin.json:**
```json
{
  "hooks": [
    "./hooks/custom.json",
    {
      "PostToolUse": [
        {
          "matcher": "Write|Edit",
          "hooks": [...]
        }
      ]
    }
  ]
}
```

### Hook Types (Handlers)

**1. Command Hook**
```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/script.sh",  // Exec form: no shell
  "args": ["arg1", "arg2"],
  "async": false,
  "timeout": 600,        // seconds (default 600)
  "shell": "bash"        // bash or powershell (default bash)
}
```

- **Exec form**: `args` present → direct spawn, no shell reinterpretation
- **Shell form**: `args` absent → passes to shell, pipes/&&/etc. work
- Shell form: wrap paths in quotes: `"${CLAUDE_PLUGIN_ROOT}/script.sh"`
- Exit code 0 = success; 2 = blocking error; others = non-blocking
- Stdout JSON parsed if valid; else treated as text output
- Stderr goes to debug log only

**2. HTTP Hook**
```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/pre-tool-use",
  "headers": { "Authorization": "Bearer $TOKEN" },
  "allowedEnvVars": ["TOKEN"],  // Vars that can be read
  "timeout": 30
}
```

- POST request with hook input as JSON body
- Response must be valid JSON
- Headers: credential-like names removed from env (unless in allowedEnvVars)

**3. MCP Tool Hook**
```json
{
  "type": "mcp_tool",
  "server": "my-server",
  "tool": "security_scan",
  "input": {
    "file_path": "${tool_input.file_path}"
  }
}
```

- Calls MCP tool before/after tool use
- Input can reference `${tool_input.*}`, `${tool_result.*}`, etc.
- Output substitutes into `additionalContext` or decision

**4. Prompt Hook**
```json
{
  "type": "prompt",
  "prompt": "Analyze this: $ARGUMENTS",
  "model": "claude-opus-5"
}
```

- Sends prompt to Claude (separate model invocation)
- Non-blocking; response returned as `additionalContext`

**5. Agent Hook**
```json
{
  "type": "agent",
  "prompt": "Validate: $ARGUMENTS"
}
```

- Delegates to subagent
- Full tool access, separate context window

### Matcher Patterns

**Exact Match:**
```json
"matcher": "Bash"
```

**Alternatives (pipe or comma):**
```json
"matcher": "Write|Edit"
```

**Regex for MCP Tools:**
```json
"matcher": "mcp__plugin_my-plugin_database__query"  // Full callable name
"matcher": "mcp__plugin_.*_database__.*"            // Regex
```

**Match All:**
```json
"matcher": "*"
```

**By Event Type:**
- Tool events: tool name
- `SessionStart`: `startup|resume|clear|compact|fork`
- `Notification`: `permission_prompt`, `idle_prompt`
- `SubagentStart`: agent name (Explore, General-purpose, custom)
- `FileChanged`: glob patterns (`.env|.envrc`)

### Hook JSON Output Format

All hook types can return JSON with these fields:

```json
{
  "continue": true,
  "stopReason": "Why to stop processing",
  "systemMessage": "Warning shown to user",
  "terminalSequence": "\033]777;notify;Title;Body\007",
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask|defer",
    "permissionDecisionReason": "Reason shown to user",
    "additionalContext": "Text injected into prompt",
    "updatedInput": { "key": "new-value" },
    "decision": "block"
  }
}
```

**Exit Codes:**
- `0`: Success; JSON controls behavior
- `2`: Blocking error (prevents action on events that support it)
- Others: Non-blocking error; JSON still controls behavior

---

## 4. SKILLS: CAPABILITY EXTENSION

### SKILL.md Frontmatter Reference

```yaml
---
name: skill-identifier                # kebab-case; invoke as /plugin:skill-name
description: "When to use this skill"  # Critical for auto-invocation
disable-model-invocation: true         # true = manual only, false/absent = Claude can invoke
user-invocable: true                   # false = Claude-only (background knowledge)
context: fork                          # fork = isolated subagent context
agent: Explore                         # Which subagent type (fork mode only)
background: false                      # true = stay in background
arguments: [issue, branch]             # Named positional arguments ($0, $1, $issue, $branch)
paths: "src/** tests/**"               # Only trigger when working with these files
effort: high                           # Override effort level for skill execution
model: claude-3-5-sonnet-20241022     # Override model
allowed-tools: Bash(git *) Read       # Pre-approve tools; no prompts
disallowed-tools: WriteFile           # Remove tools from availability
---
```

**Frontmatter Fields:**
- `name` (required): kebab-case; becomes part of `/plugin-name:skill-name`
- `description` (required): determines when Claude auto-invokes; be specific
- `disable-model-invocation`: true = only `/skill-name` works; false/absent = Claude sees it
- `user-invocable`: false = background knowledge, Claude-only
- `context: fork`: run in isolated subagent (no conversation history; skill prompt = task)
- `agent`: Subagent type for fork mode (Explore, General-purpose, or custom)
- `background`: true = don't surface to user, keep running
- `arguments`: array of named arguments; reference as `$0`, `$1`, `$issue`, etc.
- `paths`: glob patterns; skill only triggers when working with these files
- `effort`: override effort level for execution
- `model`: specific model override (sonnet, opus, haiku, full model ID)
- `allowed-tools`: Pre-approve without prompts (grant clears after next user message)
- `disallowed-tools`: Remove tools from availability

### Skill Invocation

**Manual:**
```
/skill-name
/skill-name arg1 arg2
```

**With Named Arguments:**
```yaml
---
name: fix-issue
arguments: [issue-number, priority]
---

Fix issue #$0 at priority $priority...
```

**String Substitutions:**
- `$0`, `$1`, ... (positional)
- `$ARGUMENTS` (all args)
- `$<name>` (named arguments)
- `${CLAUDE_SESSION_ID}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, etc.

### Dynamic Content Injection

**In-line command substitution:**
```markdown
Current branch: !`git branch --show-current`
```

**Multi-line commands:**
````markdown
```!
git log --oneline -10
git status
```
````

### Plugin-Namespaced Skills

In plugins, skills gain the plugin prefix:
- Skill at `my-plugin/skills/review/SKILL.md`
- Invoked as `/my-plugin:review`
- Prevents naming collisions across plugins

**Component Visibility:**
- Skills descriptions always loaded (for auto-invocation)
- Full content lazy-loaded on invoke
- Content persists in context across turns (until compaction)
- Re-invocation: if unchanged, adds note instead of re-sending

---

## 5. SUBAGENTS (AGENTS)

### agents/*.md Frontmatter Reference

```yaml
---
name: code-reviewer                    # Identifier; reference as @"code-reviewer (agent)"
description: "What this agent does"    # When Claude delegates
tools: Read, Grep, Bash               # Allowed tools (whitelist)
disallowedTools: Write, Edit          # Remove specific tools
model: sonnet                          # sonnet, opus, haiku, fable, or full model ID
permissionMode: default                # default, acceptEdits, auto, dontAsk, plan
skills: [api-conventions, patterns]   # Pre-load skills at startup
memory: project                        # user, project, or local (persistent memory)
maxTurns: 20                           # Max agentic turns
isolation: worktree                    # worktree = isolated git operations
background: false                      # true = keep in background
mcpServers: [playwright, github]      # MCP servers available
hooks:                                 # Lifecycle hooks
  PreToolUse: [...]
omitClaudeMd: false                   # Skip CLAUDE.md hierarchy
---
```

**Key Fields:**
- `name` (required): identifier
- `description` (required): determines auto-delegation
- `tools`: whitelist (defaults to all available)
- `disallowedTools`: blacklist
- `model`: override model selection
- `permissionMode`: 
  - `default`: prompt user for each permission
  - `acceptEdits`: auto-accept file edits in working dir
  - `auto`: background classifier
  - `dontAsk`: auto-deny
  - `plan`: read-only (exploration mode)
- `skills`: pre-load skill content
- `memory`: project/user/local persistent memory
- `isolation: worktree`: isolated git ops (parallel worktree)
- `background`: true = run without interrupting main session
- `mcpServers`: available MCP servers

### Invocation

**Automatic Delegation:**
- Claude detects task matches agent description

**Natural Language:**
```
Use the code-reviewer agent to review auth changes
```

**@-Mention (Guarantee Execution):**
```
@"code-reviewer (agent)" look at the auth changes
```

**Session-Wide:**
```bash
claude --agent code-reviewer
```

Or in settings:
```json
{
  "agent": "code-reviewer"
}
```

### Context Isolation

**Default (Fork Mode):**
- Subagent doesn't see conversation history
- Skill/prompt content = task
- Returns results to main conversation

**Worktree Isolation:**
```yaml
isolation: worktree
```
- Isolated git operations
- Separate working directory
- Enables parallel work on same repo

### Nested Subagents

Subagents can spawn their own subagents (up to 3 levels deep by default).

**Configure Depth:**
```json
{
  "env": {
    "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "2"
  }
}
```

**Concurrency:**
- Default: 20 concurrent subagents
- Configure with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`

---

## 6. MCP SERVERS IN PLUGINS

### Stdio Server Configuration

**In plugin.json `mcpServers`:**
```json
{
  "mcpServers": {
    "database-tools": {
      "command": "${CLAUDE_PLUGIN_ROOT}/bin/server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_URL": "${user_config.db_url}",
        "DEBUG": "1"
      }
    }
  }
}
```

**Or in .mcp.json:**
```json
{
  "mcpServers": {
    "database-tools": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
      "env": { ... }
    }
  }
}
```

**Fields:**
- `command`: binary/script path (no spaces unless starts with `/`; use `args` for args)
- `args` (optional): array of arguments
- `env` (optional): environment variables
- `timeout` (optional): startup timeout in ms
- Variable substitution: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_PROJECT_DIR}`

### Tool Naming Conventions

**For Plugin-Bundled Servers:**
- Server registered as: `plugin:<plugin-name>:<server-name>`
- Full callable tool name: `mcp__plugin_<plugin>_<server>__<tool>`
  - All non-alphanumeric chars replaced with `_`
- Example: plugin `my-plugin`, server `database-tools`, tool `query` → `mcp__plugin_my_plugin_database_tools__query`

**For Standard (Non-Plugin) Servers:**
- Registered as: `<server-name>`
- Tool name: `mcp__<server>__<tool>`

### Tool Naming in Hooks/Matchers

**Permission Rules:**
```json
{
  "if": "mcp__plugin_my-plugin_database-tools__query"
}
```

**Hook Matchers (must use registered server name):**
```json
{
  "matcher": "plugin:my-plugin:database-tools"  // Not bare server name
}
```

**MCP Tool Matchers (regex):**
```json
{
  "matcher": "mcp__plugin_my_plugin_.*__.*"
}
```

### Environment Variables in MCP Servers

**Exported to Server Process:**
- `CLAUDE_PLUGIN_ROOT`: plugin installation path
- `CLAUDE_PLUGIN_DATA`: persistent data directory
- Any env vars declared in `env` field

**User Config Substitution:**
```json
{
  "env": {
    "API_TOKEN": "${user_config.api_token}"  // Works in MCP
  }
}
```

### Permission Management for MCP Tools

**In Hook Config (`if` field):**
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__.*__write.*",
        "if": "mcp__plugin_db_server__write_data",
        "hooks": [...]
      }
    ]
  }
}
```

**Pre-Approval (Skill `allowed-tools`):**
```yaml
---
name: database-admin
allowed-tools: mcp__plugin_db_server__query mcp__plugin_db_server__update
---
```

---

## 7. PLUGIN VALIDATION & TESTING

### Plugin Validation (CLI)

```bash
# Basic validation
claude plugin validate ./my-plugin

# Strict mode (fail on warnings; useful for CI)
claude plugin validate ./my-plugin --strict

# Validate marketplace
claude plugin validate ./my-marketplace
```

**Checks:**
- JSON syntax and schema compliance
- Required fields (name, version, description, author)
- Component paths exist and don't escape plugin root
- Plugin names don't conflict with Anthropic's reserved names
- Marketplace entries match plugin names
- LSP, MCP, monitor configs (v2.1.283+)

**Exit Codes:**
- 0: Validation passed
- 1: Validation failed
- 2: Unexpected error

### Plugin Evals (Testing Framework)

**Run Evals:**
```bash
claude plugin eval ./my-plugin

# With baseline comparison
claude plugin eval ./my-plugin

# Specific cases
claude plugin eval ./my-plugin --case "Case name"

# Filter by tags
claude plugin eval ./my-plugin --tag important

# CI-friendly JSON output
claude plugin eval ./my-plugin --json results.json --threshold 0.75

# Concurrency
claude plugin eval ./my-plugin -j 4

# Custom eval directory
claude plugin eval ./my-plugin --eval-dir quality/tests
```

**Suite Layout:**
```
plugin-root/
└── evals/
    ├── <case-name>/
    │   ├── prompt.md                      # Frontmatter + prompt
    │   ├── graders/
    │   │   ├── accuracy.md               # Grader (regex, llm, etc.)
    │   │   └── performance.md
    │   ├── case.yaml                     # Advanced config
    │   └── mocks/
    │       └── <server>/
    │           └── <tool>.md             # Mock tool
    └── mocks/
        └── shared-mocks/
```

**prompt.md Frontmatter:**
```yaml
---
name: "API Design Review"
tags: [api, design]
plugins: ["../.."]                    # Plugin under test
runs: 3                               # Number of runs
max_turns: 10                         # Max turns per run
timeout_seconds: 300
allowed_tools: Read, Grep, Bash       # Restrict tool access
model: claude-opus-5                  # Override model
append_system_prompt: |
  You are a strict API reviewer
---

[Prompt body]
```

**Grader Types:**

1. **regex**: Pattern matching
   ```yaml
   ---
   type: regex
   pattern: "API.*design"
   flags: i                     # case-insensitive
   match: contains              # contains, not_contains, count:N
   target: last_message        # last_message (default), trace, files
   ---
   ```

2. **tool_used**: Tool invocation
   ```yaml
   ---
   type: tool_used
   tool: Read
   input_match: '\.py$'        # Regex on input JSON
   min: 1
   max: 5
   ---
   ```

3. **tool_order**: Call sequence
   ```yaml
   ---
   type: tool_order
   before: Read
   after: Write
   ---
   ```

4. **file_exists**: File creation
   ```yaml
   ---
   type: file_exists
   path: "**/*.test.ts"
   ---
   ```

5. **llm**: Judge model votes
   ```yaml
   ---
   type: llm
   criteria: "Did the agent identify all security issues?"
   focus: tool_result          # what judge focuses on
   ---
   ```

6. **baseline**: Compare to baseline
   ```yaml
   ---
   type: baseline
   baseline_file: baseline.json
   criteria: "Is this implementation better?"
   ---
   ```

**Mock MCP Servers:**
```markdown
<!-- evals/mocks/my-server/query.md -->
---
expect:
  sql: 'SELECT.*users'      # Guard: abort if input doesn't match
error: false
---

[{"name": "Alice"}, {"name": "Bob"}]
```

**Output:**
- `results/<timestamp>/aggregate-result.json`: v1 results schema
- `results/<timestamp>/report.html`: interactive HTML report
- Published to claude.ai artifacts (if supported)
- Exit codes: 0 (pass), 1 (below threshold), 2 (partial/auth error)

### Headless/CLI Mode (E2E Testing)

**Bare Mode (Faster Startup):**
```bash
claude --bare --plugin-dir ./my-plugin -p <<< "/my-plugin:skill-name"
```

**Headless Session:**
```bash
claude -p --plugin-dir ./my-plugin <<< "Prompt text"
```

**With Arguments:**
```bash
echo "Do something" | claude -p --plugin-dir ./my-plugin
```

**Settings Inline:**
```bash
claude --settings '{"model": "opus"}' -p --plugin-dir ./my-plugin
```

**Exit Codes:**
- 0: Success
- 1: Error
- 130: Interrupted

---

## 8. RECENT FEATURES & v2.1.288 ENHANCEMENTS

### Prompt Caching for Plugins

- Plugin components (skills, agents) benefit from prompt cache
- Cache invalidated on plugin reload or version change
- Reloading warns about cache cost

### Request Timeout Control (v2.1.288+)

**LSP Servers:**
```json
{
  "requestTimeout": 60000,  // milliseconds; default 60s
  "restartOnCrash": true,
  "maxRestarts": 5
}
```

### Archive Plugin Sources (v2.1.224+)

- Direct download of `.zip` plugins
- Pre-authentication with `sha256` pin
- Support for long-lived or rotating credentials via `headersHelper`

### MCP Bundle Support

- `.mcpb` and `.dxt` bundle format
- Reference in `mcpServers` as path or URL
- Extracted to `.mcpb-cache/` under plugin root

### User Config Options (v2.1.271+)

```json
{
  "type": "string",
  "options": ["production", "staging", "development"],
  "default": "production"
}
```

- Fixed-choice field in `/config`
- Prevents invalid user inputs

### Monitor Support (Interactive Sessions Only)

```json
{
  "experimental": {
    "monitors": [
      {
        "name": "build-status",
        "command": "${CLAUDE_PLUGIN_ROOT}/scripts/monitor.sh",
        "description": "Build status watcher",
        "when": "on-skill-invoke:deploy"
      }
    ]
  }
}
```

- Background processes
- Not available on Bedrock, Vertex, or Foundry

### Marketplace Entry `headersHelper`

- Dynamic authentication (v2.1.238+)
- Mint tokens per-install
- Supports short-lived credentials

### Plugin Relevance Suggestions

- Marketplace can declare signals matching project structure
- Claude Code suggests plugins when conditions met
- Admin enables via managed settings

### Organization Sync from GitHub/GitLab

- distribute plugins via organization GitHub connection
- No user git credentials needed
- Stricter component support (bin/ not allowed)

---

## 9. BEST PRACTICES FOR MULTI-HOST ADAPTERS

### Adapter-Specific Considerations

**1. Plugin Naming & Namespacing**
- Use consistent prefix (e.g., `workit-adapter`)
- All subskills prefixed: `/workit-adapter:skill-name`
- Prevents collisions in multi-plugin environments

**2. Component Isolation**
- Keep shared TS core in vendor or lib dir (not under plugin)
- Use `${CLAUDE_PLUGIN_DATA}` for host-specific state
- Store lifecycle/session data in `${CLAUDE_PLUGIN_DATA}`

**3. Cross-Platform Executables**
- Ship binaries for each platform in `bin/` or symlink from `${CLAUDE_PLUGIN_DATA}`
- Use `command` source to handle platform differences
- Don't use `bin/` if distributing on claude.ai/Cowork

**4. MCP Server Initialization**
- Pin versions in `package.json` or npm lockfile
- Handle graceful degradation if MCP server fails
- Test stdio vs HTTP transports on each host

**5. Hook Reliability**
- Make hooks idempotent (safe to run multiple times)
- Use exec form with `args` to avoid shell injection
- Validate input before running external tools

**6. Skill Documentation**
- Be specific in `description` for auto-invocation tuning
- Include examples in skill body
- Use `disable-model-invocation: true` for commands requiring exact invocation

**7. Testing in CI**
```bash
# Validate
claude plugin validate --strict ./adapter

# Run evals
claude plugin eval ./adapter --json results.json --threshold 0.80

# Test headless
echo "Test prompt" | claude -p --plugin-dir ./adapter
```

**8. Version Management**
- For published adapter: increment `version` on each release
- For local development: omit `version` to track commits
- Tag releases: `claude plugin tag` creates `workit-adapter--v1.2.0`

**9. Marketplace Distribution**
- Publish to organization marketplace for team access
- Use `dependencies` for required plugins
- Provide clear `README.md` + `homepage` URL

---

## 10. DOCUMENTATION LINKS

### Official References
- **Plugin Overview**: https://code.claude.com/docs/en/plugins/overview.md
- **Plugin Components**: https://code.claude.com/docs/en/plugins/components.md
- **Manifest Reference**: https://code.claude.com/docs/en/plugins/manifest-reference.md
- **Create Marketplace**: https://code.claude.com/docs/en/plugins/create-marketplace.md
- **Host Marketplace**: https://code.claude.com/docs/en/plugins/host-marketplace.md
- **Hooks Guide**: https://code.claude.com/docs/en/hooks-guide.md
- **Hooks Reference**: https://code.claude.com/docs/en/hooks.md
- **Skills Guide**: https://code.claude.com/docs/en/skills.md
- **Subagents Guide**: https://code.claude.com/docs/en/sub-agents.md
- **MCP Integration**: https://code.claude.com/docs/en/mcp.md
- **Plugin Evals**: https://code.claude.com/docs/en/plugin-evals.md
- **Plugin CLI Reference**: https://code.claude.com/docs/en/plugins/cli-reference.md
- **Plugin Loading**: https://code.claude.com/docs/en/plugins/loading.md
- **Plugin Troubleshooting**: https://code.claude.com/docs/en/plugins/troubleshooting.md

### Quick Command Reference
```bash
# Development
claude --plugin-dir ./path            # Load for session
claude plugin init my-adapter          # Scaffold ~/.claude/skills/
claude plugin validate ./my-adapter    # Validate manifest + components

# Marketplace
claude plugin marketplace add ./local   # Add local marketplace
claude plugin install name@marketplace # Install plugin

# Testing
claude plugin eval ./my-adapter        # Run eval suite
claude plugin eval --json results.json # CI output

# Deployment
claude plugin marketplace add owner/repo # Add GitHub marketplace
claude plugin tag                       # Tag release
```

---

**Document Version**: 2.1.288+  
**Last Verified**: October 2026  
**Maintainer**: Claude Haiku 4.5
