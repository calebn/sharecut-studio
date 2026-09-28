import { useEffect, useMemo, useSyncExternalStore } from "react";
import { loadProsodyOverlay } from "../api/prosody";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { ProjectView } from "../types/project";
import type { ProsodyOverlay } from "../types/prosody";
import { isPipelineRunning } from "../utils/pipeline";
import { listenerSet } from "../waveform/listenerSet";

function jobStateKey(job: PipelineJobSnapshot | null): string {
  return job ? `${job.id}:${isPipelineRunning(job) ? "run" : "idle"}` : "";
}

// Module-singleton, debounced, project-keyed fetch store: the same shape as
// waveform/statusStore.ts and hooks/useMediaQueryStore.ts (all on listenerSet).
// A fourth one should extract a shared createProjectFetchStore({ debounceMs, key, load })
// that owns the abort, stale-guard and failure rules (#732 review).
const DEBOUNCE_MS = 250;
type Entry = {
  projectPath: string;
  project: ProjectView | null;
  jobKey: string;
  payload: ProsodyOverlay | null;
  payloadClips: ProjectView["clips"] | null;
};
const EMPTY: Entry = {
  projectPath: "",
  project: null,
  jobKey: "",
  payload: null,
  payloadClips: null,
};
let entry: Entry = EMPTY;
let inflight: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const changes = listenerSet();

function request(
  projectPath: string,
  project: ProjectView,
  jobKey: string,
): void {
  if (
    entry.projectPath === projectPath &&
    entry.project === project &&
    entry.jobKey === jobKey
  )
    return;
  const samePath = entry.projectPath === projectPath;
  // A new project drops the old payload at once; a reload of the same project keeps it until the refetch lands.
  entry = {
    projectPath,
    project,
    jobKey,
    payload: samePath ? entry.payload : null,
    payloadClips: samePath ? entry.payloadClips : null,
  };
  if (!samePath) changes.emit();
  inflight?.abort();
  if (timer != null) clearTimeout(timer);
  const ctrl = new AbortController();
  inflight = ctrl;
  timer = setTimeout(() => {
    timer = null;
    loadProsodyOverlay(projectPath, ctrl.signal)
      .then((payload) => {
        if (
          ctrl.signal.aborted ||
          entry.project !== project ||
          entry.jobKey !== jobKey
        )
          return;
        inflight = null;
        entry = { ...entry, payload, payloadClips: project.clips };
        changes.emit();
      })
      .catch(() => {
        if (ctrl.signal.aborted) return; // superseded by a newer request
        if (inflight === ctrl) inflight = null;
        if (entry.project !== project || entry.jobKey !== jobKey) return;
        // Network or parse failure (a non-OK status already resolves null): stop drawing
        // the last payload as if it were current. no-console rules out a log.
        entry = { ...entry, payload: null, payloadClips: null };
        changes.emit();
      });
  }, DEBOUNCE_MS);
}

const getSnapshot = () => entry;

export type ProsodyOverlayViews = {
  /** Last payload for the current project (transcript emphasis, timeline status summary). */
  latest: ProsodyOverlay | null;
  /** `latest` only while it was mapped against the current clip layout (timeline geometry); null after a clip edit until the refetch lands. */
  aligned: ProsodyOverlay | null;
};

/**
 * The host's cached prosody overlay while `enabled` (#719). It refetches (debounced) when the project
 * object changes, a pipeline or agent job starts or ends, or the layer is turned back on.
 * Always null for share keys (host-only route). One call gives both views of the same snapshot,
 * so a consumer that needs both cannot gate two hook calls differently (#732 review).
 */
export function useProsodyOverlayViews(enabled: boolean): ProsodyOverlayViews {
  const projectPath = useDawStore((s) => s.projectPath);
  const project = useDawStore((s) => s.project);
  // Pipeline-tab runs (pipelineJob) and host-MCP agent runs (activityJob) both can write the cache.
  const jobKey = useDawStore(
    (s) => `${jobStateKey(s.pipelineJob)}|${jobStateKey(s.activityJob)}`,
  );
  const active =
    enabled &&
    Boolean(projectPath) &&
    project != null &&
    !isShareProjectKey(projectPath);
  useEffect(() => {
    if (active && project) request(projectPath, project, jobKey);
  }, [active, projectPath, project, jobKey]);
  // Layer off forgets the entry, so turning it back on refetches: the manual refresh after an
  // analyze_prosody run in another process (a terminal CLI), which no job state reaches.
  useEffect(() => {
    if (!enabled) resetProsodyOverlay();
  }, [enabled]);
  const snap = useSyncExternalStore(changes.subscribe, getSnapshot);
  const latest =
    active && snap.projectPath === projectPath ? snap.payload : null;
  // Clip layout = `project.clips` identity. This holds because document sync (mergeProjectPatch /
  // document/reuseUnchanged.ts) keeps `clips` referentially stable across edits that do not touch
  // clips. A setProject() path that rebuilds `clips` on every edit would hide this layer and refetch
  // after each edit; the "real merge path" test in useProsodyOverlay.test.tsx locks that in.
  const aligned =
    latest && snap.payloadClips === project?.clips ? latest : null;
  return useMemo(() => ({ latest, aligned }), [latest, aligned]);
}

/** The latest payload only (the transcript keys words by word_index, so clip moves do not matter). */
export function useProsodyOverlay(enabled: boolean): ProsodyOverlay | null {
  return useProsodyOverlayViews(enabled).latest;
}

/** Forget the shared entry and cancel any pending fetch (the layer turning off; also a test seam). */
export function resetProsodyOverlay(): void {
  inflight?.abort();
  inflight = null;
  if (timer != null) clearTimeout(timer);
  timer = null;
  if (entry === EMPTY) return;
  entry = EMPTY;
  // Every subscriber drops the old snapshot now, not at its next request().
  changes.emit();
}
