// #780: asking before a YouTrack write is the default for every workspace,
// existing ones included; `youtrack: { writes: "auto" }` is the only opt-out.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { youTrackWritesMode } from "@/packages/workit-core/src/core/youtrack-writes";
import { useConfigHome } from "../shared/grant-home";

// A temp account home: an `auto` reads the grant seal there (#819), never the real one.
const withWorkspaces = (workspaces: unknown[], fn: () => void) => {
  const home = useConfigHome("wk-yt-mode-");
  try {
    writeFileSync(path.join(home.configDir, "workspaces.json"), JSON.stringify({ workspaces }));
    fn();
  } finally {
    home.restore();
  }
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
      { name: "home", glob: "/srv/home/**", youtrack: { writes: "ask" } },
    ],
    () => {
      expect(youTrackWritesMode("/srv/work/repo")).toBe("auto");
      expect(youTrackWritesMode("/srv/home/repo")).toBe("ask");
    },
  );
});

test("Given a writes value the schema does not know, Then the file does not validate and every workspace asks", () => {
  withWorkspaces(
    [
      { name: "work", glob: "/srv/work/**", youtrack: { writes: "auto" } },
      { name: "home", glob: "/srv/home/**", youtrack: { writes: "yes please" } },
    ],
    () => {
      expect(youTrackWritesMode("/srv/work/repo")).toBe("ask");
      expect(youTrackWritesMode("/srv/home/repo")).toBe("ask");
    },
  );
});
