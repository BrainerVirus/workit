# Workit v1 host capability matrix

Generated from adapter fixtures. Fixture revision: `workit-v1-2026-09-09`.

Unknown or untested cells fail the applicable baseline rather than reading as supported.

| Capability | opencode | cursor | codex_cli | codex_desktop | pi | cli |
| --- | --- | --- | --- | --- | --- | --- |
| arbitrary_shell_write | agent_guided | unavailable | unavailable | unavailable | agent_guided | — |
| compact_context | — | agent_guided | agent_guided | agent_guided | — | — |
| direct_child_workers | enforced | — | — | — | — | — |
| interactive_decision | enforced | agent_guided | agent_guided | agent_guided | enforced | enforced |
| known_product_writes | unavailable | unavailable | unavailable | unavailable | — | — |
| native_subagent_start | — | enforced | agent_guided | agent_guided | — | — |
| native_subagents | — | agent_guided | agent_guided | agent_guided | — | — |
| product_write_interception | — | — | — | — | enforced | — |

## Adapter notes

### opencode

- **interactive_decision** (enforced): native question answers are observed by tool.execute.after and consumed once
- **direct_child_workers** (enforced): nested native task launches are denied and observed child sessions are parent-bound
- **known_product_writes** (unavailable): file writes are host-policy; OpenCode native permissions govern them, workit no longer gates write tools
- **arbitrary_shell_write** (agent_guided): OpenCode does not expose a reliable interception boundary for every shell mutation

### cursor

- **interactive_decision** (agent_guided): Cursor does not expose AskQuestion answers to Workit hooks or MCP
- **known_product_writes** (unavailable): file writes are host-policy; the Cursor hook no longer gates write tools or shell commands
- **native_subagents** (agent_guided): reviewer/investigator starts are bounded; Cursor implementer delegation is unavailable and subagentStop lacks a stable child identity
- **native_subagent_start** (enforced): Cursor subagentStart enforces explicit reviewer/investigator markers; implementer delegation is unavailable
- **arbitrary_shell_write** (unavailable): Only explicitly parsed shell targets are interceptable; arbitrary shell writes are not provable
- **compact_context** (agent_guided): sessionStart injects context; preCompact can only show a bounded user reminder

### codex_cli

- **interactive_decision** (agent_guided): Codex hooks expose no native arbitrary-question answer receipt
- **known_product_writes** (unavailable): file writes are host-policy; PreToolUse allows write tools
- **native_subagents** (agent_guided): Codex reports stable child identities, but cannot block creation or bind a writer
- **native_subagent_start** (agent_guided): SubagentStart supplies identity and bounded read-only guidance; continue:false cannot stop creation
- **arbitrary_shell_write** (unavailable): Only covered known tool inputs are interceptable; specialized and write_stdin paths are not complete
- **compact_context** (agent_guided): SessionStart source=compact is the single restore path

### codex_desktop

- **interactive_decision** (agent_guided): Codex hooks expose no native arbitrary-question answer receipt
- **known_product_writes** (unavailable): file writes are host-policy; PreToolUse allows write tools
- **native_subagents** (agent_guided): Codex reports stable child identities, but cannot block creation or bind a writer
- **native_subagent_start** (agent_guided): SubagentStart supplies identity and bounded read-only guidance; continue:false cannot stop creation
- **arbitrary_shell_write** (unavailable): Only covered known tool inputs are interceptable; specialized and write_stdin paths are not complete
- **compact_context** (agent_guided): SessionStart source=compact is the single restore path

### pi

- **product_write_interception** (enforced): Pi exposes a before-tool boundary for known built-in write tools; it enforces project trust while file targets stay host-policy.
- **interactive_decision** (enforced): Pi supplies a native confirmation receipt when dialog UI is available.
- **arbitrary_shell_write** (agent_guided): Pi extensions do not sandbox arbitrary shell commands.
