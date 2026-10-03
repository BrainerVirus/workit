import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateLegacyDocs } from "@/packages/workit-core/src/core/docs-migration";
import { postUpdate } from "@/packages/workit-core/src/core/youtrack-tools";

// Confirmation gates compare with `=== true` on purpose: tool input arrives
// as untyped JSON, so truthy non-boolean values must never count as consent.
const notTrue = ["false", "no", "true", 1, {}] as unknown as boolean[];

test("YouTrack postUpdate rejects every truthy non-boolean confirmation", async () => {
  const operations = {
    postComment: () => {
      throw new Error("postComment must not run without confirmed: true");
    },
    logTime: () => {
      throw new Error("logTime must not run without confirmed: true");
    },
  };
  for (const confirmed of notTrue) {
    const result = await postUpdate({ confirmed, issueId: "NSR-1", markdown: "x" }, operations);
    expect(result.error, JSON.stringify(confirmed)).toBe("confirmed: true required");
  }
});

test("legacy docs migration treats truthy non-boolean confirmation as declined", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "wk-confirm-gate-"));
  try {
    for (const confirmed of notTrue) {
      expect(
        migrateLegacyDocs({ workspace_root: root, confirmed }),
        JSON.stringify(confirmed),
      ).toMatchObject({ ok: false, declined: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
