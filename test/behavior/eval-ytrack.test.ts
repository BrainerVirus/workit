// The bench never reaches a real YouTrack (#780 review): every world's PATH
// leads with a fake `ytrack` that answers reads with canned JSON and refuses
// every write, and a real ytrack further down finds no login and no host.
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import { ytrackBackend } from "@/packages/workit-core/src/core/youtrack-backend";
import { findYtrack, ytrackRunner } from "@/packages/workit-core/src/core/youtrack-ytrack";
import { childEnv } from "@/scripts/eval/run";
import { makeWorld } from "@/scripts/eval/scaffold";

const world = makeWorld({ id: "ytrack-fake", tier: "smoke", prompt: "x", source: "test" } as never);
afterAll(() => rmSync(world.dir, { recursive: true, force: true }));
const savedToken = process.env.YTRACK_TOKEN;
process.env.YTRACK_TOKEN = "user-token-must-not-reach-the-world";
const env = childEnv(world, path.join(world.dir, "plugin-bin"));
if (savedToken === undefined) delete process.env.YTRACK_TOKEN;
else process.env.YTRACK_TOKEN = savedToken;

test.skipIf(process.platform === "win32")(
  "Given a bench world, Then the ytrack Workit finds is the world's fake, with no host or login of the user's",
  () => {
    expect(findYtrack(env)).toBe(path.join(world.bin, "ytrack"));
    expect(env.YTRACK_HOST).toBe("https://youtrack.invalid");
    expect(env.YTRACK_CONFIG_DIR?.startsWith(world.dir)).toBe(true);
    expect(env.YTRACK_TOKEN).toBeUndefined();
  },
);

test.skipIf(process.platform === "win32")(
  "Given the fake ytrack, Then reads are canned and every write is refused as not applied",
  async () => {
    const backend = ytrackBackend(ytrackRunner(env));
    expect(await backend.ownEntries("X-1", "workItems")).toEqual([]);
    expect(await backend.ownEntries("X-1", "comments")).toEqual([]);
    expect(await backend.texts("X-1", "comments")).toEqual({ texts: [], complete: true });
    expect(await backend.addWorkItem("X-1", { minutes: 30, text: "x", dateMs: 0 })).toMatchObject({
      ok: false,
      outcome: "not_applied",
    });
    expect(await backend.addComment("X-1", "x")).toMatchObject({
      ok: false,
      outcome: "not_applied",
    });
    expect(await backend.createIssue({ project: "X", summary: "s" })).toMatchObject({ ok: false });
    const run = ytrackRunner(env);
    expect(run(["api", "/users/me", "-X", "POST"]).status).toBe(2);
    expect(run(["api", "/issues", "-f", "summary=s"]).status).toBe(2);
  },
);
