import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { needsTranscriptDetailHydrate } from "./hydrateTranscriptDetail";

describe("detail hydration eligibility", () => {
  it("hydrates incomplete host detail including initial shell, and never guest or complete detail", () => {
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
    expect(needsTranscriptDetailHydrate(null, incomplete)).toBe(true);
    expect(needsTranscriptDetailHydrate(complete, incomplete)).toBe(true);
    expect(needsTranscriptDetailHydrate(incomplete, complete)).toBe(false);
    expect(
      needsTranscriptDetailHydrate(complete, {
        ...incomplete,
        project_path: "share:token",
      }),
    ).toBe(false);
    expect(needsTranscriptDetailHydrate(complete, null)).toBe(false);
  });
});
