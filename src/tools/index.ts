import { createRepoTools } from "./repo";
import { WorkflowStateStore } from "../state";
import { createSddTools } from "./sdd";

const state = new WorkflowStateStore();

export const createTools = () => ({ ...createRepoTools(), ...createSddTools(state) });
