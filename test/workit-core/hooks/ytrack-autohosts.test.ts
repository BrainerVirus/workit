// youtrack.autoHosts: with `writes: auto`, a raw ytrack write passes unasked
// only from a plain call whose --host is an allowed host. One naming no host
// is denied with the retry that names one; one naming another host asks as
// without auto (Claude Code asks, the other hosts deny). Plain auto keeps
// meaning any host. A temp account home and seal, never the real ones.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { grantsHome } from "@/packages/workit-core/src/autonomy";
import { configDir } from "@/packages/workit-core/src/core/workit-paths.mjs";
import { claudeCodeAdapter, dispatchHook } from "@/packages/workit-core/src/hooks/index";
import { codexAdapter } from "@/packages/workit-core/src/hooks/hosts/codex";
import { cursorAdapter } from "@/packages/workit-core/src/hooks/hosts/cursor";
import { ytrackGate } from "@/packages/workit-core/src/hooks/ytrack-guard";
import { enforceToolPolicy } from "@/packages/workit-pi/src/tools";
import { fixture, tempRoot } from "./hook-fixtures";
import { sealConfig } from "../../shared/grant-home";

const base = realpathSync(tempRoot("workit-ytrack-autohosts-"));
const root = path.join(base, "repo");
mkdirSync(root, { recursive: true });
const account = configDir({ HOME: path.join(base, "account") });
mkdirSync(account, { recursive: true });
const KEYS = ["WORKIT_CONFIG_DIR", "WORKIT_STATE_DIR", "WORKIT_WORKSPACE_NAME"];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const savedResolve = grantsHome.resolve;
beforeEach(() => {
  // The account's own dir, so no redirect lowers auto.
  process.env.WORKIT_CONFIG_DIR = account;
  process.env.WORKIT_STATE_DIR = path.join(base, "state");
  delete process.env.WORKIT_WORKSPACE_NAME;
  grantsHome.resolve = () => path.join(base, "account");
  rmSync(path.join(account, "workspaces.json"), { force: true });
  rmSync(path.join(account, "workspaces.json.seal"), { force: true });
});
afterEach(() => {
  grantsHome.resolve = savedResolve;
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const SANDBOX = "sandbox.youtrack.cloud";
const WORK = "acme.youtrack.cloud";

const sealed = (youtrack: Record<string, unknown>) => {
  writeFileSync(
    path.join(account, "workspaces.json"),
    `${JSON.stringify({
      workspaces: [{ name: "personal", glob: `${root.replaceAll("\\", "/")}/**`, youtrack }],
    })}\n`,
  );
  sealConfig(account);
};

const gate = (command: string, ask = true) => ytrackGate(root, command, "posix", ask);

type Kind = "deny" | "ask" | "pass";
const claude = (command: string): Kind => {
  const out = (
    dispatchHook(
      claudeCodeAdapter,
      fixture("claude-code", "pre-tool-use-bash", root, { tool_input: { command } }),
    ).json as { hookSpecificOutput?: { permissionDecision?: string } }
  ).hookSpecificOutput?.permissionDecision;
  return out === "deny" || out === "ask" ? out : "pass";
};
const codex = (command: string): Kind =>
  (
    dispatchHook(
      codexAdapter,
      fixture("codex", "pre-tool-use-bash", root, { tool_input: { command } }),
    ).json as { hookSpecificOutput?: { permissionDecision?: string } }
  ).hookSpecificOutput?.permissionDecision === "deny"
    ? "deny"
    : "pass";
const cursor = (command: string): Kind => {
  const permission = (
    dispatchHook(cursorAdapter, fixture("cursor", "before-shell-execution", root, { command }))
      .json as { permission?: string }
  ).permission;
  return permission === "deny" ? "deny" : permission === "ask" ? "ask" : "pass";
};
const pi = (command: string): Kind =>
  (
    enforceToolPolicy(
      { toolName: "bash", input: { command } } as never,
      { cwd: root, isProjectTrusted: () => true } as never,
    ) as { block?: boolean } | undefined
  )?.block
    ? "deny"
    : "pass";
const HOSTS = { claude, codex, cursor, pi };

test("G sealed auto with autoHosts [sandbox], W a raw write names the work host, T it is no longer let through: Claude Code asks, the rest deny", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  const command = `ytrack --host ${WORK} issue comment W-1 --body x`;
  expect(gate(command, true)?.kind).toBe("ask");
  expect(gate(command, false)?.kind).toBe("deny");
  for (const [host, run] of Object.entries(HOSTS))
    expect(run(command), host).toBe(host === "claude" ? "ask" : "deny");
  // A covered write to another host names the workit call that asks, as without auto.
  const update = `ytrack --host ${WORK} issue update W-1 --field State=Fixed`;
  expect(gate(update, true)?.kind).toBe("ask");
});

test("G sealed auto with autoHosts [sandbox], W a plain write names the sandbox with --host in any spelling, T it passes on every host", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  for (const command of [
    `ytrack issue comment DEMO-1 --body x --host ${SANDBOX}`,
    `ytrack --host=https://Sandbox.YouTrack.cloud/ issue comment DEMO-1 --body x`,
    `ytrack --host https://${SANDBOX}:443/api issue update DEMO-1 --field State=Fixed`,
    `ytrack --host ${SANDBOX} issue comment DEMO-1 --body x | jq .`,
    `ytrack --host ${SANDBOX} api /issues/DEMO-1/comments -X POST -f text=hi`,
  ]) {
    expect(gate(command), command).toBeNull();
    for (const [host, run] of Object.entries(HOSTS))
      expect(run(command), `${host}: ${command}`).toBe("pass");
  }
});

test("G sealed auto with autoHosts [sandbox], W a write names no host, T it is denied on every host with the retry that names the sandbox", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  const out = gate("ytrack issue comment DEMO-1 --body x");
  expect(out?.kind).toBe("deny");
  expect(out && "reason" in out ? out.reason : "").toContain(
    `Retry as: ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
  );
  expect(gate("ytrack issue comment DEMO-1 --body x", false)?.kind).toBe("deny");
  for (const [host, run] of Object.entries(HOSTS))
    expect(run("ytrack issue comment DEMO-1 --body x"), host).toBe("deny");
  // An issue URL or YTRACK_HOST does not name the host the hook can trust.
  for (const command of [
    `ytrack issue comment https://${SANDBOX}/issue/DEMO-1 --body x`,
    `YTRACK_HOST=${SANDBOX} ytrack issue comment DEMO-1 --body x`,
    `ytrack api https://${SANDBOX}/api/issues/DEMO-1/comments -X POST -f text=hi`,
  ])
    expect(gate(command)?.kind, command).toBe("deny");
});

test("G sealed auto with autoHosts [sandbox], W --host is a value, not literal, wrapped, ytrack's config moves, or the command is unanalysable, T it is never let through", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  for (const command of [
    // `--host` here is --body's value: no host is named.
    `ytrack issue comment DEMO-1 --body --host ${SANDBOX}`,
    // ytrack takes the last --host: every one must be allowed.
    `ytrack --host ${SANDBOX} issue comment DEMO-1 --body x --host ${WORK}`,
    `ytrack --host "$H" issue comment DEMO-1 --body x`,
    `ytrack --host '*.youtrack.cloud' issue comment DEMO-1 --body x`,
    `ytrack --host https://user:pw@${SANDBOX} issue comment DEMO-1 --body x`,
    `YTRACK_CONFIG_DIR=/tmp/yt ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
    `export YTRACK_CONFIG_DIR=/tmp/yt`,
    `HOME=/tmp/h ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
    // A wrapper may append a --host the hook never sees.
    `cat ids | xargs ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
    `cd /tmp && ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
    `${"eval ".repeat(8)}ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
  ])
    for (const ask of [true, false])
      expect(gate(command, ask), `${ask}: ${command}`).not.toBeNull();
  const wrapped = gate(`cd /tmp && ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`);
  expect(wrapped && "reason" in wrapped ? wrapped.reason : "").toContain("not a plain command");
});

// Verdict mwqgyb4y: a `--host` after a boolean flag Workit does not know was
// read as that flag's value and dropped, while ytrack 0.6.2 posted to it (the last --host).
test("G sealed auto with autoHosts [sandbox], W an allowed --host then a flag Workit does not know then --host <other>, T it is never let through", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  for (const flag of ["-i", "--slurp", "-e", "--editor", "--web", "--comments", "--zzz"])
    for (const command of [
      `ytrack --host ${SANDBOX} api issues -X POST ${flag} --host ${WORK}`,
      `ytrack --host ${SANDBOX} issue comment DEMO-1 --body x ${flag} --host ${WORK}`,
      `ytrack --host ${SANDBOX} issue update DEMO-1 ${flag} --host=${WORK}`,
    ]) {
      for (const ask of [true, false])
        expect(gate(command, ask), `${ask}: ${command}`).not.toBeNull();
      for (const [host, run] of Object.entries(HOSTS))
        expect(run(command), `${host}: ${command}`).not.toBe("pass");
    }
  // Every --host before `--` counts; one after `--` is an operand ytrack never reads as a flag.
  expect(gate(`ytrack --host ${SANDBOX} -i --host ${SANDBOX} issue update DEMO-1`)).toBeNull();
  expect(gate(`ytrack --host ${SANDBOX} issue comment DEMO-1 --body x -- --host`)).toBeNull();
  // A --host with no value as the last word is no literal host.
  expect(gate(`ytrack issue comment DEMO-1 --body x --host ${SANDBOX} --host`)).not.toBeNull();
});

test("G auto with autoHosts, W ytrack reads or a mention, T nothing is denied", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  for (const command of [
    "ytrack issue view DEMO-1",
    `ytrack --host ${WORK} issue list`,
    "echo ytrack issue comment DEMO-1 --body x",
    "echo $YTRACK_CONFIG_DIR",
  ])
    expect(gate(command), command).toBeNull();
});

test("G auto with an empty autoHosts, W any raw write, T it asks or denies as with ask", () => {
  sealed({ writes: "auto", autoHosts: [] });
  expect(gate(`ytrack --host ${SANDBOX} issue update DEMO-1 --field State=Fixed`)?.kind).toBe(
    "ask",
  );
  expect(gate("ytrack issue update DEMO-1 --field State=Fixed")?.kind).toBe("ask");
});

test("G plain writes auto without autoHosts, W any raw write, unanalysable or not, T it passes as before (any host)", () => {
  sealed({ writes: "auto" });
  for (const command of [
    `ytrack --host ${WORK} issue comment W-1 --body x`,
    "ytrack issue comment DEMO-1 --body x",
    "YTRACK_CONFIG_DIR=/tmp/yt ytrack issue comment DEMO-1 --body x",
    `${"eval ".repeat(8)}ytrack --host ${SANDBOX} issue comment DEMO-1 --body x`,
  ])
    for (const [host, run] of Object.entries(HOSTS))
      expect(run(command), `${host}: ${command}`).toBe("pass");
});

test("G writes ask with autoHosts set, W a raw write naming an allowed host, T it still asks", () => {
  sealed({ writes: "ask", autoHosts: [SANDBOX] });
  expect(gate(`ytrack --host ${SANDBOX} issue update DEMO-1 --field State=Fixed`)?.kind).toBe(
    "ask",
  );
});

test("G autoHosts widened after the seal, W a raw write to the added host, T the seal is broken and it asks", () => {
  sealed({ writes: "auto", autoHosts: [SANDBOX] });
  writeFileSync(
    path.join(account, "workspaces.json"),
    `${JSON.stringify({
      workspaces: [
        {
          name: "personal",
          glob: `${root.replaceAll("\\", "/")}/**`,
          youtrack: { writes: "auto", autoHosts: [SANDBOX, WORK] },
        },
      ],
    })}\n`,
  );
  expect(gate(`ytrack --host ${WORK} issue update W-1 --field State=Fixed`)?.kind).toBe("ask");
  expect(gate(`ytrack --host ${SANDBOX} issue update W-1 --field State=Fixed`)?.kind).toBe("ask");
});
