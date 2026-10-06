# Proposal: parallel delegation (scoped fan-out)

**Status:** deferred to 1.1.0 — proposal only, no implementation. Read-only
fan-out (parallel explore/search) already parallelizes freely; only parallel
product writes need this design.
**Branch:** `feature/workit-v1`

## Problem

One lead session does sequenced slices while independent workstreams
(Red-first gate, TTY harness, wizard walks) could run in parallel. The
worker protocol already has reservation-bound dispatch
(`prepareWorkerDispatch` / `commitWorkerDispatch`) and a shared writer with
exactly-one-holder ownership, but there is no documented pattern for fanning
out two implementers on disjoint paths in one task.

## Proposal

- Fan-out via `workit_worker assign` (role `implementer`) with **disjoint
  `scope.paths`** per worker; the lead keeps the writer and merges by
  committing each worker's paths atomically on report.
- Writer handoff only when a worker must write outside its paths: lead
  releases, worker acquires, writes, releases, lead re-acquires — never
  held by two sessions at once (the current release→revise→assess→acquire
  flow in this task is the template).
- Review stays a fresh-context `reviewer` worker whose session is neither
  the creator's nor any evidence recorder's (already enforced).

## Non-goals

- No parallel lead mutations: task state (progress/decisions/close) stays
  single-writer, owned by the lead session.
- No new operation family and no ninth-family reservation bypass:
  `prepareWorkerDispatch` / `commitWorkerDispatch` remain host-only core
  methods.
- No cross-task worker binding: workers bind within a single task only.
