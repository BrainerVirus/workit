# Blast radius beyond the diff

A small diff is not a small risk. For every surface the change touches, name
the one fact it is safe because of and run the proof.

1. List what the change touches: exported symbols and every caller
   (`git grep -nw <symbol>`), shared state, wire or file formats, config keys,
   migrations, CLI flags and outputs, public types.
2. For each: the fact it is safe because of (a type boundary, an existing test
   that covers the path, an unreachable branch, a version gate) and the command
   that proves it.
3. Run the proofs with `workit check -- <cmd>` so the result is observed.
4. Anything you could not prove is a finding labeled UNPROVEN with what would
   prove it. Never fold it into "looks safe".
5. A fix belongs at the shared root (one guard that every caller passes
   through), not copied per caller.

Example note:

| Surface | Safe because | Proof |
| --- | --- | --- |
| `parseRange()` (4 callers) | callers pass validated input; new branch only for `--since` | `workit check -- bun test range.test.ts` exit 0 |
| `config.json` `since` key | additive, old readers ignore unknown keys | `workit check -- bun test config-compat.test.ts` exit 0 |
| GitLab adapter | UNPROVEN - no fixture for relative dates | add a `gitlab/relative-since.json` fixture |
