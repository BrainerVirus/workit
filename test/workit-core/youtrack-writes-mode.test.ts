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

const withYouTrackJson = (baseUrl: string, fn: () => void) => {
  const saved = process.env.WORKIT_YOUTRACK_CONFIG;
  const home = useConfigHome("wk-yt-json-");
  const file = path.join(home.configDir, "youtrack.json");
  writeFileSync(file, JSON.stringify({ baseUrl }));
  process.env.WORKIT_YOUTRACK_CONFIG = file;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.WORKIT_YOUTRACK_CONFIG;
    else process.env.WORKIT_YOUTRACK_CONFIG = saved;
    home.restore();
  }
};

test("Given writes auto with autoHosts, Then a write is auto only for an allowed host, and by default for youtrack.json's (what the MCP tools and the PR backlink reach)", () => {
  withWorkspaces(
    [
      {
        name: "personal",
        glob: "/srv/personal/**",
        youtrack: { writes: "auto", autoHosts: ["sandbox.youtrack.cloud"] },
      },
    ],
    () => {
      const cwd = "/srv/personal/repo";
      expect(youTrackWritesMode(cwd, "https://Sandbox.YouTrack.cloud/")).toBe("auto");
      expect(youTrackWritesMode(cwd, "https://sandbox.youtrack.cloud:443/api")).toBe("auto");
      // ytrack keys a host without its scheme (hosts.Parse: Key is host[:port]+path), so http is the same host.
      expect(youTrackWritesMode(cwd, "http://sandbox.youtrack.cloud")).toBe("auto");
      expect(youTrackWritesMode(cwd, "http://sandbox.youtrack.cloud:443")).toBe("ask");
      expect(youTrackWritesMode(cwd, "https://work.youtrack.cloud")).toBe("ask");
      expect(youTrackWritesMode(cwd, "https://sandbox.youtrack.cloud.evil.test")).toBe("ask");
      expect(youTrackWritesMode(cwd, "https://me@sandbox.youtrack.cloud")).toBe("ask");
      expect(youTrackWritesMode(cwd, null)).toBe("ask");
    },
  );
  for (const [baseUrl, mode] of [
    ["https://work.youtrack.cloud", "ask"],
    ["https://sandbox.youtrack.cloud", "auto"],
  ] as const)
    withYouTrackJson(baseUrl, () => {
      writeFileSync(
        path.join(process.env.WORKIT_CONFIG!, "workspaces.json"),
        JSON.stringify({
          workspaces: [
            {
              name: "personal",
              glob: "/srv/personal/**",
              youtrack: { writes: "auto", autoHosts: ["sandbox.youtrack.cloud"] },
            },
          ],
        }),
      );
      expect(youTrackWritesMode("/srv/personal/repo"), baseUrl).toBe(mode);
    });
});
