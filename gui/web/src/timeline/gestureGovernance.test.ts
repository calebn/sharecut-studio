/**
 * One gesture router (#1096): the touch input grammar lives in the hit
 * router and its contract, not in each timeline component. These scans fail
 * when a component under `timeline/` grows its own touch handling, a pointer
 * handler on an element the router cannot see, or its own arrow-key edits.
 * The last scan walks all of `gui/web/src/` (#1795): any other file that owns
 * a pointer press, touch, slider or drag handle must be a surface that keeps
 * its own gesture, with the decision it keeps written beside it.
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
  "timeline/ClipBlock.tsx":
    "Alt-press is a split-guide modifier, so a clip body ignores it for a mouse only",
  "timeline/useSplitAtPointer.ts":
    "Alt-click Split is mouse only; a finger has no Alt and never splits",
  "timeline/precision/precisionController.ts":
    "the precision drag lab (#1184) owns a target the router handed it, and a second finger cancels it",
};

/** Pointer handlers on elements outside the routed lanes, by a marker in the element. */
const POINTER_ALLOWLIST: { file: string; marker: string; reason: string }[] = [
  {
    file: "timeline/TimelineChooser.tsx",
    marker: 'className="timeline-chooser-host"',
    reason:
      "records the pointer type and suppresses the compat mousedown of a chip press; the router owns the gesture",
  },
  {
    file: "timeline/TimelineCreateMenu.tsx",
    marker: 'className="timeline-create-scrim"',
    reason: "the create menu's scrim closes it",
  },
  {
    file: "timeline/PendingEditOverlayView.tsx",
    marker: 'aria-label="Pending edit actions"',
    reason: "the portaled action card only stops presses reaching the lanes",
  },
  {
    file: "timeline/TrimHint.tsx",
    marker: 'role="presentation"',
    reason: "the portaled trim tip only stops presses reaching the lanes",
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
  "timeline/ClipBlock.tsx": "swallows keys while a clip body drag is live",
  "timeline/useClipEdgeHandles.ts":
    "the focused handle's key release saves the run edit.setClipFade and edit.trimClipEdge stepped",
};

/**
 * No gesture package is in use: Pointer Events plus
 * `hooks/gestureConstants.ts` do everything. The guard is a denylist of
 * known gesture and pointer libraries, not a proof that no other one exists:
 * add a name here when a new library of that kind appears.
 */
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
  /^@react-aria\//,
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
    ).toEqual([true, true, true, true, false, true]);
    expect(
      importedModules(
        'import a from "x";\nconst b = await import("y");\nconst c = require("z");\nexport { d } from "w";',
      ),
    ).toEqual(["x", "y", "z", "w"]);
  });

  // Reads every non-test source file under gui/web/src (about 670), which
  // took 4 to 9 s cold on a loaded machine, over Vitest's 5 s default.
  it("adopts no gesture package (#1078, #1312)", () => {
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
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = srcRelative(file);
      if (/\.(test|stories)\./.test(rel)) continue;
      for (const name of importedModules(readFileSync(file, "utf8"))) {
        if (isDeniedGesturePackage(name)) denied.push(`${rel} imports ${name}`);
      }
    }
    expect(denied).toEqual([]);
  }, 30_000);
});

/**
 * Surfaces outside `timeline/` that keep their own gesture, and the decision
 * each keeps. A gesture here is not in the hit router's grammar on purpose:
 * it moves a control, not a timeline target. A new surface with its own
 * gesture adds a line here, or routes through `commands/gestures.ts`.
 */
const SURFACE_GESTURES: Record<string, string> = {
  "stage/frame/useAnnounceStageSwitch.ts":
    "only notes that a Stage tab was pressed, so a mouse click on a tab is not announced as a key switch; it starts no gesture and moves nothing",
  "hooks/useLongPress.ts":
    "one long-press timing for track headers, transcript words and the rail's icon-only labels (gestureConstants)",
  "hooks/useTwoFingerTap.ts":
    "two-finger tap is Undo (the Two-finger tap row in commands/gestures.ts), read from window pointers",
  "hooks/usePointerType.ts":
    "reads the last pointer kind to pick touch or mouse copy; it starts no gesture",
  "hooks/useUserScrollIntent.ts":
    "tells a wheel or press scroll from the follow-playhead scroll; it starts no gesture",
  "hooks/useTimelineFocusRegion.ts":
    "a mousedown inside the timeline or a panel sets which one keys address; it starts no gesture",
  "hooks/useCommitRange.ts":
    "slider commit: a drag previews locally and saves one value on release",
  "feedback/FeedbackToast.tsx":
    "a press outside a toast dismisses it; it starts no gesture",
  "ui/useOutsidePointerDown.ts":
    "a press outside an open popover closes it; it starts no gesture",
  "ui/Menu.tsx":
    "a press on an open menu's trigger keeps focus there instead of closing and reopening it; menu items take presses as plain buttons",
  "ui/useDrawerSwipe.ts":
    "sheet drag: the grabber drags a bottom sheet between detents; a range input under it keeps the keyboard and screen reader path",
  "ui/BottomSheet.tsx":
    "the detent slider under the grabber is the keyboard and screen reader path to the same detents",
  "models/useModelNeedFocus.ts":
    "cancels a delayed model-action focus handoff when a press or focus move happens before the action is ready; it starts no gesture, captures no pointer and never consumes the event; focusin also covers keyboard navigation",
  "stage/edit/useViewAnchor.ts":
    "a new press cancels pending View focus recovery; it starts no gesture and intercepts no pointer action",
  "stage/edit/InspectorHost.tsx":
    "the Close control's capture-phase pointer observer runs before default focus transfer and matches focus restoration to the press; it starts no gesture and takes no pointer capture, while InspectorSheet and useGrab own the detent drag",
  "stage/edit/ScriptDivider.tsx":
    "divider: a drag resizes the Script pane beside the timeline; the arrow keys, Enter and double-click do the same by key",
  "system/Player.tsx":
    "hold to hear: a press on A hears the original and letting go after a hold goes back; a quick release latches it, and the A and B buttons do the same by key",
  "stage/edit/TrackColumn.tsx":
    "reorder drop: the column takes a track header dragged over a header slot and moves the track on drop; Shift with Up or Down on a header and the Move up and Move down commands do the same by key",
  "transcript/TranscriptWordbar.tsx":
    "the waveform handles preview a word's timing and save one adjustment on release; Escape cancels, and the Start and End Scrub fields do the same by key",
  "system/Seam.tsx":
    "the pill's edges roll the seam with pointer capture and save one roll on release; Alt with an arrow key rolls it 1 ms",
  "system/useSourceReorder.ts":
    "source reorder: a pointer drag on a Source card's grip, with pointer capture, moves the card among the session's cards and saves one new order on release; Escape, a cancel or a lost capture put it back; the card menu moves a source by key; it is a list reorder, not a timeline target",
  "system/wavePointer.ts":
    "the pointer helpers shared by the suggestion and clip trim handles: a pointer position as a ratio of a strip, and a safe pointer capture; no gesture of its own",
  "system/useScriptGestures.ts":
    "the script text's own selection gestures, by delegation on the pane's body with pointer capture: a mouse or pen drag from a word selects to the word under the pointer, a touch long press then drag does the same while a swipe before the hold scrolls, the body scrolls itself near its edges, and Esc, a lost pointer, a blur or a second finger end it uncommitted (D-script-gestures, which supersedes D-transcript-longpress-range); every gesture has a key path, Shift with the arrows, Enter and F2, so it is a text selection, not a timeline target",
  "system/SelectionHandles.tsx":
    "the script text's selection grips: a drag on either end moves an edge of the selected words by word with pointer capture, and a tap that never moves passes through to the word under it; the grips have no keys, because Shift and Alt+Shift with the arrows do the same from the words; it is a text selection, not a timeline target",
  "system/Clip.tsx":
    "the clip view: a press on its body or a handle is captured and reported as drag start, drag and drag end intents with the pointer, its keys and pixels from the press, and a finger only grabs a selected clip; it edits nothing and owns no timeline target, because the lane host that mounts it turns the intents into one edit",
  "system/Ruler.tsx":
    "the time ruler view: a press on its body is captured and reported as scrub start, scrub and scrub end intents with the pointer and its keys, a tap seeks, and a press on a selection handle reports drag start, drag and drag end intents for the host to turn into one range edit; a finger scrubs by a horizontal swipe because the body leaves vertical panning to the browser; it edits nothing and owns no timeline target, because the host that mounts it turns the intents into one seek or edit",
  "system/MarkerLane.tsx":
    "the marker lane view: a press on a chapter, a bracket or a bracket's edge is captured and reported as drag start, drag and drag end intents with the pointer, its keys and seconds from the press, and a finger only grabs a selected marker; a double-click on an empty part asks the host to add a chapter; it edits nothing and owns no timeline target, because the host that mounts it turns the intents into one edit",
  "system/Envelope.tsx":
    "the volume envelope view: a press on a point is captured (useGrab) and reported as drag start, move and drag end intents with the level and time, a click on the line asks the host to add a point, and a finger only grabs through the points' own 44 px areas; it edits nothing and owns no timeline target, because the host that mounts it turns the intents into one edit",
  "stages/edit/chooserStoryHost.tsx":
    "the Storybook host of the Edit target chooser: a press held on its surface opens the fan, a slide reports the chip under the finger as over, and a lift picks or cancels, with pointer capture on the surface; it is a story fixture that owns a stub press surface, and the app's hit router owns the real gesture",
  "stages/edit/timelineDemo.tsx":
    "the Storybook host of the Edit timeline parts: it passes the envelope's drag start and drag end intents to local state, so a cancelled drag puts the point back; it is a story fixture, not a surface",
  "system/ProjectCard.tsx":
    "the Home project card: a touch long press or a right click opens its actions menu, and a touch swipe left shows Remove from list (useSwipeReveal); Enter opens the card, Shift+F10 or the Menu key opens the same menu, and the menu's Remove from list is the key path; it edits no timeline target",
  "system/useSwipeReveal.ts":
    "a touch swipe left slides a row over to show the action behind it, and a swipe right or a tap elsewhere closes it; a mouse never swipes, and the row's actions menu holds the same action by key; it moves one row and owns no timeline target",
  "system/useGrab.ts":
    "the pointer lifecycle the ruler and the marker lane share for a dragged mark: one pointer has hold, the drag starts after the slop, and Escape, a blur, a cancel, a lost capture or the owner leaving end it as not committed; it reports intents and owns no timeline target",
  "system/TrackHeader.tsx":
    "the track header is draggable except on its controls so the column can reorder it by HTML drag; Shift with Up or Down asks the host to do the same by key; it is not a timeline target",
  "system/SuggestionWaveform.tsx":
    "a suggestion's edge handles move a control inside one Decision card, not a timeline target; they preview the range and the card saves on decision",
  "stages/deliver/ClipTrimWave.tsx":
    "a clip's In and Out handles move a control inside one Deliver clip card, not a timeline target; a drag snaps to words and edits the clip's range",
  "system/RecordButton.tsx":
    "the Record button: a 600 ms press-and-hold stops a live take, and Enter or Space asks first; it is not a timeline target",
  "system/ScriptPane.tsx":
    "observes native scrolling to retain the guest reading place; word-selection gestures remain in useScriptGestures and grips remain in SelectionHandles",
  "system/ScrubField.tsx":
    "the scrub field: a horizontal drag previews a number and saves one value on release; it is an inspector field, not a timeline target",
  "system/TimeField.tsx":
    "a number field's grip drags its own value, 4 px to start; a field edit, not a timeline target",
  "system/useCoachTip.ts":
    "a press or key anywhere dismisses the one coach tip on screen; it starts no gesture",
  "system/useHoverTip.ts":
    "a hover tip opens for a mouse or pen and never for a touch; it starts no gesture",
  "system/useSwipeDecision.ts":
    "the Review card and queue row swipe: right is the verb, left is Keep, up is Later (the Swipe right and Swipe left rows in verbs.ts), 80 px to commit",
  "presence/usePresenceCursorSource.ts":
    "reads the pointer to publish a presence cursor; it starts no gesture",
  "review/ReviewStage.tsx":
    "a pointerdown outside the stage clears which row the keys address; it starts no gesture",
};

/** A file that owns a pointer press, touch, slider, drag handle or capture. */
const OWNS_GESTURE =
  /\bon(Touch(Start|Move|End|Cancel)|Pointer(Down|Move|Up|Cancel)(Capture)?)\b\s*[=:(]|\bonDragStart\s*=|\bdraggable\b|type="range"|setPointerCapture|addEventListener\(\s*["'](touch|pointer|mouse)(start|down|move|up|end|cancel)|pointerType\s*[!=]==\s*["']touch["']|pointerType:\s*["']touch["']/;

/** Arrow keys outside `timeline/`, and why they are not a timeline edit. */
const SRC_ARROW_ALLOWLIST: Record<string, string> = {
  "commands/focusedClipHandle.ts":
    "the focused-handle registry the timeline's arrow edits run through",
  "keymap/registry.ts": "the keymap rows that bind the arrows",
  "system/SuggestionWaveform.tsx":
    "a focused suggestion handle moves its edge with the arrows, 0.05 s and 0.5 s with Shift, like a slider",
  "stages/deliver/ClipTrimWave.tsx":
    "a focused clip trim handle moves its edge with the arrows, 10 ms and 100 ms with Shift, like a slider",
  "stage/edit/ScriptDivider.tsx":
    "the separator pattern: Left and Right move the divider between the timeline and the Script pane",
  "system/Clip.tsx":
    "a focused clip handle reports a nudge of its edge with the arrows, 10 ms and 100 ms with Shift, like a slider, and Alt with the arrows walks focus along the handles; the host applies the nudge",
  "system/Ruler.tsx":
    "a focused ruler moves the playhead one tick with the arrows, ten with Shift, and a focused selection handle reports a nudge of its edge, 10 ms and 100 ms with Shift, like a slider; Alt with the arrows walks focus to the handles; the host applies the seek or the nudge",
  "system/MarkerLane.tsx":
    "a focused selected chapter or bracket, and a bracket's edge, report a nudge with the arrows, 0.1 s and 1 s with Shift, like a slider, and Alt with the arrows walks focus along a bracket's edges; the host applies the nudge",
  "system/OverviewStrip.tsx":
    "a focused overview strip moves the playhead one second with the arrows, ten with Shift, and Home and End go to the ends, like a slider; the host applies the seek",
  "system/Envelope.tsx":
    "a focused envelope point nudges its time (10 ms, 100 ms with Shift) and level (0.5 dB, 5 with Shift) with the arrows, like a slider, and Alt with Left or Right walks focus along the points; a guest's plain arrows are not the envelope's and reach the keymap (Up and Down only have their browser scroll prevented), while Alt with Left or Right is still kept from it; the host applies the nudge",
  "system/useGrab.ts":
    "the list of keys a part ignores while its drag is moving, so a nudge cannot land mid-drag; it moves nothing itself",
  "system/InspectorSheet.tsx":
    "the focused sheet grip is a vertical slider: Up and Down step the detent and Home and End go to the ends, like a slider; the host applies the detent",
  "system/ScrubField.tsx":
    "a focused scrub field steps its number with the arrows, ten times as far with Shift and a tenth with Alt, like a spinbutton",
  "system/scriptSelection.ts":
    "the pure helper behind the script pane's arrows: it turns a key and a position into a caret move or a word selection, and moves nothing itself",
  "system/Seam.tsx":
    "the Script pill's key path to its edge drag: Alt with Left or Right rolls the seam 1 ms, saved as one roll; the host decides whether the clips can roll",
  "system/TakeSwitcher.tsx":
    "the take switcher steps to the previous or next take with the arrows and stops there, like a radio group; the host selects the take",
  "ui/Tabs.tsx": "the ARIA tablist pattern: arrows move among the tabs",
  "ui/useMenuKeyboard.ts": "arrows step through the items of an open menu",
};

function srcSources() {
  return walkTsFiles(SRC_ROOT)
    .map((file) => ({ file, rel: srcRelative(file) }))
    .filter(
      ({ rel }) =>
        !/\.(test|stories)\./.test(rel) &&
        !rel.startsWith("test/") &&
        !rel.startsWith("timeline/"),
    )
    .map(({ file, rel }) => ({ rel, text: readFileSync(file, "utf8") }));
}

describe("gesture governance across src", () => {
  it("lists every surface outside timeline/ that keeps its own gesture", () => {
    const owners = srcSources()
      .filter(({ text }) => OWNS_GESTURE.test(text))
      .map(({ rel }) => rel)
      .sort();
    expect(owners).toEqual(Object.keys(SURFACE_GESTURES).sort());
  });

  it("states a decision for each surface", () => {
    for (const [rel, decision] of Object.entries(SURFACE_GESTURES)) {
      expect(decision.length, rel).toBeGreaterThan(30);
    }
  });

  it("keeps arrow-key edits out of src files that are not widgets or the keymap", () => {
    const sources = srcSources();
    const offenders = sources
      .filter(({ text }) => /["']Arrow(Left|Right)["']/.test(text))
      .map(({ rel }) => rel)
      .filter((rel) => !(rel in SRC_ARROW_ALLOWLIST));
    expect(offenders).toEqual([]);
    const stale = Object.keys(SRC_ARROW_ALLOWLIST).filter(
      (rel) =>
        !sources.some(
          ({ rel: found, text }) =>
            found === rel && /["']Arrow(Left|Right)["']/.test(text),
        ),
    );
    expect(stale).toEqual([]);
  });
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
