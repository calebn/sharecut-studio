import { describe, expect, it } from "vitest";
import type { QueuedCommand } from "./offlineStore";
import { chainQueuedEnvelopeBaseline } from "./queuedEnvelopeBaseline";

function envelopeCommand(
  id: string,
  trackId: string,
  points: unknown[],
  expected: unknown[],
): QueuedCommand {
  return {
    command_id: id,
    client_seq: 1,
    type: "SetEnvelope",
    payload: { track_id: trackId, points, expected_points: expected },
    created_at: 0,
  };
}

describe("chainQueuedEnvelopeBaseline", () => {
  const original = [{ id: "a", time: 0, value: 1 }];
  const first = envelopeCommand(
    "first",
    "host",
    [{ id: "a", time: 0, value: 0.5 }],
    original,
  );

  it("bases a same-track edit on the previous queued edit's points", () => {
    const second = envelopeCommand(
      "second",
      "host",
      [{ id: "a", time: 0, value: 0.25 }],
      original,
    );
    const chained = chainQueuedEnvelopeBaseline([first], second);
    expect(chained.payload.expected_points).toEqual(first.payload.points);
    expect(chained.payload.points).toEqual(second.payload.points);
  });

  it("leaves other tracks, other commands, and ID-less predecessors alone", () => {
    const guest = envelopeCommand("guest", "guest", [], original);
    expect(chainQueuedEnvelopeBaseline([first], guest)).toBe(guest);
    const meta = { ...guest, type: "SetTrackMeta" };
    expect(chainQueuedEnvelopeBaseline([first], meta)).toBe(meta);
    const idless = envelopeCommand(
      "idless",
      "host",
      [{ time: 0, value: 1 }],
      [],
    );
    const next = envelopeCommand("next", "host", [], original);
    expect(chainQueuedEnvelopeBaseline([idless], next)).toBe(next);
  });
});
