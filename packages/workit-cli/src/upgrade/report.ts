import { createStyle, type Style } from "../style";
import { type HostOutcome, type UpgradePlan } from "./shared";

const pad = (text: string) => text.padEnd(12);
const PLAIN = createStyle({ json: true });

export const summary = (
  plan: UpgradePlan,
  permissions: { host: string; file: string }[],
  style: Style = PLAIN,
): string => {
  const host = (name: string) => `  ${style.bold(pad(name))}`;
  const run = (fix: string | undefined) => (fix ? ` (run: ${style.command(fix)})` : "");
  const version = (from: string, to: string) => `update ${style.dim(from)} -> ${style.ok(to)}`;
  const lines = [style.bold("Workit upgrade plan:")];
  if (plan.cli) lines.push(`${host("cli")}${version(plan.cli.installed, plan.cli.latest)}`);
  for (const entry of plan.entries) {
    const what = entry.repair
      ? `reinstall missing plugin files (${entry.latest})`
      : entry.latest
        ? version(entry.installedVersion ?? "?", entry.latest)
        : entry.published
          ? version(entry.installedVersion ?? "?", entry.published)
          : `update (${style.command(entry.commands.map((c) => `${c.command} ${c.args.join(" ")}`).join(" && "))})`;
    lines.push(`${host(entry.host)}${what}`);
  }
  for (const skipped of plan.skipped)
    lines.push(
      `${host(skipped.host)}${skipped.reason.startsWith("already current") ? style.dim(skipped.reason) : `${style.warn("skip:")} ${skipped.reason}`}${run(skipped.fix)}`,
    );
  for (const failed of plan.failed)
    lines.push(
      `${host(failed.host)}${style.fail("cannot upgrade:")} ${failed.reason}${run(failed.fix)}`,
    );
  for (const migration of plan.migrations) lines.push(`${host("config")}${migration.description}`);
  for (const change of permissions)
    lines.push(
      `${host("permissions")}refresh the ${change.host} block in ${style.path(change.file)}`,
    );
  for (const blocked of plan.blocked) lines.push(`  ${style.fail("blocked:")} ${blocked}`);
  for (const warning of plan.warnings ?? []) lines.push(`  ${style.warn("warning:")} ${warning}`);
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

const PAINT: Record<HostOutcome["status"], keyof Style> = {
  updated: "ok",
  current: "dim",
  skipped: "warn",
  failed: "fail",
};

export const table = (hosts: HostOutcome[], style: Style = PLAIN): string =>
  [
    style.bold("Result:"),
    ...hosts.map((entry) => {
      const paint = style[PAINT[entry.status]] as (text: string) => string;
      const reason = reasonFor(entry);
      return `  ${style.bold(pad(entry.host))}${paint(LABEL[entry.status])}${" ".repeat(16 - LABEL[entry.status].length)}${
        entry.status === "current" ? style.dim(reason) : reason
      }${
        entry.fix && entry.status !== "updated" && entry.status !== "current"
          ? `\n  ${pad("")}${"".padEnd(16)}fix: ${style.command(entry.fix)}`
          : ""
      }`;
    }),
  ].join("\n") + "\n";

export const askConfirm = async (question: string, out: { write: (text: string) => void }) => {
  if (!process.stdin.isTTY) {
    out.write("Not a terminal: rerun with --yes to apply.\n");
    return false;
  }
  const { askLine } = await import("../prompt");
  return /^y(?:es)?$/i.test((await askLine(question)).trim());
};
