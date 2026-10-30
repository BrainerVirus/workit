# Changelog and docs before the PR

Read the workspace's steps in `workit grant show` (`changelog:` and `docs:`).
Both default to `off`: then skip this file. Do them last, on the final diff,
right before `workit pr create`.

## Changelog (`changelog: update|create`)

A PR whose title type is chore, test, docs, ci, build or style (no `!`) needs
no entry. Under `update`, a repo without CHANGELOG.md needs none either.
Otherwise:

1. Write one bullet per change a user can see, leading with what they can now
   do, not with internals: "Added: `workit pr create --no-changelog <reason>`
   skips the changelog check with a recorded reason", not "refactor gate
   module".
2. Apply it only with `workit changelog apply --entries '{"Added": ["…"]}'`
   (categories: Added, Changed, Deprecated, Removed, Fixed, Security). It
   merges into `## [Unreleased]` and creates the Keep a Changelog file when it
   is missing. Never clobber CHANGELOG.md: never rewrite, reorder or delete an
   existing entry, and never hand-edit released sections.
3. Commit it (`workit git commit -m "docs(changelog): …" -- CHANGELOG.md`)
   with the change, then push.

`workit pr create` refuses a user-facing PR without a new Unreleased bullet
(`changelog_required`) and prints the exact `workit changelog apply` command.
When the PR truly needs no entry, pass `--no-changelog "<why>"`: the reason is
written into the PR body.

## Docs (`docs: when-user-facing`)

Only when user-facing behavior changed (same types as above):

1. Read the diff against the base and list each public surface it touches:
   commands, flags, settings, outputs, defaults.
2. Fix only lines the diff makes false in README.md and the guides. Do not
   write new prose for a surface no doc covers: name it under "Docs" in the
   PR body as uncovered instead.
3. A pass that changed nothing is still reported in the PR body: "Docs:
   checked README.md, docs/guides/x.md; nothing the diff made false."
