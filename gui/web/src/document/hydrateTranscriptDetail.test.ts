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
    ["reads", true, true],
    ["does not read", false, false],
  ] as const)(
    "a session that %s the transcript hydrates missing words: %s",
    (_name, reads, want) => {
      expect(needsTranscriptDetailHydrate(incomplete, reads)).toBe(want);
    },
  );

  it("never hydrates complete detail or no project", () => {
    expect(needsTranscriptDetailHydrate(complete, true)).toBe(false);
    expect(needsTranscriptDetailHydrate(null, true)).toBe(false);
  });
});
