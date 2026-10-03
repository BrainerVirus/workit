import { expect, test } from "bun:test";
import {
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  OPENCODE_DESCRIPTOR,
  PI_DESCRIPTOR,
  capabilitiesFor,
  support,
  type Axis,
  type HostDescriptor,
  type Support,
} from "@/packages/workit-core/src/hooks/index";

const DESCRIPTORS = [
  CLAUDE_CODE_DESCRIPTOR,
  CODEX_DESCRIPTOR,
  CURSOR_DESCRIPTOR,
  OPENCODE_DESCRIPTOR,
  PI_DESCRIPTOR,
];

/** Every runtime observation any rule can ask for, all granted. */
const allObserved = (descriptor: HostDescriptor) =>
  Object.fromEntries(
    descriptor.capabilities.flatMap((rule) => (rule.observed ?? []).map((flag) => [flag, true])),
  );

/** A copy of `descriptor` with one axis set to `value`. */
const withAxis = (descriptor: HostDescriptor, axis: Axis, value: Support): HostDescriptor => {
  const copy = structuredClone(descriptor);
  if (axis.startsWith("event:"))
    copy.events[axis.slice(6) as keyof HostDescriptor["events"]].support = value;
  else if (axis === "shellPolicy.deny") copy.shellPolicy.deny = value;
  else if (axis === "stopControl" || axis === "shellAvailable") copy[axis] = value;
  else {
    const [group, key] = axis.split(".") as ["context", "sessionStart"];
    copy[group][key] = value as never;
  }
  return copy;
};

test("host descriptors match their reviewed snapshots", () => {
  for (const descriptor of DESCRIPTORS)
    expect({
      descriptor,
      capabilities: capabilitiesFor(descriptor, allObserved(descriptor)),
      unobserved: capabilitiesFor(descriptor),
    }).toMatchSnapshot(descriptor.host);
});

test("given an undocumented axis, capabilitiesFor never yields enforced for it", () => {
  let checked = 0;
  for (const descriptor of DESCRIPTORS) {
    const axes = new Set(descriptor.capabilities.flatMap((rule) => rule.requires));
    for (const axis of axes) {
      const degraded = withAxis(descriptor, axis, "undocumented");
      expect(support(degraded, axis)).toBe("undocumented");
      const capabilities = capabilitiesFor(degraded, allObserved(degraded));
      for (const rule of degraded.capabilities.filter((item) => item.requires.includes(axis))) {
        const capability = capabilities.find((item) => item.name === rule.name)!;
        expect(capability.assurance, `${descriptor.host} ${rule.name} on ${axis}`).toBe(
          "unavailable",
        );
        checked++;
      }
    }
  }
  expect(checked).toBeGreaterThan(10);
});

test("enforced capabilities rest only on native axes; partial support degrades to agent_guided", () => {
  for (const descriptor of DESCRIPTORS) {
    const capabilities = capabilitiesFor(descriptor, allObserved(descriptor));
    for (const rule of descriptor.capabilities) {
      const capability = capabilities.find((item) => item.name === rule.name)!;
      if (capability.assurance !== "enforced") continue;
      expect(rule.requires.length, `${descriptor.host} ${rule.name}`).toBeGreaterThan(0);
      for (const axis of rule.requires) expect(support(descriptor, axis)).toBe("native");
      const axis = rule.requires[0];
      const partial = capabilitiesFor(
        withAxis(descriptor, axis, "partial"),
        allObserved(descriptor),
      );
      expect(partial.find((item) => item.name === rule.name)!.assurance).toBe("agent_guided");
    }
  }
});

test("runtime observations gate assurance: an unobserved hook claims nothing", () => {
  for (const descriptor of DESCRIPTORS)
    for (const capability of capabilitiesFor(descriptor)) {
      const rule = descriptor.capabilities.find((item) => item.name === capability.name)!;
      if ((rule.observed ?? []).length > 0) expect(capability.assurance).toBe("unavailable");
    }
});
