/**
 * Nudges (#1051 round 4): small steps of one value of a timeline target, the
 * same steps the arrow keys take on a focused handle. Each field says what it
 * moves, its hard limits, where its moving point sits on the timeline (for
 * soft boundaries), how a draft value shows in the project, and how it saves.
 *
 * A held nudge previews every step in the project and saves once on release,
 * so a whole run is one undoable edit (`inspector/useNudgeRun.ts`).
 */
import { setClipFade, setEnvelope, updatePendingEdit } from "../api";
import { pendingEditBaseline } from "../api/documentEdits";
import {
  pendingEdgePlacement,
  pendingEdgePreview,
} from "../timeline/pendingEdgeDrag";
import type {
  AutomationPoint,
  ClipRow,
  PendingEditView,
  ProjectView,
} from "../types/project";
import {
  clampEnvelopeValue,
  findVolumeEnvelope,
  replaceEnvelopePoint,
  sortedVolumePoints,
  withVolumeEnvelopePoints,
} from "../utils/envelopes";
import { formatTimeMs } from "../utils/time";
import { clipsForOriginTrack } from "../utils/timebase";
import type { TrimEdge } from "./clipEdgePreview";
import { saveClipEdge, TRIM_MODE } from "./clipEdgeSave";
import { CLIP_HANDLE_STEPS } from "./clipHandleSteps";
import { clampFadeMs, edgeFadeMaxMs } from "./fadeLimits";
import {
  firstBoundaryCrossed,
  type NudgeMover,
  type SoftBoundary,
} from "./nudgeBoundaries";
import { trimDraft } from "./ripplePreview";
import { clampToTrimLimits, trimEdgeLimits } from "./trimLimits";

/** One value of one target that nudges can step. */
export type NudgeField =
  | { kind: "fade"; trackId: string; clipId: string; edge: TrimEdge }
  | { kind: "trim"; trackId: string; clipId: string; edge: TrimEdge }
  | {
      kind: "pending";
      trackId: string;
      editId: string;
      edge: "start" | "end";
    }
  | { kind: "envelope-time"; trackId: string; pointId: string }
  | { kind: "envelope-level"; trackId: string; pointId: string };

export type NudgeKind = NudgeField["kind"];

/** A field against one project: its value, hard limits and moving point. */
export interface NudgeAxis {
  value: number;
  /** The hard limits: `v` moved inside them. */
  clamp: (v: number) => number;
  /** Timeline second of the moving point at `v`; null if it does not move. */
  at: (v: number) => number | null;
  /** What moves, for the soft boundaries; null when nothing moves in time. */
  mover: NudgeMover | null;
}

/** How each kind of field reads, steps and announces itself. */
export const NUDGE_KINDS: Record<
  NudgeKind,
  {
    /** Small then large step, as the arrow keys and Shift+arrows step. */
    steps: readonly [number, number];
    unit: string;
    /** Words for a negative and a positive step. */
    ways: readonly [string, string];
    format: (v: number) => string;
    saved: string;
    /** A step ripples: later clips on every dialogue track move with it (#1135). */
    ripples: boolean;
  }
> = {
  fade: {
    steps: [CLIP_HANDLE_STEPS.fade.small, CLIP_HANDLE_STEPS.fade.large],
    unit: "ms",
    ways: ["shorter", "longer"],
    format: (v) => `${v} ms`,
    saved: "Fade saved",
    ripples: false,
  },
  trim: {
    steps: [CLIP_HANDLE_STEPS.trim.small, CLIP_HANDLE_STEPS.trim.large],
    unit: "s",
    ways: ["earlier", "later"],
    format: formatTimeMs,
    saved: "Trim saved",
    ripples: true,
  },
  pending: {
    steps: [CLIP_HANDLE_STEPS.trim.small, CLIP_HANDLE_STEPS.trim.large],
    unit: "s",
    ways: ["earlier", "later"],
    format: formatTimeMs,
    saved: "Pending edit timing saved",
    ripples: false,
  },
  "envelope-time": {
    steps: [CLIP_HANDLE_STEPS.trim.small, CLIP_HANDLE_STEPS.trim.large],
    unit: "s",
    ways: ["earlier", "later"],
    format: formatTimeMs,
    saved: "Envelope point saved",
    ripples: false,
  },
  "envelope-level": {
    steps: [0.01, 0.1],
    unit: "",
    ways: ["lower", "higher"],
    format: (v) => `${v.toFixed(2)}×`,
    saved: "Envelope point saved",
    ripples: false,
  },
};

/** Envelope points keep this far apart in time, so they never reorder. */
export const ENVELOPE_POINT_GAP_SEC = 0.001;

/** Values this close are equal (float noise from summed steps). */
const SAME = 1e-9;
/** Step sums carry float noise; values keep microseconds (or µ-units). */
const tidy = (v: number) => Math.round(v * 1e6) / 1e6;

function laneClip(project: ProjectView, trackId: string, clipId: string) {
  const lane = project.clips.tracks[trackId] ?? [];
  const index = lane.findIndex((c) => c.id === clipId);
  return index < 0 ? null : { lane, index, clip: lane[index] };
}

function pendingEdit(project: ProjectView, editId: string) {
  return project.pending_edits.find((e) => e.id === editId) ?? null;
}

/** The placement of a pending edit's edge: the clip its source sits in. */
function pendingEdge(
  project: ProjectView,
  edit: PendingEditView,
  edge: "start" | "end",
) {
  if (
    edit.exact_range ||
    edit.type === "split" ||
    edit.source_start == null ||
    edit.source_end == null
  ) {
    return null;
  }
  const source = edge === "start" ? edit.source_start : edit.source_end;
  const timeline =
    edge === "start" ? edit.source_start_timeline : edit.source_end_timeline;
  if (timeline == null) return null;
  const placement = pendingEdgePlacement(
    clipsForOriginTrack(project.clips.tracks, edit.track_id),
    source,
    timeline,
  );
  return placement
    ? {
        placement,
        sourceStart: edit.source_start,
        sourceEnd: edit.source_end,
        value: source,
      }
    : null;
}

function envelopePoint(project: ProjectView, trackId: string, pointId: string) {
  const points = sortedVolumePoints(project.envelopes, trackId);
  const index = points.findIndex((p) => p.id === pointId);
  return index < 0 ? null : { points, index, point: points[index] };
}

/** `field` against `project`, or null if its target is gone. */
export function nudgeAxis(
  project: ProjectView,
  field: NudgeField,
): NudgeAxis | null {
  switch (field.kind) {
    case "fade": {
      const found = laneClip(project, field.trackId, field.clipId);
      if (!found) return null;
      const { clip } = found;
      const track = project.tracks.find((t) => t.id === field.trackId);
      const inEdge = field.edge === "in";
      const max = edgeFadeMaxMs(
        clip.source_end - clip.source_start,
        track?.fade_max_ms ?? null,
        inEdge ? clip.fade_out_ms : clip.fade_in_ms,
      );
      return {
        value: inEdge ? clip.fade_in_ms : clip.fade_out_ms,
        clamp: (v) => clampFadeMs(v, max),
        at: (v) =>
          inEdge
            ? clip.timeline_start + v / 1000
            : clip.timeline_end - v / 1000,
        mover: {
          kind: "clip",
          clipId: clip.id,
          trackId: field.trackId,
          ripple: false,
        },
      };
    }
    case "trim": {
      const found = laneClip(project, field.trackId, field.clipId);
      if (!found) return null;
      const { lane, index, clip } = found;
      const out = field.edge === "out";
      const limits = trimEdgeLimits(lane, index, field.edge, TRIM_MODE);
      return {
        value: out ? clip.source_end : clip.source_start,
        clamp: (v) => clampToTrimLimits(v, limits),
        // A ripple trim keeps the clip's start in place: only the end moves.
        at: (v) => (out ? clip.timeline_start + (v - clip.source_start) : null),
        mover: out
          ? {
              kind: "clip",
              clipId: clip.id,
              trackId: field.trackId,
              ripple: true,
            }
          : null,
      };
    }
    case "pending": {
      const edit = pendingEdit(project, field.editId);
      const edge = edit && pendingEdge(project, edit, field.edge);
      if (!edit || !edge) return null;
      const preview = (v: number) =>
        pendingEdgePreview({
          edge: field.edge,
          sourceStart: edge.sourceStart,
          sourceEnd: edge.sourceEnd,
          sourceDeltaSec: v - edge.value,
          placement: edge.placement,
          ticks: [],
          zoomPxPerSec: 1,
        });
      return {
        value: edge.value,
        clamp: (v) => {
          const p = preview(v);
          if (!p) return edge.value;
          return field.edge === "start" ? p.sourceStart : p.sourceEnd;
        },
        at: (v) => preview(v)?.timelinePoint ?? null,
        mover: { kind: "pending", editId: edit.id, trackId: edit.track_id },
      };
    }
    case "envelope-time":
    case "envelope-level": {
      const found = envelopePoint(project, field.trackId, field.pointId);
      if (!found) return null;
      const { points, index, point } = found;
      if (field.kind === "envelope-level") {
        return {
          value: point.value,
          clamp: clampEnvelopeValue,
          at: () => null,
          mover: null,
        };
      }
      const lo =
        (points[index - 1]?.time ?? -Infinity) + ENVELOPE_POINT_GAP_SEC;
      const hi = (points[index + 1]?.time ?? Infinity) - ENVELOPE_POINT_GAP_SEC;
      return {
        value: point.time,
        clamp: (v) => Math.min(hi, Math.max(lo, 0, v)),
        at: (v) => v,
        mover: {
          kind: "envelope-point",
          trackId: field.trackId,
          pointId: point.id,
        },
      };
    }
  }
}

export type NudgeStop =
  | { kind: "limit" }
  | { kind: "boundary"; boundary: SoftBoundary };

/**
 * One nudge of `delta` from `value`. Hard limits always stop it. A held step
 * (an auto-repeat after the first) also stops exactly at the first soft
 * boundary it would reach or cross; a fresh step crosses it.
 */
export function nudgeStep(
  axis: NudgeAxis,
  boundaries: readonly SoftBoundary[],
  value: number,
  delta: number,
  held: boolean,
): { value: number; stop: NudgeStop | null } {
  const wanted = tidy(value + delta);
  const next = tidy(axis.clamp(wanted));
  if (Math.abs(next - value) < SAME) return { value, stop: { kind: "limit" } };
  const from = axis.at(value);
  const to = axis.at(next);
  if (held && from != null && to != null && from !== to) {
    const boundary = firstBoundaryCrossed(from, to, boundaries);
    if (boundary) {
      const at = tidy(
        axis.clamp(
          value + ((next - value) * (boundary.sec - from)) / (to - from),
        ),
      );
      return { value: at, stop: { kind: "boundary", boundary } };
    }
  }
  return {
    value: next,
    stop: Math.abs(next - wanted) > SAME ? { kind: "limit" } : null,
  };
}

function patchClip(
  project: ProjectView,
  trackId: string,
  clipId: string,
  patch: (clip: ClipRow) => ClipRow,
): ProjectView {
  const lane = project.clips.tracks[trackId];
  const index = lane?.findIndex((c) => c.id === clipId) ?? -1;
  if (!lane || index < 0) return project;
  const next = lane.map((c, i) => (i === index ? patch(c) : c));
  return {
    ...project,
    clips: {
      ...project.clips,
      tracks: { ...project.clips.tracks, [trackId]: next },
    },
  };
}

/** `project` showing `field` at `value`: the draft a held nudge previews. */
export function withNudge(
  project: ProjectView,
  field: NudgeField,
  value: number,
): ProjectView {
  switch (field.kind) {
    case "fade":
      return patchClip(project, field.trackId, field.clipId, (c) =>
        field.edge === "in"
          ? { ...c, fade_in_ms: value }
          : { ...c, fade_out_ms: value },
      );
    case "trim":
      return trimDraft(
        project,
        field.trackId,
        field.clipId,
        field.edge,
        value,
        TRIM_MODE,
      );
    case "pending": {
      const axis = nudgeAxis(project, field);
      const at = axis?.at(value);
      if (at == null) return project;
      const start = field.edge === "start";
      return {
        ...project,
        pending_edits: project.pending_edits.map((e) => {
          if (e.id !== field.editId) return e;
          const spans = e.timeline_spans.map((s, i, all) =>
            start && i === 0
              ? { ...s, start: at }
              : !start && i === all.length - 1
                ? { ...s, end: at }
                : s,
          );
          return start
            ? {
                ...e,
                source_start: value,
                source_start_timeline: at,
                timeline_start: at,
                timeline_spans: spans,
              }
            : {
                ...e,
                source_end: value,
                source_end_timeline: at,
                timeline_end: at,
                timeline_spans: spans,
              };
        }),
      };
    }
    case "envelope-time":
    case "envelope-level": {
      const raw = findVolumeEnvelope(project.envelopes, field.trackId)?.points;
      const point = raw?.find((p) => p.id === field.pointId);
      if (!raw || !point) return project;
      const next: AutomationPoint =
        field.kind === "envelope-time"
          ? { ...point, time: value }
          : { ...point, value };
      return {
        ...project,
        envelopes: withVolumeEnvelopePoints(
          project.envelopes,
          field.trackId,
          replaceEnvelopePoint(raw, next),
        ),
      };
    }
  }
}

/**
 * Saves `field` at `value` as one document command, against `origin`, the
 * project as it was saved when the nudges began. False when nothing saved:
 * a ripple trim over another speaker's speech asks first (`CutSpeechDialog`).
 */
export async function saveNudge(
  projectPath: string,
  origin: ProjectView,
  field: NudgeField,
  value: number,
): Promise<boolean> {
  switch (field.kind) {
    case "fade":
    case "trim": {
      const clip = laneClip(origin, field.trackId, field.clipId)?.clip;
      if (!clip) throw new Error("The clip is gone.");
      if (field.kind === "fade") {
        await setClipFade(
          projectPath,
          clip.id,
          field.edge === "in" ? value : clip.fade_in_ms,
          field.edge === "out" ? value : clip.fade_out_ms,
          { fade_in_ms: clip.fade_in_ms, fade_out_ms: clip.fade_out_ms },
        );
        return true;
      }
      return saveClipEdge(projectPath, clip, {
        kind: "trim",
        edge: field.edge,
        mode: TRIM_MODE,
        sourceSec: value,
      });
    }
    case "pending": {
      const edit = pendingEdit(origin, field.editId);
      if (!edit || edit.source_start == null || edit.source_end == null) {
        throw new Error("The pending edit is gone.");
      }
      const start = field.edge === "start" ? value : edit.source_start;
      const end = field.edge === "end" ? value : edit.source_end;
      await updatePendingEdit(
        projectPath,
        edit.id,
        start,
        end,
        false,
        undefined,
        pendingEditBaseline(edit),
      );
      return true;
    }
    case "envelope-time":
    case "envelope-level": {
      // Echo the saved points verbatim: the host compares floats exactly.
      const raw =
        findVolumeEnvelope(origin.envelopes, field.trackId)?.points ?? [];
      const point = raw.find((p) => p.id === field.pointId);
      if (!point) throw new Error("The envelope point is gone.");
      const next: AutomationPoint =
        field.kind === "envelope-time"
          ? { ...point, time: value }
          : { ...point, value };
      await setEnvelope(
        projectPath,
        field.trackId,
        replaceEnvelopePoint(raw, next),
        raw,
      );
      return true;
    }
  }
}

/** The stable key of a field, for a run and a button row. */
export function nudgeKey(field: NudgeField): string {
  return Object.values(field).join(":");
}
