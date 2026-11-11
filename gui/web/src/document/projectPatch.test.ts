import { describe, expect, it } from "vitest";
import {
  clipRow,
  minimalProject,
  sampleComment,
  sampleTrack,
} from "../test/fixtures";
import { HISTORY_ROOT_ID, type ProjectView } from "../types/project";
import { transcriptSpanText } from "../utils/transcript";
import {
  commentFromCommandResult,
  mergeProjectPatch,
  patchClipGain,
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
                source_duration_sec: null,
                recording_key: null,
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
  it.each(["Mira", null])(
    "updates speaker rows and preserves their source data for %s",
    (speaker) => {
      const words = [{ text: "hello", start: 0, end: 1 }];
      const source = {
        track_id: "host",
        speaker: "Host",
        text: "hello",
        start: 0,
        end: 1,
        words,
      };
      const other = { ...source, track_id: "guest", speaker: "Guest" };
      const previous = minimalProject({
        tracks: [sampleTrack({ speaker: "Host" })],
        transcript: { utterances: [source, other] },
      });
      const next = patchTrackMeta(previous, "host", { speaker });
      expect(next.transcript?.utterances[0]).toEqual({
        ...source,
        speaker: speaker ?? "host",
      });
      expect(next.transcript?.utterances[0].words).toBe(words);
      expect(next.transcript?.utterances[1]).toBe(other);
      expect(previous.transcript?.utterances[0].speaker).toBe("Host");
      expect(patchTrackMeta(next, "host", { speaker })).toBe(next);
      expect(patchTrackMeta(previous, "missing", { speaker })).toBe(previous);
    },
  );
});

describe("patchClipGain", () => {
  const base = minimalProject({
    clips: {
      tracks: { host: [clipRow({ id: "c1" }), clipRow({ id: "c2" })] },
      clip_count: 2,
    },
  });

  it("sets one clip's gain and leaves the others and the project identity", () => {
    const next = patchClipGain(base, "c1", 4.5);
    expect(next.clips.tracks.host?.[0]?.gain_db).toBe(4.5);
    expect(next.clips.tracks.host?.[1]).toBe(base.clips.tracks.host?.[1]);
    expect(base.clips.tracks.host?.[0]?.gain_db).toBeUndefined();
  });

  it("returns the same project for an unchanged or unknown clip", () => {
    expect(patchClipGain(base, "c1", 0)).toBe(base);
    expect(patchClipGain(base, "nope", 3)).toBe(base);
    const gained = patchClipGain(base, "c1", 3);
    expect(patchClipGain(gained, "c1", 3)).toBe(gained);
  });
});

describe("projectFromDocumentSnapshot", () => {
  it("invalidates an overlapping word whose playable tail extends beyond the row end", () => {
    const row = {
      track_id: "host",
      speaker: "Host",
      start: 1.75,
      end: 2.25,
      text: "anchor overlap tail",
      mappable: true,
      timeline_start: 1.75,
      timeline_end: 2,
      timeline_spans: [{ start: 1.75, end: 2 }],
    };
    const clips = (rolled: boolean): ProjectView["clips"] => ({
      clip_count: 3,
      tracks: {
        host: [
          {
            id: "anchor",
            source_start: 0,
            source_end: 2,
            timeline_start: 0,
            timeline_end: 2,
          },
          {
            id: "left",
            source_start: 4,
            source_end: rolled ? 5.1 : 5,
            timeline_start: 2.28,
            timeline_end: rolled ? 3.38 : 3.28,
          },
          {
            id: "right",
            source_start: rolled ? 2.38 : 2.28,
            source_end: 4,
            timeline_start: rolled ? 3.38 : 3.28,
            timeline_end: 5,
          },
        ].map((clip) => ({
          ...clip,
          track_id: "host",
          origin_track_id: "host",
          source_id: null,
          recording_key: null,
          source_duration_sec: 6,
          fade_in_ms: 0,
          fade_out_ms: 0,
          join_in_mode: "fade",
        })),
      },
    });
    const words = [
      {
        text: "anchor",
        word_index: 0,
        start: 1.75,
        end: 1.99,
        mappable: true,
        timeline_start: 1.75,
        timeline_end: 1.99,
      },
      {
        text: "overlap",
        word_index: 1,
        start: 2,
        end: 2.33,
        confidence: 0.4,
        mappable: true,
        timeline_start: 3.28,
        timeline_end: 3.33,
      },
      {
        text: "tail",
        word_index: 2,
        start: 2.15,
        end: 2.25,
        mappable: false,
        timeline_start: null,
        timeline_end: null,
      },
    ];
    const previous = minimalProject({
      clips: clips(false),
      transcript: { utterances: [{ ...row, words }] },
    });
    const shell = minimalProject({
      ...previous,
      clips: clips(true),
      meta: { ...previous.meta, hydration: { transcript_words: false } },
      transcript: { utterances: [row] },
    });
    const next = projectFromDocumentSnapshot(previous, { project: shell });
    expect(next?.meta.hydration?.transcript_words).toBe(false);
    expect(next?.transcript?.utterances[0].words).toBeUndefined();
  });

  it.each([
    { rowSource: "take-a", clipSource: "take-a", lane: "host", origin: "host" },
    { rowSource: null, clipSource: "primary", lane: "host", origin: "host" },
    { rowSource: "take-a", clipSource: "alias", lane: "other", origin: "host" },
  ])(
    "does not reuse cached word mapping after a clip roll changes source coverage ($rowSource, $clipSource, $lane)",
    ({ rowSource, clipSource, lane, origin }) => {
      const clips = (leftEnd: number, rightStart: number) => ({
        tracks: {
          [lane]: [
            {
              id: "left",
              track_id: lane,
              origin_track_id: origin,
              source_start: 0,
              source_end: leftEnd,
              timeline_start: 0,
              timeline_end: leftEnd,
              fade_in_ms: 0,
              fade_out_ms: 0,
              join_in_mode: "fade",
              source_id: clipSource,
              source_duration_sec: 6,
              recording_key: null,
            },
            {
              id: "right",
              track_id: lane,
              origin_track_id: origin,
              source_start: rightStart,
              source_end: 6,
              timeline_start: leftEnd,
              timeline_end: leftEnd + 6 - rightStart,
              fade_in_ms: 0,
              fade_out_ms: 0,
              join_in_mode: "fade",
              source_id: clipSource,
              source_duration_sec: 6,
              recording_key: null,
            },
          ],
        },
        clip_count: 2,
      });
      const row = {
        track_id: "host",
        source_id: rowSource,
        speaker: "Host",
        start: 0,
        end: 6,
        text: "before restored after cut",
        timeline_start: 0,
        timeline_end: 5,
        timeline_spans: [{ start: 0, end: 5 }],
        mappable: true,
      };
      const words = [
        {
          text: "before",
          word_index: 0,
          start: 1,
          end: 1.5,
          timeline_start: 1,
          timeline_end: 1.5,
          mappable: true,
        },
        {
          text: "restored",
          word_index: 1,
          start: 2.1,
          end: 2.4,
          timeline_start: null,
          timeline_end: null,
          mappable: false,
        },
        {
          text: "after cut",
          word_index: 2,
          start: 3.1,
          end: 3.4,
          timeline_start: 2.1,
          timeline_end: 2.4,
          mappable: true,
        },
        {
          text: "after",
          word_index: 3,
          start: 4,
          end: 4.5,
          timeline_start: 3,
          timeline_end: 3.5,
          mappable: true,
        },
      ] satisfies NonNullable<
        NonNullable<ProjectView["transcript"]>["utterances"][number]["words"]
      >;
      const previous = minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: true, history_groups: true },
        },
        clips: clips(2, 3),
        transcript: { utterances: [{ ...row, words }] },
      });
      const shell = minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false, history_groups: false },
        },
        clips: clips(2.5, 3.5),
        transcript: { utterances: [row] },
      });

      const next = projectFromDocumentSnapshot(previous, { project: shell });

      expect(next?.transcript?.utterances[0]?.words).toBeUndefined();
      expect(next?.meta.hydration?.transcript_words).toBe(false);
      const refreshedWords = words.map((word) =>
        word.word_index === 1
          ? { ...word, mappable: true, timeline_start: 2.1, timeline_end: 2.4 }
          : word.word_index === 2
            ? {
                ...word,
                mappable: false,
                timeline_start: null,
                timeline_end: null,
              }
            : word,
      );
      const detail = minimalProject({
        ...shell,
        meta: {
          ...shell.meta,
          hydration: { transcript_words: true, history_groups: false },
        },
        transcript: { utterances: [{ ...row, words: refreshedWords }] },
      });
      const refreshed = projectFromDocumentSnapshot(next, { project: detail });
      expect(refreshed?.transcript?.utterances[0]?.words).toEqual(
        refreshedWords,
      );
    },
  );

  it.each([
    { label: "unchanged", timelineStart: 0, wordStart: 0.5, wordEnd: 1 },
    {
      label: "translated together",
      timelineStart: 4,
      wordStart: 4.5,
      wordEnd: 5,
    },
  ])(
    "retains clip-mapped words when placements are $label",
    ({ timelineStart, wordStart, wordEnd }) => {
      const clip = (timelineStart: number) => ({
        id: "only-clip",
        track_id: "host",
        source_start: 0,
        source_end: 2,
        timeline_start: timelineStart,
        timeline_end: timelineStart + 2,
        fade_in_ms: 0,
        fade_out_ms: 0,
        join_in_mode: "fade",
        source_id: "take-a",
        source_duration_sec: 2,
        recording_key: null,
      });
      const otherClip = (start: number) => ({
        ...clip(start),
        id: "other-clip",
        track_id: "guest",
        origin_track_id: "guest",
        source_id: "take-b",
      });
      const row = {
        track_id: "host",
        source_id: "take-a",
        speaker: "Host",
        start: 0,
        end: 2,
        text: "hello",
        timeline_start: 0,
        timeline_end: 2,
        timeline_spans: [{ start: 0, end: 2 }],
        mappable: true,
        words: [
          {
            text: "hello",
            word_index: 0,
            start: 0.5,
            end: 1,
            timeline_start: 0.5,
            timeline_end: 1,
            mappable: true,
          },
        ],
      } satisfies NonNullable<
        NonNullable<ProjectView["transcript"]>["utterances"][number]
      >;
      const previous = minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: true, history_groups: true },
        },
        clips: {
          tracks: { host: [clip(0)], guest: [otherClip(0)] },
          clip_count: 2,
        },
        transcript: { utterances: [row] },
      });
      const { words: _words, ...shellRow } = row;
      const shell = minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false, history_groups: false },
        },
        clips: {
          tracks: {
            host: [clip(timelineStart)],
            guest: [otherClip(timelineStart === 0 ? 1 : 0)],
          },
          clip_count: 2,
        },
        transcript: {
          utterances: [
            {
              ...shellRow,
              timeline_start: timelineStart,
              timeline_end: timelineStart + 2,
              timeline_spans: [
                { start: timelineStart, end: timelineStart + 2 },
              ],
            },
          ],
        },
      });

      const next = projectFromDocumentSnapshot(previous, { project: shell });

      expect(next?.transcript?.utterances[0]?.words?.[0]).toMatchObject({
        text: "hello",
        timeline_start: wordStart,
        timeline_end: wordEnd,
        mappable: true,
      });
      expect(next?.meta.hydration?.transcript_words).toBe(true);
    },
  );

  it.each([
    { label: "unchanged", timelineStart: 0 },
    { label: "translated", timelineStart: 1.2 },
  ])(
    "preserves per-word mapping through a compatible $label shell update",
    ({ timelineStart }) => {
      const words = [
        {
          text: "cut",
          start: 0,
          end: 0.2,
          timeline_start: null,
          timeline_end: null,
          mappable: false,
        },
        {
          text: "also cut",
          start: 0.2,
          end: 0.4,
          timeline_start: null,
          timeline_end: null,
          mappable: false,
        },
        {
          text: "play",
          start: 0.4,
          end: 0.6,
          timeline_start: 0.4,
          timeline_end: 0.6,
          mappable: true,
        },
        {
          text: "unknown",
          start: 0.6,
          end: 0.8,
          timeline_start: 0.6,
          timeline_end: 0.8,
        },
      ] satisfies NonNullable<
        NonNullable<ProjectView["transcript"]>["utterances"][number]["words"]
      >;
      const row = {
        track_id: "host",
        source_id: "source-1",
        speaker: "Host",
        start: 0,
        end: 0.8,
        text: "cut also cut play unknown",
        timeline_start: 0,
        timeline_end: 0.8,
        mappable: true,
      };
      const previous = minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: true, history_groups: true },
        },
        transcript: { utterances: [{ ...row, words }] },
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
              ...row,
              timeline_start: timelineStart,
              timeline_end: timelineStart + 0.8,
            },
          ],
        },
      });

      const overlaid = projectFromDocumentSnapshot(previous, {
        project: shell,
      });
      const overlaidWords = overlaid?.transcript?.utterances[0]?.words;
      expect(overlaid?.meta.hydration?.transcript_words).toBe(true);
      expect(overlaid?.transcript?.utterances[0]?.source_id).toBe("source-1");
      expect(overlaidWords?.map((word) => word.text)).toEqual([
        "cut",
        "also cut",
        "play",
        "unknown",
      ]);
      expect(overlaidWords?.map((word) => word.mappable)).toEqual([
        false,
        false,
        true,
        true,
      ]);
      expect(
        overlaidWords?.map((word) => [word.timeline_start, word.timeline_end]),
      ).toEqual([
        [null, null],
        [null, null],
        [timelineStart + 0.4, timelineStart + 0.6],
        [timelineStart + 0.6, timelineStart + 0.8],
      ]);

      const detail = minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: true, history_groups: true },
        },
        transcript: {
          utterances: [
            {
              ...row,
              mappable: false,
              timeline_start: null,
              timeline_end: null,
              words: words.map((word) => ({
                ...word,
                mappable: false,
                timeline_start: null,
                timeline_end: null,
              })),
            },
          ],
        },
      });
      const replaced = projectFromDocumentSnapshot(overlaid, {
        project: detail,
      });
      expect(replaced?.meta.hydration?.transcript_words).toBe(true);
      expect(
        replaced?.transcript?.utterances[0]?.words?.map(
          (word) => word.mappable,
        ),
      ).toEqual([false, false, false, false]);
      expect(
        replaced?.transcript?.utterances[0]?.words?.map((word) => [
          word.timeline_start,
          word.timeline_end,
        ]),
      ).toEqual([
        [null, null],
        [null, null],
        [null, null],
        [null, null],
      ]);
    },
  );

  it("matches cached words to the same source when same-lane takes reorder", () => {
    const row = (
      sourceId: string | null | undefined,
      timelineStart: number,
      words: NonNullable<
        NonNullable<ProjectView["transcript"]>["utterances"][number]["words"]
      >,
    ) => ({
      track_id: "host",
      ...(sourceId === undefined ? {} : { source_id: sourceId }),
      speaker: "Host",
      start: 0,
      end: 2,
      text: "one two",
      timeline_start: timelineStart,
      timeline_end: timelineStart + 1,
      timeline_spans: [{ start: timelineStart, end: timelineStart + 1 }],
      mappable: true,
      words,
    });
    const shell = (
      sourceId: string | null | undefined,
      timelineStart: number,
    ) => {
      const { words: _words, ...utterance } = row(sourceId, timelineStart, []);
      return utterance;
    };
    const words = (timelineStart: number, firstCut: boolean) => [
      {
        text: "one",
        word_index: 0,
        start: 0,
        end: 1,
        timeline_start: firstCut ? null : timelineStart,
        timeline_end: firstCut ? null : timelineStart + 1,
        mappable: !firstCut,
      },
      {
        text: "two",
        word_index: 1,
        start: 1,
        end: 2,
        timeline_start: firstCut ? timelineStart : null,
        timeline_end: firstCut ? timelineStart + 1 : null,
        mappable: firstCut,
      },
    ];
    const previous = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: true, history_groups: true },
      },
      transcript: {
        utterances: [
          row("take-a", 0, words(0, true)),
          row("take-b", 4, words(4, false)),
          row(null, 8, words(8, true)),
          row(undefined, 12, words(12, false)),
        ],
      },
    });
    const incoming = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: {
        utterances: [
          shell("take-b", 0),
          shell("take-a", 4),
          shell(undefined, 8),
          shell(null, 12),
        ],
      },
    });

    const next = projectFromDocumentSnapshot(previous, { project: incoming });
    expect(
      next?.transcript?.utterances.map((utterance) => [
        utterance.source_id ?? null,
        utterance.words?.map((word) => word.mappable),
      ]),
    ).toEqual([
      ["take-b", [true, false]],
      ["take-a", [false, true]],
      [null, [false, true]],
      [null, [true, false]],
    ]);
    expect(
      next?.transcript?.utterances.map((utterance) =>
        utterance.words?.map((word) => [
          word.text,
          word.word_index,
          word.timeline_start,
          word.timeline_end,
        ]),
      ),
    ).toEqual([
      [
        ["one", 0, 0, 1],
        ["two", 1, null, null],
      ],
      [
        ["one", 0, null, null],
        ["two", 1, 4, 5],
      ],
      [
        ["one", 0, null, null],
        ["two", 1, 8, 9],
      ],
      [
        ["one", 0, 12, 13],
        ["two", 1, null, null],
      ],
    ]);
    expect(next?.meta.hydration?.transcript_words).toBe(true);
  });

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
        mappable: true,
      },
      {
        text: "world",
        start: 0.4,
        end: 0.8,
        timeline_start: 0.4,
        timeline_end: 0.8,
        mappable: true,
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
            source_id: "source-1",
            speaker: "Host",
            start: 0,
            end: 0.8,
            text: "hello world",
            timeline_start: 0,
            timeline_end: 0.8,
            mappable: true,
            words,
          },
        ],
      },
      history: {
        cursor: 1,
        head_id: HISTORY_ROOT_ID,
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
            source_id: "source-1",
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
      history: {
        cursor: 1,
        head_id: HISTORY_ROOT_ID,
        can_undo: true,
        can_redo: false,
        groups: [],
      },
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

  it("keeps transcript_words false across repeated shells with no utterances", () => {
    const shell = () =>
      minimalProject({
        meta: {
          name: "Test",
          workspace_dir: "/tmp",
          hydration: { transcript_words: false, history_groups: false },
        },
        transcript: { utterances: [] },
      });
    const first = projectFromDocumentSnapshot(shell(), { project: shell() });
    expect(first?.meta.hydration?.transcript_words).toBe(false);
    const second = projectFromDocumentSnapshot(first ?? shell(), {
      project: shell(),
    });
    expect(second?.meta.hydration?.transcript_words).toBe(false);
  });

  it("reports transcript_words true when every incoming utterance carries words", () => {
    const utterance = {
      track_id: "host",
      speaker: "Host",
      start: 0,
      end: 0.4,
      text: "hello",
      timeline_start: 0,
      timeline_end: 0.4,
      mappable: true,
      words: [
        {
          text: "hello",
          start: 0,
          end: 0.4,
          timeline_start: 0,
          timeline_end: 0.4,
        },
      ],
    };
    const full = minimalProject({
      meta: {
        name: "Test",
        workspace_dir: "/tmp",
        hydration: { transcript_words: false, history_groups: false },
      },
      transcript: { utterances: [utterance] },
    });
    const next = projectFromDocumentSnapshot(full, { project: full });
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
        head_id: HISTORY_ROOT_ID,
        can_undo: false,
        can_redo: false,
        groups: [{ kind: "snapshot", title: "old" }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, {
      history: {
        cursor: 1,
        head_id: HISTORY_ROOT_ID,
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
        head_id: HISTORY_ROOT_ID,
        can_undo: false,
        can_redo: false,
        groups: [{ kind: "snapshot", title: "old" }],
      },
    });
    const next = projectFromDocumentSnapshot(prev, {
      history: {
        cursor: 1,
        head_id: HISTORY_ROOT_ID,
        can_undo: true,
        can_redo: false,
      },
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
        head_id: HISTORY_ROOT_ID,
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
      history: {
        cursor: 0,
        head_id: HISTORY_ROOT_ID,
        can_undo: false,
        can_redo: false,
        groups: [],
      },
    });
    const next = projectFromDocumentSnapshot(prev, {
      project: shell,
      history: {
        cursor: 1,
        head_id: HISTORY_ROOT_ID,
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
      history: {
        cursor: 0,
        head_id: HISTORY_ROOT_ID,
        can_undo: false,
        can_redo: false,
        groups: [],
      },
    });
    const withGroups = projectFromDocumentSnapshot(prev, {
      history: {
        cursor: 1,
        head_id: HISTORY_ROOT_ID,
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
      history: {
        cursor: 0,
        head_id: HISTORY_ROOT_ID,
        can_undo: false,
        can_redo: false,
        groups: [],
      },
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
