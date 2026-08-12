import { writeFileSync } from "node:fs";
import path from "node:path";

// Stub CLI executables for tests that record argv into a log file and print a
// fake response. Windows cannot spawn extensionless shebang files, so on win32
// a `.cmd` twin is written alongside; CreateProcess resolves it via PATHEXT.
// POSIX logs "$*" (args joined with spaces), win32 logs %* (original quoting)
// — both one line per invocation, which keeps the existing toContain-style
// log assertions (e.g. "pr create", "--base main", "Closes #42") platform-free.
export function stubCli(dir: string, name: string, logFile: string, url: string): void {
  writeFileSync(
    path.join(dir, name),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\necho "${url}"\n`,
    { mode: 0o755 },
  );
  if (process.platform === "win32") {
    writeFileSync(
      path.join(dir, `${name}.cmd`),
      `@echo off\r\n>>"${logFile}" echo %*\r\necho ${url}\r\n`,
    );
  }
}
