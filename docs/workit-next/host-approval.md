# Host-approval channel: spec

Status: decided (2026-11-11); first PR shipped: the approvals guard, the request store and consume
API (`packages/workit-core/src/approvals/`), `workit approve`, Claude Code and Pi recording; no
consumer is wired yet · Issues: #419, #649, #768, #774 · Builds on #615 (user-only calls) and #798 (ask rules anchored at the verb)

## Problem

Some Workit actions need the user's yes: approving release notes, overriding a role model on one
spawn, the first push of a default branch, changing grants, a force push without a lease. Today the
only channel that records a yes is a terminal command (`workit release notes approve`,
`workit grant set`, `workit ledger void`): the CLI refuses an agent shell (agent marker, no TTY), and
each host prompts or denies the call (`WORKIT_USER_ONLY`). So the user says yes in the conversation,
then leaves the host, runs a command and comes back, once per repo (#649: twice for a two-repo
release). Elsewhere the hook denies outright, and the only way through is a config change that
allows every future case too (#768 `allowLeadOverride`).

A yes typed in chat must not count: that makes the gate agent-asserted, which #615 closed.

## Principles

1. **Ask only for authority the grants lack, never for a mention.** A workspace whose grants cover
   an action never prompts for it (an autonomous workspace stays autonomous). Workit decides that an
   approval is needed from parsed argv and its own state, anchored at the verb, never from text
   that only names a verb in an argument (#798). One prompt per action the grants do not cover.
2. **The host records the answer, not the agent.** Host-side code writes the approval: a hook
   process the host starts on a host event, a plugin or extension running in the host's runtime, or
   the CLI at a real terminal. The agent's shell never writes one.
3. **One yes, one effect.** An approval is bound to a hash of exactly what was shown, used once,
   and expires. A changed subject (a one-byte draft edit) needs a new yes.
4. **Every host has the mechanism or a recorded limit**, and every refusal prints the terminal
   fallback that works on all of them.

Trust model (D18): this stops honest mistakes and accidental self-approval, not a determined agent.
The hard boundary stays the host's prompt on the approval call and host permissions on Workit's
state dir.

## Two forms

| Form | Used when | The yes is |
| --- | --- | --- |
| **Inline ask** | The gated action is one host tool call that a Workit hook already judges (Agent spawn, raw `git push --force`, `git reset --hard`, `WORKIT_LIVE_SESSION=override`) | The host prompt on that call; on yes the call runs once. Nothing is stored except an audit row |
| **Request and approve** | A Workit CLI verb decides inside its run (release-notes gate, branch policy on `workit git push`, `grant set`, secrets in `workit git commit`) | `workit approve <id>…`, the one prompted verb; host-side code records the yes; the verb runs again and consumes it |

## Request shape

A verb that needs a yes and finds none writes a **request** and refuses with
`approval_needed: … approve: workit approve <id>`. Writing a request needs no authority (it
grants nothing), so the agent may also create one ahead of time
(`workit release notes draft` and `show` do, #649).

| Field | Content |
| --- | --- |
| `id` | `ap_` + 8 random base32 characters; printed, never derived from content |
| `kind` | `release-notes`, `spawn-model`, `first-push`, `config`, `force-push`, `live-session`, `discard-work`, `secrets` |
| `action` | The verb or call, as the user would read it: `workit git push --release 4.5.0` |
| `target` | Repo (realpath of the git common dir), branch or version, remote URL where one applies |
| `effect` | One sentence on what happens on yes: "publishes the forge release 4.5.0 with this draft" |
| `subject` | What the yes binds to: draft path and sha256, spawn args, grant key old → new, the paths that would be lost |
| `hash` | sha256 over the canonical JSON of `kind`, `action`, `target`, `effect`, `subject`; the prompt shows the first 12 hex |
| `session` | The requesting session; `created`, `expires` (30 minutes) |

The prompt text is rendered from the stored request by Workit, never from text the agent passes.
It reads, on every host that can show text: action, target, effect, subject digest, hash prefix,
expiry, and the choices the host supports (Approve once / Reject, plus Edit where the host offers a
select). Several ids in one `workit approve` call give one prompt listing each target (the #649
multi-repo release).

Requests and approvals live in one registry in the user state dir (`<state dir>/approvals/`, see
[file-locations](../agents/file-locations.md)), so one call can cover several repos; each consumed
approval is mirrored as an `approval.consumed` row in the repo's ledger. **Deliverable:** the
issued-registry write guard (#292, `underIssued` in `hooks/write-gate.ts`) matches only
`<state>/issued*` today, so the first PR extends it to `<state>/approvals/`, with a test beside the
issued-registry ones that an agent edit, redirect, `tee`, `cp` or `mv` into it is denied on each
host. Like that guard it reads edit paths and recognizable shell writes only: a hand-edit guard,
not a sandbox ([hosts.md](../agents/hosts.md#host-parity), issued-registry limits).

## Recording the answer, per host

The prompted call `workit approve <id>…` writes nothing in an agent shell: it prints the request
and "the host records your answer". Host-side code writes `approval.granted { id, hash, host,
session, toolUseId, at, expires }` (15 minutes), or `approval.rejected` where the host reports a
no. Host rules for `workit approve` are anchored at the verb, like #798. A hook acts only on one
simple `workit approve <ids>` call: a chain, a substitution, a leading `cd` or an env prefix is
denied with the plain form to run. The `asked` row holds one hash per id; a grant is written only
when that call exited 0 (Pi: from the dialog answer), one per id read from argv words, never text.

| Host | Request and approve | Inline ask | Recorded limit and fallback |
| --- | --- | --- | --- |
| Claude Code | `PreToolUse` answers `permissionDecision: "ask"` for `workit approve` with the rendered request as the reason and writes `asked { toolUseId, ids, hashes }`; `PostToolUse` for the same `toolUseId` writes the grants. Setup adds `ask` `Bash(workit approve *)` | `PreToolUse` `ask` on the call (Agent spawn, Bash), reason rendered from a request it writes itself | L: a grant proves the call ran after an ask, not that a person answered, and no hook sees a reject (the request expires). U: whether auto mode, `bypassPermissions`, an SDK `canUseTool` callback or `--permission-prompt-tool` answer an ask without a person; until probed no grant is recorded in those modes (`asked` is written only in `default`, `acceptEdits` or `plan`) |
| OpenCode | `permission.evaluate` answers `ask` for `workit approve` on every call (never `allow`), so a stored `always` never skips it; the plugin writes the grant on `permission.replied` `once` or `always` (both once) or the rejection on `reject`, matched through `permission.asked`. U: both events are in the installed `@opencode/schema` types, but nothing in Workit consumes them yet. U: Approve / Reject / Edit through `question` (no reply event in the installed plugin types) | `permission.evaluate` `ask` for a shell call it gates; U: whether a `subagent` spawn passes through `permission.evaluate`, else spawns use request and approve | Fallback-only until the U items are probed |
| Codex | Workit's `rules/workit.rules` gets a `prompt` rule for `workit approve` (the `PreToolUse` hook no longer denies it); `PostToolUse` writes the grant only when the hook input's `permission_mode` shows a mode that prompts | L: the hook can deny but not ask; prompts come only from prefix rules, so inline cases deny and name the request id | U: which `permission_mode` values Codex sends under `approval_policy = never` and whether a "don't ask again" answer caches by prefix; until probed Codex is fallback-only (L) |
| Cursor | `beforeShellExecution` answers `permission: "ask"` for `workit approve`; `afterShellExecution` (X today: offered, not registered) writes the grant | `beforeShellExecution` `ask` for shell calls; L: no spawn hook can ask, and role models are advisory there, so #768 has nothing to override | U: whether auto-run ("run everything") skips an `ask`; the IDE's handling is unverified (#635). Until both are probed Cursor is fallback-only |
| Pi | The `tool_call` hook intercepts `workit approve`, shows `ctx.ui.select` (Approve / Reject / Edit) with the rendered request, writes the answer, and blocks the shell call with a result naming it | `tool_call` → `ctx.ui.confirm` before the call runs | Records only in the TUI (`ctx.mode`). L: print mode has no dialog (`hasUI` false); in RPC mode `hasUI` is true but the dialog goes to the RPC client, which may be a program, so RPC is fallback-only |

**Fallback, every host:** `workit approve <id>…` run by the user in a real terminal shows the
same rendered request and records `via: terminal` after today's #615 checks: a TTY, no agent
marker, then y at the confirm prompt (as `grant set` and `release notes approve` do). L (D18,
`verbs/grant.ts`): an agent that allocates a pseudo-terminal and scrubs the markers passes it. Every refusal prints this line; a host with a channel adds "or approve it when
your host asks". A host that is fallback-only says so in `workit doctor` (`host_approval`).

## How a CLI verb checks an approval

1. Compute the request for this run (same fields as above, from current state).
2. Look for a grant whose `hash` equals the computed hash, not expired, not consumed, written by
   host-side code (`observer: host_hook`, with a matching `asked` record on Claude Code) or
   `via: terminal`.
3. None, but a grant for an older hash of the same `kind` and `target`: refuse `approval_stale`,
   naming the approved and current hash prefixes and the new `workit approve <id>`.
4. Found: append `approval.consumed { id, verb, head }` under the store lock immediately before the
   side effect (push, release, config write). A verb that exits before its side effect does not
   consume. A second consume of the same id refuses `approval_consumed`.
5. A grant never widens: it covers the one hash, not the kind, the repo or the session's later
   calls. A grant from another session is accepted (the user may approve from a terminal) but
   the ledger row names both sessions.

## Consumers

| Consumer | Form | On yes | Acceptance sketch |
| --- | --- | --- | --- |
| #649 release notes (`releaseNotes: review`) | Request and approve; `kind: release-notes`, subject = draft path + sha256 | `workit git push --release <tag>` consumes and publishes | See below |
| #649 multi-repo | One `workit approve <id_a> <id_b>` | Each repo's push consumes its own id | Given two repos with drafts for 1.31.0, When the user approves one prompt listing both, Then both pushes publish and neither asks again |
| #768 model override | Inline ask on Claude Code (`PreToolUse:Agent`) and Pi; request and approve on OpenCode (its `execute.before` consumes). L Codex: models come from the agent TOMLs, no spawn hook; Cursor: role models are advisory, nothing is denied | That one spawn runs with the requested model; `allowLeadOverride` is unchanged | Given role model sonnet and a spawn naming opus, When the user approves, Then that spawn runs on opus and the next spawn naming opus asks again; When the user rejects, Then the spawn is denied with the role args as today; Given no model on the spawn, Then nothing asks |
| #774 first push | Request and approve; `kind: first-push`, only when the remote has no branches | `workit git push` publishes the default branch once | Given an empty remote and a protected `main`, When the user approves `first-push` for `origin main`, Then `workit git push` creates `main`; a second push to `main` is refused by branch policy as today |
| #419 config and grants | Request and approve; subject = workspace, key, old → new | `workit grant set`/workspace verbs write once | Given `merge: false`, When the agent runs `workit grant set merge true` and the user approves the prompt that names "personal: merge false → true", Then the grant changes with no terminal trip; a direct edit of `~/.config/workit` stays denied |
| #419 force push without lease | Inline ask where a hook gates raw git; Claude Code first rewrites to `--force-with-lease` (`updatedInput`) and asks only when the lease form cannot apply | The push runs once | Given `git push --force` on a branch another session pushed, When the hook asks naming who else pushed and the user approves, Then it runs once; the next force push asks again |
| #419 live-session override | Inline ask naming the session and checkout that would be overwritten | The write runs once; the override env var alone never passes | Given a live session in checkout X, When a call sets `WORKIT_LIVE_SESSION=override`, Then the user sees the session id and path and the call runs only on yes |
| #419 losing work | Inline ask, only when tracked changes or unmerged commits would be lost; select hosts offer Stash and run / Run anyway / Cancel | Runs as chosen | Given tracked edits, When the agent runs `git reset --hard`, Then the host asks; Given only untracked scratch files the command keeps, Then nothing asks |
| #419 secrets (`secrets: ask`) | Request and approve from `workit git commit`, inline ask for raw commits; subject = the staged secret-like paths | The commit runs once with those paths | Given a staged `.env` and `secrets: ask`, When the user approves the prompt listing `.env`, Then the commit lands; with `secrets: off` nothing asks; with `block` no approval passes |

#649 in full (seams: the release-notes CLI tests with a recorded host hook payload, and the
Claude Code hook fixture tests):

- Given `releaseNotes: review` and an unapproved draft, When the user approves the host prompt
  showing version, draft path and sha prefix, Then `workit release notes show <v>` reports it
  approved via `host:<host>:<session>` and `workit git push --release <tag>` publishes with no
  terminal command.
- Given the same draft, When an agent shell runs `workit approve <id>` with no host prompt (hooks
  off, auto mode, `bypassPermissions`) or inside a chain (`cd x && workit approve <id>`), Then no
  grant is written and the push stays refused with the approve line.
- Given an approved draft edited by one byte, When the push runs, Then it refuses `approval_stale`
  naming both sha prefixes and a new id.
- Given the prompt offers Edit (Pi `select`; OpenCode `question` once probed), When the user picks it, Then
  the request is marked stale, the draft path is printed, and the next `show` writes a new request.
- Given a consumed approval, When the agent runs the same push again, Then nothing is approved by
  it (`approval_consumed`), and Given `releaseNotes: off|auto`, Then nothing asks.

Every inline case also has a hook fixture test per host that asserts the host's ask shape
(Claude Code `permissionDecision: "ask"`, Cursor `permission: "ask"`, OpenCode `effect: "ask"`)
and a fallback-only host test that asserts the deny names the request id and the terminal command.

## What does not change

- The user-only verbs (`release notes approve`, `grant set|raise`, `ledger void`) keep their
  terminal path. In an agent shell they write a request and print `workit approve <id>` instead of
  only refusing.
- No hook or rule ever answers `allow` for `workit approve` or a user-only call, on any host.
- Grants stay the delivery ceiling: an approval is one action, never a grant change by other means.

## Decisions (maintainer, 2026-11-11: all recommendations accepted)

1. **Two steps or a one-call ticket on Claude Code?** `PreToolUse` could answer `ask` and add a
   hook-minted ticket through `updatedInput`, so the consumer verb runs once. Decided: two
   steps everywhere for CLI verbs (ruling mwc2mk56): Cursor cannot rewrite, Codex prompts only via
   prefix rules, and one record path is easier to keep honest.
2. **Expiry.** Decided: request 30 minutes, grant 15 minutes after the yes, both
   configurable only in user config.
3. **OpenCode `always`.** Decided: recorded as once; Workit never stores a standing approval.
4. **Can a grant pre-approve a kind** (for example `first-push` in a personal workspace)?
   Decided: only where a grant already describes the effect (`releaseNotes: auto`, `merge`);
   never `config`, `secrets` or `discard-work`.
5. **Rejection on yes/no hosts.** Decided: no row; the request expires and the agent reports
   the denied call. Only OpenCode and Pi record `approval.rejected`.
6. **Order of delivery.** Decided: Claude Code, OpenCode and Pi first; Codex and Cursor stay
   fallback-only until the U probes above pass, recorded in
   [hosts.md](../agents/hosts.md#host-parity). The same rule applies to OpenCode's U items:
   first in order means its probes run first, not that it records before they pass.
7. **Cross-session grants.** Decided: accepted when the hash matches (the user may approve in
   a terminal or another session), with both sessions in the ledger row.
