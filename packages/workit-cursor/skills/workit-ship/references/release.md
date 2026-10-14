# Release (git-flow, without the git-flow binary)

"Do the release" means start, commits, finish. Never publish unless asked.

1. `workit release start <version>` (`--hotfix` from production, `--track <t>`
   on a release track). It cuts `release/<version>` locally from develop (or
   the track's integration branch) and never pushes it.
2. Commit the version bump, the changelog section (`## [<version>]`) and the
   docs on it (`workit git commit -m "<msg>" -- <paths>`);
   late fixes go there too. Never commit
   to main or develop directly.
3. `workit release finish --dry-run` shows each step and whether it is done.
   `workit release finish` then merges into production (`--no-ff`), tags
   `<prefix><version>` with the changelog section, merges the tag back into
   develop (and every merge-back branch of the track), deletes the local
   branch, pushes production, develop and the tag atomically, creates the
   GitHub or GitLab release and verifies the tag on the remote. It needs the
   `release` and `push` grants; when blocked, report the grant it names.
4. Interrupted (a conflict, a failed push, no forge release yet): fix the
   cause and rerun the `resume` command it printed. Steps already done are
   skipped, never repeated.

`workit release publish` pushes the release branch, and is the only verb
that does. Use it only when the user asks (others commit to it, CI must run
on it). Outside git-flow, finish pushes the branch and opens a release PR
into the trunk instead.
