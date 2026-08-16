# <Feature> Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/<slug>/spec.md`
**Branch:** `feature/<slug>`

**Goal:** <one sentence>

## Global Constraints

- Each task lands exactly one contiguous non-empty commit range (`base..head`): fix rounds append commits to that range and never rewrite/amend an active review range; each progress line records the task's real base..head shas.
- The final task ends execution with `workflow_plan_complete` (or the CLI `workit flow complete`) once the SDD ledger is complete and repository verification passes.
- <project-wide requirements, one line each>

---

### Task N: <Component>

- [ ] **Step 1: <action>**

<!-- per-task criteria: how this task is verified -->
**Criteria:** <verifiable check>

| Status | Task |
| --- | --- |
| pending | N: <Component> |
