// `claude plugin eval` only runs a scaffold_script inside the case directory,
// so each case carries a copy of a shared script from evals/scaffold/. The
// copies must stay byte-identical to a shared source.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const EVALS = path.resolve(import.meta.dir, "../../packages/workit-claude-code/evals");

test("every eval case runs its own scaffold.sh, identical to a shared evals/scaffold script", () => {
  const shared = new Set(
    readdirSync(path.join(EVALS, "scaffold")).map((name) =>
      readFileSync(path.join(EVALS, "scaffold", name), "utf8"),
    ),
  );
  const cases = readdirSync(EVALS, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && entry.name !== "scaffold",
  );
  expect(cases.length).toBeGreaterThan(0);
  for (const { name } of cases) {
    const yaml = readFileSync(path.join(EVALS, name, "case.yaml"), "utf8");
    const script = /scaffold_script:\s*(\S+)/u.exec(yaml)?.[1];
    if (!script) continue;
    expect(script, name).toBe("scaffold.sh");
    expect(shared.has(readFileSync(path.join(EVALS, name, script), "utf8")), name).toBe(true);
  }
});
