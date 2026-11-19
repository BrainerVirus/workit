import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  heavyCommand,
  heavyPlan,
  serverCommand,
  serverPlan,
} from "@/packages/workit-core/src/core/heavy";
import { maybeHeavy } from "@/packages/workit-core/src/core/heavy-words";
import { checksPath } from "@/test/workit-core/task-fixtures";

let root: string;
let state: string;
let env: NodeJS.ProcessEnv;
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "workit-heavy-"));
  mkdirSync(path.join(root, ".git"));
  state = mkdtempSync(path.join(tmpdir(), "workit-heavy-state-"));
  env = { PATH: process.env.PATH, WORKIT_STATE_DIR: state };
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
    "cargo +nightly build",
    "docker compose up --build",
    "nx run app:build",
    "nx test app",
    "rake spec",
    "pip install requests",
  ]) {
    expect(heavy(command), command).toBe(true);
    // The launchers' pre-check lets every heavy command reach the gate.
    expect(maybeHeavy(command, root, env), command).toBe(true);
  }
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
    "workit check --name unit -- bun test test/x.test.ts",
    "npx -y @workit-dev/cli check -- npm test",
    "tsc --watch",
    "jest --watch",
    "vitest watch",
    "npm run test:watch",
    "npm start",
    "pnpm dev",
    "storybook dev -p 6006",
    "npm run storybook",
    "nx graph",
    "rake",
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

test("given a repo pattern in .workit/checks.json, when its command runs, then it is heavy", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "workit-heavy-repo-"));
  try {
    mkdirSync(path.join(repo, ".git"));
    mkdirSync(path.join(repo, "sub"));
    const sub = path.join(repo, "sub");
    expect(heavyCommand("./ci/integration.sh --all", { cwd: sub, env })).toBeNull();
    writeFileSync(
      checksPath(repo),
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

const plan = (command: string, cwd = root) => heavyPlan(command, { cwd, env, rules: null });

test("given one simple heavy command, when planned, then it is rewritten verbatim after --, env prefixes kept in front", () => {
  expect(plan("npm run test:ci")).toEqual({
    kind: "rewrite",
    command: "workit check --heavy -- npm run test:ci",
    reason: "npm run test:ci",
  });
  expect(plan("CI=1 npm test")).toMatchObject({
    command: "CI=1 workit check --heavy -- npm test",
  });
  expect(plan("flock -o x.lock sh -c 'npm test'")).toMatchObject({
    command: "workit check --heavy -- flock -o x.lock sh -c 'npm test'",
  });
});

test("given one heavy command followed only by redirects or one tail/head/grep filter, when planned, then it is one rewritten command", () => {
  expect(plan("bun test 2>&1 | tail -50")).toMatchObject({
    kind: "rewrite",
    command: "workit check --heavy -- bun test",
  });
  // #913: the file the filter wrote stays on the unpiped call.
  expect(plan("bun test | tail -50 > out.txt")).toMatchObject({
    kind: "rewrite",
    command: "workit check --heavy -- bun test > out.txt",
  });
  expect(plan("bun test 2>&1 | head -n 20 >> log/run.txt")).toMatchObject({
    command: "workit check --heavy -- bun test >> log/run.txt 2>&1",
  });
  expect(plan("npm run lint >/dev/null 2>&1")).toMatchObject({
    command: "workit check --heavy -- npm run lint >/dev/null 2>&1",
  });
  expect(plan("bun test | grep -v ok | head -3").kind).toBe("split");
  expect(plan("bun test | tee out.log").kind).toBe("split");
  expect(plan("bun test && ls").kind).toBe("split");
});

test("given a chain with a heavy part, when planned, then it is split, naming the part's lease command and never bash -c", () => {
  for (const command of [
    "git status --short && make test && touch pwned.txt",
    "cd web && npm test",
    "npm test | tee out.log",
    "bash -c 'cd web && npm test'",
  ]) {
    const result = plan(command);
    expect(result.kind, command).toBe("split");
    if (result.kind !== "split") continue;
    expect(result.reason.split("now:")[1]).not.toContain("bash -c");
    expect(result.unblock).toMatch(/^workit check --heavy -- /u);
  }
  expect(plan("git status --short && make test && touch pwned.txt")).toMatchObject({
    unblock: "workit check --heavy -- make test",
  });
});

test("given an already wrapped command, a light one, or a checkout outside git, when planned, then nothing changes", () => {
  expect(plan("workit check --heavy -- npx jest")).toEqual({ kind: "none" });
  // The targeted unit lane runs as is: the hook neither wraps nor denies it.
  expect(plan("workit check --name unit -- bun test test/x.test.ts")).toEqual({ kind: "none" });
  expect(plan("ls -la")).toEqual({ kind: "none" });
  const outside = mkdtempSync(path.join(tmpdir(), "workit-heavy-nogit-"));
  try {
    expect(plan("npx jest", outside)).toEqual({ kind: "none" });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("given a deny rule naming the heavy command, when planned, then it passes through saying nothing", () => {
  const result = heavyPlan("npx jest", { cwd: root, env, rules: { deny: ["npx:*"], allow: [] } });
  expect(result).toMatchObject({ kind: "passthrough" });
  if (result.kind === "passthrough") expect(result.note).toBe("");
});

// Dev servers (#328): never heavy, routed to `workit run --bg` instead.
const server = (command: string) => serverCommand(command) !== null;

test("given dev servers across frameworks and wrappers, when classified, then each is a server and none is heavy", () => {
  for (const command of [
    "ng serve --port 4200",
    "npx ng serve",
    "vite",
    "vite --port 3000",
    "npx vite preview",
    "next dev",
    "pnpm exec next start",
    "nuxt dev",
    "astro dev",
    "react-scripts start",
    "webpack serve --mode development",
    "npm start",
    "npm run dev",
    "npm run start:prod",
    "yarn start",
    "pnpm dev",
    "bun dev",
    "bun run dev",
    "deno task dev",
    "yarn workspace web dev",
    "npx storybook dev -p 6006",
    "npm run storybook",
    "docker compose up",
    "docker compose -f dev.yml up web",
    "docker-compose up",
    "podman compose up",
    "make dev",
    "nx serve app",
    "nx run app:serve",
    "python3 -m http.server 8000",
    "python manage.py runserver",
    "bundle exec rails server",
    "mix phx.server",
    "PORT=3000 npm run dev",
    "cd web && npm run dev",
  ]) {
    expect(server(command), command).toBe(true);
    // The launchers' pre-check sends every server to the gate.
    expect(maybeHeavy(command, root, env), command).toBe(true);
  }
  for (const command of ["ng serve", "npm run dev", "docker compose up", "vite"])
    expect(heavy(command), command).toBe(false);
});

test("given builds, tests, detached compose, watch-only scripts and help, when classified, then none is a server", () => {
  for (const command of [
    "ng build",
    "ng test",
    "vite build",
    "next build",
    "npm run build",
    "npm run build:dev",
    "npm test",
    "npm run test:watch",
    "tsc --watch",
    "docker compose up -d",
    "docker compose up --detach web",
    "docker compose build",
    "ng serve --help",
    "npm run",
    "make test",
    "workit run --bg -- npm run dev",
    "npx -y @workit-dev/cli run --bg -- ng serve",
    "git status",
  ])
    expect(server(command), command).toBe(false);
  // No regression: the builds stay heavy.
  for (const command of ["ng build", "vite build", "next build", "npm run build"])
    expect(heavy(command), command).toBe(true);
});

const route = (command: string, rules: Parameters<typeof serverPlan>[1]["rules"] = null) =>
  serverPlan(command, { cwd: root, env, rules });

test("given one dev server, when planned, then it is rewritten to workit run --bg verbatim after --, env prefixes and output shaping kept", () => {
  expect(route("ng serve --port 4200")).toEqual({
    kind: "rewrite",
    command: "workit run --bg -- ng serve --port 4200",
    reason: "ng serve --port",
    server: true,
  });
  expect(route("PORT=3000 npm run dev")).toMatchObject({
    command: "PORT=3000 workit run --bg -- npm run dev",
  });
  expect(route("npm run dev 2>&1 | tail -20")).toMatchObject({
    kind: "rewrite",
    command: "workit run --bg -- npm run dev 2>&1 | tail -20",
  });
  expect(route("ng build").kind).toBe("none");
});

test("given a chain that starts a dev server, when planned, then it is split naming the exact workit run --bg call", () => {
  for (const [command, start] of [
    ["npm run dev && echo x", "workit run --bg -- npm run dev"],
    ["npm run dev; npm test", "workit run --bg -- npm run dev"],
    ["cd web && ng serve --port 4200", "workit run --bg -- ng serve --port 4200"],
  ] as const) {
    const result = route(command);
    expect(result.kind, command).toBe("split");
    if (result.kind !== "split") continue;
    expect(result.unblock).toBe(start);
    expect(result.reason).toContain(`Start it alone, now: \`${start}\``);
    expect(result.reason).not.toContain("bash -c");
  }
});

test("given host rules, when a dev server is planned, then a rule naming it or an allow covering only workit leaves it as typed (#429)", () => {
  const rules = (allow: string[], deny: string[] = []) => ({ allow, deny });
  expect(route("npm run dev", rules([], ["npm run dev:*"])).kind).toBe("passthrough");
  expect(route("npm run dev", "unreadable").kind).toBe("passthrough");
  // `workit:*` would let the rewrite run a command the user is asked about.
  expect(route("npm run dev", rules(["workit:*"])).kind).toBe("passthrough");
  expect(route("npm run dev", rules(["workit:*", "npm run dev:*"])).kind).toBe("rewrite");
  // Workit's own allows (enumerated verbs) never cover the wrapper.
  expect(route("npm run dev", rules(["workit git *", "workit ps *"])).kind).toBe("rewrite");
  expect(
    serverPlan("npm run dev", { cwd: root, env, rules: rules(["workit:*"]), bypass: true }).kind,
  ).toBe("rewrite");
});

test("given a dev server outside a git checkout or in PowerShell, when planned, then nothing changes", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "workit-server-nogit-"));
  try {
    expect(serverPlan("npm run dev", { cwd: outside, env, rules: null }).kind).toBe("none");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  expect(
    serverPlan("npm run dev", { cwd: root, env, rules: null, dialect: "powershell" }).kind,
  ).toBe("none");
});
