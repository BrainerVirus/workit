// A 1.x OpenCode host has no background service to wait for, and its own
// version (`opencode --version`) is never the Workit plugin's version.
import { expect, test } from "bun:test";
import { waitForOpencodePlugin } from "@/packages/workit-cli/src/upgrade/opencode";

test("given OpenCode 1.18.34 listing workit 8.44.0, then readiness returns at once with the plugin's version", async () => {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push([command, ...args].join(" "));
    if (args[0] === "--version") return { status: 0, stdout: "1.18.34\n", stderr: "" };
    if (args[0] === "api") return { status: 1, stdout: "", stderr: 'Error: unknown command "api"' };
    return {
      status: 0,
      stdout: "ID      VERSION  SOURCE\nworkit  8.44.0   @brainervirus/workit-opencode\n",
      stderr: "",
    };
  };
  const reading = await waitForOpencodePlugin(run, "/home/u", { timeoutMs: 60_000 });
  expect(reading?.listed).toBe(true);
  expect(reading?.version).toBe("8.44.0");
  expect(calls).toContain("opencode plugin list");
});

test("given OpenCode 1.18.34 that lists no Workit plugin, then readiness reports no version, never the host's", async () => {
  const run = async (_command: string, args: string[]) =>
    args[0] === "--version"
      ? { status: 0, stdout: "1.18.34\n", stderr: "" }
      : { status: 0, stdout: "No plugins found\n", stderr: "" };
  const reading = await waitForOpencodePlugin(run, "/home/u", { timeoutMs: 60_000 });
  expect(reading?.listed).toBe(true);
  expect(reading?.version).toBeUndefined();
});
