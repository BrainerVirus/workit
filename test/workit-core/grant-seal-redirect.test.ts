// The seal-redirect ruling (#819): no environment variable raises authority,
// and the reader enforces it. Under a config redirect (WORKIT_CONFIG,
// WORKIT_CONFIG_DIR, XDG_CONFIG_HOME) authority is the stricter of the D4
// defaults and the account's own seal-aware values; youtrack.writes is auto
// only from the sealed account file; the forge identity is part of the seal,
// and a broken seal binds it. In-process, temp homes only.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_GRANTS,
  grantsDir,
  grantsHome,
  grantsMatter,
  identityDenial,
  rawGrantDenial,
  requireGrant,
  resolveAutonomy,
  youTrackWritesMode,
} from "@/packages/workit-core/src/autonomy";
import { accountHome } from "@/packages/workit-core/src/core/account-home";
import { EVAL_WORLD_ENV, EVAL_WORLD_MARKER } from "@/packages/workit-core/src/core/eval-world";
import { checkSeal, SEAL_FILE } from "@/packages/workit-core/src/core/grant-seal";
import { sshSeam } from "@/packages/workit-core/src/core/remotes";
import type { ForgeRunner } from "@/packages/workit-core/src/forge/exec";
import { checkPushIdentity, resolveForge } from "@/packages/workit-core/src/forge/resolve";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

// Read before any test swaps the grants home: the preload's run-scoped one.
const preloadGrantsDir = grantsDir();
const preloadStateDir = process.env.WORKIT_STATE_DIR ?? "";

const KEYS = [
  "WORKIT_CONFIG",
  "WORKIT_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "WORKIT_WORKSPACE_NAME",
  EVAL_WORLD_ENV,
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let configHome: ConfigHome;
let root = "";
const savedSsh = sshSeam.read;
beforeAll(() => {
  delete process.env.WORKIT_WORKSPACE_NAME;
  sshSeam.read = () => ({ text: "", home: os.tmpdir() });
  configHome = useConfigHome("wk-seal-redirect-config-", { seal: "manual" });
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-seal-redirect-"))).replaceAll(
    "\\",
    "/",
  );
  for (const dir of ["strict/repo", "open/repo", "other/repo", "agent/workit", "empty/workit"])
    mkdirSync(path.join(root, dir), { recursive: true });
});
afterAll(() => {
  sshSeam.read = savedSsh;
  configHome.restore();
  for (const key of KEYS)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  process.env.WORKIT_CONFIG = configHome.configDir;
  for (const key of [
    "WORKIT_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    "WORKIT_WORKSPACE_NAME",
    EVAL_WORLD_ENV,
  ])
    delete process.env[key];
  for (const dir of [configHome.configDir, agentDir(), emptyDir()])
    for (const name of ["workspaces.json", SEAL_FILE])
      rmSync(path.join(dir, name), { recursive: true, force: true });
});

const SEAL = "workit workspace seal";
const agentDir = () => path.join(root, "agent", "workit");
const emptyDir = () => path.join(root, "empty", "workit");
const at = (dir: string) => `${root}/${dir}/repo`;
type Entry = Record<string, unknown>;
const account = { provider: "github", account: "me" };
const write = (dir: string, workspaces: Entry[]) =>
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces }));
const sealAccount = (workspaces: Entry[]) => {
  write(configHome.configDir, workspaces);
  sealConfig(configHome.configDir);
};
const strict = (extra: Entry = {}): Entry => ({
  name: "strict",
  glob: `${root}/strict/**`,
  vcs: account,
  autonomy: { push: false, pr: false, rerun: false },
  verification: "independent",
  ...extra,
});
const open = (extra: Entry = {}): Entry => ({
  name: "open",
  glob: `${root}/open/**`,
  vcs: account,
  autonomy: { push: true, pr: true, merge: "verified", release: true },
  defaultEndpoint: "merged",
  verification: "self",
  ...extra,
});
/** Everything granted, for a redirected file an agent wrote. */
const greedy = (name: string, dir: string): Entry => ({
  name,
  glob: `${root}/${dir}/**`,
  vcs: { provider: "github", account: "agent", tokenFile: "/tmp/agent-token" },
  autonomy: { push: true, pr: true, merge: true, release: true, rerun: true },
  defaultEndpoint: "merged",
  verification: "self",
  youtrack: { writes: "auto" },
});

/** The three ways a shell redirects the config dir to `dir` (which ends in /workit). */
const REDIRECTS: Record<string, (dir: string) => void> = {
  WORKIT_CONFIG: (dir) => {
    process.env.WORKIT_CONFIG = dir;
  },
  WORKIT_CONFIG_DIR: (dir) => {
    delete process.env.WORKIT_CONFIG;
    process.env.WORKIT_CONFIG_DIR = dir;
  },
  XDG_CONFIG_HOME: (dir) => {
    delete process.env.WORKIT_CONFIG;
    process.env.XDG_CONFIG_HOME = path.dirname(dir);
  },
};
const unredirect = () => {
  process.env.WORKIT_CONFIG = configHome.configDir;
  delete process.env.WORKIT_CONFIG_DIR;
  delete process.env.XDG_CONFIG_HOME;
};

test("1. Given a sealed strict account entry, When the config is redirected (each way, to an empty dir or an agent file granting everything), Then nothing rises", () => {
  sealAccount([strict()]);
  write(agentDir(), [greedy("strict", "strict")]);
  for (const [how, redirect] of Object.entries(REDIRECTS))
    for (const dir of [emptyDir(), agentDir()]) {
      const label = `${how} -> ${path.basename(path.dirname(dir))}`;
      redirect(dir);
      const autonomy = resolveAutonomy(at("strict"));
      expect(autonomy.grants.push, label).toBe(false);
      expect(autonomy.grants.pr, label).toBe(false);
      expect(autonomy.grants.rerun, label).toBe(false);
      expect(autonomy.verification, label).toBe("independent");
      expect(autonomy.note, label).toContain("grants are read only from");
      const decision = requireGrant(at("strict"), "push");
      expect(decision.allowed, label).toBe(false);
      if (!decision.allowed) expect(decision.error, label).toContain('workspace "strict"');
      expect(grantsMatter("push"), label).toBe(true);
      expect(rawGrantDenial(at("strict"), "push"), label).not.toBeNull();
      unredirect();
    }
});

test("2. Given a sealed open entry, When the config is redirected, Then merge and release cap at the defaults, endpoint commit, verification proportional, and the unblock names the redirect", () => {
  sealAccount([open()]);
  expect(resolveAutonomy(at("open")).grants.merge).toBe("verified");
  REDIRECTS.WORKIT_CONFIG(agentDir());
  write(agentDir(), [greedy("open", "open")]);
  const autonomy = resolveAutonomy(at("open"));
  expect(autonomy.grants).toEqual({ ...DEFAULT_GRANTS });
  expect(autonomy.effectiveEndpoint).toBe("commit");
  expect(autonomy.verification).toBe("proportional");
  expect(autonomy.unblocks?.merge).toContain("redirect");
  const merge = requireGrant(at("open"), "merge");
  expect(merge.allowed).toBe(false);
  if (!merge.allowed) expect(merge.unblock).toContain("redirect");
});

test("3. Under a redirect, remote caps, the account requirement and a broken seal still apply; with no account file it is the D4 defaults", () => {
  const url = "https://github.com/acme/strict.git";
  const repo = at("other");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", url], { cwd: repo });
  try {
    sealAccount([strict({ remotes: [url], autonomy: { push: false } })]);
    REDIRECTS.WORKIT_CONFIG(agentDir());
    expect(resolveAutonomy(repo).grants.push).toBe(false);
  } finally {
    rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  }
  unredirect();
  sealAccount([{ name: "bare", glob: `${root}/open/**`, autonomy: { push: true } }]);
  REDIRECTS.WORKIT_CONFIG(agentDir());
  expect(requireGrant(at("open"), "push")).toMatchObject({ reason: "account_required" });
  unredirect();
  sealAccount([strict()]);
  write(configHome.configDir, [strict({ autonomy: { push: true, pr: true } })]);
  REDIRECTS.WORKIT_CONFIG(agentDir());
  expect(resolveAutonomy(at("strict")).grants.push).toBe(false);
  unredirect();
  rmSync(path.join(configHome.configDir, "workspaces.json"));
  rmSync(path.join(configHome.configDir, SEAL_FILE));
  const plain = resolveAutonomy(at("open"));
  REDIRECTS.WORKIT_CONFIG(agentDir());
  write(agentDir(), [greedy("open", "open")]);
  const redirected = resolveAutonomy(at("open"));
  expect(redirected.note).toContain("does not apply to grants");
  expect({ ...redirected, note: undefined }).toEqual({ ...plain, note: undefined });
});

test("4. youtrack.writes is auto only from the sealed account file, without a redirect, a bench world or a name that disagrees", () => {
  const auto = { youtrack: { writes: "auto" } };
  // A redirected file saying auto: ask, each way.
  write(agentDir(), [greedy("open", "open")]);
  for (const [how, redirect] of Object.entries(REDIRECTS)) {
    redirect(agentDir());
    expect(youTrackWritesMode(at("open")), how).toBe("ask");
    unredirect();
  }
  // The sealed account says auto: auto, and ask once redirected.
  sealAccount([open(auto)]);
  expect(youTrackWritesMode(at("open"))).toBe("auto");
  for (const [how, redirect] of Object.entries(REDIRECTS)) {
    redirect(emptyDir());
    expect(youTrackWritesMode(at("open")), how).toBe("ask");
    unredirect();
  }
  // No seal, or a broken one: ask.
  rmSync(path.join(configHome.configDir, SEAL_FILE));
  expect(youTrackWritesMode(at("open"))).toBe("ask");
  sealAccount([open()]);
  write(configHome.configDir, [open(auto)]);
  expect(youTrackWritesMode(at("open"))).toBe("ask");
  // A broad named entry saying auto over a folder entry saying ask: ask; both auto: auto.
  const broad = (extra: Entry) => ({ name: "broad", glob: `${root}/**`, vcs: account, ...extra });
  sealAccount([broad(auto), open()]);
  process.env.WORKIT_WORKSPACE_NAME = "broad";
  expect(youTrackWritesMode(at("open"))).toBe("ask");
  sealAccount([broad(auto), open(auto)]);
  expect(youTrackWritesMode(at("open"))).toBe("auto");
  delete process.env.WORKIT_WORKSPACE_NAME;
  // A bench world whose config says auto: ask.
  const world = realpathSync(mkdtempSync(path.join(os.tmpdir(), "workit-eval-seal-")));
  try {
    mkdirSync(path.join(world, "repo"), { recursive: true });
    mkdirSync(path.join(world, "config"), { recursive: true });
    writeFileSync(path.join(world, EVAL_WORLD_MARKER), "");
    write(path.join(world, "config"), [{ name: "eval", glob: `${world}/**`, ...auto }]);
    process.env[EVAL_WORLD_ENV] = world;
    process.env.WORKIT_CONFIG = path.join(world, "config");
    expect(youTrackWritesMode(path.join(world, "repo"))).toBe("ask");
  } finally {
    rmSync(world, { recursive: true, force: true });
  }
});

test("5. Adding, changing or removing vcs.tokenFile or vcs.host breaks the seal; vcs.defaultTargetBranch does not", () => {
  const vcs = (extra: Entry) => [open({ vcs: { ...account, ...extra } })];
  const cases: Array<[string, Entry, Entry]> = [
    ["tokenFile added", {}, { tokenFile: "/x/token" }],
    ["tokenFile changed", { tokenFile: "/x/token" }, { tokenFile: "/y/token" }],
    ["tokenFile removed", { tokenFile: "/x/token" }, {}],
    ["host added", {}, { host: "git.example.test" }],
    ["host changed", { host: "git.example.test" }, { host: "other.example.test" }],
    ["host removed", { host: "git.example.test" }, {}],
  ];
  for (const [label, sealed, current] of cases) {
    sealAccount(vcs(sealed));
    write(configHome.configDir, vcs(current));
    expect(checkSeal(configHome.configDir).state, label).toBe("broken");
  }
  sealAccount(vcs({}));
  write(configHome.configDir, vcs({ defaultTargetBranch: "develop" }));
  expect(checkSeal(configHome.configDir).state).toBe("valid");
});

const counting = () => {
  const calls: string[][] = [];
  const runner: ForgeRunner = (_bin, args) => {
    calls.push([...args]);
    return { status: 1, stdout: "", stderr: "stub", timedOut: false, missing: false };
  };
  return { calls, runner };
};

test("6. Given a sealed account:me entry, When its identity is rewritten, Then forge verbs are blocked with identity_unsealed before any runner call, and resolve after sealConfig", () => {
  const sealed = open({ autonomy: { merge: "verified" } });
  const rewrites: Array<[string, Entry]> = [
    ["account rewritten", { provider: "github", account: "agent" }],
    ["tokenFile added", { ...account, tokenFile: "/tmp/agent-token" }],
    ["host changed", { ...account, host: "git.agent.test" }],
    ["provider changed", { provider: "gitlab", account: "me" }],
  ];
  for (const [label, vcs] of rewrites) {
    sealAccount([sealed]);
    write(configHome.configDir, [{ ...sealed, vcs }]);
    const { calls, runner } = counting();
    for (const result of [
      resolveForge(at("open"), { runner }),
      checkPushIdentity(at("open"), { runner }),
    ]) {
      expect(result.ok, label).toBe(false);
      if (!result.ok) {
        expect(result.code, label).toBe("blocked");
        expect(result.error, label).toContain("identity_unsealed");
        expect(result.unblock, label).toContain(SEAL);
      }
    }
    expect(calls, label).toHaveLength(0);
    sealConfig(configHome.configDir);
    expect(identityDenial(at("open"), { vcs }), label).toBeNull();
    const after = resolveForge(at("open"), { runner });
    if (!after.ok) expect(after.error, label).not.toContain("identity_unsealed");
  }
});

test("7. Identity stays free for a new entry with no sealed counterpart, with no seal, and under a redirect, with grants at most D4", () => {
  const newcomer = { ...greedy("newcomer", "other"), vcs: { provider: "github", account: "b" } };
  sealAccount([strict()]);
  write(configHome.configDir, [strict(), newcomer]);
  expect(identityDenial(at("other"), newcomer)).toBeNull();
  expect(resolveAutonomy(at("other")).grants.merge).toBe(false);
  rmSync(path.join(configHome.configDir, SEAL_FILE));
  expect(identityDenial(at("other"), newcomer)).toBeNull();
  expect(resolveAutonomy(at("other")).grants.merge).toBe(false);
  sealAccount([strict()]);
  write(configHome.configDir, [strict({ vcs: { provider: "github", account: "b" } })]);
  REDIRECTS.WORKIT_CONFIG(agentDir());
  expect(identityDenial(at("strict"), { vcs: { provider: "github", account: "b" } })).toBeNull();
  expect(resolveAutonomy(at("strict")).grants.push).toBe(false);
});

test("10. In every test process the grants home is a run-scoped temp dir, never the account record's", () => {
  expect(preloadStateDir).not.toBe("");
  expect(preloadGrantsDir.startsWith(preloadStateDir)).toBe(true);
  const real = accountHome();
  if (real) expect(preloadGrantsDir.startsWith(real)).toBe(false);
  expect(typeof grantsHome.resolve).toBe("function");
});
