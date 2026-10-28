import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ENDPOINTS,
  GRANT_KINDS,
  requireGrant,
  resolveAutonomy,
  type Autonomy,
  type GrantKind,
  type VerificationMode,
} from "@/packages/workit-core/src/autonomy";

// #536: WORKFLOW_WORKSPACE_NAME is set by whatever shell runs Workit, an
// agent's included, so it may choose which matching entry's vcs and policies
// apply but never raise grants, defaultEndpoint or verification above what the
// folder resolves to without it.

let configHome: ConfigHome;
let root = "";
const savedName = process.env.WORKFLOW_WORKSPACE_NAME;
beforeAll(() => {
  configHome = useConfigHome("wk-name-cap-config-");
  root = mkdtempSync(path.join(os.tmpdir(), "wk-name-cap-")).replaceAll("\\", "/");
});
afterAll(() => {
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  if (savedName === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = savedName;
});

const write = (workspaces: Record<string, unknown>[]) =>
  writeFileSync(path.join(configHome.configDir, "workspaces.json"), JSON.stringify({ workspaces }));
const withName = <T>(name: string | undefined, run: () => T): T => {
  if (name === undefined) delete process.env.WORKFLOW_WORKSPACE_NAME;
  else process.env.WORKFLOW_WORKSPACE_NAME = name;
  return run();
};
const account = { provider: "github", account: "me" };

test("a broader workspace named in a nested repo never lifts the nested entry's stricter merge", () => {
  write([
    {
      name: "work",
      glob: `${root}/work/**`,
      vcs: account,
      autonomy: { merge: true },
      defaultEndpoint: "merged",
      verification: "self",
    },
    {
      name: "brasil",
      glob: `${root}/work/clients/brasil/**`,
      vcs: { provider: "gitlab", account: "me" },
      autonomy: { merge: false },
      verification: "independent",
    },
  ]);
  const cwd = `${root}/work/clients/brasil/repo`;
  expect(withName(undefined, () => requireGrant(cwd, "merge")).allowed).toBe(false);
  const named = withName("work", () => resolveAutonomy(cwd));
  // The name still selects the entry (its vcs and policies come from work)...
  expect(named.workspace).toBe("work");
  // ...but merge, the endpoint and verification stay at brasil's.
  expect(named.grants.merge).toBe(false);
  // work's configured endpoint shows, but it acts as brasil's.
  expect(named.defaultEndpoint).toBe("merged");
  expect(named.effectiveEndpoint).toBe("commit");
  expect(named.verification).toBe("independent");
  expect(named.note).toContain("brasil");
  expect(withName("work", () => requireGrant(cwd, "merge"))).toMatchObject({
    allowed: false,
    reason: "grant_required",
  });
});

test("a name's verification=self under a proportional folder entry is capped to proportional", () => {
  write([
    { name: "loose", glob: `${root}/v/**`, vcs: account, verification: "self" },
    {
      name: "tight",
      glob: `${root}/v/tight/**`,
      vcs: account,
      verification: "proportional",
    },
  ]);
  const cwd = `${root}/v/tight/repo`;
  const named = withName("loose", () => resolveAutonomy(cwd));
  expect(named.workspace).toBe("loose");
  expect(named.verification).toBe("proportional");
  expect(named.note).toContain("verification");
});

test("naming one of two tied entries grants nothing beyond nothing-granted", () => {
  write([
    { name: "a", glob: `${root}/tie/**`, vcs: account, autonomy: { merge: true, release: true } },
    { name: "b", glob: `${root}/tie/**`, vcs: account },
  ]);
  const cwd = `${root}/tie/repo`;
  expect(() => withName(undefined, () => resolveAutonomy(cwd))).toThrow(/ambiguous/);
  const named = withName("a", () => resolveAutonomy(cwd));
  expect(named.workspace).toBe("a");
  for (const kind of GRANT_KINDS) {
    expect(named.grants[kind]).toBe(false);
    expect(withName("a", () => requireGrant(cwd, kind)).allowed).toBe(false);
  }
  expect(named.effectiveEndpoint).toBe("commit");
  expect(named.verification).toBe("independent");
  expect(named.note).toContain("ambiguous");
});

test("naming the most specific entry changes nothing", () => {
  write([
    { name: "work", glob: `${root}/mine/**`, vcs: account },
    {
      name: "inner",
      glob: `${root}/mine/inner/**`,
      vcs: account,
      autonomy: { merge: "verified", release: true },
      defaultEndpoint: "merged",
      verification: "self",
    },
  ]);
  const cwd = `${root}/mine/inner/repo`;
  const unnamed = withName(undefined, () => resolveAutonomy(cwd));
  expect(withName("inner", () => resolveAutonomy(cwd))).toEqual(unnamed);
  expect(unnamed.note).toBeUndefined();
});

// --- model test: the name never raises any effective value ---

const rng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
  return seed / 0x8000_0000;
};
const STRICT: readonly VerificationMode[] = ["independent", "proportional", "self"];

type Effective = {
  allowed: Record<GrantKind, boolean>;
  forgeless: Record<GrantKind, boolean>;
  unverified: boolean;
  endpoint: number;
  verification: number;
};
const NOTHING: Effective = {
  allowed: Object.fromEntries(GRANT_KINDS.map((kind) => [kind, false])) as Record<
    GrantKind,
    boolean
  >,
  forgeless: Object.fromEntries(GRANT_KINDS.map((kind) => [kind, false])) as Record<
    GrantKind,
    boolean
  >,
  unverified: false,
  endpoint: 0,
  verification: 0,
};
const effectiveAt = (cwd: string, name: string | undefined): Effective | null =>
  withName(name, () => {
    let autonomy: Autonomy;
    try {
      autonomy = resolveAutonomy(cwd);
    } catch {
      return null;
    }
    const decide = (kind: GrantKind, forge: boolean) => requireGrant(cwd, kind, { forge });
    const merge = decide("merge", true);
    return {
      allowed: Object.fromEntries(GRANT_KINDS.map((k) => [k, decide(k, true).allowed])) as Record<
        GrantKind,
        boolean
      >,
      forgeless: Object.fromEntries(
        GRANT_KINDS.map((k) => [k, decide(k, false).allowed]),
      ) as Record<GrantKind, boolean>,
      unverified: merge.allowed && merge.allowUnverified,
      endpoint: DEFAULT_ENDPOINTS.indexOf(autonomy.effectiveEndpoint),
      verification: STRICT.indexOf(autonomy.verification),
    };
  });

test("model: over generated configs and folders, a workspace name never raises an effective value", () => {
  const next = rng(536);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const globs = [
    `${root}/m/**`,
    `${root}/m/a/**`,
    `${root}/m/a/b/**`,
    `${root}/m/*/b/**`,
    `${root}/m/x/**`,
  ];
  const cwds = [`${root}/m/a/b/repo`, `${root}/m/a/repo`, `${root}/m/x/repo`, `${root}/m/repo`];
  let compared = 0;
  for (let round = 0; round < 120; round += 1) {
    const count = 2 + Math.floor(next() * 3);
    const entries = Array.from({ length: count }, (_, index) => {
      const autonomy = Object.fromEntries(
        GRANT_KINDS.flatMap((kind) => {
          const value = pick([undefined, true, false, "verified"] as const);
          return value === undefined ? [] : [[kind, value]];
        }),
      );
      return {
        name: `e${index}`,
        glob: pick(globs),
        ...(next() < 0.8 ? { vcs: account } : {}),
        ...(Object.keys(autonomy).length ? { autonomy } : {}),
        ...(next() < 0.6 ? { defaultEndpoint: pick(DEFAULT_ENDPOINTS) } : {}),
        ...(next() < 0.6 ? { verification: pick(STRICT) } : {}),
      };
    });
    write(entries);
    const cwd = pick(cwds);
    const unnamed = effectiveAt(cwd, undefined) ?? NOTHING;
    for (const entry of entries) {
      const named = effectiveAt(cwd, entry.name);
      if (!named) continue; // the name does not match this folder: refused outright
      compared += 1;
      const context = JSON.stringify({ cwd, name: entry.name, entries });
      for (const kind of GRANT_KINDS) {
        if (named.allowed[kind])
          expect({ kind, ok: unnamed.allowed[kind], context }).toMatchObject({ ok: true });
        if (named.forgeless[kind])
          expect({ kind, ok: unnamed.forgeless[kind], context }).toMatchObject({ ok: true });
      }
      if (named.unverified) expect({ ok: unnamed.unverified, context }).toMatchObject({ ok: true });
      expect({ ok: named.endpoint <= unnamed.endpoint, context }).toMatchObject({ ok: true });
      expect({ ok: named.verification <= unnamed.verification, context }).toMatchObject({
        ok: true,
      });
    }
  }
  expect(compared).toBeGreaterThan(100);
});
