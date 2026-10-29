import { expect, test } from "bun:test";
import { backfillReleaseNotes, isHeaderOnly, type Exec } from "@/scripts/backfill-release-notes";
import { REPO_ROOT } from "@/test/shared/helpers/packages";

// Injected git/gh: v1.0.1 has header-only notes (refactor-only release),
// v1.0.2 has a tag but no GitHub release (publish failed first), v1.1.0 is
// complete, v1.0.0 sits outside the range.
const HEADER = "## [1.0.1](https://github.com/o/r/compare/v1.0.0...v1.0.1) (2026-01-02)\n";
const COMMITS: Record<string, string[]> = {
  "v1.0.0..v1.0.1": ["refactor(core): split the loader (#10)", "chore(release): sync manifests"],
  "v1.0.1..v1.0.2": ["fix(cli): keep the exit code (#11)"],
  "v1.0.2..v1.1.0": ["feat: add a verb (#12)"],
};

function fake() {
  const writes: Array<{ args: string[]; input?: string }> = [];
  const exec: Exec = (cmd, args, input) => {
    const line = `${cmd} ${args.join(" ")}`;
    if (line === "git tag --list v* --sort=v:refname") return "v1.0.0\nv1.0.1\nv1.0.2\nv1.1.0\n";
    if (line === "git remote get-url origin") return "git@github.com:o/r.git\n";
    if (args[0] === "log" && args[1] === "-1") return "2026-01-0" + args[3].at(-1) + "\n";
    if (args[0] === "log")
      return (COMMITS[args[2]] ?? [])
        .map((m, i) => `${String(i).repeat(40)}\x1f${m}\n\x1e`)
        .join("");
    if (line.startsWith("gh release view v1.0.1")) return HEADER;
    if (line.startsWith("gh release view v1.0.2")) throw new Error("release not found");
    if (line.startsWith("gh release view v1.1.0")) return "## [1.1.0]\n\n### Features\n\n* a\n";
    if (line.startsWith("gh release ")) {
      writes.push({ args, input });
      return "";
    }
    throw new Error(`unexpected command: ${line}`);
  };
  return { exec, writes };
}

test("header-only means nothing below the headings", () => {
  expect(isHeaderOnly(HEADER)).toBe(true);
  expect(isHeaderOnly(`${HEADER}\n### Bug Fixes\n\n* a\n`)).toBe(false);
});

test("dry run (the default) plans the header-only edit and the missing release, writes nothing", async () => {
  const { exec, writes } = fake();
  const lines: string[] = [];
  const changes = await backfillReleaseNotes({
    root: REPO_ROOT,
    range: "v1.0.1..v1.1.0",
    exec,
    log: (l) => lines.push(l),
  });
  expect(writes).toEqual([]);
  expect(changes.map((c) => `${c.action} ${c.tag}`)).toEqual(["edit v1.0.1", "create v1.0.2"]);
  const [edit, create] = changes;
  expect(edit.notes).toContain("### Code Refactoring");
  expect(edit.notes).toContain("split the loader");
  expect(edit.notes).not.toContain("sync manifests");
  // Dated by the tag, not the day the backfill runs.
  expect(edit.notes.split("\n")[0]).toEndWith("(2026-01-01)");
  expect(create.notes).toContain("### Bug Fixes");
  expect(lines).toContain("would edit the GitHub release v1.0.1 (header-only notes):");
  expect(lines).toContain("would create the GitHub release v1.0.2 (missing):");
  expect(lines.at(-1)).toContain("--apply");
});

test("--apply edits the header-only release and creates the missing one, never as latest", async () => {
  const { exec, writes } = fake();
  const changes = await backfillReleaseNotes({
    root: REPO_ROOT,
    range: "v1.0.1..v1.1.0",
    apply: true,
    exec,
    log: () => {},
  });
  expect(writes.map((w) => w.args.join(" "))).toEqual([
    "release edit v1.0.1 --notes-file -",
    "release create v1.0.2 --verify-tag --title v1.0.2 --latest=false --notes-file -",
  ]);
  expect(writes.map((w) => w.input)).toEqual(changes.map((c) => c.notes));
});

test("an unknown range fails before any gh call", async () => {
  const { exec, writes } = fake();
  await expect(
    backfillReleaseNotes({ root: REPO_ROOT, range: "v9.0.0..v9.1.0", exec, log: () => {} }),
  ).rejects.toThrow("no tag range");
  expect(writes).toEqual([]);
});
