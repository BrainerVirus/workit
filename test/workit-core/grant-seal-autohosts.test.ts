// youtrack.autoHosts is sealed authority next to youtrack.writes: a writer
// outside the user's terminal may only narrow it, and a seal taken before the
// key existed stays valid. A temp account home, never the real one.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  lowersOnly,
  sealAfterWrite,
  sealBefore,
  youTrackWritesPolicy,
} from "@/packages/workit-core/src/autonomy";
import { checkSeal, SEAL_FILE } from "@/packages/workit-core/src/core/grant-seal";
import { sealConfig, useConfigHome, type ConfigHome } from "../shared/grant-home";

let configHome: ConfigHome;
let root = "";
const savedName = process.env.WORKIT_WORKSPACE_NAME;
beforeAll(() => {
  delete process.env.WORKIT_WORKSPACE_NAME;
  configHome = useConfigHome("wk-seal-autohosts-", { seal: "manual" });
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "wk-seal-autohosts-"))).replaceAll(
    "\\",
    "/",
  );
});
afterAll(() => {
  if (savedName !== undefined) process.env.WORKIT_WORKSPACE_NAME = savedName;
  configHome.restore();
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  for (const name of ["workspaces.json", SEAL_FILE])
    rmSync(path.join(configHome.configDir, name), { force: true });
});

const A = "a.youtrack.cloud";
const B = "b.youtrack.cloud";
const entry = (youtrack: Record<string, unknown>) => ({
  name: "personal",
  glob: `${root}/**`,
  youtrack,
});
const write = (entries: unknown[]) =>
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({ workspaces: entries }),
  );

test("G sealed autoHosts, W the list changes, T only a subset (or writes ask) is a lowering", () => {
  const was = [entry({ writes: "auto", autoHosts: [A] })];
  expect(lowersOnly(was, [entry({ writes: "auto", autoHosts: [A, B] })])).toBe(false);
  expect(lowersOnly(was, [entry({ writes: "auto", autoHosts: [B] })])).toBe(false);
  expect(lowersOnly(was, [entry({ writes: "auto", autoHosts: [] })])).toBe(true);
  expect(
    lowersOnly(was, [entry({ writes: "auto", autoHosts: [`https://${A.toUpperCase()}/`] })]),
  ).toBe(true);
  expect(lowersOnly(was, [entry({ writes: "ask" })])).toBe(true);
  expect(lowersOnly(was, [entry({ writes: "ask", autoHosts: [A, B] })])).toBe(true);
  // Under auto, no autoHosts means any host again: a raise.
  expect(lowersOnly(was, [entry({ writes: "auto" })])).toBe(false);
  // From an unscoped auto, any list narrows it.
  expect(lowersOnly([entry({ writes: "auto" })], [entry({ writes: "auto", autoHosts: [B] })])).toBe(
    true,
  );
  expect(lowersOnly([entry({ writes: "ask" })], [entry({ writes: "auto", autoHosts: [A] })])).toBe(
    false,
  );
});

test("G a sealed autoHosts [a], W a non-terminal writer makes it [a, b], T it is not resealed and no write is auto", () => {
  const sealed = [entry({ writes: "auto", autoHosts: [A] })];
  write(sealed);
  sealConfig(configHome.configDir);
  expect(youTrackWritesPolicy(`${root}/repo`)).toEqual({
    mode: "auto",
    hosts: [A],
    baseUrl: null,
  });
  const before = sealBefore(configHome.configDir);
  const widened = [entry({ writes: "auto", autoHosts: [A, B] })];
  write(widened);
  expect(sealAfterWrite(before, false, widened)).toBe("mismatch");
  expect(checkSeal(configHome.configDir).state).toBe("broken");
  expect(youTrackWritesPolicy(`${root}/repo`)).toEqual({ mode: "ask" });
});

test("G a sealed autoHosts [a], W a non-terminal writer empties it, T it is resealed as [] (a lowering)", () => {
  write([entry({ writes: "auto", autoHosts: [A] })]);
  sealConfig(configHome.configDir);
  const before = sealBefore(configHome.configDir);
  const emptied = [entry({ writes: "auto", autoHosts: [] })];
  write(emptied);
  expect(sealAfterWrite(before, false, emptied)).toBe("resealed");
  expect(youTrackWritesPolicy(`${root}/repo`)).toEqual({ mode: "auto", hosts: [], baseUrl: null });
});

/** JSON with sorted keys, as the seal hashes it (written out here, not imported). */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : item,
  );

test("G a seal written before autoHosts existed (its projection holds only youtrack.writes), W the upgraded code reads it, T it is still valid", () => {
  write([
    {
      ...entry({ writes: "auto", baseUrl: `https://${A}` }),
      checks: { test: "bun test" },
    },
  ]);
  // The version-1 seal the earlier code wrote: youtrack projected to `writes` alone.
  const projection = [{ name: "personal", glob: `${root}/**`, youtrack: { writes: "auto" } }];
  const seal = {
    version: 1,
    sha256: createHash("sha256").update(canonical(projection)).digest("hex"),
    projection,
    sealedAt: "2026-11-01T00:00:00.000Z",
  };
  writeFileSync(path.join(configHome.configDir, SEAL_FILE), JSON.stringify(seal));
  expect(checkSeal(configHome.configDir)).toEqual({ state: "valid" });
  expect(youTrackWritesPolicy(`${root}/repo`)).toEqual({
    mode: "auto",
    hosts: null,
    baseUrl: `https://${A}`,
  });
});
