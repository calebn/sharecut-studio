import { loadHostRecordState, postHostRecordCommand } from "../api";
import { publishDesktopCloseGuard } from "../desktop/useDesktopCloseGuard";
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
  if (commandType === "Start") {
    // The server can enter REC before the HTTP response updates the snapshot.
    // Publish synchronously so a close in that interval still reaches Rust.
    publishDesktopCloseGuard(true, "host");
    useRecordHostStore.getState().beginStart();
  } else if (useRecordHostStore.getState().startPending) {
    useRecordHostStore.getState().setStartInFlight(true);
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
    if (
      commandType === "Start" &&
      (current?.state === "lobby" || current?.state === "stopped")
    ) {
      outcomeVerified = true;
    }
    throw err;
  } finally {
    if (token === transportEpoch) {
      useRecordHostStore.getState().finishStartRisk(outcomeVerified);
    }
  }
}
