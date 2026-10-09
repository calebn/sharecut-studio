import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEnvelope } from "../api/documentEdits";
import {
  registerClipboardCommands,
  registerClipMoveCommands,
  registerPrimaryEditingCommands,
} from "../commands/editing";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { registerProjectMediaCommands } from "../commands/projectMedia";
import {
  _resetMixLanesForTests,
  registerTrackMixCommands,
} from "../commands/trackMix";
import { _resetTrackMutateChainForTests } from "../commands/trackMutation";
import {
  applyDocumentSnapshot,
  mergeGuestActionDone,
  mergeReturnedComment,
  refreshDocumentDisplay,
} from "../document/applyDocumentUpdate";
import { documentAuthority } from "../document/authorityState";
import {
  currentDocumentSeq,
  resetDocumentSeqForTests,
} from "../document/cursor";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../document/pendingDrafts";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { type NudgeField, saveNudge } from "../edit/nudge";
import { useTrackMetaMutation } from "../hooks/useTrackMetaMutation";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { TimelineComment } from "../types/project";
import { useNudgeRun } from "./useNudgeRun";

vi.mock("../edit/nudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edit/nudge")>()),
  saveNudge: vi.fn(async () => true),
}));
vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(async () => ({})),
}));
const field: NudgeField = {
  kind: "trim",
  trackId: "host",
  clipId: "anchor",
  edge: "out",
};
function Harness({ delta = -0.01 }: { delta?: number }) {
  const run = useNudgeRun();
  return <button {...run.buttonProps(field, delta, "Trim end")}>Nudge</button>;
}

describe("refused trim nudges", () => {
  beforeEach(() => {
    vi.mocked(saveNudge).mockClear();
  });
  it.each(["edited", "peer"])(
    "keeps and saves the last valid %s lane preview",
    async (placement) => {
      const anchor = clipRow({
        id: "anchor",
        source_end: 10,
        timeline_end: 10,
      });
      const follower = clipRow({
        id: "follower",
        track_id: placement === "edited" ? "host" : "guest",
        timeline_start: 0.015,
        timeline_end: 19.015,
        source_start: 0,
        source_end: 19,
        source_id: "alt",
        recording_key: "alt",
        fade_in_ms: 17,
      });
      const origin = minimalProject({
        tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
        clips: {
          tracks: {
            host: placement === "edited" ? [anchor, follower] : [anchor],
            guest:
              placement === "peer"
                ? [
                    clipRow({ ...anchor, id: "peer", track_id: "guest" }),
                    follower,
                  ]
                : [],
          },
          clip_count: placement === "peer" ? 3 : 2,
        },
      });
      useDawStore.getState().hydrate("/tmp/nudge.project.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const valid = useDawStore.getState().project;
      expect(
        valid?.clips.tracks[follower.track_id].find((c) => c.id === "follower"),
      ).toMatchObject({
        timeline_start: expect.closeTo(0.005, 9),
        source_start: 0,
        source_end: 19,
        fade_in_ms: 17,
      });
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(valid);
      expect(useDawStore.getState().statusAnnouncement).toContain(
        "before the timeline starts",
      );
      expect(saveNudge).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.keyUp(button, { key: "Enter" });
      });
      await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
      expect(saveNudge).toHaveBeenCalledWith(
        "/tmp/nudge.project.json",
        origin,
        field,
        9.99,
      );
    },
  );
  it("classifies each accepted step from the saved lane", async () => {
    const anchor = clipRow({
      id: "anchor",
      source_start: 0,
      source_end: 10,
      timeline_end: 10,
    });
    const nested = clipRow({
      id: "nested",
      timeline_start: 1,
      timeline_end: 9,
      source_start: 0,
      source_end: 8,
      source_id: "alt",
      recording_key: "alt",
    });
    const origin = minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [anchor, nested] }, clip_count: 2 },
    });
    useDawStore.getState().hydrate("/tmp/nudge.project.json", origin);
    const { getByRole } = render(<Harness delta={-1} />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(useDawStore.getState().project?.clips.tracks.host).toEqual([
      { ...anchor, source_end: 7, timeline_end: 7 },
      nested,
    ]);
    await act(async () => {
      fireEvent.keyUp(button, { key: "Enter" });
    });
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/nudge.project.json",
      origin,
      field,
      7,
    );
  });
});

describe("trim nudge document lifetime", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    vi.mocked(saveNudge).mockReset().mockResolvedValue(true);
    vi.mocked(submitQueuedDocumentCommand).mockReset().mockResolvedValue({});
    clearRegisteredCommands();
    _resetTrackMutateChainForTests();
  });

  afterEach(() => _resetMixLanesForTests());

  function project() {
    return minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: {
        tracks: {
          host: [
            clipRow({
              id: "anchor",
              track_id: "host",
              source_end: 10,
              timeline_end: 10,
            }),
            clipRow({
              id: "follower",
              track_id: "host",
              source_start: 10,
              source_end: 20,
              timeline_start: 9.9996,
              timeline_end: 19.9996,
            }),
          ],
        },
        clip_count: 2,
      },
    });
  }

  function initializeCommentProject(followerStart = 9.9996) {
    const comment: TimelineComment = {
      id: "review",
      body: "Keep this phrase",
      author: "Guest",
      created_at: "2026-10-09T18:00:00Z",
      updated_at: null,
      timeline_start: 2,
      timeline_end: null,
      track_ids: ["host"],
      action_items: [
        {
          id: "action",
          text: "Check the join",
          done: false,
          completed_at: null,
          completed_by: null,
        },
      ],
      replies: [],
      resolved: false,
      resolved_at: null,
      resolved_by: null,
    };
    const origin = { ...project(), comments: [comment] };
    origin.clips.tracks.host[1]!.timeline_start = followerStart;
    origin.clips.tracks.host[1]!.timeline_end = followerStart + 10;
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    applyDocumentSnapshot({ server_seq: 4, project: origin });
    return { origin, comment };
  }

  const actors = [
    "none",
    "music move",
    "anchor move",
    "mix",
    "meta",
    "envelope",
  ] as const;
  it.each(
    actors.flatMap((actor) =>
      ["repeat", "release", "unmount"].map((ending) => ({ actor, ending })),
    ),
  )(
    "removes held trim through $actor and $ending while retaining the comment and pending edit",
    async ({ actor, ending }) => {
      const { origin, comment } = initializeCommentProject();
      origin.tracks.push(sampleTrack({ id: "music", role: "music" }));
      origin.clips.tracks.music = [
        clipRow({
          id: "music-clip",
          track_id: "music",
          timeline_start: 1,
          timeline_end: 11,
          source_end: 10,
        }),
      ];
      origin.clips.clip_count = 3;
      const { getByRole, unmount } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      if (actor === "music move" || actor === "anchor move") {
        beginDocumentDraft("actor", "MoveClips", {
          clips: [
            {
              clip_id: actor === "music move" ? "music-clip" : "anchor",
              track_id: actor === "music move" ? "music" : "host",
              timeline_start: actor === "music move" ? 2 : 0,
            },
          ],
        });
      } else if (actor === "mix")
        beginDocumentDraft("actor", "SetTrackFader", {
          track_id: "host",
          fader_db: -3,
        });
      else if (actor === "meta")
        beginDocumentDraft("actor", "SetTrackMeta", {
          track_id: "host",
          label: "Renamed",
        });
      else if (actor === "envelope")
        beginDocumentDraft("actor", "SetEnvelope", {
          track_id: "host",
          points: [{ id: "p", time: 1, value: 0.5 }],
        });
      mergeReturnedComment({ ...comment, body: "New returned comment" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(10);
      if (ending === "repeat")
        fireEvent.keyDown(button, { key: "Enter", repeat: true });
      await act(async () => {
        if (ending === "unmount") unmount();
        else fireEvent.keyUp(button, { key: "Enter" });
      });
      const shown = useDawStore.getState().project!;
      expect(shown.clips.tracks.host).toMatchObject([
        { id: "anchor", source_end: 10, timeline_start: 0, timeline_end: 10 },
        {
          id: "follower",
          source_start: 10,
          source_end: 20,
          timeline_start: 9.9996,
          timeline_end: 19.9996,
        },
      ]);
      expect(shown.comments[0]?.body).toBe("New returned comment");
      expect(shown.clips.tracks.music[0]).toMatchObject({
        source_end: 10,
        timeline_start: actor === "music move" ? 2 : 1,
        timeline_end: actor === "music move" ? 12 : 11,
      });
      if (actor === "mix") expect(shown.tracks[0]?.fader_db).toBe(-3);
      if (actor === "meta") expect(shown.tracks[0]?.label).toBe("Renamed");
      if (actor === "envelope")
        expect(shown.envelopes[0]?.points).toEqual([
          { id: "p", time: 1, value: 0.5 },
        ]);
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("queued envelope response publishes clean geometry and cancels the hold before WS", async () => {
    const { comment } = initializeCommentProject();
    mergeReturnedComment({ ...comment, body: "Already returned" });
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValueOnce({
      queued: true,
    });
    await setEnvelope(
      "/tmp/one.json",
      "host",
      [{ id: "p", time: 1, value: 0.5 }],
      [],
    );
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(10);
    expect(useDawStore.getState().project?.comments[0]?.body).toBe(
      "Already returned",
    );
    expect(useDawStore.getState().project?.envelopes[0]?.points).toEqual([
      { id: "p", time: 1, value: 0.5 },
    ]);
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it.each(["move", "reorder", "metadata", "mix"] as const)(
    "a real %s writer removes trim geometry and uses a clean rollback baseline",
    async (writer) => {
      const { origin, comment } = initializeCommentProject();
      origin.tracks.push(sampleTrack({ id: "music", role: "music" }));
      mergeReturnedComment({ ...comment, body: "Returned before hold" });
      const button = render(<Harness />).getByRole("button");
      const meta = renderHook(() => useTrackMetaMutation("host"));
      fireEvent.keyDown(button, { key: "Enter" });
      const pending = deferred<Record<string, unknown>>();
      vi.mocked(submitQueuedDocumentCommand).mockReturnValueOnce(
        pending.promise,
      );
      let send!: Promise<unknown>;
      await act(async () => {
        if (writer === "move") {
          registerClipMoveCommands();
          send = execute(
            "edit.moveClips",
            {
              clips: [
                { clip_id: "anchor", track_id: "music", timeline_start: 3 },
              ],
            },
            { skipWhen: true },
          );
        } else if (writer === "reorder") {
          registerProjectMediaCommands();
          send = execute(
            "track.reorder",
            { trackId: "music", index: 0 },
            { skipWhen: true },
          );
        } else if (writer === "metadata")
          send = meta.result.current.saveMetaFields({ label: "New host" });
        else {
          registerTrackMixCommands();
          send = execute(
            "track.muteToggle",
            { trackId: "host" },
            { skipWhen: true },
          );
        }
      });
      const shown = useDawStore.getState().project!;
      const anchor = Object.values(shown.clips.tracks)
        .flat()
        .find((clip) => clip.id === "anchor");
      expect(anchor).toMatchObject({
        source_start: 0,
        source_end: 10,
        timeline_start: writer === "move" ? 3 : 0,
        timeline_end: writer === "move" ? 13 : 10,
      });
      expect(shown.comments[0]?.body).toBe("Returned before hold");
      if (writer === "move") expect(anchor?.track_id).toBe("music");
      if (writer === "reorder")
        expect(shown.tracks.map((track) => track.id)).toEqual([
          "music",
          "host",
        ]);
      if (writer === "metadata")
        expect(shown.tracks[0]?.label).toBe("New host");
      if (writer === "mix") expect(shown.tracks[0]?.muted).toBe(true);
      await act(async () => {
        pending.reject(new Error("Writer failed"));
        await send;
      });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0],
      ).toMatchObject({ source_end: 10, timeline_start: 0, timeline_end: 10 });
      expect(useDawStore.getState().project?.comments[0]?.body).toBe(
        "Returned before hold",
      );
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("keeps earlier unsequenced comments, action results and metadata across a second hold before WS", async () => {
    const { comment } = initializeCommentProject();
    const first = render(<Harness />);
    fireEvent.keyDown(first.getByRole("button"), { key: "Enter" });
    mergeReturnedComment({ ...comment, body: "Comment A" });
    await act(async () => first.unmount());
    const second = render(<Harness />);
    fireEvent.keyDown(second.getByRole("button"), { key: "Enter" });
    mergeReturnedComment({ ...comment, id: "second", body: "Comment B" });
    mergeGuestActionDone("review", "action", true);
    applyDocumentSnapshot({
      patch: { meta: { name: "New name", workspace_dir: "/tmp/one" } },
    });
    const shown = useDawStore.getState().project!;
    expect(shown.comments.map((row) => row.body)).toEqual([
      "Comment A",
      "Comment B",
    ]);
    expect(shown.comments[0]?.action_items[0]?.done).toBe(true);
    expect(shown.meta.name).toBe("New name");
    expect(shown.clips.tracks.host[0]?.source_end).toBe(10);
    expect(documentAuthority.project?.comments[0]?.body).toBe(
      "Keep this phrase",
    );
    await act(async () => second.unmount());
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it.each([-0.01, 0.01])(
    "detaches a splice with delta %s while retaining a same-lane absolute move and source payloads",
    async (delta) => {
      const { origin, comment } = initializeCommentProject();
      origin.tracks.push(sampleTrack({ id: "guest" }));
      origin.clips.tracks.host = [
        { ...origin.clips.tracks.host[0]!, source_duration_sec: 60 },
      ];
      const wide = clipRow({
        id: "wide",
        track_id: "guest",
        source_start: 20,
        source_end: 24,
        timeline_start: 8,
        timeline_end: 12,
        source_id: "take2",
        recording_key: "record2",
        origin_track_id: "original-guest",
        source_duration_sec: 80,
        fade_in_ms: 17,
        fade_out_ms: 23,
        join_in_mode: "crossfade",
        mute_regions: [{ start_s: 20.2, end_s: 20.4 }],
        clipping_regions: [{ start_s: 23, end_s: 23.2 }],
        clipping_truncated: true,
      });
      const covered = clipRow({
        id: "covered",
        track_id: "guest",
        source_start: 50,
        source_end: 50.006,
        timeline_start: 9.992,
        timeline_end: 9.998,
      });
      const other = clipRow({
        id: "other",
        track_id: "guest",
        source_start: 60,
        source_end: 62,
        timeline_start: 14,
        timeline_end: 16,
      });
      origin.clips.tracks.guest = [wide, covered, other];
      origin.clips.clip_count = 4;
      const button = render(<Harness delta={delta} />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const preview = useDawStore.getState().project!.clips.tracks.guest;
      expect(preview.find((clip) => clip.id === "wide:tail")).toMatchObject({
        source_end: 24,
        timeline_start: delta < 0 ? 9.99 : 10.01,
      });
      expect(preview.find((clip) => clip.id === "wide")).toMatchObject({
        source_start: 20,
        source_end: expect.closeTo(delta < 0 ? 21.99 : 22, 9),
      });
      if (delta < 0)
        expect(preview.some((clip) => clip.id === "covered")).toBe(false);
      beginDocumentDraft("other move", "MoveClips", {
        clips: [{ clip_id: "other", track_id: "guest", timeline_start: 18 }],
      });
      mergeReturnedComment({ ...comment, body: "Current comment" });
      const shown = useDawStore.getState().project!;
      expect(shown.clips.tracks.guest).toEqual([
        wide,
        covered,
        { ...other, timeline_start: 18, timeline_end: 20 },
      ]);
      expect(shown.comments[0]?.body).toBe("Current comment");
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("rejects a preview-only tail move before submission or pending bookkeeping", async () => {
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
      }),
    ];
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    expect(
      useDawStore
        .getState()
        .project?.clips.tracks.guest.some((clip) => clip.id === "wide:tail"),
    ).toBe(true);
    registerClipMoveCommands();
    const result = await execute(
      "edit.moveClips",
      {
        clips: [
          { clip_id: "wide:tail", track_id: "guest", timeline_start: 18 },
        ],
      },
      { skipWhen: true },
    );
    expect(result.status).toBe("disabled");
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(9.98);
  });

  it.each(["edit.copy", "edit.cut", "edit.delete", "edit.rippleDelete"])(
    "%s rejects a preview-only split target without sending or copying it",
    async (command) => {
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
        }),
      ];
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      expect(
        useDawStore
          .getState()
          .project?.clips.tracks.guest.some((clip) => clip.id === "wide:tail"),
      ).toBe(true);
      useDawStore
        .getState()
        .setSelection({ kind: "clip", trackId: "guest", id: "wide:tail" });
      setClipboard(null);
      registerClipboardCommands();
      registerPrimaryEditingCommands();
      const result = await execute(command, {}, { skipWhen: true });
      expect(result.status).toBe("disabled");
      expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
      expect(getClipboard()).toBeNull();
    },
  );

  it("copy uses the clean original clip duration during a held trim", async () => {
    initializeCommentProject();
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    useDawStore
      .getState()
      .setSelection({ kind: "clip", trackId: "host", id: "anchor" });
    registerClipboardCommands();
    expect((await execute("edit.copy", {}, { skipWhen: true })).status).toBe(
      "ok",
    );
    expect(getClipboard()?.timelineEnd).toBe(10);
  });

  it("unchanged pending mix permits normal trim steps, and a genuine fader update cancels them", async () => {
    vi.useFakeTimers();
    try {
      initializeCommentProject();
      registerTrackMixCommands();
      const mix = execute(
        "track.setVolume",
        { trackId: "host", db: -3 },
        { skipWhen: true },
      );
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.98);
      expect(useDawStore.getState().project?.tracks[0]?.fader_db).toBe(-3);
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).toHaveBeenCalledOnce();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
        await mix;
      });
      vi.mocked(saveNudge).mockClear();
      fireEvent.keyDown(button, { key: "Enter" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.97);
      const updated = execute(
        "track.setVolume",
        { trackId: "host", db: -6 },
        { skipWhen: true },
      );
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.98);
      expect(useDawStore.getState().project?.tracks[0]?.fader_db).toBe(-6);
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
        await updated;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("same-path hydration cancels before release even with unchanged authority and epoch", async () => {
    const { origin } = initializeCommentProject();
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(10);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it.each([
    { id: "anchor", lane: "host", sourceStart: 0, sourceEnd: 10 },
    { id: "anchor", lane: "music", sourceStart: 0, sourceEnd: 10 },
    { id: "follower", lane: "host", sourceStart: 10, sourceEnd: 20 },
    { id: "follower", lane: "music", sourceStart: 10, sourceEnd: 20 },
  ])(
    "retains an actual absolute $id move to $lane without trim geometry",
    async ({ id, lane, sourceStart, sourceEnd }) => {
      const { origin, comment } = initializeCommentProject();
      origin.tracks.push(sampleTrack({ id: "music", role: "music" }));
      origin.clips.tracks.music = [];
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      beginDocumentDraft("actual move", "MoveClips", {
        clips: [{ clip_id: id, track_id: lane, timeline_start: 30 }],
      });
      mergeReturnedComment({ ...comment, body: "Latest returned comment" });
      expect(
        useDawStore
          .getState()
          .project?.clips.tracks[lane]?.find((clip) => clip.id === id),
      ).toMatchObject({
        track_id: lane,
        source_start: sourceStart,
        source_end: sourceEnd,
        timeline_start: 30,
        timeline_end: 40,
      });
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(useDawStore.getState().project?.comments[0]?.body).toBe(
        "Latest returned comment",
      );
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["acknowledged", "failed"])(
    "a pending move registered before begin stays clean when %s",
    async (outcome) => {
      initializeCommentProject();
      beginDocumentDraft("existing move", "MoveClips", {
        clips: [{ clip_id: "anchor", track_id: "host", timeline_start: 2 }],
      });
      refreshDocumentDisplay();
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0],
      ).toMatchObject({
        source_end: 9.99,
        timeline_start: 2,
        timeline_end: 11.99,
      });
      finishDocumentDraft("existing move");
      if (outcome === "acknowledged") {
        const basis = documentAuthority.project!;
        applyDocumentSnapshot({
          server_seq: 5,
          project: {
            ...basis,
            clips: {
              ...basis.clips,
              tracks: {
                host: [
                  {
                    ...basis.clips.tracks.host[0]!,
                    timeline_start: 2,
                    timeline_end: 12,
                  },
                  basis.clips.tracks.host[1]!,
                ],
              },
            },
          },
        });
      } else refreshDocumentDisplay();
      expect(
        useDawStore.getState().project?.clips.tracks.host[0],
      ).toMatchObject({
        source_end: 10,
        timeline_start: outcome === "acknowledged" ? 2 : 0,
        timeline_end: outcome === "acknowledged" ? 12 : 10,
      });
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  const localMerges = ["action", "returned comment", "metadata"] as const;
  function mergeLocal(
    change: (typeof localMerges)[number],
    comment: TimelineComment,
  ) {
    if (change === "action") mergeGuestActionDone("review", "action", true);
    else if (change === "returned comment") {
      mergeReturnedComment({ ...comment, body: "Keep the whole phrase" });
    } else {
      applyDocumentSnapshot({
        patch: { meta: { name: "Updated name", workspace_dir: "/tmp/new" } },
      });
    }
  }

  it.each(localMerges)(
    "removes only its trim preview after a local %s merge on repeat and release",
    async (change) => {
      const { origin, comment } = initializeCommentProject();
      const authority = documentAuthority.project;
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      mergeLocal(change, comment);
      const merged = useDawStore.getState().project;
      expect(currentDocumentSeq()).toBe(4);
      expect(documentAuthority.project).toBe(authority);
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(useDawStore.getState().project).toEqual({
        ...merged,
        clips: origin.clips,
      });
      expect(useDawStore.getState().project?.clips.tracks.host).toMatchObject([
        { id: "anchor", source_end: 10, timeline_end: 10 },
        {
          id: "follower",
          source_start: 10,
          source_end: 20,
          timeline_start: 9.9996,
          timeline_end: 19.9996,
        },
      ]);
      if (change === "action")
        expect(
          useDawStore.getState().project?.comments[0]?.action_items[0]?.done,
        ).toBe(true);
      else if (change === "returned comment")
        expect(useDawStore.getState().project?.comments[0]?.body).toBe(
          "Keep the whole phrase",
        );
      else
        expect(useDawStore.getState().project?.meta.name).toBe("Updated name");
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["release", "unmount"])(
    "removes its preview on %s without a repeat after a returned comment",
    async (ending) => {
      const { origin, comment } = initializeCommentProject();
      const { getByRole, unmount } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      mergeReturnedComment({ ...comment, body: "Keep the whole phrase" });
      await act(async () => {
        if (ending === "release") fireEvent.keyUp(button, { key: "Enter" });
        else unmount();
      });
      expect(useDawStore.getState().project?.clips).toEqual(origin.clips);
      expect(useDawStore.getState().project?.comments[0]?.body).toBe(
        "Keep the whole phrase",
      );
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["action", "returned comment"] as const)(
    "removes its preview after a local %s merge before delayed pointer cancel and click",
    async (change) => {
      const { origin, comment } = initializeCommentProject();
      const button = render(<Harness />).getByRole("button");
      const user = userEvent.setup();
      await user.pointer({ target: button, keys: "[MouseLeft>]" });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      mergeLocal(change, comment);
      const merged = useDawStore.getState().project;
      await act(
        async () => new Promise((resolve) => setTimeout(resolve, 1100)),
      );
      fireEvent.pointerCancel(button, { pointerId: 1 });
      await user.pointer({ target: button, keys: "[/MouseLeft]" });
      expect(useDawStore.getState().project).toEqual({
        ...merged,
        clips: origin.clips,
      });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(10);
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("keeps comments after an initially refused negative trim without an owned preview", async () => {
    const { origin, comment } = initializeCommentProject(0.005);
    const button = render(<Harness />).getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    expect(useDawStore.getState().statusAnnouncement).toContain(
      "before the timeline starts",
    );
    expect(
      useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
    ).toBe(10);
    mergeGuestActionDone(comment.id, "action", true);
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(useDawStore.getState().project?.clips).toEqual(origin.clips);
    expect(
      useDawStore.getState().project?.comments[0]?.action_items[0]?.done,
    ).toBe(true);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it.each([
    "local geometry",
    "new sequence",
    "same-sequence authority",
    "project generation",
  ])(
    "preserves replacement geometry after %s instead of rolling back",
    async (change) => {
      const { origin, comment } = initializeCommentProject();
      const button = render(<Harness />).getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const preview = useDawStore.getState().project!;
      const fresh = {
        ...preview,
        meta: { ...preview.meta, name: "Fresh geometry" },
      };
      if (change === "local geometry") {
        applyDocumentSnapshot({
          patch: {
            clips: {
              ...origin.clips,
              tracks: {
                host: [
                  clipRow({ id: "anchor", source_end: 8, timeline_end: 8 }),
                ],
              },
            },
          },
        });
      } else if (change === "project generation") {
        act(() => {
          useDawStore.getState().hydrate("/tmp/two.json", origin);
          useDawStore.getState().hydrate("/tmp/one.json", fresh);
        });
      } else {
        applyDocumentSnapshot({
          server_seq: change === "new sequence" ? 5 : 4,
          project: fresh,
        });
      }
      mergeReturnedComment({
        ...comment,
        body: "New comment with fresh geometry",
      });
      const replacement = useDawStore.getState().project;
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(useDawStore.getState().project).toBe(replacement);
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(change === "local geometry" ? 8 : 9.99);
      expect(useDawStore.getState().project?.comments[0]?.body).toBe(
        "New comment with fresh geometry",
      );
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it.each(["metadata", "follower geometry"])(
    "keeps an authoritative %s update through repeat and release",
    async (change) => {
      const origin = project();
      useDawStore.getState().hydrate("/tmp/one.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const fresh = structuredClone(origin);
      if (change === "metadata") fresh.meta.name = "Committed name";
      else fresh.clips.tracks.host[1]!.timeline_start = 8;
      applyDocumentSnapshot({ server_seq: 1, project: fresh });
      const authoritative = useDawStore.getState().project;
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(authoritative);
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("discards a replacement snapshot at the current document sequence", () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    applyDocumentSnapshot({ server_seq: 1, project: origin });
    const fresh = {
      ...origin,
      meta: { ...origin.meta, name: "Same sequence" },
    };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    const authoritative = useDawStore.getState().project;
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(useDawStore.getState().project).toBe(authoritative);
    expect(useDawStore.getState().project?.meta.name).toBe("Same sequence");
  });

  it.each(["new project", "switch away and back"])(
    "does not publish or save after %s during a held trim",
    async (change) => {
      const origin = project();
      useDawStore.getState().hydrate("/tmp/one.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const fresh = {
        ...origin,
        meta: { ...origin.meta, name: "Fresh project" },
      };
      if (change === "new project") {
        act(() => useDawStore.getState().hydrate("/tmp/two.json", fresh));
      } else {
        act(() => {
          useDawStore.getState().hydrate("/tmp/two.json", project());
          useDawStore.getState().hydrate("/tmp/one.json", fresh);
        });
      }
      const authoritative = useDawStore.getState().project;
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(authoritative);
      await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
      expect(saveNudge).not.toHaveBeenCalled();
    },
  );

  it("does not save on release when an update arrives before the next repeat", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    expect(useDawStore.getState().project?.meta.name).toBe("Fresh");
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it("cancels a pending pointer repeat when a snapshot replaces the project", async () => {
    vi.useFakeTimers();
    try {
      const origin = project();
      useDawStore.getState().hydrate("/tmp/one.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
      expect(
        useDawStore.getState().project?.clips.tracks.host[0]?.source_end,
      ).toBe(9.99);
      expect(vi.getTimerCount()).toBe(1);
      const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
      applyDocumentSnapshot({ server_seq: 1, project: fresh });
      const authoritative = useDawStore.getState().project;
      await act(async () => vi.advanceTimersByTime(500));
      expect(useDawStore.getState().project).toBe(authoritative);
      expect(vi.getTimerCount()).toBe(0);
      fireEvent.pointerUp(button, { pointerId: 1 });
      expect(saveNudge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows the release click after a repeated pointer run becomes stale", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    const user = userEvent.setup();
    await user.pointer({ target: button, keys: "[MouseLeft>]" });
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
    const authoritative = useDawStore.getState().project;
    expect(authoritative?.meta.name).toBe("Fresh");
    await user.pointer({ target: button, keys: "[/MouseLeft]" });
    expect(useDawStore.getState().project).toBe(authoritative);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it("swallows a stale pointer release click after switching projects", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    const user = userEvent.setup();
    await user.pointer({ target: button, keys: "[MouseLeft>]" });
    const fresh = { ...project(), meta: { ...origin.meta, name: "Other" } };
    act(() => useDawStore.getState().hydrate("/tmp/two.json", fresh));
    await user.pointer({ target: button, keys: "[/MouseLeft]" });
    expect(useDawStore.getState().project).toBe(fresh);
    expect(saveNudge).not.toHaveBeenCalled();
  });

  it("saves valid pointer and assistive click nudges once", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole, unmount } = render(<Harness />);
    const button = getByRole("button");
    const user = userEvent.setup();
    await user.pointer({ target: button, keys: "[MouseLeft>]" });
    await user.pointer({ target: button, keys: "[/MouseLeft]" });
    expect(saveNudge).toHaveBeenCalledOnce();
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/one.json",
      origin,
      field,
      9.99,
    );

    vi.mocked(saveNudge).mockClear();
    unmount();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const assistive = render(<Harness />).getByRole("button");
    fireEvent.click(assistive, { detail: 0 });
    await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/one.json",
      origin,
      field,
      9.99,
    );
  });

  it("saves a keyboard nudge once without restarting from its generated click", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const button = render(<Harness />).getByRole("button");
    button.focus();
    await userEvent.setup().keyboard("{Enter}");
    await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/one.json",
      origin,
      field,
      9.99,
    );
  });

  it("does not restore its preview when a pending save rejects after an update", async () => {
    let rejectSave!: (error: Error) => void;
    vi.mocked(saveNudge).mockReturnValueOnce(
      new Promise<boolean>((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole } = render(<Harness />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    await act(async () => fireEvent.keyUp(button, { key: "Enter" }));
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => rejectSave(new Error("stale")));
    expect(useDawStore.getState().project?.meta.name).toBe("Fresh");
  });

  it("discards the run on unmount after an authoritative update", async () => {
    const origin = project();
    useDawStore.getState().hydrate("/tmp/one.json", origin);
    const { getByRole, unmount } = render(<Harness />);
    fireEvent.keyDown(getByRole("button"), { key: "Enter" });
    const fresh = { ...origin, meta: { ...origin.meta, name: "Fresh" } };
    applyDocumentSnapshot({ server_seq: 1, project: fresh });
    await act(async () => unmount());
    expect(useDawStore.getState().project?.meta.name).toBe("Fresh");
    expect(saveNudge).not.toHaveBeenCalled();
  });
});
