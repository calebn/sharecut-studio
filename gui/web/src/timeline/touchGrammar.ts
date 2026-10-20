/**
 * The timeline's side of the touch grammar (#1051 round 4b): what the hit
 * router's arm, create and detent events mean against the live project.
 * `TimelineView` passes these to `attachHitRouting`.
 */
import { type SoftBoundary, softBoundaries } from "../edit/nudgeBoundaries";
import { useDawStore } from "../state/dawStore";
import { selectedTrackIdsOf } from "../state/selection";
import { dialogueTrackIds } from "../utils/bladeTracks";
import { envelopeValueAt, sortedVolumePoints } from "../utils/envelopes";
import { clientXToTimelineSec } from "../utils/timelinePointer";
import type { CreateMenuPlace } from "./CreateMenu";
import type { HitPoint } from "./hitCandidates";
import type { ArmedTarget, CreateView, RoutedTarget } from "./hitRouting";
import { closestHitSurface, closestHitTarget } from "./hitTargets";
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
  y: "drag vertically to move it",
  xy: "drag to move it",
  none: "",
} as const;

/**
 * Says which target a long-press armed, and gives a platform haptic tick. The
 * message lasts as long as the arm: ending the arm clears it.
 */
export function announceArmed(armed: ArmedTarget | null): void {
  if (!armed) {
    useDawStore.getState().endGestureFeedback();
    return;
  }
  const { label } = HIT_KINDS[armed.kind];
  useDawStore
    .getState()
    .announceStatus(`${label} armed: ${ARM_HINT[armed.axis]}, lift to finish`, {
      gesture: true,
    });
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

/**
 * Where a key press opens the create menu (#1877): over the focused hit target
 * when one has focus, else at the playhead on the first selected track, else
 * the first dialogue track. Null when there is no lane to put it on.
 */
export function keyboardCreateAnchor(
  root: HTMLElement,
): { origin: HitPoint; surface: Element } | null {
  const active = document.activeElement;
  if (
    active instanceof Element &&
    root.contains(active) &&
    (closestHitTarget(active) || closestHitSurface(active))
  ) {
    const box = active.getBoundingClientRect();
    return {
      origin: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      surface: active,
    };
  }
  const { project, selection, playheadSec, zoomPxPerSec } =
    useDawStore.getState();
  const tracks = project?.tracks ?? [];
  const id =
    selectedTrackIdsOf(selection)[0] ??
    dialogueTrackIds(tracks)[0] ??
    tracks[0]?.id;
  if (!id) return null;
  const lane = [...root.querySelectorAll<HTMLElement>("[data-track-id]")].find(
    (el) => el.getAttribute("data-track-id") === id,
  );
  if (!lane) return null;
  lane.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  const box = lane.getBoundingClientRect();
  return {
    origin: {
      x: root.getBoundingClientRect().left + playheadSec * zoomPxPerSec,
      y: box.top + box.height / 2,
    },
    surface: lane,
  };
}
