import { isShareProjectKey } from "../shareMode";

type HostActivity = { kind: "sending"; count: number } | { kind: "moving" };

const hostActivity = new Map<string, HostActivity>();
const MOVE_IN_PROGRESS =
  "This episode is moving. Try the edit again after it opens.";
export const MOVE_WAIT_FOR_EDITS =
  "Some edits are still waiting to be saved. Wait for them to finish, then move the episode.";

export function supportsCommandSendOwnership(): boolean {
  return typeof navigator !== "undefined" && navigator.locks !== undefined;
}

function withMoveLock<T>(
  projectPath: string,
  mode: LockMode,
  refusal: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!supportsCommandSendOwnership()) return action();
  return navigator.locks.request(
    `sharecut:project-move:${projectPath}`,
    { mode, ifAvailable: true },
    (lock) => {
      if (!lock) throw new Error(refusal);
      return action();
    },
  );
}

async function withHostSend<T>(
  projectPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const current = hostActivity.get(projectPath);
  if (current?.kind === "moving") throw new Error(MOVE_IN_PROGRESS);
  const sending = current ?? { kind: "sending", count: 0 };
  sending.count++;
  hostActivity.set(projectPath, sending);
  try {
    return await withMoveLock(projectPath, "shared", MOVE_IN_PROGRESS, action);
  } finally {
    if (--sending.count === 0) hostActivity.delete(projectPath);
  }
}

/** Keep the old path fenced in this tab after a confirmed move until reload. */
export async function withHostMove(
  projectPath: string,
  move: () => Promise<string>,
): Promise<string> {
  const current = hostActivity.get(projectPath);
  if (current?.kind === "moving") throw new Error(MOVE_IN_PROGRESS);
  if (current) throw new Error(MOVE_WAIT_FOR_EDITS);
  hostActivity.set(projectPath, { kind: "moving" });
  try {
    return await withMoveLock(
      projectPath,
      "exclusive",
      MOVE_WAIT_FOR_EDITS,
      move,
    );
  } catch (error) {
    hostActivity.delete(projectPath);
    throw error;
  }
}

export function withCommandSendOwnership<T>(
  projectPath: string,
  mode: LockMode,
  action: () => Promise<T>,
): Promise<T> {
  const send = () => requestCommandSendOwnership(projectPath, mode, action);
  return isShareProjectKey(projectPath)
    ? send()
    : withHostSend(projectPath, send);
}

function requestCommandSendOwnership<T>(
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
