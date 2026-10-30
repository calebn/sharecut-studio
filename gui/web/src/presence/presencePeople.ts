import type { SessionClient } from "../types/session";
import { rosterDisplayName } from "./colors";
import { isObservingClient, remotePlayheadSec } from "./followSync";

/** A remote person as System/Presence draws them. */
export type PresencePerson = {
  id: string;
  name: string;
  /** Index into the eight presence colours. */
  colorIndex: number;
  /** Seconds; absent when they have none to show, so no line is drawn. */
  playhead?: number;
};

/**
 * Session clients as plain people for System/Presence. The playhead is the one
 * `remotePlayheadSec` gives (stamped transport, else the transport's own, else
 * the client's top-level position), and a client who follows someone has none:
 * they ride another person's playhead, so a second line would only double it.
 * A client with no colour takes the first. The roster passed in is already the
 * remote, live clients; this does not filter them.
 */
export function presencePeople(
  clients: readonly SessionClient[],
  durationSec: number,
  nowMs?: number,
): PresencePerson[] {
  return clients.map((client) => {
    const playhead = isObservingClient(client)
      ? null
      : remotePlayheadSec(client, durationSec, nowMs);
    return {
      id: client.client_id,
      name: rosterDisplayName(client),
      colorIndex: client.meta?.color_index ?? 0,
      ...(playhead === null ? {} : { playhead }),
    };
  });
}
