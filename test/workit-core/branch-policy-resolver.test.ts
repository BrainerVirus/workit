import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const CORE = path.join(import.meta.dir, "../../packages/workit-core/src/core");
const ADAPTERS = [
  path.join(import.meta.dir, "../../packages/workit-opencode/src"),
  path.join(import.meta.dir, "../../packages/workit-cursor"),
  path.join(import.meta.dir, "../../packages/workit-cli/src"),
];

const tsFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.includes("node_modules")) walk(p);
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
    }
  };
  walk(dir);
  return out;
};

test("CA-09: consumers never resolve branch policy on their own", () => {
  const offenders: string[] = [];
  // Definition files are exempt by exact core path, not filename substring:
  // "vcs-config.ts" ends with "config.ts" and would otherwise dodge the gate.
  const exempt = ["config.ts", "branch.ts", "workspaces.ts"].map((f) =>
    path.join("src", "core", f),
  );
  for (const dir of [CORE, ...ADAPTERS]) {
    for (const f of tsFiles(dir)) {
      if (f.includes("branch-policy-detect") || f.includes("branch-policy-resolver")) continue;
      const src = readFileSync(f, "utf8");
      if (/\bresolveBranchPolicy\(readConfig\(\)\)/.test(src)) offenders.push(f);
      if (exempt.some((suffix) => f.endsWith(suffix))) continue;
      // Per-call-site gate: any direct resolveBranchPolicy( call not routed
      // through the resolveBranchPolicyFor wrapper flags the file — including
      // the line-break and pre-bound-variable dodges the first regex allows.
      if (/\bresolveBranchPolicy\((?!For)/.test(src)) offenders.push(f);
    }
  }
  expect(offenders).toEqual([]);
});
