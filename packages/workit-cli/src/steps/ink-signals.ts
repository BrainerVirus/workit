// Ink registers a SIGINT/SIGTERM listener through signal-exit and never removes
// it when the instance unmounts. A live listener replaces the default action, and
// JavaScript cannot run it while the thread sits in a spawnSync, so after the
// wizard closed, Ctrl-C was held until the blocking apply finished (each killed
// host command failed and the next one ran). The wizard snapshots the listeners
// before it renders and drops what Ink added once it unmounts, so the apply dies
// of SIGINT like every other verb.
const SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export type SignalSnapshot = ReadonlyMap<NodeJS.Signals, ReadonlySet<NodeJS.SignalsListener>>;

export function snapshotSignalListeners(): SignalSnapshot {
  return new Map(SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]));
}

export function dropSignalListenersAddedSince(snapshot: SignalSnapshot): void {
  for (const signal of SIGNALS) {
    const known = snapshot.get(signal);
    for (const listener of process.listeners(signal)) {
      if (!known?.has(listener)) process.off(signal, listener);
    }
  }
}
