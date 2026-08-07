import { expect, test } from "bun:test";
import { detectProseChoices } from "../src/core/detector";

test("detects alpha choices with interrogative", () => {
  const d = detectProseChoices("A) install agent-browser\nB) configure lazy chrome\nC) both\nWhich one?");
  expect(d).not.toBeNull();
  if (d) {
    expect(d.pattern).toBe("alpha");
    expect(d.choices.length).toBe(3);
  }
});

test("detects numeric choices", () => {
  const d = detectProseChoices("1. Install\n2. Configure\n3. Both\nChoose one.");
  expect(d).not.toBeNull();
  if (d) expect(d.pattern).toBe("numeric");
});

test("detects the exact failure wrapper style", () => {
  const d = detectProseChoices("¿Quieres que:\n1. instale agent-browser\n2. configure lazy\n3. ambas?");
  expect(d).not.toBeNull();
  if (d) expect(d.pattern).toBe("numeric");
});

test("does not match a plain list without interrogative", () => {
  expect(detectProseChoices("Three considerations: a, b, c.")).toBeNull();
});

test("does not match a single option", () => {
  expect(detectProseChoices("Option A is best.")).toBeNull();
});

test("does not match non-consecutive prefixes", () => {
  expect(detectProseChoices("A) first\nD) fourth\nChoose?")).toBeNull();
});

test("does not match an ordinary sentence with numbers", () => {
  expect(detectProseChoices("We shipped 3 fixes today.")).toBeNull();
});
