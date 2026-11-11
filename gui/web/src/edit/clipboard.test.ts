import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { SPLIT_MICRO_FADE_MS } from "../types/limits.generated";
import type { Selection } from "../types/project";
import {
  _resetClipboardForTests,
  getClipboard,
  setClipboard,
} from "./clipboard";
import {
  CUT_EDGE_FADE,
  edgeFadeFor,
  extractClipsInRange,
  KEEP_CLIP_FADES,
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
            source_duration_sec: null,
            recording_key: null,
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
            source_duration_sec: null,
            recording_key: null,
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
    const extracts = extractClipsInRange(
      sampleProject(),
      1,
      3,
      KEEP_CLIP_FADES,
    );
    expect(extracts).toHaveLength(2);
    expect(extracts.map((e) => e.track_id).sort()).toEqual(["guest", "host"]);
  });

  it("narrows to one track when trackIds set", () => {
    const extracts = extractClipsInRange(
      sampleProject(),
      1,
      3,
      KEEP_CLIP_FADES,
      ["host"],
    );
    expect(extracts).toHaveLength(1);
    expect(extracts[0]?.track_id).toBe("host");
    expect(extracts[0]?.mute_regions).toEqual([{ start_s: 1.2, end_s: 1.8 }]);
  });

  it("copies a cut-through mute whole, so the copy has no fade at the cut", () => {
    const project = sampleProject();
    const fill = { start_s: 4, end_s: 4.5, source_id: null };
    const host = project.clips?.tracks.host?.[0];
    if (!host) {
      throw new Error("sample project has a host clip");
    }
    const mute = {
      start_s: 1.2,
      end_s: 1.8,
      fill,
      fade_out_ms: 5,
      fade_in_ms: 120,
    };
    host.mute_regions = [mute, { start_s: 3.2, end_s: 3.4 }];
    const extracts = extractClipsInRange(project, 1.5, 3, KEEP_CLIP_FADES, [
      "host",
    ]);
    expect(extracts[0]?.source_start).toBe(1.5);
    expect(extracts[0]?.mute_regions).toEqual([mute]);
  });

  it("keeps a clip's gain in its extract, and omits it for an unchanged clip", () => {
    const project = sampleProject();
    const host = project.clips?.tracks.host?.[0];
    if (!host) {
      throw new Error("sample project has a host clip");
    }
    host.gain_db = -7.5;
    const extracts = extractClipsInRange(project, 1, 3, KEEP_CLIP_FADES);
    expect(extracts.find((e) => e.track_id === "host")?.gain_db).toBe(-7.5);
    const guest = extracts.find((e) => e.track_id === "guest");
    expect(guest?.gain_db ?? 0).toBe(0);
    expect(JSON.parse(JSON.stringify(guest))).not.toHaveProperty("gain_db");
  });

  it("keeps a clip's fade curves in its extract, and omits linear or unknown ones", () => {
    const project = sampleProject();
    const host = project.clips?.tracks.host?.[0];
    const guest = project.clips?.tracks.guest?.[0];
    if (!host || !guest) {
      throw new Error("sample project has a host and a guest clip");
    }
    host.fade_in_curve = "equal_power";
    host.fade_out_curve = "s";
    guest.fade_in_curve = "linear";
    Object.assign(guest, { fade_out_curve: "wobble" });
    const extracts = extractClipsInRange(project, 1, 3, KEEP_CLIP_FADES);
    expect(extracts.find((e) => e.track_id === "host")).toMatchObject({
      fade_in_curve: "equal_power",
      fade_out_curve: "s",
    });
    const sent = JSON.parse(
      JSON.stringify(extracts.find((e) => e.track_id === "guest")),
    );
    expect(sent).not.toHaveProperty("fade_in_curve");
    expect(sent).not.toHaveProperty("fade_out_curve");
  });

  it("follows the server's range-edge rule: a cut's new edges get only the micro fade", () => {
    const project = sampleProject();
    const host = project.clips?.tracks.host?.[0];
    if (!host) {
      throw new Error("sample project has a host clip");
    }
    Object.assign(host, {
      fade_in_ms: 400,
      fade_out_ms: 300,
      fade_in_curve: "s",
      fade_out_curve: "equal_power",
      join_in_mode: "cut",
    });
    const [copied] = extractClipsInRange(project, 1, 3, KEEP_CLIP_FADES, [
      "host",
    ]);
    expect(copied).toMatchObject({
      fade_in_ms: 400,
      fade_out_ms: 300,
      fade_in_curve: "s",
      fade_out_curve: "equal_power",
      join_in_mode: "cut",
    });
    const [cut] = extractClipsInRange(project, 1, 3, CUT_EDGE_FADE, ["host"]);
    expect(cut).toMatchObject({
      fade_in_ms: SPLIT_MICRO_FADE_MS,
      fade_out_ms: SPLIT_MICRO_FADE_MS,
      join_in_mode: "fade",
    });
    expect(cut).not.toHaveProperty("fade_in_curve");
    expect(cut).not.toHaveProperty("fade_out_curve");
    const [head] = extractClipsInRange(project, 0, 3, CUT_EDGE_FADE, ["host"]);
    expect(head).toMatchObject({
      fade_in_ms: 400,
      fade_in_curve: "s",
      fade_out_ms: SPLIT_MICRO_FADE_MS,
      join_in_mode: "cut",
    });
    expect(head).not.toHaveProperty("fade_out_curve");
  });

  it("fits a cut edge fade to a piece shorter than it", () => {
    const [piece] = extractClipsInRange(
      sampleProject(),
      1,
      1.004,
      CUT_EDGE_FADE,
      ["host"],
    );
    expect(piece).toMatchObject({ fade_in_ms: 4, fade_out_ms: 4 });
  });

  it("copies keep the clip fades and cuts give new edges the micro fade", () => {
    expect(edgeFadeFor("copy")).toBe(KEEP_CLIP_FADES);
    expect(edgeFadeFor("cut")).toEqual({
      kind: "cut",
      ms: SPLIT_MICRO_FADE_MS,
    });
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
