import { act, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { trimClipEdge } from "../api";
import { type BoundaryContext, loadBoundaryContext } from "../api/boundary";
import {
  applyDocumentSnapshot,
  mergeReturnedComment,
} from "../document/applyDocumentUpdate";
import { resetDocumentSeqForTests } from "../document/cursor";
import { beginDocumentDraft } from "../document/pendingDrafts";
import { useDawStore } from "../state/dawStore";
import { editSavesInFlight } from "../state/hostSendOrder";
import { deferred } from "../test/deferred";
import { clipRow, sampleTrack } from "../test/fixtures";
import { initializeCommentProject } from "../test/trimNudgeData";
import { Harness } from "../test/trimNudgeFixture";
import { ClipBlock } from "../timeline/ClipBlock";

vi.mock("../api/boundary", () => ({ loadBoundaryContext: vi.fn() }));
vi.mock("../api", () => ({
  trimClipEdge: vi.fn(),
  rollClipJoin: vi.fn(),
  setClipFade: vi.fn(),
}));
vi.mock("../timeline/WaveformLayer", () => ({ WaveformLayer: () => null }));
vi.mock("../hooks/useSnapTicks", () => ({ useSnapTicks: () => [] }));

beforeEach(() => {
  resetDocumentSeqForTests();
  vi.mocked(loadBoundaryContext).mockReset();
  vi.mocked(trimClipEdge)
    .mockReset()
    .mockResolvedValue({ asked: false, queued: false });
});

function boundaryReply(): BoundaryContext {
  return {
    token: "fresh",
    target: { kind: "trim", clip_id: "anchor", edge: "out", mode: "ripple" },
    track_id: "host",
    geometry: [],
    current: { source_sec: 10, timeline_sec: 10 },
    limits: { min: 0, max: 20, fine_step_sec: 0.001, regular_step_sec: 0.01 },
  };
}

async function release() {
  const button = render(<Harness />).getByRole("button");
  fireEvent.keyDown(button, { key: "Enter" });
  await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
  return button;
}

it("keeps a clean edit basis until a rejected boundary load settles", async () => {
  initializeCommentProject();
  const boundary = deferred<Awaited<ReturnType<typeof loadBoundaryContext>>>();
  vi.mocked(loadBoundaryContext).mockReturnValueOnce(boundary.promise);
  await release();
  expect(useDawStore.getState().project?.clips.tracks.host[0]?.source_end).toBe(
    9.99,
  );
  const basisEnd = useDawStore.getState().projectEditBasis()?.clips.tracks
    .host[0]?.source_end;
  await act(async () => {
    boundary.reject(new Error("Boundary request failed"));
    await editSavesInFlight("/tmp/one.json");
  });
  expect(useDawStore.getState().project?.clips.tracks.host[0]?.source_end).toBe(
    10,
  );
  expect(useDawStore.getState().heldTrim).toBeNull();
  expect(basisEnd).toBe(10);
});

it.each(["failure", "resolved"])(
  "retains a foreign comment and draft after %s",
  async (outcome) => {
    const { comment } = initializeCommentProject();
    const boundary =
      deferred<Awaited<ReturnType<typeof loadBoundaryContext>>>();
    vi.mocked(loadBoundaryContext).mockReturnValueOnce(boundary.promise);
    await release();
    beginDocumentDraft("move", "MoveClips", {
      clips: [{ clip_id: "follower", track_id: "host", timeline_start: 30 }],
    });
    mergeReturnedComment({ ...comment, body: "Comment during save" });
    await act(async () => {
      if (outcome === "failure")
        boundary.reject(new Error("Boundary request failed"));
      else boundary.resolve(boundaryReply());
      await editSavesInFlight("/tmp/one.json");
    });
    expect(useDawStore.getState().project?.clips.tracks.host).toMatchObject([
      { source_end: 10, timeline_start: 0 },
      { timeline_start: 30, timeline_end: 40 },
    ]);
    expect(useDawStore.getState().project?.comments[0]?.body).toBe(
      "Comment during save",
    );
    expect(trimClipEdge).not.toHaveBeenCalled();
  },
);

it("submits the last accepted value once and Undo waits through preview cleanup", async () => {
  initializeCommentProject();
  const boundary = deferred<Awaited<ReturnType<typeof loadBoundaryContext>>>();
  vi.mocked(loadBoundaryContext).mockReturnValueOnce(boundary.promise);
  const button = render(<Harness />).getByRole("button");
  fireEvent.keyDown(button, { key: "Enter" });
  fireEvent.keyDown(button, { key: "Enter", repeat: true });
  await act(async () => {
    fireEvent.keyUp(button, { key: "Enter" });
    fireEvent.keyUp(button, { key: "Enter" });
  });
  await act(async () => {
    boundary.resolve(boundaryReply());
    await editSavesInFlight("/tmp/one.json");
  });
  expect(trimClipEdge).toHaveBeenCalledExactlyOnceWith(
    "/tmp/one.json",
    "anchor",
    "out",
    9.98,
    "ripple",
    "fresh",
  );
  expect(useDawStore.getState().project?.clips.tracks.host[0]?.source_end).toBe(
    10,
  );
  expect(useDawStore.getState().heldTrim).toBeNull();
});

it("rejects a synthetic roll while the real trim boundary is pending", async () => {
  const { origin } = initializeCommentProject();
  origin.tracks.push(sampleTrack({ id: "guest" }));
  origin.clips.tracks.guest = [
    clipRow({
      id: "wide",
      track_id: "guest",
      source_start: 20,
      source_end: 24,
      timeline_start: 8,
      timeline_end: 12,
      source_duration_sec: 60,
    }),
  ];
  const boundary = deferred<Awaited<ReturnType<typeof loadBoundaryContext>>>();
  vi.mocked(loadBoundaryContext).mockReturnValueOnce(boundary.promise);
  await release();
  const [head, tail] = useDawStore.getState().project!.clips.tracks.guest;
  const props: ComponentProps<typeof ClipBlock> = {
    clip: tail!,
    trackId: "guest",
    mediaRef: "track:guest",
    prevClip: head!,
    nextClip: null,
    role: "dialogue",
    zoomPxPerSec: 50,
    color: "var(--color-clip-dialogue-0)",
    selected: true,
    neighborSourceLo: head!.source_end,
    neighborSourceHi: 60,
    rollPreview: null,
    onRollPreview: () => {},
    onSelect: () => {},
    onHit: () => {},
    canMove: true,
  };
  const view = render(<ClipBlock {...props} />);
  const seam = view.container.querySelector("button.join-seam")!;
  await act(async () => {
    fireEvent.pointerDown(seam, { pointerId: 5, clientX: 150 });
    fireEvent.pointerMove(seam, { pointerId: 5, clientX: 155 });
    fireEvent.pointerUp(seam, { pointerId: 5, clientX: 155 });
    boundary.reject(new Error("Boundary request failed"));
    await editSavesInFlight("/tmp/one.json");
  });
  expect(loadBoundaryContext).toHaveBeenCalledExactlyOnceWith(
    "/tmp/one.json",
    { kind: "trim", clip_id: "anchor", edge: "out", mode: "ripple" },
    [
      {
        id: "anchor",
        source_start: 0,
        source_end: 10,
        timeline_start: 0,
        source_id: null,
      },
    ],
  );
  expect(useDawStore.getState().project?.clips.tracks.guest).toMatchObject([
    {
      id: "wide",
      source_start: 20,
      source_end: 24,
      timeline_start: 8,
      timeline_end: 12,
    },
  ]);
});

it("an old save cannot settle a newer held owner", async () => {
  const { comment } = initializeCommentProject();
  const boundary = deferred<Awaited<ReturnType<typeof loadBoundaryContext>>>();
  vi.mocked(loadBoundaryContext).mockReturnValueOnce(boundary.promise);
  await release();
  mergeReturnedComment({ ...comment, body: "Published" });
  const token = Symbol("next owner");
  const state = useDawStore.getState();
  expect(
    state.changeHeldTrim({
      kind: "begin",
      token,
      target: {
        trackId: "host",
        clipId: "anchor",
        edge: "out",
        mode: "ripple",
      },
    }).kind,
  ).toBe("accepted");
  state.changeHeldTrim({ kind: "value", token, sourceSec: 9.95 });
  await act(async () => {
    boundary.resolve(boundaryReply());
    await editSavesInFlight("/tmp/one.json");
  });
  expect(useDawStore.getState().project?.clips.tracks.host[0]?.source_end).toBe(
    9.95,
  );
  expect(useDawStore.getState().heldTrim?.token).toBe(token);
  expect(useDawStore.getState().projectEditBasis()?.comments[0]?.body).toBe(
    "Published",
  );
  state.changeHeldTrim({ kind: "finish", token, disposition: "discard" });
});

it("a successful command publication keeps saved geometry after settlement", async () => {
  initializeCommentProject();
  const boundary = deferred<Awaited<ReturnType<typeof loadBoundaryContext>>>();
  vi.mocked(loadBoundaryContext).mockReturnValueOnce(boundary.promise);
  vi.mocked(trimClipEdge).mockImplementationOnce(async () => {
    applyDocumentSnapshot({
      server_seq: 5,
      project: useDawStore.getState().project!,
    });
    return { asked: false, queued: false };
  });
  await release();
  await act(async () => {
    boundary.resolve(boundaryReply());
    await editSavesInFlight("/tmp/one.json");
  });
  expect(useDawStore.getState().project?.clips.tracks.host[0]?.source_end).toBe(
    9.99,
  );
  expect(
    useDawStore.getState().projectEditBasis()?.clips.tracks.host[0]?.source_end,
  ).toBe(9.99);
  expect(useDawStore.getState().heldTrim).toBeNull();
});
