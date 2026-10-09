import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { rollClipJoin } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import { useNudgeRun } from "../inspector/useNudgeRun";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { ClipBlock } from "./ClipBlock";

vi.mock("../api/boundary", () => ({
  loadBoundaryContext: vi.fn(async () => ({ token: "boundary-token" })),
}));
vi.mock("./WaveformLayer", () => ({ WaveformLayer: () => null }));
vi.mock("../hooks/useSnapTicks", () => ({ useSnapTicks: () => [] }));
vi.mock("../api", async (original) => ({
  ...(await original()),
  rollClipJoin: vi.fn(async () => undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
});
function Nudge() {
  const r = useNudgeRun();
  return (
    <button
      {...r.buttonProps(
        { kind: "trim", trackId: "host", clipId: "anchor", edge: "out" },
        -0.01,
        "Trim end",
      )}
    >
      Nudge
    </button>
  );
}
it("refuses preview-only roll joins and saves an original join", async () => {
  const p = minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: {
      tracks: {
        host: [clipRow({ id: "anchor", source_end: 10, timeline_end: 10 })],
        guest: [
          clipRow({
            id: "wide",
            track_id: "guest",
            source_start: 20,
            source_end: 24,
            timeline_start: 8,
            timeline_end: 12,
            source_duration_sec: 60,
          }),
        ],
      },
      clip_count: 2,
    },
  });
  useDawStore.getState().hydrate("/tmp/one.json", p);
  const n = render(<Nudge />).getByRole("button");
  fireEvent.keyDown(n, { key: "Enter" });
  const lane = useDawStore.getState().project!.clips.tracks.guest;
  const head = lane[0]!;
  const tail = lane[1]!;
  expect(tail.id).toBe("wide:tail");
  expect(head.timeline_end).toBeCloseTo(tail.timeline_start, 9);
  expect(
    useDawStore
      .getState()
      .projectEditBasis()!
      .clips.tracks.guest.map((c) => c.id),
  ).toEqual(["wide"]);
  const view = render(
    <ClipBlock
      clip={tail}
      trackId="guest"
      role="dialogue"
      zoomPxPerSec={50}
      color="var(--clip-dialogue-0)"
      selected={true}
      mediaRef="track:guest"
      prevClip={head}
      nextClip={null}
      neighborSourceLo={head.source_end}
      neighborSourceHi={60}
      rollPreview={null}
      onRollPreview={() => {}}
      onSelect={() => {}}
      onHit={() => {}}
      canMove={true}
    />,
  );
  const handle = view.container.querySelector(
    "button.join-seam",
  ) as HTMLElement;
  expect(handle).not.toBeNull();
  await act(async () => {
    fireEvent.pointerDown(handle, { pointerId: 5, clientX: 150 });
    fireEvent.pointerMove(handle, { pointerId: 5, clientX: 155 });
    fireEvent.pointerUp(handle, { pointerId: 5, clientX: 155 });
  });
  expect(loadBoundaryContext).not.toHaveBeenCalled();
  view.unmount();
  const left = clipRow({
    id: "left",
    track_id: "guest",
    source_start: 20,
    source_end: 22,
    timeline_start: 8,
    timeline_end: 10,
    source_duration_sec: 60,
  });
  const right = clipRow({
    id: "right",
    track_id: "guest",
    source_start: 22,
    source_end: 24,
    timeline_start: 10,
    timeline_end: 12,
    source_duration_sec: 60,
  });
  act(() =>
    useDawStore.getState().hydrate(
      "/tmp/one.json",
      minimalProject({
        tracks: [sampleTrack({ id: "guest" })],
        clips: { tracks: { guest: [left, right] }, clip_count: 2 },
      }),
    ),
  );
  const original = render(
    <ClipBlock
      clip={right}
      trackId="guest"
      role="dialogue"
      zoomPxPerSec={50}
      color="var(--clip-dialogue-0)"
      selected={true}
      mediaRef="track:guest"
      prevClip={left}
      nextClip={null}
      neighborSourceLo={left.source_end}
      neighborSourceHi={60}
      rollPreview={null}
      onRollPreview={() => {}}
      onSelect={() => {}}
      onHit={() => {}}
      canMove={true}
    />,
  );
  const originalHandle = original.container.querySelector(
    "button.join-seam",
  ) as HTMLElement;
  expect(originalHandle).not.toBeNull();
  await act(async () => {
    fireEvent.pointerDown(originalHandle, { pointerId: 6, clientX: 150 });
    fireEvent.pointerMove(originalHandle, { pointerId: 6, clientX: 155 });
    fireEvent.pointerUp(originalHandle, { pointerId: 6, clientX: 155 });
  });
  expect(vi.mocked(loadBoundaryContext).mock.calls).toEqual([
    [
      "/tmp/one.json",
      { kind: "roll", left_clip_id: "left", right_clip_id: "right" },
      [
        {
          id: "left",
          source_start: 20,
          source_end: 22,
          timeline_start: 8,
          source_id: null,
        },
        {
          id: "right",
          source_start: 22,
          source_end: 24,
          timeline_start: 10,
          source_id: null,
        },
      ],
    ],
  ]);
  expect(vi.mocked(rollClipJoin).mock.calls).toEqual([
    ["/tmp/one.json", "left", "right", 0.1, "boundary-token"],
  ]);
});
