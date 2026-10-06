# @brainervirus/workit-pi

[![CI](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml/badge.svg)](https://github.com/BrainerVirus/workit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/BrainerVirus/workit/blob/main/LICENSE)

[Workit](https://github.com/BrainerVirus/workit) for Pi (stock 0.85.1): a native extension with the
seven task families plus read-only `workit_context`, the eleven method
skills, session and compaction continuity, and a coordinator that launches
fresh reviewer/investigator processes and scoped implementers. Requires
Node.js 24+.

```bash
pi install npm:@brainervirus/workit-pi
pi install ./packages/workit-pi -l --approve   # local checkout
```

Pi discovers the extension and skills from the package's `pi` manifest
(`./dist/workit.js`, `./skills`). Pi project trust still gates mutations.
The `tool_call` boundary applies branch policy and the
[before-write gate](https://github.com/BrainerVirus/workit/blob/main/docs/guides/verification.md) to write, edit and recognizable bash
writes (unrecognized shell writes stay agent-guided; an extension is not an OS
sandbox). Tools take flat fields.
Delivery limits come from Pi's permissions plus the workspace
[grants](https://github.com/BrainerVirus/workit/blob/main/docs/guides/grants.md).
