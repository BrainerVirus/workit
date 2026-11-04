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
import { describeInstall, listInstalls, npmPackageOfFile, type FoundInstall } from "./discover";
import { type InstallNode } from "./node";
import { linkLauncher, removeFile, type InstallRun } from "./owned";
import { CLI_PACKAGE_NAME, ownedPaths, realpathOr, shellQuote } from "./paths";

export type MigrationCopy = FoundInstall & { kind: "npm" | "volta" | "wrapper" };

/**
 * The copies migration replaces: npm and volta packages, and wrappers that run
 * a workit (a workit-cli package, or another `workit` they exec by path). A
 * file at the launcher's place that runs no workit (a user's own script) is
 * never moved: the PATH check names it instead. Host plugin launchers stay.
 */
export const migrationCopies = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): MigrationCopy[] => {
  return listInstalls(env, platform).filter(
    (install): install is MigrationCopy =>
      install.kind === "npm" ||
      install.kind === "volta" ||
      (install.kind === "wrapper" && (install.version !== null || install.runs !== null)),
  );
};

const slug = (copy: MigrationCopy, index: number): string =>
  `${index + 1}-${copy.manager ?? copy.kind}-${copy.version ?? "unknown"}`;

/** Where one copy's backup goes. */
const backupOf = (backup: string, copy: MigrationCopy, index: number): string =>
  path.join(backup, "cli-copies", slug(copy, index));

/**
 * Whether the copy's place becomes a link to the owned launcher: the
 * launcher's own place, and (POSIX) every wrapper, so a PATH order that ran
 * the wrapper runs the owned install instead of nothing.
 */
const relinks = (copy: MigrationCopy, linked: string, platform: NodeJS.Platform): boolean =>
  copy.path === linked || (copy.kind === "wrapper" && platform !== "win32");

/** The package dir an install's files live in, compared by realpath. */
const packageKey = (dir: string | null): string | null => (dir ? realpathOr(dir) : null);

/** The package a wrapper execs, when it still exists. */
const wrapperPackage = (copy: MigrationCopy): string | null =>
  packageKey(copy.packageDir ?? (copy.runs ? npmPackageOfFile(copy.runs) : null));

/** The exact commands that back up and remove one copy (what a non-TTY run prints). */
export const removalCommand = (
  copy: MigrationCopy,
  index: number,
  context: { backup: string; launcher: string; linked: string; platform?: NodeJS.Platform },
): string => {
  const target = backupOf(context.backup, copy, index);
  const save = `mkdir -p ${shellQuote(target)}`;
  // What PATH finds where the launcher belongs becomes a link to the launcher.
  const relink = relinks(copy, context.linked, context.platform ?? process.platform)
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
 * commands. Wrappers go first: each is backed up and becomes a link to the
 * owned launcher, so no `workit` on PATH execs a package removed after it; a
 * package a left-in-place wrapper still runs is kept (W2.39). The PATH
 * launcher location is relinked to the owned launcher once whatever was there
 * is backed up.
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
  const where = { backup: context.backup, launcher, linked, platform };
  const outcome: MigrationOutcome = { removed: [], left: [], manifest: null };
  if (!context.remove) {
    outcome.left = copies.map((copy, index) => ({
      copy,
      command: removalCommand(copy, index, where),
    }));
    return outcome;
  }
  const record: Record<string, unknown>[] = [];
  const ordered = [...copies.entries()].toSorted(
    ([, a], [, b]) => Number(b.kind === "wrapper") - Number(a.kind === "wrapper"),
  );
  const keptWrappers: MigrationCopy[] = [];
  for (const [index, copy] of ordered) {
    const command = removalCommand(copy, index, where);
    const target = backupOf(context.backup, copy, index);
    try {
      const runBy =
        copy.kind === "wrapper"
          ? undefined
          : keptWrappers.find(
              (wrapper) =>
                wrapperPackage(wrapper) !== null &&
                wrapperPackage(wrapper) === packageKey(copy.packageDir ?? copy.realpath),
            );
      if (runBy)
        throw new Error(
          `kept: ${runBy.path} still runs it, and removing it would leave that workit broken`,
        );
      mkdirSync(target, { recursive: true, mode: 0o700 });
      if (copy.kind === "wrapper") {
        try {
          copyFileSync(copy.path, path.join(target, path.basename(copy.path)));
          record.push({ ...copy, backup: target, command });
          if (relinks(copy, linked, platform)) linkLauncher(launcher, copy.path);
          else removeFile(copy.path);
        } catch (error) {
          keptWrappers.push(copy);
          throw error;
        }
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
