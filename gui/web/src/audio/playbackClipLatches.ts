import { useDawStore } from "../state/dawStore";

/** Listening-session safety state survives responsive shell remounts. */
let epoch: number | null = null;
const clippedTracks = new Set<string>();

export function synchronizePlaybackClipLatches(
  projectEpoch: number,
  trackIds: readonly string[] | null,
): void {
  if (epoch !== projectEpoch) {
    epoch = projectEpoch;
    clippedTracks.clear();
  }
  if (trackIds) {
    for (const id of clippedTracks) {
      if (!trackIds.includes(id)) clippedTracks.delete(id);
    }
  }
}

export function playbackTrackClipped(
  trackId: string,
  projectEpoch: number,
): boolean {
  return epoch === projectEpoch && clippedTracks.has(trackId);
}

export function setPlaybackTrackClipped(
  trackId: string,
  clipped: boolean,
): void {
  if (clipped) clippedTracks.add(trackId);
  else clippedTracks.delete(trackId);
}

let observedEpoch = useDawStore.getState().projectEpoch;
let observedTracks = useDawStore.getState().project?.tracks ?? null;
synchronizePlaybackClipLatches(
  observedEpoch,
  observedTracks?.map((track) => track.id) ?? null,
);
useDawStore.subscribe((state) => {
  const tracks = state.project?.tracks ?? null;
  if (observedEpoch === state.projectEpoch && observedTracks === tracks) return;
  observedEpoch = state.projectEpoch;
  observedTracks = tracks;
  synchronizePlaybackClipLatches(
    observedEpoch,
    tracks?.map((track) => track.id) ?? null,
  );
});
