import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { docsValidate } from "./docs-validate";
import { resolveBranch } from "./branch";
import { parseTasksFromPlan } from "./docs-validate";

const DOC_RE = /docs\/([A-Za-z0-9][A-Za-z0-9._-]*)\/(spec|plan)\.md/g;

const listMd = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
};

type Resolved = { spec: string; plan: string; source: string } | { error: string };

const extractMessagePaths = (message: string): string[] =>
  [...new Set(message.match(DOC_RE) ?? [])].sort();

const resolveFromMessagePaths = (root: string, message: string): Resolved => {
  const paths = extractMessagePaths(message);
  if (paths.length === 0) return { error: "no paths" };
  const slugs = [...new Set(paths.map((p) => p.split("/")[1]))];
  if (slugs.length !== 1) return { error: "multiple features in message — use exactly one docs/<slug>/ pair" };
  const slug = slugs[0];
  const plan = `docs/${slug}/plan.md`;
  const spec = `docs/${slug}/spec.md`;
  if (!existsSync(path.join(root, plan)) || !existsSync(path.join(root, spec))) {
    return { error: `docs/${slug}/ must contain both plan.md and spec.md` };
  }
  return { spec, plan, source: "message_paths" };
};

const resolveActivePair = (root: string): Resolved => {
  const docsDir = path.join(root, "docs");
  let best: { score: number; spec: string; plan: string; source: string } | null = null;
  let entries: string[] = [];
  try {
    entries = readdirSync(docsDir);
  } catch {
    return { error: "no pair" };
  }
  for (const slug of entries) {
    if (slug.startsWith(".")) continue;
    const plan = path.join("docs", slug, "plan.md");
    const spec = path.join("docs", slug, "spec.md");
    if (!existsSync(path.join(root, plan)) || !existsSync(path.join(root, spec))) continue;
    const score = Math.max(statSync(path.join(root, spec)).mtimeMs, statSync(path.join(root, plan)).mtimeMs);
    if (best === null || score > best.score || (score === best.score && slug < best.spec.split("/")[1])) {
      best = { score, spec, plan, source: "active_pair" };
    }
  }
  if (best === null) return { error: "no pair" };
  return { spec: best.spec, plan: best.plan, source: best.source };
};

export const resolveWorkflowPaths = (root: string, message: string): Resolved => {
  const fromMessage = resolveFromMessagePaths(root, message);
  if (!("error" in fromMessage)) return fromMessage;
  if (fromMessage.error !== "no paths") return fromMessage;
  const active = resolveActivePair(root);
  if (!("error" in active)) return active;

  const docsDir = path.join(root, "docs");
  if (!existsSync(docsDir) || listMd(docsDir).length === 0) {
    return { error: "no docs/<slug>/ features found under docs/" };
  }
  return { error: "could not resolve spec and plan — mention docs/<slug>/plan.md or create docs/<slug>/{spec.md,plan.md}" };
};

export const buildHandoffContract = ({
  root,
  spec,
  plan,
  templatePath,
}: {
  root: string;
  spec: string;
  plan: string;
  templatePath: string;
}): { prompt: string } | { error: string } => {
  const validated = docsValidate({ spec_path: spec, plan_path: plan, workspace_root: root });
  if (validated.ok === false) {
    return { error: `docs validation failed\n${JSON.stringify({ ok: false, errors: validated.errors })}` };
  }
  const branchResolved = resolveBranch({ spec_path: spec, plan_path: plan, workspace_root: root });
  if ("error" in branchResolved) return { error: branchResolved.error as string };
  const branch = branchResolved.branch;
  const slug = path.basename(path.dirname(plan));
  const sddDir = `docs/${slug}/sdd`;

  const planText = readFileSync(path.join(root, plan), "utf8");
  const tasks = parseTasksFromPlan(planText);
  const taskList = tasks.map((t) => `- Task ${t.id}: ${t.title}`).join("\n");

  let contract: string;
  try {
    contract = readFileSync(templatePath, "utf8");
  } catch {
    return { error: "missing template templates/execution-contract.md" };
  }
  contract = contract
    .replace(/<SPEC_PATH>/g, spec)
    .replace(/<PLAN_PATH>/g, plan)
    .replace(/<BRANCH>/g, branch)
    .replace(/<SLUG>/g, slug)
    .replace(/<SDD_DIR>/g, sddDir)
    .replace(/<TASK_LIST>/g, taskList);

  return { prompt: contract };
};
