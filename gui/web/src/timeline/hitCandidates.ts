/**
 * Shared timeline hit resolver (#1051). Every small timeline target near a
 * pointer becomes a `HitCandidate`; the ranked list replaces CSS z-order when
 * targets crowd one spot. The selected target wins, then the nearest, then
 * the kind's priority.
 */
import { HIT_KINDS, type HitKind, outranks } from "./inputContract";

/** Viewport px box, as `getBoundingClientRect` reports it. */
export interface HitRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A target as the timeline paints it. */
export interface HitTarget {
  kind: HitKind;
  id: string;
  rect: HitRect;
  selected: boolean;
}

/** A target near the pointer, ranked by `rankHitCandidates`. */
export interface HitCandidate {
  kind: HitKind;
  id: string;
  /** Nearest point of the target's core, viewport px. */
  x: number;
  y: number;
  /** Pointer to that point, px. */
  distance: number;
  priority: number;
  selected: boolean;
}

export interface HitPoint {
  x: number;
  y: number;
}

/** A finger reaches targets this far from its reported point. */
export const TOUCH_HIT_RADIUS_PX = 22;

/** Touch reaches nearby targets; mouse and pen hit only what they are on. */
export function hitRadiusPx(pointerType: string): number {
  return pointerType === "touch" ? TOUCH_HIT_RADIUS_PX : 0;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** Pointer to the box, 0 inside it. */
export function rectDistance(rect: HitRect, p: HitPoint): number {
  const dx = p.x - clamp(p.x, rect.left, rect.right);
  const dy = p.y - clamp(p.y, rect.top, rect.bottom);
  return Math.hypot(dx, dy);
}

/**
 * Nearest point of the box's core: the box shrunk by half its short side, so
 * a square's core is its centre and a tall strip's is its centre line. Ranking
 * by the core makes a thin strip as near as its line, not its whole width.
 */
export function corePoint(rect: HitRect, p: HitPoint): HitPoint {
  const inset = Math.min(rect.right - rect.left, rect.bottom - rect.top) / 2;
  return {
    x: clamp(p.x, rect.left + inset, rect.right - inset),
    y: clamp(p.y, rect.top + inset, rect.bottom - inset),
  };
}

/**
 * Targets whose box is within `radiusPx` of the pointer (plus `hit`, the one
 * the browser hit, at any reach), ranked: selected first, then nearest core,
 * then kind priority. Each candidate keeps the target it came from. A body
 * (`HIT_KINDS[kind].body`) counts only when it is `hit` and nothing else is
 * in reach, and then it is held where the pointer is.
 */
export function rankHitTargets<T extends HitTarget>(
  targets: readonly T[],
  pointer: HitPoint,
  radiusPx: number,
  hit: T | null = null,
): { candidate: HitCandidate; target: T }[] {
  const ranked: { candidate: HitCandidate; target: T }[] = [];
  let body: { candidate: HitCandidate; target: T } | null = null;
  for (const target of targets) {
    if (HIT_KINDS[target.kind].body) {
      if (target === hit) {
        body = {
          target,
          candidate: {
            kind: target.kind,
            id: target.id,
            ...pointer,
            distance: 0,
            priority: HIT_KINDS[target.kind].priority,
            selected: target.selected,
          },
        };
      }
      continue;
    }
    if (target !== hit && rectDistance(target.rect, pointer) > radiusPx) {
      continue;
    }
    const core = corePoint(target.rect, pointer);
    ranked.push({
      target,
      candidate: {
        kind: target.kind,
        id: target.id,
        x: core.x,
        y: core.y,
        distance: Math.hypot(core.x - pointer.x, core.y - pointer.y),
        priority: HIT_KINDS[target.kind].priority,
        selected: target.selected,
      },
    });
  }
  ranked.sort(
    ({ candidate: a }, { candidate: b }) =>
      Number(b.selected) - Number(a.selected) ||
      a.distance - b.distance ||
      b.priority - a.priority,
  );
  if (ranked.length === 0 && body) return [body];
  return applyOutranks(ranked);
}

/**
 * Moves each candidate ahead of every equally selected one its kind
 * outranks (`HIT_KINDS[kind].outranks`), keeping the rest of the order.
 */
function applyOutranks<T extends { candidate: HitCandidate }>(
  ranked: T[],
): T[] {
  const out = [...ranked];
  for (let i = 0; i < out.length; i += 1) {
    const loser = out[i].candidate;
    const w = out.findIndex(
      ({ candidate }, j) =>
        j > i &&
        candidate.selected === loser.selected &&
        outranks(candidate.kind, loser.kind),
    );
    if (w > i) out.splice(i, 0, ...out.splice(w, 1));
  }
  return out;
}
