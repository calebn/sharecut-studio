import type { ReactNode } from "react";
import type { CommandContext } from "../commands/context";
import { seekTransport } from "../commands/seek";
import { rangeClips } from "../edit/rangeSelection";
import { EnvelopePointBody } from "../stage/edit/EnvelopePointBody";
import { SectionsBody } from "../stage/edit/SectionsBody";
import type { RoutedTarget } from "../timeline/hitRouting";
import { RangeFields } from "../timeline/RangeFields";
import type { ProjectView, Selection } from "../types/project";
import {
  type PeekTarget,
  peekChapter,
  peekClip,
  peekEnvelopePoint,
  peekPending,
} from "./peekBuilders";
import {
  moreCutClip,
  moreMoveTrack,
  type RelatedCommandDescriptor,
  relatedCopy,
  relatedCopyWord,
} from "./relatedRows";
import { ChapterInspector } from "./views/ChapterInspector";
import { ClipBleedHost } from "./views/ClipBleedHost";
import { ClipInspector } from "./views/ClipInspector";
import { CommentInspector } from "./views/CommentInspector";
import { PendingEditInspector } from "./views/PendingEditInspector";
import { SocialClipInspector } from "./views/SocialClipInspector";
import { TrackInspector } from "./views/TrackInspector";

export type SelectionKind = NonNullable<Selection>["kind"];
type SelectionOf<K extends SelectionKind> = Extract<
  NonNullable<Selection>,
  { kind: K }
>;

/** The Edit surfaces where a selection sheet can open: the lanes or the Script. */
export type SheetScreen = "timeline" | "text";

export interface SurfaceContext {
  project: ProjectView;
  projectEpoch: number;
  /** The desktop rail, or the touch sheet that also carries the range actions. */
  placement: "rail" | "sheet";
}

const notFound = (what: string) => <aside className="inspector">{what}</aside>;

/**
 * What one kind of selection puts on screen. `body` fills the inspector, and
 * the touch sheet, with the selection's fields and actions. `screens` are the
 * Edit surfaces, on the phone and the tablet alike, where the selection opens
 * the sheet: the lanes always, the Script only where the selection belongs. `peek` is the compact strip for a timeline target (null
 * opens the full body). `related` and `more` are the Related and More commands
 * under the body.
 */
export interface SelectionSurface<K extends SelectionKind> {
  body: (selection: SelectionOf<K>, ctx: SurfaceContext) => ReactNode;
  screens: readonly SheetScreen[];
  peek: (
    selection: SelectionOf<K>,
    project: ProjectView,
    hit: RoutedTarget | null,
  ) => PeekTarget | null;
  related: (selection: SelectionOf<K>) => readonly RelatedCommandDescriptor[];
  more: (
    selection: SelectionOf<K>,
    project: ProjectView,
    context: CommandContext,
  ) => readonly RelatedCommandDescriptor[];
}

const ANYWHERE: readonly SheetScreen[] = ["timeline"];
const WITH_TEXT: readonly SheetScreen[] = ["timeline", "text"];

const noPeek = () => null;
const noRelated = () => [];
const noMore = () => [];
/** A kind with no peek strip and no Related or More commands. */
const plain = { peek: noPeek, related: noRelated, more: noMore } as const;

const trackBody = (sel: { trackId: string }, { project }: SurfaceContext) => {
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
};

const rangeSurface = {
  ...plain,
  body: () => <RangeFields sheet always />,
  screens: WITH_TEXT,
} as const;

export const SELECTION_SURFACES: {
  [K in SelectionKind]: SelectionSurface<K>;
} = {
  range: rangeSurface,
  transcriptRange: {
    screens: WITH_TEXT,
    peek: noPeek,
    related: relatedCopyWord,
    more: noMore,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  clip: {
    screens: ANYWHERE,
    peek: peekClip,
    related: relatedCopy,
    more: moreCutClip,
    body: (sel, { project }) => {
      const clip = Object.values(project.clips.tracks)
        .flat()
        .find((c) => c.id === sel.id);
      return clip ? <ClipInspector clip={clip} /> : notFound("Clip not found");
    },
  },
  bleedAttenuation: {
    ...plain,
    screens: ANYWHERE,
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
    ...plain,
    screens: ANYWHERE,
    peek: peekPending,
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
    ...plain,
    screens: ANYWHERE,
    body: () => <SectionsBody withRange={false} />,
  },
  track: {
    ...plain,
    screens: ANYWHERE,
    more: moreMoveTrack,
    body: trackBody,
  },
  chapter: {
    ...plain,
    screens: ANYWHERE,
    peek: peekChapter,
    body: (sel) => <ChapterInspector title={sel.id} time={sel.time} />,
  },
  social: {
    ...plain,
    screens: ANYWHERE,
    body: (sel, { project }) => {
      const clip = (project.social_clips ?? []).find((c) => c.id === sel.id);
      return clip ? (
        <SocialClipInspector
          clip={clip}
          onSeek={(sec) => void seekTransport(sec)}
        />
      ) : (
        notFound("Social clip not found")
      );
    },
  },
  comment: {
    ...plain,
    screens: ANYWHERE,
    body: (sel, { project }) => {
      const comment = (project.comments ?? []).find((c) => c.id === sel.id);
      if (!comment) return notFound("Comment not found");
      const linked = comment.edit_decision_id
        ? project.pending_edits.find((e) => e.id === comment.edit_decision_id)
        : undefined;
      return linked ? (
        <PendingEditInspector edit={linked} />
      ) : (
        <CommentInspector
          comment={comment}
          onSeek={(sec) => void seekTransport(sec)}
        />
      );
    },
  },
  envelope: { ...plain, screens: ANYWHERE, body: trackBody },
  envelopePoint: {
    ...plain,
    screens: ANYWHERE,
    peek: peekEnvelopePoint,
    body: () => <EnvelopePointBody />,
  },
};

export function surfaceOf<K extends SelectionKind>(
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

/** Does `selection` open the sheet on `screen`? One answer for the phone and the tablet. */
export function opensSheet(
  selection: NonNullable<Selection>,
  screen: SheetScreen | null,
): boolean {
  return screen != null && surfaceOf(selection).screens.includes(screen);
}
