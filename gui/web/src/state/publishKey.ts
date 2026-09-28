import type { DawState } from "./types";

/**
 * The subset of state that goes out over the session-sync publish (see
 * `dawApp.tsx`'s old inline `publishKey`). Kept as its own type so
 * `selectPublishKey`'s memo and its JSON key order stay in one place.
 */
type PublishKeyDeps = {
  auditionMode: DawState["auditionMode"];
  selection: DawState["selection"];
  sessionRegion: DawState["sessionRegion"];
  viewerMute: DawState["viewerMute"];
  soloTracks: DawState["soloTracks"];
  isPlaying: DawState["isPlaying"];
};

function depsOf(s: DawState): PublishKeyDeps {
  return {
    auditionMode: s.auditionMode,
    selection: s.selection,
    sessionRegion: s.sessionRegion,
    viewerMute: s.viewerMute,
    soloTracks: s.soloTracks,
    isPlaying: s.isPlaying,
  };
}

function sameDeps(a: PublishKeyDeps, b: PublishKeyDeps): boolean {
  return (
    a.auditionMode === b.auditionMode &&
    a.selection === b.selection &&
    a.sessionRegion === b.sessionRegion &&
    a.viewerMute === b.viewerMute &&
    a.soloTracks === b.soloTracks &&
    a.isPlaying === b.isPlaying
  );
}

let lastDeps: PublishKeyDeps | null = null;
let lastKey = "";

/**
 * A `useDawStore` selector for the session-sync publish key: a JSON string of
 * exactly the published fields, memoised on their identity so an unrelated
 * store change (the playhead, `project`, `sessionClients`, …) returns the
 * same string reference instead of a new one — keeping `dawApp.tsx` from
 * re-rendering on every frame just because it reads this selector.
 */
export function selectPublishKey(s: DawState): string {
  const deps = depsOf(s);
  if (lastDeps && sameDeps(lastDeps, deps)) {
    return lastKey;
  }
  lastDeps = deps;
  lastKey = JSON.stringify(deps);
  return lastKey;
}

/** Test-only: clears the memo so tests don't see another test's cached key. */
export function resetPublishKeyForTests(): void {
  lastDeps = null;
  lastKey = "";
}
