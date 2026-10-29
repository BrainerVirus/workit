import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

setDefaultTimeout(60_000);

// `bun run doctor` wraps react-doctor so a clean scan ends in one result line,
// not the CLI's "React Doctor is not installed" install prompt (#569).

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scan(source: string) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "workit-react-doctor-"));
  dirs.push(dir);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fx", dependencies: { react: "19.0.0" } }),
  );
  writeFileSync(path.join(dir, "App.tsx"), source);
  const run = spawnSync("bun", [path.join(REPO_ROOT, "scripts/react-doctor.ts"), dir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("a clean scan prints the result line, no install prompt, and exits 0", () => {
  const { status, out } = scan("export function App() {\n  return <div>hi</div>;\n}\n");
  expect(out).toContain("react-doctor: scanned 1 files, 0 issues");
  expect(out).not.toContain("not installed");
  expect(out).not.toContain("npx react-doctor");
  expect(status).toBe(0);
});

test("a warning exits non-zero, is listed and counted in the result line", () => {
  const { status, out } = scan(
    `import { useState } from "react";
export function App({ items }: { items: string[] }) {
  const [n, setN] = useState(0);
  return <div>{items.map((i, idx) => <span key={idx} onClick={() => setN(n + 1)}>{i}</span>)}</div>;
}
`,
  );
  expect(out).toMatch(/warning App\.tsx:\d+ /);
  expect(out).toMatch(/react-doctor: scanned 1 files, [1-9]\d* issues/);
  expect(out).not.toContain("not installed");
  expect(status).toBe(1);
});
