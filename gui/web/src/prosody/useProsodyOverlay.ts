import { useEffect, useSyncExternalStore } from "react";
import { loadProsodyOverlay } from "../api/prosody";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";
import type { ProsodyOverlay } from "../types/prosody";
import { isPipelineRunning } from "../utils/pipeline";
import { listenerSet } from "../waveform/listenerSet";

const DEBOUNCE_MS = 250;
type Entry = {
  projectPath: string;
  project: ProjectView | null;
  jobKey: string;
  payload: ProsodyOverlay | null;
};
const EMPTY: Entry = {
  projectPath: "",
  project: null,
  jobKey: "",
  payload: null,
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
        entry = { ...entry, payload };
        changes.emit();
      })
      .catch(() => {
        // Aborted or offline: keep the last payload.
      });
  }, DEBOUNCE_MS);
}

const getSnapshot = () => entry;

/**
 * The host's cached prosody overlay while `enabled` (#719). It refetches (debounced) when the project
 * object changes or a pipeline job starts/ends (analyze_prosody writes the cache without touching the
 * project). Always null for share keys (host-only route).
 */
export function useProsodyOverlay(enabled: boolean): ProsodyOverlay | null {
  const projectPath = useDawStore((s) => s.projectPath);
  const project = useDawStore((s) => s.project);
  const jobKey = useDawStore((s) =>
    s.pipelineJob
      ? `${s.pipelineJob.id}:${isPipelineRunning(s.pipelineJob) ? "run" : "idle"}`
      : "",
  );
  const active =
    enabled &&
    Boolean(projectPath) &&
    project != null &&
    !isShareProjectKey(projectPath);
  useEffect(() => {
    if (active && project) request(projectPath, project, jobKey);
  }, [active, projectPath, project, jobKey]);
  const snap = useSyncExternalStore(changes.subscribe, getSnapshot);
  return active && snap.projectPath === projectPath ? snap.payload : null;
}

/** Test seam: forget the shared entry and cancel any pending fetch. */
export function resetProsodyOverlay(): void {
  inflight?.abort();
  inflight = null;
  if (timer != null) clearTimeout(timer);
  timer = null;
  entry = EMPTY;
}
