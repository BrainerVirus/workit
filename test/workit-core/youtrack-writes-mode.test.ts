// #780: asking before a YouTrack write is the default for every workspace,
// existing ones included; `youtrack: { writes: "auto" }` is the only opt-out.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { youTrackWritesMode } from "@/packages/workit-core/src/core/youtrack-writes";
import { withIsolatedConfig } from "../shared/helpers/env";

const withWorkspaces = (workspaces: unknown[], fn: () => void) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wk-yt-mode-"));
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify({ workspaces }));
  withIsolatedConfig(dir, fn);
};

test("Given workspaces that never set youtrack.writes, When a write's mode is resolved, Then it asks", () => {
  withWorkspaces(
    [
      {
        name: "work",
        glob: "/srv/work/**",
        youtrack: { baseUrl: "https://yt.example.test" },
      },
      { name: "home", glob: "/srv/home/**" },
    ],
    () => {
      expect(youTrackWritesMode("/srv/work/repo")).toBe("ask");
      expect(youTrackWritesMode("/srv/home/repo")).toBe("ask");
      expect(youTrackWritesMode("/elsewhere")).toBe("ask");
    },
  );
});

test("Given a workspace with youtrack.writes auto, Then only that workspace skips the ask", () => {
  withWorkspaces(
    [
      { name: "work", glob: "/srv/work/**", youtrack: { writes: "auto" } },
      {
        name: "home",
        glob: "/srv/home/**",
        youtrack: { writes: "yes please" },
      },
    ],
    () => {
      expect(youTrackWritesMode("/srv/work/repo")).toBe("auto");
      expect(youTrackWritesMode("/srv/home/repo")).toBe("ask");
    },
  );
});
