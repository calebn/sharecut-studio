import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import { trimNeighborBounds } from "../utils/trimLimits";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

/** 50 px a second, so the 8 px magnet reaches 0.16 s either side. */
const ZOOM = 50;

const row = (
  id: string,
  track: string,
  timelineStart: number,
  timelineEnd: number,
  sourceStart = 0,
): ClipRow =>
  clipRow({
    id,
    track_id: track,
    source_id: `${id}-src`,
    source_duration_sec: 600,
    source_start: sourceStart,
    source_end: sourceStart + (timelineEnd - timelineStart),
    timeline_start: timelineStart,
    timeline_end: timelineEnd,
  });

/**
 * Clip `a` (source 10 to 20) sits at 0 to 10 s on the host lane. Host and
 * guest are dialogue lanes, so a ripple trim of `a` moves both; the music
 * lane stays put.
 */
function project() {
  return minimalProject({
    tracks: [
      sampleTrack({ id: "host", duration_sec: 600 }),
      sampleTrack({ id: "guest", duration_sec: 600 }),
      sampleTrack({ id: "music", role: "music", duration_sec: 600 }),
    ],
    clips: {
      tracks: {
        host: [row("a", "host", 0, 10, 10), row("h2", "host", 12, 20)],
        guest: [row("g1", "guest", 0, 6), row("g2", "guest", 10.5, 15)],
        music: [row("m", "music", 3, 12.3)],
      },
      clip_count: 5,
    },
  });
}

function Harness({ handle }: { handle: "trim-in" | "trim-out" }) {
  const lane = useDawStore((s) => s.project?.clips.tracks.host) ?? [];
  const bounds = trimNeighborBounds(lane, 0, "ripple");
  const h = useClipEdgeHandles({
    clip: lane[0]!,
    trackId: "host",
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: ZOOM,
    getTicks: () => [],
    onSelect: () => {},
  });
  const p = h.trimPreview;
  return (
    <button
      type="button"
      onPointerDown={(e) => h.onPointerDown(handle, e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      {p ? (handle === "trim-in" ? p.sourceStart : p.sourceEnd) : "idle"}
    </button>
  );
}

/** Drags `handle` by `deltaSec` timeline seconds and reads the previewed edge. */
function dragBy(
  handle: "trim-in" | "trim-out",
  deltaSec: number,
  altKey = false,
): number {
  const view = render(<Harness handle={handle} />);
  const button = view.getByRole("button");
  fireEvent.pointerDown(button, { pointerId: 1, clientX: 1000 });
  fireEvent.pointerMove(button, {
    pointerId: 1,
    clientX: 1000 + deltaSec * ZOOM,
    altKey,
  });
  const edge = Number(button.textContent);
  view.unmount();
  return edge;
}

beforeEach(() => {
  useDawStore.getState().hydrate("/tmp/ep.json", project());
  useDawStore.setState({ snapEnabled: true, playheadSec: 40 });
});

afterEach(() => useDawStore.setState({ snapEnabled: true }));

describe("a trim drag snaps to other clips' edges", () => {
  it("pulls an out edge onto the end of a clip on a lane the trim does not ripple", () => {
    // The pointer puts the end at 12.25 s; the music clip ends at 12.3 s.
    expect(dragBy("trim-out", 2.25)).toBeCloseTo(22.3, 9);
  });

  it("pulls a shortening out edge onto a rippled clip that ends before it", () => {
    // The guest's first clip ends at 6 s and stays put while `a` shortens.
    expect(dragBy("trim-out", -3.9)).toBeCloseTo(16, 9);
  });

  it("ignores the start of a rippled clip that moves with the trim", () => {
    // The guest's second clip starts at 10.5 s, after the edited end.
    expect(dragBy("trim-out", 0.45)).toBeCloseTo(20.45, 9);
    // The host's next clip starts at 12 s and follows the trimmed end.
    expect(dragBy("trim-out", 1.95)).toBeCloseTo(21.95, 9);
  });

  it("pulls an out edge onto the playhead", () => {
    useDawStore.setState({ playheadSec: 13 });
    expect(dragBy("trim-out", 2.95)).toBeCloseTo(23, 9);
  });

  it("lands a rippled in edge's saved end on a clip edge that stays put", () => {
    // Opening 2.3 s of head moves the end from 10 s to the music clip's 12.3 s.
    expect(dragBy("trim-in", -2.25)).toBeCloseTo(7.7, 9);
    // Cutting 7 s of head moves the end to the music clip's start at 3 s.
    expect(dragBy("trim-in", 6.95)).toBeCloseTo(17, 9);
  });

  it("offers an in edge no rippled clip's edge", () => {
    // The guest's first clip ends at 6 s, after the in edge's point at 0 s:
    // the ripple cuts into it, so the end landing there is no target.
    expect(dragBy("trim-in", 3.95)).toBeCloseTo(13.95, 9);
  });

  it("keeps the edge under the pointer while Snap is off", () => {
    useDawStore.setState({ snapEnabled: false });
    expect(dragBy("trim-out", 2.25)).toBeCloseTo(22.25, 9);
  });

  it("keeps the edge under the pointer while Alt inverts Snap on", () => {
    expect(dragBy("trim-out", 2.25, true)).toBeCloseTo(22.25, 9);
  });

  it("pulls the edge while Alt inverts Snap off", () => {
    useDawStore.setState({ snapEnabled: false });
    expect(dragBy("trim-out", 2.25, true)).toBeCloseTo(22.3, 9);
  });
});
