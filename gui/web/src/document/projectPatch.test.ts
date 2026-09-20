import { describe, expect, it } from "vitest";
import { minimalProject, sampleComment } from "../test/fixtures";
import {
  commentFromCommandResult,
  mergeProjectPatch,
  patchTrackMeta,
  patchTracksOrder,
  projectFromDocumentSnapshot,
} from "./projectPatch";

describe("mergeProjectPatch", () => {
  it("keeps identity for keys omitted from the patch", () => {
    const prev = minimalProject();
    const next = mergeProjectPatch(prev, {
      transcript: { utterances: [] },
    });
    expect(next.tracks).toBe(prev.tracks);
    expect(next.clips).toBe(prev.clips);
    expect(next.transcript).not.toBe(prev.transcript);
  });

  it("replaces a clips-only patch without touching transcript or tracks identity", () => {
    const prev = minimalProject({
      transcript: {
        utterances: [
          { track_id: "host", speaker: "Host", text: "hi", start: 0, end: 1 },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, {
      patch: {
        clips: {
          tracks: {
            host: [
              {
                id: "c1",
                track_id: "host",
                source_start: 0,
                source_end: 10,
                timeline_start: 0,
                timeline_end: 10,
                fade_in_ms: 40,
                fade_out_ms: 8,
                join_in_mode: "fade",
                source_id: null,
              },
            ],
          },
          clip_count: 1,
        },
      },
    });
    expect(next?.transcript).toBe(prev.transcript);
    expect(next?.tracks).toBe(prev.tracks);
    expect(next?.render_status).toBe(prev.render_status);
    expect(next?.clips.clip_count).toBe(1);
  });

  it("replaces FX and envelopes one key at a time", () => {
    const prev = minimalProject();
    const fx = projectFromDocumentSnapshot(prev, {
      patch: {
        effects_by_track: {
          host: [{ effect: "agate", params: {}, bypass: true }],
        },
      },
    });
    expect(fx?.transcript).toBe(prev.transcript);
    expect(fx?.tracks).toBe(prev.tracks);
    expect(fx?.effects_by_track.host?.[0]?.bypass).toBe(true);
    const env = projectFromDocumentSnapshot(prev, {
      patch: {
        envelopes: [{ track_id: "host", parameter: "volume", points: [] }],
      },
    });
    expect(env?.transcript).toBe(prev.transcript);
    expect(env?.envelopes).toHaveLength(1);
  });
});

describe("patchTracksOrder / patchTrackMeta", () => {
  const three = () =>
    minimalProject({
      tracks: [
        {
          id: "a",
          label: "A",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 1,
          fx_count: 0,
          stem_is_fresh: true,
        },
        {
          id: "b",
          label: "B",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 1,
          fx_count: 0,
          stem_is_fresh: true,
        },
        {
          id: "c",
          label: "C",
          role: "dialogue",
          speaker: null,
          gain_db: 0,
          muted: false,
          duration_sec: 1,
          fx_count: 0,
          stem_is_fresh: true,
        },
      ],
    });

  it("splices tracks for display reorder", () => {
    const next = patchTracksOrder(three(), "c", 0);
    expect(next.tracks.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("patches one track label without replacing others", () => {
    const prev = three();
    const next = patchTrackMeta(prev, "b", { label: "Guest" });
    expect(next.tracks[0]).toBe(prev.tracks[0]);
    expect(next.tracks[1]?.label).toBe("Guest");
    expect(next.tracks[2]).toBe(prev.tracks[2]);
  });
});

describe("projectFromDocumentSnapshot", () => {
  it("merges comments-only snapshots", () => {
    const prev = minimalProject({ comments: [] });
    const next = projectFromDocumentSnapshot(prev, {
      comments: [sampleComment({ id: "c1", body: "hi" })],
    });
    expect(next?.tracks).toBe(prev.tracks);
    expect(next?.comments).toHaveLength(1);
  });

  it("overlays words onto a remapped shell utterance instead of keeping the old transcript", () => {
    const words = [
      {
        text: "hello",
        start: 0,
        end: 0.4,
        timeline_start: 0,
        timeline_end: 0.4,
      },
      {
        text: "world",
        start: 0.4,
        end: 0.8,
        timeline_start: 0.4,
        timeline_end: 0.8,
      },
    ];
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.8,
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            words,
          },
        ],
      },
      history: {
        cursor: 1,
        can_undo: true,
        can_redo: false,
        groups: [{ kind: "snapshot", title: "s" }],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.8,
            text: "hello world",
            timeline_start: 1.2,
            timeline_end: 2.0,
            mappable: true,
          },
        ],
      },
      history: { cursor: 1, can_undo: true, can_redo: false, groups: [] },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    const overlaid = next?.transcript?.utterances[0]?.words;
    expect(next?.transcript).not.toBe(prev.transcript);
    expect(next?.transcript?.utterances[0]?.timeline_start).toBe(1.2);
    expect(overlaid).toEqual([
      {
        text: "hello",
        start: 0,
        end: 0.4,
        timeline_start: 1.2,
        timeline_end: 1.6,
        mappable: true,
      },
      {
        text: "world",
        start: 0.4,
        end: 0.8,
        timeline_start: 1.6,
        timeline_end: 2.0,
        mappable: true,
      },
    ]);
    expect(overlaid).not.toBe(words);
    expect(next?.history.groups).toBe(prev.history.groups);
    expect(next?.meta.hydration?.transcript_words).toBe(true);
  });

  it("does not overlay chips when shell utterance text disagrees", () => {
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.8,
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            words: [
              { text: "hello", start: 0, end: 0.4, timeline_start: 0 },
              { text: "world", start: 0.4, end: 0.8, timeline_start: 0.4 },
            ],
          },
        ],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.8,
            text: "goodbye world",
            timeline_start: 0,
            timeline_end: 0.8,
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(next?.transcript?.utterances[0]?.text).toBe("goodbye world");
    expect(next?.meta.hydration?.transcript_words).toBe(false);
  });

  it("leaves unmatched restored utterances wordless and not fully hydrated", () => {
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0.4,
            end: 0.8,
            text: "world",
            words: [{ text: "world", start: 0.4, end: 0.8 }],
          },
        ],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        utterances: [
          {
            track_id: "host",
            speaker: "Host",
            start: 0,
            end: 0.4,
            text: "hello",
          },
          {
            track_id: "host",
            speaker: "Host",
            start: 0.4,
            end: 0.8,
            text: "world",
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(next?.transcript?.utterances[1]?.words?.[0]?.text).toBe("world");
    expect(next?.meta.hydration?.transcript_words).toBe(false);
  });

  it("replaces groups when snapshot.history includes them", () => {
    const prev = minimalProject({
      history: {
        cursor: 0,
        can_undo: false,
        can_redo: false,
        groups: [{ kind: "snapshot", title: "old" }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, {
      history: {
        cursor: 1,
        can_undo: true,
        can_redo: false,
        groups: [{ kind: "mutation", title: "set track meta · on host" }],
      },
    });
    expect(next?.history.groups).toEqual([
      { kind: "mutation", title: "set track meta · on host" },
    ]);
    expect(next?.history.cursor).toBe(1);
    expect(next?.history.can_undo).toBe(true);
    expect(next?.meta.hydration?.history_groups).toBe(true);
  });

  it("keeps previous groups when snapshot.history omits groups", () => {
    const prev = minimalProject({
      history: {
        cursor: 0,
        can_undo: false,
        can_redo: false,
        groups: [{ kind: "snapshot", title: "old" }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, {
      history: { cursor: 1, can_undo: true, can_redo: false },
    });
    expect(next?.history.groups).toEqual([{ kind: "snapshot", title: "old" }]);
    expect(next?.history.cursor).toBe(1);
  });

  it("applies history groups on top of a shell project snapshot", () => {
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      history: {
        cursor: 0,
        can_undo: false,
        can_redo: false,
        groups: [{ kind: "snapshot", title: "old" }],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
    });
    const next = projectFromDocumentSnapshot(prev, {
      project: shell,
      history: {
        cursor: 1,
        can_undo: true,
        can_redo: false,
        groups: [{ kind: "mutation", title: "add comment" }],
      },
    });
    expect(next?.history.groups).toEqual([
      { kind: "mutation", title: "add comment" },
    ]);
    expect(next?.meta.hydration?.history_groups).toBe(true);
  });

  it("marks history hydrated from Applied groups and keeps them across a shell poll", () => {
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
    });
    const withGroups = projectFromDocumentSnapshot(prev, {
      history: {
        cursor: 1,
        can_undo: true,
        can_redo: false,
        groups: [{ kind: "mutation", title: "add comment" }],
      },
    });
    expect(withGroups?.meta.hydration?.history_groups).toBe(true);
    expect(withGroups?.history.groups).toEqual([
      { kind: "mutation", title: "add comment" },
    ]);

    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      history: { cursor: 0, can_undo: false, can_redo: false, groups: [] },
    });
    const afterPoll = projectFromDocumentSnapshot(withGroups, {
      project: shell,
    });
    expect(afterPoll?.history.groups).toEqual([
      { kind: "mutation", title: "add comment" },
    ]);
    expect(afterPoll?.meta.hydration?.history_groups).toBe(true);
  });
});

describe("commentFromCommandResult", () => {
  it("reads handler result from the command payload", () => {
    expect(
      commentFromCommandResult({
        command: { payload: { result: { id: "c1", body: "x" } } },
      })?.id,
    ).toBe("c1");
  });
});
