import { writeFileSync } from "node:fs";

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
