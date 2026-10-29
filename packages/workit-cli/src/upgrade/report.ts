import { type HostOutcome, type UpgradePlan } from "./shared";

const pad = (text: string) => text.padEnd(12);

export const summary = (
  plan: UpgradePlan,
  permissions: { host: string; file: string }[],
): string => {
  const lines = ["Workit upgrade plan:"];
  if (plan.cli) lines.push(`  ${pad("cli")}update ${plan.cli.installed} -> ${plan.cli.latest}`);
  for (const entry of plan.entries) {
    const what = entry.repair
      ? `reinstall missing plugin files (${entry.latest})`
      : entry.latest
        ? `update ${entry.installedVersion ?? "?"} -> ${entry.latest}`
        : `update (${entry.commands.map((c) => `${c.command} ${c.args.join(" ")}`).join(" && ")})`;
    lines.push(`  ${pad(entry.host)}${what}`);
  }
  for (const skipped of plan.skipped)
    lines.push(
      `  ${pad(skipped.host)}${skipped.reason.startsWith("already current") ? "" : "skip: "}${skipped.reason}${skipped.fix ? ` (run: ${skipped.fix})` : ""}`,
    );
  for (const failed of plan.failed)
    lines.push(
      `  ${pad(failed.host)}cannot upgrade: ${failed.reason}${failed.fix ? ` (run: ${failed.fix})` : ""}`,
    );
  for (const migration of plan.migrations) lines.push(`  ${pad("config")}${migration.description}`);
  for (const change of permissions)
    lines.push(`  ${pad("permissions")}refresh the ${change.host} block in ${change.file}`);
  for (const blocked of plan.blocked) lines.push(`  blocked: ${blocked}`);
  for (const warning of plan.warnings ?? []) lines.push(`  warning: ${warning}`);
  return lines.join("\n") + "\n";
};

const LABEL: Record<HostOutcome["status"], string> = {
  updated: "updated",
  current: "already current",
  skipped: "skipped",
  failed: "FAILED",
};

/** The reason without a leading copy of the status label ("already current (1.2.3)" under "already current"). */
const reasonFor = (entry: HostOutcome): string => {
  const label = LABEL[entry.status];
  const head = entry.reason.slice(0, label.length);
  return entry.status !== "failed" &&
    head.toLowerCase() === label.toLowerCase() &&
    !/^[a-z]/i.test(entry.reason[label.length] ?? "")
    ? entry.reason.slice(label.length).replace(/^[\s:;,-]+/, "")
    : entry.reason;
};

export const table = (hosts: HostOutcome[]): string =>
  [
    "Result:",
    ...hosts.map(
      (entry) =>
        `  ${pad(entry.host)}${LABEL[entry.status].padEnd(16)}${reasonFor(entry)}${
          entry.fix && entry.status !== "updated" && entry.status !== "current"
            ? `\n  ${pad("")}${"".padEnd(16)}fix: ${entry.fix}`
            : ""
        }`,
    ),
  ].join("\n") + "\n";

export const askConfirm = async (question: string, out: { write: (text: string) => void }) => {
  if (!process.stdin.isTTY) {
    out.write("Not a terminal: rerun with --yes to apply.\n");
    return false;
  }
  const { askLine } = await import("../prompt");
  return /^y(?:es)?$/i.test((await askLine(question)).trim());
};
