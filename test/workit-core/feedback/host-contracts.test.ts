import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FEEDBACK_LINE } from "@/packages/workit-core/src/core/methods";
import { getWorkitBootstrap } from "@/packages/workit-opencode/src/bootstrap";
import { workitContext } from "@/packages/workit-pi/src/context";
import { useConfigHome, type ConfigHome } from "../../shared/grant-home";

// #777 host parity: OpenCode and Pi render the contract for the session's
// directory, so `feedback: "off"` hides the feedback line there too.

let configHome: ConfigHome;
let off: string;
let on: string;
beforeAll(() => {
  configHome = useConfigHome("wk-feedback-hosts-");
  off = path.join(configHome.home, "src", "client", "app");
  on = path.join(configHome.home, "src", "own", "app");
  for (const dir of [off, on]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(configHome.configDir, "workspaces.json"),
    JSON.stringify({
      workspaces: [
        {
          name: "client",
          glob: `${path.dirname(off).replaceAll("\\", "/")}/**`,
          feedback: "off",
        },
        { name: "own", glob: `${path.dirname(on).replaceAll("\\", "/")}/**` },
      ],
    }),
  );
});
afterAll(() => configHome.restore());

const piContext = (cwd: string) =>
  workitContext({
    cwd,
    sessionManager: { getSessionId: () => "pi-session" },
    isProjectTrusted: () => true,
  } as never);

test('Given `feedback: "off"`, When OpenCode renders the contract for that directory, Then the feedback line is absent; elsewhere it is present', () => {
  expect(getWorkitBootstrap(off)).not.toContain("workit feedback");
  expect(getWorkitBootstrap(off)).toContain("<workit-contract>");
  expect(getWorkitBootstrap(on)).toContain(FEEDBACK_LINE);
});

test('Given `feedback: "off"`, When Pi renders the contract for that directory, Then the feedback line is absent; elsewhere it is present', () => {
  expect(piContext(off)).not.toContain("workit feedback");
  expect(piContext(off)).toContain("<workit-contract>");
  expect(piContext(on)).toContain(FEEDBACK_LINE);
});
