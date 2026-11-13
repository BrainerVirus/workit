# Approvals

Some Workit actions need your yes even when an agent runs them. A yes typed in
the chat never counts: your host's prompt or your own terminal records it.

## One click on the action itself

A YouTrack write (`workit youtrack note`, `time`, `meeting`, `update`,
`create`) asks you on that very call:

- **Claude Code** (`default`, `acceptEdits`, `plan` and auto mode): the
  permission prompt on the `workit youtrack …` call shows the whole text it
  will post (a long one ends with "N more lines"). Yes posts it in that call,
  once. There is no id and nothing to type.
- **Pi** (TUI): a dialog on the call shows the whole text. Approve once posts
  it in that call; Reject posts nothing.

Your yes covers that one call with exactly that text and those files. It is
used once and lasts two minutes. In `bypassPermissions`, `dontAsk`,
`claude -p` or the SDK nobody sees a prompt, so nothing is approved and the
call says which mode it ran in.

The agent must run the call as its own plain command, with no pipe, chain,
redirect, `cd`, variable or `bash -c` around it; otherwise the host cannot
show it to you, and Workit denies the call and names the plain form. Only the
host's prompt can approve a call: a command or file of the agent's that names
Workit's approval ticket is refused.

## Hosts with no prompt on the action

On OpenCode, Codex, Cursor and Pi print or RPC mode, the call records one
request for that text and refuses:

```text
approval_needed: nothing was posted. approve: ask the user to run `workit approve` in a terminal (it shows the full text and asks y/N), then run this call again
```

Run it in a real terminal, outside any agent:

```bash
workit approve
```

It shows the full request and asks you to confirm with `y`. The agent's next
run uses your yes once. When several requests wait, `workit approve` lists
them and the refusal names the one to approve (`workit approve ap_k3m7q2xa`).
Refusing the same text again reuses its request: one text, one id. In an
agent's shell, or without a terminal, `workit approve` shows the request and
records nothing.

## Other approvals

A Workit verb that decides inside its run writes a request and refuses the
same way. On Claude Code and Pi the agent may run `workit approve <id>`
itself: the host asks you on that call and records your answer (on Claude
Code also in auto mode). Grant raises and the workspace seal stay a terminal
step.

## Rules

- One yes covers one run of exactly what you saw. A change to the subject (a
  one-byte draft edit) needs a new yes (`approval_stale`); a second run needs
  a new one too (`approval_consumed`).
- A request lasts 30 minutes; a yes recorded by `workit approve` lasts 15
  minutes; a yes on the action itself is used in that call.
- `workit approve ap_a ap_b` asks once for several requests, for example one
  per repo of a multi-repo release.
- Requests and approvals live in `<state dir>/approvals/`. Agents cannot edit
  that directory: Workit's hooks deny it on every host.

The terminal check stops an honest agent from approving its own action. It is
not a sandbox: the host's prompt on the call is the hard boundary (see
[hosts.md](../agents/hosts.md#host-parity) for each host's limits).
