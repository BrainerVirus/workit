# Changelog merge driver

Two branches that each add an entry under `## [Unreleased]` conflict in git, because both
edit the same lines. Workit ships a git merge driver that keeps both sides' entries.

## Install

```bash
workit changelog driver install
```

This registers `merge.workit-changelog.driver` (`workit changelog merge %O %A %B`, falling back to
`git merge-file` with normal conflict markers when `workit` cannot run) in the
repo's local git config and adds `<path> merge=workit-changelog` to `.gitattributes` for each
configured changelog path (`changelogPath`, default `CHANGELOG.md`). Commit `.gitattributes` so
every clone gets the attribute; each clone runs the install once for the git config. Running it
again changes nothing.

## What the driver does

- Under `## [Unreleased]`, each `###` heading appears once. Entries keep ours first, then
  theirs; an identical entry on both sides appears once.
- An entry one side removed from the base stays removed, also when that side removed its whole
  `###` group.
- An entry that either side moved into a `## [X.Y.Z]` section since the branches split is
  never put back under `## [Unreleased]`, so rebasing a changelog roll onto a branch that still
  lists the rolled entries keeps one copy, in its release. Releases older than the merge base
  do not count: a new entry that repeats an old one ("Dependencies bumped.") is kept. When
  entries are left out, the driver prints one line to stderr, such as
  `workit: changelog merge left 2 Unreleased entries out, already in [1.2.0]`.
- Anything outside `## [Unreleased]` merges with git's normal three-way rules. When both sides
  edit the same released text, the driver exits 1 and leaves git's conflict markers, so
  nothing is lost silently.

`workit` must be on the `PATH` of the process that runs git.

## Without the driver

`workit git rebase` applies the same merge itself, so a branch rebases without the driver too.
When every conflict is in a configured changelog path and merges cleanly as above, it stages the
merge, continues and names the file in its output. Any other conflict aborts the rebase and
leaves the branch where it was.

`workit pr merge` on a PR that conflicts with its base only in the changelog rebases it the same
way, pushes it with `--force-with-lease` and stops, printing `workit ci wait` and the same merge as
the next commands; any other conflict is refused with an exact `workit git rebase` command.

`workit fanout check` never reports a configured changelog path as out of a slice's scope: the
lead writes that entry on each slice branch.

## Adding an entry

`workit changelog apply --entries '{"Fixed": ["…"]}'` adds bullets under `## [Unreleased]`
(`--entries -` reads the JSON from stdin, a pipe included). When `pr create` refuses with
`changelog_required`, rerun it with `--changelog "<Section>: <entry>"` instead: it adds the entry,
commits it with a conventional subject commitlint accepts, pushes and opens the PR in one call
([changelog gate](delivery.md#changelog-gate)).
