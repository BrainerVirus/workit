# Changelog

Workit keeps `## [Unreleased]` mergeable (the merge driver below) and moves its entries into
releases ([releasing the entries](#releasing-the-entries)).

## Merge driver

Two branches that each add an entry under `## [Unreleased]` conflict in git, because both
edit the same lines. Workit ships a git merge driver that keeps both sides' entries.

### Install

```bash
workit changelog driver install
```

This registers `merge.workit-changelog.driver` (`workit changelog merge %O %A %B`, falling back to
`git merge-file` with normal conflict markers when `workit` cannot run) in the
repo's local git config and adds `<path> merge=workit-changelog` to `.gitattributes` for each
configured changelog path (`changelogPath`, default `CHANGELOG.md`). Commit `.gitattributes` so
every clone gets the attribute; each clone runs the install once for the git config. Running it
again changes nothing.

### What the driver does

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

### Without the driver

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

## Releasing the entries

Entries written under `## [Unreleased]` stay there until something moves them. Two local verbs do
it; they read only the file and the repo's tags (`git for-each-ref`, `git show`), so they need no
forge, no grant and no Workit setup, and run headless in any CI.

```bash
workit changelog roll [--path CHANGELOG.md] [--tag-prefix v] [--preview]
workit changelog release 1.4.0 [--date 2026-11-25] [--notes-out notes.md] [--notes-format github] [--no-write]
```

- `roll` moves each `[Unreleased]` entry into the section of the first release tag whose
  changelog already holds it, dated by that tag (`## [1.3.0] - <tag date>`), and leaves the
  entries no tag holds. The result depends only on the tags, so it can run on any branch at any
  time, and a second run changes nothing. A clone without release tags has nothing to roll.
  `--preview` writes nothing (`--json` adds the would-be file as `data.after`).
- `release <x.y.z>` rolls, then moves the rest into `## [x.y.z] - <date>` (`--date`, default
  today in UTC) and fixes the compare links when the file has them. `--notes-out <file>` writes
  that version's entries as Markdown (`### Fixed` and its bullets) for the forge release body;
  `--notes-out -` prints them on stdout and everything else on stderr. `--notes-format github`
  puts them between `<!-- workit:changelog <tag> -->` and `<!-- /workit:changelog -->` and cuts
  them at 24,000 characters with a link to the compare view, for a GitHub release body that
  other generated notes follow; `workit release notes edit --from-changelog` later replaces that
  block in place. `--no-write` leaves the changelog as it is and still writes the notes.
- An empty `[Unreleased]` releases nothing: exit 0, the file untouched, no empty `[x.y.z]`
  heading, empty notes. A changelog with no `[Unreleased]` section says the section is missing,
  also with exit 0 and nothing written. A rerun of the same release (a retried CI job) changes nothing and
  writes the same notes, read back from the existing `[x.y.z]` section.
- Tags are `<prefix><x.y.z>`; the prefix is the workspace's release tag prefix (git-flow's
  `gitflow.prefix.versiontag`, default `v`), or `--tag-prefix`. `--path` names another
  changelog, such as one package's in a monorepo, relative to the current directory.
- Nothing is written, exit 1, when the result would double or drop text: an `[Unreleased]`
  entry its release's section already holds (a merge that put back what a roll moved) is named
  by its line (`CHANGELOG.md:12 is already under [1.3.0]`); delete it from `[Unreleased]` and
  rerun. A bad version or date exits 2.

The file is replaced through a temporary file and a rename, keeping its mode and CRLF line
endings. `workit doctor` warns (`changelog_released`) when `[Unreleased]` holds entries a release
tag already shipped, with their count and the oldest release, and names `workit changelog roll`;
it says nothing without release tags, in a shallow clone or without a changelog.

CI clones are often shallow and tagless: fetch the tags first (`fetch-depth: 0` on
`actions/checkout`, `GIT_DEPTH: 0` on GitLab, or `git fetch --tags`), or `release` moves every
entry into the new version, ones an older release shipped included. Pipeline setups for
semantic-release, release-please and GoReleaser are in
[delivery](delivery.md#changelog-in-automatic-releases).
