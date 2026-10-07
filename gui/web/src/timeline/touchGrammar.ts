/**
 * The timeline's side of the touch grammar (#1051 round 4b): what the hit
 * router's arm, create and detent events mean against the live project.
 * `TimelineView` passes these to `attachHitRouting`.
 */
import { type SoftBoundary, softBoundaries } from "../edit/nudgeBoundaries";
import { useDawStore } from "../state/dawStore";
import { envelopeValueAt, sortedVolumePoints } from "../utils/envelopes";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import type { CreateMenuPlace } from "./CreateMenu";
import type { ArmedTarget, CreateView, RoutedTarget } from "./hitRouting";
import { HIT_KINDS, softMover } from "./inputContract";

/** The playhead and the edges and markers near an armed target, in seconds. */
export function armedDetents(
  target: RoutedTarget,
  sec: number,
): readonly SoftBoundary[] {
  const { project, playheadSec } = useDawStore.getState();
  if (!project) return [];
  const mover = softMover(project, target.kind, target.id, sec);
  return mover ? softBoundaries(project, mover, playheadSec) : [];
}

/** How to move an armed target, by its axes. */
const ARM_HINT = {
  x: "drag sideways to move it",
  xy: "drag to move it",
  none: "",
} as const;

/** Says which target a long-press armed, and gives a platform haptic tick. */
export function announceArmed(armed: ArmedTarget | null): void {
  if (!armed) return;
  const { label } = HIT_KINDS[armed.kind];
  useDawStore
    .getState()
    .announceStatus(`${label} armed: ${ARM_HINT[armed.axis]}, lift to finish`);
  vibrate();
}

/** A short tick where the platform has one (Android); a no-op elsewhere. */
export function vibrate(): void {
  try {
    navigator.vibrate?.(8);
  } catch {
    // A browser may refuse without a user activation.
  }
}

/** The time, lane and envelope level a create menu acts on. */
export function createPlace(
  view: CreateView,
  canvas: HTMLElement,
): CreateMenuPlace {
  const { project, zoomPxPerSec } = useDawStore.getState();
  const atTime = clientXToTimelineSec(
    view.origin.x,
    canvas,
    0,
    zoomPxPerSec,
    project?.timeline_duration_sec ?? 0,
  );
  const lane = view.surface.closest<HTMLElement>("[data-track-id]");
  const trackId = lane?.getAttribute("data-track-id") ?? null;
  const track = project?.tracks.find((t) => t.id === trackId) ?? null;
  const box = lane?.getBoundingClientRect();
  return {
    atTime,
    trackId: track?.id ?? null,
    trackLabel: track ? track.speaker || track.label : null,
    lane: box ? { top: box.top, bottom: box.bottom } : null,
    level: track
      ? envelopeValueAt(
          sortedVolumePoints(project?.envelopes, track.id),
          atTime,
        )
      : null,
  };
}
