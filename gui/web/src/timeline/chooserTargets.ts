import type { ChooserKind } from "../stages/edit/chooserKinds";
import { KIND_NAMES } from "../stages/edit/chooserKinds";
import { CHOOSER_MAX_CHIPS } from "../stages/edit/chooserMath";
import type { ChooserTarget } from "../stages/edit/TargetChooser";
import { useDawStore } from "../state/dawStore";
import { formatTime } from "../utils/time";
import { hitDetail, hitTimeSec, type ResolvedHit } from "./hitTargets";
import { HIT_KINDS, type HitKind } from "./inputContract";
import { laneColorIndex } from "./laneColors";

const CHOOSER_KIND: Record<HitKind, ChooserKind> = {
  clip: "clip",
  "trim-in": "clip",
  "trim-out": "clip",
  "fade-in": "clip",
  "fade-out": "clip",
  roll: "seam",
  "pending-start": "suggestion",
  "pending-end": "suggestion",
  "pending-flag": "suggestion",
  "bleed-attenuation": "suggestion",
  comment: "comment",
  "envelope-point": "envelope-point",
  chapter: "chapter",
  "social-clip": "social-clip",
};

const AUTHOR_CHARS = 16;
const MULTIPLY = "×";

function shortAuthor(author: string): string {
  const chars = Array.from(author.trim());
  return chars.length > AUTHOR_CHARS
    ? `${chars.slice(0, AUTHOR_CHARS - 1).join("")}…`
    : chars.join("");
}

/** What the target is, beyond its kind: a trim edge, a point's gain, a comment's author. */
function subName(hit: ResolvedHit): string {
  const kind = hit.candidate.kind;
  const detail = hitDetail(hit.element);
  if (kind === "comment" && detail) return shortAuthor(detail);
  if (kind === "envelope-point" && detail) return `${detail}${MULTIPLY}`;
  return HIT_KINDS[kind].label;
}

function labelOf(hit: ResolvedHit): string {
  const name = subName(hit);
  const time = formatTime(hitTimeSec(hit.element));
  const label =
    name === KIND_NAMES[CHOOSER_KIND[hit.candidate.kind]]
      ? time
      : `${name} at ${time}`;
  return hit.candidate.selected ? `${label}, selected` : label;
}

function trackColorOf(element: Element): number {
  const row = element.closest<HTMLElement>(".lane-row[data-track-id]");
  const tracks = useDawStore.getState().project?.tracks ?? [];
  const index = tracks.findIndex((t) => t.id === row?.dataset.trackId);
  return index < 0 ? 0 : laneColorIndex(tracks[index].role, index);
}

/**
 * Which hits the chooser keeps when more than five crowd one spot: a selected
 * target is never cut, then the best-ranked of each kind (chips of one kind
 * look alike), then the rest by rank.
 */
function keptIndices(hits: readonly ResolvedHit[]): number[] {
  const all = hits.map((_, index) => index);
  const seen = new Set<ChooserKind>();
  const firstOfKind = all.filter((index) => {
    const kind = CHOOSER_KIND[hits[index].candidate.kind];
    if (seen.has(kind)) return false;
    seen.add(kind);
    return true;
  });
  const ranked = [
    ...all.filter((index) => hits[index].candidate.selected),
    ...firstOfKind,
    ...all,
  ];
  return [...new Set(ranked)].slice(0, CHOOSER_MAX_CHIPS);
}

/**
 * The router's ranked hits as the leaf's targets: the five it keeps in x order
 * (left to right, as the leaf draws them), then the ones it cuts, so the leaf
 * can say how many there are. An id is the hit's index in `hits`, which the
 * router reads back from a chip.
 */
export function chooserTargetsOf(
  hits: readonly ResolvedHit[],
): ChooserTarget[] {
  const kept = keptIndices(hits).sort(
    (a, b) =>
      hits[a].candidate.x - hits[b].candidate.x ||
      hits[b].candidate.priority - hits[a].candidate.priority,
  );
  const cut = hits.flatMap((_, index) => (kept.includes(index) ? [] : [index]));
  return [...kept, ...cut].map((index) => ({
    id: String(index),
    kind: CHOOSER_KIND[hits[index].candidate.kind],
    trackColorIndex: trackColorOf(hits[index].element),
    label: labelOf(hits[index]),
  }));
}
