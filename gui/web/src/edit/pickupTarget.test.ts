import { describe, expect, it } from "vitest";
import { EDIT_SELECTIONS, editFixtureProject } from "../test/actionBarFixtures";
import { SCRIPT_MAX_CHARS, scriptOf } from "./pickupTarget";

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
