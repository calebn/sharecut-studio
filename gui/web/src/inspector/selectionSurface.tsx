import type { ReactNode } from "react";
import { EnvelopePointBody } from "../stage/edit/EnvelopePointBody";
import { PendingEditBody } from "../stage/edit/PendingEditBody";
import { SectionsBody } from "../stage/edit/SectionsBody";
import { RangeFields } from "../timeline/RangeFields";
import type { ProjectView, Selection } from "../types/project";

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
 */
export interface SelectionSurface<K extends SelectionKind> {
  body: (selection: SelectionOf<K>, ctx: SurfaceContext) => ReactNode;
  screens: readonly SheetScreen[];
}

const ANYWHERE: readonly SheetScreen[] = ["timeline"];
const WITH_TEXT: readonly SheetScreen[] = ["timeline", "text"];

const rangeSurface = {
  body: () => <RangeFields sheet always />,
  screens: WITH_TEXT,
} as const;

export const SELECTION_SURFACES: {
  [K in SelectionKind]: SelectionSurface<K>;
} = {
  range: rangeSurface,
  transcriptRange: {
    screens: WITH_TEXT,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  clip: {
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  bleedAttenuation: {
    screens: ANYWHERE,
    body: () => <SectionsBody withRange={false} />,
  },
  pending: {
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
    screens: ANYWHERE,
    body: () => <SectionsBody withRange={false} />,
  },
  track: {
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  chapter: {
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  social: {
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  comment: {
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
    screens: ANYWHERE,
    body: (_sel, { placement }) => (
      <SectionsBody withRange={placement === "sheet"} />
    ),
  },
  envelopePoint: {
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
