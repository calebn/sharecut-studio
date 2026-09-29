import { describe, expect, it } from "vitest";
import { minimalProject, sampleComment } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { transcriptSpanText } from "../utils/transcript";
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

  it("refuses the word overlay when the shell ignored words differ", () => {
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
              {
                text: "hello",
                start: 0,
                end: 0.4,
                timeline_start: 0,
                ignored: false,
              },
              {
                text: "world",
                start: 0.4,
                end: 0.8,
                timeline_start: 0.4,
                ignored: false,
              },
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
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            ignored_word_indices: [1],
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(next?.meta.hydration?.transcript_words).toBe(false);
  });

  it("keeps the word overlay when the shell ignored words match", () => {
    const words = [
      {
        text: "hello",
        start: 0,
        end: 0.4,
        timeline_start: 0,
        ignored: false,
        word_index: 0,
      },
      {
        text: "world",
        start: 0.4,
        end: 0.8,
        timeline_start: 0.4,
        ignored: true,
        word_index: 1,
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
            ignored_word_indices: [1],
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
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            ignored_word_indices: [1],
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeDefined();
    expect(next?.meta.hydration?.transcript_words).toBe(true);
  });

  it("refuses the word overlay when the shell locked words differ (#824 Undo after Return to automatic)", () => {
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
              {
                text: "hello",
                start: 0,
                end: 0.4,
                timeline_start: 0,
                word_index: 0,
              },
              {
                text: "world",
                start: 0.4,
                end: 0.8,
                timeline_start: 0.4,
                word_index: 1,
                suppressed: true,
                audibility_locked: false,
              },
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
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            locked_word_indices: [1],
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(next?.meta.hydration?.transcript_words).toBe(false);
  });

  it("keeps the word overlay when the shell locked words match", () => {
    const words = [
      {
        text: "hello",
        start: 0,
        end: 0.4,
        timeline_start: 0,
        word_index: 0,
      },
      {
        text: "world",
        start: 0.4,
        end: 0.8,
        timeline_start: 0.4,
        word_index: 1,
        suppressed: true,
        audibility_locked: true,
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
            locked_word_indices: [1],
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
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            locked_word_indices: [1],
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeDefined();
    expect(next?.meta.hydration?.transcript_words).toBe(true);
  });

  it("refuses the word overlay when a row's edge-suppressed attachment changes", () => {
    const utterance = {
      track_id: "host",
      speaker: "Host",
      start: 0.5,
      end: 0.9,
      text: "to the",
      timeline_start: 0.5,
      timeline_end: 0.9,
    };
    const words = [
      {
        text: "to",
        start: 0.5,
        end: 0.7,
        timeline_start: 0.5,
        ignored: false,
        word_index: 1,
      },
      {
        text: "the",
        start: 0.7,
        end: 0.9,
        timeline_start: 0.7,
        ignored: false,
        word_index: 2,
      },
    ];
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [{ ...utterance, words }],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        utterances: [{ ...utterance, edge_suppressed_word_indices: [0] }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(next?.meta.hydration?.transcript_words).toBe(false);
  });

  it("keeps the word overlay when the edge-suppressed attachment matches", () => {
    const utterance = {
      track_id: "host",
      speaker: "Host",
      start: 0.5,
      end: 0.9,
      text: "to the",
      timeline_start: 0.5,
      timeline_end: 0.9,
    };
    const words = [
      {
        text: "welcome",
        start: 0,
        end: 0.3,
        timeline_start: 0,
        ignored: false,
        suppressed: true,
        word_index: 0,
      },
      {
        text: "to",
        start: 0.5,
        end: 0.7,
        timeline_start: 0.5,
        ignored: false,
        word_index: 1,
      },
      {
        text: "the",
        start: 0.7,
        end: 0.9,
        timeline_start: 0.7,
        ignored: false,
        word_index: 2,
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
          { ...utterance, words, edge_suppressed_word_indices: [0] },
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
        utterances: [{ ...utterance, edge_suppressed_word_indices: [0] }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeDefined();
    expect(next?.transcript?.utterances[0]?.words).toHaveLength(3);
    expect(next?.meta.hydration?.transcript_words).toBe(true);
  });

  it("refuses the word overlay when a row's suppressed_only flag flips", () => {
    const utterance = {
      track_id: "guest",
      speaker: "guest",
      start: 0.1,
      end: 0.6,
      text: "um uh",
      timeline_start: 0.1,
      timeline_end: 0.6,
    };
    const words = [
      {
        text: "um",
        start: 0.1,
        end: 0.3,
        timeline_start: 0.1,
        suppressed: true,
        word_index: 0,
      },
      {
        text: "uh",
        start: 0.4,
        end: 0.6,
        timeline_start: 0.4,
        suppressed: true,
        word_index: 1,
      },
    ];
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [{ ...utterance, words, suppressed_only: true }],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        // The row is no longer suppressed_only (a word was unsuppressed
        // elsewhere) while sharing the same track/start/end/text key (#758).
        utterances: [{ ...utterance }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(next?.meta.hydration?.transcript_words).toBe(false);
  });

  it("keeps the word overlay for a matching suppressed-only row", () => {
    const utterance = {
      track_id: "guest",
      speaker: "guest",
      start: 0.1,
      end: 0.6,
      text: "um uh",
      timeline_start: 0.1,
      timeline_end: 0.6,
      suppressed_only: true,
    };
    const words = [
      {
        text: "um",
        start: 0.1,
        end: 0.3,
        timeline_start: 0.1,
        suppressed: true,
        word_index: 0,
      },
      {
        text: "uh",
        start: 0.4,
        end: 0.6,
        timeline_start: 0.4,
        suppressed: true,
        word_index: 1,
      },
    ];
    const prev = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [{ ...utterance, words }],
      },
    });
    const shell = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        utterances: [{ ...utterance }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toHaveLength(2);
    expect(next?.meta.hydration?.transcript_words).toBe(true);
  });

  it("refetches DETAIL when a neighbour's removal and restore move edge-suppressed attachments", () => {
    const meta = (transcriptWords: boolean) => ({
      name: "Test",
      workspace_dir: "/tmp",
      hydration: { transcript_words: transcriptWords, history_groups: false },
    });
    const first = {
      track_id: "host",
      speaker: "Host",
      start: 0.5,
      end: 0.9,
      text: "to the",
      timeline_start: 0.5,
      timeline_end: 0.9,
    };
    const second = {
      track_id: "host",
      speaker: "Host",
      start: 3,
      end: 3.3,
      text: "bye",
      timeline_start: 3,
      timeline_end: 3.3,
    };
    const firstWords = [
      {
        text: "to",
        start: 0.5,
        end: 0.7,
        timeline_start: 0.5,
        ignored: false,
        word_index: 0,
      },
      {
        text: "the",
        start: 0.7,
        end: 0.9,
        timeline_start: 0.7,
        ignored: false,
        word_index: 1,
      },
    ];
    const um = {
      text: "um",
      start: 2.5,
      end: 2.6,
      timeline_start: 2.5,
      ignored: false,
      suppressed: true,
      word_index: 2,
    };
    const bye = {
      text: "bye",
      start: 3,
      end: 3.3,
      timeline_start: 3,
      ignored: false,
      suppressed: false,
      word_index: 3,
    };
    // DETAIL: the suppressed "um" rides on the nearer second row.
    const detail = minimalProject({
      meta: meta(true),
      transcript: {
        utterances: [
          { ...first, words: firstWords },
          { ...second, words: [um, bye], edge_suppressed_word_indices: [2] },
        ],
      },
    });
    // SHELL after suppressing "bye": the second row is gone; the first row gains [2, 3] (absent -> non-empty).
    const afterSuppress = projectFromDocumentSnapshot(detail, {
      project: minimalProject({
        meta: meta(false),
        transcript: {
          utterances: [{ ...first, edge_suppressed_word_indices: [2, 3] }],
        },
      }),
    });
    expect(afterSuppress?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(afterSuppress?.meta.hydration?.transcript_words).toBe(false);
    // DETAIL refetch rehydrates the first row with both edge chips.
    const hydrated = projectFromDocumentSnapshot(afterSuppress, {
      project: minimalProject({
        meta: meta(true),
        transcript: {
          utterances: [
            {
              ...first,
              words: [...firstWords, um, { ...bye, suppressed: true }],
              edge_suppressed_word_indices: [2, 3],
            },
          ],
        },
      }),
    });
    expect(hydrated?.transcript?.utterances[0]?.words).toHaveLength(4);
    // SHELL after undo: the second row returns; the first row's attachment goes non-empty -> absent.
    const afterUndo = projectFromDocumentSnapshot(hydrated, {
      project: minimalProject({
        meta: meta(false),
        transcript: {
          utterances: [
            { ...first },
            { ...second, edge_suppressed_word_indices: [2] },
          ],
        },
      }),
    });
    expect(afterUndo?.transcript?.utterances[0]?.words).toBeUndefined();
    expect(afterUndo?.transcript?.utterances[1]?.words).toBeUndefined();
    expect(afterUndo?.meta.hydration?.transcript_words).toBe(false);
  });

  it("refuses the word overlay when a same-size run of different words is ignored", () => {
    const words = [
      {
        text: "hello",
        start: 0,
        end: 0.4,
        timeline_start: 0,
        ignored: true,
        word_index: 0,
      },
      {
        text: "world",
        start: 0.4,
        end: 0.8,
        timeline_start: 0.4,
        ignored: false,
        word_index: 1,
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
            ignored_word_indices: [0],
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
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            ignored_word_indices: [1],
          },
        ],
      },
    });
    const next = projectFromDocumentSnapshot(prev, { project: shell });
    expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
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

  describe("SHELL overlay of a word listed under two utterances", () => {
    // Word index 1 ("quick") straddles the utterance boundary, so the mapper
    // lists it under both rows. SHELL strips `words` from every row, so each
    // overlaid listing comes from the same previous snapshot. This pins the
    // invariant that keeps transcriptSpanText's disagreement branch defensive.
    const straddlingRows = (first: string, second: string) => [
      {
        track_id: "host",
        speaker: "Host",
        start: 0,
        end: 2,
        text: first,
        timeline_start: 0,
        timeline_end: 2,
      },
      {
        track_id: "host",
        speaker: "Host",
        start: 1,
        end: 3,
        text: second,
        timeline_start: 1,
        timeline_end: 3,
      },
    ];
    const hydratedPrev = () => {
      const [a, b] = straddlingRows("the quick", "quick fox");
      return minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: true, history_groups: true },
        },
        transcript: {
          utterances: [
            {
              ...a,
              words: [
                { text: "the", word_index: 0, start: 0, end: 1 },
                { text: "quick", word_index: 1, start: 1, end: 2 },
              ],
            },
            {
              ...b,
              words: [
                { text: "quick", word_index: 1, start: 1, end: 2 },
                { text: "fox", word_index: 2, start: 2, end: 3 },
              ],
            },
          ],
        },
      });
    };
    const shell = (first: string, second: string) =>
      minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false, history_groups: false },
        },
        transcript: { utterances: straddlingRows(first, second) },
      });
    const listingsOf = (project: ProjectView | null, wordIndex: number) =>
      (project?.transcript?.utterances ?? []).flatMap((u) =>
        (u.words ?? [])
          .filter((w) => u.track_id === "host" && w.word_index === wordIndex)
          .map((w) => w.text),
      );

    it.each([
      {
        label: "neither row's text changed",
        first: "the quick",
        second: "quick fox",
        complete: true,
        listings: ["quick", "quick"],
      },
      {
        label: "a correction changed both rows",
        first: "the quack",
        second: "quack fox",
        complete: false,
        listings: [],
      },
      {
        label: "a correction changed only one row",
        first: "the quack",
        second: "quick fox",
        complete: false,
        listings: ["quick"],
      },
    ])(
      "leaves the listings agreeing or the words incomplete when $label",
      ({ first, second, complete, listings }) => {
        const next = projectFromDocumentSnapshot(hydratedPrev(), {
          project: shell(first, second),
        });
        const texts = listingsOf(next, 1);
        expect(next?.meta.hydration?.transcript_words).toBe(complete);
        expect(texts).toEqual(listings);
        expect(new Set(texts).size <= 1 || !complete).toBe(true);
      },
    );

    it("keeps the straddling word verifiable after an unchanged SHELL overlay", () => {
      const next = projectFromDocumentSnapshot(hydratedPrev(), {
        project: shell("the quick", "quick fox"),
      });
      expect(transcriptSpanText(next, "host", 1, 1)).toBe("quick");
      expect(transcriptSpanText(next, "host", 0, 2)).toBe("the quick fox");
    });
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
