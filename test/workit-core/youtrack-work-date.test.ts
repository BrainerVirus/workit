import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { youTrackWorkDateMs } from "@/packages/workit-core/src/core/youtrack";

// The work-item date must be the same UTC-midnight epoch for a given calendar
// day no matter which timezone the process runs in. Each case runs in a fresh
// process with TZ set, because runtimes cache the default Intl timezone.
const ZONES = ["Asia/Tokyo", "America/Santiago", "UTC", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
const MODULE = path.resolve(import.meta.dir, "../../packages/workit-core/src/core/youtrack.ts");

let dir: string;
let savedConfig: string | undefined;

type WorkDate = ReturnType<typeof youTrackWorkDateMs>;

const workDateInTz = (tz: string, raw: string): WorkDate => {
  const script = `const { youTrackWorkDateMs } = await import(${JSON.stringify(MODULE)});
console.log(JSON.stringify(youTrackWorkDateMs(${JSON.stringify(raw)})));`;
  const out = Bun.spawnSync([process.execPath, "-e", script], {
    env: { ...process.env, TZ: tz },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (out.exitCode !== 0) throw new Error(out.stderr.toString());
  return JSON.parse(out.stdout.toString().trim().split("\n").at(-1) ?? "null") as WorkDate;
};

const writeYouTrackJson = (value: Record<string, unknown>): void => {
  const file = path.join(dir, "youtrack.json");
  writeFileSync(file, JSON.stringify(value), "utf8");
  process.env.WORKFLOW_YOUTRACK_CONFIG = file;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "wf-yt-date-"));
  savedConfig = process.env.WORKFLOW_YOUTRACK_CONFIG;
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.WORKFLOW_YOUTRACK_CONFIG;
  else process.env.WORKFLOW_YOUTRACK_CONFIG = savedConfig;
  rmSync(dir, { recursive: true, force: true });
});

test("Given an explicit YYYY-MM-DD date, When the process runs in any timezone, Then dateMs is that day's UTC midnight", () => {
  writeYouTrackJson({ baseUrl: "https://yt.example.test" });
  for (const tz of ZONES) {
    const out = workDateInTz(tz, "2026-10-03");
    expect("data" in out, tz).toBe(true);
    if (!("data" in out)) continue;
    expect(out.data.dateMs, tz).toBe(Date.UTC(2026, 9, 3));
    expect(out.data.localDate, tz).toBe("2026-10-03");
  }
});

test("Given an old youtrack.json with a timezone, When the process runs east of UTC, Then the explicit date is not shifted a day back", () => {
  writeYouTrackJson({ baseUrl: "https://yt.example.test", timezone: "America/Santiago" });
  for (const tz of ZONES) {
    const out = workDateInTz(tz, "2026-10-03");
    expect("data" in out && out.data.dateMs, tz).toBe(Date.UTC(2026, 9, 3));
  }
});

test("Given no configured timezone, When the date is auto, Then it is today's calendar day in the process timezone at UTC midnight", () => {
  writeYouTrackJson({ baseUrl: "https://yt.example.test" });
  for (const tz of ZONES) {
    const today = () =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    const before = today();
    const out = { result: workDateInTz(tz, "auto"), today: today() };
    if (before !== out.today) continue; // crossed midnight in that zone mid-test
    expect("data" in out.result, tz).toBe(true);
    if (!("data" in out.result)) continue;
    const [y, m, d] = out.today.split("-").map(Number);
    expect(out.result.data.localDate, tz).toBe(out.today);
    expect(out.result.data.dateMs, tz).toBe(Date.UTC(y, m - 1, d));
    expect(out.result.data.timezone, tz).toBe(tz);
  }
});

test("Given a youtrack.json timezone override, When the date is auto, Then today's day is taken in that zone and stored at UTC midnight", () => {
  writeYouTrackJson({ baseUrl: "https://yt.example.test", timezone: "Asia/Tokyo" });
  const out = workDateInTz("America/Santiago", "auto");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  expect("data" in out && out.data).toEqual({
    dateMs: Date.UTC(y, m - 1, d),
    timezone: "Asia/Tokyo",
    localDate: today,
  });
});

test("Given no youtrack.json, When the date is auto, Then the process timezone is used instead of a hard-coded zone", () => {
  process.env.WORKFLOW_YOUTRACK_CONFIG = path.join(dir, "missing.json");
  const out = workDateInTz("Asia/Tokyo", "auto");
  expect("data" in out && out.data.timezone).toBe("Asia/Tokyo");
});

test("Given an invalid YYYY-MM-DD date, When it is resolved, Then an error is returned instead of NaN", () => {
  writeYouTrackJson({ baseUrl: "https://yt.example.test" });
  for (const raw of ["2026-13-01", "2026-02-30", "not-a-date"]) {
    const out = youTrackWorkDateMs(raw);
    expect("error" in out, raw).toBe(true);
  }
});
