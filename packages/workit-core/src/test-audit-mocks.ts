type Node = { type: string; start: number; end: number; loc: Loc; [key: string]: any };
type Loc = { start: { line: number }; end: { line: number } };

/** A parsed test file: the shape `@babel/parser` returns, as `workit test-audit` passes it in. */
export type ParsedTest = { source: string; program: Node; comments: Node[] };

export const MOCK_RULES = {
  "mock-call-order":
    "Asserts the call count or call order of an internal collaborator: couples the test to the implementation",
  "private-access": "Reaches into private state or a test-only export of the code under test",
} as const;
export type MockRuleId = keyof typeof MOCK_RULES;

export type MockFinding = {
  rule: MockRuleId;
  severity: "medium" | "low";
  confidence: "high" | "medium" | "low";
  file: string;
  line: number;
  test: string | null;
  why: string;
  suggestion: string;
  snippet: string;
};

const ORDER_MATCHERS = new Set([
  "toHaveBeenNthCalledWith",
  "nthCalledWith",
  "toHaveBeenCalledBefore",
  "toHaveBeenCalledAfter",
  "calledBefore",
  "calledAfter",
  "calledImmediatelyBefore",
  "calledImmediatelyAfter",
]);
const COUNT_MATCHERS = new Set([
  "toHaveBeenCalledTimes",
  "toBeCalledTimes",
  "toHaveBeenCalledOnce",
  "toHaveBeenCalledExactlyOnceWith",
  "calledOnce",
  "calledTwice",
  "calledThrice",
]);
const MOCK_FACTORIES = /^(?:mock|jest\.fn|vi\.fn|sinon\.(?:spy|stub|fake)|spy|stub|fn)$/;
const SPY_CALLS = /^(?:spyOn|jest\.spyOn|vi\.spyOn|mock\.method|sinon\.(?:spy|stub|replace))$/;
const MODULE_MOCKS =
  /^(?:mock\.module|jest\.(?:mock|doMock|unstable_mockModule)|vi\.(?:mock|doMock)|td\.replace(?:Esm)?)$/;
const TEST_CALLEES = /^(?:test|it|specify)(?:\.(?:only|each|concurrent|serial|failing))?$/;
const TEST_ONLY_EXPORT = /^(?:_\w|\w*(?:ForTest(?:s|ing)?|TestOnly|_test|__test__|Internals?)$)/;
const PRIVATE_MEMBER = /^_{1,2}[A-Za-z]/;
const NOT_PRIVATE = new Set(["__proto__", "__esModule", "__dirname", "__filename"]);
const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function walk(root: Node, visit: (node: Node, ancestors: readonly Node[]) => void) {
  const stack: [Node, Node[]][] = [[root, []]];
  while (stack.length > 0) {
    const [node, ancestors] = stack.pop()!;
    visit(node, ancestors);
    const below = [...ancestors, node];
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value.toReversed()) if (isNode(item)) stack.push([item, below]);
      } else if (isNode(value)) stack.push([value, below]);
    }
  }
}

function dotted(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    const object = dotted(node.object);
    return object ? `${object}.${node.property.name}` : null;
  }
  return null;
}

function unwrap(node: Node | null | undefined): Node | null {
  let current = node ?? null;
  while (
    current &&
    [
      "AwaitExpression",
      "TSAsExpression",
      "TSNonNullExpression",
      "ParenthesizedExpression",
    ].includes(current.type)
  )
    current = current.type === "AwaitExpression" ? current.argument : current.expression;
  return current;
}

const internalSpecifier = (spec: string): boolean => /^(?:\.{1,2}\/|@\/|~\/|#|src\/)/.test(spec);

const literal = (node: Node | undefined): string | null =>
  node?.type === "StringLiteral" ? node.value : null;

type Doubles = {
  internalImports: Map<string, string>;
  internalMocks: Set<string>;
  mocks: Set<string>;
};

function collectDoubles(program: Node): Doubles {
  const internalImports = new Map<string, string>();
  const mockedModules = new Set<string>();
  const internalMocks = new Set<string>();
  const mocks = new Set<string>();
  for (const statement of program.body as Node[])
    if (statement.type === "ImportDeclaration" && internalSpecifier(statement.source.value))
      for (const spec of statement.specifiers as Node[])
        internalImports.set(spec.local.name, statement.source.value);
  walk(program, (node) => {
    if (node.type !== "CallExpression") return;
    const name = dotted(node.callee);
    const spec = literal(node.arguments[0]);
    if (name && MODULE_MOCKS.test(name) && spec && internalSpecifier(spec)) mockedModules.add(spec);
  });
  for (const [local, spec] of internalImports)
    if (mockedModules.has(spec)) {
      internalMocks.add(local);
      mocks.add(local);
    }
  walk(program, (node) => {
    const call = node.type === "VariableDeclarator" ? unwrap(node.init) : node;
    if (call?.type !== "CallExpression") return;
    const name = dotted(call.callee);
    if (!name) return;
    const bound =
      node.type === "VariableDeclarator" && node.id.type === "Identifier" ? node.id.name : null;
    if (SPY_CALLS.test(name)) {
      const target = dotted(call.arguments[0]);
      const method = literal(call.arguments[1]);
      const internal = !!target && internalImports.has(target.split(".")[0]);
      for (const key of [bound, target && method ? `${target}.${method}` : null])
        if (key) {
          mocks.add(key);
          if (internal) internalMocks.add(key);
        }
    } else if (bound && MOCK_FACTORIES.test(name)) mocks.add(bound);
  });
  return { internalImports, internalMocks, mocks };
}

function subject(node: Node | null): string | null {
  const target = unwrap(node);
  if (!target) return null;
  const name = dotted(target);
  if (name)
    return name.replace(/\.(?:mock\.(?:calls|invocationCallOrder)|callCount|args)(?:\..*)?$/, "");
  if (target.type === "MemberExpression") return subject(target.object);
  return null;
}

function expectation(node: Node): { actual: Node | null; matcher: string } | null {
  if (node.type !== "CallExpression" || node.callee.type !== "MemberExpression") return null;
  if (node.callee.property.type !== "Identifier") return null;
  const matcher = node.callee.property.name;
  let current: Node = node.callee.object;
  while (current.type === "MemberExpression") current = current.object;
  if (current.type !== "CallExpression" || dotted(current.callee) !== "expect") return null;
  return { actual: current.arguments[0] ?? null, matcher };
}

function enclosingTest(ancestors: readonly Node[]): string | null {
  for (const node of ancestors.toReversed()) {
    if (node.type !== "CallExpression") continue;
    const callee = node.callee.type === "CallExpression" ? node.callee.callee : node.callee;
    const name = dotted(callee);
    if (name && TEST_CALLEES.test(name)) return literal(node.arguments[0]) ?? "<anonymous>";
  }
  return null;
}

function mutedLines(comments: Node[]): Map<number, Set<string> | null> {
  const lines = new Map<number, Set<string> | null>();
  for (const comment of comments) {
    const match = /workit-test-audit-ignore(?:\s+([\w\s,-]+?))?(?:\s+--|$)/.exec(comment.value);
    if (!match) continue;
    const rules = match[1]
      ? new Set(match[1].split(/[\s,]+/).filter((rule) => rule in MOCK_RULES))
      : null;
    const set = rules && rules.size > 0 ? rules : null;
    lines.set(comment.loc.start.line, set);
    lines.set(comment.loc.end.line + 1, set);
  }
  return lines;
}

/**
 * The `mock-call-order` and `private-access` findings of one parsed test
 * file. Call order on any double, and call counts on a double that replaces
 * the code under test's own module, couple a test to how the code works
 * rather than what it returns.
 */
export function auditMockUse(parsed: ParsedTest, file: string): MockFinding[] {
  const doubles = collectDoubles(parsed.program);
  const muted = mutedLines(parsed.comments);
  const findings: MockFinding[] = [];
  const snippet = (node: Node) =>
    parsed.source.slice(node.start, node.end).replace(/\s+/g, " ").slice(0, 120);
  const push = (finding: Omit<MockFinding, "file">) => {
    const mute = muted.has(finding.line) ? muted.get(finding.line) : undefined;
    if (mute === null || mute?.has(finding.rule)) return;
    findings.push({ file, ...finding });
  };

  walk(parsed.program, (node, ancestors) => {
    const assertion = expectation(node);
    const sinonAssert =
      node.type === "CallExpression"
        ? /^sinon\.assert\.(callOrder|callCount)$/.exec(dotted(node.callee) ?? "")
        : null;
    let kind: "order" | "count" | null = null;
    let target: string | null = null;
    if (assertion) {
      let actual = unwrap(assertion.actual);
      while (actual?.type === "MemberExpression" && actual.computed) actual = actual.object;
      const source = dotted(actual) ?? "";
      if (ORDER_MATCHERS.has(assertion.matcher) || source.includes(".mock.invocationCallOrder"))
        kind = "order";
      else if (
        COUNT_MATCHERS.has(assertion.matcher) ||
        /\.(?:mock\.calls\.length|callCount)$/.test(source)
      )
        kind = "count";
      target = subject(assertion.actual);
    } else if (sinonAssert) {
      kind = sinonAssert[1] === "callOrder" ? "order" : "count";
      target = subject(node.arguments[0]);
    }
    if (kind && target) {
      const internal = doubles.internalMocks.has(target);
      if (internal || (kind === "order" && doubles.mocks.has(target)))
        push({
          rule: "mock-call-order",
          severity: internal ? "medium" : "low",
          confidence: internal ? "high" : "medium",
          line: node.loc.start.line,
          test: enclosingTest(ancestors),
          why: internal
            ? `Asserts the call ${kind} of ${target}, a double of the code under test's own module: a refactor that keeps the behavior breaks it.`
            : `Asserts the order in which ${target} was called: the order between collaborators is an implementation detail unless a caller depends on it.`,
          suggestion:
            "Assert the observable result (return value, written state, the message a boundary received) instead; keep a call count only for a boundary contract such as retries or idempotency.",
          snippet: snippet(node),
        });
    }

    if (node.type === "MemberExpression" && node.object.type !== "ThisExpression") {
      const name =
        !node.computed && node.property.type === "Identifier"
          ? node.property.name
          : literal(node.property);
      if (name && PRIVATE_MEMBER.test(name) && !NOT_PRIVATE.has(name))
        push({
          rule: "private-access",
          severity: "low",
          confidence: "medium",
          line: node.loc.start.line,
          test: enclosingTest(ancestors),
          why: `Reads ${name}, a private member: the test breaks when the internals are renamed, though the behavior is unchanged.`,
          suggestion:
            "Drive the behavior through the public API and assert what a caller observes.",
          snippet: snippet(node),
        });
    }
  });

  for (const statement of parsed.program.body as Node[]) {
    if (statement.type !== "ImportDeclaration" || !internalSpecifier(statement.source.value))
      continue;
    for (const spec of statement.specifiers as Node[]) {
      const imported = spec.imported?.name ?? spec.imported?.value ?? null;
      if (imported && TEST_ONLY_EXPORT.test(imported))
        push({
          rule: "private-access",
          severity: "low",
          confidence: "medium",
          line: spec.loc.start.line,
          test: null,
          why: `Imports ${imported}, a test-only or internal export: the test pins internals the public API does not promise.`,
          suggestion:
            "Test through the public export, or move the logic into its own module with a real public API.",
          snippet: snippet(statement),
        });
    }
  }
  return findings.toSorted((a, b) => a.line - b.line);
}
