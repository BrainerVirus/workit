import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { heavyCommand, leaseRewrite } from "@/packages/workit-core/src/core/heavy";

let root: string;
let state: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "workit-heavy-"));
  mkdirSync(path.join(root, ".git"));
  state = mkdtempSync(path.join(tmpdir(), "workit-heavy-state-"));
  env = { PATH: process.env.PATH, WORKFLOW_TOOLKIT_STATE: state };
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const heavy = (command: string) => heavyCommand(command, { cwd: root, env }) !== null;

test("given raw heavy commands across ecosystems, when classified, then each is heavy", () => {
  for (const command of [
    "npx jest",
    "npx -y jest --runInBand",
    "npm run test:ci",
    "npm test",
    "npm ci",
    "pnpm -r build",
    "yarn lint",
    "yarn",
    "bun test test/x.test.ts",
    "bun run typecheck",
    "bunx tsc --noEmit",
    "npm exec -- vitest run",
    "make",
    "make -j4 check",
    "go test ./...",
    "cargo clippy --all-targets",
    "./gradlew build",
    "mvn -q verify",
    "dotnet test",
    "python3 -m pytest -q",
    "uv run pytest",
    "poetry run mypy src",
    "bundle exec rspec",
    "docker build -t app .",
    "docker compose build",
    "npx playwright test",
    "sonar-scanner",
  ])
    expect(heavy(command), command).toBe(true);
});

test("given wrappers and chains, when classified, then the heavy command inside is found", () => {
  for (const command of [
    "flock -o x.lock sh -c 'npm test'",
    "flock /tmp/claude-heavy-v2.lock -c 'npx jest'",
    "timeout 300 nice -n 10 env CI=1 npx jest",
    "CI=1 npm run test:ci",
    "cd packages/app && npm run build",
    "bash -c 'cd web && yarn test'",
    "ls; npm run lint | tee lint.log",
  ])
    expect(heavy(command), command).toBe(true);
});

test("given light commands, dev servers and workit itself, when classified, then none is heavy", () => {
  for (const command of [
    "ls -la",
    "git status",
    "cat package.json",
    "npm run",
    "npm view jest version",
    "jest --version",
    "make help",
    "npm run dev",
    "docker compose up",
    "bun scripts/gen.ts",
    "workit check --heavy -- npm test",
    "npx -y @brainervirus/workit-cli check -- npm test",
  ])
    expect(heavy(command), command).toBe(false);
});

test("given a light command, when classified repeatedly, then the gate adds well under 5 ms", () => {
  // Warm the module and the file reads once, as a long-lived hook host would.
  heavy("ls -la");
  const runs = 50;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) {
    heavy("ls -la");
    heavy("git status");
  }
  const perCommand = (performance.now() - started) / (runs * 2);
  expect(perCommand).toBeLessThan(5);
});

test("given a repo pattern in workit.checks.json, when its command runs, then it is heavy", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "workit-heavy-repo-"));
  try {
    mkdirSync(path.join(repo, ".git"));
    mkdirSync(path.join(repo, "sub"));
    const sub = path.join(repo, "sub");
    expect(heavyCommand("./ci/integration.sh --all", { cwd: sub, env })).toBeNull();
    writeFileSync(
      path.join(repo, "workit.checks.json"),
      JSON.stringify({ resources: { heavyCommands: ["./ci/integration.sh", "task test:*"] } }),
    );
    expect(heavyCommand("./ci/integration.sh --all", { cwd: sub, env })?.source).toEqual({
      pattern: "./ci/integration.sh",
      from: "repo",
    });
    expect(heavyCommand("task test:unit", { cwd: sub, env })).not.toBeNull();
    expect(heavyCommand("task lint", { cwd: sub, env })).toBeNull();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("given machine patterns in the state dir, when a matching command runs, then it is heavy", () => {
  writeFileSync(
    path.join(state, "heavy-commands.json"),
    JSON.stringify({ patterns: ["terraform plan"] }),
  );
  try {
    expect(heavyCommand("cd infra && terraform plan -out x", { cwd: root, env })?.source).toEqual({
      pattern: "terraform plan",
      from: "machine",
    });
    expect(heavyCommand("terraform fmt", { cwd: root, env })).toBeNull();
  } finally {
    rmSync(path.join(state, "heavy-commands.json"), { force: true });
  }
});

test("given a heavy command, when rewritten, then a plain one keeps its words and anything else goes through --shell", () => {
  expect(leaseRewrite("npm run test:ci")).toBe("workit check --heavy -- npm run test:ci");
  expect(leaseRewrite("  npx   jest ")).toBe("workit check --heavy -- npx jest");
  expect(leaseRewrite("CI=1 npm test")).toBe("workit check --heavy --shell -- 'CI=1 npm test'");
  expect(leaseRewrite("cd web && npm test")).toBe(
    "workit check --heavy --shell -- 'cd web && npm test'",
  );
  expect(leaseRewrite("flock -o x.lock sh -c 'npm test'")).toBe(
    `workit check --heavy --shell -- 'flock -o x.lock sh -c '\\''npm test'\\'''`,
  );
  expect(leaseRewrite("npm test | tee out.log")).toBe(
    "workit check --heavy --shell -- 'npm test | tee out.log'",
  );
});
