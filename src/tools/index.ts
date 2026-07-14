import { createRepoTools } from "./repo";
import { WorkflowStateStore } from "../state";
import { createSddTools } from "./sdd";
import { createHandoffTools, type HandoffClient } from "./handoff";

export const createTools = (client: HandoffClient, state: WorkflowStateStore) => ({
  ...createRepoTools(),
  ...createSddTools(state),
  ...createHandoffTools(client, state),
});
