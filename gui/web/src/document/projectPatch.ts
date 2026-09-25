import type {
  CombinedUtterance,
  ProjectView,
  TimelineComment,
  TrackView,
  TranscriptWordView,
} from "../types/project";
import { reuseUnchanged } from "./reuseUnchanged";

export type ProjectHydration = {
  transcript_words?: boolean;
  history_groups?: boolean;
};

export type DocumentSnapshot = {
  server_seq?: number;
  comments?: TimelineComment[];
  project?: ProjectView;
  patch?: Partial<ProjectView>;
  resync?: boolean;
  history?: {
    cursor?: number;
    can_undo?: boolean;
    can_redo?: boolean;
    groups?: ProjectView["history"]["groups"];
  };
};

const PROJECT_KEYS: (keyof ProjectView)[] = [
  "project_path",
  "meta",
  "timeline_duration_sec",
  "tracks",
  "clips",
  "chapters",
  "pending_edits",
  "edit_boundaries",
  "applied_edits",
  "effects_by_track",
  "envelopes",
  "social_clips",
  "comments",
  "render_status",
  "edit_impact",
  "history",
  "transcript",
];

function mergeHydration(
  previous: ProjectView["meta"],
  incoming: ProjectView["meta"],
): ProjectView["meta"] {
  const prevH = previous.hydration;
  const nextH = incoming.hydration;
  const hydration =
    prevH || nextH
      ? {
          transcript_words: Boolean(
            nextH?.transcript_words || prevH?.transcript_words,
          ),
          history_groups: Boolean(
            nextH?.history_groups || prevH?.history_groups,
          ),
        }
      : undefined;
  return {
    ...previous,
    ...incoming,
    ...(hydration ? { hydration } : {}),
  };
}

/** Shallow-merge a projection patch; keys omitted from ``patch`` keep identity. */
export function mergeProjectPatch(
  previous: ProjectView,
  patch: Partial<ProjectView>,
): ProjectView {
  const next: ProjectView = { ...previous };
  for (const key of PROJECT_KEYS) {
    if (!Object.hasOwn(patch, key)) {
      continue;
    }
    const value = patch[key];
    if (value === undefined) {
      continue;
    }
    if (key === "meta" && value && typeof value === "object") {
      next.meta = mergeHydration(previous.meta, value as ProjectView["meta"]);
      continue;
    }
    if (key === "history" && value && typeof value === "object") {
      next.history = {
        ...previous.history,
        ...(value as ProjectView["history"]),
      };
      continue;
    }
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  return reuseUnchanged(previous, next);
}

function utteranceSourceKey(utterance: CombinedUtterance): string {
  return `${utterance.track_id}\0${utterance.start}\0${utterance.end}`;
}

function remapOverlayWords(
  words: TranscriptWordView[],
  previous: CombinedUtterance,
  incoming: CombinedUtterance,
): TranscriptWordView[] {
  const prevStart = previous.timeline_start;
  const nextStart = incoming.timeline_start;
  const delta =
    typeof prevStart === "number" && typeof nextStart === "number"
      ? nextStart - prevStart
      : 0;
  return words.map((word) => {
    const next: TranscriptWordView = { ...word };
    if (typeof word.timeline_start === "number") {
      next.timeline_start = word.timeline_start + delta;
    }
    if (typeof word.timeline_end === "number") {
      next.timeline_end = word.timeline_end + delta;
    }
    if (incoming.mappable !== undefined) {
      next.mappable = incoming.mappable;
    }
    return next;
  });
}

function overlayTranscriptWords(
  previous: ProjectView["transcript"],
  incoming: ProjectView["transcript"],
): { transcript: ProjectView["transcript"]; complete: boolean } {
  if (!incoming) {
    return { transcript: incoming, complete: false };
  }
  const previousBySource = new Map<string, CombinedUtterance>();
  for (const utterance of previous?.utterances ?? []) {
    if (utterance.words) {
      previousBySource.set(utteranceSourceKey(utterance), utterance);
    }
  }
  let complete = true;
  const utterances = incoming.utterances.map((utterance) => {
    if (utterance.words) {
      return utterance;
    }
    const prior = previousBySource.get(utteranceSourceKey(utterance));
    if (!prior?.words || prior.text !== utterance.text) {
      complete = false;
      return utterance;
    }
    return {
      ...utterance,
      words: remapOverlayWords(prior.words, prior, utterance),
    };
  });
  return { transcript: { ...incoming, utterances }, complete };
}

function preserveHydratedFields(
  previous: ProjectView,
  incoming: ProjectView,
): ProjectView {
  const incomingH = incoming.meta?.hydration;
  if (!incomingH) {
    return incoming;
  }
  let next = incoming;
  if (incomingH.transcript_words === false && previous.transcript) {
    const { transcript, complete } = overlayTranscriptWords(
      previous.transcript,
      incoming.transcript,
    );
    const mergedMeta = mergeHydration(previous.meta, incoming.meta);
    next = {
      ...next,
      transcript,
      meta: {
        ...mergedMeta,
        hydration: {
          ...mergedMeta.hydration,
          transcript_words: complete,
        },
      },
    };
  }
  if (
    incomingH.history_groups === false &&
    previous.meta?.hydration?.history_groups &&
    previous.history.groups.length > 0
  ) {
    next = {
      ...next,
      history: {
        ...next.history,
        groups: previous.history.groups,
      },
      meta: mergeHydration(next.meta, {
        ...next.meta,
        hydration: { ...next.meta.hydration, history_groups: true },
      }),
    };
  }
  return next;
}

function mergeSnapshotHistory(
  next: ProjectView,
  history: DocumentSnapshot["history"],
): ProjectView {
  if (!history) {
    return next;
  }
  let merged = mergeProjectPatch(next, {
    history: { ...next.history, ...history },
  });
  if (Array.isArray(history.groups)) {
    merged = mergeProjectPatch(merged, {
      meta: {
        ...merged.meta,
        hydration: {
          ...merged.meta.hydration,
          history_groups: true,
        },
      },
    });
  }
  return merged;
}

export function projectFromDocumentSnapshot(
  previous: ProjectView | null,
  snap: DocumentSnapshot,
): ProjectView | null {
  if (snap.project) {
    let next = previous
      ? preserveHydratedFields(previous, snap.project)
      : snap.project;
    if (snap.comments) {
      next = { ...next, comments: snap.comments };
    }
    return reuseUnchanged(previous, mergeSnapshotHistory(next, snap.history));
  }
  if (!previous) {
    return null;
  }
  let next = previous;
  if (snap.patch) {
    next = mergeProjectPatch(next, snap.patch);
  }
  if (snap.comments) {
    next = { ...next, comments: snap.comments };
  }
  return reuseUnchanged(previous, mergeSnapshotHistory(next, snap.history));
}

export function patchTracksOrder(
  project: ProjectView,
  trackId: string,
  index: number,
): ProjectView {
  const tracks = [...project.tracks];
  const current = tracks.findIndex((t) => t.id === trackId);
  if (current < 0) {
    return project;
  }
  const [track] = tracks.splice(current, 1);
  if (!track) {
    return project;
  }
  const dest = Math.max(0, Math.min(index, tracks.length));
  tracks.splice(dest, 0, track);
  if (tracks.length === project.tracks.length) {
    let same = true;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i] !== project.tracks[i]) {
        same = false;
        break;
      }
    }
    if (same) {
      return project;
    }
  }
  return { ...project, tracks };
}

export type { ClipMoveItem } from "../edit/clipMove";
export { patchClipsMove } from "../edit/clipMove";

function patchTrack<K extends keyof TrackView>(
  project: ProjectView,
  trackId: string,
  fields: Partial<Pick<TrackView, K>>,
): ProjectView {
  let changed = false;
  const keys = Object.keys(fields) as K[];
  const tracks = project.tracks.map((t) => {
    if (t.id !== trackId) {
      return t;
    }
    if (keys.every((key) => fields[key] === t[key])) {
      return t;
    }
    changed = true;
    return { ...t, ...fields };
  });
  return changed ? { ...project, tracks } : project;
}

export function patchTrackMeta(
  project: ProjectView,
  trackId: string,
  fields: Partial<Pick<TrackView, "label" | "role" | "speaker">>,
): ProjectView {
  return patchTrack(project, trackId, fields);
}

/** Optimistic splice for SetTrackFader / SetTrackMute. */
export function patchTrackMix(
  project: ProjectView,
  trackId: string,
  fields: Partial<Pick<TrackView, "fader_db" | "muted">>,
): ProjectView {
  return patchTrack(project, trackId, fields);
}

export function snapshotFromResult(
  result: Record<string, unknown>,
): DocumentSnapshot | null {
  const snap = result.snapshot;
  if (!snap || typeof snap !== "object") {
    return null;
  }
  return snap as DocumentSnapshot;
}

export function commentFromCommandResult(
  result: Record<string, unknown>,
): TimelineComment | null {
  const cmd = result.command;
  if (cmd && typeof cmd === "object") {
    const payload = (cmd as { payload?: Record<string, unknown> }).payload;
    const inner = payload?.result;
    if (inner && typeof inner === "object" && inner !== null && "id" in inner) {
      return inner as TimelineComment;
    }
  }
  const comments = snapshotFromResult(result)?.comments;
  if (Array.isArray(comments) && comments.length > 0) {
    return comments[comments.length - 1] ?? null;
  }
  return null;
}
