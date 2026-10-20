import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { setClipFade, trimClipEdge } from "../api";
import { trimNeighborBounds } from "../edit/trimLimits";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { parseHistoryEntryId } from "../types/project";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

const FADE_HEAD = parseHistoryEntryId("h-fade");
const TRIM_HEAD = parseHistoryEntryId("h-trim");

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  setClipFade: vi.fn(),
  trimClipEdge: vi.fn(),
}));
vi.mock("../api/boundary", async (original) => ({
  ...(await original<typeof import("../api/boundary")>()),
  loadBoundaryContext: vi.fn(async () => ({ token: "boundary-token" })),
}));

const clip = clipRow({
  id: "c1",
  track_id: "host",
  source_start: 2,
  source_end: 12,
  timeline_start: 0,
  timeline_end: 10,
});

function Harness({ handle }: { handle: "fade-in" | "trim-out" }) {
  const lane = useDawStore.getState().project!.clips.tracks.host;
  const bounds = trimNeighborBounds(lane, 0, "ripple");
  const h = useClipEdgeHandles({
    clip,
    trackId: "host",
    fadeMaxMs: null,
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: 50,
    getTicks: () => [],
    onSelect: () => {},
  });
  return (
    <button
      onPointerDown={(e) => h.onPointerDown(handle, e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      Handle
    </button>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setClipFade).mockResolvedValue(FADE_HEAD);
  vi.mocked(trimClipEdge).mockResolvedValue({ queued: false, undo: TRIM_HEAD });
  useDawStore.getState().hydrate(
    "/tmp/ep.json",
    minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [clip] }, clip_count: 1 },
    }),
  );
  useDawStore.setState({ feedbackToast: null });
});

it.each([
  ["fade-in", "Fade saved", FADE_HEAD, 160],
  ["trim-out", "Trim saved", TRIM_HEAD, 140],
] as const)(
  "%s drag raises a toast whose Undo is the saved entry",
  async (handle, message, head, endX) => {
    const button = render(<Harness handle={handle} />).getByRole("button");
    fireEvent.pointerDown(button, { pointerId: 1, clientX: 150 });
    fireEvent.pointerMove(button, { pointerId: 1, clientX: endX });
    await act(async () =>
      fireEvent.pointerUp(button, { pointerId: 1, clientX: endX }),
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message,
      undo: head,
      tone: "status",
    });
  },
);

it("clears a gesture message when the drag ends without a change", async () => {
  const button = render(<Harness handle="trim-out" />).getByRole("button");
  fireEvent.pointerDown(button, { pointerId: 1, clientX: 150 });
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 190 });
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 150 });
  act(() => {
    useDawStore
      .getState()
      .announceStatus("Trim end is at its limit", { gesture: true });
  });
  expect(useDawStore.getState().feedbackToast).not.toBeNull();
  await act(async () =>
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 150 }),
  );
  expect(trimClipEdge).not.toHaveBeenCalled();
  expect(useDawStore.getState().feedbackToast).toBeNull();
});

it("raises no toast when the project changes while the save is in flight", async () => {
  let finish: (value: { queued: false; undo: typeof TRIM_HEAD }) => void =
    () => {};
  vi.mocked(trimClipEdge).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const button = render(<Harness handle="trim-out" />).getByRole("button");
  fireEvent.pointerDown(button, { pointerId: 1, clientX: 150 });
  fireEvent.pointerMove(button, { pointerId: 1, clientX: 140 });
  await act(async () =>
    fireEvent.pointerUp(button, { pointerId: 1, clientX: 140 }),
  );
  act(() => {
    useDawStore.getState().hydrate(
      "/tmp/other.json",
      minimalProject({
        tracks: [sampleTrack({ id: "host" })],
        clips: { tracks: { host: [clip] }, clip_count: 1 },
      }),
    );
  });
  await act(async () => finish({ queued: false, undo: TRIM_HEAD }));
  expect(useDawStore.getState().feedbackToast).toBeNull();
});
