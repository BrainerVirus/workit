#!/usr/bin/env bun
// Rewrites packages/workit-core/schemas/ from the zod config schemas.
// test/workit-core/config-schemas.test.ts fails when a committed file drifts.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_SCHEMA_FILES, renderConfigSchema } from "../src/core/config-schemas";

export const SCHEMAS_DIR = path.join(import.meta.dir, "..", "schemas");

if (import.meta.main) {
  mkdirSync(SCHEMAS_DIR, { recursive: true });
  for (const file of CONFIG_SCHEMA_FILES) {
    writeFileSync(path.join(SCHEMAS_DIR, file), renderConfigSchema(file));
    console.log(`wrote ${path.relative(process.cwd(), path.join(SCHEMAS_DIR, file))}`);
  }
}
