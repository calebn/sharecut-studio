/**
 * What the phone peek strip shows for a timeline selection (#1051 rounds 3
 * and 4): the target's name, its key value, and the values nudges can step
 * at the keyboard's steps: a clip's fade or trim, a pending edit's start and
 * end, an envelope point's time and level. `null` for a selection that is
 * not a timeline target; that one opens the full inspector as before.
 */
import { type NudgeField, nudgeAxis } from "../edit/nudge";
import { HIT_KINDS, type HitKind } from "../timeline/hitCandidates";
import type { RoutedTarget } from "../timeline/hitRouting";
import type { ClipRow, ProjectView, Selection } from "../types/project";
import { clipIdentityTrack, clipSpeakerLabel } from "../utils/clipLabels";
import { formatTime } from "../utils/time";

/** One value of the target the strip's nudge buttons step. */
export interface PeekNudgeRow {
  field: NudgeField;
  /** The row's label when the target has several: "Start", "Level". */
  label: string | null;
  /** The value's name in button labels and announcements: "Trim start". */
  name: string;
}

export interface PeekTarget {
  /** The target's name: "Fade in", "Pending cut", "Envelope point". */
  title: string;
  /** What it belongs to (the clip, track or chapter), when the title does not say. */
  owner: string | null;
  /** Its key value: "300 ms", "00:10.000 to 00:24.000". */
  value: string;
  /** What nudges can step, before permissions (the strip checks those). */
  nudges: PeekNudgeRow[];
  /** Selector of the timeline element the strip must leave in view. */
  locate: string;
}

const attr = (name: string, value: string) =>
  `[${name}=${JSON.stringify(value)}]`;

const hitSelector = (kind: HitKind, id: string) =>
  `${attr("data-hit-kind", kind)}${attr("data-hit-id", id)}`;

const CLIP_EDGES: Partial<
  Record<HitKind, { kind: "fade" | "trim"; edge: "in" | "out" }>
> = {
  "fade-in": { kind: "fade", edge: "in" },
  "fade-out": { kind: "fade", edge: "out" },
  "trim-in": { kind: "trim", edge: "in" },
  "trim-out": { kind: "trim", edge: "out" },
};

/** `rows` whose fields exist in `project` (a pending split has no edges). */
function present(project: ProjectView, rows: PeekNudgeRow[]): PeekNudgeRow[] {
  return rows.filter((row) => nudgeAxis(project, row.field) != null);
}

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
    const title = HIT_KINDS[hit.kind].label;
    const field: NudgeField = {
      ...edge,
      trackId: clip.track_id,
      clipId: clip.id,
    };
    const value =
      edge.kind === "fade"
        ? `${edge.edge === "in" ? clip.fade_in_ms : clip.fade_out_ms} ms`
        : formatTime(edge.edge === "in" ? clip.source_start : clip.source_end);
    return {
      title,
      owner,
      value,
      nudges: present(project, [{ field, label: null, name: title }]),
      locate: hitSelector(hit.kind, clip.id),
    };
  }
  return {
    title: owner,
    owner: null,
    value: `${formatTime(clip.timeline_start)} to ${formatTime(clip.timeline_end)}`,
    nudges: [],
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
      const title = `Pending ${edit.type}`;
      const edge = (e: "start" | "end", label: string): PeekNudgeRow => ({
        field: {
          kind: "pending",
          trackId: edit.track_id,
          editId: edit.id,
          edge: e,
        },
        label,
        name: `${title} ${e}`,
      });
      return {
        title,
        owner: track?.label ?? "Track",
        value: `${formatTime(edit.timeline_start)} to ${formatTime(edit.timeline_end)}`,
        nudges: present(project, [edge("start", "Start"), edge("end", "End")]),
        locate: attr("data-pending-id", edit.id),
      };
    }
    case "envelopePoint": {
      const point = project.envelopes
        .find((e) => e.track_id === selection.trackId)
        ?.points.find((p) => p.id === selection.pointId);
      if (!point) return null;
      const track = project.tracks.find((t) => t.id === selection.trackId);
      const title = HIT_KINDS["envelope-point"].label;
      const ids = { trackId: selection.trackId, pointId: point.id };
      return {
        title,
        owner: track?.label ?? "Track",
        value: `${point.value.toFixed(2)}× at ${formatTime(point.time)}`,
        nudges: present(project, [
          {
            field: { kind: "envelope-time", ...ids },
            label: "Time",
            name: title,
          },
          {
            field: { kind: "envelope-level", ...ids },
            label: "Level",
            name: `${title} level`,
          },
        ]),
        locate: hitSelector("envelope-point", point.id),
      };
    }
    case "chapter":
      return {
        title: HIT_KINDS.chapter.label,
        owner: selection.id,
        value: formatTime(selection.time),
        nudges: [],
        locate: hitSelector("chapter", `${selection.time}-${selection.id}`),
      };
    default:
      return null;
  }
}
