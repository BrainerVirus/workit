import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

// Stub CLI executables for tests that record argv into a log file and print a
// fake response. Windows cannot spawn extensionless shebang files (CreateProcess
// hits ERROR_BAD_EXE_FORMAT on the raw file), so on win32 ONLY a `.cmd` twin is
// written. POSIX logs "$*" (args joined with spaces), win32 logs %* (original
// quoting) — both one line per invocation, which keeps the existing
// toContain-style log assertions (e.g. "pr create", "--base main", "Closes #42")
// platform-free.
export function stubCli(dir: string, name: string, logFile: string, url: string): void {
  if (process.platform !== "win32") {
    writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\necho "${url}"\n`,
      { mode: 0o755 },
    );
    return;
  }
  writeFileSync(
    path.join(dir, `${name}.cmd`),
    `@echo off\r\n>>"${logFile}" echo %*\r\necho ${url}\r\n`,
  );
}

// PATH with the stub dir first and real gh/glab CLI directories removed on
// win32, so a stale real CLI can never shadow the stub regardless of the
// PATHEXT search order. Other platforms keep plain prepend order.
export function stubPath(dir: string): string {
  if (process.platform !== "win32") return `${dir}${path.delimiter}${process.env.PATH ?? ""}`;
  const cleaned = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(
      (d) =>
        d &&
        !["gh", "glab"].some(
          (n) => existsSync(path.join(d, n)) || existsSync(path.join(d, `${n}.exe`)),
        ),
    );
  return `${dir}${path.delimiter}${cleaned.join(path.delimiter)}`;
}
