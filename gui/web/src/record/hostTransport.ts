import { loadHostRecordState, postHostRecordCommand } from "../api";
import { useDawStore } from "../state/dawStore";
import { useRecordHostStore } from "./hostStore";

const EXPECTED: Record<string, string> = {
  Start: "recording",
  Pause: "paused",
  Resume: "recording",
  Stop: "stopped",
};

let transportEpoch = 0;

export async function submitHostRecordTransport(
  commandType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const path = useDawStore.getState().projectPath;
  if (!path) {
    return;
  }
  const token = ++transportEpoch;
  try {
    const snap = await postHostRecordCommand(path, commandType, payload);
    if (token !== transportEpoch) {
      return;
    }
    useRecordHostStore.getState().setSnapshot(snap);
  } catch (err) {
    if (token !== transportEpoch) {
      return;
    }
    const current = await loadHostRecordState(path);
    if (token !== transportEpoch) {
      return;
    }
    if (current && current.state === EXPECTED[commandType]) {
      useRecordHostStore.getState().setSnapshot(current);
      return;
    }
    throw err;
  }
}
