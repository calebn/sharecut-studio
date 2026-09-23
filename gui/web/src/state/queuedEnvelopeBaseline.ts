import type { QueuedCommand } from "./offlineStore";

type BaselinePoint = { id?: unknown; time?: unknown; value?: unknown };

function hasIds(points: unknown): points is BaselinePoint[] {
  return (
    Array.isArray(points) &&
    points.every(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof (p as BaselinePoint).id === "string",
    )
  );
}

/**
 * Chain a queued ``SetEnvelope`` baseline to the same track's previous queued edit.
 *
 * Replay applies queued commands in order, so by the time this one runs the host
 * holds the predecessor's ``points``. Without this, two edits made from one
 * stale snapshot would share a baseline and the second would always conflict.
 * Predecessor points without IDs get server-generated IDs, so they cannot be a
 * baseline; leave the command as captured.
 */
export function chainQueuedEnvelopeBaseline(
  queue: readonly QueuedCommand[],
  cmd: QueuedCommand,
): QueuedCommand {
  if (cmd.type !== "SetEnvelope") {
    return cmd;
  }
  const previous = queue.findLast(
    (item) =>
      item.type === "SetEnvelope" &&
      item.payload.track_id === cmd.payload.track_id,
  );
  if (!previous || !hasIds(previous.payload.points)) {
    return cmd;
  }
  return {
    ...cmd,
    payload: { ...cmd.payload, expected_points: previous.payload.points },
  };
}
