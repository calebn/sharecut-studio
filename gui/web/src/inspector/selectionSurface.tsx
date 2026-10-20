import type { ReactNode } from "react";
import { rangeClips } from "../edit/rangeSelection";
import type { MobileMode, MoreDestination } from "../state/types";
import { RangeActions } from "../timeline/RangeActions";
import type { ProjectView, Selection } from "../types/project";
import { AppliedEditInspector } from "./views/AppliedEditInspector";
import { ChapterInspector } from "./views/ChapterInspector";
import { ClipBleedHost } from "./views/ClipBleedHost";
import { ClipInspector } from "./views/ClipInspector";
import { CommentInspector } from "./views/CommentInspector";
import { EnvelopeWorkspace } from "./views/EnvelopeWorkspace";
import { PendingEditInspector } from "./views/PendingEditInspector";
import { SocialClipInspector } from "./views/SocialClipInspector";
import { TrackInspector } from "./views/TrackInspector";
import { TranscriptWordInspector } from "./views/TranscriptWordInspector";

export type SelectionKind = NonNullable<Selection>["kind"];
type SelectionOf<K extends SelectionKind> = Extract<
  NonNullable<Selection>,
  { kind: K }
>;

/** The phone-shell screens whose selection sheet can open. */
export type SheetScreen =
  | "timeline"
  | "listen"
  | "text"
  | "comments"
  | "impact";

/** The phone screen a mobile mode and More destination put on screen. */
export function sheetScreen(
  mode: MobileMode,
  destination: MoreDestination,
): SheetScreen | null {
  if (mode !== "more") return mode;
  return destination === "comments" || destination === "impact"
    ? destination
    : null;
}

export interface SurfaceContext {
  project: ProjectView;
  projectEpoch: number;
  setPlayheadSec: (sec: number) => void;
}

const notFound = (what: string) => <aside className="inspector">{what}</aside>;

/**
 * What one kind of selection puts on screen. `body` fills the inspector, and
 * the touch sheet, with the selection's fields and actions. `phoneScreens` are
 * the phone screens where the selection opens the sheet: the Timeline and
 * Listen screens always, the rest only where the selection belongs.
 */
export interface SelectionSurface<K extends SelectionKind> {
  body: (selection: SelectionOf<K>, ctx: SurfaceContext) => ReactNode;
  phoneScreens: readonly SheetScreen[];
}

const ANYWHERE: readonly SheetScreen[] = ["timeline", "listen"];
const WITH_TEXT: readonly SheetScreen[] = ["timeline", "listen", "text"];

const rangeSurface = {
  body: () => <RangeActions sheet />,
  phoneScreens: WITH_TEXT,
} as const;

export const SELECTION_SURFACES: {
  [K in SelectionKind]: SelectionSurface<K>;
} = {
  range: rangeSurface,
  transcriptRange: rangeSurface,
  clip: {
    phoneScreens: ANYWHERE,
    body: (sel, { project }) => {
      const clip = Object.values(project.clips.tracks)
        .flat()
        .find((c) => c.id === sel.id);
      return clip ? <ClipInspector clip={clip} /> : notFound("Clip not found");
    },
  },
  bleedAttenuation: {
    phoneScreens: ANYWHERE,
    body: (sel, { project }) => {
      const clip = rangeClips(project).find(
        (row) => row.id === sel.id && row.track_id === sel.trackId,
      );
      return clip ? (
        <ClipBleedHost
          key={JSON.stringify([sel.trackId, sel.id])}
          trackId={sel.trackId}
          clipId={sel.id}
          clipLabel={
            project.tracks.find((track) => track.id === sel.trackId)?.label ??
            sel.trackId
          }
        />
      ) : (
        notFound("Clip not found")
      );
    },
  },
  pending: {
    phoneScreens: [...ANYWHERE, "impact"],
    body: (sel, { project }) => {
      const edit = project.pending_edits.find((e) => e.id === sel.id);
      return edit ? (
        <PendingEditInspector edit={edit} />
      ) : (
        notFound("Edit not found")
      );
    },
  },
  applied: {
    phoneScreens: ANYWHERE,
    body: (sel, { project }) => {
      const rec = project.applied_edits.records.find((r) => r.id === sel.id);
      return rec ? (
        <AppliedEditInspector rec={rec} />
      ) : (
        notFound("Record not found")
      );
    },
  },
  track: {
    phoneScreens: ANYWHERE,
    body: (sel, { project }) => {
      const track = project.tracks.find((t) => t.id === sel.trackId);
      return track ? (
        <TrackInspector
          key={track.id}
          track={track}
          effects={project.effects_by_track[sel.trackId] ?? []}
        />
      ) : (
        notFound("Track not found")
      );
    },
  },
  chapter: {
    phoneScreens: ANYWHERE,
    body: (sel) => <ChapterInspector title={sel.id} time={sel.time} />,
  },
  social: {
    phoneScreens: ANYWHERE,
    body: (sel, { project, setPlayheadSec }) => {
      const clip = (project.social_clips ?? []).find((c) => c.id === sel.id);
      return clip ? (
        <SocialClipInspector clip={clip} onSeek={setPlayheadSec} />
      ) : (
        notFound("Social clip not found")
      );
    },
  },
  comment: {
    phoneScreens: [...ANYWHERE, "comments"],
    body: (sel, { project, setPlayheadSec }) => {
      const comment = (project.comments ?? []).find((c) => c.id === sel.id);
      if (!comment) return notFound("Comment not found");
      const linked = comment.edit_decision_id
        ? project.pending_edits.find((e) => e.id === comment.edit_decision_id)
        : undefined;
      return linked ? (
        <PendingEditInspector edit={linked} />
      ) : (
        <CommentInspector comment={comment} onSeek={setPlayheadSec} />
      );
    },
  },
  transcriptWord: {
    phoneScreens: WITH_TEXT,
    body: (sel) => (
      <TranscriptWordInspector
        key={JSON.stringify([sel.trackId, sel.sourceId ?? null, sel.wordIndex])}
        trackId={sel.trackId}
        sourceId={sel.sourceId}
        wordIndex={sel.wordIndex}
      />
    ),
  },
  envelope: {
    phoneScreens: ANYWHERE,
    body: (sel, { projectEpoch }) => (
      <EnvelopeWorkspace
        key={`${projectEpoch}:${sel.trackId}:workspace`}
        trackId={sel.trackId}
        pointId={null}
      />
    ),
  },
  envelopePoint: {
    phoneScreens: ANYWHERE,
    body: (sel, { projectEpoch }) => (
      <EnvelopeWorkspace
        key={`${projectEpoch}:${sel.trackId}:${sel.pointId}`}
        trackId={sel.trackId}
        pointId={sel.pointId}
      />
    ),
  },
};

function surfaceOf<K extends SelectionKind>(
  selection: SelectionOf<K>,
): SelectionSurface<K> {
  return SELECTION_SURFACES[selection.kind] as SelectionSurface<K>;
}

/** The body of `selection`'s surface. */
export function renderSelectionBody(
  selection: NonNullable<Selection>,
  ctx: SurfaceContext,
): ReactNode {
  return surfaceOf(selection).body(selection, ctx);
}

/** Does `selection` open the phone sheet on `screen`? */
export function opensPhoneSheet(
  selection: NonNullable<Selection>,
  screen: SheetScreen | null,
): boolean {
  return screen != null && surfaceOf(selection).phoneScreens.includes(screen);
}
