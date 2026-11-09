import type { ReactNode } from "react";
import type { CommandContext } from "../commands/context";
import { EnvelopePointBody } from "../stage/edit/EnvelopePointBody";
import { PendingEditBody } from "../stage/edit/PendingEditBody";
import { SectionsBody } from "../stage/edit/SectionsBody";
import { RangeFields } from "../timeline/RangeFields";
import type { ProjectView, Selection } from "../types/project";
import {
  moreCutClip,
  moreMoveTrack,
  type RelatedCommandDescriptor,
  relatedCopy,
  relatedCopyWord,
} from "./relatedRows";

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
 * the sheet: the lanes always, the Script only where the selection belongs.
 * `related` and `more` are the Related and More commands under the body.
 */
export interface SelectionSurface<K extends SelectionKind> {
  body: (selection: SelectionOf<K>, ctx: SurfaceContext) => ReactNode;
  screens: readonly SheetScreen[];
  related: (selection: SelectionOf<K>) => readonly RelatedCommandDescriptor[];
  more: (
    selection: SelectionOf<K>,
    project: ProjectView,
    context: CommandContext,
  ) => readonly RelatedCommandDescriptor[];
}

const ANYWHERE: readonly SheetScreen[] = ["timeline"];
const WITH_TEXT: readonly SheetScreen[] = ["timeline", "text"];

const noRelated = () => [];
const noMore = () => [];
/** A kind with no Related or More commands. */
const plain = { related: noRelated, more: noMore } as const;

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
    related: relatedCopyWord,
    more: noMore,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  clip: {
    screens: ANYWHERE,
    related: relatedCopy,
    more: moreCutClip,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  bleedAttenuation: {
    ...plain,
    screens: ANYWHERE,
    body: () => <SectionsBody withRange={false} />,
  },
  pending: {
    ...plain,
    screens: ANYWHERE,
    body: (sel, { project }) => {
      const edit = project.pending_edits.find((e) => e.id === sel.id);
      return edit ? (
        <PendingEditBody edit={edit} />
      ) : (
        notFound("Edit not found")
      );
    },
  },
  seam: {
    ...plain,
    screens: ANYWHERE,
    body: () => <SectionsBody withRange={false} />,
  },
  track: {
    ...plain,
    screens: ANYWHERE,
    more: moreMoveTrack,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  chapter: {
    ...plain,
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  social: {
    ...plain,
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
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
        <PendingEditBody edit={linked} />
      ) : (
        <SectionsBody withRange={false} />
      );
    },
  },
  envelope: {
    ...plain,
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  envelopePoint: {
    ...plain,
    screens: ANYWHERE,
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
