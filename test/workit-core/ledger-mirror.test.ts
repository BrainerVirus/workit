// #311: a verifier records its verdict in a throwaway clone, then deletes the
// clone. The verdict must still reach the merge gate of the real checkout of
// the same remote: every verdict is mirrored per remote in the user's state
// dir, and the gates import the branch's rows from there.
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendObserved,
  checkVerdicts,
  readLedger,
  recordVerdict,
  verdictMirrorPath,
  type LedgerResult,
} from "@/packages/workit-core/src/ledger";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

const value = <T>(result: LedgerResult<T>): T => {
  if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
  return result.value;
};

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const configure = (root: string) => {
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Workit Test");
  git(root, "config", "commit.gpgsign", "false");
};

/** The real checkout: main plus feature/x, origin at a (never contacted) forge URL. */
const realCheckout = (remote: string): string => {
  const root = tempDir("wk-mirror-real-");
  git(root, "init", "-q", "-b", "main");
  configure(root);
  writeFileSync(path.join(root, "README.md"), "# app\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  git(root, "checkout", "-qb", "feature/x");
  writeFileSync(path.join(root, "app.ts"), "export const x = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feature");
  git(root, "remote", "add", "origin", remote);
  return root;
};

/** A throwaway clone of `source`, on feature/x, with origin set to `origin` (or left at `source`). */
const throwawayClone = (source: string, origin?: string): string => {
  const clone = path.join(tempDir("wk-mirror-tmp-"), "clone");
  git(path.dirname(clone), "clone", "-q", "--branch", "feature/x", source, clone);
  configure(clone);
  if (origin) git(clone, "remote", "set-url", "origin", origin);
  return clone;
};

const verify = (cwd: string) =>
  value(
    recordVerdict(
      { cwd, actor: { host: "cli", session: "verifier-7", agentId: null } },
      { result: "verified", how: "exercised it in a temp clone", kind: "unit" },
    ),
  );

const gate = (root: string) =>
  checkVerdicts(root, "feature/x", value(readLedger(root, { integrity: true })).rows);

test("Given a verdict recorded in a temp clone of the same remote, When the clone is deleted and the gate runs in the real checkout, Then it finds and accepts the verdict", () => {
  const remote = "git@github.com:acme/mirror-one.git";
  const real = realCheckout(remote);
  const clone = throwawayClone(real, "https://github.com/Acme/mirror-one");
  const recorded = verify(clone);
  rmSync(path.dirname(clone), { recursive: true, force: true });
  expect(existsSync(clone)).toBe(false);

  const result = gate(real);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.accepted.verdict).toMatchObject({
    id: recorded.id,
    head: recorded.head,
    integrity: "verified",
  });
  // Imported once, into the real ledger's own chain.
  const rows = value(readLedger(real, { integrity: true }));
  expect(rows.rows.filter((row) => row.id === recorded.id)).toHaveLength(1);
  expect(rows.integrity?.unverified).toEqual([]);
  expect(gate(real).accepted.accepted).toBe(true);
  expect(value(readLedger(real)).rows.filter((row) => row.id === recorded.id)).toHaveLength(1);
});

test("Given a clone of the local checkout (origin is its path), When it records a verdict, Then the checkout's gate finds it", () => {
  const real = realCheckout("git@github.com:acme/mirror-two.git");
  const clone = throwawayClone(real);
  expect(verdictMirrorPath(clone)).toBe(verdictMirrorPath(real));
  const recorded = verify(clone);
  rmSync(path.dirname(clone), { recursive: true, force: true });
  expect(gate(real).accepted.verdict?.id).toBe(recorded.id);
});

test("Given a verdict recorded in a clone of a different remote, When the gate runs, Then it is not imported", () => {
  const real = realCheckout("git@github.com:acme/mirror-three.git");
  const other = throwawayClone(real, "git@github.com:acme/someone-else.git");
  verify(other);
  expect(verdictMirrorPath(other)).not.toBe(verdictMirrorPath(real));
  expect(gate(real).accepted).toMatchObject({ accepted: false, reasons: ["no_verdict"] });
});

test("Given a mirror row edited by hand, When the gate runs, Then it is never imported", () => {
  const real = realCheckout("git@github.com:acme/mirror-four.git");
  const clone = throwawayClone(real);
  verify(clone);
  const mirror = verdictMirrorPath(real) as string;
  const text = readFileSync(mirror, "utf8");
  writeFileSync(mirror, text.replace("exercised it", "forged it"));
  expect(gate(real).accepted).toMatchObject({ accepted: false, reasons: ["no_verdict"] });
});

const judge = (cwd: string, session: string, result: "verified" | "failed", at: string) =>
  value(
    recordVerdict(
      { cwd, actor: { host: "cli", session, agentId: null }, now: new Date(at) },
      { result, how: `${result} it`, kind: "unit" },
    ),
  );

test("Given an older pass recorded in a clone and a newer local failure on the same head, When the gate imports the pass, Then the newer failure still wins", () => {
  const real = realCheckout("git@github.com:acme/mirror-order.git");
  const clone = throwawayClone(real);
  judge(clone, "rev-A", "verified", "2026-01-01T00:00:00Z");
  rmSync(path.dirname(clone), { recursive: true, force: true });
  const failure = judge(real, "rev-B", "failed", "2026-01-02T00:00:00Z");
  const result = gate(real);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  expect(result.accepted.verdict?.id).toBe(failure.id);
  expect(result.current.verdict?.id).toBe(failure.id);
});

test("Given a local failure and a newer pass recorded in a clone by another session, When the gate imports it, Then the newer pass wins", () => {
  const real = realCheckout("git@github.com:acme/mirror-order-2.git");
  judge(real, "rev-B", "failed", "2026-01-01T00:00:00Z");
  const clone = throwawayClone(real);
  const pass = judge(clone, "rev-A", "verified", "2026-01-02T00:00:00Z");
  rmSync(path.dirname(clone), { recursive: true, force: true });
  const result = gate(real);
  expect(result.accepted).toMatchObject({ accepted: true, reasons: [] });
  expect(result.accepted.verdict?.id).toBe(pass.id);
});

test("Given a local failure and a pass recorded in a clone with the same `at`, When the gate imports the pass, Then the failure ranks newest", () => {
  const real = realCheckout("git@github.com:acme/mirror-tie.git");
  const failure = judge(real, "rev-B", "failed", "2026-01-02T00:00:00Z");
  const clone = throwawayClone(real);
  judge(clone, "rev-A", "verified", "2026-01-02T00:00:00Z");
  rmSync(path.dirname(clone), { recursive: true, force: true });
  const result = gate(real);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  expect(result.current.verdict?.id).toBe(failure.id);
});

test("Given a pass from a clone dated in the future, When a local failure is recorded after it was imported, Then the failure ranks newest", () => {
  const real = realCheckout("git@github.com:acme/mirror-future.git");
  const clone = throwawayClone(real);
  const pass = judge(clone, "rev-A", "verified", "2099-01-01T00:00:00Z");
  rmSync(path.dirname(clone), { recursive: true, force: true });
  expect(gate(real).accepted.verdict?.id).toBe(pass.id);
  const failure = judge(real, "rev-B", "failed", "2026-01-03T00:00:00Z");
  const result = gate(real);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  expect(result.current.verdict?.id).toBe(failure.id);
});

test("Given a failure from a clone, When its reviewer became an author locally only after it was recorded, Then the failure still blocks (it ranks where it was recorded, not where it was imported)", () => {
  const real = realCheckout("git@github.com:acme/mirror-authors.git");
  judge(real, "rev-V", "verified", "2026-01-01T00:00:00Z");
  const clone = throwawayClone(real);
  const failure = judge(clone, "rev-A", "failed", "2026-01-02T00:00:00Z");
  rmSync(path.dirname(clone), { recursive: true, force: true });
  value(
    appendObserved(
      real,
      {
        type: "commit.recorded",
        actor: { host: "cli", session: "rev-A", agentId: null },
        session: "rev-A",
        branch: "feature/x",
        head: git(real, "rev-parse", "HEAD"),
      },
      { now: new Date("2026-01-03T00:00:00Z") },
    ),
  );
  const result = gate(real);
  expect(result.accepted).toMatchObject({ accepted: false, reasons: ["failing_verdict"] });
  expect(result.current.verdict?.id).toBe(failure.id);
});

test("Given a checkout with no remote origin, Then there is no mirror", () => {
  const root = tempDir("wk-mirror-none-");
  git(root, "init", "-q", "-b", "main");
  expect(verdictMirrorPath(root)).toBeNull();
});
