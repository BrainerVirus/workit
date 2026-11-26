// The launchers' cheap pre-check for two guards (#984): text that may run one of
// Workit's own hook entries (hook-entry.ts) or remove a ledger's dir
// (write-gate.ts removesLedger) leaves their fast path for the runtime. An
// entry's name, a plugin root variable or a Workit package; a runner
// given a script path, a glob or an expansion; a
// removal or move of `.`, `..`, an absolute, home, variable or glob path. The
// Claude Code launcher (bin/workit-hook.mjs) holds a copy.
const HOOK_ENTRY_TEXT =
  /workit-hook|workit-(?:codex|cursor)-hook|session-start|launch(?:-runtime)?\.mjs|\b(?:run|hook|launcher)\.ts\b|PLUGIN_ROOT|@workit-dev\//u;
const RUNS_SCRIPT =
  /(?:^|[\s;&|(`])(?:\S*[\\/])?(?:node|bunx?|deno|npx|pnpx|tsx|ts-node)(?:\.exe)?\s[^\n;&|]*(?:[*?[$`]|\.[cm]?[jt]s\b)/u;
const REMOVES_ABOVE =
  /\b(?:rm|rmdir|rd|mv|unlink|shred|find|remove-item|move-item|ri|mi|del|erase)\b[^\n;&|]*\s(?:\.{1,2}(?:[\\/\s]|$)|[~/$*?]|[A-Za-z]:)/iu;

export const mayHitHookGuard = (text: string): boolean => {
  const bare = text.replace(/['"\\]/gu, "");
  return [text, bare].some(
    (all) => HOOK_ENTRY_TEXT.test(all) || RUNS_SCRIPT.test(all) || REMOVES_ABOVE.test(all),
  );
};
