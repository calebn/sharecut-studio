import { describe, expect, it } from "vitest";
import type { ClipRow } from "../types/project";
import {
  buildSchedule,
  chunkFileStartSec,
  chunkIndexForSource,
  offsetInChunk,
} from "./proxyMath";

function clip(partial: Partial<ClipRow> & Pick<ClipRow, "id">): ClipRow {
  return {
    track_id: "host",
    source_start: 0,
    source_end: 10,
    timeline_start: 0,
    timeline_end: 10,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    ...partial,
  };
}

describe("proxyMath", () => {
  it("maps source seconds to chunk indices", () => {
    expect(chunkIndexForSource(0, 60)).toBe(0);
    expect(chunkIndexForSource(59.9, 60)).toBe(0);
    expect(chunkIndexForSource(60, 60)).toBe(1);
  });

  it("computes chunk file starts with overlap", () => {
    expect(chunkFileStartSec(0, 60, 200)).toBe(0);
    expect(chunkFileStartSec(1, 60, 200)).toBeCloseTo(59.8);
  });

  it("offsets within a chunk including overlap trim", () => {
    expect(offsetInChunk(60, 1, 60, 200)).toBeCloseTo(0.2);
  });

  it("splits a clip across chunk boundaries", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 50,
          source_end: 70,
          timeline_start: 0,
          timeline_end: 20,
        }),
      ],
      0,
      30,
      60,
      200,
    );
    expect(slices.length).toBe(2);
    expect(slices[0].chunkIdx).toBe(0);
    expect(slices[1].chunkIdx).toBe(1);
    expect(slices[0].durationSec + slices[1].durationSec).toBeCloseTo(20);
  });

  it("applies fades only on first and last slices", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 50,
          source_end: 70,
          timeline_start: 0,
          timeline_end: 20,
          fade_in_ms: 40,
          fade_out_ms: 50,
        }),
      ],
      0,
      30,
      60,
      200,
    );
    expect(slices[0].fadeInSec).toBeCloseTo(0.04);
    expect(slices[0].fadeOutSec).toBe(0);
    expect(slices[1].fadeInSec).toBe(0);
    expect(slices[1].fadeOutSec).toBeCloseTo(0.05);
  });

  it("marks equalPower for crossfade joins", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          join_in_mode: "crossfade",
          fade_in_ms: 30,
        }),
      ],
      0,
      20,
      60,
      200,
    );
    expect(slices[0].gainCurve).toBe("equalPower");
  });

  it("schedules slices against origin media, not the dest lane", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          track_id: "guest",
          origin_track_id: "host",
          source_start: 0,
          source_end: 2,
          timeline_start: 0,
          timeline_end: 2,
        }),
      ],
      0,
      10,
      60,
      200,
    );
    expect(slices[0]?.trackId).toBe("host");
  });
});
