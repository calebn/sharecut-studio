import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trimClipEdge } from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawKeymapListener } from "../keymap/listener";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow } from "../types/project";
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
  source_duration_sec: 20,
});
const later = clipRow({
  id: "c2",
  track_id: "host",
  source_start: 6,
  source_end: 9,
  timeline_start: 6,
  timeline_end: 9,
  source_duration_sec: 20,
});

const guest = sampleTrack({ id: "guest", duration_sec: 20 });
const guestLong = clipRow({
  id: "g1",
  track_id: "guest",
  source_start: 0,
  source_end: 8,
  timeline_start: 0,
  timeline_end: 8,
});
const music = sampleTrack({ id: "music", role: "music", duration_sec: 20 });
const bed = clipRow({
  id: "m1",
  track_id: "music",
  source_start: 0,
  source_end: 9,
  timeline_start: 0,
  timeline_end: 9,
});

function renderLane(hostClips: ClipRow[] = [first, later]) {
  clearRegisteredCommands();
  registerDawCommands();
  const lanes = { host: hostClips, guest: [guestLong], music: [bed] };
  const tracks = [track, guest, music];
  useDawStore
    .getState()
    .hydrate(
      "/tmp/ripple.project.json",
      minimalProject({ tracks, clips: { tracks: lanes, clip_count: 4 } }),
    );
  return render(
    <>
      <Keys />
      {tracks.map((t, i) => (
        <TrackLane
          key={t.id}
          track={t}
          trackIndex={i}
          clips={lanes[t.id as keyof typeof lanes]}
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
      ))}
    </>,
  );
}

const laneOf = (container: HTMLElement, trackId: string) =>
  container.querySelector(
    `.lane-row[data-track-id="${trackId}"] .lane-inner`,
  ) as HTMLElement;

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
    const host = laneOf(container, "host");
    const arrows = host.querySelectorAll(":scope > .ripple-arrow");
    expect(arrows).toHaveLength(1);
    // From c2's start (600 px) back 10 px to where it will start.
    expect(arrows[0]).toHaveStyle({ left: "590px", width: "10px" });
    expect(host.querySelector(":scope > .clip-trimmed-span")).toBeNull();

    // The guest's dialogue track loses the same 0.1 s at 4.9-5 s, and the
    // rest of its clip moves back by as much.
    const guestLane = laneOf(container, "guest");
    expect(guestLane.querySelector(":scope > .clip-trimmed-span")).toHaveStyle({
      left: "490px",
      width: "10px",
    });
    const guestArrows = guestLane.querySelectorAll(":scope > .ripple-arrow");
    expect(guestArrows).toHaveLength(1);
    expect(guestArrows[0]).toHaveStyle({ left: "490px", width: "10px" });

    // Music is not a dialogue track: nothing on it moves.
    const musicLane = laneOf(container, "music");
    expect(
      musicLane.querySelectorAll(
        ":scope > .ripple-arrow, :scope > .clip-trimmed-span",
      ),
    ).toHaveLength(0);

    fireEvent.keyUp(handle, { key: "ArrowLeft" });
    await waitFor(() => expect(trimClipEdge).toHaveBeenCalledOnce());
    expect(host).toHaveClass("is-settling");
    expect(guestLane).toHaveClass("is-settling");
    expect(musicLane).not.toHaveClass("is-settling");
    expect(container.querySelectorAll(".ripple-arrow")).toHaveLength(0);
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

  it("lets a drag run past the next clip when that clip is another recording", () => {
    const take1 = clipRow({
      id: "c1",
      track_id: "host",
      source_id: "host_t1",
      recording_path: "raw/host_t1.wav",
      source_duration_sec: 600,
      source_start: 0,
      source_end: 5,
      timeline_start: 0,
      timeline_end: 5,
    });
    const take2 = clipRow({
      id: "c2",
      track_id: "host",
      source_id: "host_t2",
      recording_path: "raw/host_t2.wav",
      source_duration_sec: 60,
      source_start: 6,
      source_end: 9,
      timeline_start: 6,
      timeline_end: 9,
    });
    const { container } = renderLane([take1, take2]);
    const handle = container.querySelector(
      '[data-clip-id="c1"] button.trim-handle.out',
    ) as HTMLElement;
    HTMLElement.prototype.setPointerCapture = vi.fn();
    fireEvent.pointerDown(handle, { pointerId: 3, clientX: 500, button: 0 });
    // 4 s further: past take 2's source start (6 s) in take 1's own media.
    fireEvent.pointerMove(handle, { pointerId: 3, clientX: 900 });

    expect(handle).not.toHaveAttribute("data-bump");
    expect(
      container.querySelector('[data-clip-id="c1"] .trim-readout'),
    ).toHaveTextContent("Ripplelater +4.0 s");
  });
});
