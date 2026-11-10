import type { ClipWord } from "../../stages/deliver/clipTrim";
import type {
  Chapter,
  Clip,
  ReadinessFacts,
} from "../../stages/deliver/deliverLogic";
import type {
  ChapterMarker,
  CombinedUtterance,
  HistoryGroup,
  SocialClipView,
} from "../../types/project";
import type { StageId } from "../../types/stage";
import { shownTitle } from "../../utils/clipTitle";

export function chaptersOf(markers: readonly ChapterMarker[]): Chapter[] {
  return markers.map((m, i) => ({ id: `ch-${i}`, at: m.time, title: m.title }));
}

export function clipsOf(clips: readonly SocialClipView[]): Clip[] {
  return clips.map((c) => ({
    id: c.id,
    title: shownTitle(c.title_suggestion),
    start: c.start,
    end: c.end,
    score: c.score,
    approved: c.approved,
  }));
}

/**
 * The words a clip's trim handles snap to, on the timeline clock the clips
 * use: the project transcript's own per-word timings (the forced-aligned ones,
 * never a raw ASR pass). Cut-away, suppressed and ignored words are left out.
 * `undefined` when the transcript has no words, so the handles move freely.
 */
export function clipWordsOf(
  utterances: readonly CombinedUtterance[] | undefined,
): ClipWord[] | undefined {
  const words: ClipWord[] = [];
  for (const utterance of utterances ?? []) {
    for (const w of utterance.words ?? []) {
      if (w.suppressed || w.ignored || w.mappable === false) continue;
      const { timeline_start: start, timeline_end: end } = w;
      if (start == null || end == null) continue;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
        continue;
      words.push({ text: w.text, start, end });
    }
  }
  return words.length > 0 ? words : undefined;
}

export type ChapterOp =
  | { kind: "add"; at: number; title: string }
  | {
      kind: "update";
      from: { at: number; title: string };
      at: number;
      title: string;
    }
  | { kind: "delete"; at: number; title: string };

export function chapterOps(
  base: readonly Chapter[],
  next: readonly Chapter[],
): ChapterOp[] {
  const kept = new Set(next.map((c) => c.id));
  const was = new Map(base.map((c) => [c.id, c]));
  const ops: ChapterOp[] = [];
  for (const c of base) {
    if (!kept.has(c.id)) ops.push({ kind: "delete", at: c.at, title: c.title });
  }
  for (const c of next) {
    const old = was.get(c.id);
    if (!old) ops.push({ kind: "add", at: c.at, title: c.title });
    else if (old.at !== c.at || old.title !== c.title) {
      ops.push({
        kind: "update",
        from: { at: old.at, title: old.title },
        at: c.at,
        title: c.title,
      });
    }
  }
  return ops;
}

export type ClipOp =
  | { kind: "trim"; id: string; start: number; end: number }
  | { kind: "details"; id: string; title?: string; approved?: boolean }
  | { kind: "delete"; id: string };

export function clipOps(
  base: readonly Clip[],
  next: readonly Clip[],
): ClipOp[] {
  const now = new Map(next.map((c) => [c.id, c]));
  const ops: ClipOp[] = [];
  for (const c of base) {
    const after = now.get(c.id);
    if (!after) {
      ops.push({ kind: "delete", id: c.id });
      continue;
    }
    if (after.start !== c.start || after.end !== c.end) {
      ops.push({ kind: "trim", id: c.id, start: after.start, end: after.end });
    }
    const title = shownTitle(after.title) !== shownTitle(c.title);
    const approved = after.approved !== c.approved;
    if (title || approved) {
      ops.push({
        kind: "details",
        id: c.id,
        ...(title ? { title: after.title.trim() } : {}),
        ...(approved ? { approved: after.approved } : {}),
      });
    }
  }
  return ops;
}

export type DeliverFactsInput = {
  pendingReviewCount: number;
  appliedEditCount: number;
  comments: readonly { resolved: boolean }[];
  unsureWordsLeft: ReadinessFacts["unsureWordsLeft"];
  mixUpToDate: boolean;
  chapterCount: number;
  removedSeconds: number;
};

export function deliverFacts(input: DeliverFactsInput): ReadinessFacts {
  return {
    suggestions: {
      decided: input.appliedEditCount,
      total: input.appliedEditCount + input.pendingReviewCount,
    },
    comments: {
      resolved: input.comments.filter((c) => c.resolved).length,
      total: input.comments.length,
    },
    unsureWordsLeft: input.unsureWordsLeft,
    mixUpToDate: input.mixUpToDate,
    chapters: input.chapterCount,
    editsSaved: input.removedSeconds,
  };
}

export type FixRoute =
  | { kind: "refreshMix" }
  | {
      kind: "stage";
      stage: StageId;
      section?: "queue";
      comment?: true;
    };

export function fixRoute(stage: StageId, target?: string): FixRoute {
  if (target === "mix") return { kind: "refreshMix" };
  if (stage === "review") {
    if (target === "suggestions" || target === "unsure-words")
      return { kind: "stage", stage, section: "queue" };
    if (target === "comments")
      return { kind: "stage", stage, section: "queue", comment: true };
  }
  return { kind: "stage", stage };
}

export function sameChapters(a: readonly Chapter[], b: readonly Chapter[]) {
  return (
    a.length === b.length &&
    a.every((c, i) => c.at === b[i]?.at && c.title === b[i]?.title)
  );
}

/** Whether two lists hold the same clips as the document saves them: id, bounds, title and approval. */
export function sameClips(a: readonly Clip[], b: readonly Clip[]) {
  return (
    a.length === b.length &&
    a.every(
      (c, i) =>
        c.id === b[i]?.id &&
        c.start === b[i]?.start &&
        c.end === b[i]?.end &&
        c.approved === b[i]?.approved &&
        shownTitle(c.title) === shownTitle(b[i]?.title),
    )
  );
}

export function editHeadOf(history: {
  head_id: string;
  groups: readonly Pick<
    HistoryGroup,
    "operation" | "id" | "before_id" | "after_id"
  >[];
}): string | undefined {
  if (history.groups.length === 0 && history.head_id !== "root")
    return undefined;
  let latest: string | null = null;
  for (const group of history.groups) {
    const entries =
      group.id !== undefined
        ? [{ id: group.id, edit: group.operation !== "render_preview" }]
        : [
            ...(group.before_id === undefined
              ? []
              : [{ id: group.before_id, edit: true }]),
            ...(group.after_id === undefined
              ? []
              : [
                  {
                    id: group.after_id,
                    edit: group.operation !== "render_preview",
                  },
                ]),
          ];
    for (const entry of entries) {
      if (entry.edit) latest = entry.id;
      if (entry.id === history.head_id) return latest ?? history.head_id;
    }
  }
  return history.head_id;
}
