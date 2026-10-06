# @brainervirus/workit-mcp

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

Shared MCP stdio transport for [Workit](https://github.com/BrainerVirus/workit): the seven task
families (`workit_task`, `workit_policy`, `workit_evidence`,
`workit_finding`, `workit_decision`, `workit_worker`, `workit_state`) as
flat tools (one depth-1 object: `action` plus primitive fields, e.g.
`workit_policy {action:"assess", riskTier:"normal", behaviorChange:true}`), and read-only contexts (`git`, `pr`, `youtrack`, `github_issue`,
`gitlab_issue`, `changelog`, `release`, `affected`) as
`workit://context/{kind}` resources. Requires Node.js 24+.

```bash
workit-mcp
```

Cursor and Codex register it; Claude Code does not by default (add it to your
own settings to opt in). Mutations are unavailable to unattested callers; they
run through the `workit` CLI.
