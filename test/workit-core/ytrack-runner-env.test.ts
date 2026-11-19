// Every ytrack Workit runs gets YTRACK_NO_UPDATE_NOTIFIER=1 and
// YTRACK_NO_AUTO_UPGRADE=1: Workit never starts ytrack's release check or its
// background upgrade. ytrack is a stub on a temp PATH that prints its env.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ytrackRunner } from "@/packages/workit-core/src/core/youtrack-ytrack";

const scratch = mkdtempSync(path.join(realpathSync(os.tmpdir()), "wk-ytrack-env-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test.skipIf(process.platform === "win32")(
  "Given any ytrack call, Then the child env turns off ytrack's release check and auto-upgrade, even when the caller's env turns them on",
  () => {
    const bin = path.join(scratch, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      path.join(bin, "ytrack"),
      '#!/bin/sh\nprintf "%s %s %s\\n" "$YTRACK_NO_UPDATE_NOTIFIER" "$YTRACK_NO_AUTO_UPGRADE" "$YTRACK_HOST"\n',
    );
    chmodSync(path.join(bin, "ytrack"), 0o755);
    const env = {
      PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
      YTRACK_NO_UPDATE_NOTIFIER: "0",
      YTRACK_NO_AUTO_UPGRADE: "0",
    };
    expect(ytrackRunner(env)(["version"]).stdout).toBe("1 1 \n");
    expect(ytrackRunner(env, "acme.youtrack.cloud")(["skill", "list", "--json"]).stdout).toBe(
      "1 1 acme.youtrack.cloud\n",
    );
  },
);
