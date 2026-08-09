# @brainervirus/workit-opencode

OpenCode plugin for workit — workflow rails for agentic coding (specs, plans, YouTrack, CI-gated commits).

## Install

```jsonc
// opencode.json
{
  "plugin": ["@brainervirus/workit-opencode"]
}
```

## What it provides

- 12 `wk-*` commands (wk-init, wk-pr, wk-implement, wk-issue-update, ...)
- Per-turn enforcement rails (contract reminder, doc rendering, self-review gates, config guard)
- YouTrack/VCS integration with path-based workspaces

## Docs

Full usage: https://github.com/BrainerVirus/workit#readme
