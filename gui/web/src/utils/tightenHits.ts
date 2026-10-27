import type { ConfirmQuestion } from "../feedback/ask";
import type {
  CombinedUtterance,
  PendingEditView,
  PendingKind,
  ProjectView,
  TranscriptWordView,
} from "../types/project";

/** The server kinds that make a pending edit a tighten hit: everything but `other`. */
export type TightenClass = Exclude<PendingKind, "other">;

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
  listenOneByOne: boolean;
  snippet: string;
  riskBadge: "risky" | "review" | "ok";
};

export function isTightenPending(edit: PendingEditView): boolean {
  return tightenClassOf(edit) !== null;
}

const TIGHTEN_CLASS_SET: Record<TightenClass, true> = {
  filler: true,
  pause: true,
  repeat: true,
  "false-start": true,
  sound: true,
};

/** True for a kind this client knows; an absent or newer kind from an older or newer host is not. */
export function isTightenClass(kind: unknown): kind is TightenClass {
  return typeof kind === "string" && Object.hasOwn(TIGHTEN_CLASS_SET, kind);
}

/** The tighten class the server grouped the edit into (`kind`), or null for `other`. */
export function tightenClassOf(edit: PendingEditView): TightenClass | null {
  return isTightenClass(edit.kind) ? edit.kind : null;
}

/**
 * The server's harsh flag; the rule lives in `edits/tighten_hits.py` for GUI and agents.
 * Fails closed: only an explicit `false` is safe, so an edit the server never classified
 * is skipped by Avoid harsh cuts.
 */
export function isHarshTightenHit(edit: PendingEditView): boolean {
  return edit.harsh !== false;
}

/**
 * The server's listen-one-by-one flag (`edits/tighten_hits.py`): Apply eligible never batches
 * the hit, whatever Avoid harsh cuts says. Fails closed like `harsh`: only an explicit
 * `false` lets it into a batch.
 */
export function isListenOneByOneHit(edit: PendingEditView): boolean {
  return edit.listen_one_by_one !== false;
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
  const sourceStart = edit.source_start;
  const sourceEnd = edit.source_end;
  if (sourceStart == null || sourceEnd == null) return "";
  const words = wordsOnTrack ?? wordsForTrack(edit.track_id, transcript);
  if (words.length) {
    const overlapping = words
      .map((word, index) => ({ word, index }))
      .filter(({ word }) => word.end > sourceStart && word.start < sourceEnd);
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
  const hit = onTrack.find((u) => u.end > sourceStart && u.start < sourceEnd);
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
    listenOneByOne: isListenOneByOneHit(edit),
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
    return (aT ?? Number.POSITIVE_INFINITY) - (bT ?? Number.POSITIVE_INFINITY);
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

function hitCount(n: number): string {
  return n === 1 ? "1 sound" : `${n} sounds`;
}

/** The question Apply suggested actions asks before it applies the listed sounds. */
export function applySuggestedSummary(listed: number): {
  question: Omit<ConfirmQuestion, "kind">;
} {
  return {
    question: {
      title: `Apply suggested actions to ${hitCount(listed)}?`,
      message:
        "Each sound gets its own action: cut, shorten, lower or leave. A cut over another speaker ripples every track. One undo puts it all back.",
      keepLabel: "Keep reviewing",
      actionLabel: `Apply ${listed}`,
      danger: false,
    },
  };
}

export function tightenHitsForListedIds(
  pending: PendingEditView[] | undefined,
  transcript: ProjectView["transcript"],
  listedIds: string[],
): TightenHit[] {
  const idSet = new Set(listedIds);
  return listTightenHits(pending, transcript).filter((h) => idSet.has(h.id));
}
