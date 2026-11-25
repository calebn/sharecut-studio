import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setClipFade, trimClipEdge } from "../api";
import { runFocusedClipHandle } from "../commands/focusedClipHandle";
import { trimNeighborBounds } from "../edit/trimLimits";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { useClipEdgeHandles } from "./useClipEdgeHandles";

vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  trimClipEdge: vi.fn(async () => ({ queued: false, asked: false })),
  setClipFade: vi.fn(async () => ({ queued: false, asked: false })),
}));
vi.mock("../api/boundary", async (original) => ({
  ...(await original<typeof import("../api/boundary")>()),
  loadBoundaryContext: vi.fn(async () => ({ token: "boundary" })),
}));

const clip = clipRow({ id: "c1", track_id: "t1" });

function Harness() {
  const bounds = trimNeighborBounds(
    useDawStore.getState().project!.clips.tracks.t1,
    0,
    "ripple",
  );
  const h = useClipEdgeHandles({
    clip,
    trackId: "t1",
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: 50,
    getTicks: () => [],
    onSelect: () => {},
  });
  return (
    <button
      type="button"
      onPointerDown={(e) => h.onPointerDown("trim-in", e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
      onFocus={(e) => h.onFocus("trim-in", e)}
    >
      Trim
    </button>
  );
}

function FadeHarness() {
  const bounds = trimNeighborBounds(
    useDawStore.getState().project!.clips.tracks.t1,
    0,
    "ripple",
  );
  const h = useClipEdgeHandles({
    clip,
    trackId: "t1",
    neighborSourceLo: bounds.neighborLo,
    neighborSourceHi: bounds.neighborHi,
    zoomPxPerSec: 50,
    getTicks: () => [],
    onSelect: () => {},
  });
  return (
    <button
      type="button"
      onPointerDown={(e) => h.onPointerDown("fade-in", e)}
      onPointerMove={h.onPointerMove}
      onPointerUp={h.onPointerUp}
    >
      Fade in
    </button>
  );
}

function drag() {
  const button = render(<Harness />).getByRole("button");
  fireEvent.pointerDown(button, { pointerId: 5, clientX: 100 });
  fireEvent.pointerMove(button, { pointerId: 5, clientX: 150 });
  return button;
}

const realEnd = useDawStore.getState().endGestureFeedback;

beforeEach(() => {
  vi.mocked(trimClipEdge).mockClear();
  useDawStore.getState().hydrate(
    "/tmp/interrupt.project.json",
    minimalProject({
      tracks: [sampleTrack({ id: "t1" })],
      clips: { tracks: { t1: [clip] }, clip_count: 1 },
    }),
  );
});

afterEach(() => {
  useDawStore.setState({ endGestureFeedback: realEnd });
  vi.restoreAllMocks();
});

describe("a trim-handle drag interrupted by the window", () => {
  it.each([
    ["window blur", () => fireEvent.blur(window)],
    [
      "the document hiding",
      () => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        fireEvent(document, new Event("visibilitychange"));
      },
    ],
    ["pagehide", () => fireEvent(window, new Event("pagehide"))],
  ])(
    "is discarded on %s and a late pointerup saves nothing",
    async (_n, interrupt) => {
      const end = vi.fn();
      useDawStore.setState({ endGestureFeedback: end });
      const button = drag();
      act(() => interrupt());
      await act(async () =>
        fireEvent.pointerUp(button, { pointerId: 5, clientX: 150 }),
      );
      expect(trimClipEdge).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledOnce();
    },
  );

  it("still saves once when the blur arrives while the trim is committing", async () => {
    const button = drag();
    await act(async () =>
      fireEvent.pointerUp(button, { pointerId: 5, clientX: 150 }),
    );
    act(() => {
      fireEvent.blur(window);
    });
    await waitFor(() => expect(trimClipEdge).toHaveBeenCalledOnce());
  });

  it("keeps a held-arrow preview through window blur and saves on key release", async () => {
    const end = vi.fn();
    useDawStore.setState({ endGestureFeedback: end });
    const button = render(<Harness />).getByRole("button");
    act(() => button.focus());
    await act(async () => {
      await runFocusedClipHandle("trim", {
        phase: "nudge",
        direction: 1,
        shift: false,
        held: false,
      });
    });
    act(() => {
      fireEvent.blur(window);
    });
    expect(end).not.toHaveBeenCalled();
    await act(async () => {
      await runFocusedClipHandle("trim", {
        phase: "finish",
        key: "ArrowRight",
      });
    });
    await waitFor(() => expect(trimClipEdge).toHaveBeenCalledOnce());
  });
});

describe("a fade-handle drag whose clip limits change", () => {
  it("is discarded when the saved clip's other fade changes, and saves nothing", async () => {
    vi.mocked(setClipFade).mockClear();
    const button = render(<FadeHarness />).getByRole("button");
    fireEvent.pointerDown(button, { pointerId: 7, clientX: 100 });
    fireEvent.pointerMove(button, { pointerId: 7, clientX: 120 });
    act(() => {
      const project = useDawStore.getState().project!;
      useDawStore.getState().hydrate(
        "/tmp/interrupt.project.json",
        minimalProject({
          tracks: project.tracks,
          clips: {
            tracks: { t1: [{ ...clip, fade_out_ms: 900 }] },
            clip_count: 1,
          },
        }),
      );
    });
    fireEvent.pointerMove(button, { pointerId: 7, clientX: 130 });
    await act(async () =>
      fireEvent.pointerUp(button, { pointerId: 7, clientX: 130 }),
    );
    expect(setClipFade).not.toHaveBeenCalled();
  });

  it("saves the dragged fade when the limits hold", async () => {
    vi.mocked(setClipFade).mockClear();
    const button = render(<FadeHarness />).getByRole("button");
    fireEvent.pointerDown(button, { pointerId: 8, clientX: 100 });
    fireEvent.pointerMove(button, { pointerId: 8, clientX: 120 });
    await act(async () =>
      fireEvent.pointerUp(button, { pointerId: 8, clientX: 120 }),
    );
    await waitFor(() => expect(setClipFade).toHaveBeenCalledOnce());
  });
});
