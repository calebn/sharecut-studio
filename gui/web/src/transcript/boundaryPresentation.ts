import type { BoundaryTarget } from "../api/boundary";
import { clipsAbut } from "../edit/joinRender";
import type { ClipRow } from "../types/project";

export type BoundaryPresentation =
  | { kind: "roll"; target: Extract<BoundaryTarget, { kind: "roll" }> }
  | { kind: "gap-trim"; target: Extract<BoundaryTarget, { kind: "trim" }> }
  | { kind: "edge-trim"; target: Extract<BoundaryTarget, { kind: "trim" }> }
  | { kind: "unavailable"; target: null };

export function resolveBoundaryPresentation(
  left: ClipRow | null,
  neighbour: ClipRow | null,
): BoundaryPresentation {
  if (!left) return { kind: "unavailable", target: null };
  if (neighbour && clipsAbut(left, neighbour)) {
    return {
      kind: "roll",
      target: {
        kind: "roll",
        left_clip_id: left.id,
        right_clip_id: neighbour.id,
      },
    };
  }
  return {
    kind: neighbour ? "gap-trim" : "edge-trim",
    target: { kind: "trim", clip_id: left.id, edge: "out" },
  };
}
