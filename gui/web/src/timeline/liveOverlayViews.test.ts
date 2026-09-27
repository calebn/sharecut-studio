import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SRC_ROOT } from "../test/sourceFiles";

/**
 * The three live-overlay production views must stay prop-only: no direct
 * import of the DAW store, the API layer, or the timeline-metrics context.
 * `followSync` (via `clock.ts`) still reaches the store transitively — this
 * guard checks only each view's own direct imports.
 */
const VIEW_FILES = [
  "timeline/CommentPlaybackBubbleView.tsx",
  "timeline/EnvelopeOverlayView.tsx",
  "timeline/PresenceOverlayView.tsx",
];

const FORBIDDEN = [/\.\.\/state\//, /\.\.\/api/, /timelineMetrics/];

describe("live overlay production views stay prop-only", () => {
  it.each(VIEW_FILES)("%s imports no store, API or timelineMetrics", (file) => {
    const text = readFileSync(join(SRC_ROOT, file), "utf8");
    for (const pattern of FORBIDDEN) {
      expect(text).not.toMatch(pattern);
    }
  });
});
