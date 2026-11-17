// #857 verifier follow-up: no module-level budget bridge. Two checkouts resolved
// in one process each acquire a lease, and admit a server, with their own
// budget and weights; a call without a budget uses `slots` alone, never the
// budget some earlier resolution produced.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLease,
  admit,
  resolveResourceSettings,
  type AcquireOptions,
  type ResourceSource,
} from "@/packages/workit-core/src/core/resources";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const leases = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-checkouts-"));
  dirs.push(dir);
  return path.join(dir, "leases");
};

const GIB = 1024 ** 3;
const machine = (value: Record<string, unknown>): ResourceSource[] => [
  { label: "workspaces.json", trust: "machine", value },
];
// Checkout A weighs `suite` 3 units of 4; checkout B leaves it at 1 unit of 4.
const resolveA = () => resolveResourceSettings(machine({ budget: 4, weights: { suite: 3 } }));
const resolveB = () => resolveResourceSettings(machine({ budget: 4 }));

const options = (dir: string, extra: Partial<AcquireOptions>): AcquireOptions => ({
  dir,
  slots: 4,
  check: "suite",
  cwd: "/repo",
  session: "s-checkouts",
  waitMs: 0,
  pollMs: 5,
  watch: false,
  probe: { alive: () => true, boot: null },
  ...extra,
});

test("Given checkouts A then B resolved in one process, When each acquires a lease with its budget, Then each lease carries its own weight", async () => {
  const a = resolveA();
  const b = resolveB();
  const leaseA = await acquireLease(options(leases(), { budget: a.budget }));
  const leaseB = await acquireLease(options(leases(), { budget: b.budget }));
  if (!leaseA.ok || !leaseB.ok) throw new Error("expected both leases");
  expect(leaseA.lease.record.units).toBe(3);
  expect(leaseB.lease.record.units).toBe(1);
  leaseA.lease.release();
  leaseB.lease.release();
});

test("Given B resolved last, When A's budget holds 3 of 4 units, Then a second suite under A waits while one under B's budget would fit", async () => {
  const a = resolveA();
  const dir = leases();
  const first = await acquireLease(options(dir, { budget: a.budget }));
  if (!first.ok) throw new Error("first lease");
  resolveB();
  const second = await acquireLease(options(dir, { budget: a.budget }));
  expect(second.ok).toBe(false);
  first.lease.release();
});

test("Given a resolution with weights, When a lease or admission passes no budget, Then it uses slots alone and the machine defaults, not the earlier resolution", async () => {
  resolveA();
  const plain = await acquireLease(options(leases(), {}));
  if (!plain.ok) throw new Error("plain lease");
  // A counted (slots-only) lease records no weight at all.
  expect(plain.lease.record.units).toBeUndefined();
  plain.lease.release();
  const small = resolveResourceSettings(machine({ budget: "1G" }));
  const dir = leases();
  const ask = (budget?: typeof small.budget) =>
    admit({
      dir,
      kind: "server",
      label: "probe",
      rssBytes: 2 * GIB,
      cwd: "/a",
      session: null,
      budget,
    });
  expect(ask(small.budget).ok).toBe(false);
  // With no budget: the machine default (RAM less the reserve), not the 1 GiB resolved just before.
  const defaults = ask();
  expect(defaults.ok).toBe(true);
  if (defaults.ok) defaults.admission.release();
});
