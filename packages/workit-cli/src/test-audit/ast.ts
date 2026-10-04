// Parsing and AST helpers for `workit test-audit`. @babel/parser is pure JS
// (bundles into the Node CLI, no native binding) and reads TS, TSX and JSX
// with positions intact, so findings carry exact file:line.
import { parse } from "@babel/parser";

// Babel nodes are walked generically; a loose shape keeps the rules short.
export type Node = { type: string; start: number; end: number; loc: Loc; [key: string]: any };
type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };

export type Parsed = { source: string; program: Node; comments: Node[] };

const JSX_EXT = /\.(?:[jt]sx|[cm]?js)$/;

export function parseSource(source: string, file: string): Parsed {
  const plugins: ("typescript" | "jsx")[] = [];
  if (!/\.(?:[cm]?js|jsx)$/.test(file)) plugins.push("typescript");
  if (JSX_EXT.test(file)) plugins.push("jsx");
  const ast = parse(source, {
    sourceType: "module",
    errorRecovery: true,
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    plugins,
  });
  return {
    source,
    program: ast.program as unknown as Node,
    comments: (ast.comments ?? []) as unknown as Node[],
  };
}

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
  "superTypeParameters",
]);

// Type-only declarations hold no runtime behavior to audit or mutate.
const TYPE_ONLY = new Set([
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSDeclareFunction",
  "TSModuleDeclaration",
  "TSEnumDeclaration",
  "TSLiteralType",
]);

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

/** Depth-first walk; `visit` returning false skips the node's children. */
export function walk(root: Node, visit: (node: Node, parent: Node | null) => boolean | void) {
  const stack: [Node, Node | null][] = [[root, null]];
  while (stack.length > 0) {
    const [node, parent] = stack.pop()!;
    if (TYPE_ONLY.has(node.type)) continue;
    if (visit(node, parent) === false) continue;
    const children: [Node, Node | null][] = [];
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push([item, node]);
      } else if (isNode(value)) children.push([value, node]);
    }
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
}

export const find = (root: Node, match: (node: Node) => boolean): Node[] => {
  const out: Node[] = [];
  walk(root, (node) => void (match(node) && out.push(node)));
  return out;
};

export const textOf = (source: string, node: Node): string => source.slice(node.start, node.end);

/** Source text with whitespace and trailing commas removed, for comparisons. */
export const normalized = (source: string, node: Node): string =>
  textOf(source, node)
    .replace(/\s+/g, "")
    .replace(/,(?=[)\]}])/g, "");

/** `a.b.c` for identifier/member chains, null for anything computed. */
export function calleeName(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    const object = calleeName(node.object);
    return object ? `${object}.${node.property.name}` : null;
  }
  return null;
}

/** Leftmost identifier of a member/call chain (`items` in `items.map(f).length`). */
export function rootIdentifier(node: Node | null | undefined): string | null {
  let current = node;
  while (current) {
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression" || current.type === "OptionalMemberExpression")
      current = current.object;
    else if (current.type === "CallExpression" || current.type === "OptionalCallExpression")
      current = current.callee;
    else if (
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression"
    )
      current = current.expression;
    else return null;
  }
  return null;
}

/** Strip `await`, parentheses and TS casts. */
export function unwrap(node: Node | null | undefined): Node | null {
  let current = node ?? null;
  while (
    current &&
    (current.type === "AwaitExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "TSSatisfiesExpression")
  )
    current = current.type === "AwaitExpression" ? current.argument : current.expression;
  return current;
}

export const isFunction = (node: Node | null | undefined): boolean =>
  !!node &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration");

const LITERALS = new Set([
  "StringLiteral",
  "NumericLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "BigIntLiteral",
  "RegExpLiteral",
]);

/** A value fixed at authoring time: literals and literal-only structures. */
export function isLiteralValue(node: Node | null | undefined): boolean {
  const value = unwrap(node);
  if (!value) return false;
  if (LITERALS.has(value.type)) return true;
  if (value.type === "Identifier") return value.name === "undefined";
  if (value.type === "TemplateLiteral") return value.expressions.length === 0;
  if (value.type === "UnaryExpression") return isLiteralValue(value.argument);
  if (value.type === "BinaryExpression")
    return isLiteralValue(value.left) && isLiteralValue(value.right);
  if (value.type === "ArrayExpression")
    return value.elements.every((element: Node | null) => element && isLiteralValue(element));
  if (value.type === "ObjectExpression")
    return value.properties.every(
      (property: Node) =>
        property.type === "ObjectProperty" && !property.computed && isLiteralValue(property.value),
    );
  return false;
}

export const lineOf = (node: Node): number => node.loc.start.line;
