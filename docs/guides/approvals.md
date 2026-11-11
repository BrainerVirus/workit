# Approvals

Some Workit actions need your yes even when an agent runs them. When a Workit
verb needs one and finds none, it writes a request and refuses:

```text
approval_needed: workit git push --release 4.5.0 needs the user's yes. approve: run `workit approve ap_k3m7q2xa` now with your shell tool, as its own call with no cd, pipe or redirect; never ask the user to type it: your call makes the host ask them, and only their answer approves
```

The agent then runs `workit approve ap_k3m7q2xa`. Your host shows you what
Workit stored for that request: the action, its target, what happens on yes,
the subject it binds to and a hash prefix. Your answer is recorded by the host,
never by the agent. The verb then runs again and uses your yes once.

No verb asks for an approval yet: this release ships the channel, and the
release-notes, first-push, model-override and grant-change checks use it in
later releases.

## Rules

- One yes covers one run of exactly what you saw. A change to the subject (a
  one-byte draft edit) needs a new yes (`approval_stale`); a second run needs
  a new one too (`approval_consumed`).
- A request lasts 30 minutes; your yes lasts 15 minutes.
- `workit approve ap_a ap_b` asks once for several requests, for example one
  per repo of a multi-repo release.
- A yes typed in the chat never counts.
- Requests and approvals live in `<state dir>/approvals/`. Agents cannot edit
  that directory: Workit's hooks deny it on every host.

## Per host

| Host | How you answer |
| --- | --- |
| Claude Code | The permission prompt on the `workit approve` call. Yes records it in the `default`, `acceptEdits` and `plan` modes; auto mode, `bypassPermissions`, `dontAsk`, `claude -p` and the SDK record nothing. |
| Pi | A dialog in the TUI: Approve once, Reject or Edit. Print and RPC modes use the terminal. |
| OpenCode, Codex, Cursor | Your own terminal (below), until their prompts are verified. |

## In your terminal

Every host can use this. Outside any agent, in a real terminal:

```bash
workit approve ap_k3m7q2xa
```

It shows the same request and asks you to confirm with `y`. In an agent's
shell, or without a terminal, it shows the request and records nothing.

The terminal check stops an honest agent from approving its own action. It is
not a sandbox: the host's prompt on the call is the hard boundary (see
[hosts.md](../agents/hosts.md#host-parity) for each host's limits).
