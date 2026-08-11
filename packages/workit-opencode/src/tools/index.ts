import { createRepoTools } from "./repo";
import { WorkflowStateStore } from "@brainervirus/workit-core/src/state";
import { createSddTools } from "./sdd";
import { createHandoffTools, type HandoffClient } from "./handoff";
import { createYouTrackTools } from "./youtrack";
import { createPresentTools } from "./present";
import { createFlowTools } from "./flow";
import { createDocsRepoTools } from "./docs-repo";
import { createTemplateTools } from "./templates";
import { createRuleTools } from "./rules";
import { createDoctorTool } from "./doctor";

export const createTools = (client: HandoffClient, state: WorkflowStateStore) => ({
  ...createRepoTools(),
  ...createSddTools(state),
  ...createHandoffTools(client, state),
  ...createYouTrackTools(),
  ...createPresentTools(),
  ...createFlowTools(),
  ...createDocsRepoTools(),
  ...createTemplateTools(),
  ...createRuleTools(),
  ...createDoctorTool(),
});
