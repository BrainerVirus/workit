// Descriptor drift guard: a descriptor's events say what workit registers on
// each host, so every event it marks native (or partial) must be registered
// in that host's hooks config or plugin source, and every hook a hook-process
// host registers must be one the descriptor maps. Host features workit leaves
// unregistered are recorded in docs/agents/hosts.md (Host parity), not here.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  OPENCODE_DESCRIPTOR,
  PI_DESCRIPTOR,
  type HostDescriptor,
} from "@/packages/workit-core/src/hooks/index";

const PACKAGES = path.resolve(import.meta.dir, "../../../packages");
const read = (file: string) => readFileSync(path.join(PACKAGES, file), "utf8");

/** Event names a hooks.json registers (Claude Code, Codex, Cursor share the `hooks` map shape). */
const hooksConfig = (file: string): Set<string> =>
  new Set(Object.keys((JSON.parse(read(file)) as { hooks: Record<string, unknown> }).hooks));

/** `ctx.<area>.hook("<name>", …)` registrations, named as the descriptor names them. */
const opencodeHooks = (file: string): Set<string> =>
  new Set(
    [...read(file).matchAll(/\bctx\.(\w+)\.hook\("([\w.]+)"/g)].map(
      ([, area, name]) => `${area}.hook("${name}")`,
    ),
  );

/** `pi.on("<event>", …)` registrations. */
const piHooks = (file: string): Set<string> =>
  new Set([...read(file).matchAll(/\bpi\.on\("(\w+)"/g)].map(([, name]) => name));

const HOSTS: Array<{
  descriptor: HostDescriptor;
  registered: Set<string>;
  /** Hook-process configs register nothing a descriptor does not map. */
  exhaustive: boolean;
}> = [
  {
    descriptor: CLAUDE_CODE_DESCRIPTOR,
    registered: hooksConfig("workit-claude-code/hooks/hooks.json"),
    exhaustive: true,
  },
  {
    descriptor: CODEX_DESCRIPTOR,
    registered: hooksConfig("workit-codex/hooks/hooks.json"),
    exhaustive: true,
  },
  {
    descriptor: CURSOR_DESCRIPTOR,
    registered: hooksConfig("workit-cursor/hooks/hooks-cursor.json"),
    exhaustive: true,
  },
  // In-process plugins also subscribe to bookkeeping events (Pi's
  // session_compact, session_shutdown) that carry no protocol event.
  {
    descriptor: OPENCODE_DESCRIPTOR,
    registered: opencodeHooks("workit-opencode/src/v2/plugin.ts"),
    exhaustive: false,
  },
  {
    descriptor: PI_DESCRIPTOR,
    registered: piHooks("workit-pi/extensions/workit.ts"),
    exhaustive: false,
  },
];

/** The registered hook a native name refers to: OpenCode qualifies subagent uses with a suffix. */
const hookOf = (native: string) => native.replace(/ subagent$/, "");

test("every host descriptor marks native exactly the events workit registers on that host", () => {
  for (const { descriptor, registered, exhaustive } of HOSTS) {
    expect(registered.size, descriptor.host).toBeGreaterThan(0);
    const mapped = new Set<string>();
    for (const [kind, event] of Object.entries(descriptor.events)) {
      const usable = event.support === "native" || event.support === "partial";
      // A native name without support, or support without a name, is drift too.
      expect(event.native !== null, `${descriptor.host} ${kind}: native name iff usable`).toBe(
        usable,
      );
      if (!usable || event.native === null) continue;
      mapped.add(hookOf(event.native));
      expect(
        registered.has(hookOf(event.native)),
        `${descriptor.host} ${kind} → ${event.native} is not registered`,
      ).toBe(true);
    }
    if (exhaustive)
      for (const hook of registered)
        expect(
          mapped.has(hook),
          `${descriptor.host} registers ${hook} but maps no event to it`,
        ).toBe(true);
  }
});
