import { loadHostRecordState, postHostRecordCommand } from "../api";
import { publishDesktopCloseGuard } from "../desktop/useDesktopCloseGuard";
import { useDawStore } from "../state/dawStore";
import { prepareHostKeeperStorage } from "./hostKeeperStorage";
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
  if (commandType === "Start") {
    await prepareHostKeeperStorage();
    if (token !== transportEpoch) {
      return;
    }
    // The server can enter REC before the HTTP response updates the snapshot.
    // Publish after local storage is ready and before Start reaches the server.
    publishDesktopCloseGuard(true, "host");
    useRecordHostStore.getState().beginStart();
  }
  let outcomeVerified = false;
  try {
    const snap = await postHostRecordCommand(path, commandType, payload);
    if (token !== transportEpoch) {
      return;
    }
    useRecordHostStore.getState().setSnapshot(snap);
    outcomeVerified = true;
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
      outcomeVerified = true;
      return;
    }
    // A safe-looking read can race ahead of an uncertain Start mutation.
    // Only a completed command or its expected state can clear the guard.
    throw err;
  } finally {
    if (token === transportEpoch) {
      useRecordHostStore.getState().finishStartRisk(outcomeVerified);
    }
  }
}
