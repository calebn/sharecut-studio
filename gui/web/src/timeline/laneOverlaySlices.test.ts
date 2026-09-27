import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppliedEditRecord, AutomationEnvelope } from "../types/project";
import {
  appliedRecordTrackIds,
  envelopeTrackIds,
  groupByTrack,
  useByTrack,
} from "./laneOverlaySlices";

function envelope(trackId: string, parameter = "volume"): AutomationEnvelope {
  return { track_id: trackId, parameter, points: [] };
}

function record(id: string, trackIds: string[]): AppliedEditRecord {
  return {
    id,
    applied_at: "2024-01-01T00:00:00Z",
    operation: "cut",
    track_ids: trackIds,
    timeline_start: 0,
    timeline_end: 1,
    source_start: 0,
    source_end: 1,
    reason: null,
    params: {},
  };
}

describe("groupByTrack", () => {
  it("groups items under every track id they belong to", () => {
    const items = [record("a", ["host"]), record("b", ["host", "guest"])];
    const out = groupByTrack(items, appliedRecordTrackIds);
    expect(out.host).toEqual([items[0], items[1]]);
    expect(out.guest).toEqual([items[1]]);
  });

  it("reuses a track's previous array when its items are identical", () => {
    const a = envelope("host");
    const b = envelope("guest");
    const prev = groupByTrack([a, b], envelopeTrackIds);
    const next = groupByTrack([a, b], envelopeTrackIds, prev);
    expect(next.host).toBe(prev.host);
    expect(next.guest).toBe(prev.guest);
  });

  it("builds a new array only for the track whose items changed", () => {
    const a = envelope("host");
    const b = envelope("guest");
    const prev = groupByTrack([a, b], envelopeTrackIds);
    const b2 = envelope("guest");
    const next = groupByTrack([a, b2], envelopeTrackIds, prev);
    expect(next.host).toBe(prev.host);
    expect(next.guest).not.toBe(prev.guest);
    expect(next.guest).toEqual([b2]);
  });

  it("does not reuse a track whose item count changed", () => {
    const a = envelope("host");
    const prev = groupByTrack([a], envelopeTrackIds);
    const next = groupByTrack([a, envelope("host")], envelopeTrackIds, prev);
    expect(next.host).not.toBe(prev.host);
  });
});

describe("useByTrack", () => {
  it("does no work and returns the same object when items keep identity", () => {
    const items = [envelope("host")];
    const { result, rerender } = renderHook(
      ({ items }: { items: AutomationEnvelope[] }) =>
        useByTrack(items, envelopeTrackIds),
      { initialProps: { items } },
    );
    const first = result.current;
    rerender({ items });
    expect(result.current).toBe(first);
  });

  it("keeps an unaffected track's slice by reference across an items swap", () => {
    const host = envelope("host");
    const guest = envelope("guest");
    const { result, rerender } = renderHook(
      ({ items }: { items: AutomationEnvelope[] }) =>
        useByTrack(items, envelopeTrackIds),
      { initialProps: { items: [host, guest] } },
    );
    const hostSlice = result.current.host;
    const guest2 = envelope("guest");
    rerender({ items: [host, guest2] });
    expect(result.current.host).toBe(hostSlice);
    expect(result.current.guest).not.toBe(hostSlice);
    expect(result.current.guest).toEqual([guest2]);
  });
});
