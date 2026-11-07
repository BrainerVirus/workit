// Workit's repo rules: recurring mistakes from past PRs, as an oxlint JS
// plugin. Each rule names the fix in its message. `check.mts` runs them against
// a ratchet baseline; see CODING_STANDARDS.md "Enforced by checks".
import path from "node:path";

type Node = { type: string; [key: string]: unknown };
type Context = {
  cwd: string;
  filename: string;
  report: (problem: { node: Node; message: string }) => void;
};
type Visitor = Record<string, (node: Node) => void>;

type RepoRule = {
  /** The past mistake the rule was written from. */
  cited: string;
  fix: string;
  /** Repo-relative POSIX path prefixes the rule covers; every file when absent. */
  only?: readonly string[];
  /** Paths the rule skips inside `only`. */
  skip?: RegExp;
  visit: (report: (node: Node, what: string) => void) => Visitor;
};

const PACKAGES = ["packages/"];
const BUILD_SCRIPTS = /^packages\/[^/]+\/scripts\//u;
const TESTS = ["test/"];

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string";

const child = (node: Node, key: string): Node | null => {
  const value = node[key];
  return isNode(value) ? value : null;
};

const children = (node: Node, key: string): Node[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

const name = (node: Node | null): string | null => {
  if (node === null) return null;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
};

/** `callee` as `a.b` or `b`, the last two segments of a member chain. */
const calleeName = (call: Node): string | null => {
  const callee = child(call, "callee");
  if (callee === null) return null;
  if (callee.type === "Identifier") return String(callee.name);
  if (callee.type !== "MemberExpression" || callee.computed === true) return null;
  const property = name(child(callee, "property"));
  const object = child(callee, "object");
  const owner = object?.type === "Identifier" ? String(object.name) : null;
  if (property === null) return null;
  return owner === null ? property : `${owner}.${property}`;
};

const lastSegment = (dotted: string): string => dotted.slice(dotted.lastIndexOf(".") + 1);

const isProcessEnv = (node: Node | null): boolean =>
  node?.type === "MemberExpression" &&
  name(child(node, "object")) === "process" &&
  name(child(node, "property")) === "env";

const propertyKey = (property: Node): string | null =>
  property.type === "Property" && property.computed !== true ? name(child(property, "key")) : null;

const hasKey = (object: Node, key: string): boolean =>
  children(object, "properties").some((property) => propertyKey(property) === key);

const hasSpread = (object: Node): boolean =>
  children(object, "properties").some((property) => property.type === "SpreadElement");

const SYNC_SPAWNS = new Set(["spawnSync", "execSync", "execFileSync"]);

/** The options argument of a child_process or Bun spawn call, or null when it has none. */
const spawnOptions = (call: Node, callee: string): Node | null => {
  const args = children(call, "arguments");
  if (callee === "Bun.spawnSync" || callee === "Bun.spawn") {
    if (args[0]?.type === "ObjectExpression") return args[0];
    return args[1] ?? null;
  }
  const verb = lastSegment(callee);
  if (verb === "execSync" || verb === "exec") return args[1] ?? null;
  if (args.length >= 3) return args[2] ?? null;
  return args[1]?.type === "ObjectExpression" ? args[1] : null;
};

const containsNow = (node: Node | null): boolean => {
  if (node === null) return false;
  if (node.type === "CallExpression") {
    const callee = calleeName(node);
    return callee === "performance.now" || callee === "Date.now";
  }
  if (node.type === "BinaryExpression")
    return containsNow(child(node, "left")) || containsNow(child(node, "right"));
  return false;
};

const isElapsed = (node: Node | null): boolean =>
  node?.type === "BinaryExpression" && node.operator === "-" && containsNow(node);

const isFlush = (statement: Node | undefined): boolean => {
  if (statement?.type !== "ExpressionStatement") return false;
  const expression = child(statement, "expression");
  const call = expression?.type === "AwaitExpression" ? child(expression, "argument") : null;
  const callee = call?.type === "CallExpression" ? calleeName(call) : null;
  return callee !== null && /^flush/iu.test(lastSegment(callee));
};

export const RULES: Record<string, RepoRule> = {
  "spawn-timeout": {
    cited: "#644/#660: pr create hung past the host timeout on an unbounded spawnSync",
    fix: "pass `timeout` (and `killSignal`) in the options, as `bounded()` in core/pr-create.ts does; a synchronous child without one blocks the event loop until the host kills the call",
    only: ["packages/", "scripts/"],
    visit: (report) => ({
      CallExpression(call) {
        const callee = calleeName(call);
        if (callee === null) return;
        const sync = callee === "Bun.spawnSync" || SYNC_SPAWNS.has(lastSegment(callee));
        if (!sync) return;
        const options = spawnOptions(call, callee);
        if (options === null) {
          report(call, `${callee} without options has no timeout`);
          return;
        }
        if (options.type !== "ObjectExpression") return;
        if (hasKey(options, "timeout") || hasSpread(options)) return;
        report(call, `${callee} options have no timeout`);
      },
    }),
  },
  "spawn-env-path": {
    cited:
      "c8b30bd4: gh/glab spawned with { ...process.env, GH_TOKEN } failed with ENOENT on Windows",
    fix: 're-declare `PATH: process.env.PATH ?? ""` in the object; bun\'s Windows spawn ignores a PATH that arrives only through a spread',
    only: PACKAGES,
    skip: BUILD_SCRIPTS,
    visit: (report) => ({
      ObjectExpression(object) {
        const properties = children(object, "properties");
        const spreadsEnv = properties.some(
          (property) =>
            property.type === "SpreadElement" && isProcessEnv(child(property, "argument")),
        );
        const spreads = properties.filter((property) => property.type === "SpreadElement").length;
        if (!spreadsEnv || spreads > 1) return;
        if (!properties.some((property) => property.type === "Property")) return;
        if (hasKey(object, "PATH")) return;
        report(object, "a child env spreads process.env without its own PATH key");
      },
    }),
  },
  "home-expanded-vars": {
    cited: "retro 2026-11-07 R2 (#664): `--cwd $W` resolved to <lead>/$W through homeExpanded(cwd)",
    fix: "expand the word's variables first: `homeExpanded(expandVars(word, vars))`, and say so in the denial when one stays unresolved",
    visit: (report) => ({
      CallExpression(call) {
        if (calleeName(call) !== "homeExpanded") return;
        const argument = children(call, "arguments")[0] ?? null;
        if (argument?.type === "CallExpression" && calleeName(argument) === "expandVars") return;
        report(call, "homeExpanded() on a shell word that was not passed through expandVars()");
      },
    }),
  },
  "no-wall-clock-assert": {
    cited:
      "#176/#497: revision-retry asserted `elapsed < 2_000` and failed on slow Windows runners",
    fix: "assert what bounds the work (attempt counts, an injected clock, the result), never runner wall time",
    only: TESTS,
    visit: (report) => {
      const elapsed = new Set<string>();
      return {
        VariableDeclarator(declarator) {
          const id = name(child(declarator, "id"));
          if (id !== null && isElapsed(child(declarator, "init"))) elapsed.add(id);
        },
        CallExpression(call) {
          const matcher = calleeName(call);
          if (matcher === null || !/^toBeLessThan(?:OrEqual)?$/u.test(lastSegment(matcher))) return;
          const member = child(call, "callee");
          const subject = member === null ? null : child(member, "object");
          if (subject?.type !== "CallExpression" || name(child(subject, "callee")) !== "expect")
            return;
          const actual = children(subject, "arguments")[0] ?? null;
          const measured =
            isElapsed(actual) ||
            (actual?.type === "Identifier" && elapsed.has(String(actual.name)));
          if (measured) report(call, "a test bounds runner wall time");
        },
      };
    },
  },
  "exit-after-flush": {
    cited: "#535: `process.exit(await main(...))` cut off output piped to the host",
    fix: "`await flushStreams()` (packages/workit-cli/src/output.ts) right before process.exit, or set process.exitCode and return",
    only: PACKAGES,
    skip: BUILD_SCRIPTS,
    visit: (report) => ({
      CallExpression(call) {
        if (calleeName(call) !== "process.exit") return;
        const statement = child(call, "parent");
        const block = statement?.type === "ExpressionStatement" ? child(statement, "parent") : null;
        const siblings =
          block === null
            ? []
            : children(block, block.type === "SwitchCase" ? "consequent" : "body");
        const index = statement === null ? -1 : siblings.indexOf(statement);
        if (index > 0 && isFlush(siblings[index - 1])) return;
        report(call, "process.exit without draining stdout and stderr first");
      },
    }),
  },
};

const posix = (file: string): string => file.split(path.sep).join("/");

const covers = (rule: RepoRule, file: string): boolean =>
  (rule.only === undefined || rule.only.some((prefix) => file.startsWith(prefix))) &&
  !(rule.skip?.test(file) ?? false);

const plugin = {
  meta: { name: "workit" },
  rules: Object.fromEntries(
    Object.entries(RULES).map(([id, rule]) => [
      id,
      {
        meta: { type: "problem", docs: { description: rule.cited } },
        create(context: Context): Visitor {
          const file = posix(path.relative(context.cwd, context.filename));
          if (!covers(rule, file)) return {};
          return rule.visit((node, what) =>
            context.report({ node, message: `${what}. Fix: ${rule.fix}. (${rule.cited})` }),
          );
        },
      },
    ]),
  ),
};

/** @public oxlint loads it from oxlintrc.json `jsPlugins`. */
export default plugin;
