// A closed threads store lets go of threads.db and its -wal and -shm files:
// bun:sqlite kept them open while a prepared statement was not finalized, so
// Windows refused to remove a state dir the registry had used (EBUSY).
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveProcs, openProcs } from "@/packages/workit-core/src/core/procs";
import { upsertProc } from "@/packages/workit-core/src/store/threads/procs";

/** Open descriptors of this process under `dir` (Linux: /proc/self/fd), or null elsewhere. */
const openUnder = (dir: string): number | null => {
  if (!existsSync("/proc/self/fd")) return null;
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`).startsWith(dir);
    } catch {
      return false;
    }
  }).length;
};

test("Given a store that ran reads and writes, When it closes, Then no handle under the state dir stays open and the dir can be removed", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-procs-handles-"));
  const env: NodeJS.ProcessEnv = { ...process.env, WORKIT_STATE_DIR: dir };
  const store = openProcs(env);
  upsertProc(store, "phandle01", () => ({
    session: "s-owner",
    lead: "s-owner",
    host: null,
    hostPid: null,
    cmd: "fake server",
    kind: "server",
    startedAt: new Date().toISOString(),
    pid: null,
    pgid: null,
    pidStart: null,
    cwd: dir,
  }));
  expect(liveProcs(store).map((row) => row.id)).toEqual(["phandle01"]);
  store.close();
  const open = openUnder(dir);
  if (open !== null) expect(open).toBe(0);
  // No retries: on Windows this throws EBUSY while any handle is still open.
  rmSync(dir, { recursive: true });
  expect(existsSync(dir)).toBe(false);
});
