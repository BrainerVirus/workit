# Named checks and the `ci` group

`workit check <name>` runs a command declared in `.workit/checks.json` and records
the result as evidence. A repo also declares **groups**: named lists of those
checks that `workit check <group>` runs one after another.

```json
{
  "checks": {
    "lint": ["bun", "run", "lint"],
    "knip": ["bun", "run", "knip"],
    "test": ["bun", "run", "test"]
  },
  "groups": { "ci": ["lint", "knip", "test"] },
  "resources": { "heavy": ["knip"] }
}
```

## Mirror CI locally

Declare the checks your CI workflow runs as the `ci` group, then run
`workit check ci` before you push. A PR then never goes red on a gate that never
ran locally.

- Each member runs as its own recorded check: one evidence row per name.
- Light members (`resources.light`, default lint, typecheck, format) run first
  and never take the heavy lease. Heavy members (`test`, `build`, `packaging`,
  and what `resources.heavy` adds) queue for it, so a session holding the lease
  delays only them.
- Every member runs even when one fails. The exit code is 1 if any failed, and
  the last line names them (`FAILED typecheck (2/3 passed)`).
- `--json`, `--full`, `--wait`, `--no-wait` and `--timeout` pass through to each
  member.
- A repo with no `ci` group gets exit 2, the configured check names and how to
  declare the group.

A group member must be a configured check, and a group cannot share a name with
a check.
