# <Feature> plan

Spec: `docs/<slug>/spec.md` · Goal: <one sentence>

A plan records decisions, not code: per slice the branch, what it touches, its
acceptance, how it is verified, and what it depends on (workit-shape
`references/slicing.md`). Independent slices fan out (workit-fanout);
dependent ones stack (`workit stack plan <bottom> … <top>`).

## Global constraints

- <project-wide requirement, one line each>

---

### S1 <type>/<slug>  (base: main)

Touches: <areas, not line numbers>
Acceptance:
- Given <state>, When <action>, Then <observable result>
Verify: `workit check test`; verify-<app> "<feature>"
Decisions: <ledger refs or one-line rulings>

| Slice | Branch | Depends on | Status |
| --- | --- | --- | --- |
| S1 | <type>/<slug> | — | pending |
