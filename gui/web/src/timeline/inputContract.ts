/**
 * The touch input grammar's single source (#1051, governance #1096). Every
 * hit-testable timeline target kind declares here how each input treats it;
 * the hit router, the target chooser, the peek strip, the keyboard and the
 * conformance tests (`inputContract.conformance.test.ts`) all read this table,
 * so a new kind cannot ship with its own gesture rules.
 *
 * The grammar, as the owner approved it on 2026-10-06:
 * - one finger moving scrolls and never edits;
 * - a tap selects;
 * - a long-press arms a target (the chooser fans out when targets crowd), and
 *   only an armed target drags, along its own axes; lifting commits;
 * - a long-press on empty timeline space opens the create menu;
 * - a second finger cancels and rolls back any uncommitted one-finger action;
 * - held nudges and held arrow keys stop at soft boundaries; drags get a
 *   brief detent there; hard limits always stop.
 */
import type { NudgeKind } from "../edit/nudge";
import type { NudgeMover } from "../edit/nudgeBoundaries";
import type { ProjectView } from "../types/project";

/**
 * How an armed target drags: along time (`x`), in time and value (`xy`), or
 * not at all (`none`: a target that only takes taps, and a long-press on it
 * selects instead of arming).
 */
export type DragAxis = "x" | "xy" | "none";

/** Keyboard on a focused target: arrows step its value, or it only activates. */
export type KeyInput = "arrows" | "activate";

/** The catalog command an armed drag (and the arrow keys) of a kind runs. */
export type KindCommand =
  | "edit.setClipFade"
  | "edit.trimClipEdge"
  | "edit.rollClipJoin";

export interface HitKindContract {
  /** Tie-break when targets crowd one spot (higher wins). */
  priority: number;
  /** The kind's name in the chooser, the strip and announcements. */
  label: string;
  /** Axes an armed drag moves it along. */
  axis: DragAxis;
  /** Nudge rows the strip shows for it, in order (`edit/nudge.ts`). */
  nudges: readonly NudgeKind[];
  /**
   * Soft boundaries apply to it (`edit/nudgeBoundaries.ts`): its moving point
   * moves in time, so a drag detents and a held nudge or arrow key stops at
   * the playhead, chapters and neighbouring edges.
   */
  soft: boolean;
  keys: KeyInput;
  /**
   * The catalog command its drag runs, when it has one; the capabilities
   * manifest lists the touch gestures for it (`inputContract.manifest.test.ts`).
   */
  command: KindCommand | null;
  /**
   * Kinds this one beats wherever both are in reach, however near the
   * other is: a plain grab at a join rolls it rather than ripple-trimming
   * the clip beside it (#1135). The chooser still lists both.
   */
  outranks: readonly string[];
}

/** Every hit-testable timeline target kind and its input contract. */
export const HIT_KINDS = {
  join: {
    priority: 10,
    label: "Join",
    axis: "none",
    nudges: [],
    soft: false,
    keys: "activate",
    command: null,
    outranks: [],
  },
  "envelope-point": {
    priority: 9,
    label: "Envelope point",
    axis: "xy",
    nudges: ["envelope-time", "envelope-level"],
    soft: true,
    keys: "activate",
    command: null,
    outranks: [],
  },
  "pending-start": {
    priority: 8,
    label: "Pending start",
    axis: "x",
    nudges: ["pending"],
    soft: true,
    keys: "activate",
    command: null,
    outranks: [],
  },
  "pending-end": {
    priority: 8,
    label: "Pending end",
    axis: "x",
    nudges: ["pending"],
    soft: true,
    keys: "activate",
    command: null,
    outranks: [],
  },
  "pending-flag": {
    priority: 7,
    label: "Pending split",
    axis: "none",
    nudges: [],
    soft: false,
    keys: "activate",
    command: null,
    outranks: [],
  },
  roll: {
    priority: 6,
    label: "Roll",
    axis: "x",
    nudges: [],
    soft: true,
    keys: "activate",
    command: "edit.rollClipJoin",
    outranks: ["trim-in", "trim-out"],
  },
  "fade-in": {
    priority: 5,
    label: "Fade in",
    axis: "x",
    nudges: ["fade"],
    soft: true,
    keys: "arrows",
    command: "edit.setClipFade",
    outranks: [],
  },
  "fade-out": {
    priority: 5,
    label: "Fade out",
    axis: "x",
    nudges: ["fade"],
    soft: true,
    keys: "arrows",
    command: "edit.setClipFade",
    outranks: [],
  },
  // A trim of the start ripples: the clip's start stays put and its content
  // slides under it, so nothing moves in time for a boundary to stop.
  "trim-in": {
    priority: 4,
    label: "Trim start",
    axis: "x",
    nudges: ["trim"],
    soft: false,
    keys: "arrows",
    command: "edit.trimClipEdge",
    outranks: [],
  },
  "trim-out": {
    priority: 4,
    label: "Trim end",
    axis: "x",
    nudges: ["trim"],
    soft: true,
    keys: "arrows",
    command: "edit.trimClipEdge",
    outranks: [],
  },
  chapter: {
    priority: 3,
    label: "Chapter",
    axis: "x",
    nudges: [],
    soft: true,
    keys: "activate",
    command: null,
    outranks: [],
  },
  "social-clip": {
    priority: 2,
    label: "Social clip",
    axis: "x",
    nudges: [],
    soft: true,
    keys: "activate",
    command: null,
    outranks: [],
  },
} as const satisfies Record<string, HitKindContract>;

export type HitKind = keyof typeof HIT_KINDS;

export const HIT_KIND_NAMES = Object.keys(HIT_KINDS) as HitKind[];

export function isHitKind(value: unknown): value is HitKind {
  return typeof value === "string" && Object.hasOwn(HIT_KINDS, value);
}

/** What a tap does to any target. */
export type TapAction = "select";
/** What a long-press does: arm a target that drags, select one that does not. */
export type LongPressAction = "arm" | "select";
/** What a second finger does to any uncommitted one-finger action. */
export type SecondFingerAction = "cancel";

export function tapAction(_kind: HitKind): TapAction {
  return "select";
}

export function longPressAction(kind: HitKind): LongPressAction {
  return HIT_KINDS[kind].axis === "none" ? "select" : "arm";
}

/** `winner` beats `loser` wherever both are in reach (`outranks`). */
export function outranks(winner: HitKind, loser: HitKind): boolean {
  return (HIT_KINDS[winner].outranks as readonly string[]).includes(loser);
}

export function secondFingerAction(_kind: HitKind): SecondFingerAction {
  return "cancel";
}

/** The clip edge a clip handle kind belongs to. */
export function clipEdgeOf(kind: HitKind): "in" | "out" {
  return kind.endsWith("-out") ? "out" : "in";
}

/**
 * What moves when target `kind` `id` (at `sec`) drags, for its soft
 * boundaries, or null when none apply (`soft: false`, or the target is gone).
 */
export function softMover(
  project: ProjectView,
  kind: HitKind,
  id: string,
  sec: number,
): NudgeMover | null {
  if (!HIT_KINDS[kind].soft) return null;
  switch (kind) {
    case "fade-in":
    case "fade-out":
    case "trim-out":
    case "roll": {
      for (const [trackId, lane] of Object.entries(project.clips.tracks)) {
        if (lane.some((clip) => clip.id === id)) {
          return {
            kind: "clip",
            clipId: id,
            trackId,
            ripple: kind === "trim-out",
          };
        }
      }
      return null;
    }
    case "pending-start":
    case "pending-end": {
      const edit = project.pending_edits.find((e) => e.id === id);
      return edit
        ? { kind: "pending", editId: edit.id, trackId: edit.track_id }
        : null;
    }
    case "envelope-point": {
      const envelope = project.envelopes.find((e) =>
        e.points.some((p) => p.id === id),
      );
      return envelope
        ? { kind: "envelope-point", trackId: envelope.track_id, pointId: id }
        : null;
    }
    case "chapter":
    case "social-clip":
      return { kind: "marker", sec };
    default:
      return null;
  }
}

/**
 * The touch gestures the capabilities manifest's `surfaces.touch` column may
 * name (`contracts/capabilities.manifest.json`). `make capabilities-check`
 * keeps the manifest schema's enum equal to these keys, and
 * `inputContract.manifest.test.ts` derives each command's column from the
 * grammar: the create menu, the kinds' commands and the Gestures sheet.
 */
export const TOUCH_GESTURES = {
  "long-press-arm-drag": "Long-press to arm, then drag",
  "long-press-empty": "Long-press empty space: create menu",
  "hold-nudge": "Hold a strip nudge",
  "double-tap": "Double-tap",
  "swipe-left": "Swipe left",
  pinch: "Pinch",
  "two-finger-tap": "Two-finger tap",
} as const;

export type TouchGestureId = keyof typeof TOUCH_GESTURES;

/** Where a long-press on empty space landed: what the create menu acts on. */
export interface CreatePlace {
  /** Timeline seconds under the finger. */
  atTime: number;
  /** The track whose lane it landed on, if any. */
  trackId: string | null;
}

/** One entry of the create menu, routed through an existing command. */
export interface CreateEntry {
  id: "envelope-point" | "split" | "chapter" | "comment";
  label: string;
  /** `track` entries act on the held lane; `episode` entries on the whole episode. */
  scope: "track" | "episode";
  command:
    | "envelope.addPoint"
    | "edit.bladeCut"
    | "edit.addChapter"
    | "comment.draftAt";
  /** The command's arguments for `place`; null when it cannot act there. */
  args: (place: CreatePlace) => Record<string, unknown> | null;
}

/** The create menu a long-press on empty timeline space opens, in order. */
export const CREATE_ENTRIES: readonly CreateEntry[] = [
  {
    id: "envelope-point",
    label: "Add envelope point",
    scope: "track",
    command: "envelope.addPoint",
    args: ({ atTime, trackId }) => (trackId ? { atTime, trackId } : null),
  },
  {
    id: "split",
    label: "Blade cut",
    scope: "track",
    command: "edit.bladeCut",
    args: ({ atTime }) => ({ atTime }),
  },
  {
    id: "chapter",
    label: "Add chapter",
    scope: "episode",
    command: "edit.addChapter",
    args: ({ atTime }) => ({ atTime }),
  },
  {
    id: "comment",
    label: "Add comment",
    scope: "episode",
    command: "comment.draftAt",
    args: ({ atTime, trackId }) => ({
      atTime,
      ...(trackId ? { trackId } : {}),
    }),
  },
];
