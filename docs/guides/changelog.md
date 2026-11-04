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
- An entry one side removed from the base stays removed.
- Anything outside `## [Unreleased]` merges with git's normal three-way rules. When both sides
  edit the same released text, the driver exits 1 and leaves git's conflict markers, so
  nothing is lost silently.

`workit` must be on the `PATH` of the process that runs git.
