import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { docsValidate } from "./docs-validate";
import { resolveBranch } from "./branch";
import { parseTasksFromPlan } from "./docs-validate";

const SPEC_LINK_RE = /docs\/(?:superpowers\/)?specs\/[^\s`]+\.md/;

const listMd = (dir: string): string[] => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
};

const normalizeDocPath = (root: string, p: string): string => {
  if (p.startsWith("docs/specs/")) {
    const alt = path.join(root, "docs/superpowers/specs", path.basename(p));
    if (existsSync(alt)) return path.relative(root, alt).split(path.sep).join("/");
  }
  return p;
};

const extractMessagePaths = (message: string): string[] => {
  const matches = message.match(/docs\/(?:superpowers\/)?(?:specs|plans)\/[^\s`'"]+\.md/g) ?? [];
  return [...new Set(matches)].sort();
};

type Resolved = { spec: string; plan: string; source: string } | { error: string };

const resolveFromMessagePaths = (root: string, message: string): Resolved => {
  const paths = extractMessagePaths(message);
  const msgSpecs: string[] = [];
  const msgPlans: string[] = [];
  for (const p of paths) {
    if (p.startsWith("docs/superpowers/specs/") || p.startsWith("docs/specs/")) {
      msgSpecs.push(normalizeDocPath(root, p));
    } else if (p.startsWith("docs/superpowers/plans/")) {
      msgPlans.push(p);
    }
  }
  if (msgSpecs.length === 0 && msgPlans.length === 0) return { error: "no paths" };
  if (msgSpecs.length === 1 && msgPlans.length === 1) {
    return { spec: msgSpecs[0], plan: msgPlans[0], source: "message_paths" };
  }
  return { error: "multiple specs or plans in message — use exactly one of each" };
};

const resolveActivePair = (root: string): Resolved => {
  const specsDir = path.join(root, "docs/superpowers/specs");
  const plansDir = path.join(root, "docs/superpowers/plans");
  let best: { score: number; spec: string; plan: string; source: string } | null = null;

  for (const planFile of listMd(plansDir)) {
    const plan = path.join(plansDir, planFile);
    let spec: string | null = null;
    let source = "active_pair";
    const text = readFileSync(plan, "utf8");
    for (const line of text.split("\n")) {
      if (line.startsWith("**Spec:**")) {
        const m = line.match(SPEC_LINK_RE);
        if (m) spec = m[0];
        break;
      }
    }
    if (spec?.startsWith("docs/specs/")) {
      const alt = path.join("docs/superpowers/specs", path.basename(spec));
      if (existsSync(path.join(root, alt))) spec = alt;
    }
    if (spec === null) {
      const stem = path.basename(planFile, ".md");
      for (const name of [`${stem}-design.md`, `${stem}.md`]) {
        const candidate = path.join(specsDir, name);
        if (existsSync(candidate)) {
          spec = `docs/superpowers/specs/${name}`;
          source = "matching_pair";
          break;
        }
      }
    }
    if (!spec || !existsSync(path.join(root, spec))) continue;
    const score = Math.max(statSync(path.join(root, spec)).mtimeMs, statSync(plan).mtimeMs);
    if (
      best === null ||
      score > best.score ||
      (score === best.score && (spec + plan) < (best.spec + best.plan))
    ) {
      best = { score, spec, plan: `docs/superpowers/plans/${planFile}`, source };
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

  const specsDir = path.join(root, "docs/superpowers/specs");
  const plansDir = path.join(root, "docs/superpowers/plans");
  if (listMd(specsDir).length === 0) return { error: "no spec under docs/superpowers/specs/" };
  if (listMd(plansDir).length === 0) return { error: "no plan under docs/superpowers/plans/" };
  return { error: "could not resolve spec and plan for this thread — mention paths, add a **Spec:** link, or use matching <slug>.md and <slug>-design.md names" };
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
  const slug = path.basename(plan, ".md");
  const sddDir = `docs/superpowers/sdd/${slug}`;

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
