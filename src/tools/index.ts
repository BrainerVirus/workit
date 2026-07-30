import { createRepoTools } from "./repo";
import { WorkflowStateStore } from "../state";
import { createSddTools } from "./sdd";
import { createHandoffTools, type HandoffClient } from "./handoff";
import { createYouTrackTools } from "./youtrack";
import { createPresentTools } from "./present";

export const createTools = (client: HandoffClient, state: WorkflowStateStore) => ({
  ...createRepoTools(),
  ...createSddTools(state),
  ...createHandoffTools(client, state),
  ...createYouTrackTools(),
  ...createPresentTools(),
});
