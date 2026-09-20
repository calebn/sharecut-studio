import { describe, expect, it } from "vitest";
import type { KeeperGate } from "./segments";
import { emptyKeeperCursor, planKeeperSegment } from "./segments";

function gate(partial: Partial<KeeperGate>): KeeperGate {
  return {
    role: "guest",
    consented: true,
    roomState: "recording",
    takeIndex: 0,
    recordingMs: 0,
    muted: false,
    ...partial,
  };
}

describe("planKeeperSegment", () => {
  it("does not write for producers or before consent", () => {
    const idle = emptyKeeperCursor();
    expect(
      planKeeperSegment(gate({ role: "producer", consented: null }), idle)
        .write,
    ).toBe(false);
    expect(
      planKeeperSegment(gate({ consented: null, roomState: "lobby" }), idle)
        .write,
    ).toBe(false);
    expect(
      planKeeperSegment(
        gate({ consented: false, roomState: "recording" }),
        idle,
      ).write,
    ).toBe(false);
  });

  it("opens segment 0 when recording starts", () => {
    const plan = planKeeperSegment(
      gate({ recordingMs: 12 }),
      emptyKeeperCursor(),
    );
    expect(plan.close).toBe(false);
    expect(plan.write).toBe(true);
    expect(plan.open).toEqual({
      takeIndex: 0,
      segmentIndex: 0,
      joinOffsetMs: 12,
    });
    expect(plan.cursor.nextSegmentIndex).toBe(1);
  });

  it("keeps writing the open segment", () => {
    const opened = planKeeperSegment(gate({}), emptyKeeperCursor());
    const next = planKeeperSegment(gate({ muted: true }), opened.cursor);
    expect(next.close).toBe(false);
    expect(next.open).toBeNull();
    expect(next.write).toBe(true);
    expect(next.muted).toBe(true);
  });

  it("closes on pause and opens a new segment on resume", () => {
    const recording = planKeeperSegment(gate({}), emptyKeeperCursor());
    const paused = planKeeperSegment(
      gate({ roomState: "paused", recordingMs: 60_000 }),
      recording.cursor,
    );
    expect(paused.close).toBe(true);
    expect(paused.write).toBe(false);
    expect(paused.cursor.open).toBeNull();
    const resumed = planKeeperSegment(
      gate({ roomState: "recording", recordingMs: 60_000 }),
      paused.cursor,
    );
    expect(resumed.open).toEqual({
      takeIndex: 0,
      segmentIndex: 1,
      joinOffsetMs: 60_000,
    });
  });

  it("resets segment index on a new take", () => {
    const take0 = planKeeperSegment(gate({}), emptyKeeperCursor());
    const stopped = planKeeperSegment(
      gate({ roomState: "stopped" }),
      take0.cursor,
    );
    const take1 = planKeeperSegment(
      gate({ takeIndex: 1, recordingMs: 0 }),
      stopped.cursor,
    );
    expect(take1.open?.segmentIndex).toBe(0);
    expect(take1.open?.takeIndex).toBe(1);
  });

  it("writes zeros while muted without closing", () => {
    const open = planKeeperSegment(gate({}), emptyKeeperCursor());
    const muted = planKeeperSegment(gate({ muted: true }), open.cursor);
    expect(muted.write).toBe(true);
    expect(muted.muted).toBe(true);
    expect(muted.close).toBe(false);
  });
});
