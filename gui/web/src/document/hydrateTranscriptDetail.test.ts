import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { needsTranscriptDetailHydrate } from "./hydrateTranscriptDetail";

describe("detail hydration eligibility", () => {
  const incomplete = minimalProject({
    meta: {
      name: "Test",
      workspace_dir: "/tmp",
      hydration: { transcript_words: false, history_groups: true },
    },
  });
  const complete = {
    ...incomplete,
    meta: {
      ...incomplete.meta,
      hydration: { transcript_words: true, history_groups: true },
    },
  };

  it.each([
    ["edit", true],
    ["suggest", true],
    ["none", false],
  ] as const)("hydrates missing words for a %s session: %s", (mode, want) => {
    expect(needsTranscriptDetailHydrate(incomplete, mode)).toBe(want);
  });

  it("never hydrates complete detail or no project", () => {
    expect(needsTranscriptDetailHydrate(complete, "edit")).toBe(false);
    expect(needsTranscriptDetailHydrate(null, "edit")).toBe(false);
  });
});
