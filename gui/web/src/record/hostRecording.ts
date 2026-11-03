import type { RecordSnapshot } from "./types";

const HOST_ID = "p_host";

/** Whether the host's own mic is part of the session. Off once the host declined their own recording. */
export function hostRecordsMic(snapshot: RecordSnapshot | null): boolean {
  const host = snapshot?.participants.find((p) => p.participant_id === HOST_ID);
  return host?.consented !== false;
}

/** Whether anyone who records has accepted, so a take could start; the server holds the same rule. */
export function someoneAccepted(snapshot: RecordSnapshot): boolean {
  return snapshot.participants.some(
    (p) =>
      (p.role === "host" || p.role === "guest") &&
      p.connected &&
      !p.removed &&
      p.consented === true,
  );
}
