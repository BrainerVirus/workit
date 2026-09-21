/** Dual-artifact matrix lanes (docs/opencode-v2/plan.md step 5b-6).
 *
 * One packed @brainervirus/workit-opencode artifact drives three lanes:
 * - `v2-native`: pinned V2 image, native config (`plugins`), packed dist entry;
 * - `v2-v1`: pinned V2 image, V1-shaped config copy, packed dist entry;
 * - `v1`: pinned V1 image, V1 config, packed dist entry through `server()`.
 *
 * Opt-in only: `WORKIT_V2_HARNESS=1 bun test test/opencode-v2/matrix.test.ts`
 * (needs docker plus the pinned images). Without the opt-in it passes silently.
 * The lane configs are copied into an isolated HOME; the host never touches
 * live credentials, and only read-only Workit work runs inside the lanes.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installPackedPackage, packWorkspacePackages } from "@/test/shared/helpers/packages";
import {
  V1_IMAGE,
  V2_IMAGE,
  bootLane,
  dispose,
  dockerAvailable,
  ensureImages,
  type Harness,
} from "./harness";

const ENABLED = process.env.WORKIT_V2_HARNESS === "1";
const OPENCODE = "@brainervirus/workit-opencode";

const WORKIT_TOOL_NAMES = [
  "workit_task",
  "workit_policy",
  "workit_evidence",
  "workit_finding",
  "workit_decision",
  "workit_worker",
  "workit_writer",
  "workit_state",
  "workit_external_action",
  "workit_init_apply",
];

type Lane = {
  name: string;
  harness: Harness;
  home: string;
  work: string;
  configPath: string;
  configBytes: string;
};

const lanes = new Map<string, Lane>();

const laneRoot = (name: string): { root: string; home: string; work: string; logDir: string } => {
  const root = path.join(tmpdir(), `workit-matrix-${process.pid}-${name}-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  const logDir = path.join(root, "logs");
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  return { root, home, work, logDir };
};

const v2Provider = () => ({
  stub: {
    name: "Stub",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: "http://stub:8000/v1" },
    models: {
      "stub-model": {
        name: "Stub Model",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 64000, output: 4096 },
      },
      "stub-workit": {
        name: "Stub Workit",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 64000, output: 4096 },
      },
    },
  },
});

type LaneArtifact = { pluginDir: string; fileEntry: string };

const v2NativeConfig = (artifact: LaneArtifact) =>
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "stub/stub-model",
      providers: v2Provider(),
      plugins: [artifact.pluginDir],
    },
    null,
    2,
  );

const v2V1Config = (artifact: LaneArtifact) =>
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "stub/stub-model",
      providers: v2Provider(),
      plugin: [artifact.pluginDir],
      permission: { bash: { "*git *worktree*": "deny" } },
      command: {
        "wk-user": {
          description: "user-defined command that must stay untouched",
          template: "echo $ARGUMENTS",
        },
      },
      skills: { paths: ["/workspace/work/user-skills"] },
    },
    null,
    2,
  );

/** V1 loads the exact packed file entry through `server()`; the V2 lanes load
 * the packed package directory (whose shim only re-exports that file). */
const v1Config = (artifact: LaneArtifact) =>
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "stub/stub-workit",
      provider: {
        stub: {
          npm: "@ai-sdk/openai-compatible",
          name: "Stub",
          options: { baseURL: "http://stub:8000/v1", apiKey: "stub-key" },
          models: {
            "stub-workit": { name: "Stub Workit" },
            "stub-model": { name: "Stub Model" },
          },
        },
      },
      plugin: [artifact.fileEntry],
    },
    null,
    2,
  );

const lines = (text: string): any[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** A configured V2 plugin must be a directory with a `server`/`index`
 * entrypoint, so the packed package is installed and shimmed once. The shim
 * only re-exports the packed `dist/plugin.js`; the artifact bytes are what
 * loads. */
const installLaneArtifact = (work: string): { pluginDir: string; fileEntry: string } => {
  const install = path.join(work, "node_modules", OPENCODE);
  installPackedPackage(path.join(work, "node_modules"), packs().opencode);
  const pluginDir = path.join(work, "plugins", "workit");
  cpSync(install, pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "index.js"), 'export { default } from "./dist/plugin.js";\n');
  return {
    pluginDir: `/workspace/work/plugins/workit`,
    fileEntry: `file:///workspace/work/node_modules/${OPENCODE}/dist/plugin.js`,
  };
};

const prepare = (name: string, image: string, config: (artifact: LaneArtifact) => string) => {
  const dirs = laneRoot(name);
  const artifact = installLaneArtifact(dirs.work);
  const configPath = path.join(dirs.home, ".config", "opencode", "opencode.json");
  const configBytes = config(artifact);
  writeFileSync(configPath, configBytes);
  return { ...dirs, image, configPath, configBytes };
};

let packed: ReturnType<typeof packWorkspacePackages> | null = null;
const packs = () => {
  if (!packed) packed = packWorkspacePackages();
  const opencode = packed.find((entry) => entry.packageName === OPENCODE);
  if (!opencode) throw new Error("packed workit-opencode tarball missing");
  return { opencode };
};

beforeAll(async () => {
  if (!ENABLED) return;
  // The opt-in is an explicit request for this gate: an unavailable
  // environment fails loudly instead of reporting a vacuous pass.
  if (!(await dockerAvailable())) throw new Error("WORKIT_V2_HARNESS=1 but docker is unavailable");
  try {
    await ensureImages();
  } catch {
    throw new Error("WORKIT_V2_HARNESS=1 but the pinned images are unreachable");
  }
  for (const [name, image, driver, config] of [
    ["v2-native", V2_IMAGE, "v2", v2NativeConfig],
    ["v2-v1", V2_IMAGE, "v2", v2V1Config],
    ["v1", V1_IMAGE, "v1", v1Config],
  ] as const) {
    const prepared = prepare(name, image, config);
    const harness = await bootLane({
      image: prepared.image,
      root: prepared.root,
      home: prepared.home,
      work: prepared.work,
      logDir: prepared.logDir,
      driver,
    });
    lanes.set(name, {
      name,
      harness,
      home: prepared.home,
      work: prepared.work,
      configPath: prepared.configPath,
      configBytes: prepared.configBytes,
    });
  }
}, 900_000);

afterAll(async () => {
  for (const lane of lanes.values()) await dispose(lane.harness);
  lanes.clear();
});

const need = (name: string): Lane | null => lanes.get(name) ?? null;

const sessionWithModel = async (h: Harness, model: string): Promise<string> => {
  const session = await h.api("POST", "/api/session", {
    location: { directory: "/workspace/work" },
  });
  const id = session.data.id as string;
  await h.api(
    "POST",
    `/api/session/${id}/model`,
    { model: { providerID: "stub", id: model } },
    true,
  );
  return id;
};

const waitIdle = async (h: Harness, id: string, timeoutMs = 120_000): Promise<any[]> => {
  const start = Date.now();
  for (;;) {
    const context = await h.api("GET", `/api/session/${id}/context`);
    const messages = context.data as any[];
    if (messages.some((message) => message.type === "idle")) return messages;
    if (Date.now() - start > timeoutMs) throw new Error(`session ${id} never idle`);
    await Bun.sleep(2000);
  }
};

const runWorkitTool = async (h: Harness, model = "stub-workit"): Promise<any[]> => {
  const id = await sessionWithModel(h, model);
  await h.api("POST", `/api/session/${id}/prompt`, { text: "run the workit lane" });
  return waitIdle(h, id);
};

const toolCall = (messages: any[], name: string): any =>
  messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .find((part) => part.type === "tool" && part.name === name);

const toolText = (call: any): string =>
  Array.isArray(call?.state?.content)
    ? call.state.content.map((part: any) => String(part?.text ?? "")).join("\n")
    : String(call?.state?.content ?? "");

const dataOf = (value: any): any[] => (Array.isArray(value?.data) ? value.data : []);

const offeredTools = (log: string): string[] =>
  (lines(log)
    .filter((request) => Array.isArray(request.tools) && request.tools.length > 5)
    .at(-1)?.tools ?? []) as string[];

test("V2 native lane loads the packed plugin, registers skills, and executes a family tool", async () => {
  const lane = need("v2-native");
  if (!lane) return;
  const plugins = dataOf(await lane.harness.op("v2.plugin.list"));
  expect(plugins.map((entry) => entry.id)).toContain("workit");
  const skills = dataOf(await lane.harness.op("v2.skill.list")).map((entry) => entry.id);
  for (const id of [
    "workit-challenge",
    "workit-behavioral-tdd",
    "workit-review",
    "workit-plan",
    "workit-implement",
    "workit-debug",
    "workit-handoff",
    "workit-babysit",
    "workit-blast-radius",
    "workit-deslop",
    "workit-diagram",
    "workit-mockup",
    "workit-green-run",
    "workit-steer",
  ])
    expect(skills, id).toContain(id);
  const commands = dataOf(await lane.harness.op("v2.command.list")).map((entry) => entry.name);
  for (const alias of [
    "wk-challenge",
    "wk-babysit",
    "wk-implement",
    "wk-plan",
    "wk-debug",
    "wk-review",
    "wk-handoff",
    "wk-tdd",
    "wk-blast-radius",
    "wk-deslop",
    "wk-diagram",
    "wk-mockup",
    "wk-green-run",
    "wk-steer",
  ])
    expect(commands, alias).toContain(alias);

  const messages = await runWorkitTool(lane.harness);
  const call = toolCall(messages, "workit_task");
  expect(call).toBeDefined();
  expect(call.state.status).toBe("completed");
  expect(toolText(call)).toContain('"ok": true');
  const offered = offeredTools(lane.harness.stubLog());
  for (const name of WORKIT_TOOL_NAMES) expect(offered, name).toContain(name);
}, 300_000);

test("V2 V1-shaped config lane behaves identically and rewrites nothing", async () => {
  const lane = need("v2-v1");
  if (!lane) return;
  const messages = await runWorkitTool(lane.harness);
  const call = toolCall(messages, "workit_task");
  expect(call.state.status).toBe("completed");
  expect(toolText(call)).toContain('"ok": true');
  const offered = offeredTools(lane.harness.stubLog());
  for (const name of WORKIT_TOOL_NAMES) expect(offered, name).toContain(name);
  // A user-defined command survives alongside the 14 Workit aliases.
  const commands = dataOf(await lane.harness.op("v2.command.list")).map((entry) => entry.name);
  expect(commands).toContain("wk-user");
  // The V1-shaped source file is normalized in memory only.
  expect(readFileSync(lane.configPath, "utf8")).toBe(lane.configBytes);
}, 300_000);

test("V1 lane loads the dual entry and offers every Workit tool", async () => {
  const lane = need("v1");
  if (!lane) return;
  const out = await lane.harness
    .exec(["opencode", "run", "run the workit lane"])
    .catch((error) => String(error));
  const offered = offeredTools(lane.harness.stubLog());
  for (const name of WORKIT_TOOL_NAMES) expect(offered, name).toContain(name);
  // Model text after the tool call proves the host executed the call and
  // continued the loop instead of failing the plugin load.
  expect(out).toContain("workit done");
  expect(readFileSync(lane.configPath, "utf8")).toBe(lane.configBytes);
}, 300_000);

test("packed artifact bundles no Effect runtime and no host SDK import", async () => {
  const lane = need("v2-native");
  if (!lane) return;
  const bundle = readFileSync(
    path.join(lane.work, "node_modules", OPENCODE, "dist", "plugin.js"),
    "utf8",
  );
  for (const spec of ["@opencode-ai/plugin", "@opencode/plugin", "effect"]) {
    expect(bundle, spec).not.toMatch(
      new RegExp(`(?:from\\s+|import\\s*\\(\\s*)\\s*["']${spec.replace("/", "\\/")}["']`),
    );
  }
});
