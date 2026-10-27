import type {
  Chapter,
  Clip,
  ReadinessFacts,
} from "../../stages/deliver/deliverLogic";
import type { ChapterMarker, SocialClipView } from "../../types/project";
import type { StageId } from "../../types/stage";

/** The stage's chapters from the project's, with ids that stay put while the page is open. */
export function chaptersOf(markers: readonly ChapterMarker[]): Chapter[] {
  return markers.map((m, i) => ({ id: `ch-${i}`, at: m.time, title: m.title }));
}

/** The stage's clips from the project's social clips. */
export function clipsOf(clips: readonly SocialClipView[]): Clip[] {
  return clips.map((c) => ({
    id: c.id,
    title: c.title_suggestion?.trim() || "Untitled clip",
    start: c.start,
    end: c.end,
    score: c.score,
    approved: c.approved,
  }));
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

/** Document commands that turn the chapters the project holds into the ones on the page. */
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
  | { kind: "delete"; id: string };

/**
 * Clip edits the document can keep: a removed clip and new bounds. A new title
 * or an approval has no document command yet and stays on the page.
 */
export function clipOps(
  base: readonly Clip[],
  next: readonly Clip[],
): ClipOp[] {
  const now = new Map(next.map((c) => [c.id, c]));
  const ops: ClipOp[] = [];
  for (const c of base) {
    const after = now.get(c.id);
    if (!after) ops.push({ kind: "delete", id: c.id });
    else if (after.start !== c.start || after.end !== c.end) {
      ops.push({ kind: "trim", id: c.id, start: after.start, end: after.end });
    }
  }
  return ops;
}

export type DeliverFactsInput = {
  pendingReviewCount: number;
  appliedEditCount: number;
  comments: readonly { resolved: boolean }[];
  unsureWordsLeft: number;
  mixUpToDate: boolean;
  chapterCount: number;
  removedSeconds: number;
};

/** The readiness facts the project can state. Loudness and peaks are measured by an export, so they are left out. */
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
    loudness: "podcast",
    chapters: input.chapterCount,
    editsSaved: input.removedSeconds,
  };
}

export type FixRoute =
  | { kind: "refreshMix" }
  | { kind: "stage"; stage: StageId; section?: "impact" | "comments" };

/** Where a readiness row's fix goes. */
export function fixRoute(stage: StageId, target?: string): FixRoute {
  if (target === "mix") return { kind: "refreshMix" };
  if (stage === "review") {
    if (target === "suggestions")
      return { kind: "stage", stage, section: "impact" };
    if (target === "comments")
      return { kind: "stage", stage, section: "comments" };
  }
  return { kind: "stage", stage };
}
