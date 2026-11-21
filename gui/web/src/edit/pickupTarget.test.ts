import { describe, expect, it } from "vitest";
import { EDIT_SELECTIONS, editFixtureProject } from "../test/actionBarFixtures";
import { clipRow, minimalProject } from "../test/fixtures";
import { replaceableSpan, SCRIPT_MAX_CHARS, scriptOf } from "./pickupTarget";

describe("scriptOf", () => {
  it("quotes the selected words between ellipses", () => {
    expect(scriptOf(EDIT_SELECTIONS.liveWords, editFixtureProject())).toBe(
      "…this…",
    );
  });

  it("is absent without words", () => {
    expect(
      scriptOf(EDIT_SELECTIONS.rangeOnAllTracks, editFixtureProject()),
    ).toBeUndefined();
  });

  it("cuts a long selection to the cap and keeps the closing ellipsis", () => {
    const project = editFixtureProject();
    const word = project.transcript?.utterances[0]?.words?.find(
      (entry) => entry.word_index === 2,
    );
    if (!word) throw new Error("fixture word missing");
    word.text = "long ".repeat(100);
    const line = scriptOf(EDIT_SELECTIONS.liveWords, project) ?? "";
    expect(line.startsWith("…long")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(SCRIPT_MAX_CHARS + 2);
  });
});

describe("replaceableSpan", () => {
  it("allows a pickup through the canonical timeline end after the last clip", () => {
    const trackId = "mira-voice";
    const project = minimalProject({
      timeline_duration_sec: 10,
      clips: {
        clip_count: 1,
        tracks: { [trackId]: [clipRow({ timeline_end: 5 })] },
      },
    });
    const span = { start: 4, end: 10, trackIds: [trackId] };

    expect(replaceableSpan(span, project)).toEqual(span);
    expect(replaceableSpan({ ...span, end: 10.01 }, project)).toBeNull();
  });
});
