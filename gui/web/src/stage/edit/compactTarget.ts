/**
 * What the compact inspector (the phone drawer on a timeline selection) is
 * about: the target's name for the drawer header, and the timeline element it
 * must leave in view above the sheet. A kind without one (a track, a comment)
 * opens the regular Inspector sheet instead.
 */
import type { RoutedTarget } from "../../timeline/hitRouting";
import { HIT_KINDS, type HitKind } from "../../timeline/inputContract";
import type { ClipRow, ProjectView, Selection } from "../../types/project";
import { clipIdentityTrack, clipSpeakerLabel } from "../../utils/clipLabels";

export interface CompactTarget {
  /** The target's name: "Fade in", "Pending cut", "Envelope point". */
  title: string;
  /** Selector of the timeline element the sheet must leave in view. */
  locate: string;
}

const attr = (name: string, value: string) =>
  `[${name}=${JSON.stringify(value)}]`;

const hitSelector = (kind: HitKind, id: string) =>
  `${attr("data-hit-kind", kind)}${attr("data-hit-id", id)}`;

/** Edge handles are the hit kinds whose contract nudge row is a fade or a trim. */
function isEdgeHandle(kind: HitKind): boolean {
  const [nudge] = HIT_KINDS[kind].nudges;
  return nudge === "fade" || nudge === "trim";
}

function clipTarget(
  project: ProjectView,
  clip: ClipRow,
  hit: RoutedTarget | null,
): CompactTarget {
  if (hit?.id === clip.id && isEdgeHandle(hit.kind)) {
    return {
      title: HIT_KINDS[hit.kind].label,
      locate: hitSelector(hit.kind, clip.id),
    };
  }
  const track = clipIdentityTrack({ clip, tracks: project.tracks });
  return {
    title: `${clipSpeakerLabel({
      trackSpeaker: track?.speaker,
      trackLabel: track?.label,
      role: track?.role ?? "audio",
    })} clip`,
    locate: attr("data-clip-id", clip.id),
  };
}

export function compactTarget(
  project: ProjectView,
  selection: Selection,
  hit: RoutedTarget | null,
): CompactTarget | null {
  switch (selection?.kind) {
    case "clip": {
      const id = selection.id;
      const clip = Object.values(project.clips.tracks)
        .flat()
        .find((c) => c.id === id);
      return clip ? clipTarget(project, clip, hit) : null;
    }
    case "pending": {
      const id = selection.id;
      const edit = project.pending_edits.find((e) => e.id === id);
      if (!edit || edit.timeline_start == null || edit.timeline_end == null) {
        return null;
      }
      return {
        title: `Pending ${edit.type}`,
        locate: attr("data-pending-id", edit.id),
      };
    }
    case "envelopePoint": {
      const { trackId, pointId } = selection;
      const point = project.envelopes
        .find((e) => e.track_id === trackId)
        ?.points.find((p) => p.id === pointId);
      return point
        ? {
            title: HIT_KINDS["envelope-point"].label,
            locate: hitSelector("envelope-point", point.id),
          }
        : null;
    }
    case "chapter":
      return {
        title: HIT_KINDS.chapter.label,
        locate: hitSelector("chapter", `${selection.time}-${selection.id}`),
      };
    default:
      return null;
  }
}
