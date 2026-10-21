import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { loadDocumentState } from "../api/project";
import { useProjectBootstrap } from "../hooks/useProjectBootstrap";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { movingLikeTheQueue } from "../test/queueDraft";
import {
  type ClipRow,
  type HistoryEntryId,
  parseHistoryEntryId,
  type TrackView,
} from "../types/project";
import { ApiError } from "../utils/apiError";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetTrackMutateChainForTests,
  registerDawCommands,
} from "./register";
import { enqueueTrackMutate } from "./trackMutation";

vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));

vi.mock("../api", () => ({
  moveClips: vi.fn(async () => null),
}));

function track(id: string): TrackView {
  return {
    id,
    label: id,
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 20,
    fx_count: 0,
    stem_is_fresh: true,
  };
}

function clip(id: string, trackId: string, start: number): ClipRow {
  return {
    id,
    track_id: trackId,
    source_start: 0,
    source_end: 2,
    timeline_start: start,
    timeline_end: start + 2,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    source_duration_sec: null,
    recording_key: null,
  };
}

describe("edit.moveClips", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetTrackMutateChainForTests();
    vi.mocked(api.moveClips).mockClear();
    vi.mocked(api.moveClips).mockImplementation(
      movingLikeTheQueue(async () => null),
    );
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host"), track("guest")],
        clips: {
          clip_count: 1,
          tracks: {
            host: [clip("c1", "host", 0)],
            guest: [],
          },
        },
      }),
    );
    useDawStore.setState({
      guestMode: null,
      shareCapabilities: null,
      feedbackToast: null,
      statusAnnouncement: "",
    });
    vi.mocked(loadDocumentState).mockReset();
  });

  it("preserves placement while a coupled join save is in flight", async () => {
    const before = useDawStore.getState().project;
    useDawStore.getState().setJoinMutationInFlight(true);
    try {
      const result = await execute(
        "edit.moveClips",
        { clips: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }] },
        { skipWhen: true },
      );
      expect(result).toEqual({
        status: "disabled",
        reason: "Wait for the join change to finish",
      });
      expect(useDawStore.getState().project).toBe(before);
      expect(api.moveClips).not.toHaveBeenCalled();
    } finally {
      useDawStore.getState().setJoinMutationInFlight(false);
    }
  });

  it("patches then submits MoveClips", async () => {
    useDawStore.getState().setSelection({
      kind: "clip",
      id: "c1",
      trackId: "host",
    });
    const r = await execute(
      "edit.moveClips",
      {
        clips: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }],
      },
      { skipWhen: true },
    );
    expect(r.status).toBe("ok");
    expect(api.moveClips).toHaveBeenCalledWith("/tmp/ep", [
      { clip_id: "c1", timeline_start: 4, track_id: "guest" },
    ]);
    const moved = useDawStore
      .getState()
      .project?.clips.tracks.guest?.find((c) => c.id === "c1");
    expect(moved?.timeline_start).toBe(4);
    expect(moved?.origin_track_id).toBe("host");
    expect(useDawStore.getState().project?.clips.tracks.host).toEqual([]);
    expect(useDawStore.getState().selection).toEqual({
      kind: "clip",
      id: "c1",
      trackId: "guest",
    });
  });

  it("reverts the optimistic patch when the command fails", async () => {
    vi.mocked(api.moveClips).mockImplementationOnce(
      movingLikeTheQueue(() => Promise.reject(new Error("nope"))),
    );
    const before = useDawStore.getState().project;
    const r = await execute(
      "edit.moveClips",
      {
        clips: [{ clip_id: "c1", timeline_start: 9, track_id: "host" }],
      },
      { skipWhen: true },
    );
    expect(r.status).toBe("disabled");
    expect(useDawStore.getState().project).toBe(before);
  });
  it.each(["move-own", null])(
    "binds nearby Undo only to its reply id %s despite a displayed peer head",
    async (replyId) => {
      const held = deferred();
      vi.mocked(api.moveClips).mockImplementationOnce(
        movingLikeTheQueue(() => held.promise),
      );
      const moving = execute("edit.moveClips", moves, { skipWhen: true });
      await vi.waitFor(() => expect(api.moveClips).toHaveBeenCalledTimes(1));
      const project = useDawStore.getState().project!;
      useDawStore.getState().setProject({
        ...project,
        history: {
          ...project.history!,
          head_id: parseHistoryEntryId("peer-edit")!,
        },
      });
      held.resolve(parseHistoryEntryId(replyId));
      expect((await moving).status).toBe("ok");
      expect(useDawStore.getState().feedbackToast).toMatchObject({
        message: "Moved clips",
        undo: replyId,
        baseHead: "peer-edit",
      });
      expect(
        useDawStore.getState().project?.clips.tracks.guest[0].timeline_start,
      ).toBe(4);
    },
  );
  it("keeps an editor server refusal recoverable without Undo", async () => {
    useDawStore
      .getState()
      .hydrate("share:episode", useDawStore.getState().project, "edit", [
        "edit",
      ]);
    vi.mocked(api.moveClips).mockImplementationOnce(
      movingLikeTheQueue(() =>
        Promise.reject(new ApiError("Edits not allowed", "forbidden", 403)),
      ),
    );
    expect(await execute("edit.moveClips", moves, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "Edits not allowed",
    });
    expect(
      useDawStore.getState().project?.clips.tracks.host[0].timeline_start,
    ).toBe(0);
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Move failed: Edits not allowed",
      undo: null,
    });
  });
  it("refuses a move when edit permission is revoked while queued", async () => {
    const held = deferred();
    const blocker = enqueueTrackMutate(() => held.promise);
    useDawStore
      .getState()
      .hydrate("share:episode", useDawStore.getState().project, "edit", [
        "edit",
      ]);
    const moving = execute("edit.moveClips", moves, { skipWhen: true });
    useDawStore.setState({ guestMode: "view", shareCapabilities: [] });
    held.resolve(null);
    await blocker;
    expect(await moving).toEqual({
      status: "disabled",
      reason: "Edits not allowed",
    });
    expect(
      useDawStore.getState().project?.clips.tracks.host[0].timeline_start,
    ).toBe(0);
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(api.moveClips).not.toHaveBeenCalled();
  });
  const moves = {
    clips: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }],
  };
  function deferred() {
    let resolve!: (id: HistoryEntryId | null) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<HistoryEntryId | null>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }
  async function open(path: string) {
    const project = useDawStore.getState().project!;
    vi.mocked(loadDocumentState).mockResolvedValue({
      server_seq: 0,
      state_token: "a".repeat(64),
      project,
    });
    const hook = renderHook(() => useProjectBootstrap(path));
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(hook.result.current.error).toBeNull());
    return hook;
  }
  it.each(["switch", "reopen"])(
    "rejects queued moves after an opening %s",
    async (change) => {
      const hook = await open("/tmp/ep");
      const held = deferred();
      const blocker = enqueueTrackMutate(() => held.promise);
      const moving = execute("edit.moveClips", moves, { skipWhen: true });
      hook.unmount();
      const path = change === "switch" ? "/tmp/other" : "/tmp/ep";
      useDawStore.getState().hydrate(path, useDawStore.getState().project);
      const next = await open(path);
      const before = useDawStore.getState().project;
      held.resolve(null);
      await blocker;
      const result = await moving;
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.timeline_start,
      ).toBe(0);
      expect(useDawStore.getState().project).toBe(before);
      expect(result.status).toBe("disabled");
      expect(api.moveClips).not.toHaveBeenCalled();
      next.unmount();
    },
  );
  it.each([
    ["success", "reopen"],
    ["failure", "reopen"],
    ["success", "switch"],
    ["failure", "switch"],
  ])("ignores late %s after bootstrap %s", async (outcome, change) => {
    const hook = await open("/tmp/ep");
    const held = deferred();
    vi.mocked(api.moveClips).mockImplementationOnce(
      movingLikeTheQueue(() => held.promise),
    );
    const moving = execute("edit.moveClips", moves, { skipWhen: true });
    await vi.waitFor(() => expect(api.moveClips).toHaveBeenCalledTimes(1));
    const optimistic = useDawStore.getState().project;
    hook.unmount();
    const path = change === "switch" ? "/tmp/other" : "/tmp/ep";
    useDawStore.getState().hydrate(path, optimistic);
    const next = await open(path);
    useDawStore.getState().announceStatus("Reopened episode");
    if (outcome === "success") held.resolve(parseHistoryEntryId("move-own"));
    else held.reject(new Error("Late failure"));
    await moving;
    expect(useDawStore.getState().project).toBe(optimistic);
    expect(useDawStore.getState().statusAnnouncement).toBe("Reopened episode");
    expect(
      useDawStore.getState().project?.clips.tracks.guest[0]?.timeline_start,
    ).toBe(4);
    next.unmount();
  });
});
