import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { setClipFade } from "../api";
import { trimNeighborBounds } from "../edit/trimLimits";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

vi.mock("../api", async (original) => ({
  ...(await original()),
  setClipFade: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
});
function Harness({ clip }: { clip: ClipRow }) {
  const lane = useDawStore.getState().project!.clips.tracks.guest;
  const bounds = trimNeighborBounds(
    lane,
    lane.findIndex((c) => c.id === clip.id),
    "ripple",
  );
  const h = useClipEdgeHandles({
    clip,
    trackId: "guest",
    fadeMaxMs: null,
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: 50,
    getTicks: () => [],
    onSelect: () => {},
  });
  return (
    <button
      onPointerDown={(e) => h.onPointerDown("fade-in", e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      Fade
    </button>
  );
}
it("saves a fade on the original clip", async () => {
  const origin = minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "anchor",
            track_id: "host",
            source_end: 10,
            timeline_end: 10,
          }),
        ],
        guest: [
          clipRow({
            id: "wide",
            track_id: "guest",
            source_start: 20,
            source_end: 24,
            timeline_start: 8,
            timeline_end: 12,
          }),
        ],
      },
      clip_count: 2,
    },
  });
  useDawStore.getState().hydrate("/tmp/one.json", origin);
  const original = origin.clips.tracks.guest[0]!;
  const savedButton = render(<Harness clip={original} />).getByRole("button", {
    name: "Fade",
  });
  fireEvent.pointerDown(savedButton, { pointerId: 4, clientX: 150 });
  fireEvent.pointerMove(savedButton, { pointerId: 4, clientX: 155 });
  await act(async () =>
    fireEvent.pointerUp(savedButton, { pointerId: 4, clientX: 155 }),
  );
  expect(vi.mocked(setClipFade).mock.calls).toEqual([
    [
      "/tmp/one.json",
      "wide",
      100,
      0,
      {
        fade_in_ms: 0,
        fade_out_ms: 0,
        fade_in_curve: "linear",
        fade_out_curve: "linear",
      },
    ],
  ]);
});
