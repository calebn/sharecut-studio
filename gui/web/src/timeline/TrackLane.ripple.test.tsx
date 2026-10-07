import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trimClipEdge } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawKeymapListener } from "../keymap/listener";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { TrackLane } from "./TrackLane";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  trimClipEdge: vi.fn(async () => undefined),
  loadWaveformSnap: vi.fn(async () => ({ ticks: [] })),
}));
vi.mock("../api/boundary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/boundary")>()),
  loadBoundaryContext: vi.fn(async () => ({ token: "t" })),
}));
vi.mock("./WaveformLayer", () => ({ WaveformLayer: () => null }));

function Keys() {
  useDawKeymapListener();
  return null;
}

const track = sampleTrack({ id: "host", duration_sec: 20 });
const first = clipRow({
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 5,
  timeline_start: 0,
  timeline_end: 5,
});
const later = clipRow({
  id: "c2",
  track_id: "host",
  source_start: 6,
  source_end: 9,
  timeline_start: 6,
  timeline_end: 9,
});

function renderLane() {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(
    "/tmp/ripple.project.json",
    minimalProject({
      tracks: [track],
      clips: { tracks: { host: [first, later] }, clip_count: 2 },
    }),
  );
  return render(
    <>
      <Keys />
      <TrackLane
        track={track}
        trackIndex={0}
        clips={[first, later]}
        width={2000}
        zoomPxPerSec={100}
        projectPath="/tmp/ripple.project.json"
        selection={{ kind: "clip", id: "c1", trackId: "host" }}
        showLevels={false}
        showEdits={false}
        envelopes={[]}
        appliedRecords={[]}
        pendingEdits={[]}
        onSelectTrack={vi.fn()}
        onSelectPending={vi.fn()}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />
    </>,
  );
}

describe("ripple trims on the lane (#1135)", () => {
  beforeEach(() => vi.mocked(trimClipEdge).mockClear());

  it("labels a ripple trim and draws how far the later clips will move, then lets them settle", async () => {
    const { container } = renderLane();
    const handle = container.querySelector(
      '[data-clip-id="c1"] button.trim-handle.out',
    ) as HTMLElement;
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });

    expect(
      container.querySelector('[data-clip-id="c1"] .trim-readout'),
    ).toHaveTextContent("Ripplelater −0.1 s");
    const arrows = container.querySelectorAll(".lane-inner > .ripple-arrow");
    expect(arrows).toHaveLength(1);
    // From c2's start (600 px) back 10 px to where it will start.
    expect(arrows[0]).toHaveStyle({ left: "590px", width: "10px" });

    fireEvent.keyUp(handle, { key: "ArrowLeft" });
    await waitFor(() => expect(trimClipEdge).toHaveBeenCalledOnce());
    expect(container.querySelector(".lane-inner")).toHaveClass("is-settling");
    expect(
      container.querySelectorAll(".lane-inner > .ripple-arrow"),
    ).toHaveLength(0);
  });

  it("stops a drag at a hard limit with the bump and a note", () => {
    const { container } = renderLane();
    const handle = container.querySelector(
      '[data-clip-id="c1"] button.trim-handle.out',
    ) as HTMLElement;
    HTMLElement.prototype.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 500, button: 0 });
    // The next clip's source start (6 s) caps this clip's end.
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 900 });

    expect(handle).toHaveAttribute("data-bump");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Trim end is at its limit",
    );
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 540 });
    expect(handle).not.toHaveAttribute("data-bump");
  });
});
