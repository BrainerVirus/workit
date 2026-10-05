// Task families (`workit task|policy|evidence|… <action>`) keep routing to
// task.ts until S17 (design §2.0). The implicit-task forms of `workit task`
// (status, start "<objective>", note, close without --task, adopt) route to
// verbs/task.ts.
import type { Verb } from "../output";
import { runTaskCommand } from "../task";

export const familyVerb = (name: string): Verb => ({
  run: async (argv, io) => {
    if (name === "task") {
      const implicit = await import("./task");
      if (implicit.isImplicitTaskForm(argv)) return implicit.run(argv, io);
    }
    return runTaskCommand([name, ...argv]);
  },
});
