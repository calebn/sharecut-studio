import { useEffect, useSyncExternalStore } from "react";
import { useDawStore } from "../state/dawStore";
import { WORD_ALIGNER } from "./capability";
import type { ModelView } from "./types";
import { useModels } from "./useModels";

const timedWithout = new Set<string>();
const listeners = new Set<() => void>();

function change(update: () => void): void {
  update();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A run that redoes the timing, or the transcript, settles the offer. */
export function clearRetimeOffer(projectPath: string): void {
  if (timedWithout.has(projectPath))
    change(() => timedWithout.delete(projectPath));
}

export type WordTiming = {
  /** The aligner's row; null until the status arrives. */
  row: ModelView | null;
  /** The aligner is known and not installed. */
  missing: boolean;
  /** A transcript exists and its words were timed without the aligner. */
  approximate: boolean;
  /** The aligner is in now, and these words still carry the rough timing. */
  retime: boolean;
};

/**
 * One answer to "were these words timed without the aligner" for every surface. A surface that sees
 * a transcript with the aligner missing remembers it for the project, so installing the aligner
 * from any place, then leaving and coming back, still offers Re-time words.
 */
export function useWordTiming(): WordTiming {
  const { models } = useModels();
  const projectPath = useDawStore((s) => s.projectPath);
  const hasTranscript = useDawStore(
    (s) => (s.project?.transcript?.utterances?.length ?? 0) > 0,
  );
  const row = models?.find((m) => m.id === WORD_ALIGNER) ?? null;
  const missing = row !== null && row.state.kind !== "installed";
  const remembered = useSyncExternalStore(subscribe, () =>
    timedWithout.has(projectPath),
  );
  const approximate = hasTranscript && missing;
  useEffect(() => {
    if (approximate) change(() => timedWithout.add(projectPath));
  }, [approximate, projectPath]);
  return {
    row,
    missing,
    approximate,
    retime: hasTranscript && row !== null && !missing && remembered,
  };
}
