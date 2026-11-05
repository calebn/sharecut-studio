import { act, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { rollClipJoin } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { ClipBlock } from "./ClipBlock";

const clipBlockDefaults = {
  role: "dialogue",
  zoomPxPerSec: 50,
  color: "var(--color-clip-dialogue-0)",
  selected: true,
  nextClip: null,
  neighborSourceHi: 60,
  rollPreview: null,
  onRollPreview: () => {},
  onSelect: () => {},
  canMove: true,
} satisfies Partial<ComponentProps<typeof ClipBlock>>;

vi.mock("../api/boundary", () => ({
  loadBoundaryContext: vi.fn(async () => ({ token: "boundary-token" })),
}));
vi.mock("./WaveformLayer", () => ({ WaveformLayer: () => null }));
vi.mock("../hooks/useSnapTicks", () => ({
  useSnapTicks: () => [],
  useSplitGuideOnClip: () => false,
}));
vi.mock("../api", async (original) => ({
  ...(await original()),
  rollClipJoin: vi.fn(async () => undefined),
}));
beforeEach(() => {
  vi.clearAllMocks();
});
it("saves a roll join on its original clips", async () => {
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
      {...clipBlockDefaults}
      clip={right}
      trackId="guest"
      mediaRef="track:guest"
      prevClip={left}
      neighborSourceLo={left.source_end}
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

it("does not save a roll when its partners change during boundary loading", async () => {
  const left = clipRow({
    id: "left",
    track_id: "host",
    source_start: 20,
    source_end: 22,
    timeline_start: 8,
    timeline_end: 10,
    source_duration_sec: 60,
  });
  const right = clipRow({
    id: "right",
    track_id: "host",
    source_start: 22,
    source_end: 24,
    timeline_start: 10,
    timeline_end: 12,
    source_duration_sec: 60,
  });
  const project = minimalProject({
    tracks: [sampleTrack({ id: "host" })],
    clips: { tracks: { host: [left, right] }, clip_count: 2 },
  });
  useDawStore.getState().hydrate("/tmp/one.json", project);
  let release!: () => void;
  vi.mocked(loadBoundaryContext).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            target: {
              kind: "roll",
              left_clip_id: "left",
              right_clip_id: "right",
            },
            token: "boundary-token",
            track_id: "host",
            geometry: [],
            current: { source_sec: 22, timeline_sec: 10 },
            limits: {
              min: -1,
              max: 1,
              fine_step_sec: 0.001,
              regular_step_sec: 0.01,
            },
          });
      }),
  );
  const view = render(
    <ClipBlock
      {...clipBlockDefaults}
      clip={right}
      trackId="host"
      mediaRef="track:host"
      prevClip={left}
      neighborSourceLo={left.source_end}
    />,
  );
  const handle = view.container.querySelector(
    "button.join-seam",
  ) as HTMLElement;
  await act(async () => {
    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 150 });
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 155 });
  });
  expect(loadBoundaryContext).toHaveBeenCalledTimes(1);
  act(() =>
    useDawStore.getState().setProject({
      ...project,
      clips: {
        tracks: {
          host: [left, { ...right, source_end: 25, timeline_end: 13 }],
        },
        clip_count: 2,
      },
    }),
  );
  await act(async () => release());
  expect(rollClipJoin).not.toHaveBeenCalled();
  expect(useDawStore.getState().project!.clips.tracks.host[1]!.source_end).toBe(
    25,
  );
});
