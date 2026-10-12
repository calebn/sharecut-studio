export function supportsCommandSendOwnership(): boolean {
  return typeof navigator !== "undefined" && navigator.locks !== undefined;
}

export function withCommandSendOwnership<T>(
  projectPath: string,
  mode: LockMode,
  action: () => Promise<T>,
): Promise<T> {
  if (!supportsCommandSendOwnership()) {
    if (mode === "exclusive") {
      return Promise.reject(
        new Error(
          "Undo and Redo are unavailable in this browser. Open the project in a supported browser.",
        ),
      );
    }
    return action();
  }
  return navigator.locks.request(
    `sharecut:command-send:${projectPath}`,
    { mode },
    action,
  );
}
