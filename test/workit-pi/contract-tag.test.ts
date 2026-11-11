// #793: Pi's model reads the contract in the same closed tag as every host.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { invariantBootstrap } from "@/packages/workit-core/src/core";
import { PI_DESCRIPTOR, sessionContextText } from "@/packages/workit-core/src/hooks/index";
import { workitContext } from "@/packages/workit-pi/src/context";

const root = mkdtempSync(path.join(tmpdir(), "workit-pi-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const ctx = (trusted: boolean) =>
  ({
    cwd: root,
    sessionManager: { getSessionId: () => "pi-session" },
    isProjectTrusted: () => trusted,
  }) as never;

test("Pi renders the contract exactly as the core renderer does for its host", () => {
  const rendered = sessionContextText(
    {
      host: "pi",
      cwd: root,
      session: { id: "pi-session", agentId: null, agentType: null, parentId: null },
      permissionMode: null,
      transcriptPath: null,
      event: { kind: "session.start", source: "startup" },
    },
    PI_DESCRIPTOR,
    { offer: false, addendum: "Native Pi session: pi-session." },
  );
  expect(workitContext(ctx(true))).toBe(rendered);
});

test("an untrusted Pi project still gets one closed <workit-contract> block", () => {
  const text = workitContext(ctx(false));
  expect(text).toMatch(/^<workit-contract>\n[\s\S]*\n<\/workit-contract>$/u);
  expect(text).toStartWith(`<workit-contract>\n${invariantBootstrap()}\n`);
  expect(text).toContain("unavailable until Pi trusts this project");
});
