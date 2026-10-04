/** Dual-artifact matrix lanes (docs/opencode-v2/plan.md step 5b-6).
 *
 * One packed @brainervirus/workit-opencode artifact drives two lanes:
 * - `v2-native`: pinned V2 image, native config (`plugins`), packed dist entry;
 * - `v2-v1`: pinned V2 image, V1-shaped config copy (`plugin` key), packed dist
 *   entry. Workit 3 retired the V1 `server()` entry, so there is no V1 lane.
 *
 * Opt-in only: `WORKIT_V2_HARNESS=1 bun test test/opencode-v2/matrix.test.ts`
 * (needs docker plus the pinned images). Without the opt-in it reports skipped.
 * The lane configs are copied into an isolated HOME; the host never touches
 * live credentials, and only read-only Workit work runs inside the lanes.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installPackedPackage, packWorkspacePackages } from "@/test/shared/helpers/packages";
import {
  HARNESS_ENABLED,
  V2_IMAGE,
  bootLane,
  harnessTest,
  dispose,
  dockerAvailable,
  ensureImages,
  type Harness,
} from "./harness";
import {
  WORKIT_METHOD_SKILLS,
  WORKIT_SKILL_ALIASES,
} from "@/packages/workit-core/src/core/skill-manifests";

const ENABLED = HARNESS_ENABLED;
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
  "workit_context",
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

type LaneArtifact = { pluginDir: string };

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
const installLaneArtifact = (work: string): LaneArtifact => {
  const install = path.join(work, "node_modules", OPENCODE);
  installPackedPackage(path.join(work, "node_modules"), packs().opencode);
  const pluginDir = path.join(work, "plugins", "workit");
  cpSync(install, pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, "index.js"), 'export { default } from "./dist/plugin.js";\n');
  return {
    pluginDir: `/workspace/work/plugins/workit`,
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
  for (const [name, image, config] of [
    ["v2-native", V2_IMAGE, v2NativeConfig],
    ["v2-v1", V2_IMAGE, v2V1Config],
  ] as const) {
    const prepared = prepare(name, image, config);
    const harness = await bootLane({
      image: prepared.image,
      root: prepared.root,
      home: prepared.home,
      work: prepared.work,
      logDir: prepared.logDir,
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
  (lines(log).findLast((request) => Array.isArray(request.tools) && request.tools.length > 5)
    ?.tools ?? []) as string[];

harnessTest(
  "V2 native lane loads the packed plugin, registers skills, and executes a family tool",
  async () => {
    const lane = need("v2-native");
    if (!lane) return;
    const plugins = dataOf(await lane.harness.op("plugin.list"));
    expect(plugins.map((entry) => entry.id)).toContain("workit");
    const skills = dataOf(await lane.harness.op("skill.list")).map((entry) => entry.id);
    for (const id of WORKIT_METHOD_SKILLS) expect(skills, id).toContain(id);
    const commands = dataOf(await lane.harness.op("command.list")).map((entry) => entry.name);
    for (const alias of Object.keys(WORKIT_SKILL_ALIASES)) expect(commands, alias).toContain(alias);

    const messages = await runWorkitTool(lane.harness);
    const call = toolCall(messages, "workit_task");
    expect(call).toBeDefined();
    expect(call.state.status).toBe("completed");
    expect(toolText(call)).toContain('"ok": true');
    const offered = offeredTools(lane.harness.stubLog());
    for (const name of WORKIT_TOOL_NAMES) expect(offered, name).toContain(name);
  },
  300_000,
);

harnessTest(
  "V2 V1-shaped config lane behaves identically and rewrites nothing",
  async () => {
    const lane = need("v2-v1");
    if (!lane) return;
    const messages = await runWorkitTool(lane.harness);
    const call = toolCall(messages, "workit_task");
    expect(call.state.status).toBe("completed");
    expect(toolText(call)).toContain('"ok": true');
    const offered = offeredTools(lane.harness.stubLog());
    for (const name of WORKIT_TOOL_NAMES) expect(offered, name).toContain(name);
    // A user-defined command survives alongside the 14 Workit aliases.
    const commands = dataOf(await lane.harness.op("command.list")).map((entry) => entry.name);
    expect(commands).toContain("wk-user");
    // The V1-shaped source file is normalized in memory only.
    expect(readFileSync(lane.configPath, "utf8")).toBe(lane.configBytes);
  },
  300_000,
);

harnessTest("packed artifact bundles no Effect runtime and no host SDK import", async () => {
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
