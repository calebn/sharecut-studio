import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";
import { importSpecifiers } from "../test/storyGovernance";

/**
 * The three live-overlay production views must stay prop-only: no direct
 * import of the DAW store, the API layer, or the timeline-metrics context.
 * Reads real import specifiers (not raw text), so barrels like "../state"
 * are caught and comments are ignored. `followSync` (via `clock.ts`) still
 * reaches the store transitively; this guard checks only each view's own
 * direct imports.
 */
const VIEW_FILES = [
  "timeline/CommentPlaybackBubbleView.tsx",
  "timeline/EnvelopeOverlayView.tsx",
  "timeline/PresenceOverlayView.tsx",
  "timeline/JoinPopoverView.tsx",
];

const FORBIDDEN = [
  /^\.\.\/state(\/|$)/,
  /^\.\.\/api(\/|$)/,
  /(^|\/)timelineMetrics(\.tsx?)?$/,
];

function forbiddenImports(text: string): string[] {
  return importSpecifiers(text).filter((spec) =>
    FORBIDDEN.some((pattern) => pattern.test(spec)),
  );
}

describe("live overlay production views stay prop-only", () => {
  it.each(VIEW_FILES)("%s imports no store, API or timelineMetrics", (file) => {
    expect(
      forbiddenImports(readFileSync(join(SRC_ROOT, file), "utf8")),
    ).toEqual([]);
  });

  it.each([
    ['import { useDawStore } from "../state";', ["../state"]],
    ['import { useDawStore } from "../state/dawStore";', ["../state/dawStore"]],
    ['import { setEnvelope } from "../api";', ["../api"]],
    [
      'import { useTimelineMetrics } from "./timelineMetrics";',
      ["./timelineMetrics"],
    ],
    ["// adapters read timelineMetrics and ../state/\nexport const a = 1;", []],
    ['import { errorMessage } from "../utils/apiError";', []],
  ])("classifies %j", (text, expected) => {
    expect(forbiddenImports(text)).toEqual(expected);
  });
});
