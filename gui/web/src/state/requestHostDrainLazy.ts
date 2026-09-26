/**
 * Ask the host drain to run (or run once more) for this project. The drain
 * module is loaded on demand because it imports `../api`. Never rejects.
 */
export function requestHostDrainLazy(projectPath: string): void {
  void import("./drainOfflineQueue")
    .then(({ requestHostDrain }) => requestHostDrain(projectPath))
    .catch(() => undefined);
}
