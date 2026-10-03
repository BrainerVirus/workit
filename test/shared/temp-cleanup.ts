// Preloaded by bunfig.toml: one global afterAll for the whole `bun test` run.
// bun's test runner does not emit process "exit", so temp dirs that must
// outlive a single test file (packed tarballs) are removed here.
import { afterAll } from "bun:test";
import { removeTarballDirs } from "./helpers/packages";

afterAll(removeTarballDirs);
