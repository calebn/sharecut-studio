/** Drain requests that load the drain module on demand (it imports `../api`). Never reject. */

/** Ask the host drain to run (or run once more) for this project. */
export function requestHostDrainLazy(projectPath: string): void {
  void import("./drainOfflineQueue")
    .then(({ requestHostDrain }) => requestHostDrain(projectPath))
    .catch(() => undefined);
}

/** Replay this share guest's queued commands. */
export function requestGuestDrainLazy(token: string): void {
  void import("./drainOfflineQueue")
    .then(({ drainOfflineQueue }) => drainOfflineQueue(token))
    .catch(() => undefined);
}
