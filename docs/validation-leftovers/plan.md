# Validation leftovers — fix plan

Eight open findings from the v1 validation sweep, fixed smallest-first in
commit `c3429e8` (this file follows in a second commit).

## Sequence

1. Investigate all eight; confirm root causes in code (no guessing).
2. Product call (native question): Pi worker model stays ambient and
   documented — Document-ambient over Pin-explicitly.
3. Implement: receipt bus events → manager-bin detection → dead cursor
   main → Pi cancel symmetry + ambient docs → Codex precision + pin
   check → Pi test gaps.
4. Full suite (`bun test`, 1265 green) plus lint, format, `tsc`.
5. Single fresh-context reviewer with forgery/correctness review.
6. Resolve the eight findings fixed on the validation task.
7. Close this task verified.

## Dependencies

- (6) needs (4) green and (5) approved.
- (7) needs (6) with nothing left open.
- No pushes without approval; branch `feature/workit-v1` stays local.

## Next action

Close verified, then continue the validation task (phase 2 live runs still
need a go-ahead; Codex weekly limit applies).
