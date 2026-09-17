# Structural Fixes: End Patch-Cycling in Task Flow, Approvals, and Gates - Spec

**Status:** draft direction from the audit synthesis (user-directed to write);
implementation follows as separately tasked work. Supersedes `docs/route-denial-scope/spec.md`
(Option A `.workit/` marker gate — do not implement as written).

## Context

Two live incidents proved the approval and enforcement flows manufacture the
friction they claim to prevent:

- Session `ses_f5511cf6cffeR50J3yk4bRjekr`: manual `git checkout -b` in an
  unrelated checkout denied by the globally-installed plugin's unconditional
  `shellRouteIntent` denial (`packages/workit-opencode/src/plugin.ts:591-599`).
- The `feature/route-denial-scope` setup trace: a granted approval died on the
  five-minute proposal clock, the identical proposal was re-asked (same
  `descriptorDigest` twice), a stated "commit it" was re-asked instead of
  recorded, and a user-ordered commit invalidated the recorded branch approval.

A full audit followed: 5 challenging code auditors (approval lifecycle,
state machine, gates/enforcement, policy/requirements, cross-audit
challenger) plus 3 harness surveys (Gentle-AI, pstack/poteto, Claude Code /
Codex CLI / Cursor / Aider / Cline / Continue / Copilot). All evidence is
recorded on paused audit task `1940a873`. Convergent thesis: workit has ~6
missing invariants papered over by ~100 patches. This spec names the
invariants. Anything that adds another CA-numbered patch without closing one
is rejected at review.

## Decisions

1. **Content-addressed approvals, no clocks.** An approval binds
   `(operation, user payload minus volatile resolved fields, plan-step list)`
   and is valid until its bound content changes or it is explicitly revoked —
   never because a clock ticked or a process restarted. Clocks appear only in
   observability (age display), never in validity. Replaces the five-minute
   proposal/receipt TTLs, restart-loss, and near-miss freshness diagnostics
   (`packages/workit-opencode/src/tools/workit.ts:92,284-285,843-876`).
2. **Idempotent proposals.** One `descriptorDigest` opens at most one question:
   re-resolution returns the existing pending proposal instead of minting a
   new one. Retires byte-identical re-asks
   (`workit.ts:1007-1010,1066-1087`; `external-action.ts:474-486`).
3. **Stated choices are protocol, not prose.** A plain-language user choice is
   recorded as `stated_choice` provenance with a conversation ref and carries
   sufficient authority for low-risk actions; the adapter never re-asks a
   settled choice to mint a receipt
   (`workit.ts:193-248,323-329`; `task-engine.ts:1196-1197`).
4. **State-change re-resolution without re-approval.** Content refs bind
   intent; when bytes drift only through the approved operation's own effects,
   the approval auto-carries with the diff shown. Only genuinely new semantic
   changes need a fresh receipt
   (`authority.ts:419-495,542-543`; `task-contract.ts:450-459`).
5. **Single chain reservation.** One lease covers branch setup through plan
   commits to PR creation, carrying the snapshot; each step checks
   lease-still-valid instead of its own field list. Retires `plan_steps`
   string lists, per-step consumption, and base/HEAD/dirty triple-binding
   patches (`external-action.ts:324-466,494-520`;
   `external-action-effects.ts:820-841,1323-1331`).
6. **Session-scoped enforcement by default.** Every denial and mutation checks
   `(session → task → checkout)` attribution that worker dispatch already
   computes. Replaces the `.workit/` fs-marker heuristic, the
   workdir-resolution gap, and the babysit-for-unenforced-routes doctrine;
   outside an attributed session, commands are silently allowed
   (`plugin.ts:589-598`; `packages/workit-pi/src/tools.ts:577-589`;
   `packages/workit-codex/hooks/workit-hook.ts:352-360`).
7. **Self-identifying runtime.** Doctor and stale-install logic compare the
   running core bundle hash against the registry hash — never launcher argv,
   pin forms, or path spellings. Collapses the path/pin/symlink/`/var`-alias
   patch family to one check.
8. **Core-owned state machine, generated adapters.** Core exports the
   recognizer, proposal store, and settlement machine; adapters supply only
   `(sessionDir, askNativeQuestion, observeSpawn)`. Skill text lives in one
   source file with hash-verified copies. A fix touching >1 host directory is
   rejected at review — the abstraction is wrong, not the hosts.
9. **Git as undo, standing rules, human gates for irreversible effects only.**
   Persist settled choices as scoped standing rules (never re-receipt); allow
   local branches freely and gate remote/protected refs; commit-per-edit or
   checkpoints instead of the worktree ban; writer/dispatch reservation only
   for true parallel implementers on one checkout (lead-only flows pass
   through with attribution); deslop and babysit become hook/classifier
   behavior instead of close gates. Keeps: branch protections, required
   reviews, plan-before-edit, auto lint/test, push/PR approval, and the
   close-outcome truthfulness gate (`task-evaluation.ts:674-701`).

## Non-goals

- Copying current adapter logic into OpenCode V2. V2 consumes invariants
  1–6 or it doubles the maintenance surface on day one.
- Recognizer widening (`git branch <name>`, `git -C <dir>`, `eval`
  obfuscation). The narrow recognizer stays; session scoping makes its gaps
  harmless instead of blocking.
- Rewriting the task engine into a general effects system or adding a second
  lifecycle, approval protocol, or evidence format.
- Relaxing review independence, RED-before-GREEN discipline, or exact action
  payload binding at settlement time.
- Migrating old `.workit/` files eagerly.

## Required Behavior (for the implementation follow-up)

- Core `shouldDenyShellRoute(sessionAttribution, command)` replaces the three
  copy-pasted deny sites; `shellRouteIntent` stays a pure parser.
- Proposal store keyed by `descriptorDigest` with re-resolve equality;
  wall-clock used for display age only; restart reloads pending proposals
  from the store instead of failing closed.
- `stated_choice` provenance type with conversation ref, accepted for
  low-risk actions; every core-raised gate emits a bindable proposal (no
  free-text "ask the user" strings — first case: the dirty-tree branch
  setup path in `branch.ts:399-407`).
- Single `resolveBinding → checkPin → evaluateEvidence → isVerified` core
  used by all call sites; no in-place input mutation; canonical-JSON ref
  compare; one finding-gate evaluator with one error code.
- Lifecycle gate table split by intent (`blocksPause` vs
  `blocksResume/Close/Revise`, typed on `WorkerState`); idempotent
  lead-attested cancel; explicit revisions at the core boundary with one
  field name; schema-driven export/import with a single resume path.
- Policy: enforce-or-remove `before:write`; close blocks only on
  `before:close` requirements; unsatisfied reasons name the expected
  evidence kind; RED-first scoped to newly-added behavior claims;
  reviewer-session uniqueness per requirement; dead skill ruleIds
  (`root-cause-investigation`, `durable-handoff`) deleted or retargeted;
  `verification` dimension and `self-review` routed.
- Parity tests per fix plus one adapter-signature conformance test; V2
  implements the 3 callbacks and inherits the invariants.
- Docs at implementation time: `AGENTS.md` denial bullet qualified to
  attributed sessions, `CHANGELOG.md` Unreleased entries per landed
  invariant, and this spec's supersession notes resolved.

## Docs cleanup shipped with this spec

- `docs/route-denial-scope/spec.md`: marked superseded (Option A marker gate
  replaced by decision 6 above); kept as history, not to be implemented.
- `docs/workit-reliability-delta/spec.md`: historical record of shipped
  v1.0.9/v1.0.10 behavior — left unchanged. Its §1 proposal TTL and
  fail-closed rules are the mechanism decisions 1–4 replace.
- `AGENTS.md`, `CHANGELOG.md`: unchanged until implementation lands; they
  describe current behavior truthfully today.

## Counter-cases considered

- Human-attention nudges ("you approved this 3 days ago, confirm?") stay
  legitimate as UX, never as fail-closed validity.
- Session liveness legitimately bounds _observation_ (a dead process proves
  nothing about spawns — dispatch-claim conservatism is correct) but never
  _approval validity_: a recorded approval outlives the process.
- Fresh checkouts with no task yet allow manual branching (nothing exists to
  protect); `git.branch_setup` still handles pre-existing branches.
