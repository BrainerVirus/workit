#!/usr/bin/env bun
// Rewrites docs/qualification/context-budget.json from the current sources.
// test/behavior/context-budget.test.ts fails when the committed file drifts.
import path from "node:path";
import { BUDGET_FILE, measureBudget, writeBudget } from "../test/behavior/context-budget.ts";

writeBudget(await measureBudget());
console.log(`wrote ${path.relative(process.cwd(), BUDGET_FILE)}`);
