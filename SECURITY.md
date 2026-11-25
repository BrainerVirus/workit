# Security policy

## Supported versions

Security fixes land in the latest minor release of the `@workit-dev/*`
packages (the CLI and every host plugin ship together on one version line).
Older minors and the retired `@brainervirus/workit-*` packages get no fixes:
upgrade with `workit upgrade`
([migration guide](docs/guides/migration.md#100-the-packages-move-to-workit-dev)
for the old scope).

## Reporting a vulnerability

Please do not report a vulnerability in a public issue, pull request or
discussion. Report it privately through
[GitHub security advisories](https://github.com/BrainerVirus/workit/security/advisories/new)
for `BrainerVirus/workit`. If that form is not available to you, contact the
maintainer ([@BrainerVirus](https://github.com/BrainerVirus)) privately first
and ask for a private channel.

Include what you can of:

- the affected package and version (`workit --version`, and `workit doctor --json`
  with anything private removed);
- the host (Claude Code, OpenCode, Codex, Cursor, Pi or the CLI alone) and the
  operating system;
- what an attacker gains: for example, an agent raising its own grants,
  writing a guarded file (`workspaces.json`, its seal, approvals), getting past
  a host permission rule or a Workit hook, or reading a secret Workit should
  redact;
- the smallest steps that reproduce it, and whether it needs a malicious
  repository, a malicious agent, or local access.

You get an acknowledgement when the report is read, and the fix is published
as a GitHub security advisory with the release that carries it.

## Scope

Workit's grants, seal and hooks stop an honest agent from going past what you
allowed; they are not a sandbox against an adversarial process on your
account. The hard boundary is your host's own permission prompt
([trust model](docs/guides/grants.md#trust-model)). A report that a process
with your user's rights can edit Workit's files is expected behaviour unless
it gets past a host permission rule or a native deny rule `workit setup`
wrote ([hosts guide](docs/guides/hosts.md#host-permissions-workit-setup)).
