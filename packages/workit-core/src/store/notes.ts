// One-time notes from the store to the user. A host installs a reporter on
// the global `Symbol.for("workit.migrationReporter")` slot (the CLI router
// does; it must not import workit-core on its cold path). Without one, the
// note is silent: hooks and in-process hosts own their output channels.

export type MigrationReport = {
  /** The 2.x store that was migrated. */
  from: string;
  /** The store it now lives in. */
  to: string;
  /** Where the 2.x files were backed up. */
  backup: string;
  tasks: number;
  skipped: number;
  workspace: boolean;
};

const SLOT = Symbol.for("workit.migrationReporter");

export const reportMigration = (report: MigrationReport): void => {
  try {
    const reporter = (globalThis as Record<symbol, unknown>)[SLOT];
    if (typeof reporter === "function") reporter(report);
  } catch {}
};
