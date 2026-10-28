import { useRef } from "react";

/**
 * Whether the job in view was first seen with the audio the tracks hold now.
 * A run that finished on this audio has covered every source, even one with
 * nothing to transcribe (silence, every word deleted, no media), so it still
 * reads done. Audio that arrived after the job did is not covered by it.
 */
export function useJobCoverage(
  jobId: string | null,
  mediaKey: string,
): boolean {
  const seen = useRef<{ id: string; key: string } | null>(null);
  if (jobId === null) seen.current = null;
  else if (seen.current?.id !== jobId)
    seen.current = { id: jobId, key: mediaKey };
  return seen.current !== null && seen.current.key === mediaKey;
}
