// The session marker's stops and judges lists are read-modify-written by
// concurrent hook processes: an update must not lose another's entry, and a
// write must never leave a half-written file.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import {
  readSessionMarker,
  updateSessionMarker,
  writeSessionMarker,
} from "@/packages/workit-core/src/hooks/session-marker";
import { tempRoot } from "./hook-fixtures";

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const markerFile = () => {
  const root = tempRoot("workit-marker-");
  roots.push(root);
  mkdirSync(path.join(root, "hooks"));
  return path.join(root, "hooks", "skills-x.json");
};

test("G another hook writes the marker between this one's read and write, W both update stops, T neither entry is lost", () => {
  const file = markerFile();
  let raced = false;
  updateSessionMarker(file, (marker) => {
    if (!raced) {
      raced = true;
      // The concurrent hook lands its entry after this one read the marker.
      updateSessionMarker(file, (other) => ({ ...other, judges: [...other.judges, "v1"] }));
    }
    return { ...marker, stops: [...marker.stops, "verdict:abc"] };
  });
  const marker = readSessionMarker(file);
  expect(marker.stops).toEqual(["verdict:abc"]);
  expect(marker.judges).toEqual(["v1"]);
});

test("G a marker write, W it completes, T no temporary file is left beside the marker and the file is whole JSON", () => {
  const file = markerFile();
  writeSessionMarker(file, { ...readSessionMarker(file), stops: ["checks:1"] });
  expect(readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
  expect(JSON.parse(readFileSync(file, "utf8")).stops).toEqual(["checks:1"]);
});
