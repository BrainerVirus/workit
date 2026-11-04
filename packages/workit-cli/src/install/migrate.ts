// Moving to the owned install: every other copy of the CLI (an npm global in
// a version manager's prefix, a volta package, a hand-written wrapper) is
// backed up under the upgrade's backup dir, then removed with its own tool.
// A person at a terminal answers y/N first; anywhere else Workit removes
// nothing and prints the exact commands.
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { describeInstall, listInstalls, type FoundInstall } from "./discover";
import { type InstallNode } from "./node";
import { linkLauncher, removeFile, type InstallRun } from "./owned";
import { CLI_PACKAGE_NAME, ownedPaths, shellQuote } from "./paths";

export type MigrationCopy = FoundInstall & { kind: "npm" | "volta" | "wrapper" };

/** The copies migration replaces: npm and volta packages, and wrappers that run the CLI or sit where the launcher goes. */
export const migrationCopies = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): MigrationCopy[] => {
  const linked = ownedPaths(env, platform).linked;
  return listInstalls(env, platform).filter(
    (install): install is MigrationCopy =>
      install.kind === "npm" ||
      install.kind === "volta" ||
      (install.kind === "wrapper" && (install.version !== null || install.path === linked)),
  );
};

const slug = (copy: MigrationCopy, index: number): string =>
  `${index + 1}-${copy.manager ?? copy.kind}-${copy.version ?? "unknown"}`;

/** Where one copy's backup goes. */
const backupOf = (backup: string, copy: MigrationCopy, index: number): string =>
  path.join(backup, "cli-copies", slug(copy, index));

/** The exact commands that back up and remove one copy (what a non-TTY run prints). */
export const removalCommand = (
  copy: MigrationCopy,
  index: number,
  context: { backup: string; launcher: string; linked: string },
): string => {
  const target = backupOf(context.backup, copy, index);
  const save = `mkdir -p ${shellQuote(target)}`;
  // What PATH finds where the launcher belongs becomes a link to the launcher.
  const relink =
    copy.path === context.linked
      ? ` && ln -sf ${shellQuote(context.launcher)} ${shellQuote(copy.path)}`
      : "";
  if (copy.kind === "wrapper")
    return `${save} && mv ${shellQuote(copy.path)} ${shellQuote(path.join(target, path.basename(copy.path)))}${relink}`;
  const keep = `${save} && cp -R ${shellQuote(copy.packageDir ?? copy.realpath)} ${shellQuote(path.join(target, "package"))}`;
  return copy.kind === "volta"
    ? `${keep} && volta uninstall ${CLI_PACKAGE_NAME}${relink}`
    : `${keep} && npm uninstall --global --prefix ${shellQuote(copy.prefix ?? "")} ${CLI_PACKAGE_NAME}${relink}`;
};

export type MigrationOutcome = {
  removed: MigrationCopy[];
  /** Copies still in place: not confirmed, or their removal failed (with why). */
  left: { copy: MigrationCopy; command: string; error?: string }[];
  /** The record written beside the backups, when anything was backed up. */
  manifest: string | null;
};

/**
 * Back up and remove each copy (`remove`), or leave every one and return the
 * commands. The PATH launcher location is relinked to the owned launcher once
 * whatever was there is backed up.
 */
export const migrateCopies = async (
  copies: MigrationCopy[],
  context: {
    remove: boolean;
    backup: string;
    env: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    node: InstallNode;
    run: InstallRun;
  },
): Promise<MigrationOutcome> => {
  const platform = context.platform ?? process.platform;
  const { launcher, linked } = ownedPaths(context.env, platform);
  const where = { backup: context.backup, launcher, linked };
  const outcome: MigrationOutcome = { removed: [], left: [], manifest: null };
  if (!context.remove) {
    outcome.left = copies.map((copy, index) => ({
      copy,
      command: removalCommand(copy, index, where),
    }));
    return outcome;
  }
  const record: Record<string, unknown>[] = [];
  for (const [index, copy] of copies.entries()) {
    const command = removalCommand(copy, index, where);
    const target = backupOf(context.backup, copy, index);
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      if (copy.kind === "wrapper") {
        copyFileSync(copy.path, path.join(target, path.basename(copy.path)));
        record.push({ ...copy, backup: target, command });
        removeFile(copy.path);
        if (copy.path === linked) linkLauncher(launcher, linked);
      } else {
        const packageDir = copy.packageDir ?? copy.realpath;
        cpSync(packageDir, path.join(target, "package"), {
          recursive: true,
          verbatimSymlinks: true,
        });
        record.push({ ...copy, backup: target, command });
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one copy at a time: each removal is backed up and recorded before the next.
        const result = await (copy.kind === "volta"
          ? context.run("volta", ["uninstall", CLI_PACKAGE_NAME])
          : context.run(context.node.node, [
              context.node.npmCli,
              "uninstall",
              "--global",
              "--prefix",
              copy.prefix ?? "",
              CLI_PACKAGE_NAME,
            ]));
        if (result.status !== 0 || existsSync(packageDir))
          throw new Error(
            `${copy.kind === "volta" ? "volta" : "npm"} uninstall failed${result.stderr?.trim() ? `: ${result.stderr.trim().split(/\r?\n/).at(-1)}` : ""}`,
          );
      }
      outcome.removed.push(copy);
    } catch (error) {
      outcome.left.push({
        copy,
        command,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // A link at the launcher's place that pointed at a removed copy now dangles.
  try {
    if (
      lstatSync(linked).isSymbolicLink() &&
      readlinkSync(linked) !== launcher &&
      !existsSync(linked)
    )
      linkLauncher(launcher, linked);
  } catch {
    // nothing at the launcher's place: writeLaunchers links it
  }
  if (record.length) {
    outcome.manifest = path.join(context.backup, "cli-copies", "manifest.json");
    writeFileSync(outcome.manifest, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }
  return outcome;
};

/** The lines a report prints for copies left in place. */
export const leftLines = (left: MigrationOutcome["left"]): string[] =>
  left.map(
    (entry) =>
      `${describeInstall(entry.copy)}${entry.error ? ` [not removed: ${entry.error}]` : ""}\n    ${entry.command}`,
  );
