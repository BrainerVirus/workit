# Tag-driven releases

Some repositories release by pushing a version tag: a GoReleaser,
cargo-dist or other release workflow runs on `push: tags` and publishes the
forge release. They use github-flow with no release branch, so the git-flow
verbs (`workit release start|finish`) do not apply. `workit release tag`
creates and pushes the tag. An agent needs no raw `git tag` and gets no
permission prompt. The workspace's `release` grant decides whether it runs
([grants](grants.md)).

```bash
workit release tag v1.4.0 --dry-run    # the steps, CI verdict and grant, nothing changes
workit release tag v1.4.0              # tag origin/main and push the tag
workit release tag v1.4.0 --wait       # wait for trunk CI, tag, then wait for the release workflow and the forge release
workit release notes edit v1.3.0 --from-changelog   # backfill a published release's notes
```

## `workit release tag <vX.Y.Z>`

In order, it:

1. Refuses without the `release` grant and names it. Nothing is fetched first.
2. Fetches the remote trunk from the trunk's push remote (`origin` unless
   `main` pushes elsewhere); the checks, the push and the verification all use
   that remote, whatever the current branch tracks. The tag goes on the trunk
   tip. The forge reports CI on a branch tip only, so `--at <ref>` must name
   that tip (`at_not_tip` otherwise); only a push remote that is a local path
   takes an older commit the trunk has.
3. Reads CI on the trunk tip. Red CI (`ci_red`, with the `workit ci rerun`
   fix), CI still running (`ci_pending`) and no CI report on that commit
   (`ci_unknown`) are refused. With `--wait`, CI still running (or not yet
   reported, as right after a merge) is waited out first, within `--timeout`,
   and the tag goes on once it is green; red CI is still refused. Without
   `--wait`, the `ci_pending` refusal ends in `Retry as: workit release tag
   <vX.Y.Z> --wait`. A push remote that is a local path has no forge, so CI is
   not read there.
4. Refuses a tag that already exists here or on the remote (`tag_exists`):
   a release tag never moves.
5. When the repository keeps a changelog (`CHANGELOG.md` or the workspace's
   `changelogPath`), requires a `## [X.Y.Z]` section at that commit
   (`changelog_section_missing`). To fix it, move the Unreleased entries into
   that section on a branch, merge it through a PR, then rerun.
6. Creates an annotated tag whose message is the changelog section. No local
   branch moves, so the checkout can be on any branch, even behind.
7. Pushes the tag through `workit git push --release`, with the same grant,
   identity and remote-tip checks. When the push is refused, it deletes the
   local tag it made so a rerun can tag again.
8. With `--wait` (`--timeout`, default 30m for each wait; `--interval`,
   default 30s), it polls the workflow runs on the tag (GitHub Actions runs, GitLab tag
   pipelines). It fails when one fails and succeeds once the forge release
   exists. `--wait` can outlast a shell timeout, so run it in the background.

Workit never creates the forge release itself. The tag's release workflow
does.

## `workit release notes edit <tag> --from-changelog`

Puts the version's changelog section at the top of a published release's
body, between `<!-- workit:changelog <tag> -->` markers, and keeps the rest
of the body. When the markers are already there, it replaces the text between
them. A rerun with the same section changes nothing. The section is read at
the tag's commit, else on the fetched trunk, which suits a backfill of older
releases. It needs the `release` grant. It refuses when the section is
missing or the forge has no release for the tag.

## Hosts

Both verbs are `workit release` calls, so `workit setup` covers them on
every host. On Claude Code, the `Bash(workit release *)` allow rule covers
them and the auto-mode line names `workit release`. Cursor has the
`Shell(workit release)` allow and Codex the `workit release` prefix rule.
OpenCode's plugin allows Workit verbs, and Pi has no permission layer.
