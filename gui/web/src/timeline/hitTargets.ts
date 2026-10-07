/**
 * DOM side of the hit resolver: timeline targets mark themselves with
 * `hitTargetProps`, plain hit areas behind them with `HIT_SURFACE_PROPS`, and
 * `resolveHits` turns the marked elements near a pointer into ranked
 * candidates paired with their elements.
 */
import {
  type HitCandidate,
  type HitPoint,
  type HitTarget,
  hitRadiusPx,
  rankHitTargets,
} from "./hitCandidates";
import { type HitKind, isHitKind } from "./inputContract";

const KIND_ATTR = "data-hit-kind";
const SURFACE_ATTR = "data-hit-surface";

export type HitTargetAttrs = {
  "data-hit-kind": HitKind;
  "data-hit-id": string;
  "data-hit-selected"?: "true";
  /** Timeline seconds, for the chooser's label. */
  "data-hit-time": string;
  /** Envelope gain, or the join glyph / pending edit type. */
  "data-hit-detail"?: string;
  /** A body's length in seconds from `data-hit-time`, its start. */
  "data-hit-span"?: string;
};

export function hitTargetProps(
  kind: HitKind,
  id: string,
  timeSec: number,
  opts: { selected?: boolean; detail?: string; spanSec?: number } = {},
): HitTargetAttrs {
  return {
    "data-hit-kind": kind,
    "data-hit-id": id,
    "data-hit-time": String(timeSec),
    ...(opts.selected ? { "data-hit-selected": "true" } : {}),
    ...(opts.detail != null ? { "data-hit-detail": opts.detail } : {}),
    ...(opts.spanSec != null ? { "data-hit-span": String(opts.spanSec) } : {}),
  };
}

/**
 * A hit area behind the targets that only takes taps (a lane, the envelope
 * layer, a wide pending region): a long-press there opens the create menu.
 */
export const HIT_SURFACE_PROPS = { [SURFACE_ATTR]: "" } as const;

/** A ranked candidate and the element that owns its gestures. */
export interface ResolvedHit {
  candidate: HitCandidate;
  element: Element;
}

export function closestHitTarget(node: EventTarget | null): Element | null {
  return node instanceof Element ? node.closest(`[${KIND_ATTR}]`) : null;
}

export function closestHitSurface(node: EventTarget | null): Element | null {
  return node instanceof Element ? node.closest(`[${SURFACE_ATTR}]`) : null;
}

export function hitTimeSec(element: Element): number {
  return Number(element.getAttribute("data-hit-time"));
}

/** A body's length in seconds; 0 for a target that is a point or an edge. */
export function hitSpanSec(element: Element): number {
  return Number(element.getAttribute("data-hit-span") ?? 0);
}

export function hitDetail(element: Element): string | null {
  return element.getAttribute("data-hit-detail");
}

type DomTarget = HitTarget & { element: Element };

function readTarget(element: Element): DomTarget | null {
  const kind = element.getAttribute(KIND_ATTR);
  if (!isHitKind(kind)) {
    return null;
  }
  const r = element.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) {
    return null;
  }
  return {
    element,
    kind,
    id: element.getAttribute("data-hit-id") ?? "",
    rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    selected:
      element.getAttribute("data-hit-selected") === "true" ||
      element === document.activeElement,
  };
}

/** Painted, hit-testable, and not covered by chrome outside `root`. */
function reachable(root: Element, target: DomTarget, at: HitPoint): boolean {
  const style = getComputedStyle(target.element);
  if (style.pointerEvents === "none" || style.visibility !== "visible") {
    return false;
  }
  const top = document.elementFromPoint?.(at.x, at.y);
  return top == null || root.contains(top);
}

/**
 * Marked targets under `root` within the pointer's reach, ranked. `hit` is the
 * element the browser hit; its target is always kept. A target that is hidden,
 * click-through, or whose nearest point sits under chrome outside `root`
 * (sticky headers, sheets) is out of reach.
 */
export function resolveHits(
  root: Element,
  pointer: HitPoint,
  pointerType: string,
  hit: Element | null,
): ResolvedHit[] {
  const targets: DomTarget[] = [];
  for (const element of root.querySelectorAll(`[${KIND_ATTR}]`)) {
    const target = readTarget(element);
    if (target) {
      targets.push(target);
    }
  }
  const hitTarget = targets.find((t) => t.element === hit) ?? null;
  return rankHitTargets(targets, pointer, hitRadiusPx(pointerType), hitTarget)
    .filter(
      ({ candidate, target }) =>
        target === hitTarget || reachable(root, target, candidate),
    )
    .map(({ candidate, target }) => ({ candidate, element: target.element }));
}
