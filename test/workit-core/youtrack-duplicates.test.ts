// #780 review: the duplicate check compares a work item's day whatever form
// the read gives it. ytrack documents `date` as YYYY-MM-DD; an epoch (YouTrack's
// own UTC-midnight work date) or an ISO timestamp must land on the same day.
import { expect, test } from "bun:test";
import type { OwnEntry, YouTrackBackend } from "@/packages/workit-core/src/core/youtrack-backend";
import { findDuplicate, workItemDay } from "@/packages/workit-core/src/core/youtrack-writes";

const backendWith = (entries: OwnEntry[] | null): YouTrackBackend =>
  ({ ownEntries: async () => entries }) as unknown as YouTrackBackend;

const WANTED = {
  where: "workItems" as const,
  text: "review",
  minutes: 30,
  date: "2026-10-03",
};

test.each([
  ["YYYY-MM-DD", "2026-10-03"],
  ["epoch ms (UTC midnight)", Date.UTC(2026, 9, 3)],
  ["epoch ms as a string", String(Date.UTC(2026, 9, 3))],
  ["ISO at UTC midnight", "2026-10-03T00:00:00.000Z"],
  ["ISO with a time, read in the work timezone", "2026-10-04T01:30:00Z"],
])("Given a work item dated as %s, Then it is the same day as the write", async (_label, date) => {
  const found = await findDuplicate(
    "ABC-1",
    WANTED,
    backendWith([{ id: "115-3", text: "review", minutes: 30, date }]),
    "America/Santiago",
  );
  expect(found?.id).toBe("115-3");
});

test("Given a work item on another day, in any form, Then it is not a duplicate", async () => {
  for (const date of ["2026-10-04", Date.UTC(2026, 9, 4), "2026-10-04T12:00:00Z"])
    expect(
      await findDuplicate(
        "ABC-1",
        WANTED,
        backendWith([{ id: "1", text: "review", minutes: 30, date }]),
        "America/Santiago",
      ),
    ).toBeNull();
});

test("workItemDay reads nothing it cannot parse as a day", () => {
  expect(workItemDay("yesterday", "UTC")).toBeNull();
  expect(workItemDay(undefined, "UTC")).toBeNull();
  expect(workItemDay(Number.NaN, "UTC")).toBeNull();
});

test("Given unreadable entries, Then the check says so (undefined), never 'no duplicate' (null)", async () => {
  expect(await findDuplicate("ABC-1", WANTED, backendWith(null), "UTC")).toBeUndefined();
});
