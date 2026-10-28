import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDoctor, type DoctorReport } from "@/packages/workit-cli/src/admin/doctor";

// #265 / #272: on a normal global install (no dev checkout) the doctor reported
// six WARNs that were either expected or not actionable. These rows say what is
// true: no dev checkout is info, flock belongs to the dev runtime sync only, and
// OpenCode's own plugin cache (2.x `npm/<name>@<spec>/<stamp>/node_modules`
// layout) is where the installed workit-opencode lives.

const base = mkdtempSync(path.join(os.tmpdir(), "wk-doctor-install-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const which = (name: string): string | null => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      if (Bun.file(candidate).size > 0) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
};

/** A PATH holding only node and git: no flock, no codex, no opencode. */
const minimalBin = (): string => {
  const bin = path.join(base, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["node", "git"]) {
    const found = which(name);
    if (!found) throw new Error(`${name} must be on PATH for this fixture`);
    symlinkSync(found, path.join(bin, name));
  }
  return bin;
};
const bin = process.platform === "win32" ? "" : minimalBin();

const installedEnv = (home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: bin };
  for (const key of ["WORKFLOW_TOOLKIT_DEV", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"])
    delete env[key];
  return { ...env, ...extra };
};

const doctorFor = (name: string, host: "cli" | "opencode", extra: Record<string, string> = {}) => {
  const home = path.join(base, name, "home");
  const cwd = path.join(base, name, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    home,
    run: (): DoctorReport =>
      runDoctor({
        host,
        home,
        cwd,
        workspaceRoot: cwd,
        configDir: path.join(home, ".config", "workit"),
        stateDir: path.join(home, ".local", "state", "workit"),
        env: installedEnv(home, extra),
      }),
  };
};

const row = (report: DoctorReport, id: string) => report.checks.find((c) => c.id === id)!;

test.skipIf(process.platform === "win32")(
  "Given a normal install without a dev checkout, When doctor runs, Then no-dev-checkout rows are info and flock is not required",
  () => {
    const report = doctorFor("normal", "opencode").run();
    expect(row(report, "versions").status).toBe("info");
    expect(row(report, "launcher").status).toBe("info");
    expect(row(report, "assets").status).toBe("info");
    expect(row(report, "utility").status).toBe("pass");
    expect(row(report, "utility").detail).not.toContain("flock");
    const devWarns = report.checks.filter(
      (c) => c.status === "warn" && /dev checkout|WORKFLOW_TOOLKIT_DEV|flock/.test(c.detail),
    );
    expect(devWarns).toEqual([]);
    // info counts as passed, never as a warning
    expect(report.summary.warned).toBe(report.checks.filter((c) => c.status === "warn").length);
    expect(report.summary.passed + report.summary.warned + report.summary.failed).toBe(
      report.summary.total,
    );
  },
);

test.skipIf(process.platform === "win32")(
  "Given OpenCode cached workit-opencode in its 2.x npm layout, When doctor checks the install, Then it reads that version",
  () => {
    const doctor = doctorFor("opencode-cache", "opencode", {
      WORKIT_DOCTOR_STALE_REGISTRY_VERSION: "9.0.0",
    });
    const spec = path.join(
      doctor.home,
      ".cache",
      "opencode",
      "npm",
      "@brainervirus",
      "workit-opencode@latest",
    );
    const pkg = path.join(
      spec,
      "1790643053398",
      "node_modules",
      "@brainervirus",
      "workit-opencode",
    );
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "@brainervirus/workit-opencode", version: "8.9.0" }),
    );
    const config = path.join(doctor.home, ".config", "opencode", "opencode.json");
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ plugin: ["@brainervirus/workit-opencode"] }));

    const stale = row(doctor.run(), "stale_install");
    expect(stale.status).toBe("fail");
    expect(stale.detail).toContain("8.9.0");
    expect(stale.fix).toContain(spec);
    expect(stale.fix).toContain("opencode plugin update @brainervirus/workit-opencode");
  },
);

// An exported-but-empty WORKFLOW_TOOLKIT_DEV is no dev checkout for every row:
// the runtime row used to read "" as a checkout that needs bun and FAIL, while
// the utility and versions rows read it as none.
test.skipIf(process.platform === "win32")(
  "Given WORKFLOW_TOOLKIT_DEV is empty and no bun is installed, When doctor runs, Then runtime agrees there is no dev checkout",
  () => {
    // No bun: not on the minimal PATH, not in the temp HOME, no BUN override.
    const doctor = doctorFor("empty-dev", "opencode", { WORKFLOW_TOOLKIT_DEV: "", BUN: "" });
    const report = doctor.run();
    expect(row(report, "runtime").status).not.toBe("fail");
    expect(row(report, "runtime").detail).toContain("no bun");
    expect(row(report, "versions").status).toBe("info");
    expect(row(report, "utility").detail).toBe("git on PATH");
  },
);
