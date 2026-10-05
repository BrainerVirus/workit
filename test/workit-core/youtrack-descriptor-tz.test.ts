import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// `workit youtrack time|note --date` resolves the work-item date through
// youTrackWorkDateMs. An explicit date must resolve to the same epoch in every
// process timezone; "auto" follows the process timezone when youtrack.json sets
// none. Each phase runs in its own process because runtimes cache Intl's zone.
const YOUTRACK = path.resolve(import.meta.dir, "../../packages/workit-core/src/core/youtrack.ts");

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "wf-yt-tz-"));
  writeFileSync(
    path.join(root, "youtrack.json"),
    JSON.stringify({ baseUrl: "https://yt.example.test" }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dateIn = (tz: string, raw: string): any => {
  const script = `const { youTrackWorkDateMs } = await import(${JSON.stringify(YOUTRACK)});
console.log(JSON.stringify(youTrackWorkDateMs(${JSON.stringify(raw)})));`;
  const out = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, TZ: tz, WORKFLOW_YOUTRACK_CONFIG: path.join(root, "youtrack.json") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return JSON.parse(out.stdout.toString().trim().split("\n").at(-1) ?? "null");
};

test("Given an explicit work date, When it resolves under different process timezones, Then the epoch is identical", () => {
  const values = ["America/Santiago", "Asia/Tokyo", "UTC"].map((tz) => dateIn(tz, "2026-10-03"));
  for (const value of values) expect(value.data.dateMs).toBe(Date.UTC(2026, 9, 3));
  const epoch = String(Date.UTC(2026, 9, 3));
  expect(dateIn("Asia/Tokyo", epoch).data).toMatchObject({
    dateMs: Date.UTC(2026, 9, 3),
    localDate: "2026-10-03",
  });
});

test("Given no youtrack.json timezone, When the date is auto, Then the process timezone is reported", () => {
  expect(dateIn("America/Santiago", "auto").data).toMatchObject({
    timezone: "America/Santiago",
    timezoneSource: "process",
  });
  expect(dateIn("UTC", "auto").data.timezone).toBe("UTC");
});
