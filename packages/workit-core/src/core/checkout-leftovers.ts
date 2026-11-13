// The names older runtimes left in a git checkout's `.workit/`. No imports: the
// task store (which backs them up) and `workit doctor` (which must never move
// them as notes) both read this list, and doctor loads without the store's deps.

/**
 * What older runtimes left in a git checkout's `.workit/`: moved into the
 * store's backup (known markers deleted), so `.workit/` keeps only team config.
 */
export const CHECKOUT_LEFTOVERS: readonly string[] = [
  "workspace.json",
  "index.json",
  "tasks",
  "recovery",
  "metadata.lock",
  "store.moved.json",
  "task-index.json",
  "checkouts",
  "blobs",
  "legacy",
  "ledger",
  "keys",
];
