// The zod the hook-loaded schemas (workspaces, task contract, store lock) use.
// Classic zod's schema classes import its JSON Schema emitter (~18 KB minified)
// for their toJSONSchema() methods, so they would ship it in every hook
// bundle; zod/mini validates with the same core and only config-schemas.ts
// (CLI) emits JSON Schema, through z.toJSONSchema. Import zod from here, never
// "zod" or "zod/mini", in a module a hook loads (test/workit-core/hooks/bundle.test.ts).
import { config, globalRegistry, memoizer, type ZodMiniType } from "zod/mini";
import { globalConfig } from "zod/v4/core";
import en from "zod/v4/locales/en.js";

// What classic zod sets up on its first schema, so issue messages and parsing
// do not depend on whether this process also loaded classic zod.
if (!globalConfig.localeError) config(en());
if (!globalConfig.memoizer) config({ memoizer: memoizer() });

export * from "zod/mini";

/**
 * Classic zod's `schema.describe(text)`: a copy registered with the
 * description, which the editor JSON Schemas (config-schemas.ts) carry.
 */
export const described = <T extends ZodMiniType>(schema: T, description: string): T => {
  const copy = schema.clone();
  globalRegistry.add(copy, { description });
  return copy;
};
