// workit doctor: `grant_endpoint` (#455) and the per-host grant-rule rows
// (#419): a host whose allow rules miss a verb the workspace grants warns with
// the command that writes them. Grants are seeded in a scratch config home.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctor, type DoctorCheck } from "@/packages/workit-cli/src/admin/doctor";
import { useConfigHome, type ConfigHome } from "../shared/grant-home";

const scratch = mkdtempSync(path.join(tmpdir(), "workit-doctor-grants-"));
let configHome: ConfigHome;
beforeAll(() => {
  configHome = useConfigHome("wk-doctor-grants-config-");
});
afterAll(() => {
  configHome.restore();
  rmSync(scratch, { recursive: true, force: true });
});
afterEach(() => rmSync(path.join(configHome.configDir, "workspaces.json"), { force: true }));

const emptyBin = path.join(scratch, "empty-bin");
mkdirSync(emptyBin, { recursive: true });

let n = 0;
/** A scratch home with `hosts` installed, a project dir, and a workspace entry for it. */
const setup = (entry: Record<string, unknown> | null) => {
  const home = path.join(scratch, `home-${++n}`);
  const cwd = path.join(scratch, `project-${n}`);
  for (const dir of [".claude", ".codex/rules", ".cursor"])
    mkdirSync(path.join(home, dir), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (entry)
    writeFileSync(
      path.join(configHome.configDir, "workspaces.json"),
      JSON.stringify({
        workspaces: [{ name: "w", glob: `${cwd.replaceAll("\\", "/")}/**`, ...entry }],
      }),
    );
  return { home, cwd };
};

const rows = (home: string, cwd: string): Map<string, DoctorCheck> =>
  new Map(
    runDoctor({
      host: "cli",
      home,
      cwd,
      configDir: configHome.configDir,
      stateDir: path.join(home, "state"),
      dev: path.join(home, "no-dev"),
      env: {
        HOME: home,
        PATH: emptyBin,
        CODEX_HOME: path.join(home, ".codex"),
      },
      scopeProbe: () => ({
        effective: false,
        supported: false,
        reason: "test",
        delegate: null,
      }),
    }).checks.map((check) => [check.id, check]),
  );

// --- grant_endpoint (#455) ---------------------------------------------------

test("Given merge granted and endpoint pr, When doctor runs, Then grant_endpoint warns with the grant set command", () => {
  const { home, cwd } = setup({
    autonomy: { merge: true },
    defaultEndpoint: "pr",
  });
  const row = rows(home, cwd).get("grant_endpoint")!;
  expect(row.status).toBe("warn");
  expect(row.detail).toBe("merge granted, but endpoint pr stops at the PR");
  expect(row.fix).toBe(
    "to land on green: workit grant set w defaultEndpoint=merged (your terminal)",
  );
});

test("Given pr granted and endpoint commit, When doctor runs, Then grant_endpoint warns", () => {
  const { home, cwd } = setup({
    autonomy: { pr: true },
    defaultEndpoint: "commit",
  });
  const row = rows(home, cwd).get("grant_endpoint")!;
  expect(row.status).toBe("warn");
  expect(row.detail).toContain("pr granted, but endpoint commit stops at the local commit");
});

test("Given the grant and the endpoint agree, or no workspace entry, When doctor runs, Then grant_endpoint passes", () => {
  const agree = setup({ autonomy: { merge: true }, defaultEndpoint: "merged" });
  expect(rows(agree.home, agree.cwd).get("grant_endpoint")?.status).toBe("pass");
  const none = setup(null);
  expect(rows(none.home, none.cwd).get("grant_endpoint")?.status).toBe("pass");
});

// --- grant rules per host (#419) ---------------------------------------------

test("Given a granted workspace and no host rules, When doctor runs, Then each installed host warns with the exact setup command", () => {
  const { home, cwd } = setup({
    autonomy: { push: true, pr: true, merge: true },
  });
  const all = rows(home, cwd);
  for (const [id, host] of [
    ["claude_grant_rules", "claude-code"],
    ["codex_grant_rules", "codex"],
    ["cursor_grant_rules", "cursor"],
  ] as const) {
    const row = all.get(id)!;
    expect(row.status, id).toBe("warn");
    expect(row.detail, id).toContain("workit git push");
    expect(row.fix, id).toBe(`workit setup --hosts=${host}`);
  }
});

test("Given Claude allow rules for every verb but no auto-mode text naming workit, When doctor runs, Then only the auto-mode line is missing", async () => {
  const { home, cwd } = setup({ autonomy: { push: true } });
  const { CLAUDE_ALLOW } = await import("@/packages/workit-cli/src/admin/host-permissions");
  writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: [...CLAUDE_ALLOW] },
      autoMode: { allow: ["$defaults"] },
    }),
  );
  const row = rows(home, cwd).get("claude_grant_rules")!;
  expect(row.status).toBe("warn");
  expect(row.detail).toContain("do not cover autoMode.allow line naming workit:");
  expect(row.detail).not.toContain("workit git push");
});

test("Given the Workit block in every host, When doctor runs, Then the grant rows pass", async () => {
  const { home, cwd } = setup({
    autonomy: { push: true, pr: true, merge: true },
  });
  const { CLAUDE_ALLOW, CURSOR_ALLOW, codexRulesText } =
    await import("@/packages/workit-cli/src/admin/host-permissions");
  writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: [...CLAUDE_ALLOW] },
      autoMode: {
        allow: ["$defaults", "Workit-gated delivery: `workit pr merge` is authorized"],
      },
    }),
  );
  writeFileSync(path.join(home, ".codex", "rules", "workit.rules"), codexRulesText());
  writeFileSync(
    path.join(home, ".cursor", "cli-config.json"),
    JSON.stringify({ permissions: { allow: [...CURSOR_ALLOW] } }),
  );
  const all = rows(home, cwd);
  for (const id of ["claude_grant_rules", "codex_grant_rules", "cursor_grant_rules"])
    expect(all.get(id)?.status, `${id}: ${all.get(id)?.detail}`).toBe("pass");
});

test("Given merge is not granted, When the rules lack `workit pr merge`, Then the row does not ask for it", () => {
  const { home, cwd } = setup({ autonomy: { merge: false } });
  writeFileSync(
    path.join(home, ".cursor", "cli-config.json"),
    JSON.stringify({
      permissions: {
        allow: [
          "Shell(workit git)",
          "Shell(workit pr)",
          ...["test", "lint", "typecheck", "build", "format", "docs"].map(
            (name) => `Shell(workit check ${name})`,
          ),
          "Shell(workit lock status)",
          "Shell(workit lock wait)",
        ],
      },
    }),
  );
  expect(rows(home, cwd).get("cursor_grant_rules")?.status).toBe("pass");
});

test("Given a project-level Claude allow rule for the verbs, When doctor runs, Then it counts", () => {
  const { home, cwd } = setup({ autonomy: { push: true } });
  mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(workit *)"] },
      autoMode: { allow: ["workit push is fine"] },
    }),
  );
  expect(rows(home, cwd).get("claude_grant_rules")?.status).toBe("pass");
});

test("Given no workspace entry or no installed host, When doctor runs, Then the rows are information", () => {
  const { home, cwd } = setup(null);
  expect(rows(home, cwd).get("claude_grant_rules")?.status).toBe("info");
  const granted = setup({ autonomy: { push: true } });
  rmSync(path.join(granted.home, ".cursor"), { recursive: true });
  expect(rows(granted.home, granted.cwd).get("cursor_grant_rules")?.status).toBe("info");
});

test("Given legacy, wildcard and bare Claude rules, When doctor runs, Then each covers the Workit verbs", () => {
  for (const rule of ["Bash(workit:*)", "Bash(workit *)", "Bash(*)", "Bash"]) {
    const { home, cwd } = setup({ autonomy: { push: true } });
    writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: [rule] }, autoMode: { allow: ["workit ok"] } }),
    );
    const row = rows(home, cwd).get("claude_grant_rules")!;
    expect(row.status, `${rule}: ${row.detail}`).toBe("pass");
  }
  const { home, cwd } = setup({ autonomy: { push: true } });
  writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: { allow: ["Bash(workitx:*)"] },
      autoMode: { allow: ["workit"] },
    }),
  );
  expect(rows(home, cwd).get("claude_grant_rules")?.status).toBe("warn");
});

test("Given ~/.cursor without a cli-config, When doctor runs, Then the warning says the file does not exist and setup writes it", () => {
  const { home, cwd } = setup({ autonomy: { push: true } });
  const row = rows(home, cwd).get("cursor_grant_rules")!;
  expect(row.status).toBe("warn");
  expect(row.detail).toContain("does not exist yet");
  expect(row.detail).toContain("`workit setup` writes it");
  expect(row.fix).toBe("workit setup --hosts=cursor");
});

// --- grant_remotes (#549) ----------------------------------------------------

test("Given a workspace that claims no remotes, When doctor runs in its checkout, Then grant_remotes warns with the command naming its origin", () => {
  const { home, cwd } = setup({ autonomy: { push: true } });
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["remote", "add", "origin", "git@github.com:me/app.git"], { cwd });
  const row = rows(home, cwd).get("grant_remotes")!;
  expect(row.status).toBe("warn");
  expect(row.detail).toContain("workspace w claims no remotes");
  expect(row.fix).toBe(
    "in your own terminal: workit workspace set w remotes=git@github.com:me/app.git",
  );
});

test("Given a checkout whose origin a stricter workspace claims, When doctor runs, Then grant_remotes warns naming that workspace", () => {
  const { home, cwd } = setup(null);
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/strict.git"], { cwd });
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        { name: "open", glob: `${cwd.replaceAll("\\", "/")}/**`, remotes: ["git@github.com:me/*"] },
        {
          name: "strict",
          glob: `${scratch.replaceAll("\\", "/")}/strict/**`,
          autonomy: { push: false },
          remotes: ["git@github.com:ACME/strict.git"],
        },
      ],
    }),
  );
  const row = rows(home, cwd).get("grant_remotes")!;
  expect(row.status).toBe("warn");
  expect(row.detail).toContain("is claimed by workspace strict");
  expect(row.detail).not.toContain("claims no remotes");
});

test("Given a workspace whose remotes claim its own origin, When doctor runs, Then grant_remotes passes", () => {
  const { home, cwd } = setup({ remotes: ["https://github.com/me/app"] });
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["remote", "add", "origin", "git@github.com:me/app.git"], { cwd });
  expect(rows(home, cwd).get("grant_remotes")!.status).toBe("pass");
});
