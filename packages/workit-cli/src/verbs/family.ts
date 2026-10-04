// Task families (`workit task|policy|evidence|… <action>`) keep routing to
// task.ts until S17 (design §2.0).
import type { Verb } from "../output";
import { runTaskCommand } from "../task";

export const familyVerb = (name: string): Verb => ({
  run: (argv) => runTaskCommand([name, ...argv]),
});
