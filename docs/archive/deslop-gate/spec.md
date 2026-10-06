# Deslop gate (pre-pr-cleanup)

Behavior and mechanical-low-risk tasks gain a `pre-pr-cleanup` requirement.

- Rule: dimension `verification`, `acceptanceAllowed: true`, `before: dependent_action`, `dependentAction: hosting.pull_request`.
- Satisfaction: fresh passing `check` evidence linked to the requirement id (the workit-deslop pass), or a native-approved `limitation` decision linked to the requirement (explicit waiver) which evaluates to `accepted_limitation`.
- Enforcement: `WorkitCore.reserveAction` reads the operation from the decision's `approvedContent`; every stored requirement whose `dependentAction` equals that operation must be `satisfied` or `accepted_limitation`. Otherwise the reservation fails `requirements_unsatisfied` with `requirementIds` and the approval decision stays unconsumed, so the same approved action can be retried after the evidence or waiver is recorded. All hosts and the CLI inherit this from core.
- Routing: the method registry selects `workit-deslop` whenever the rule is present; the bootstrap already routes the pre-PR moment.
- Closure: existing closure rules already block unsatisfied requirements; a waiver therefore forces an `accepted_limitations` outcome instead of `verified`.
- Matching is structural (requirement id and operation), never prose.
