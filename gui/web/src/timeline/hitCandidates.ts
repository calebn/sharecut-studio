/**
 * Shared timeline hit resolver (#1051). Every small timeline target near a
 * pointer becomes a `HitCandidate`; the ranked list replaces CSS z-order when
 * targets crowd one spot. The selected target wins, then the nearest, then
 * the kind's priority.
 */

import { clamp } from "../utils/math";
import {
  HIT_KINDS,
  type HitKind,
  type HitKindContract,
  needsDirectHit,
  outranks,
} from "./inputContract";

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

/**
 * The box the resolver reaches a target from: its painted box, grown about
 * its centre to the kind's `minBoxPx` for this pointer.
 */
export function reachRect(
  rect: HitRect,
  kind: HitKind,
  pointerType: string,
): HitRect {
  const min = (HIT_KINDS[kind] as HitKindContract).minBoxPx;
  if (!min) return rect;
  const side = pointerType === "touch" ? min.touch : min.pointer;
  const dx = Math.max(0, side - (rect.right - rect.left)) / 2;
  const dy = Math.max(0, side - (rect.bottom - rect.top)) / 2;
  return {
    left: rect.left - dx,
    top: rect.top - dy,
    right: rect.right + dx,
    bottom: rect.bottom + dy,
  };
}

/** Pointer to the box, 0 inside it. */
export function rectDistance(rect: HitRect, p: HitPoint): number {
  const dx = p.x - clamp(p.x, rect.left, rect.right);
  const dy = p.y - clamp(p.y, rect.top, rect.bottom);
  return Math.hypot(dx, dy);
}

function isRowKind(kind: HitKind): boolean {
  return (HIT_KINDS[kind] as HitKindContract).reach === "row";
}

function inReach(
  rect: HitRect,
  pointer: HitPoint,
  radiusPx: number,
  reach: "row" | undefined,
): boolean {
  if (reach === "row" && (pointer.y < rect.top || pointer.y > rect.bottom)) {
    return false;
  }
  return rectDistance(rect, pointer) <= radiusPx;
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
 * then kind priority. Direct-only activation targets follow editing controls
 * in the chooser. Each candidate keeps the target it came from. A body
 * (`HIT_KINDS[kind].body`) counts only when it is `hit` and nothing else is
 * in reach, and then it is held where the pointer is.
 *
 * `reachable` refuses a target the pointer cannot actually take (click-through,
 * hidden, or under chrome). It runs before the body fallback is decided, so a
 * body whose only neighbours are out of reach still stands alone.
 */
export function rankHitTargets<T extends HitTarget>(
  targets: readonly T[],
  pointer: HitPoint,
  radiusPx: number,
  hit: T | null = null,
  reachable: (target: T, at: HitPoint) => boolean = () => true,
): { candidate: HitCandidate; target: T }[] {
  const ranked: { candidate: HitCandidate; target: T }[] = [];
  let body: { candidate: HitCandidate; target: T } | null = null;
  for (const target of targets) {
    if (needsDirectHit(target.kind) && target !== hit) continue;
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
    if (
      target !== hit &&
      !inReach(
        target.rect,
        pointer,
        radiusPx,
        (HIT_KINDS[target.kind] as HitKindContract).reach,
      )
    ) {
      continue;
    }
    const core = corePoint(target.rect, pointer);
    if (target !== hit && !reachable(target, core)) {
      continue;
    }
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
  ranked.sort(({ candidate: a }, { candidate: b }) => {
    const bySelected = Number(b.selected) - Number(a.selected);
    const byDistance = a.distance - b.distance;
    // Marker pins sit a finger's width apart: the nearer one is the one
    // meant, selected or not. Equal distance (a stack) keeps selected first.
    return (
      Number(needsDirectHit(a.kind)) - Number(needsDirectHit(b.kind)) ||
      (isRowKind(a.kind) && isRowKind(b.kind)
        ? byDistance || bySelected
        : bySelected || byDistance) ||
      b.priority - a.priority
    );
  });
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
