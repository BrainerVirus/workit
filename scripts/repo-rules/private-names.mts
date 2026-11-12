// The `private-names` repo rule: this repository is public, and tests and docs
// once used the maintainer's real employer, repos, usernames, SSH alias and home
// directory as sample values. oxlint only sees JS/TS, so this rule scans every
// tracked text file itself. The names are stored split into fragments so that a
// grep for them over the repo stays clean, this file included.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const RULE = "private-names";

const CITED = "chore/neutral-sample-names: tests and docs used real work names as sample values";

type Name = { fragments: readonly string[]; kind: string; neutral: string };

const NAMES: readonly Name[] = [
  { fragments: ["eng", "house"], kind: "the employer org", neutral: "acme" },
  { fragments: ["six", "bell"], kind: "the work org", neutral: "acme" },
  { fragments: ["cris", "thofer"], kind: "the maintainer's name", neutral: "alice or user" },
  { fragments: ["pin", "cetti"], kind: "the maintainer's name", neutral: "alice or user" },
  { fragments: ["github", "-work"], kind: "the work SSH alias", neutral: "work-gh" },
  { fragments: ["ui", "-kit"], kind: "a work repo name", neutral: "widgets" },
  { fragments: ["web", "-manager"], kind: "a work repo name", neutral: "portal" },
];

/** The author credit is the one place the maintainer's full name belongs. */
const AUTHOR = ["Cris", "thofer ", "Pin", "cetti"].join("");
const AUTHOR_FILES = new Set([
  "LICENSE",
  "packages/workit-core/LICENSE",
  "packages/workit-cursor/.cursor-plugin/plugin.json",
  "test/artifacts/manifests.test.ts",
]);

type NameHit = { rule: string; file: string; line: number; column: number; message: string };

const SKIP_DIRS = new Set([".git", "node_modules", ".workit-scratch"]);

function walk(root: string, dir = ""): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walk(root, rel);
    return entry.isFile() ? [rel] : [];
  });
}

/** Tracked files, or every file under `root` when it is not a git checkout. */
function files(root: string): string[] {
  const listed = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (listed.status === 0) return listed.stdout.split("\0").filter((file) => file !== "");
  return walk(root);
}

function read(root: string, file: string): string | null {
  const full = path.join(root, file);
  try {
    if (!statSync(full).isFile()) return null;
    const bytes = readFileSync(full);
    if (bytes.subarray(0, 8000).includes(0)) return null;
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

function scanText(file: string, text: string): NameHit[] {
  const needles = NAMES.map((name) => ({ ...name, needle: name.fragments.join("") }));
  const hits: NameHit[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = AUTHOR_FILES.has(file) ? raw.replaceAll(AUTHOR, "") : raw;
    const lower = line.toLowerCase();
    for (const name of needles) {
      const at = lower.indexOf(name.needle);
      if (at === -1) continue;
      hits.push({
        rule: RULE,
        file,
        line: index + 1,
        column: at + 1,
        message: `names ${name.kind}, which a public repo must not carry. Fix: use the neutral sample value ${name.neutral}. (${CITED})`,
      });
    }
  });
  return hits;
}

export function scanPrivateNames(root: string): NameHit[] {
  return files(root).flatMap((file) => {
    const text = read(root, file);
    return text === null ? [] : scanText(file, text);
  });
}
