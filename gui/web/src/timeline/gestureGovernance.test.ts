/**
 * One gesture router (#1096): the touch input grammar lives in the hit
 * router and its contract, not in each timeline component. These scans fail
 * when a component under `timeline/` grows its own touch handling, a pointer
 * handler on an element the router cannot see, or its own arrow-key edits.
 * Follows `commands/governance.test.ts`; an allowlist entry needs a reason.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  jsxElements,
  markedKinds,
  marksSurface,
  ownsPointerDown,
} from "../test/jsxElements";
import { SRC_ROOT, sourceFiles } from "../test/sourceFiles";

const TIMELINE = join(SRC_ROOT, "timeline");

function timelineSources() {
  return [...sourceFiles(TIMELINE)].filter(
    ({ rel }) => !rel.includes(".test.") && !rel.includes(".stories."),
  );
}

/** The router and the modules it is built from. */
const ROUTER = new Set([
  "timeline/hitRouting.ts",
  "timeline/hitCandidates.ts",
  "timeline/useTouchPress.ts",
  // Two fingers: pinch and pan, which the router yields every pointer to.
  "timeline/timelineZoomGestures.ts",
]);

/** Touch-specific code outside the router, and why it is not a gesture. */
const TOUCH_ALLOWLIST: Record<string, string> = {
  "timeline/TrackLane.tsx": "skips hover lane highlighting for a finger",
  "timeline/useRangeGesture.ts":
    "an armed Select range is the one mode that owns its touches",
  "timeline/precision/precisionController.ts":
    "the precision drag lab (#1184) owns a target the router handed it, and a second finger cancels it",
};

/** Pointer handlers on elements outside the routed lanes, by a marker in the element. */
const POINTER_ALLOWLIST: { file: string; marker: string; reason: string }[] = [
  {
    file: "timeline/TargetChooser.tsx",
    marker: "<button",
    reason: "the chooser's chips: router-owned overlay",
  },
  {
    file: "timeline/TargetChooser.tsx",
    marker: 'className="target-chooser-scrim"',
    reason: "the chooser's scrim closes it",
  },
  {
    file: "timeline/CreateMenu.tsx",
    marker: 'className="create-menu-scrim"',
    reason: "the create menu's scrim closes it",
  },
  {
    file: "timeline/CreateMenu.tsx",
    marker: 'role="menuitem"',
    reason: "create menu items: router-owned overlay",
  },
  {
    file: "timeline/TimeRulerView.tsx",
    marker: "data-testid={timelineTestIds.ruler}",
    reason: "the ruler sits above the routed lanes: seek and comment anchors",
  },
  {
    file: "timeline/PendingEditOverlayView.tsx",
    marker: 'className="pending-actionbar"',
    reason: "the portaled action card only stops presses reaching the lanes",
  },
  {
    file: "timeline/TimelineView.tsx",
    marker: "ref={lanesRef}",
    reason:
      "the lanes' capture for an armed Select range, the one mode that owns its touches",
  },
];

/** Arrow keys outside the command bus's focused-handle commands, and why. */
const ARROW_ALLOWLIST: Record<string, string> = {
  "timeline/TimeRulerView.tsx": "the ruler seeks; it is not a target",
  "timeline/MarkerLaneView.tsx": "swallows keys while a marker drag is live",
  "timeline/ClipBlock.tsx": "swallows keys while a clip body drag is live",
  "timeline/useClipEdgeHandles.ts":
    "the focused handle's key release saves the run edit.setClipFade and edit.trimClipEdge stepped",
};

describe("timeline gesture governance", () => {
  it("keeps touch-specific handling in the router", () => {
    const touch =
      /\bon(Touch(Start|Move|End|Cancel))\s*=|addEventListener\(\s*["']touch|pointerType\s*[!=]==\s*["']touch["']|pointerType:\s*["']touch["']/;
    const offenders = timelineSources()
      .filter(({ rel, text }) => touch.test(text) && !ROUTER.has(rel))
      .map(({ rel }) => rel)
      .filter((rel) => !(rel in TOUCH_ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it("puts every pointerdown handler on an element the router can see", () => {
    const offenders: string[] = [];
    for (const { rel, text } of timelineSources()) {
      if (!rel.endsWith(".tsx")) continue;
      for (const element of jsxElements(text)) {
        if (!ownsPointerDown(element)) continue;
        const marked = markedKinds(element).length > 0 || marksSurface(element);
        const allowed = POINTER_ALLOWLIST.some(
          (entry) => entry.file === rel && element.text.includes(entry.marker),
        );
        if (!marked && !allowed) offenders.push(`${rel}:${element.line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("routes arrow-key edits through the focused-handle commands", () => {
    const offenders = timelineSources()
      .filter(({ text }) => /["']Arrow(Left|Right)["']/.test(text))
      .map(({ rel }) => rel)
      .filter((rel) => !ROUTER.has(rel) && !(rel in ARROW_ALLOWLIST));
    expect(offenders).toEqual([]);
  });

  it("keeps every allowlist entry live", () => {
    const sources = new Map(timelineSources().map((s) => [s.rel, s.text]));
    const stale = [
      ...Object.keys(TOUCH_ALLOWLIST),
      ...Object.keys(ARROW_ALLOWLIST),
      ...POINTER_ALLOWLIST.filter(
        (entry) => !sources.get(entry.file)?.includes(entry.marker),
      ).map((entry) => `${entry.file} ${entry.marker}`),
    ].filter((rel) => rel.includes(" ") || !sources.has(rel));
    expect(stale).toEqual([]);
  });
});
