/**
 * Conformance (#1096): every hit kind in `HIT_KINDS` behaves as its contract
 * says, for every input. The cases are generated from the table, so a new
 * kind gets them all without a new test, and a kind whose row changes fails
 * here until the router, strip and keys agree. A scan of the timeline's
 * components checks that every kind with an axis is marked on an element
 * that owns its drag, and that no drag hides behind a plain surface, so a
 * mouse drag cannot lose its touch path unnoticed (the clip move did once).
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nudgeAxis, nudgeStep } from "../edit/nudge";
import { softBoundaries } from "../edit/nudgeBoundaries";
import { TOUCH_SLOP_PX } from "../hooks/gestureConstants";
import { peekTarget } from "../inspector/peekTarget";
import { argsFromKeyEvent, KEYMAP_COMMANDS } from "../keymap/registry";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../test/fixtures";
import { button, press } from "../test/hitDom";
import {
  jsxElements,
  markedKinds,
  marksSurface,
  ownsPointerDown,
} from "../test/jsxElements";
import { SRC_ROOT, sourceFiles } from "../test/sourceFiles";
import type { Selection } from "../types/project";
import {
  ARMED_ATTR,
  type ArmedTarget,
  attachHitRouting,
  type HitRouter,
  isReplayed,
} from "./hitRouting";
import { hitTargetProps } from "./hitTargets";
import {
  HIT_KIND_NAMES,
  HIT_KINDS,
  type HitKind,
  longPressAction,
  secondFingerAction,
  softMover,
  tapAction,
} from "./inputContract";

const clip = clipRow({
  id: "c2",
  track_id: "host",
  source_start: 10,
  source_end: 40,
  timeline_start: 10,
  timeline_end: 40,
  fade_in_ms: 300,
  fade_out_ms: 300,
});
const project = minimalProject({
  tracks: [sampleTrack({ id: "host", duration_sec: 60 })],
  clips: { tracks: { host: [clip] }, clip_count: 1 },
  chapters: [{ time: 30, title: "Middle" }],
  pending_edits: [
    pendingEditView({
      id: "p1",
      track_id: "host",
      track_ids: ["host"],
      source_start: 20,
      source_end: 24,
      source_start_timeline: 20,
      source_end_timeline: 24,
      timeline_start: 20,
      timeline_end: 24,
      timeline_spans: [{ start: 20, end: 24 }],
    }),
  ],
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [{ id: "e1", time: 16, value: 0.8 }],
    },
  ],
});

/** The id and time each kind's target has in `project`. */
const TARGET: Record<HitKind, { id: string; sec: number }> = {
  join: { id: "c2", sec: 10 },
  "envelope-point": { id: "e1", sec: 16 },
  "pending-start": { id: "p1", sec: 20 },
  "pending-end": { id: "p1", sec: 24 },
  "pending-flag": { id: "p1", sec: 20 },
  roll: { id: "c2", sec: 10 },
  "fade-in": { id: "c2", sec: 10.3 },
  "fade-out": { id: "c2", sec: 39.7 },
  "crossfade-end": { id: "c2", sec: 10.15 },
  "trim-in": { id: "c2", sec: 10 },
  "trim-out": { id: "c2", sec: 40 },
  chapter: { id: "30-Middle", sec: 30 },
  "social-clip": { id: "s1", sec: 50 },
  clip: { id: "c2", sec: 10 },
};

/** The selection the strip shows each kind's rows for. */
function selectionFor(kind: HitKind): Selection {
  if (kind.startsWith("pending")) {
    return { kind: "pending", id: "p1", trackId: "host" };
  }
  if (kind === "envelope-point") {
    return { kind: "envelopePoint", trackId: "host", pointId: "e1" };
  }
  return { kind: "clip", id: "c2", trackId: "host" };
}

let root: HTMLDivElement;
let router: HitRouter;
let log: string[];
let armed: (ArmedTarget | null)[];
let restored: number;

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  armed = [];
  restored = 0;
  root = document.createElement("div");
  document.body.append(root);
  document.elementFromPoint = () => null;
  root.addEventListener(
    "pointerdown",
    (e) => {
      if (router.defers(e)) e.stopPropagation();
    },
    true,
  );
  router = attachHitRouting(root, {
    touchLab: () => true,
    onArm: (target) => armed.push(target),
    snapshot: () => () => {
      restored += 1;
    },
  });
});

afterEach(() => {
  router.dispose();
  root.remove();
  vi.useRealTimers();
});

/** One target of `kind`, alone, a 12 px box centred on (200, 112). */
function lone(kind: HitKind): HTMLButtonElement {
  const el = button(hitTargetProps(kind, TARGET[kind].id, TARGET[kind].sec), {
    left: 194,
    top: 106,
    right: 206,
    bottom: 118,
  });
  root.append(el);
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "click",
  ]) {
    el.addEventListener(type, (e) => {
      if (!isReplayed(e)) return;
      const p = e as PointerEvent;
      log.push(`${type}@${p.clientX},${p.clientY}`);
    });
  }
  return el;
}

/** Timeline elements that own a pointer press, and what they mark themselves as. */
const PRESS_OWNERS = [...sourceFiles(join(SRC_ROOT, "timeline"))]
  .filter(
    ({ rel }) =>
      rel.endsWith(".tsx") &&
      !rel.includes(".test.") &&
      !rel.includes(".stories."),
  )
  .flatMap(({ rel, text }) =>
    jsxElements(text)
      .filter(ownsPointerDown)
      .map((element) => ({
        at: `${rel}:${element.line}`,
        kinds: markedKinds(element),
        surface: marksSurface(element),
      })),
  );

describe("touch paths", () => {
  it("finds the timeline's press owners", () => {
    expect(PRESS_OWNERS.length).toBeGreaterThan(HIT_KIND_NAMES.length);
  });

  it("starts no drag on a plain surface, where a long-press opens the create menu", () => {
    expect(
      PRESS_OWNERS.filter((o) => o.surface && o.kinds.length === 0).map(
        (o) => o.at,
      ),
    ).toEqual([]);
  });
});

const OUTRANKS = HIT_KIND_NAMES.flatMap((winner) =>
  HIT_KINDS[winner].outranks.map((loser) => [winner, loser] as const),
);

describe.each(OUTRANKS)("%s outranks %s (#1135)", (winner, loser) => {
  it("names a real kind", () => {
    expect(HIT_KIND_NAMES).toContain(loser);
  });

  /** The join cluster: a wide roll seam under a nearer, narrow trim strip. */
  function cluster() {
    const wide = lone(winner);
    const narrow = button(hitTargetProps(loser as HitKind, "c3", 10), {
      left: 198,
      top: 100,
      right: 206,
      bottom: 160,
    });
    const both = { wide, narrow };
    for (const el of [wide, narrow])
      el.setAttribute("data-hit-selected", "true");
    root.append(narrow);
    narrow.addEventListener("pointerdown", (e) => {
      if (isReplayed(e)) log.push("loser:pointerdown");
    });
    return both;
  }

  it("takes a plain mouse grab though the other is nearer", () => {
    const { narrow } = cluster();
    narrow.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        clientX: 202,
        clientY: 112,
      }),
    );

    expect(log).toEqual(["pointerdown@202,112"]);
  });

  it("leaves the other in the chooser for a long press", () => {
    const views: string[][] = [];
    router.dispose();
    router = attachHitRouting(root, {
      touchLab: () => true,
      onChooser: (view) =>
        view && views.push(view.hits.map((h) => h.candidate.kind)),
    });
    const { narrow } = cluster();
    press(narrow, "pointerdown", 202, 112);
    router.longPress();

    expect(views[0]).toEqual([winner, loser]);
  });
});

describe.each(HIT_KIND_NAMES)("%s", (kind) => {
  const contract = HIT_KINDS[kind];

  // A long-press arms a kind with an axis, and the router replays the drag
  // on the element that marks it; one without an axis only selects.
  it(
    contract.axis === "none"
      ? "owns no drag, which a finger could not reach"
      : "has a reachable touch path: an element that marks it owns the drag",
    () => {
      const owners = PRESS_OWNERS.filter((o) => o.kinds.includes(kind));
      if (contract.axis === "none") expect(owners).toEqual([]);
      else expect(owners).not.toEqual([]);
    },
  );

  // A selected target keeps the touch from scrolling, and still waits for
  // the long press: no draggable kind drags on touch until armed.
  it.skipIf(contract.axis === "none")(
    "drags on touch only once a long press arms it, selected or not",
    () => {
      const el = lone(kind);
      el.setAttribute("data-hit-selected", "true");
      press(el, "pointerdown", 200, 112);
      press(el, "pointermove", 230, 132);
      press(el, "pointerup", 230, 132);
      vi.runAllTimers();
      expect(log).toEqual([]);

      press(el, "pointerdown", 200, 112);
      router.longPress();
      press(el, "pointermove", 230, 112);
      press(el, "pointerup", 230, 112);
      vi.runAllTimers();
      expect(log.slice(0, 2)).toEqual([
        "pointerdown@200,112",
        "pointermove@230,112",
      ]);
    },
  );

  it("one finger moving never edits it", () => {
    const el = lone(kind);
    press(el, "pointerdown", 200, 112);
    press(el, "pointermove", 200 + TOUCH_SLOP_PX * 4, 112);
    press(el, "pointerup", 200 + TOUCH_SLOP_PX * 4, 112);
    vi.runAllTimers();

    expect(log).toEqual([]);
  });

  it(`a tap does: ${tapAction(kind)}`, () => {
    const el = lone(kind);
    press(el, "pointerdown", 200, 112);
    press(el, "pointerup", 201, 112);
    vi.runAllTimers();

    expect(log).toEqual([
      "pointerdown@200,112",
      "pointerup@200,112",
      "click@200,112",
    ]);
    expect(armed).toEqual([]);
  });

  it(`a long-press does: ${longPressAction(kind)}`, () => {
    const el = lone(kind);
    press(el, "pointerdown", 200, 112);
    router.longPress();

    if (longPressAction(kind) === "arm") {
      expect(el.hasAttribute(ARMED_ATTR)).toBe(true);
      expect(armed).toEqual([
        { kind, id: TARGET[kind].id, axis: contract.axis },
      ]);
      expect(log).toEqual(["pointerdown@200,112"]);
    } else {
      expect(el.hasAttribute(ARMED_ATTR)).toBe(false);
      expect(armed).toEqual([]);
      vi.runAllTimers();
      expect(log).toEqual([
        "pointerdown@200,112",
        "pointerup@200,112",
        "click@200,112",
      ]);
    }
  });

  it(`an armed drag moves along: ${contract.axis}`, () => {
    const el = lone(kind);
    press(el, "pointerdown", 200, 112);
    router.longPress();
    press(el, "pointermove", 230, 132);
    press(el, "pointerup", 230, 132);
    vi.runAllTimers();

    const moves = log.filter((line) => line.startsWith("pointermove"));
    expect(moves).toEqual(
      contract.axis === "xy"
        ? ["pointermove@230,132"]
        : contract.axis === "x"
          ? ["pointermove@230,112"]
          : [],
    );
  });

  it(`a second finger does: ${secondFingerAction(kind)}`, () => {
    const el = lone(kind);
    press(el, "pointerdown", 200, 112);
    router.longPress();
    press(el, "pointermove", 230, 112);
    press(el, "pointerdown", 400, 140, 8);
    press(el, "pointerup", 230, 112);
    press(el, "pointerup", 400, 140, 8);
    vi.runAllTimers();

    expect(el.hasAttribute(ARMED_ATTR)).toBe(false);
    expect(restored).toBe(1);
    if (longPressAction(kind) === "arm") {
      expect(log.at(-1)).toBe("pointercancel@200,112");
      expect(log).not.toContain("pointerup@230,112");
    }
  });

  it(`its strip rows are: ${contract.nudges.join(", ") || "none"}`, () => {
    if (contract.nudges.length === 0) return;
    const peek = peekTarget(project, selectionFor(kind), {
      kind,
      id: TARGET[kind].id,
    });
    expect([...new Set(peek?.nudges.map((row) => row.field.kind))]).toEqual(
      contract.nudges,
    );
  });

  it(`soft boundaries ${contract.soft ? "apply" : "do not apply"}`, () => {
    const mover = softMover(project, kind, TARGET[kind].id, TARGET[kind].sec);
    if (!contract.soft) {
      expect(mover).toBeNull();
      return;
    }
    expect(mover).not.toBeNull();
    const at = softBoundaries(project, mover!, 35).map((b) => b.label);
    expect(at).toContain("the playhead");
  });

  it(`its keys: ${contract.keys}`, () => {
    const arrowBound = KEYMAP_COMMANDS.filter(
      (cmd) =>
        cmd.id === contract.command &&
        cmd.keys.some((key) => key === "ArrowLeft" || key === "ArrowRight"),
    );
    if (contract.keys === "activate") {
      expect(arrowBound).toEqual([]);
      return;
    }
    expect(arrowBound).toHaveLength(1);
    expect(
      argsFromKeyEvent(
        { key: "ArrowRight", shiftKey: false, repeat: true },
        contract.command!,
      ),
    ).toMatchObject({ phase: "nudge", held: true });
    // A held arrow steps the same field as the strip's first row, and stops
    // where a held nudge does.
    const field =
      contract.nudges[0] === "fade" || contract.nudges[0] === "trim"
        ? {
            kind: contract.nudges[0],
            trackId: "host",
            clipId: "c2",
            edge: kind.endsWith("-out") ? ("out" as const) : ("in" as const),
          }
        : null;
    expect(field).not.toBeNull();
    const axis = nudgeAxis(project, field!)!;
    const delta = field!.kind === "fade" ? 10 : 0.01;
    const from = axis.at(axis.value);
    const to = axis.at(axis.value + delta);
    // The playhead halfway along the step: a held step stops there exactly
    // when the kind takes soft boundaries.
    const playhead = from != null && to != null ? (from + to) / 2 : 0;
    const boundaries = axis.mover
      ? softBoundaries(project, axis.mover, playhead)
      : [];
    const step = nudgeStep(axis, boundaries, axis.value, delta, true);
    expect(step.stop?.kind === "boundary").toBe(contract.soft);
  });
});
