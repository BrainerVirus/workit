// Workit never reads, writes or sends a YouTrack token (ytrack keeps it in the
// OS keyring). A source scan keeps the token-file client from coming back.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(import.meta.dir, "../../packages");

const sources = (): { rel: string; text: string }[] => {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "build"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|mjs)$/.test(entry.name) && full.includes(`${path.sep}src${path.sep}`))
        out.push({
          rel: path.relative(PACKAGES, full).split(path.sep).join("/"),
          text: readFileSync(full, "utf8"),
        });
    }
  };
  walk(PACKAGES);
  return out;
};

// Files that may name a legacy youtrack.token, each only to check it exists:
// doctor warns it can be deleted, setup and the scaffold report it left untouched.
// forge/resolve.ts names it in a comment about the VCS token file.
const LEGACY_NAMERS = new Set([
  "workit-cli/src/admin/doctor.ts",
  "workit-cli/src/admin/setup.ts",
  "workit-cli/src/logic.ts",
  "workit-core/src/forge/resolve.ts",
]);

const READ_CALL = /\b(?:readFileSync|readFile|openSync|createReadStream)\(([^)]*)\)/g;

test("Given the shipped sources, Then nothing names YOUTRACK_TOKEN, a YouTrack token env or the token placeholder", () => {
  // The placeholder was only ever compared against a token file's contents.
  const hits = sources().filter(({ text }) =>
    /YOUTRACK_TOKEN|WORKIT_YT_TOKEN|YOUR_TOKEN_HERE/.test(text),
  );
  expect(hits.map((hit) => hit.rel)).toEqual([]);
});

test("Given the shipped sources, Then only the allowlisted files name youtrack.token", () => {
  const namers = sources()
    .filter(({ text }) => text.includes("youtrack.token"))
    .map((file) => file.rel);
  expect(namers.filter((rel) => !LEGACY_NAMERS.has(rel))).toEqual([]);
});

test("Given a file that names the legacy token, Then no read call in it touches a token path", () => {
  const offenders = sources()
    .filter(({ rel }) => LEGACY_NAMERS.has(rel) && !rel.endsWith("forge/resolve.ts"))
    .flatMap(({ rel, text }) =>
      [...text.matchAll(READ_CALL)]
        .filter((match) => /token|legacy/i.test(match[1]))
        .map((match) => `${rel}: ${match[0]}`),
    );
  expect(offenders).toEqual([]);
});

test("Given the YouTrack modules, Then none holds a token, an Authorization header or a REST call", () => {
  const youtrack = sources().filter(({ rel }) =>
    /^workit-core\/src\/core\/youtrack[^/]*\.ts$/.test(rel),
  );
  expect(youtrack.length).toBeGreaterThan(3);
  for (const { rel, text } of youtrack) {
    expect(text, rel).not.toMatch(/\btokenFile\b/);
    expect(text, rel).not.toMatch(/Authorization|Bearer /);
    expect(text, rel).not.toMatch(/\bfetch\(/);
  }
});
