# Archive

Specs and plans from earlier eras, kept for history. None of them describes
the shipped system. The 3.0–7.0 redesign record is
[`docs/workit-next/`](../workit-next/spec.md), itself a dated record not kept
in step with the code; usage lives in the
[README](../../README.md) and [guides](../guides/). Paths inside these
documents refer to their original locations under `docs/`.

| Folder | Era | Status | Superseded by |
| --- | --- | --- | --- |
| [`workit-reliability-overhaul/`](workit-reliability-overhaul/spec.md) | 0.x (Aug 2026) | Shipped as the reliability release | `workit-v1` |
| [`workit-v1/`](workit-v1/spec.md) | 1.0 rewrite | Shipped; host matrix and qualification moved to [`docs/qualification/`](../qualification/qualification.md) | `adaptive-workit`, then `workit-next` |
| [`challenge-redesign/`](challenge-redesign/spec.md) | 1.x | Shipped as `workit-challenge` | `workit-shape` skill (5.0) |
| [`deslop-gate/`](deslop-gate/spec.md) | 1.x | Shipped as a pre-PR gate | `workit-deslop` skill (5.0) |
| [`trackers/`](trackers/spec.md) | 1.x | Shipped as `github_issue`/`gitlab_issue` context | README context section |
| [`parallel-delegation/`](parallel-delegation/proposal.md) | 1.x | Proposal, not built | `workit-fanout` skill (5.0) |
| [`workit-runtime-reliability/`](workit-runtime-reliability/spec.md) | 1.x | Shipped | `adaptive-workit`, then the 4.0 event store |
| [`workit-reliability-delta/`](workit-reliability-delta/spec.md) | 1.x | Shipped | `adaptive-workit` |
| [`route-denial-scope/`](route-denial-scope/spec.md) | 1.x | Not built | `structural-fixes` |
| [`structural-fixes/`](structural-fixes/spec.md) | 1.x–2.x | Partly shipped | `workit-next` (6.0 grants) |
| [`opencode-v2/`](opencode-v2/spec.md) | 2.x | Shipped; V1 adapter removed in 3.0 | [Hosts guide](../guides/hosts.md#opencode) |
| [`auto-approval/`](auto-approval/spec.md) | 2.x | Shipped, removed in 6.0 | [Autonomy grants](../guides/grants.md) |
| [`adaptive-workit/`](adaptive-workit/spec.md) | 2.x | Shipped | `workit-next` (3.0–6.0) |
