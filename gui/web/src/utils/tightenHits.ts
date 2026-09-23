import type {
  CombinedUtterance,
  PendingEditView,
  ProjectView,
  TranscriptWordView,
} from "../types/project";

const TIGHTEN_CLASSES = ["filler", "pause", "repetition", "restart"] as const;

export type TightenClass = (typeof TIGHTEN_CLASSES)[number];

export type TightenFilters = {
  classFilter: "all" | TightenClass;
  trackId: string;
  harshOnly: boolean;
  query: string;
  /** Optional track id → display label for search. */
  trackLabels?: Record<string, string>;
};

export type TightenHit = PendingEditView & {
  tightenClass: TightenClass;
  harsh: boolean;
  snippet: string;
  riskBadge: "risky" | "review" | "ok";
};

export function isTightenPending(edit: PendingEditView): boolean {
  return tightenClassOf(edit) !== null;
}

export function tightenClassOf(edit: PendingEditView): TightenClass | null {
  const reason = edit.reason ?? "";
  return TIGHTEN_CLASSES.find((name) => reason.startsWith(`${name}:`)) ?? null;
}

export function isHarshTightenHit(edit: PendingEditView): boolean {
  if (edit.review_required) {
    return true;
  }
  const verdict = edit.join_risk?.verdict;
  if (verdict === "fail" || verdict === "review") {
    return true;
  }
  const reason = edit.reason ?? "";
  return reason.includes(":risky") || reason.includes(":join_review");
}

export function riskBadgeFor(edit: PendingEditView): TightenHit["riskBadge"] {
  const label = edit.join_risk?.label;
  if (label === "risky" || (edit.reason ?? "").includes(":risky")) {
    return "risky";
  }
  if (
    edit.review_required ||
    edit.join_risk?.verdict === "review" ||
    label === "join_review" ||
    (edit.reason ?? "").includes(":join_review")
  ) {
    return "review";
  }
  return "ok";
}

function utteranceWords(utterance: CombinedUtterance): TranscriptWordView[] {
  return (utterance.words ?? []).filter((w) => !w.suppressed);
}

function wordsForTrack(
  trackId: string,
  transcript: ProjectView["transcript"],
): TranscriptWordView[] {
  const utterances = transcript?.utterances ?? [];
  return utterances
    .filter((u) => u.track_id === trackId)
    .flatMap(utteranceWords);
}

export function tightenSnippet(
  edit: PendingEditView,
  transcript: ProjectView["transcript"],
  wordsOnTrack?: TranscriptWordView[],
): string {
  const words = wordsOnTrack ?? wordsForTrack(edit.track_id, transcript);
  if (words.length) {
    const overlapping = words
      .map((word, index) => ({ word, index }))
      .filter(
        ({ word }) =>
          word.end > edit.source_start && word.start < edit.source_end,
      );
    if (overlapping.length) {
      const first = overlapping[0].index;
      const last = overlapping[overlapping.length - 1].index;
      const from = Math.max(0, first - 3);
      const to = Math.min(words.length, last + 4);
      return words
        .slice(from, to)
        .map((w) => w.text)
        .join(" ");
    }
  }
  const utterances = transcript?.utterances ?? [];
  const onTrack = utterances.filter((u) => u.track_id === edit.track_id);
  const hit = onTrack.find(
    (u) => u.end > edit.source_start && u.start < edit.source_end,
  );
  return hit?.text ?? "";
}

export function toTightenHit(
  edit: PendingEditView,
  transcript: ProjectView["transcript"],
  wordsByTrack?: Map<string, TranscriptWordView[]>,
): TightenHit | null {
  const tightenClass = tightenClassOf(edit);
  if (!tightenClass) {
    return null;
  }
  const wordsOnTrack = wordsByTrack?.get(edit.track_id);
  return {
    ...edit,
    tightenClass,
    harsh: isHarshTightenHit(edit),
    snippet: tightenSnippet(edit, transcript, wordsOnTrack),
    riskBadge: riskBadgeFor(edit),
  };
}

export function listTightenHits(
  edits: PendingEditView[] | undefined,
  transcript: ProjectView["transcript"],
): TightenHit[] {
  const wordsByTrack = new Map<string, TranscriptWordView[]>();
  const hits: TightenHit[] = [];
  for (const edit of edits ?? []) {
    if (!wordsByTrack.has(edit.track_id)) {
      wordsByTrack.set(edit.track_id, wordsForTrack(edit.track_id, transcript));
    }
    const hit = toTightenHit(edit, transcript, wordsByTrack);
    if (hit) {
      hits.push(hit);
    }
  }
  hits.sort((a, b) => {
    const aT = a.timeline_start ?? a.source_start;
    const bT = b.timeline_start ?? b.source_start;
    return aT - bT;
  });
  return hits;
}

export function filterTightenHits(
  hits: TightenHit[],
  filters: TightenFilters,
): TightenHit[] {
  const q = filters.query.trim().toLowerCase();
  return hits.filter((hit) => {
    if (
      filters.classFilter !== "all" &&
      hit.tightenClass !== filters.classFilter
    ) {
      return false;
    }
    if (filters.trackId && hit.track_id !== filters.trackId) {
      return false;
    }
    if (filters.harshOnly && !hit.harsh) {
      return false;
    }
    if (!q) {
      return true;
    }
    const trackLabel = filters.trackLabels?.[hit.track_id] ?? "";
    const hay = [
      hit.reason ?? "",
      hit.snippet,
      hit.track_id,
      trackLabel,
      hit.type,
      hit.riskBadge,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

export function tightenHitCanGoTo(
  hit: Pick<TightenHit, "timeline_start">,
): boolean {
  return hit.timeline_start != null;
}

export function tightenHitCanPreview(
  hit: Pick<TightenHit, "timeline_start" | "timeline_end">,
): boolean {
  return hit.timeline_start != null && hit.timeline_end != null;
}

export function eligibleApplyAllIds(
  hits: TightenHit[],
  avoidHarsh: boolean,
): string[] {
  return hits.filter((hit) => !avoidHarsh || !hit.harsh).map((hit) => hit.id);
}

export function applyAllSummary(
  listed: number,
  eligible: number,
): { apply: number; skipped: number; confirm: string } {
  const skipped = Math.max(0, listed - eligible);
  const confirm =
    skipped > 0
      ? `Apply ${eligible} of ${listed}; ${skipped} skipped as harsh`
      : `Apply ${eligible} of ${listed}`;
  return { apply: eligible, skipped, confirm };
}

export function tightenHitsForListedIds(
  pending: PendingEditView[] | undefined,
  transcript: ProjectView["transcript"],
  listedIds: string[],
): TightenHit[] {
  const idSet = new Set(listedIds);
  return listTightenHits(pending, transcript).filter((h) => idSet.has(h.id));
}
