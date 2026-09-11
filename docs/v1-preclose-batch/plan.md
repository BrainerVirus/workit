# v1 pre-close batch — implementation plan

Spec: `docs/v1-preclose-batch/spec.md`. Lead implements (writer held);
reviewer worker per slice group; full suite + review before close.

## Sequence

1. Skill pipeline recon: single source + per-host copy/build (read build
   scripts, manifests, pi extension, codex plugin).
2. Slice A — triage: assess guidance (code comments/defaults where
   mechanical) + `workit-plan` tiers + override test.
3. Slice B — aliases: opencode `commands/`, cursor `commands/` + manifest
   key, pi `registerCommand` x5, codex `$` docs, README fix. Parity test.
4. Slice C — babysit: `--no-babysit` decline flag, watch/classify/merge
   core helpers (gh/GitLab), `workit-babysit` skill, auto-start wiring.
5. Slice D — skills: 7 new SKILL.md + 4 upgrades + style-guide pass.
   Ship through the same pipeline as existing skills (no new mechanism).
6. Slice E — template: `spec-template.md` (Change line, SHALL/GWT,
   skip marker, N/A architecture, 7-item checklist).
7. Slice F — youtrack: body fetch in `youTrackContext` (summary +
   description + status), fail-closed, unit test with stubbed request.
8. Slice G — steer: `workit-steer` skill + `workit-plan` clause.
9. Scope bug bonus: `scopeCovers` trailing-slash normalization + test
   (found live: `docs/` never covered `docs/x`).
10. Full suite + lint/format/tsc, fresh-context review, resolve, close.

## Dependencies

- (2)-(8) all need (1) recon first.
- (9) verify → (10). (10) needs all slices merged.
- No pushes without approval; branch `feature/workit-v1` stays local.

## Next action

Slice recon, then A.
