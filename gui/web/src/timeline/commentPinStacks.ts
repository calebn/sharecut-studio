import type { TimelineComment } from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";

/** Pins closer than this (px) cover each other's dot. */
const STACK_GAP_PX = MARKER_ROW_HEIGHT / 2;

/** A comment drawn as a point, not a span. */
export function isPinComment(comment: TimelineComment): boolean {
  return (
    comment.timeline_end == null ||
    comment.timeline_end <= comment.timeline_start
  );
}

/**
 * Pins whose dots overlap at this zoom, as groups of comment ids in time
 * order. A pin alone is not listed; a chain of pins each within a dot's width
 * of the last is one group.
 */
export function commentPinStacks(
  comments: readonly TimelineComment[],
  zoomPxPerSec: number,
): string[][] {
  const pins = comments
    .filter(isPinComment)
    .sort((a, b) => a.timeline_start - b.timeline_start);
  const stacks: string[][] = [];
  let run: TimelineComment[] = [];
  const close = () => {
    if (run.length > 1) stacks.push(run.map((c) => c.id));
    run = [];
  };
  for (const pin of pins) {
    const last = run[run.length - 1];
    if (
      last &&
      (pin.timeline_start - last.timeline_start) * zoomPxPerSec >= STACK_GAP_PX
    )
      close();
    run.push(pin);
  }
  close();
  return stacks;
}

/** The pin a mouse click on a stack opens: the one after the selected member, else the clicked one. */
export function nextInStack(
  stack: readonly string[] | undefined,
  selectedId: string | null,
  clickedId: string,
): string {
  const at = stack && selectedId ? stack.indexOf(selectedId) : -1;
  return stack && at >= 0 ? stack[(at + 1) % stack.length] : clickedId;
}
