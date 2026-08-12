import { createRepoTools } from "./repo";
import { WorkflowStateStore } from "@brainervirus/workit-core/src/state";
import { createSddTools } from "./sdd";
import { createHandoffTools, type HandoffClient } from "./handoff";
import { createYouTrackTools } from "./youtrack";
import { createPresentTools } from "./present";
import { createFlowTools, type SessionLookup } from "./flow";
import { createDocsRepoTools } from "./docs-repo";
import { createTemplateTools } from "./templates";
import { createRuleTools } from "./rules";
import { createDoctorTool } from "./doctor";
import { HostReceiptStore } from "@brainervirus/workit-core/src/core/flow-state";

export const createTools = (
  client: HandoffClient,
  state: WorkflowStateStore,
  sdkClient?: SessionLookup,
  receipts: HostReceiptStore = new HostReceiptStore(),
) => ({
  ...createRepoTools(),
  ...createSddTools(state, sdkClient),
  ...createHandoffTools(client, state),
  ...createYouTrackTools(),
  ...createPresentTools(),
  ...createFlowTools(receipts, sdkClient),
  ...createDocsRepoTools(),
  ...createTemplateTools(),
  ...createRuleTools(),
  ...createDoctorTool(),
});
