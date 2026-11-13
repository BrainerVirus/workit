// #819: a check at read time does not depend on how workspaces.json was
// written. When `<account config dir>/workspaces.json.seal` exists and the
// authority fields no longer match it, every authority value is the stricter
// of its current and last sealed value, and the note names the terminal
// command that accepts the change. Without a seal the D4 defaults are the
// sealed value.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  grantsMatter,
  rawGrantDenial,
  requireGrant,
  resolveAutonomy,
} from "@/packages/workit-core/src/autonomy";
import { SEAL_FILE, sealDocument } from "@/packages/workit-core/src/core/grant-seal";
import { sshSeam } from "@/packages/workit-core/src/core/remotes";
import { youTrackWritesMode } from "@/packages/workit-core/src/core/youtrack-writes";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
let root = "";
const savedSsh = sshSeam.read;
const savedName = process.env.WORKIT_WORKSPACE_NAME;
beforeAll(() => {
  delete process.env.WORKIT_WORKSPACE_NAME;
  sshSeam.read = () => ({ text: "", home: os.tmpdir() });
  configHome = useConfigHome("wk-grant-seal-config-", { seal: "manual" });
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-grant-seal-"))).replaceAll("\\", "/");
  for (const dir of ["strict/repo", "open/repo", "other/repo"])
    mkdirSync(path.join(root, dir), { recursive: true });
});
afterAll(() => {
  sshSeam.read = savedSsh;
  if (savedName !== undefined) process.env.WORKIT_WORKSPACE_NAME = savedName;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const name of ["workspaces.json", SEAL_FILE])
    rmSync(path.join(configHome.configDir, name), {
      recursive: true,
      force: true,
    });
});

const SEAL = "workit workspace seal";
const account = { provider: "github", account: "me" };
type Entry = Record<string, unknown>;
const write = (workspaces: Entry[]) =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ workspaces }));
const strict = (extra: Entry = {}): Entry => ({
  name: "strict",
  glob: `${root}/strict/**`,
  vcs: account,
  autonomy: { push: false, pr: false },
  ...extra,
});
const open = (extra: Entry = {}): Entry => ({
  name: "open",
  glob: `${root}/open/**`,
  vcs: account,
  autonomy: { push: true, pr: true, merge: "verified" },
  defaultEndpoint: "pr",
  ...extra,
});
const at = (dir: string) => `${root}/${dir}/repo`;
/** Seal `sealed`, then write `current` over it, as a write no hook saw would. */
const tamper = (sealed: Entry[], current: Entry[]) => {
  write(sealed);
  sealConfig(configHome.configDir);
  write(current);
};

test("Given a matching seal, Then grants, endpoint, verification and youtrack.writes are as written", () => {
  const entries = [
    strict({ verification: "independent" }),
    open({
      autonomy: { push: true, pr: true, merge: true, release: true },
      defaultEndpoint: "merged",
      verification: "self",
      youtrack: { writes: "auto" },
    }),
  ];
  write(entries);
  expect(youTrackWritesMode(at("open"))).toBe("ask");
  sealConfig(configHome.configDir);
  const [strictAt, openAt, otherAt] = [at("strict"), at("open"), at("other")].map((cwd) =>
    resolveAutonomy(cwd),
  );
  expect(strictAt.grants.push).toBe(false);
  expect(strictAt.verification).toBe("independent");
  expect(openAt.grants).toEqual({ push: true, pr: true, merge: true, release: true, rerun: true });
  expect(openAt.effectiveEndpoint).toBe("merged");
  expect(openAt.verification).toBe("self");
  expect(otherAt.workspace).toBeNull();
  for (const autonomy of [strictAt, openAt, otherAt]) expect(autonomy.note).toBeUndefined();
  expect(youTrackWritesMode(at("open"))).toBe("auto");
});

test("Given no seal, When grants are raised above the D4 defaults in the file, Then they fall back to the defaults and the note names the seal command", () => {
  write([open({ autonomy: { merge: true }, defaultEndpoint: "merged", verification: "self" })]);
  const autonomy = resolveAutonomy(at("open"));
  expect(autonomy.grants.merge).toBe(false);
  expect(autonomy.effectiveEndpoint).toBe("commit");
  expect(autonomy.verification).toBe("proportional");
  expect(autonomy.note).toContain(SEAL);
  expect(autonomy.unblocks?.merge).toContain(SEAL);
  expect(grantsMatter("merge")).toBe(true);
  const decision = requireGrant(at("open"), "merge");
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.unblock).toContain(SEAL);
});

test("Given no seal, When the file only lowers below the defaults, Then it applies with no note", () => {
  write([strict()]);
  const autonomy = resolveAutonomy(at("strict"));
  expect(autonomy.grants.push).toBe(false);
  expect(autonomy.note).toBeUndefined();
});

test("Given a seal and a changed authority field, Then each falls back to the stricter of current and sealed, and the note names the seal command", () => {
  const cases: Array<{
    field: string;
    sealed: Entry[];
    current: Entry[];
    cwd: string;
    expect: (cwd: string) => void;
  }> = [
    {
      field: "autonomy (a raised grant)",
      sealed: [strict()],
      current: [strict({ autonomy: { push: true, pr: true } })],
      cwd: at("strict"),
      expect: (cwd) => {
        const autonomy = resolveAutonomy(cwd);
        expect(autonomy.grants.push).toBe(false);
        expect(autonomy.grants.pr).toBe(false);
        const decision = requireGrant(cwd, "push");
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) expect(decision.unblock).toContain(SEAL);
      },
    },
    {
      field: "autonomy (merge verified to true)",
      sealed: [open()],
      current: [open({ autonomy: { push: true, pr: true, merge: true } })],
      cwd: at("open"),
      expect: (cwd) => expect(resolveAutonomy(cwd).grants.merge).toBe("verified"),
    },
    {
      field: "legacy autoApprove",
      sealed: [open({ autonomy: undefined })],
      current: [open({ autonomy: undefined, autoApprove: true })],
      cwd: at("open"),
      expect: (cwd) => expect(resolveAutonomy(cwd).grants.merge).toBe(false),
    },
    {
      field: "defaultEndpoint",
      sealed: [open({ autonomy: { merge: true } })],
      current: [open({ autonomy: { merge: true }, defaultEndpoint: "merged" })],
      cwd: at("open"),
      expect: (cwd) => {
        const autonomy = resolveAutonomy(cwd);
        expect(autonomy.effectiveEndpoint).toBe("pr");
        expect(autonomy.endpointReason).toContain(SEAL);
      },
    },
    {
      field: "verification",
      sealed: [open({ verification: "independent" })],
      current: [open({ verification: "self" })],
      cwd: at("open"),
      expect: (cwd) => expect(resolveAutonomy(cwd).verification).toBe("independent"),
    },
    {
      field: "youtrack.writes",
      sealed: [open()],
      current: [open({ youtrack: { writes: "auto" } })],
      cwd: at("open"),
      expect: (cwd) => expect(youTrackWritesMode(cwd)).toBe("ask"),
    },
    {
      field: "vcs.account",
      sealed: [open({ vcs: { provider: "github" } })],
      current: [open()],
      cwd: at("open"),
      expect: (cwd) => {
        expect(resolveAutonomy(cwd).accountConfigured).toBe(false);
        expect(requireGrant(cwd, "push")).toMatchObject({
          reason: "account_required",
        });
      },
    },
    {
      field: "vcs.provider",
      sealed: [open()],
      current: [open({ vcs: { provider: "gitlab", account: "me" } })],
      cwd: at("open"),
      expect: (cwd) => expect(resolveAutonomy(cwd).grants.merge).toBe("verified"),
    },
    {
      field: "name",
      sealed: [open()],
      current: [open({ name: "renamed" })],
      cwd: at("open"),
      expect: (cwd) => expect(resolveAutonomy(cwd).workspace).toBe("renamed"),
    },
    {
      field: "entry order",
      sealed: [strict(), open()],
      current: [open(), strict()],
      cwd: at("open"),
      expect: (cwd) => expect(resolveAutonomy(cwd).grants.push).toBe(true),
    },
    {
      field: "glob (widened over a folder no sealed entry covers)",
      sealed: [strict(), open({ autonomy: { merge: true, release: true } })],
      current: [strict(), open({ glob: `${root}/**`, autonomy: { merge: true, release: true } })],
      cwd: at("other"),
      expect: (cwd) => {
        const autonomy = resolveAutonomy(cwd);
        expect(autonomy.workspace).toBe("open");
        expect(autonomy.grants.merge).toBe(false);
        expect(autonomy.grants.release).toBe(false);
        expect(autonomy.unblocks?.merge).toContain(SEAL);
      },
    },
  ];
  for (const item of cases) {
    tamper(item.sealed, item.current);
    const note = resolveAutonomy(item.cwd).note;
    expect(note, item.field).toContain(SEAL);
    expect(note, item.field).toContain("does not match its seal");
    item.expect(item.cwd);
  }
});

test("Given a seal, When only settings outside authority change, Then the seal stays valid", () => {
  tamper(
    [open()],
    [
      open({
        deleteBranch: false,
        delegation: "lead-orchestrates",
        vcs: { ...account, defaultTargetBranch: "develop" },
        youtrack: { project: "X" },
      }),
    ],
  );
  const autonomy = resolveAutonomy(at("open"));
  expect(autonomy.note).toBeUndefined();
  expect(autonomy.grants.merge).toBe("verified");
});

test("Given a sealed remote claim, When the remote is removed, Then the checkout stays capped and the raw push is denied naming the seal command", () => {
  const url = "https://github.com/acme/strict.git";
  const repo = at("open");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["remote", "add", "origin", url], { cwd: repo });
  try {
    write([strict({ remotes: [url] }), open()]);
    expect(resolveAutonomy(repo).grants.push).toBe(false);
    tamper([strict({ remotes: [url] }), open()], [strict(), open()]);
    expect(resolveAutonomy(repo).grants.push).toBe(false);
    expect(grantsMatter("push")).toBe(true);
    const denial = rawGrantDenial(repo, "push");
    expect(denial?.unblock).toContain(SEAL);
  } finally {
    rmSync(path.join(repo, ".git"), { recursive: true, force: true });
  }
});

test("Given a broken seal, Then grantsMatter and the raw-git denial judge by the sealed value", () => {
  write([strict({ autonomy: { push: true, pr: true } })]);
  sealConfig(configHome.configDir);
  // Sealed as granted: nothing to judge, as today.
  expect(grantsMatter("push")).toBe(false);
  tamper([strict()], [strict({ autonomy: { push: true, pr: true } })]);
  expect(grantsMatter("push")).toBe(true);
  const denial = rawGrantDenial(at("strict"), "push");
  expect(denial?.error).toContain("does not match its seal");
  expect(denial?.unblock).toContain(SEAL);
});

test("Given a malformed or unreadable seal, Then it counts as a mismatch with the D4 defaults as the sealed value", () => {
  const seal = path.join(configHome.configDir, SEAL_FILE);
  const forged = sealDocument([open({ autonomy: { merge: true, release: true } })], new Date());
  const shapes: Array<[string, () => void]> = [
    ["not JSON", () => writeFileSync(seal, "{ not json")],
    ["wrong version", () => writeFileSync(seal, JSON.stringify({ ...forged, version: 99 }))],
    [
      "digest of another projection",
      () => writeFileSync(seal, JSON.stringify({ ...forged, projection: [open()] })),
    ],
    ["a directory", () => mkdirSync(seal)],
  ];
  for (const [shape, make] of shapes) {
    rmSync(seal, { recursive: true, force: true });
    write([open({ autonomy: { push: true, pr: true, merge: true, release: true } })]);
    make();
    const autonomy = resolveAutonomy(at("open"));
    expect(autonomy.note, shape).toContain(SEAL);
    expect(autonomy.grants, shape).toEqual({
      push: true,
      pr: true,
      merge: false,
      release: false,
      rerun: true,
    });
    expect(grantsMatter("merge"), shape).toBe(true);
    expect(grantsMatter("push"), shape).toBe(false);
  }
});

test("Given push below the D4 default in both sealed and current, When the seal is broken, Then push stays false", () => {
  tamper([strict()], [strict({ verification: "self" })]);
  expect(resolveAutonomy(at("strict")).grants.push).toBe(false);
  // No sealed value at all (D4 push is true) never raises it either.
  writeFileSync(path.join(configHome.configDir, SEAL_FILE), "garbage");
  expect(resolveAutonomy(at("strict")).grants.push).toBe(false);
});
