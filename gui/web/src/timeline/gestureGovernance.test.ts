/**
 * One gesture router (#1096): the touch input grammar lives in the hit
 * router and its contract, not in each timeline component. These scans fail
 * when a component under `timeline/` grows its own touch handling, a pointer
 * handler on an element the router cannot see, or its own arrow-key edits.
 * Follows `commands/governance.test.ts`; an allowlist entry needs a reason.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  jsxElements,
  markedKinds,
  marksSurface,
  ownsPointerDown,
} from "../test/jsxElements";
import {
  SRC_ROOT,
  sourceFiles,
  srcRelative,
  walkTsFiles,
} from "../test/sourceFiles";

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
    marker: 'aria-label="Pending edit actions"',
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
  "timeline/EnvelopeOverlayView.tsx":
    "the focused DOM slider owns native arrow and Home/End value keys, previews locally, then saves one existing SetEnvelope on key release; no catalog command owns line level",
  "timeline/TimeRulerView.tsx": "the ruler seeks; it is not a target",
  "timeline/MarkerLaneView.tsx": "swallows keys while a marker drag is live",
  "timeline/ClipBlock.tsx": "swallows keys while a clip body drag is live",
  "timeline/useClipEdgeHandles.ts":
    "the focused handle's key release saves the run edit.setClipFade and edit.trimClipEdge stepped",
};

/**
 * The one gesture package in use (#1078): React Aria's press hooks, confined to
 * the touch press layer and the chooser's chip buttons. Pointer Events plus
 * `hooks/gestureConstants.ts` do everything else. The guard is a denylist of
 * known gesture and pointer libraries, not a proof that no other one exists:
 * add a name here when a new library of that kind appears.
 */
const PRESS_LIBRARY = "@react-aria/interactions";
const PRESS_LIBRARY_USERS = new Set([
  "timeline/useTouchPress.ts",
  "timeline/TargetChooser.tsx",
]);
const DENIED_GESTURE_PACKAGES = [
  /^@use-gesture\//,
  /^react-use-gesture$/,
  /^@dnd-kit\//,
  /^hammerjs$/,
  /^react-hammerjs$/,
  /^react-swipeable$/,
  /^interactjs$/,
  /^@interactjs\//,
  /^framer-motion$/,
  /^motion$/,
  /^react-aria$/,
  /^react-aria-components$/,
  /^@react-aria\/(dnd|gridlist|selection)$/,
];

function isDeniedGesturePackage(name: string): boolean {
  return DENIED_GESTURE_PACKAGES.some((pattern) => pattern.test(name));
}

/** Module specifiers a source file imports, requires or dynamically imports. */
function importedModules(text: string): string[] {
  const specifier = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  return [...text.matchAll(specifier)].map((match) => match[1]);
}

describe("gesture package governance", () => {
  it("recognizes known gesture libraries and nothing else", () => {
    expect(
      [
        "@use-gesture/react",
        "react-swipeable",
        "@dnd-kit/core",
        "hammerjs",
        "react",
        "@react-aria/interactions",
      ].map(isDeniedGesturePackage),
    ).toEqual([true, true, true, true, false, false]);
    expect(
      importedModules(
        'import a from "x";\nconst b = await import("y");\nconst c = require("z");\nexport { d } from "w";',
      ),
    ).toEqual(["x", "y", "z", "w"]);
  });

  // Reads every non-test source file under gui/web/src (about 670), which
  // took 4 to 9 s cold on a loaded machine, over Vitest's 5 s default.
  it("adopts no gesture package beyond the React Aria press layer (#1078)", () => {
    const manifest = JSON.parse(
      readFileSync(join(SRC_ROOT, "..", "package.json"), "utf8"),
    ) as Record<string, Record<string, string> | undefined>;
    const declared = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ].flatMap((field) => Object.keys(manifest[field] ?? {}));
    expect(declared.filter(isDeniedGesturePackage)).toEqual([]);

    const denied: string[] = [];
    const pressUsers = new Set<string>();
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = srcRelative(file);
      if (/\.(test|stories)\./.test(rel)) continue;
      for (const name of importedModules(readFileSync(file, "utf8"))) {
        if (isDeniedGesturePackage(name)) denied.push(`${rel} imports ${name}`);
        if (name === PRESS_LIBRARY) pressUsers.add(rel);
      }
    }
    expect(denied).toEqual([]);
    expect(pressUsers).toEqual(PRESS_LIBRARY_USERS);
  }, 30_000);
});

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
