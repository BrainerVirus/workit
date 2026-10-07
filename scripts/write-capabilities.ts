#!/usr/bin/env bun
// Regenerates docs/qualification/capabilities.md from the adapter fixtures.
// test/acceptance/deterministic.test.ts fails when the committed file drifts.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { collectCapabilityMatrix, renderCapabilitiesMarkdown } from "../test/acceptance/harness.ts";

const target = path.resolve(import.meta.dir, "..", "docs/qualification/capabilities.md");
writeFileSync(target, renderCapabilitiesMarkdown(collectCapabilityMatrix()));
console.log(`wrote ${path.relative(process.cwd(), target)}`);
