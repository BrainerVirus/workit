// Static rules for `workit test-audit`. Each rule reads one parsed test file
// and reports low-value tests: assertions that pass by construction or do not
// depend on the code under test. Findings are advice for a human or agent to
// triage (remove, or replace with a behavioral test against an independent
// oracle); nothing here edits a file.
import { builtinModules } from "node:module";
import path from "node:path";
import {
  calleeName,
  find,
  isFunction,
  isLiteralValue,
  lineOf,
  normalized,
  rootIdentifier,
  textOf,
  unwrap,
  walk,
  type Node,
  type Parsed,
} from "./ast";

export const RULES = {
  tautology:
    "Expected value is computed the way the code computes it, so it passes by construction",
  "mock-echo": "Asserts the value a mock was configured to return",
  "snapshot-of-constant": "Snapshots a literal or imported constant",
  "assertion-free": "Test body makes no assertion",
  "prose-contains": "Asserts a long prose fragment with toContain/toMatch",
  "byte-copy": "Compares two file reads: tests a copy step, not behavior",
  "duplicate-body": "Test body is identical to another test",
  "constants-only": "Test file imports only constants from the code under test",
  "always-true": "Actual value is a literal: the assertion never depends on the code",
  "over-mocking": "Mocks the unit under test or many internal modules",
} as const;

export type RuleId = keyof typeof RULES;
export type Level = "high" | "medium" | "low";

export type Finding = {
  rule: RuleId;
  severity: Level;
  confidence: Level;
  file: string;
  line: number;
  test: string | null;
  why: string;
  suggestion: string;
  snippet: string;
};

export type TestCase = { name: string; line: number; call: Node; fn: Node };

type Assertion = {
  node: Node;
  matcher: string;
  actual: Node | null;
  expected: Node | null;
  /** `.not` in the chain: the assertion claims a difference. */
  negated?: boolean;
};

const TEST_CALLEES = new Set(["test", "it", "specify", "Deno.test"]);
const EQUALITY = new Set([
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toMatchObject",
  "toBeCloseTo",
  "equal",
  "equals",
  "eql",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
  "same",
]);
const SNAPSHOT = new Set(["toMatchSnapshot", "toMatchInlineSnapshot", "toMatchFileSnapshot"]);
const CHAI_WORDS = new Set(["to", "be", "been", "is", "that", "which", "and", "has", "have"]);
const CHAI_WORDS_2 = new Set(["with", "at", "of", "same", "deep", "not", "resolves", "rejects"]);
const ASSERT_LIKE = /expect|assert|should|^(?:check|verify|ensure|must)/i;

const FRAMEWORK =
  /^(?:bun:test|vitest|@jest\/globals|node:test|node:assert(?:\/strict)?|assert|chai|@testing-library\/.*)$/;
const NON_UNIT = /(?:^|\/)(?:test|tests|__tests__|helpers?|fixtures?|support|mocks?)(?:\/|$)/;
const BUILTINS = new Set(builtinModules);

/** An import from the code under test, not a framework, builtin or test helper. */
const isUnitSpecifier = (spec: string): boolean =>
  !FRAMEWORK.test(spec) &&
  !spec.startsWith("node:") &&
  !spec.startsWith("bun:") &&
  !BUILTINS.has(spec) &&
  !NON_UNIT.test(spec);

/** Root identifier of a test call: `test`, `it.only`, `test.each([...])`. */
function testCallee(call: Node): boolean {
  let callee: Node = call.callee;
  if (callee.type === "CallExpression") callee = callee.callee; // test.each(table)(name, fn)
  const name = calleeName(callee);
  if (!name) return false;
  const [head, ...rest] = name.split(".");
  if (rest.includes("todo")) return false;
  return TEST_CALLEES.has(name) || TEST_CALLEES.has(head);
}

const testName = (source: string, node: Node | undefined): string => {
  if (!node) return "<anonymous>";
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral") return textOf(source, node).slice(1, -1);
  return textOf(source, node);
};

function collectTests(parsed: Parsed): TestCase[] {
  const tests: TestCase[] = [];
  walk(parsed.program, (node) => {
    if (node.type !== "CallExpression" || !testCallee(node)) return;
    const fn = node.arguments.findLast((arg: Node) => isFunction(arg));
    if (!fn) return;
    tests.push({
      name: testName(parsed.source, node.arguments[0]),
      line: lineOf(node),
      call: node,
      fn,
    });
    return false; // nested test() inside a test is unusual; keep the outer one
  });
  return tests;
}

function assertionOf(node: Node): Assertion | null {
  if (node.type !== "CallExpression") return null;
  const callee = node.callee;
  // assert(x), assert.equal(a, b), t.assert.equal(a, b), t.equal(a, b)
  const name = calleeName(callee);
  if (name === "assert" || name === "assert.ok" || name?.endsWith(".assert.ok"))
    return { node, matcher: "ok", actual: node.arguments[0] ?? null, expected: null };
  if (name && /(?:^|\.)assert\.\w+$/.test(name))
    return {
      node,
      matcher: name.slice(name.lastIndexOf(".") + 1),
      actual: node.arguments[0] ?? null,
      expected: node.arguments[1] ?? null,
    };
  if (callee.type !== "MemberExpression" || callee.computed) return null;
  const matcher = callee.property.name as string;
  let object: Node = callee.object;
  let negated = false;
  while (
    object.type === "MemberExpression" &&
    !object.computed &&
    (CHAI_WORDS.has(object.property.name) || CHAI_WORDS_2.has(object.property.name))
  ) {
    if (object.property.name === "not") negated = !negated;
    object = object.object;
  }
  if (object.type !== "CallExpression") return null;
  const root = calleeName(object.callee);
  if (root !== "expect" && root !== "expect.soft" && root !== "chai.expect") return null;
  return {
    node,
    matcher,
    actual: object.arguments[0] ?? null,
    expected: node.arguments[0] ?? null,
    negated,
  };
}

const isEquality = (assertion: Assertion): boolean =>
  EQUALITY.has(assertion.matcher) && !assertion.negated;

// Each rule scans the same test bodies; parse their assertions once.
const assertionCache = new WeakMap<Node, Assertion[]>();
const assertionsIn = (root: Node): Assertion[] => {
  let cached = assertionCache.get(root);
  if (!cached) {
    cached = find(root, (node) => node.type === "CallExpression")
      .map(assertionOf)
      .filter((entry): entry is Assertion => entry !== null);
    assertionCache.set(root, cached);
  }
  return cached;
};

/** `const name = init` bindings in a scope (shadowing ignored on purpose). */
function constBindings(root: Node): Map<string, Node> {
  const bindings = new Map<string, Node>();
  walk(root, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init)
      bindings.set(node.id.name, node.init);
  });
  return bindings;
}

const resolve = (node: Node | null, bindings: Map<string, Node>): Node | null => {
  const value = unwrap(node);
  if (value?.type === "Identifier" && bindings.has(value.name))
    return unwrap(bindings.get(value.name));
  return value;
};

const callsIn = (node: Node): Node[] =>
  find(node, (child) => child.type === "CallExpression" || child.type === "NewExpression");

const identifiersIn = (node: Node): Set<string> =>
  new Set(find(node, (child) => child.type === "Identifier").map((child) => child.name as string));

const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "**"]);

/**
 * The expected value is itself a computation over the unit's inputs:
 * `add(a, b)` expected as `a + b`, `total(items)` as `items.reduce(...)`.
 * Only the top-level expression counts; building an expected object from
 * inputs (`path.join(dir, "x")` inside a literal) is a spec-level fact.
 */
function rederives(expected: Node, inputs: Set<string>, literalArgs: string[], source: string) {
  const node = unwrap(expected);
  if (!node) return false;
  const usesInputs = (child: Node) => [...identifiersIn(child)].some((name) => inputs.has(name));
  if (node.type === "BinaryExpression" && ARITHMETIC.has(node.operator)) {
    if (usesInputs(node)) return true;
    // add(2, 3) expected as 2 + 3: the same literals combined again.
    const leaves = new Set(
      find(node, (child) => child.type === "NumericLiteral").map((child) =>
        normalized(source, child),
      ),
    );
    return literalArgs.length > 1 && literalArgs.every((arg) => leaves.has(arg));
  }
  if (node.type === "TemplateLiteral")
    return (node.expressions as Node[]).some((child) => usesInputs(child));
  if (
    (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
    (node.callee.type === "MemberExpression" || node.callee.type === "OptionalMemberExpression")
  )
    return inputs.has(rootIdentifier(node.callee) ?? "");
  return false;
}

type Context = {
  parsed: Parsed;
  file: string;
  fileBindings: Map<string, Node>;
  imports: Map<string, string>; // local name -> module specifier
  /** Module specifier when `name` is imported from the code under test. */
  unitModule: (name: string | null) => string | null;
  mocks: Map<string, Node[]>; // file-level mock name -> configured returns
};

type Emit = (finding: Omit<Finding, "file" | "line" | "snippet">, node: Node) => void;

const snippetOf = (source: string, node: Node): string => {
  const text = textOf(source, node).replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
};

const ORACLE =
  "Use an independent oracle: a known-good literal from a worked example, the spec or an external contract. Name the Break: which wrong implementation must make this fail?";

const EFFECTFUL = new Set([
  "CallExpression",
  "NewExpression",
  "AwaitExpression",
  "YieldExpression",
  "UpdateExpression",
  "AssignmentExpression",
]);

function checkTautology(ctx: Context, test: TestCase, bindings: Map<string, Node>, emit: Emit) {
  const { source } = ctx.parsed;
  for (const assertion of assertionsIn(test.fn)) {
    if (!isEquality(assertion) || !assertion.actual || !assertion.expected) continue;
    const rawActual = unwrap(assertion.actual)!;
    const rawExpected = unwrap(assertion.expected)!;
    // A literal expected value is the independent oracle; literal arithmetic
    // (add(2, 3) expected as 2 + 3) is still checked below.
    const literalSum = rawExpected.type === "BinaryExpression";
    if (isLiteralValue(rawActual) || (isLiteralValue(rawExpected) && !literalSum)) continue;
    const base = { rule: "tautology" as const, test: test.name };
    // expect(x).toBe(x). Calls are left alone: f() === f() checks determinism
    // and a value read before an action checks that the action changed nothing.
    if (
      normalized(source, rawActual) === normalized(source, rawExpected) &&
      find(rawActual, (node) => EFFECTFUL.has(node.type)).length === 0
    ) {
      emit(
        {
          ...base,
          severity: "high",
          confidence: "high",
          why: `Actual and expected are the same expression (\`${snippetOf(source, rawActual)}\`): the value is asserted equal to itself.`,
          suggestion: ORACLE,
        },
        assertion.node,
      );
      continue;
    }
    const actual = resolve(assertion.actual, bindings);
    const expected = resolve(assertion.expected, bindings);
    if (!actual || !expected || (isLiteralValue(expected) && !literalSum)) continue;
    const unit = callsIn(actual).find(
      (call) => call.type === "CallExpression" && ctx.unitModule(rootIdentifier(call.callee)),
    );
    if (!unit) continue;
    const module = ctx.unitModule(rootIdentifier(unit.callee))!;
    const sameAsActual = (node: Node) =>
      normalized(source, node) === normalized(source, actual) ||
      normalized(source, node) === normalized(source, rawActual);
    // Same function with other arguments is a metamorphic check (order
    // invariance, idempotence), not a tautology.
    // Only an expectation computed inline, or bound to an `expected…`
    // variable, counts: a value produced by an earlier step (`held =
    // lock.acquire()`) and checked after another is an interaction test.
    const unitName = calleeName(unit.callee);
    const inline =
      rawExpected.type !== "Identifier" || /^(?:expected|want|oracle)/i.test(rawExpected.name);
    const oracleCall =
      !inline || sameAsActual(expected)
        ? undefined
        : callsIn(expected).find(
            (call) =>
              call.type === "CallExpression" &&
              calleeName(call.callee) !== unitName &&
              ctx.unitModule(rootIdentifier(call.callee)) === module,
          );
    if (oracleCall) {
      emit(
        {
          ...base,
          severity: "high",
          confidence: "medium",
          why: `Expected value is computed by \`${snippetOf(source, oracleCall)}\` from the module under test (${module}): the code checks itself, so a shared bug passes.`,
          suggestion: ORACLE,
        },
        assertion.node,
      );
      continue;
    }
    const inputs = new Set<string>();
    const literalArgs: string[] = [];
    for (const arg of unit.arguments as Node[]) {
      if (isFunction(arg)) continue;
      for (const name of identifiersIn(arg)) inputs.add(name);
      if (arg.type === "NumericLiteral") literalArgs.push(normalized(source, arg));
    }
    if (rederives(expected, inputs, literalArgs, source))
      emit(
        {
          ...base,
          severity: "high",
          confidence: "medium",
          why: `Expected value \`${snippetOf(source, expected)}\` re-derives the result from the inputs passed to \`${calleeName(unit.callee) ?? "the unit"}\`: it restates the implementation, so it passes by construction.`,
          suggestion: `Replace the computed expectation with a literal worked out by hand or from the spec (e.g. \`expect(${snippetOf(source, rawActual)}).toBe(<literal>)\`). Name the Break: which wrong implementation must make this fail?`,
        },
        assertion.node,
      );
  }
}

const MOCK_FACTORY = /^(?:vi|jest)\.fn$|^mock$|^mock\.fn$|^jest\.fn$/;
const SPY_FACTORY = /^(?:vi\.|jest\.)?spyOn$|^mock\.method$/;
const MOCK_RETURN = /^mock(?:Resolved|Rejected)?(?:Return)?Value(?:Once)?$/;

/** The value an implementation function returns, if it is a single expression. */
function returnedBy(fn: Node | undefined): Node | null {
  if (!fn || !isFunction(fn)) return null;
  if (fn.body.type !== "BlockStatement") return fn.body;
  const statements = fn.body.body as Node[];
  const last = statements.at(-1);
  return statements.length === 1 && last?.type === "ReturnStatement" ? last.argument : null;
}

/** Mock name (or `obj.method` for spies) -> configured return values. */
function collectMocks(root: Node, into: Map<string, Node[]> = new Map()): Map<string, Node[]> {
  // Walk a chain `factory(impl).mockReturnValue(x)` from the outer call in.
  const configure = (declared: string | null, init: Node) => {
    const values: (Node | null)[] = [];
    const names: string[] = [];
    let node: Node | null = unwrap(init);
    while (node?.type === "CallExpression") {
      const callee: Node = node.callee;
      const method =
        callee.type === "MemberExpression" && !callee.computed ? callee.property.name : null;
      if (method && MOCK_RETURN.test(method)) values.push(node.arguments[0] ?? null);
      else if (method === "mockImplementation" || method === "mockImplementationOnce")
        values.push(returnedBy(node.arguments[0]));
      else {
        const name = calleeName(callee) ?? "";
        if (MOCK_FACTORY.test(name)) {
          values.push(returnedBy(node.arguments[0]));
          if (declared) names.push(declared);
          break;
        }
        if (SPY_FACTORY.test(name)) {
          const target = calleeName(node.arguments[0]);
          const key = node.arguments[1];
          if (target && key?.type === "StringLiteral") names.push(`${target}.${key.value}`);
          if (declared) names.push(declared);
          values.push(returnedBy(node.arguments[2]));
          break;
        }
      }
      if (callee.type !== "MemberExpression") break;
      const object: Node = callee.object;
      if (object.type === "Identifier" && into.has(object.name)) {
        names.push(object.name);
        break;
      }
      node = object;
    }
    for (const name of names) {
      const list = into.get(name) ?? [];
      for (const value of values) if (value) list.push(value);
      into.set(name, list);
    }
  };
  walk(root, (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init)
      configure(node.id.name, node.init);
    else if (node.type === "ExpressionStatement" && node.expression.type === "CallExpression")
      configure(null, node.expression);
  });
  return into;
}

function checkMockEcho(ctx: Context, test: TestCase, bindings: Map<string, Node>, emit: Emit) {
  const { source } = ctx.parsed;
  const mocks = collectMocks(test.fn, new Map(ctx.mocks));
  if (mocks.size === 0) return;
  for (const assertion of assertionsIn(test.fn)) {
    if (!isEquality(assertion) || !assertion.actual || !assertion.expected) continue;
    const actual = resolve(assertion.actual, bindings);
    const expectedText = normalized(source, unwrap(assertion.expected)!);
    const expectedResolved = normalized(source, resolve(assertion.expected, bindings)!);
    if (actual?.type === "CallExpression") {
      const callee = calleeName(actual.callee);
      if (callee && mocks.has(callee)) {
        emit(
          {
            rule: "mock-echo",
            test: test.name,
            severity: "high",
            confidence: "high",
            why: `Calls the mock \`${callee}\` directly and asserts its result: the code under test never runs.`,
            suggestion:
              "Call the real unit with the mock injected at the boundary, and assert the unit's own observable output.",
          },
          assertion.node,
        );
        continue;
      }
    }
    for (const [name, values] of mocks) {
      const echoed = values.find((value) => {
        if (isLiteralValue(value) && value.type !== "ObjectExpression") return false;
        const text = normalized(source, value);
        return text === expectedText || text === expectedResolved;
      });
      if (!echoed) continue;
      emit(
        {
          rule: "mock-echo",
          test: test.name,
          severity: "medium",
          confidence: "medium",
          why: `Expected value \`${snippetOf(source, echoed)}\` is exactly what mock \`${name}\` returns: the test proves pass-through at most.`,
          suggestion:
            "Assert what the unit adds (a transformation, a decision, a side effect), with an expected value written independently of the mock setup.",
        },
        assertion.node,
      );
      break;
    }
  }
}

const isConstantRef = (node: Node | null, ctx: Context, bindings: Map<string, Node>): boolean => {
  const value = unwrap(node);
  if (!value) return false;
  if (isLiteralValue(value)) return true;
  if (value.type === "Identifier") {
    if (ctx.imports.has(value.name)) return /^[A-Z][A-Z0-9_]*$/.test(value.name);
    const bound = bindings.get(value.name);
    return bound ? isLiteralValue(bound) : false;
  }
  if (value.type === "MemberExpression") return isConstantRef(value.object, ctx, bindings);
  return false;
};

function checkSnapshots(ctx: Context, test: TestCase, bindings: Map<string, Node>, emit: Emit) {
  for (const assertion of assertionsIn(test.fn)) {
    if (!SNAPSHOT.has(assertion.matcher) || !isConstantRef(assertion.actual, ctx, bindings))
      continue;
    emit(
      {
        rule: "snapshot-of-constant",
        test: test.name,
        severity: "medium",
        confidence: "high",
        why: "The snapshot records a literal or an imported constant: it only re-states the constant and changes whenever the constant does.",
        suggestion:
          "Snapshot the output of the code that consumes the constant, or delete the test if the constant has no behavior of its own.",
      },
      assertion.node,
    );
  }
}

function checkAlwaysTrue(ctx: Context, test: TestCase, emit: Emit) {
  for (const assertion of assertionsIn(test.fn)) {
    if (SNAPSHOT.has(assertion.matcher) || !isLiteralValue(assertion.actual)) continue;
    // expect("x").toBe(subject) style inversions still exercise the code.
    if (assertion.expected && !isLiteralValue(assertion.expected)) continue;
    emit(
      {
        rule: "always-true",
        test: test.name,
        severity: "high",
        confidence: "high",
        why: `The actual value \`${snippetOf(ctx.parsed.source, assertion.actual!)}\` is a literal, so the outcome is fixed when the test is written.`,
        suggestion: "Assert on a value produced by the code under test, or delete the assertion.",
      },
      assertion.node,
    );
  }
}

/** Local functions whose bodies assert count as assertion helpers. */
function assertingHelpers(program: Node): Set<string> {
  const helpers = new Set<string>();
  walk(program, (node) => {
    let name: string | null = null;
    let fn: Node | null = null;
    if (node.type === "FunctionDeclaration" && node.id) [name, fn] = [node.id.name, node];
    else if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      isFunction(node.init)
    )
      [name, fn] = [node.id.name, node.init];
    if (!name || !fn) return;
    if (find(fn, (child) => assertionOf(child) !== null).length > 0) helpers.add(name);
    return false; // searched once; nested helpers inside helpers are rare
  });
  return helpers;
}

function checkAssertionFree(ctx: Context, test: TestCase, helpers: Set<string>, emit: Emit) {
  const calls = find(test.fn.body, (node) => node.type === "CallExpression");
  const asserts = calls.some((call) => {
    if (assertionOf(call)) return true;
    const name = calleeName(call.callee) ?? "";
    const last = name.slice(name.lastIndexOf(".") + 1);
    return ASSERT_LIKE.test(last) || ASSERT_LIKE.test(name.split(".")[0]) || helpers.has(name);
  });
  if (asserts) return;
  // A call to an imported helper may assert inside; say so through confidence.
  const opaque = calls.some((call) => ctx.imports.has(rootIdentifier(call.callee) ?? ""));
  emit(
    {
      rule: "assertion-free",
      test: test.name,
      severity: "medium",
      confidence: opaque ? "medium" : "high",
      why: "The test makes no assertion: it passes as long as nothing throws.",
      suggestion:
        "Assert the observable result (return value, output, state change) against an expected value, or delete the test.",
    },
    test.call,
  );
}

const PROSE_MATCHERS = new Set([
  "toContain",
  "toMatch",
  "toInclude",
  "include",
  "contain",
  "match",
]);

function proseOf(node: Node | null): string | null {
  const value = unwrap(node);
  if (!value) return null;
  if (value.type === "StringLiteral") return value.value;
  if (value.type === "TemplateLiteral" && value.expressions.length === 0)
    return value.quasis.map((quasi: Node) => quasi.value.cooked).join("");
  if (value.type === "RegExpLiteral") return value.pattern.replace(/\\s[+*]?/g, " ");
  return null;
}

function checkProse(ctx: Context, test: TestCase, emit: Emit) {
  for (const assertion of assertionsIn(test.fn)) {
    if (!PROSE_MATCHERS.has(assertion.matcher)) continue;
    const prose = proseOf(assertion.expected);
    if (!prose || prose.length < 40 || prose.trim().split(/\s+/).length < 6) continue;
    const docs = /\.md\b|SKILL|README|readme|skillText|docs?\b/.test(
      textOf(ctx.parsed.source, assertion.actual ?? assertion.node),
    );
    emit(
      {
        rule: "prose-contains",
        test: test.name,
        severity: "low",
        confidence: docs ? "high" : "medium",
        why: `Asserts a ${prose.length}-character prose fragment${docs ? " of documentation" : ""}: a wording edit fails it without any behavior change.`,
        suggestion:
          "Assert the behavior the text drives (a parsed field, an exit code, a routed decision), or a short stable token; drop doc-wording checks.",
      },
      assertion.node,
    );
  }
}

const READER = /^read|^(?:file|text|bytes|arrayBuffer)$|(?:Text|Bytes|Contents?)$/;
const RUNS_CODE =
  /^(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|main|run)$|^Bun\.spawn/;

/** The first call on this side that reads file contents or a digest of them. */
const readCall = (node: Node): Node | undefined =>
  callsIn(node).find((call) => {
    if (call.type !== "CallExpression") return false;
    const callee: Node = call.callee;
    const name =
      callee.type === "Identifier"
        ? callee.name
        : callee.type === "MemberExpression" && !callee.computed
          ? callee.property.name
          : "";
    return READER.test(name);
  });

function checkByteCopy(ctx: Context, test: TestCase, bindings: Map<string, Node>, emit: Emit) {
  const { source } = ctx.parsed;
  // A copy made by code the test runs (an installer, a backup) is behavior.
  const runsUnit = callsIn(test.fn.body).some(
    (call) =>
      !readCall(call) &&
      (ctx.unitModule(rootIdentifier(call.callee)) !== null ||
        RUNS_CODE.test(calleeName(call.callee) ?? "")),
  );
  if (runsUnit) return;
  for (const assertion of assertionsIn(test.fn)) {
    if (!isEquality(assertion) || !assertion.actual || !assertion.expected) continue;
    const actual = resolve(assertion.actual, bindings);
    const expected = resolve(assertion.expected, bindings);
    if (!actual || !expected) continue;
    const left = readCall(actual);
    const right = readCall(expected);
    // The same read before and after an action checks that nothing changed.
    if (!left || !right || normalized(source, left) === normalized(source, right)) continue;
    const args = (call: Node) =>
      (call.arguments as Node[]).map((arg) => normalized(source, arg)).join(",");
    if (args(left) === args(right)) continue;
    emit(
      {
        rule: "byte-copy",
        test: test.name,
        severity: "medium",
        confidence: "medium",
        why: `Compares the contents of two different sources (\`${snippetOf(source, left)}\` vs \`${snippetOf(source, right)}\`): it proves a copy is identical, which tests a copy step rather than behavior.`,
        suggestion:
          "Generate the copy from one source at build time and delete this test, or assert the behavior of the consumer that reads the copy.",
      },
      assertion.node,
    );
  }
}

function checkConstantsOnly(ctx: Context, emit: Emit) {
  const { program, source } = ctx.parsed;
  const unitImports = (program.body as Node[]).filter(
    (node) =>
      node.type === "ImportDeclaration" &&
      node.importKind !== "type" &&
      isUnitSpecifier(node.source.value),
  );
  if (unitImports.length === 0) return;
  const names = unitImports.flatMap((node) =>
    (node.specifiers as Node[]).filter((spec) => spec.importKind !== "type"),
  );
  if (names.length === 0) return;
  const constantsOnly = names.every(
    (spec) => spec.type === "ImportSpecifier" && /^[A-Z][A-Z0-9_]*$/.test(spec.local.name),
  );
  // A test that spawns a process or calls fetch exercises behavior anyway.
  if (!constantsOnly || /\bspawn|\bexec|\bfetch\(|Bun\.spawn/.test(source)) return;
  emit(
    {
      rule: "constants-only",
      test: null,
      severity: "medium",
      confidence: "medium",
      why: `Imports only constants (${names.map((spec) => spec.local.name).join(", ")}) from the code under test: no behavior is exercised.`,
      suggestion:
        "Test the code that consumes these constants through its public interface, or delete the file if it only restates them.",
    },
    unitImports[0],
  );
}

const MODULE_MOCK = /^(?:vi|jest)\.(?:mock|doMock)$|^mock\.module$/;

function checkOverMocking(ctx: Context, emit: Emit) {
  const { program } = ctx.parsed;
  const unit = path
    .basename(ctx.file)
    .replace(/\.(?:[cm]?[jt]sx?)$/, "")
    .replace(/\.(?:test|spec)$/, "");
  const mocked = find(
    program,
    (node) =>
      node.type === "CallExpression" &&
      MODULE_MOCK.test(calleeName(node.callee) ?? "") &&
      node.arguments[0]?.type === "StringLiteral",
  );
  const internal = mocked.filter((call) => /^(?:\.|@\/|~\/)/.test(call.arguments[0].value));
  for (const call of mocked) {
    const spec: string = call.arguments[0].value;
    const base = path
      .basename(spec.replace(/\/index(?:\.[cm]?[jt]sx?)?$/, ""))
      .replace(/\.(?:[cm]?[jt]sx?)$/, "");
    if (base === unit)
      emit(
        {
          rule: "over-mocking",
          test: null,
          severity: "high",
          confidence: "high",
          why: `Mocks \`${spec}\`, the module this file tests: assertions then check the mock, not the unit.`,
          suggestion:
            "Run the real unit and mock only its system boundaries (network, clock, randomness, process).",
        },
        call,
      );
  }
  if (internal.length >= 3)
    emit(
      {
        rule: "over-mocking",
        test: null,
        severity: "medium",
        confidence: "medium",
        why: `Mocks ${internal.length} internal modules: the test is coupled to the implementation's collaborators and breaks on refactors.`,
        suggestion:
          "Test at a higher seam with real collaborators; mock only at system boundaries.",
      },
      internal[0],
    );
}

/** Lines suppressed by `workit-test-audit-ignore [rule…]` comments. */
function suppressions(parsed: Parsed): {
  file: Set<string> | null;
  lines: Map<number, Set<string> | null>;
} {
  const lines = new Map<number, Set<string> | null>();
  let file: Set<string> | null = null;
  for (const comment of parsed.comments) {
    const match = /workit-test-audit-ignore(-file)?(?:\s+([\w\s,-]+))?/.exec(comment.value);
    if (!match) continue;
    const rules = match[2]
      ? new Set(match[2].split(/[\s,]+/).filter((rule) => rule in RULES))
      : null;
    const set = rules && rules.size > 0 ? rules : null;
    if (match[1]) file = set ?? new Set(Object.keys(RULES));
    else {
      lines.set(comment.loc.start.line, set);
      lines.set(comment.loc.end.line + 1, set);
    }
  }
  return { file, lines };
}

export type FileAudit = { findings: Finding[]; tests: TestCase[]; bodies: Map<string, TestCase> };

export function auditParsed(parsed: Parsed, file: string): Omit<FileAudit, "bodies"> {
  const findings: Finding[] = [];
  const muted = suppressions(parsed);
  const emit: Emit = (finding, node) => {
    const line = lineOf(node);
    if (muted.file?.has(finding.rule)) return;
    if (muted.lines.has(line)) {
      const rules = muted.lines.get(line);
      if (!rules || rules.has(finding.rule)) return;
    }
    findings.push({ ...finding, file, line, snippet: snippetOf(parsed.source, node) });
  };
  const imports = new Map<string, string>();
  for (const node of parsed.program.body as Node[])
    if (node.type === "ImportDeclaration")
      for (const spec of node.specifiers as Node[]) imports.set(spec.local.name, node.source.value);
  // Top-level bindings only; each test adds its own body's bindings.
  const fileBindings = new Map<string, Node>();
  for (const statement of parsed.program.body as Node[]) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration")
      for (const [name, init] of constBindings(declaration)) fileBindings.set(name, init);
  }
  const unitModule = (name: string | null) => {
    const spec = name ? imports.get(name) : undefined;
    return spec && isUnitSpecifier(spec) ? spec : null;
  };
  const ctx: Context = {
    parsed,
    file,
    fileBindings,
    imports,
    unitModule,
    mocks: collectMocks(parsed.program),
  };
  const tests = collectTests(parsed);
  const helpers = assertingHelpers(parsed.program);
  for (const test of tests) {
    const bindings = new Map([...fileBindings, ...constBindings(test.fn)]);
    checkTautology(ctx, test, bindings, emit);
    checkMockEcho(ctx, test, bindings, emit);
    checkSnapshots(ctx, test, bindings, emit);
    checkAlwaysTrue(ctx, test, emit);
    checkAssertionFree(ctx, test, helpers, emit);
    checkProse(ctx, test, emit);
    checkByteCopy(ctx, test, bindings, emit);
  }
  if (tests.length > 0) {
    checkConstantsOnly(ctx, emit);
    checkOverMocking(ctx, emit);
  }
  return { findings, tests };
}

/**
 * Duplicate-check key: the normalized body plus the modules its identifiers
 * come from, so equal bodies that exercise different imports stay distinct.
 */
export const bodyKey = (parsed: Parsed, test: TestCase): string | null => {
  const body = normalized(parsed.source, test.fn.body);
  if (body.length < 40) return null;
  const imports = new Map<string, string>();
  for (const node of parsed.program.body as Node[])
    if (node.type === "ImportDeclaration")
      for (const spec of node.specifiers as Node[]) imports.set(spec.local.name, node.source.value);
  const used = [...identifiersIn(test.fn.body)]
    .filter((name) => imports.has(name))
    .toSorted()
    .map((name) => `${name}=${imports.get(name)}`);
  return `${body}|${used.join(",")}`;
};
