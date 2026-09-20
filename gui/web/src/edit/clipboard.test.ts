import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import type { Selection } from "../types/project";
import {
  _resetClipboardForTests,
  getClipboard,
  setClipboard,
} from "./clipboard";
import {
  extractClipsInRange,
  payloadFromSelection,
} from "./selectionClipboard";

function sampleProject() {
  return minimalProject({
    timeline_duration_sec: 20,
    tracks: [
      {
        id: "host",
        label: "Host",
        role: "dialogue",
        speaker: "A",
        gain_db: 0,
        muted: false,
        duration_sec: 20,
        fx_count: 0,
        stem_is_fresh: true,
      },
      {
        id: "guest",
        label: "Guest",
        role: "dialogue",
        speaker: "B",
        gain_db: 0,
        muted: false,
        duration_sec: 20,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
    clips: {
      tracks: {
        host: [
          {
            id: "c1",
            track_id: "host",
            source_start: 0,
            source_end: 5,
            timeline_start: 0,
            timeline_end: 5,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
            mute_regions: [{ start_s: 1.2, end_s: 1.8 }],
          },
        ],
        guest: [
          {
            id: "c2",
            track_id: "guest",
            source_start: 0,
            source_end: 5,
            timeline_start: 0,
            timeline_end: 5,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
          },
        ],
      },
      clip_count: 2,
    },
    transcript: {
      utterances: [
        {
          track_id: "host",
          speaker: "A",
          start: 1,
          end: 2,
          text: "hello world",
          words: [
            {
              text: "hello",
              start: 1,
              end: 1.4,
              timeline_start: 1,
              timeline_end: 1.4,
              word_index: 0,
            },
            {
              text: "world",
              start: 1.5,
              end: 2,
              timeline_start: 1.5,
              timeline_end: 2,
              word_index: 1,
            },
          ],
        },
      ],
    },
  });
}

describe("clipboard", () => {
  beforeEach(() => {
    _resetClipboardForTests();
  });

  it("stores and clears payload", () => {
    setClipboard({
      timelineStart: 1,
      timelineEnd: 2,
      mode: "copy",
      extracts: [],
    });
    expect(getClipboard()?.timelineStart).toBe(1);
    _resetClipboardForTests();
    expect(getClipboard()).toBeNull();
  });

  it("rejects invalid ranges", () => {
    setClipboard({
      timelineStart: 2,
      timelineEnd: 1,
      mode: "copy",
      extracts: [],
    });
    expect(getClipboard()).toBeNull();
  });
});

describe("selectionClipboard", () => {
  it("extracts same-track clips in range", () => {
    const extracts = extractClipsInRange(sampleProject(), 1, 3);
    expect(extracts).toHaveLength(2);
    expect(extracts.map((e) => e.track_id).sort()).toEqual(["guest", "host"]);
  });

  it("narrows to one track when trackIds set", () => {
    const extracts = extractClipsInRange(sampleProject(), 1, 3, ["host"]);
    expect(extracts).toHaveLength(1);
    expect(extracts[0]?.track_id).toBe("host");
    expect(extracts[0]?.mute_regions).toEqual([{ start_s: 1.2, end_s: 1.8 }]);
  });

  it("builds payload from clip selection", () => {
    const sel: Selection = { kind: "clip", id: "c1", trackId: "host" };
    const payload = payloadFromSelection(sampleProject(), sel, "cut");
    expect(payload?.mode).toBe("cut");
    expect(payload?.trackIds).toEqual(["host"]);
    expect(payload?.extracts).toHaveLength(1);
  });

  it("builds payload from transcript range", () => {
    const sel: Selection = {
      kind: "transcriptRange",
      trackId: "host",
      startWordIndex: 0,
      endWordIndex: 1,
    };
    const payload = payloadFromSelection(sampleProject(), sel, "copy");
    expect(payload?.plainText).toBe("hello world");
    expect(payload?.timelineStart).toBe(1);
    expect(payload?.timelineEnd).toBe(2);
  });
});
