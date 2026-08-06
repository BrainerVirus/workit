export type WorkflowState = { spec: string; plan: string; sdd: string };

export class WorkflowStateStore {
  #sessions = new Map<string, WorkflowState>();

  constructor() {}

  set(sessionID: string, state: WorkflowState) {
    this.#sessions.set(sessionID, { spec: state.spec, plan: state.plan, sdd: state.sdd });
  }

  get(sessionID: string) {
    return this.#sessions.get(sessionID);
  }

  compactionContext(sessionID: string) {
    const value = this.get(sessionID);
    return value
      ? `Active workflow:\nSpec: ${value.spec}\nPlan: ${value.plan}\nSDD: ${value.sdd}`
      : null;
  }
}
