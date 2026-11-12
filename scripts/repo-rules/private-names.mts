// The `private-names` repo rule: this repository is public, and tests and docs
// once used the maintainer's real employer, repos, usernames, SSH alias and home
// directory as sample values. oxlint only sees JS/TS, so this rule scans every
// tracked file itself: its path, and its bytes as ASCII/UTF-8 and as UTF-16 LE
// and BE, so binaries and UTF-16 text are covered too. The names are stored
// split into fragments so that a grep for them over the repo stays clean, this
// file included.
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

type NameHit = {
  rule: string;
  file: string;
  line: number;
  column: number;
  /** Set for a hit found in the raw bytes (a non-UTF-8 file, or UTF-16): its offset. */
  byte?: number;
  message: string;
};

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

function read(root: string, file: string): Uint8Array | null {
  const full = path.join(root, file);
  try {
    return statSync(full).isFile() ? readFileSync(full) : null;
  } catch {
    return null;
  }
}

const NEEDLES = NAMES.map((name) => {
  const needle = name.fragments.join("");
  const chars = needle.split(""); // the names are ASCII
  return {
    ...name,
    needle,
    utf16: [
      { encoding: "UTF-16 LE", needle: chars.map((c) => `${c}\0`).join("") },
      { encoding: "UTF-16 BE", needle: chars.map((c) => `\0${c}`).join("") },
    ],
  };
});

const message = (name: Name, where: string): string =>
  `names ${name.kind}${where}, which a public repo must not carry. Fix: use the neutral sample value ${name.neutral}. (${CITED})`;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decode(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function scanPath(file: string): NameHit[] {
  const lower = file.toLowerCase();
  return NEEDLES.filter((name) => lower.includes(name.needle)).map((name) => ({
    rule: RULE,
    file,
    line: 0,
    column: 0,
    message: message(name, " in its path"),
  }));
}

function scanLines(file: string, text: string): NameHit[] {
  const hits: NameHit[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = AUTHOR_FILES.has(file) ? raw.replaceAll(AUTHOR, "") : raw;
    const lower = line.toLowerCase();
    for (const name of NEEDLES) {
      const at = lower.indexOf(name.needle);
      if (at !== -1)
        hits.push({
          rule: RULE,
          file,
          line: index + 1,
          column: at + 1,
          message: message(name, ""),
        });
    }
  });
  return hits;
}

/**
 * Byte offsets, from a latin1 view: one char per byte, so lower-casing keeps
 * every offset. Plain needles only when the file is not UTF-8 (UTF-8 is scanned
 * by line); UTF-16 needles always.
 */
function scanBytes(file: string, bytes: Uint8Array, utf8: boolean): NameHit[] {
  const lower = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("latin1")
    .toLowerCase();
  const hits: NameHit[] = [];
  for (const name of NEEDLES) {
    const forms = utf8 ? name.utf16 : [{ encoding: "", needle: name.needle }, ...name.utf16];
    // UTF-16 text matches both byte orders one byte apart: report the first form only.
    for (const form of forms) {
      const at = lower.indexOf(form.needle);
      if (at === -1) continue;
      const as = form.encoding === "" ? "" : ` as ${form.encoding}`;
      hits.push({
        rule: RULE,
        file,
        line: 0,
        column: at,
        byte: at,
        message: message(name, `${as} at byte ${at}`),
      });
      break;
    }
  }
  return hits;
}

export function scanPrivateNames(root: string): NameHit[] {
  return files(root).flatMap((file) => {
    const bytes = read(root, file);
    if (bytes === null) return scanPath(file);
    const text = decode(bytes);
    return [
      ...scanPath(file),
      ...(text === null ? [] : scanLines(file, text)),
      ...scanBytes(file, bytes, text !== null),
    ];
  });
}
