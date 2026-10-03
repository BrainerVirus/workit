// Local-pin hook process (bin/workit-hook.mjs spawns `bun src/run.ts`). The
// installed package imports dist/workit-hook.js and calls runClaudeHook itself.
import { runClaudeHook } from "./hook";

process.exitCode = await runClaudeHook(process.stdin, process.stdout);
