import {
  DOUBLE_TAP_MS,
  MOVE_THRESHOLD_PX,
  TOUCH_SLOP_PX,
} from "../hooks/gestureConstants";

/** Who made the selection. A key is a gesture too, so the host reads one vocabulary. */
type ScriptGestureSource = "mouse" | "pen" | "touch" | "keyboard";

/**
 * What the selection is for. `drag` is a press that moved, `extend` the same
 * with Shift held (the anchor stays), `hold` a touch long press.
 */
type ScriptGestureIntent = "drag" | "extend" | "hold";

/** The flags every selection callback carries after its ids. `mod` is Cmd: a press with Ctrl held never starts a gesture (a Mac Ctrl-click is the context menu), so it is false on Windows and Linux. */
export type ScriptGesture = {
  source: ScriptGestureSource;
  intent: ScriptGestureIntent;
  shift: boolean;
  alt: boolean;
  mod: boolean;
};

/** The end of a gesture. False when Escape, a lost pointer, a blur or unmounting stopped it: nothing was committed. */
export type ScriptGestureEnd = ScriptGesture & { committed: boolean };

/** How Fix text was asked for. Typing never asks for it. */
export type FixTextVia = "enter" | "f2" | "double-click" | "double-tap";

/** The pointer kinds that can start a press. */
export type PressKind = "mouse" | "pen" | "touch";

const PRESS_KINDS: Readonly<Record<string, PressKind>> = {
  touch: "touch",
  pen: "pen",
};

export const pressKind = (pointerType: string): PressKind =>
  PRESS_KINDS[pointerType] ?? "mouse";

/** How far a press may travel before it is a drag (mouse, pen) or a scroll (touch). */
export const pressSlop = (kind: PressKind): number =>
  kind === "touch" ? TOUCH_SLOP_PX : MOVE_THRESHOLD_PX;

/** A drag within this many px of the body's top or bottom edge scrolls it. */
const EDGE_BAND_PX = 56;
const EDGE_STEP_PX = 14;

/** The px to scroll one frame near an edge: negative up, positive down, faster the nearer the edge. The band is at most a quarter of the body so a short pane keeps a middle. */
export function edgeScrollDelta(
  y: number,
  top: number,
  bottom: number,
): number {
  const band = Math.min(EDGE_BAND_PX, (bottom - top) / 4);
  const intoTop = top + band - y;
  const intoBottom = y - (bottom - band);
  const depth = intoTop > 0 ? -intoTop : intoBottom > 0 ? intoBottom : 0;
  if (depth === 0) return 0;
  return Math.sign(depth) * Math.min(EDGE_STEP_PX, Math.abs(depth) / 4 + 2);
}

/** A tap on the same word as the last one, soon enough. */
export function isDoubleTap(
  last: { index: number; at: number } | null,
  index: number,
  now: number,
): boolean {
  return last !== null && last.index === index && now - last.at < DOUBLE_TAP_MS;
}
