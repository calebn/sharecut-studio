import { beforeEach, describe, expect, it, vi } from "vitest";
import { moveClips } from "../api";
import { moveClips as submitClipMoves } from "../api/documentEdits";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import {
  _resetTrackMutateChainForTests,
  enqueueTrackMutate,
} from "../commands/trackMutation";
import { beginDocumentDraft } from "../document/pendingDrafts";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { movingLikeTheQueue } from "../test/queueDraft";
import type { ClipRow } from "../types/project";
import {
  applyClipPlacement,
  beginClipPlacement,
  cancelClipPlacement,
  getClipPlacement,
  updateClipPlacement,
} from "./clipPlacement";

vi.mock("../services/commandQueue", () => ({
  // Like the real queue, the draft begins before the first await and a queued
  // reply keeps it.
  submitQueuedDocumentCommand: vi.fn(
    async (_path: string, type: string, payload: Record<string, unknown>) => {
      beginDocumentDraft("queued-move", type, payload);
      return {
        ok: true,
        queued: true,
        command_id: "queued-move",
        client_seq: 1,
      };
    },
  ),
}));
vi.mock("../api", () => ({ moveClips: vi.fn(async () => null) }));
const clip = (
  id: string,
  track_id: string,
  timeline_start: number,
): ClipRow => ({
  id,
  track_id,
  timeline_start,
  timeline_end: timeline_start + 2,
  source_start: 0,
  source_end: 2,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
  source_duration_sec: null,
  recording_key: null,
});
function begin() {
  const token = beginClipPlacement("a");
  if (token === null) throw new Error("placement did not start");
  return token;
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<null>((done) => {
    resolve = () => done(null);
  });
  return { promise, resolve };
}
beforeEach(() => {
  cancelClipPlacement();
  clearRegisteredCommands();
  registerDawCommands();
  _resetTrackMutateChainForTests();
  vi.mocked(moveClips)
    .mockReset()
    .mockImplementation(movingLikeTheQueue(async () => null));
  useDawStore.getState().hydrate(
    "/tmp/placement",
    minimalProject({
      tracks: ["host", "guest", "third"].map((id) =>
        sampleTrack({ id, label: id }),
      ),
      clips: {
        clip_count: 3,
        tracks: {
          host: [clip("a", "host", 5)],
          guest: [clip("b", "guest", 25)],
          third: [clip("c", "third", 1)],
        },
      },
    }),
  );
  useDawStore.setState({
    guestMode: null,
    shareCapabilities: null,
    timelineDragging: false,
    joinMutationInFlight: false,
  });
  useDawStore.getState().setSelection({
    kind: "clip",
    id: "a",
    trackId: "host",
    ids: ["a", "b"],
  });
});

describe("local clip placement owner", () => {
  it("previews and saves exact group time and lanes once without patching a preview", async () => {
    const before = useDawStore.getState().project;
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    expect(getClipPlacement()).toMatchObject({
      kind: "preview",
      placements: [
        { clip_id: "a", timeline_start: 7, track_id: "guest" },
        { clip_id: "b", timeline_start: 27, track_id: "third" },
      ],
    });
    expect(useDawStore.getState().project).toBe(before);
    await Promise.all([applyClipPlacement(token), applyClipPlacement(token)]);
    expect(moveClips).toHaveBeenCalledExactlyOnceWith("/tmp/placement", [
      { clip_id: "a", timeline_start: 7, track_id: "guest" },
      { clip_id: "b", timeline_start: 27, track_id: "third" },
    ]);
    expect(
      useDawStore
        .getState()
        .project?.clips.tracks.third.map((row) => [row.id, row.timeline_start]),
    ).toEqual([
      ["c", 1],
      ["b", 27],
    ]);
    expect(getClipPlacement()).toEqual({ kind: "idle" });
  });
  it("hands a queued delivery to the existing command path without claiming server acknowledgement", async () => {
    vi.mocked(moveClips).mockImplementationOnce(submitClipMoves);
    const history = useDawStore.getState().project?.history;
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    await applyClipPlacement(token);
    expect(submitQueuedDocumentCommand).toHaveBeenCalledWith(
      "/tmp/placement",
      "MoveClips",
      {
        clips: [
          { clip_id: "a", timeline_start: 7, track_id: "guest" },
          { clip_id: "b", timeline_start: 27, track_id: "third" },
        ],
      },
      undefined,
    );
    expect(useDawStore.getState().project?.clips.tracks.guest[0]).toMatchObject(
      { id: "a", timeline_start: 7 },
    );
    expect(useDawStore.getState().project?.history).toBe(history);
    expect(getClipPlacement()).toEqual({ kind: "idle" });
  });
  it("uses existing independent zero and outer-lane clamps", () => {
    useDawStore.getState().setSelection({
      kind: "clip",
      id: "a",
      trackId: "host",
      ids: ["a", "c"],
    });
    const token = begin();
    updateClipPlacement(token, "0", "third");
    expect(getClipPlacement()).toMatchObject({
      placements: [
        { clip_id: "a", timeline_start: 0, track_id: "third" },
        { clip_id: "c", timeline_start: 0, track_id: "third" },
      ],
    });
  });
  it("does not snap an exact fractional destination", async () => {
    const token = begin();
    updateClipPlacement(token, "7.00001", "host");
    await applyClipPlacement(token);
    expect(
      useDawStore.getState().project?.clips.tracks.host[0].timeline_start,
    ).toBe(7.00001);
  });
  it("cancel and unchanged Apply leave the project and delivery untouched", async () => {
    const before = useDawStore.getState().project;
    const token = begin();
    await applyClipPlacement(token);
    expect(getClipPlacement()).toEqual({ kind: "idle" });
    const next = begin();
    updateClipPlacement(next, "7", "guest");
    cancelClipPlacement(next);
    await applyClipPlacement(next);
    expect(useDawStore.getState().project).toBe(before);
    expect(moveClips).not.toHaveBeenCalled();
  });
  it.each(["", "-1", "NaN"])(
    "keeps invalid input %s recoverable",
    async (value) => {
      const token = begin();
      updateClipPlacement(token, value, "guest");
      await applyClipPlacement(token);
      expect(getClipPlacement()).toMatchObject({
        kind: "preview",
        placements: [],
        error: expect.stringContaining("zero or more"),
      });
      updateClipPlacement(token, "7", "guest");
      await applyClipPlacement(token);
      expect(
        useDawStore.getState().project?.clips.tracks.guest[0].timeline_start,
      ).toBe(7);
    },
  );
  it.each([
    "geometry",
    "meta",
    "history",
    "selection",
    "project",
    "permission",
    "gesture",
  ])("invalidates on %s", async (change) => {
    if (change === "permission")
      useDawStore.setState({
        projectPath: "share:placement",
        guestMode: "edit",
        shareCapabilities: ["edit"],
      });
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const s = useDawStore.getState();
    if (change === "geometry" && s.project)
      s.setProject({ ...s.project, timeline_duration_sec: 100 });
    if (change === "meta" && s.project)
      s.setProject({
        ...s.project,
        meta: { ...s.project.meta, name: "Renamed" },
      });
    if (change === "history" && s.project)
      s.setProject({
        ...s.project,
        history: { ...s.project.history, head_id: "h2" as never },
      });
    if (change === "selection")
      s.setSelection({ kind: "track", trackId: "guest" });
    if (change === "project")
      useDawStore.setState({ projectEpoch: s.projectEpoch + 1 });
    if (change === "permission")
      useDawStore.setState({ guestMode: "view", shareCapabilities: [] });
    if (change === "gesture") useDawStore.setState({ timelineDragging: true });
    await applyClipPlacement(token);
    expect(getClipPlacement()).toEqual({ kind: "idle" });
    expect(moveClips).not.toHaveBeenCalled();
  });
  it("keeps a preview open when the project view is replaced with identical content", () => {
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const s = useDawStore.getState();
    if (!s.project) throw new Error("no project");
    s.setProject({ ...s.project });
    expect(useDawStore.getState().project).not.toBe(s.project);
    expect(getClipPlacement()).toMatchObject({ kind: "preview", start: "7" });
  });
  it("keeps a preview open across a late transcript, hydration flag and history groups load", () => {
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const s = useDawStore.getState();
    if (!s.project) throw new Error("no project");
    s.setProject({
      ...s.project,
      transcript: { utterances: [{ id: "u" } as never] },
      meta: { ...s.project.meta, hydration: { transcript_words: true } },
      history: { ...s.project.history, groups: [{ id: "g" } as never] },
    });
    expect(getClipPlacement()).toMatchObject({ kind: "preview", start: "7" });
  });
  it("applies a move after the project view is replaced with identical content", async () => {
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const s = useDawStore.getState();
    if (!s.project) throw new Error("no project");
    s.setProject({ ...s.project });
    await applyClipPlacement(token);
    expect(moveClips).toHaveBeenCalled();
  });
  it("does not refuse a committing move queued behind a content-identical replacement", async () => {
    const held = deferred();
    const blocker = enqueueTrackMutate(() => held.promise);
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const applying = applyClipPlacement(token);
    const s = useDawStore.getState();
    if (!s.project) throw new Error("no project");
    s.setProject({ ...s.project });
    held.resolve();
    await blocker;
    await applying;
    expect(moveClips).toHaveBeenCalled();
  });
  it.each(["geometry", "project", "cancel", "selection", "permission"])(
    "rechecks %s after waiting in the mutation queue",
    async (change) => {
      const held = deferred();
      const blocker = enqueueTrackMutate(() => held.promise);
      if (change === "permission")
        useDawStore.setState({
          projectPath: "share:placement",
          guestMode: "edit",
          shareCapabilities: ["edit"],
        });
      const token = begin();
      updateClipPlacement(token, "7", "guest");
      const applying = applyClipPlacement(token);
      expect(getClipPlacement()).toMatchObject({ kind: "committing" });
      const s = useDawStore.getState();
      if (change === "geometry" && s.project)
        s.setProject({ ...s.project, timeline_duration_sec: 100 });
      if (change === "project")
        useDawStore.setState({
          projectPath: "/tmp/other",
          projectEpoch: s.projectEpoch + 1,
        });
      if (change === "cancel") cancelClipPlacement(token);
      if (change === "selection")
        s.setSelection({ kind: "track", trackId: "guest" });
      if (change === "permission")
        useDawStore.setState({ shareCapabilities: ["view"] });
      const before = useDawStore.getState().project;
      held.resolve();
      await blocker;
      await applying;
      expect(useDawStore.getState().project).toBe(before);
      expect(moveClips).not.toHaveBeenCalled();
      expect(getClipPlacement()).toEqual({ kind: "idle" });
    },
  );
  it("keeps a refused move available for correction and retry", async () => {
    vi.mocked(moveClips).mockImplementationOnce(
      movingLikeTheQueue(() => Promise.reject(new Error("Save refused"))),
    );
    const before = useDawStore.getState().project;
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    await applyClipPlacement(token);
    expect(useDawStore.getState().project).toBe(before);
    expect(getClipPlacement()).toMatchObject({
      kind: "preview",
      start: "7",
      error: "Save refused",
    });
    await applyClipPlacement(token);
    expect(
      useDawStore.getState().project?.clips.tracks.guest[0].timeline_start,
    ).toBe(7);
  });
  it("late rejection cannot clear a draft on a replacement project", async () => {
    const held = deferred();
    vi.mocked(moveClips).mockImplementationOnce(
      movingLikeTheQueue(() =>
        held.promise.then(() => {
          throw new Error("Late refusal");
        }),
      ),
    );
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const applying = applyClipPlacement(token);
    await vi.waitFor(() => expect(moveClips).toHaveBeenCalledTimes(1));
    const s = useDawStore.getState();
    useDawStore.setState({
      projectPath: "/tmp/replacement",
      projectEpoch: s.projectEpoch + 1,
    });
    const replacement = begin();
    updateClipPlacement(replacement, "9", "host");
    held.resolve();
    await applying;
    expect(getClipPlacement()).toMatchObject({
      kind: "preview",
      capture: { token: replacement },
      start: "9",
    });
    expect(
      useDawStore.getState().project?.clips.tracks.guest[0].timeline_start,
    ).toBe(7);
  });
  it("late success cannot clear a replacement owner", async () => {
    const held = deferred();
    vi.mocked(moveClips).mockImplementationOnce(
      movingLikeTheQueue(() => held.promise as Promise<null>),
    );
    const token = begin();
    updateClipPlacement(token, "7", "guest");
    const applying = applyClipPlacement(token);
    await vi.waitFor(() => expect(moveClips).toHaveBeenCalledTimes(1));
    cancelClipPlacement(token);
    const replacement = begin();
    updateClipPlacement(replacement, "9", "host");
    held.resolve();
    await applying;
    expect(getClipPlacement()).toMatchObject({
      kind: "preview",
      capture: { token: replacement },
      start: "9",
    });
    cancelClipPlacement(token);
    expect(getClipPlacement()).toMatchObject({ kind: "preview", start: "9" });
  });
});
