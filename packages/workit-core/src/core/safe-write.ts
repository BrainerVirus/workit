import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// Shared credential-safe write (Task 14 Step 7 / CA-13): `wx` exclusive create
// closes the TOCTOU window between an existence check and the write, and EEXIST
// means the other writer won — their bytes are preserved instead of clobbered.
// Every token write in the wizard (ensureToken), the apply path (create-file
// mutations) and initApplyData routes through this one primitive.
export type ExclusiveWriteResult = "created" | "preserved";

export function writeFileExclusive(
  file: string,
  content: string,
  mode?: number,
): ExclusiveWriteResult {
  try {
    writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode });
    return "created";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return "preserved";
    throw err;
  }
}

export function writeFileAtomic(file: string, content: string, mode?: number): void {
  const absolute = path.resolve(file);
  let parent = path.dirname(absolute);
  const root = path.parse(parent).root;
  for (;;) {
    try {
      if (lstatSync(parent).isSymbolicLink()) throw new Error(`symlinked write path: ${parent}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = path.dirname(parent);
    if (parent === root || next === parent) break;
    parent = next;
  }

  const directory = path.dirname(absolute);
  mkdirSync(directory, { recursive: true });
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error(`refusing to replace non-regular file: ${absolute}`);
  }
  const temporary = `${absolute}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", mode ?? 0o666);
    writeFileSync(fd, content, "utf8");
    if (existing) fchmodSync(fd, existing.mode & 0o777);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, absolute);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Keep the original write error.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary may already have been renamed or removed.
    }
    throw error;
  }
}
