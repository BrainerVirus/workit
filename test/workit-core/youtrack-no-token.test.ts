// Workit never reads, writes or sends a YouTrack token (ytrack keeps it in the
// OS keyring), and makes no HTTP request of its own: forges go through gh/glab,
// YouTrack through ytrack. A source scan keeps a token client from coming back.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const PACKAGES = path.resolve(import.meta.dir, "../../packages");

type Source = { rel: string; text: string };

const sources = (): Source[] => {
  const out: Source[] = [];
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

// An HTTP client or an auth header. Each entry names why the file may say it.
const NETWORK = /\bfetch\(|Bearer |Authorization/;
const NETWORK_ALLOWED = new Map([
  ["workit-core/src/core/logger.ts", "the log redactor names Authorization headers to scrub them"],
]);

// The forge's VCS token (forge/) is the only token file Workit reads.
const isForge = (rel: string): boolean => rel.startsWith("workit-core/src/forge/");
const TOKEN_FILE = /\btokenFile\b/;
const TOKEN_FILE_ALLOWED = new Map([
  [
    "workit-cli/src/admin/doctor.ts",
    "checks a legacy youtrack.json tokenFile exists, to say delete it",
  ],
  [
    "workit-cli/src/admin/setup.ts",
    "checks a legacy youtrack.json tokenFile exists, to say it was left",
  ],
  ["workit-cli/src/verbs/ci.ts", "an unblock that names the forge's vcs.tokenFile"],
  ["workit-core/src/core/config-schemas.ts", "the schema of the forge's vcs.tokenFile"],
  [
    "workit-core/src/core/grant-seal.ts",
    "seals the forge's vcs.tokenFile as part of the identity (never reads it)",
  ],
  ["workit-core/src/core/workspaces.ts", "parses the forge's vcs.tokenFile from workspaces.json"],
]);

// Files that may name a legacy youtrack.token, each only to check it exists:
// doctor warns it can be deleted, setup and the scaffold report it left untouched.
// forge/resolve.ts names it in a comment about the VCS token file.
const LEGACY_NAMERS = new Set([
  "workit-cli/src/admin/doctor.ts",
  "workit-cli/src/admin/setup.ts",
  "workit-cli/src/logic.ts",
  "workit-core/src/forge/resolve.ts",
]);

const READ_CALL = /\b(?:readFileSync|readFile|openSync|createReadStream|Bun\.file)\(([^)]*)\)/g;

// YouTrack code reaches YouTrack only by running ytrack: no HTTP module, no curl.
const isYouTrack = (rel: string): boolean => /(?:^|\/)[^/]*(?:youtrack|ytrack)[^/]*$/i.test(rel);
const YOUTRACK_TRANSPORT = /["'`]node:https?["'`]|\bhttps?\.request\(|["'`]curl(?:\.exe)?["'`]/;

// A file read whose path says token. Each entry names why the file may read one.
const TOKEN_READ_ALLOWED = new Map([
  [
    "workit-core/src/fanout-worktree.ts",
    "reads the fanout worktree's random ownership marker, no credential",
  ],
]);

const readsTokenPath = (rel: string, args: string): boolean =>
  (/token/i.test(args) && !TOKEN_READ_ALLOWED.has(rel)) ||
  (LEGACY_NAMERS.has(rel) && /legacy/i.test(args));

/** Each rule a file breaks, as `<rel>: <what>`. */
const violations = (files: readonly Source[]): string[] =>
  files.flatMap(({ rel, text }) => [
    ...(NETWORK.test(text) && !NETWORK_ALLOWED.has(rel)
      ? [`${rel}: an HTTP call or auth header (${NETWORK.exec(text)?.[0]})`]
      : []),
    ...(TOKEN_FILE.test(text) && !isForge(rel) && !TOKEN_FILE_ALLOWED.has(rel)
      ? [`${rel}: names tokenFile`]
      : []),
    ...(isForge(rel)
      ? []
      : [...text.matchAll(READ_CALL)]
          .filter((match) => readsTokenPath(rel, match[1]))
          .map((match) => `${rel}: reads a token path (${match[0]})`)),
    ...(isYouTrack(rel) && YOUTRACK_TRANSPORT.test(text)
      ? [`${rel}: a YouTrack transport other than ytrack (${YOUTRACK_TRANSPORT.exec(text)?.[0]})`]
      : []),
  ]);

test("Given the shipped sources, Then none makes an HTTP call, sends an auth header or reads a token file outside the allowlists", () => {
  expect(violations(sources())).toEqual([]);
});

test("Given each allowlist entry, Then it carries a reason and its file still says what the entry allows", () => {
  const byRel = new Map(sources().map((file) => [file.rel, file.text]));
  for (const [allowed, pattern] of [
    [NETWORK_ALLOWED, NETWORK],
    [TOKEN_FILE_ALLOWED, TOKEN_FILE],
    [TOKEN_READ_ALLOWED, /FANOUT_TOKEN_FILE/],
  ] as const) {
    for (const [rel, reason] of allowed) {
      expect(reason.length, rel).toBeGreaterThan(10);
      expect(byRel.get(rel) ?? "", rel).toMatch(pattern);
    }
  }
});

test("Given planted offences, Then the scan names each file and what it broke", () => {
  const planted: Source[] = [
    { rel: "workit-cli/src/verbs/pr.ts", text: "await fetch(url);" },
    {
      rel: "workit-core/src/core/youtrack.ts",
      text: 'headers["Authorization"] = x;',
    },
    {
      rel: "workit-core/src/forge/github.ts",
      text: "const h = `Bearer ${token}`;",
    },
    {
      rel: "workit-core/src/core/youtrack-tools.ts",
      text: "const f = config.tokenFile;",
    },
    { rel: "workit-cli/src/logic.ts", text: "Bun.file(legacyPath).text();" },
    {
      rel: "workit-cli/src/verbs/note.ts",
      text: "readFileSync(ytTokenPath, 'utf8');",
    },
    {
      rel: "workit-core/src/core/youtrack-writes.ts",
      text: 'import https from "node:https";',
    },
    {
      rel: "workit-core/src/core/ytrack-skill.ts",
      text: "https.request(options);",
    },
    {
      rel: "workit-cli/src/verbs/youtrack.ts",
      text: 'spawnSync("curl", ["-s", url]);',
    },
  ];
  expect(violations(planted)).toEqual([
    "workit-cli/src/verbs/pr.ts: an HTTP call or auth header (fetch()",
    "workit-core/src/core/youtrack.ts: an HTTP call or auth header (Authorization)",
    "workit-core/src/forge/github.ts: an HTTP call or auth header (Bearer )",
    "workit-core/src/core/youtrack-tools.ts: names tokenFile",
    "workit-cli/src/logic.ts: reads a token path (Bun.file(legacyPath))",
    "workit-cli/src/verbs/note.ts: reads a token path (readFileSync(ytTokenPath, 'utf8'))",
    'workit-core/src/core/youtrack-writes.ts: a YouTrack transport other than ytrack ("node:https")',
    "workit-core/src/core/ytrack-skill.ts: a YouTrack transport other than ytrack (https.request()",
    'workit-cli/src/verbs/youtrack.ts: a YouTrack transport other than ytrack ("curl")',
  ]);
  // The allowed uses stay quiet: the redactor, the forge reading its own
  // token file, and doctor checking a legacy tokenFile exists.
  expect(
    violations([
      {
        rel: "workit-core/src/core/logger.ts",
        text: "// `Authorization: abc` is redacted",
      },
      {
        rel: "workit-core/src/forge/resolve.ts",
        text: "readFileSync(tokenFile.trim())",
      },
      {
        rel: "workit-cli/src/admin/doctor.ts",
        text: "existsSync(config.tokenFile)",
      },
    ]),
  ).toEqual([]);
});

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

test("Given the YouTrack modules, Then the transport rule covers each of them", () => {
  const youtrack = sources()
    .filter(({ rel }) => isYouTrack(rel))
    .map(({ rel }) => rel);
  expect(youtrack).toEqual(
    expect.arrayContaining([
      "workit-core/src/core/youtrack-backend.ts",
      "workit-core/src/core/youtrack-ytrack.ts",
      "workit-cli/src/upgrade/ytrack-skill.ts",
      "workit-cli/src/verbs/youtrack.ts",
    ]),
  );
});
