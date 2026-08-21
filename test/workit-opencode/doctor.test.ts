import { afterAll, afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DoctorReport } from "../../packages/workit-core/src/core/doctor";
import { runDoctor } from "../../packages/workit-core/src/core/doctor";
import { makeDoctorFixture } from "../shared/helpers/doctor-fixture";

// workit_doctor on the OpenCode host (DG-07): returns the same report shape as
// runDoctor, forced broken fixtures yield consistent nonzero, the host stays
// usable, and no canary reaches logs.

const tempDirs: string[] = [];
const persistentDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Persistent env + fixture at module scope so the plugin import resolves the
// same isolated config/state/dev the tests mutate.
const fixture = makeDoctorFixture();
persistentDirs.push(fixture.root);
afterAll(() => {
  for (const dir of persistentDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const previous = {
  HOME: process.env.HOME,
  WORKFLOW_TOOLKIT_CONFIG: process.env.WORKFLOW_TOOLKIT_CONFIG,
  WORKFLOW_TOOLKIT_STATE: process.env.WORKFLOW_TOOLKIT_STATE,
  WORKFLOW_TOOLKIT_DEV: process.env.WORKFLOW_TOOLKIT_DEV,
};
Object.assign(process.env, {
  HOME: fixture.home,
  WORKFLOW_TOOLKIT_CONFIG: fixture.configDir,
  WORKFLOW_TOOLKIT_STATE: fixture.stateDir,
  WORKFLOW_TOOLKIT_DEV: fixture.dev,
});
afterAll(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Cache-busted import so the plugin + logger rate budget are fresh for this file.
const pluginSpecifier = "../../packages/workit-opencode/src/plugin.ts?doctor-test";
const pluginModule = await import(pluginSpecifier);
const { default: plugin } = pluginModule;

type Captured = { level: string; message: string; context: Record<string, unknown> };
const makeClient = (): { client: unknown; events: Captured[] } => {
  const events: Captured[] = [];
  const client = {
    app: {
      async log(options: {
        body: { service: string; level: string; message: string; extra: Record<string, unknown> };
      }) {
        events.push({
          level: options.body.level,
          message: options.body.message,
          context: options.body.extra,
        });
        return {};
      },
    },
  };
  return { client, events };
};

const clientArgs = {
  directory: fixture.cwd,
  worktree: fixture.cwd,
  serverUrl: new URL("http://localhost"),
};

const reportOf = (raw: string): DoctorReport => (JSON.parse(raw) as { data: DoctorReport }).data;

const direct = () => runDoctor({ host: "opencode", cwd: fixture.cwd });

test("workit_doctor returns the runDoctor report shape on a healthy install", async () => {
  const { client } = makeClient();
  const hooks = await plugin({ client, ...clientArgs } as never);
  const raw = (await hooks.tool!.workit_doctor.execute({}, clientArgs as never)) as string;
  const report = reportOf(raw);
  expect(report.ok).toBe(true);
  expect(report.exitCode).toBe(0);
  expect(report.offline).toBe(true);
  expect(report.host).toBe("opencode");
  expect(report.summary).toEqual(direct().summary);
  expect(report.checks.map((c) => [c.id, c.status])).toEqual(
    direct().checks.map((c) => [c.id, c.status]),
  );

  // the host stayed usable: the config hook still registers commands + skills
  const config: Record<string, any> = {};
  await hooks.config?.(config);
  expect(Object.keys(config.command).length).toBeGreaterThan(0);
});

test("forced broken fixture yields consistent nonzero via workit_doctor", async () => {
  writeFileSync(
    fixture.opencodeConfig,
    JSON.stringify({
      plugin: [
        "workflow-toolkit-opencode@git+file:///legacy",
        `file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`,
      ],
    }),
  );
  try {
    const { client } = makeClient();
    const hooks = await plugin({ client, ...clientArgs } as never);
    const raw = (await hooks.tool!.workit_doctor.execute({}, clientArgs as never)) as string;
    const report = reportOf(raw);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(
      report.checks.some((c) => c.id === "duplicate_registration" && c.status === "fail"),
    ).toBe(true);
    // parity with the shared engine
    expect(report.checks.map((c) => [c.id, c.status])).toEqual(
      runDoctor({ host: "opencode", cwd: fixture.cwd }).checks.map((c) => [c.id, c.status]),
    );
    // host remains usable: a sibling tool still executes
    const verify = (await hooks.tool!.workit_verify.execute(
      { dry_run: true },
      clientArgs as never,
    )) as string;
    expect(JSON.parse(verify)).toHaveProperty("ok");
  } finally {
    writeFileSync(
      fixture.opencodeConfig,
      JSON.stringify({ plugin: [`file://${fixture.dev}/packages/workit-opencode/src/plugin.ts`] }),
    );
  }
});

test("no canary reaches logs or the tool result", async () => {
  const tokenFile = path.join(fixture.configDir, "youtrack.token");
  const youtrackJson = path.join(fixture.configDir, "youtrack.json");
  writeFileSync(youtrackJson, JSON.stringify({ tokenFile }));
  writeFileSync(tokenFile, "sk-live-77\n", { mode: 0o600 });

  const { client, events } = makeClient();
  const hooks = await plugin({ client, ...clientArgs } as never);
  events.length = 0;
  const raw = (await hooks.tool!.workit_doctor.execute({}, clientArgs as never)) as string;
  expect(JSON.stringify(raw)).not.toContain("sk-live-77");
  // the doctor boundary event lands on the app log with summary only
  const doctorEvents = events.filter((e) => e.message === "doctor");
  expect(doctorEvents.length).toBeGreaterThanOrEqual(1);
  const rawEvents = JSON.stringify(events);
  expect(rawEvents).not.toContain("sk-live-77");
  expect(rawEvents).toContain("failed");
});
