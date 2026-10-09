import { act, fireEvent, render, renderHook } from "@testing-library/react";
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
import { resetDocumentSeqForTests } from "../document/cursor";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../document/pendingDrafts";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { saveNudge } from "../edit/nudge";
import { useTrackMetaMutation } from "../hooks/useTrackMetaMutation";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { clipRow, sampleTrack } from "../test/fixtures";
import { initializeCommentProject } from "../test/trimNudgeData";
import { Harness } from "../test/trimNudgeFixture";

vi.mock("../edit/nudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edit/nudge")>()),
  saveNudge: vi.fn(async () => true),
}));
vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(async () => ({})),
}));

describe("trim nudge document writers", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    vi.mocked(saveNudge).mockReset().mockResolvedValue(true);
    vi.mocked(submitQueuedDocumentCommand).mockReset().mockResolvedValue({});
    clearRegisteredCommands();
    _resetTrackMutateChainForTests();
  });

  afterEach(() => _resetMixLanesForTests());

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
});
