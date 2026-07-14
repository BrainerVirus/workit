export type WorkflowState = { spec: string; plan: string; sdd: string };

export class WorkflowStateStore {
  #sessions = new Map<string, WorkflowState>();

  set(sessionID: string, state: WorkflowState) {
    this.#sessions.set(sessionID, state);
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
