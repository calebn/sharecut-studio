/**
 * What the phone peek strip shows for a timeline selection (#1051 round 3):
 * the target's name, its key value, and, for a clip's fade or trim, nudges at
 * the keyboard's steps. `null` for a selection that is not a timeline target;
 * that one opens the full inspector as before.
 */
import type { TrimEdge } from "../edit/clipEdgePreview";
import { clipEdgeValue } from "../edit/clipEdgeSave";
import {
  CLIP_HANDLE_STEPS,
  type ClipHandleStepKind,
} from "../edit/clipHandleSteps";
import { HIT_KINDS, type HitKind } from "../timeline/hitCandidates";
import type { RoutedTarget } from "../timeline/hitRouting";
import type { ClipRow, ProjectView, Selection } from "../types/project";
import { clipIdentityTrack, clipSpeakerLabel } from "../utils/clipLabels";
import { formatTime } from "../utils/time";

export interface PeekNudge {
  kind: ClipHandleStepKind;
  edge: TrimEdge;
  clip: ClipRow;
  /** Small then large step, in `unit`, as the arrow keys and Shift+arrows step. */
  steps: readonly [number, number];
  unit: "ms" | "s";
}

export interface PeekTarget {
  /** The target's name: "Fade in", "Pending cut", "Envelope point". */
  title: string;
  /** What it belongs to (the clip, track or chapter), when the title does not say. */
  owner: string | null;
  /** Its key value: "300 ms", "00:10.000 to 00:24.000". */
  value: string;
  nudge: PeekNudge | null;
  /** Selector of the timeline element the strip must leave in view. */
  locate: string;
}

const attr = (name: string, value: string) =>
  `[${name}=${JSON.stringify(value)}]`;

const hitSelector = (kind: HitKind, id: string) =>
  `${attr("data-hit-kind", kind)}${attr("data-hit-id", id)}`;

const CLIP_EDGES: Partial<
  Record<HitKind, { kind: ClipHandleStepKind; edge: TrimEdge }>
> = {
  "fade-in": { kind: "fade", edge: "in" },
  "fade-out": { kind: "fade", edge: "out" },
  "trim-in": { kind: "trim", edge: "in" },
  "trim-out": { kind: "trim", edge: "out" },
};

function clipPeek(
  project: ProjectView,
  clip: ClipRow,
  hit: RoutedTarget | null,
): PeekTarget {
  const track = clipIdentityTrack({ clip, tracks: project.tracks });
  const owner = `${clipSpeakerLabel({
    trackSpeaker: track?.speaker,
    trackLabel: track?.label,
    role: track?.role ?? "audio",
  })} clip`;
  const edge = hit?.id === clip.id ? CLIP_EDGES[hit.kind] : undefined;
  if (hit && edge) {
    const { small, large, unit } = CLIP_HANDLE_STEPS[edge.kind];
    const value = clipEdgeValue(clip, edge.kind, edge.edge);
    return {
      title: HIT_KINDS[hit.kind].label,
      owner,
      value: edge.kind === "fade" ? `${value} ms` : formatTime(value),
      nudge: { ...edge, clip, steps: [small, large], unit },
      locate: hitSelector(hit.kind, clip.id),
    };
  }
  return {
    title: owner,
    owner: null,
    value: `${formatTime(clip.timeline_start)} to ${formatTime(clip.timeline_end)}`,
    nudge: null,
    locate: attr("data-clip-id", clip.id),
  };
}

export function peekTarget(
  project: ProjectView,
  selection: Selection,
  hit: RoutedTarget | null,
): PeekTarget | null {
  switch (selection?.kind) {
    case "clip": {
      const clip = Object.values(project.clips.tracks)
        .flat()
        .find((c) => c.id === selection.id);
      return clip ? clipPeek(project, clip, hit) : null;
    }
    case "pending": {
      const edit = project.pending_edits.find((e) => e.id === selection.id);
      if (!edit || edit.timeline_start == null || edit.timeline_end == null) {
        return null;
      }
      const track = project.tracks.find((t) => t.id === edit.track_id);
      return {
        title: `Pending ${edit.type}`,
        owner: track?.label ?? "Track",
        value: `${formatTime(edit.timeline_start)} to ${formatTime(edit.timeline_end)}`,
        nudge: null,
        locate: attr("data-pending-id", edit.id),
      };
    }
    case "envelopePoint": {
      const point = project.envelopes
        .find((e) => e.track_id === selection.trackId)
        ?.points.find((p) => p.id === selection.pointId);
      if (!point) return null;
      const track = project.tracks.find((t) => t.id === selection.trackId);
      return {
        title: HIT_KINDS["envelope-point"].label,
        owner: track?.label ?? "Track",
        value: `${point.value.toFixed(2)}× at ${formatTime(point.time)}`,
        nudge: null,
        locate: hitSelector("envelope-point", point.id),
      };
    }
    case "chapter":
      return {
        title: HIT_KINDS.chapter.label,
        owner: selection.id,
        value: formatTime(selection.time),
        nudge: null,
        locate: hitSelector("chapter", `${selection.time}-${selection.id}`),
      };
    default:
      return null;
  }
}
