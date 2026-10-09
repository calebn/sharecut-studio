import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { trimClipEdge } from "../api";
import { loadBoundaryContext } from "../api/boundary";
import { mergeReturnedComment } from "../document/applyDocumentUpdate";
import { resetDocumentSeqForTests } from "../document/cursor";
import { beginDocumentDraft } from "../document/pendingDrafts";
import { useDawStore } from "../state/dawStore";
import { editSavesInFlight } from "../state/hostSendOrder";
import { deferred } from "../test/deferred";
import { initializeCommentProject } from "../test/trimNudgeData";
import { Harness } from "../test/trimNudgeFixture";

vi.mock("../api/boundary", () => ({ loadBoundaryContext: vi.fn() }));
vi.mock("../api", () => ({ trimClipEdge: vi.fn() }));

beforeEach(() => {
  resetDocumentSeqForTests();
  vi.mocked(loadBoundaryContext).mockReset();
  vi.mocked(trimClipEdge).mockReset().mockResolvedValue({ asked: false });
});

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
      else
        boundary.resolve({ token: "fresh" } as Awaited<
          ReturnType<typeof loadBoundaryContext>
        >);
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
    boundary.resolve({ token: "fresh" } as Awaited<
      ReturnType<typeof loadBoundaryContext>
    >);
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
