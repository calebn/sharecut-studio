import { describe, expect, it } from "vitest";
import { makeRangeTarget } from "../edit/rangeSelection";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView, Selection } from "../types/project";
import { resolveCommentAnchor } from "./commentAnchor";

const selection: Selection = {
  kind: "transcriptRange",
  trackId: "speaker",
  sourceId: null,
  startWordIndex: 0,
  endWordIndex: 1,
};

function project(complete: boolean): ProjectView {
  return minimalProject({
    timeline_duration_sec: 100,
    tracks: [sampleTrack({ id: "speaker", range_media_seal: "s" })],
    clips: {
      tracks: {
        speaker: [
          clipRow({
            id: "a",
            track_id: "speaker",
            source_id: null,
            source_start: 0,
            source_end: 8,
            timeline_start: 0,
            timeline_end: 8,
          }),
        ],
      },
      clip_count: 1,
    },
    transcript: {
      utterances: [
        {
          track_id: "speaker",
          speaker: "Speaker",
          start: 1,
          end: 7,
          text: "one two",
          ...(complete
            ? {
                words: [
                  { text: "one", start: 1, end: 2, word_index: 0 },
                  { text: "two", start: 6, end: 7, word_index: 1 },
                ],
              }
            : {}),
        },
      ],
    },
    meta: {
      name: "t",
      workspace_dir: "/tmp",
      hydration: { transcript_words: complete },
    },
  });
}

const inputs = (p: ProjectView, playheadSec: number) => ({
  commentDraft: null,
  selection,
  project: p,
  playheadSec,
  projectPath: "/work/episode.sharecut",
});

describe("resolveCommentAnchor", () => {
  it("anchors at the selected words, from the project's own times", () => {
    const anchor = resolveCommentAnchor(inputs(project(true), 50));
    expect(anchor).toMatchObject({
      source: "selection",
      draft: { startSec: 1, endSec: 7 },
    });
  });

  it("names the refreshing selection and never falls to the playhead", () => {
    expect(resolveCommentAnchor(inputs(project(false), 50))).toEqual({
      source: "refreshing",
      reason: "Refreshing the transcript. Try again in a moment.",
    });
  });

  it("still anchors a typed draft and, with no selection, the playhead", () => {
    const draft = { startSec: 30, endSec: null };
    expect(
      resolveCommentAnchor({
        ...inputs(project(false), 50),
        commentDraft: draft,
      }),
    ).toEqual({ source: "draft", draft });
    expect(
      resolveCommentAnchor({ ...inputs(project(false), 50), selection: null }),
    ).toEqual({ source: "playhead", draft: { startSec: 50, endSec: null } });
  });
});

describe("resolveCommentAnchor with a stored timeline range", () => {
  const complete = project(true);
  const target = makeRangeTarget(
    complete,
    [{ start: 1, end: 7 }],
    ["speaker"],
  )!;
  const range: Selection = { kind: "range", target };
  const wordFree = project(false);
  const at = (path: string) => ({
    ...inputs(wordFree, 50),
    selection: range,
    projectPath: path,
  });

  it("names the refreshing range on a share link and never falls to the playhead", () => {
    expect(resolveCommentAnchor(at("share:tok"))).toEqual({
      source: "refreshing",
      reason: "Refreshing the transcript. Try again in a moment.",
    });
  });

  it("anchors a host's stored range as before", () => {
    expect(resolveCommentAnchor(at("/work/episode.sharecut"))).toMatchObject({
      source: "selection",
      draft: { startSec: 1, endSec: 7 },
    });
  });
});
