#!/usr/bin/env bun
// CI: a PR that grows the committed context budget needs the
// `context-increase` label. Compares docs/qualification/context-budget.json
// at <base> with the working tree. No dependencies: runs before install.
// Usage: bun scripts/check-budget-growth.ts <base-ref>   (LABELS: comma-separated)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE = "docs/qualification/context-budget.json";
const base = process.argv[2];
if (!base) throw new Error("usage: check-budget-growth.ts <base-ref>");

const shown = spawnSync("git", ["show", `${base}:${FILE}`], { encoding: "utf8" });
// The base predates the budget: nothing to compare.
const before: Record<string, number> = shown.status === 0 ? JSON.parse(shown.stdout) : {};
const after: Record<string, number> = JSON.parse(readFileSync(FILE, "utf8"));
const grown = Object.entries(after)
  .filter(([key, size]) => key in before && size > before[key])
  .map(([key, size]) => `${key}: ${before[key]} -> ${size} (+${size - before[key]})`);
const added = Object.keys(after).filter((key) => shown.status === 0 && !(key in before));

const changes = [...grown, ...added.map((key) => `${key}: new`)].join("\n");
const labels = (process.env.LABELS ?? "").split(",").map((label) => label.trim());
if (!changes) {
  console.log("context budget: no growth");
} else if (labels.includes("context-increase")) {
  console.log(`context budget grew (allowed by the context-increase label):\n${changes}`);
} else {
  console.error(
    `context budget grew; add the context-increase label if it is worth it, or cut elsewhere:\n${changes}`,
  );
  process.exit(1);
}
