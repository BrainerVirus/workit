# @brainervirus/workit-pi

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../../LICENSE)

Workit native extension for Pi (stock 0.85.1 package contract) — eight core-backed operation tools, fourteen method skills, session/compaction continuity, and a coordinator that supervises fresh reviewer/investigator processes plus explicitly scoped implementers.

## Requirements

- **Node.js ≥ 24**
- **Pi coding agent 0.85.1** (peer dependency)

## Install

Install this package alongside the Pi peer dependency. Pi discovers the
extension and skills through the `pi` manifest section in `package.json`
(`./dist/workit.js` plus `./skills`); see the Pi documentation for how it
resolves extension packages in your setup.

## Notes

- Only an observed child process may acquire the shared writer; cancellation or restart uncertainty blocks replacement ownership.
- The extension is a workflow control, not an OS sandbox: shell writes stay agent-guided.
- Approval uses native `ctx.ui.confirm`, or `needs_input` when headless.
