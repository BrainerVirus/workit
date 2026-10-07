# Durable knowledge: when and how

Default: nothing durable. Conversation, the ledger (`workit ledger`) and the
code carry most work. Propose a record only when a trigger below fires or the
user asks for one, say which trigger fired, and let the user decline.

| Record | Trigger | Where |
| --- | --- | --- |
| Spec | more than one slice, crosses repos, or an open product choice a future reader must know | `docs/<topic>/spec.md` |
| Plan | more than one slice with dependencies, or work that will be resumed by someone else | `docs/<topic>/plan.md`, next to the spec |
| ADR | the choice is hard to reverse **and** surprising **and** a real trade-off (all three) | `docs/adr/NNNN-<slug>.md` |
| Glossary entry | a project term was ambiguous and you resolved it | `GLOSSARY.md` (create lazily) |
| Coding standard | a judgment-call rule a reviewer must check, recurring twice (workit-retro); a mechanical rule gets a check instead | `CODING_STANDARDS.md` (create lazily) |
| Out of scope | a request was rejected and is likely to come back | `.out-of-scope/<concept>.md` |

Never: a spec for a one-file mechanical fix, a plan that restates the spec,
file paths or line numbers in a spec (they go stale), a glossary entry for a
general programming term.
Create a lazy file only in the same edit as its first real entry, never as a
headers-only or TBD scaffold (`workit knowledge lint` flags one).

## Spec (scaled to the work)

```md
# <Topic> - spec
## Problem        (what hurts, for whom, with evidence)
## Decisions      (table: # | decision | why; link ledger rows)
## Behavior       (Given/When/Then, one line each; these become test names)
## Out of scope
```
Add `## Design` only for architectural work, and a diagram only when it argues
a decision.

## Plan

Decisions, not code: per slice the branch, what it touches, its acceptance
lines, how it is verified, and what it depends on. A plan several times longer
than its spec is a transcript; cut it.

## ADR

```md
# NNNN <decision in a few words>
Status: accepted (YYYY-MM-DD)
<1-3 sentences: the context, the choice, the trade-off accepted.>
Considered: <option> - <why not>.
```

## Glossary entry

```md
**Verdict** - an independent pass/fail judgment on a branch head, recorded in the ledger.
_Avoid_: approval, sign-off.
```
One or two sentences, project terms only, no implementation detail.

## Out of scope

One file per concept: the request, why it was declined, what would change the
answer, links to the issues that asked for it. Check this directory before
grilling a request that sounds familiar.
