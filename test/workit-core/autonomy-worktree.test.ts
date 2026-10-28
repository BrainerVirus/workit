import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ENDPOINTS,
  GRANT_KINDS,
  requireGrant,
  resolveAutonomy,
  type GrantKind,
  type VerificationMode,
} from "@/packages/workit-core/src/autonomy";

// #540: a linked worktree resolves its workspace from its own path, but its
// grants, endpoint and verification never exceed its main checkout's; and a
// capped refusal's unblock names the entry that capped it.

let configHome: ConfigHome;
let root = "";
const savedName = process.env.WORKFLOW_WORKSPACE_NAME;
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
};
/** A repo at `main` with linked worktrees at `worktrees`. */
const repo = (main: string, worktrees: string[]) => {
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q");
  git(
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  );
  for (const [index, at] of worktrees.entries()) {
    mkdirSync(path.dirname(at), { recursive: true });
    git(main, "worktree", "add", "-q", "-b", `wt${index}`, at);
  }
};
beforeAll(() => {
  configHome = useConfigHome("wk-wt-cap-config-");
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-wt-cap-"))).replaceAll("\\", "/");
  repo(`${root}/work/clients/brasil/app`, [`${root}/work/wt/app`, `${root}/elsewhere/app`]);
  repo(`${root}/m/a/main`, [`${root}/m/a/b/wt`, `${root}/m/x/wt`, `${root}/m/wt`]);
  repo(`${root}/m/x/main`, [`${root}/m/a/b/wt2`, `${root}/m/a/wt2`]);
  for (const plain of [
    `${root}/m/a/b/plain`,
    `${root}/m/a/plain`,
    `${root}/m/x/plain`,
    `${root}/m/plain`,
  ])
    mkdirSync(plain, { recursive: true });
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
const brasilConfig = () => [
  {
    name: "work",
    glob: `${root}/work/**`,
    vcs: account,
    autonomy: { merge: true, release: true },
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
];

test("a worktree under a broader permissive entry is capped at its main checkout's stricter entry", () => {
  write(brasilConfig());
  const worktree = `${root}/work/wt/app`;
  const autonomy = withName(undefined, () => resolveAutonomy(worktree));
  // Its own path still picks the entry (vcs and policies come from work)...
  expect(autonomy.workspace).toBe("work");
  // ...but merge, release, the endpoint and verification stay at brasil's.
  expect(autonomy.grants.merge).toBe(false);
  expect(autonomy.grants.release).toBe(false);
  expect(autonomy.effectiveEndpoint).toBe("commit");
  expect(autonomy.verification).toBe("independent");
  expect(autonomy.note).toContain("brasil");
  const decision = withName(undefined, () => requireGrant(worktree, "merge"));
  expect(decision).toMatchObject({ allowed: false, reason: "grant_required" });
  if (decision.allowed) throw new Error("unreachable");
  expect(decision.unblock).toContain("workit grant set brasil merge=verified");
  expect(decision.unblock).not.toContain("grant set work ");
});

test("a worktree outside every entry still takes its main checkout's workspace", () => {
  write(brasilConfig());
  const autonomy = withName(undefined, () => resolveAutonomy(`${root}/elsewhere/app`));
  expect(autonomy.workspace).toBe("brasil");
  expect(autonomy.note).toBeUndefined();
});

test("a worktree whose main checkout's entries tie grants nothing and names the tie", () => {
  write([
    { name: "wide", glob: `${root}/work/**`, vcs: account, autonomy: { merge: true } },
    { name: "a", glob: `${root}/work/clients/brasil/**`, vcs: account },
    { name: "b", glob: `${root}/work/clients/brasil/**`, vcs: account },
  ]);
  const worktree = `${root}/work/wt/app`;
  const autonomy = withName(undefined, () => resolveAutonomy(worktree));
  for (const kind of GRANT_KINDS) expect(autonomy.grants[kind]).toBe(false);
  const decision = withName(undefined, () => requireGrant(worktree, "merge"));
  if (decision.allowed) throw new Error("expected a refusal");
  expect(decision.unblock).toContain("a, b");
  expect(decision.unblock).not.toContain("grant set wide");
});

test("a name-capped refusal names the folder's entry, not the named one", () => {
  write(brasilConfig());
  const cwd = `${root}/work/clients/brasil/app`;
  const decision = withName("work", () => requireGrant(cwd, "merge"));
  if (decision.allowed) throw new Error("expected a refusal");
  expect(decision.unblock).toContain("workit grant set brasil merge=verified");
  expect(decision.unblock).not.toContain("grant set work ");
});

test("a name and a worktree compose: both caps apply and both are noted", () => {
  write([
    { name: "outer", glob: `${root}/work/**`, vcs: account, autonomy: { merge: true } },
    {
      name: "mid",
      glob: `${root}/work/wt/**`,
      vcs: account,
      autonomy: { merge: "verified", release: true },
    },
    { name: "brasil", glob: `${root}/work/clients/brasil/**`, vcs: account },
  ]);
  const worktree = `${root}/work/wt/app`;
  const autonomy = withName("outer", () => resolveAutonomy(worktree));
  expect(autonomy.workspace).toBe("outer");
  expect(autonomy.grants.merge).toBe(false);
  expect(autonomy.grants.release).toBe(false);
  expect(autonomy.note).toContain("WORKFLOW_WORKSPACE_NAME=outer");
  expect(autonomy.note).toContain("brasil");
});

// --- model test: a worktree never exceeds its main checkout or its unnamed resolution ---

const rng = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
  return seed / 0x8000_0000;
};
const STRICT: readonly VerificationMode[] = ["independent", "self", "proportional"];
type Effective = {
  allowed: Record<GrantKind, boolean>;
  forgeless: Record<GrantKind, boolean>;
  unverified: boolean;
  endpoint: number;
  verification: number;
};
const NOTHING: Effective = {
  allowed: Object.fromEntries(GRANT_KINDS.map((k) => [k, false])) as Record<GrantKind, boolean>,
  forgeless: Object.fromEntries(GRANT_KINDS.map((k) => [k, false])) as Record<GrantKind, boolean>,
  unverified: false,
  endpoint: 0,
  verification: 0,
};
/** The effective values at cwd, or null when resolution refuses (nothing granted). */
const effectiveAt = (
  cwd: string,
  name?: string,
): (Effective & { workspace: string | null }) | null =>
  withName(name, () => {
    let autonomy;
    try {
      autonomy = resolveAutonomy(cwd);
    } catch {
      return null;
    }
    const decide = (kind: GrantKind, forge: boolean) => requireGrant(cwd, kind, { forge });
    const merge = decide("merge", true);
    const each = (forge: boolean) =>
      Object.fromEntries(GRANT_KINDS.map((k) => [k, decide(k, forge).allowed])) as Record<
        GrantKind,
        boolean
      >;
    return {
      workspace: autonomy.workspace,
      allowed: each(true),
      forgeless: each(false),
      unverified: merge.allowed && merge.allowUnverified,
      endpoint: DEFAULT_ENDPOINTS.indexOf(autonomy.effectiveEndpoint),
      verification: STRICT.indexOf(autonomy.verification),
    };
  });
const atMost = (low: Effective, high: Effective, context: string) => {
  for (const kind of GRANT_KINDS) {
    if (low.allowed[kind])
      expect({ kind, ok: high.allowed[kind], context }).toMatchObject({ ok: true });
    if (low.forgeless[kind])
      expect({ kind, ok: high.forgeless[kind], context }).toMatchObject({ ok: true });
  }
  if (low.unverified) expect({ ok: high.unverified, context }).toMatchObject({ ok: true });
  expect({ ok: low.endpoint <= high.endpoint, context }).toMatchObject({ ok: true });
  expect({ ok: low.verification <= high.verification, context }).toMatchObject({ ok: true });
};

test("model: over generated configs, a worktree never exceeds its main checkout, its own path or its unnamed resolution", () => {
  const next = rng(540);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const globs = [
    `${root}/m/**`,
    `${root}/m/a/**`,
    `${root}/m/a/b/**`,
    `${root}/m/*/b/**`,
    `${root}/m/x/**`,
  ];
  // [worktree, its main checkout, a plain folder its own path resolves like]
  const cases = [
    [`${root}/m/a/b/wt`, `${root}/m/a/main`, `${root}/m/a/b/plain`],
    [`${root}/m/x/wt`, `${root}/m/a/main`, `${root}/m/x/plain`],
    [`${root}/m/wt`, `${root}/m/a/main`, `${root}/m/plain`],
    [`${root}/m/a/b/wt2`, `${root}/m/x/main`, `${root}/m/a/b/plain`],
    [`${root}/m/a/wt2`, `${root}/m/x/main`, `${root}/m/a/plain`],
  ] as const;
  let compared = 0;
  for (let round = 0; round < 100; round += 1) {
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
    const [worktree, main, plain] = pick(cases);
    const context = JSON.stringify({ worktree, main, entries });
    const unnamed = effectiveAt(worktree);
    if (!unnamed) continue; // the worktree's own entries tie: refused outright
    compared += 1;
    atMost(unnamed, effectiveAt(main) ?? NOTHING, `main ${context}`);
    const own = effectiveAt(plain);
    if (own?.workspace) atMost(unnamed, own, `own ${context}`);
    for (const entry of entries) {
      const named = effectiveAt(worktree, entry.name);
      if (named) atMost(named, unnamed, `named ${entry.name} ${context}`);
    }
  }
  expect(compared).toBeGreaterThan(50);
});
